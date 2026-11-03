// flake-shape: in-process-mock — #1712/#4485: the installer is the external tool boundary; it hands the real typescript-language-server 5.3.0 wrapper and a classic compiler to the real launcher, service, client and cascade.
/**
 * #1712 / #4485 live twin: the cascade over a real classic TypeScript server.
 *
 * The recurrence: classic tsserver neighbours were classified silent and
 * deferred to the quiet window, which mostly never came, so a primary edit
 * that broke its importers returned `no_neighbors` (a leaf's all-clear) and
 * a later cascade hid a persistent error behind the rolling delta. Every
 * unit test drives a double of the server; only a real wrapper shows whether
 * the `typescript.tsserverRequest` pull answers in-lane.
 *
 * Opt-in like the other live TypeScript suites: it runs only with
 * `PI_LENS_INTEGRATION=1` and a classic compiler named by
 * `PI_LENS_CLASSIC_TSC` (a `tsc` whose package still ships
 * `lib/tsserver.js`, TypeScript 6 or older; the repo's own devDependency is
 * TypeScript 7). Without either it skips and says why.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { pinFixtureHome, removeTempDirSync } from "./test-utils.js";
import { withEnv } from "../support/with-env.js";

const { classicTsc } = vi.hoisted(() => ({
	classicTsc: { value: "" },
}));
// Installation/discovery is the external tool boundary. The launcher, the
// wrapper, the compiler, the service, the client and the cascade are real.
vi.mock("../../clients/installer/index.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../clients/installer/index.js")
	>()),
	ensureTool: async (id: string) =>
		id === "typescript-language-server"
			? createRequire(import.meta.url).resolve(
					"typescript-language-server/lib/cli.mjs",
				)
			: id === "typescript"
				? classicTsc.value
				: undefined,
}));

function classicCompiler(): string | undefined {
	const tsc = process.env.PI_LENS_CLASSIC_TSC;
	if (!tsc || !fs.existsSync(tsc)) return undefined;
	const pkg = path.resolve(path.dirname(fs.realpathSync(tsc)), "..");
	return fs.existsSync(path.join(pkg, "lib", "tsserver.js")) ? tsc : undefined;
}

const LIVE = process.env.PI_LENS_INTEGRATION === "1";
const TSC = LIVE ? classicCompiler() : undefined;
const SKIP_REASON = !LIVE
	? "PI_LENS_INTEGRATION is not 1"
	: !TSC
		? "PI_LENS_CLASSIC_TSC names no classic compiler (lib/tsserver.js)"
		: "";

const PRIMARY_BEFORE =
	"export function foo(x: number): number {\n\treturn x;\n}\n";
const PRIMARY_BROKEN =
	"export function foo(x: string): string {\n\treturn x;\n}\n";
const IMPORTER = (name: string) =>
	`import { foo } from "./a";\nexport const ${name}: number = foo(1);\n`;

let tmp = "";
let restoreEnv: () => void = () => {};
const pids = new Set<number>();

describe.skipIf(SKIP_REASON !== "")(
	`cascade over a real classic TypeScript server (#1712, #4485)${SKIP_REASON ? ` [skipped: ${SKIP_REASON}]` : ""}`,
	() => {
		let restoreHome: () => void = () => {};

		beforeAll(() => {
			classicTsc.value = TSC ?? "";
			tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-cascade-live-"));
			const childTmp = path.join(tmp, "os-temp");
			fs.mkdirSync(childTmp);
			restoreEnv = withEnv({
				TMPDIR: childTmp,
				TEMP: childTmp,
				TMP: childTmp,
				PI_LENS_HOME: path.join(tmp, "pi-lens-home"),
				PILENS_DATA_DIR: path.join(tmp, "data"),
				PI_LENS_TEST_MODE: "0",
				PI_LENS_DISABLE_TOOL_INSTALL: "1",
				PI_LENS_DISABLE_LSP_INSTALL: "1",
			});
		});

		// HOME lives in the worker's scratch root beside its worker home, never
		// under `tmp`, which afterAll deletes (AGENTS "Test requirements": #2912,
		// #4591). A child that writes to its inherited HOME after teardown would
		// re-create the deleted tree.
		beforeEach(() => {
			restoreHome = pinFixtureHome("1712-cascade-live").restore;
		});

		afterEach(() => {
			restoreHome();
		});

		afterAll(async () => {
			const { resetLSPService, getLSPService } =
				await import("../../clients/lsp/index.js");
			await getLSPService().shutdown({ fast: false, reason: "test" });
			resetLSPService();
			// Every server this suite spawned is gone; kill a survivor by PID.
			for (const pid of pids) {
				try {
					process.kill(pid, 0);
					process.kill(pid, "SIGKILL");
				} catch {
					/* already exited */
				}
			}
			const { resetProjectTrust } =
				await import("../../clients/project-trust.js");
			resetProjectTrust();
			restoreEnv();
			removeTempDirSync(tmp);
		});

		it("lists each broken importer at the first cascade and still at the third", async () => {
			const proj = path.join(tmp, "project");
			fs.mkdirSync(path.join(proj, "src"), { recursive: true });
			fs.writeFileSync(path.join(proj, "package.json"), "{}\n");
			fs.writeFileSync(
				path.join(proj, "tsconfig.json"),
				JSON.stringify({ compilerOptions: { strict: true } }),
			);
			const a = path.join(proj, "src", "a.ts");
			const b = path.join(proj, "src", "b.ts");
			const c = path.join(proj, "src", "c.ts");
			fs.writeFileSync(a, PRIMARY_BEFORE);
			fs.writeFileSync(b, IMPORTER("b"));
			fs.writeFileSync(c, IMPORTER("c"));

			const { setProjectTrustState } =
				await import("../../clients/project-trust.js");
			setProjectTrustState("trusted");
			const { getLSPService } = await import("../../clients/lsp/index.js");
			const { computeCascadeForFile } =
				await import("../../clients/dispatch/integration.js");
			const service = getLSPService();
			// Warm: the primary and both importers are open and clean, so
			// each holds a passive snapshot from before the edit (#4486).
			for (const file of [a, b, c]) {
				await service.touchFile(file, fs.readFileSync(file, "utf8"), {
					diagnostics: "document",
					collectDiagnostics: true,
				});
			}
			const spawned = await service.getClientForFile(b);
			expect(spawned?.client.serverId).toBe("typescript");
			const pid = spawned?.client.getProcessPid?.();
			if (pid) pids.add(pid);

			const runs = [];
			for (const turn of [1, 2, 3]) {
				// Each turn edits the primary, as the agent's write would.
				const content = `${PRIMARY_BROKEN}// turn ${turn}\n`;
				fs.writeFileSync(a, content);
				await service.touchFile(a, content, {
					diagnostics: "document",
					collectDiagnostics: true,
				});
				runs.push(
					await computeCascadeForFile(a, proj, {
						turnSeq: turn,
						writeSeq: turn,
						projectRoot: proj,
					}),
				);
			}

			// What the agent reads: each importer's block with the server's
			// own error text, on every run.
			const summary = runs.map((run) => ({
				skipReason: run.skipReason,
				unconfirmed: run.unconfirmed?.count,
				broken: ["b", "c"].filter((name) =>
					new RegExp(
						`<diagnostics file="src/${name}\\.ts"[^>]*>\\n[^<]*is not assignable`,
					).test(run.result?.formatted ?? ""),
				),
			}));
			console.log(`[cascade-live] ${JSON.stringify(summary)}`);
			expect(summary).toEqual(
				[1, 2, 3].map(() => ({
					skipReason: undefined,
					unconfirmed: undefined,
					broken: ["b", "c"],
				})),
			);
		}, 120_000);
	},
);
