// The recurrence this file guards (#4719 F1, greptile P1, sourcery High,
// CodeRabbit Functional Correctness): tier 2 held a STATIC import of
// `@earendil-works/pi-coding-agent`, so `PI_LENS_PI_HOST_PACKAGE` switched only
// the scripted provider. A directory holding nothing but a manifest and a
// pi-ai shim ran `tests/support/pi-session.test.ts` green 16/16, and the
// certified-host spread printed that result on an OLD host's line (measured:
// `Tests 16 passed (16)` before the fix, `15 failed | 1 passed` after it).
//
// The cases below drive the resolver the tier itself uses — the environment
// override included — so a host directory that supplies no session code is
// refused instead of being reported as probed. A stub of the resolver would
// pass with the defect in place, which is why every case plants a real
// package directory on disk.
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { hostModule, piAiModule, warmHostModule } from "./pi-session.js";

/** The one override the tier, and therefore this file, resolves through. */
const HOST_PACKAGE_ENV = "PI_LENS_PI_HOST_PACKAGE";

/** The session API members every host install must supply. */
const SESSION_API = [
	"AgentSessionRuntime",
	"ModelRuntime",
	"SessionManager",
	"createAgentSessionServices",
	"createAgentSessionFromServices",
] as const;

/** The scripted-provider members (`piAiModule`) every host install must carry. */
const PI_AI_API = [
	"fauxProvider",
	"fauxText",
	"fauxToolCall",
	"fauxAssistantMessage",
] as const;

/** The host's own provider package, resolved from the host install's own tree. */
const PI_AI_PACKAGE = "@earendil-works/pi-ai";

const fixtures: Array<{ tmpDir: string; cleanup: () => void }> = [];

function fixtureRoot(): string {
	const fixture = setupTestEnvironment("pi-lens-pi-session-host-");
	fixtures.push(fixture);
	return fixture.tmpDir;
}

/**
 * A package directory at `root/pi-<version>/node_modules/<name>` that answers
 * for `names` and nothing else. Each export is a function carrying the name it
 * was exported under and the install it was planted for, so a case can tell one
 * planted host's module from another's.
 */
function plantPackage(
	root: string,
	options: {
		packageName: string;
		tag: string;
		version: string;
		names: readonly string[];
	},
): string {
	const dir = path.join(
		root,
		`pi-${options.version}`,
		"node_modules",
		...options.packageName.split("/"),
	);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			name: options.packageName,
			version: options.version,
			main: "index.cjs",
		}),
	);
	// The entry reads its names and tag from a data file rather than having them
	// spliced into its source, so no value is ever built into code. It also
	// leaves a `loaded` mark beside itself, which the warm-up case reads.
	fs.writeFileSync(
		path.join(dir, "fixture.json"),
		JSON.stringify({ names: options.names, tag: options.tag }),
	);
	const lines = [
		'const fs = require("node:fs");',
		'const path = require("node:path");',
		'const fixture = require("./fixture.json");',
		'fs.writeFileSync(path.join(__dirname, "loaded"), "1");',
		"const exported = {};",
		"for (const name of fixture.names) {",
		"\texported[name] = Object.assign(function hosted() {}, { exportedAs: name, install: fixture.tag });",
		"}",
		"module.exports = exported;",
	];
	fs.writeFileSync(path.join(dir, "index.cjs"), `${lines.join("\n")}\n`);
	return dir;
}

/** A host install (the session API) at the versioned install layout. */
function plantHost(
	root: string,
	names: readonly string[],
	version = "0.86.1",
	tag = "host",
): string {
	return plantPackage(root, {
		names,
		packageName: "@earendil-works/pi-coding-agent",
		tag,
		version,
	});
}

/** The install tag a planted module's export was written with. */
function installOf(module: unknown, name: string): string | undefined {
	const exports = module as Record<string, { install?: string } | undefined>;
	return exports[name]?.install;
}

/** Run `body` with the override pointed at `dir`, and put the value back. */
function withHostOverride<T>(dir: string, body: () => T): T {
	const saved = process.env[HOST_PACKAGE_ENV];
	process.env[HOST_PACKAGE_ENV] = dir;
	try {
		return body();
	} finally {
		if (saved === undefined) delete process.env[HOST_PACKAGE_ENV];
		else process.env[HOST_PACKAGE_ENV] = saved;
	}
}

/** The fixture module's own marker, as the resolver handed it over. */
function exportedAs(name: string): string | undefined {
	const host = hostModule() as unknown as Record<
		string,
		{ exportedAs?: string } | undefined
	>;
	return host[name]?.exportedAs;
}

afterAll(async () => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
	await cleanupTestEnvironmentsDrained("pi-lens-pi-session-host-");
});

describe("the tier's session API comes from the host the override names (#4719 F1)", () => {
	it("loads the session API from that host, not from this repo's devDependency", () => {
		const dir = plantHost(fixtureRoot(), SESSION_API);
		const markers = withHostOverride(dir, () =>
			SESSION_API.map((name) => exportedAs(name)),
		);
		expect(markers).toEqual([...SESSION_API]);
	});

	it("refuses a host that carries no import entry instead of falling back", () => {
		// The reviewer's probe: a manifest and nothing else. Before the fix this
		// directory ran the whole tier against the dev host's session code.
		const root = fixtureRoot();
		const dir = path.join(root, "manifest-only");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({
				name: "@earendil-works/pi-coding-agent",
				version: "0.86.1",
			}),
		);
		expect(() => withHostOverride(dir, () => hostModule())).toThrow(
			`${dir}/package.json declares no import entry`,
		);
	});

	it("refuses a host that stops exporting a session member", () => {
		// A host whose entry exists but no longer answers for the whole API is
		// NOT a host this tier can probe: naming the missing member is what turns
		// a half-loaded host into a refusal rather than a green run.
		const dir = plantHost(
			fixtureRoot(),
			SESSION_API.filter((name) => name !== "SessionManager"),
		);
		expect(() => withHostOverride(dir, () => hostModule())).toThrow(
			`does not export SessionManager, so the session API cannot come from the host ${HOST_PACKAGE_ENV} names (${dir})`,
		);
	});

	it("warms the host module without turning a host-less run into a hook failure", () => {
		// Recurrence (#4719 F8): the host module's ~0.9 s load moved from helper
		// module load into the first case that creates a session, and a master-side
		// tier-2 case at 4.0-4.7 s against the 5 s default timed out on CI. The
		// warm-up hook pre-pays it. Its ONE swallowed failure is "nothing to
		// load": a file whose cases are gated on a host being installed must stay
		// a run of skips, and a case that NEEDS the host still raises the load's
		// own error itself (the cases above).
		// Recurrence (#4719 F13): with a no-op warmHostModule this case passed.
		// A fresh host's entry marks that it loaded; warming under the override
		// must load it before anything calls hostModule().
		const freshHost = plantHost(fixtureRoot(), SESSION_API, "0.86.2", "warmed");
		expect(fs.existsSync(path.join(freshHost, "loaded"))).toBe(false);
		withHostOverride(freshHost, () => warmHostModule());
		expect(fs.existsSync(path.join(freshHost, "loaded"))).toBe(true);
		const notAHost = path.join(fixtureRoot(), "not-a-host");
		fs.mkdirSync(notAHost, { recursive: true });
		fs.writeFileSync(
			path.join(notAHost, "package.json"),
			JSON.stringify({ name: "not-a-host" }),
		);
		expect(() =>
			withHostOverride(notAHost, () => warmHostModule()),
		).not.toThrow();
	});

	it("loads the scripted provider from the same host as the session API", () => {
		// Recurrence (#4719 F11): `hostModuleFor` is keyed on the host directory
		// and `loadedPiAi` was keyed on nothing, so a second host in one process
		// paired host B's session API with host A's provider (measured:
		// `hostA 0.86.1 aiA 0.86.1 hostB 1.3.0 aiB 0.86.1`). The two halves of
		// one session must agree about the install they came from.
		const root = fixtureRoot();
		const hosts = ["hostA", "hostB"].map((tag, index) => {
			const version = index === 0 ? "0.86.1" : "1.3.0";
			plantPackage(root, {
				names: PI_AI_API,
				packageName: PI_AI_PACKAGE,
				tag,
				version,
			});
			return plantHost(root, SESSION_API, version, tag);
		});
		const pairFor = (dir: string) =>
			withHostOverride(dir, () => [
				installOf(hostModule(), "SessionManager"),
				installOf(piAiModule(), "fauxProvider"),
			]);
		// Both directions: the FIRST host's pair, then a switch to the second.
		expect(pairFor(hosts[0])).toEqual(["hostA", "hostA"]);
		expect(pairFor(hosts[1])).toEqual(["hostB", "hostB"]);
	});

	it("falls back to this repo's host when the override is unset", () => {
		// The per-PR tiers run with no override; a resolver that only worked when
		// `PI_LENS_PI_HOST_PACKAGE` was set would break every other tier-2 file.
		for (const name of SESSION_API)
			expect(
				typeof (hostModule() as unknown as Record<string, unknown>)[name],
			).toBe("function");
	});
});
