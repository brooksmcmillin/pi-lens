/**
 * Recurrence this guards: #4789 review F8 (PR #4794, CodeRabbit). The first cut
 * of `assertManagedBinDirInsidePinnedHome` sat in `installArchiveTool` AFTER
 * `swapExtractedDir`, so a refused install (a pinned `PI_LENS_HOME` whose `bin`
 * links out) had already replaced `tools/<id>` while its log said "keeping
 * installed version", and an existing shim then ran the new bytes.
 *
 * Through the production installer (`installTool("spotbugs")`, the archive
 * strategy with a shim launcher) in a fixture under the lane TMPDIR. Doubled at
 * true boundaries only: `node:https` (the download) and the extractor process
 * (`tar`), which here unpacks a fixture tree. The registry entry's sha256 pin is
 * patched through the exported `TOOLS` so the fixture archive verifies. The
 * swap, the guard and the degradation ledger run for real.
 */

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { removeTempDirSync } from "../test-utils.js";

vi.unmock("../../../clients/installer/index.js");

const { httpsGetMock } = vi.hoisted(() => ({ httpsGetMock: vi.fn() }));

vi.mock("node:https", () => ({
	default: { get: httpsGetMock },
	get: httpsGetMock,
}));

const ARCHIVE = Buffer.from("FIXTURE-ARCHIVE-BYTES-4789\n");
const NEW_LAUNCHER = "#!/bin/sh\necho NEW-TOOL-FROM-THE-ARCHIVE\n";
const ORIGINAL = "ORIGINAL-VICTIM\n";

// The extractor double: `tar -xzf <archive> -C <dir> ...` becomes "write the
// fixture tree into <dir>/bin/spotbugs". Everything else answers success.
vi.mock("../../../clients/safe-spawn.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/safe-spawn.js")>()),
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 0 })),
	safeSpawnAsync: vi.fn(
		async (command: string, args: string[], options?: { cwd?: string }) => {
			if (command === "tar") {
				const into = args[args.indexOf("-C") + 1] as string;
				const bin = path.join(options?.cwd ?? ".", into, "bin");
				fs.mkdirSync(bin, { recursive: true });
				fs.writeFileSync(path.join(bin, "spotbugs"), NEW_LAUNCHER);
			}
			return { stdout: "1.0.0", stderr: "", status: 0 };
		},
	),
}));

httpsGetMock.mockImplementation(
	(_url: string, _options: unknown, callback: (res: EventEmitter) => void) => {
		const request = new EventEmitter();
		queueMicrotask(() => {
			const res = new EventEmitter() as EventEmitter & {
				statusCode: number;
				headers: Record<string, string>;
				resume: () => void;
			};
			res.statusCode = 200;
			res.headers = {};
			res.resume = () => {};
			callback(res);
			queueMicrotask(() => {
				res.emit("data", ARCHIVE);
				res.emit("end");
			});
		});
		return request;
	},
);

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function fixtureRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4789-arc-"));
	roots.push(root);
	return root;
}

/** A pinned home whose `tools/spotbugs` holds a previous install. */
function seedHome(root: string): { home: string; oldMarker: string } {
	const home = path.join(root, "home");
	const oldDir = path.join(home, "tools", "spotbugs");
	fs.mkdirSync(oldDir, { recursive: true });
	const oldMarker = path.join(oldDir, "OLD-MARKER.txt");
	fs.writeFileSync(oldMarker, "previous install\n");
	return { home, oldMarker };
}

async function loadFresh() {
	vi.resetModules();
	const installer = await import("../../../clients/installer/index.js");
	const ledger = await import("../../../clients/degradation-ledger.js");
	const spec = installer.TOOLS.find((tool) => tool.id === "spotbugs")?.archive;
	if (!spec?.sha256) throw new Error("spotbugs archive spec changed shape");
	// The fixture archive verifies against the pin the registry would hold.
	spec.sha256[spec.url as string] = createHash("sha256")
		.update(ARCHIVE)
		.digest("hex");
	return { installer, ledger };
}

beforeEach(() => {
	for (const key of ["PI_LENS_HOME", "PI_LENS_DISABLE_TOOL_INSTALL"])
		savedEnv[key] = process.env[key];
	delete process.env.PI_LENS_DISABLE_TOOL_INSTALL;
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

afterAll(() => {
	for (const root of roots) removeTempDirSync(root);
});

describe("the archive strategy checks the managed bin directory before it swaps the installed tree (#4789 F8)", () => {
	it("a pinned home whose bin links out: the refused install leaves the previous tree and the victim untouched", async () => {
		const root = fixtureRoot();
		const { home, oldMarker } = seedHome(root);
		const victimDir = path.join(root, "victim-bin");
		fs.mkdirSync(victimDir, { recursive: true });
		const victim = path.join(victimDir, "spotbugs");
		fs.writeFileSync(victim, ORIGINAL);
		fs.symlinkSync(
			victimDir,
			path.join(home, "bin"),
			process.platform === "win32" ? "junction" : "dir",
		);
		process.env.PI_LENS_HOME = home;

		const { installer, ledger } = await loadFresh();
		const installed = await installer.installTool("spotbugs");

		expect(installed).toBe(false);
		expect(fs.readFileSync(victim, "utf8")).toBe(ORIGINAL);
		// The previous install is still the live one: its marker is in place and
		// the fixture archive's launcher is not.
		expect(fs.existsSync(oldMarker)).toBe(true);
		expect(
			fs.existsSync(path.join(home, "tools", "spotbugs", "bin", "spotbugs")),
		).toBe(false);
		const group = ledger
			.getDegradationSummary()
			.find((entry) => entry.kind === "managed-tool-install");
		expect(group?.count).toBe(1);
		expect(group?.latestReasons[0]?.subject).toBe("spotbugs:bin-dir-escape");
	});

	it("control: an ordinary bin directory swaps the tree and writes the shim", async () => {
		const root = fixtureRoot();
		const { home, oldMarker } = seedHome(root);
		fs.mkdirSync(path.join(home, "bin"), { recursive: true });
		process.env.PI_LENS_HOME = home;

		const { installer } = await loadFresh();
		const installed = await installer.installTool("spotbugs");

		expect(installed).toBe(true);
		// The swap really ran here, so the refusal case above cannot pass
		// vacuously by an install that never reaches the swap.
		expect(fs.existsSync(oldMarker)).toBe(false);
		expect(
			fs.readFileSync(
				path.join(home, "tools", "spotbugs", "bin", "spotbugs"),
				"utf8",
			),
		).toBe(NEW_LAUNCHER);
	});
});
