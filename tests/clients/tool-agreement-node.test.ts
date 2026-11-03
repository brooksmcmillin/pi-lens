/**
 * Direct coverage of `nodeAgreement` (clients/tool-agreement.ts) through its
 * exported caller `establishToolAgreement`, with real on-disk fixtures and no
 * mocks (#4361 C5, PLAN_4361 section 2).
 *
 * Recurrence: AGENTS.md's Node tool agreement rule (npm, then pnpm, then yarn
 * lockfile order) had no test, so a mixed-repo project could silently be
 * judged against the wrong package manager's resolved version.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { establishToolAgreement } from "../../clients/tool-agreement.js";
import { setupTestEnvironment } from "./test-utils.js";

const RANGE = "^3.2.5";
const PACKAGE_JSON = JSON.stringify({
	devDependencies: { prettier: RANGE },
});

function npmLock(version: string): string {
	return JSON.stringify({
		lockfileVersion: 3,
		packages: { "node_modules/prettier": { version } },
	});
}

function pnpmLock(version: string): string {
	return [
		"lockfileVersion: '9.0'",
		"",
		"importers:",
		"  .:",
		"    devDependencies:",
		"      prettier:",
		`        specifier: ${RANGE}`,
		`        version: ${version}`,
		"",
	].join("\n");
}

// A leading unrelated block: yarnV1Blocks drops the block that directly follows
// the two-blank-line header, so prettier must not be first (#4361 C5 finding:
// a canonical v1 lock with prettier first declines evidence-unsupported).
function yarnV1Lock(version: string): string {
	return [
		"# yarn lockfile v1",
		"",
		"",
		"ansi-styles@^4.0.0:",
		'  version "4.0.0"',
		'  resolved "https://registry.example/ansi-styles-4.0.0.tgz"',
		"",
		`prettier@${RANGE}:`,
		`  version "${version}"`,
		`  resolved "https://registry.example/prettier-${version}.tgz"`,
		"",
	].join("\n");
}

function yarnBerryLock(version: string): string {
	return [
		"__metadata:",
		"  version: 8",
		"  cacheKey: 10c0",
		"",
		`"prettier@npm:${RANGE}":`,
		`  version: ${version}`,
		`  resolution: "prettier@npm:${version}"`,
		"",
	].join("\n");
}

describe("establishToolAgreement: node lockfile selection (#4361 C5)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;
	let seq = 0;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-4361-node-agreement-");
	});
	afterEach(() => env.cleanup());

	/**
	 * A fresh project root under the test root. Keys are relative paths, so a
	 * key such as `packages/app/yarn.lock` places a file in a nested package.
	 */
	function project(files: Record<string, string>): string {
		seq += 1;
		const root = path.join(env.tmpDir, `case-${seq}`);
		for (const [name, text] of Object.entries(files)) {
			const file = path.join(root, name);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, text);
		}
		return root;
	}

	const decide = (cwd: string) => establishToolAgreement("prettier", cwd);

	describe("each lockfile selects its package manager", () => {
		it("selects package-lock.json (npm) when it resolves the declared range", () => {
			const cwd = project({
				"package.json": PACKAGE_JSON,
				"package-lock.json": npmLock("3.2.5"),
			});
			expect(decide(cwd)).toEqual({
				decision: "established",
				lockfile: "package-lock.json",
			});
		});

		it("selects pnpm-lock.yaml (pnpm v9 importers) when it resolves the declared range", () => {
			const cwd = project({
				"package.json": PACKAGE_JSON,
				"pnpm-lock.yaml": pnpmLock("3.2.5"),
			});
			expect(decide(cwd)).toEqual({
				decision: "established",
				lockfile: "pnpm-lock.yaml",
			});
		});

		it("selects yarn.lock (classic v1 blocks) when it resolves the declared range", () => {
			const cwd = project({
				"package.json": PACKAGE_JSON,
				"yarn.lock": yarnV1Lock("3.2.5"),
			});
			expect(decide(cwd)).toEqual({
				decision: "established",
				lockfile: "yarn.lock",
			});
		});

		it("selects yarn.lock (Berry npm: descriptors) when it resolves the declared range", () => {
			const cwd = project({
				"package.json": PACKAGE_JSON,
				"yarn.lock": yarnBerryLock("3.2.5"),
			});
			expect(decide(cwd)).toEqual({
				decision: "established",
				lockfile: "yarn.lock",
			});
		});
	});

	describe("lockfile precedence when several coexist in one directory", () => {
		// Each losing lockfile resolves a different version, so the supplier
		// the code picks is the only one whose version can establish agreement.

		it("package-lock.json wins over pnpm-lock.yaml", () => {
			const cwd = project({
				"package.json": PACKAGE_JSON,
				"package-lock.json": npmLock("3.2.5"),
				"pnpm-lock.yaml": pnpmLock("9.9.9"),
			});
			expect(decide(cwd)).toEqual({
				decision: "established",
				lockfile: "package-lock.json",
			});
		});

		it("package-lock.json wins over yarn.lock", () => {
			const cwd = project({
				"package.json": PACKAGE_JSON,
				"package-lock.json": npmLock("3.2.5"),
				"yarn.lock": yarnV1Lock("9.9.9"),
			});
			expect(decide(cwd)).toEqual({
				decision: "established",
				lockfile: "package-lock.json",
			});
		});

		it("pnpm-lock.yaml wins over yarn.lock when no package-lock.json exists", () => {
			const cwd = project({
				"package.json": PACKAGE_JSON,
				"pnpm-lock.yaml": pnpmLock("3.2.5"),
				"yarn.lock": yarnV1Lock("9.9.9"),
			});
			expect(decide(cwd)).toEqual({
				decision: "established",
				lockfile: "pnpm-lock.yaml",
			});
		});

		it("never reads the losing lockfile: an unreadable pnpm-lock.yaml does not block package-lock.json", () => {
			const cwd = project({
				"package.json": PACKAGE_JSON,
				"package-lock.json": npmLock("3.2.5"),
				"pnpm-lock.yaml": "{{{ not: [yaml",
			});
			expect(decide(cwd)).toEqual({
				decision: "established",
				lockfile: "package-lock.json",
			});
		});

		it("uses the nearest directory with a lockfile, so a package-dir yarn.lock beats an ancestor package-lock.json", () => {
			// The ancestor would agree (3.2.5); the package directory's yarn.lock
			// disagrees (9.9.9). The decision must name yarn.lock, not npm.
			const root = project({
				"package-lock.json": npmLock("3.2.5"),
				"packages/app/package.json": PACKAGE_JSON,
				"packages/app/yarn.lock": yarnV1Lock("9.9.9"),
			});
			expect(
				establishToolAgreement("prettier", path.join(root, "packages/app")),
			).toMatchObject({
				decision: "decline",
				reason: expect.stringContaining("yarn.lock"),
			});
		});

		it("climbs to an ancestor lockfile when the package directory has none", () => {
			const root = project({
				"package-lock.json": npmLock("3.2.5"),
				"packages/app/package.json": PACKAGE_JSON,
			});
			expect(
				establishToolAgreement("prettier", path.join(root, "packages/app")),
			).toEqual({ decision: "established", lockfile: "package-lock.json" });
		});
	});

	describe("declines when project evidence cannot establish agreement", () => {
		it("declines evidence-absent when no lockfile exists", () => {
			const cwd = project({ "package.json": PACKAGE_JSON });
			expect(decide(cwd)).toMatchObject({
				decision: "decline",
				reasonCode: "evidence-absent",
				reason: expect.stringContaining("no lockfile"),
			});
		});

		it("declines evidence-absent for an unrecognized lockfile (bun.lock is not a supplier)", () => {
			const cwd = project({
				"package.json": PACKAGE_JSON,
				"bun.lock": "{}\n",
			});
			expect(decide(cwd)).toMatchObject({
				decision: "decline",
				reasonCode: "evidence-absent",
			});
		});

		it("ignores a packageManager field: with no lockfile it still declines", () => {
			const cwd = project({
				"package.json": JSON.stringify({
					packageManager: "pnpm@9.12.0",
					devDependencies: { prettier: RANGE },
				}),
			});
			expect(decide(cwd)).toMatchObject({
				decision: "decline",
				reasonCode: "evidence-absent",
			});
		});

		it("ignores a packageManager field: a conflicting one does not select over the lockfile", () => {
			const cwd = project({
				"package.json": JSON.stringify({
					packageManager: "yarn@4.0.0",
					devDependencies: { prettier: RANGE },
				}),
				"pnpm-lock.yaml": pnpmLock("3.2.5"),
			});
			expect(decide(cwd)).toEqual({
				decision: "established",
				lockfile: "pnpm-lock.yaml",
			});
		});

		it("declines evidence-absent when package.json does not declare the tool", () => {
			const cwd = project({
				"package.json": JSON.stringify({
					devDependencies: { eslint: "^9.0.0" },
				}),
				"package-lock.json": npmLock("3.2.5"),
			});
			expect(decide(cwd)).toMatchObject({
				decision: "decline",
				reasonCode: "evidence-absent",
				reason: expect.stringContaining("no package declaration"),
			});
		});

		it("declines evidence-unparseable when package.json is malformed", () => {
			const cwd = project({
				"package.json": "{ not json",
				"package-lock.json": npmLock("3.2.5"),
			});
			expect(decide(cwd)).toMatchObject({
				decision: "decline",
				reasonCode: "evidence-unparseable",
			});
		});

		it("declines when package-lock.json has no entry for the tool", () => {
			const cwd = project({
				"package.json": PACKAGE_JSON,
				"package-lock.json": JSON.stringify({ packages: {} }),
			});
			expect(decide(cwd)).toMatchObject({
				decision: "decline",
				reason: expect.stringContaining(
					"package-lock.json does not establish its resolved version",
				),
			});
		});

		it("declines when the supplying pnpm lockfile resolves a different version", () => {
			const cwd = project({
				"package.json": PACKAGE_JSON,
				"pnpm-lock.yaml": pnpmLock("9.9.9"),
			});
			expect(decide(cwd)).toMatchObject({
				decision: "decline",
				reason: expect.stringContaining("agreement disagrees"),
			});
		});

		it("declines evidence-unsupported for a pnpm lockfile with no importers or top-level maps", () => {
			const cwd = project({
				"package.json": PACKAGE_JSON,
				"pnpm-lock.yaml": "lockfileVersion: '9.0'\npackages: {}\n",
			});
			expect(decide(cwd)).toMatchObject({
				decision: "decline",
				reasonCode: "evidence-unsupported",
			});
		});
	});
});

describe("yarn v1 first-entry residual (#4361 C5, refs #4766)", () => {
	let env: ReturnType<typeof setupTestEnvironment>;

	beforeEach(() => {
		env = setupTestEnvironment("pi-lens-4361-yarn-first-");
	});
	afterEach(() => env.cleanup());

	// Defect (accepted p3 residual, clients/tool-agreement.ts:610): yarnV1Blocks
	// splits on blank lines, so the block directly after the canonical
	// two-blank-line v1 header is dropped. A consistent lock whose first entry
	// is the tool therefore declines `evidence-unsupported` instead of agreeing.
	// `it.fails` pins the live bug: it passes while the defect exists, and it
	// must flip to `it` (and go red) when the product fix lands.
	it.fails("a canonical yarn v1 lock with the tool as the first entry agrees", () => {
		const root = path.join(env.tmpDir, "yarn-first");
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ devDependencies: { prettier: RANGE } }),
		);
		fs.writeFileSync(
			path.join(root, "yarn.lock"),
			[
				"# yarn lockfile v1",
				"",
				"",
				`prettier@${RANGE}:`,
				'  version "3.2.5"',
				'  resolved "https://registry.example/prettier-3.2.5.tgz"',
				"",
			].join("\n"),
		);
		expect(establishToolAgreement("prettier", root)).toEqual({
			decision: "established",
			lockfile: "yarn.lock",
		});
	});
});
