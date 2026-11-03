/**
 * #2556 — a directory named `..foo` is INSIDE the root it belongs to.
 *
 * Ten runtime sites tested containment as `path.relative(root, x)
 * .startsWith("..")` (`tests/config/path-containment-sweep.test.ts` carried
 * each as a `..`-name row, AGENTS.md shapes 32 and 83). The prefix test reads
 * `..foo/x` as a parent step, so each site answered "outside" for a file under
 * `<root>/..foo/`. They now route through `isUnderDir` (clients/path-utils.ts),
 * which compares whole segments. Each cell below drives one site through its
 * production caller with the same layout: an in-root directory whose name
 * starts with two dots.
 *
 * RECURRENCE GUARDED: the `startsWith("..")` copy of the containment rule at
 * `classifyKnipBinary`, `isSameOrWithin`, `findNestedProjectMutationValue` and
 * `runnerRetirementDecision` (the sites with a directly exported caller). The
 * six sites with another caller carry their cell in the file that already
 * drives that caller: `tests/clients/dependency-checker-madge-resolution.test.ts`,
 * `tests/clients/lsp/root-coalescing.test.ts`,
 * `tests/clients/lsp/server-policy.test.ts`,
 * `tests/clients/dispatch/runners/helm-render.test.ts`,
 * `tests/clients/test-runner-client.test.ts` and
 * `tests/mcp/turn-end-route.smoke.test.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyKnipBinary } from "../../clients/knip-client.js";
import {
	type LensFlagSpec,
	getLensFlagSpec,
} from "../../clients/lens-flag-registry.js";
import { isSameOrWithin } from "../../clients/lsp/server.js";
import {
	findNestedProjectMutationValue,
	resetProjectLensConfigCache,
} from "../../clients/project-lens-config.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../clients/project-trust.js";
import type { WidgetDiagnostic } from "../../clients/widget-state.js";
import { runnerRetirementDecision } from "../../tools/lens-diagnostics.js";
import { setupTestEnvironment } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	resetProjectLensConfigCache();
	resetProjectTrust();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(prefix: string): string {
	const env = setupTestEnvironment(prefix);
	cleanups.push(env.cleanup);
	return fs.realpathSync.native(env.tmpDir);
}

describe("containment reads a ..-named directory as inside (#2556)", () => {
	it("classifies a shim under <root>/..cache as a project binary", () => {
		const root = fixture("pi-lens-2556-knip-");
		const inside = path.join(root, "..cache", "node_modules", ".bin", "knip");
		const sibling = `${root}-sibling`;
		expect({
			dotDotNamed: classifyKnipBinary(inside, root),
			ordinary: classifyKnipBinary(
				path.join(root, "node_modules", ".bin", "knip"),
				root,
			),
			// A sibling directory that merely shares the root's name prefix.
			prefixSibling: classifyKnipBinary(
				path.join(sibling, "node_modules", ".bin", "knip"),
				root,
			),
			parent: classifyKnipBinary(path.join(root, "..", "knip"), root),
		}).toEqual({
			dotDotNamed: "project",
			ordinary: "project",
			prefixSibling: "global",
			parent: "global",
		});
	});

	it("groups a candidate under <root>/..pkg with its root (LSP comparator)", () => {
		const root = path.resolve(path.sep, "work", "proj");
		expect({
			dotDotNamed: isSameOrWithin(root, path.join(root, "..pkg", "a.ts")),
			ordinary: isSameOrWithin(root, path.join(root, "pkg", "a.ts")),
			same: isSameOrWithin(root, root),
			prefixSibling: isSameOrWithin(root, `${root}-x`),
			parent: isSameOrWithin(root, path.dirname(root)),
		}).toEqual({
			dotDotNamed: true,
			ordinary: true,
			same: true,
			prefixSibling: false,
			parent: false,
		});
	});

	it("reads the nested mutation config of a file under <root>/..pkg", () => {
		setProjectTrustState("trusted");
		const root = fixture("pi-lens-2556-nested-");
		const pkg = path.join(root, "..pkg");
		fs.mkdirSync(pkg, { recursive: true });
		fs.writeFileSync(
			path.join(pkg, ".pi-lens.json"),
			JSON.stringify({ format: { enabled: false } }),
		);
		const file = path.join(pkg, "a.ts");
		fs.writeFileSync(file, "export const a = 1;\n");
		const noAutoformat = getLensFlagSpec("no-autoformat") as LensFlagSpec;
		expect(findNestedProjectMutationValue(noAutoformat, file, root)).toEqual({
			value: false,
			dir: pkg,
		});
	});

	it("retires a stale finding for a covered file under <root>/..gen", () => {
		const diagnostic: WidgetDiagnostic = {
			tool: "opengrep",
			severity: "warning",
			message: "retained",
			uri: "",
			rule: "opengrep:finding",
		};
		const file = "/proj/..gen/retained.py";
		const decide = (scanned: string[]) =>
			runnerRetirementDecision(diagnostic, file, new Set(["opengrep"]), [
				{ runnerId: "opengrep", root: "/proj", files: new Set(scanned) },
			]);
		expect({
			scannedUnderDotDotName: decide([file]),
			notScanned: decide(["/proj/other.py"]),
		}).toEqual({ scannedUnderDotDotName: "retire", notScanned: "keep" });
	});
});
