/**
 * Track B (#775) item 3 — scale knob end-to-end (post-#779).
 *
 * A `.pi-lens.json` with a small `maxProjectFiles` at the monorepo root
 * actually changes the EFFECTIVE startup-scan and review-graph budgets,
 * observed via behavior (a verdict/build-skip flip), not just via the
 * `project-scale.ts` getters (already unit-tested in
 * `tests/clients/project-scale.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactStore } from "../../clients/dispatch/fact-store.js";
import { resolveStartupScanContext } from "../../clients/startup-scan.js";
import { buildOrUpdateGraph } from "../../clients/review-graph/service.js";
import {
	clearGraphCache,
	clearReviewGraphWorkspaceCache,
	getLastGraphBuildInfo,
} from "../../clients/review-graph/builder.js";
import { clearModuleGraphCache } from "../../clients/review-graph/workspace-modules.js";
import { resetProjectLensConfigCache } from "../../clients/project-lens-config.js";
import { makeMonorepo, type MonorepoPackageSpec } from "./fixture.js";
import { withEnv } from "../support/with-env.js";

function fileMap(count: number): Record<string, string> {
	const files: Record<string, string> = {};
	for (let i = 0; i < count; i++) {
		files[`src/file${i}.ts`] = `export const v${i} = ${i};\n`;
	}
	return files;
}

describe("monorepo .pi-lens.json maxProjectFiles scale knob, end-to-end (#775 item 3, post-#779)", () => {
	// `PI_LENS_REVIEW_GRAPH_MAX_FILES` wins outright over the derived budget
	// (`getReviewGraphMaxFiles`, clients/review-graph/builder.ts), so an ambient
	// value decides every review-graph verdict here. Cleared for each case and
	// restored after. Recurrence: with it set to 2, the skip case below reds and
	// the new it.each rows stay green under the floor mutation (review of #4979).
	let restoreEnv: (() => void) | undefined;
	beforeEach(() => {
		restoreEnv = withEnv({ PI_LENS_REVIEW_GRAPH_MAX_FILES: undefined });
	});
	afterEach(() => {
		restoreEnv?.();
		restoreEnv = undefined;
		resetProjectLensConfigCache();
		clearReviewGraphWorkspaceCache();
		clearModuleGraphCache();
	});

	it("a root .pi-lens.json maxProjectFiles=3 flips the startup-scan verdict at its derived (1.25x) source-file budget", () => {
		// startupScan ratio is 1.25x maxProjectFiles (project-scale.ts), so
		// maxProjectFiles: 3 derives a startup-scan budget of 4 source files.
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(5), // one over the derived budget
		};
		const repo = makeMonorepo({
			packages: [pkg],
			rootPiLensConfig: { maxProjectFiles: 3 },
		});
		try {
			const ctx = resolveStartupScanContext(repo.root, {
				homeDir: repo.root + "-not-home",
				// No explicit maxSourceFiles override — let the derived value from
				// the fixture's own .pi-lens.json flow through.
			});
			expect(ctx.canWarmCaches).toBe(false);
			expect(ctx.reason).toBe("too-many-source-files");
		} finally {
			repo.cleanup();
		}
	});

	// RECURRENCE THIS PREVENTS: the derived budget rounding down instead of to
	// nearest, or the ratio drifting below 1.25 (floor and a ratio of 1 both
	// derive 3, not 4). The 5-file case above is over the budget under every
	// ratio below 1.5, so it cannot see the cliff move downward; only the file
	// count AT the derived budget can. Mutation: `Math.round(` -> `Math.floor(`
	// in `deriveBudget` (clients/project-scale.js) leaves the case above and
	// tests/clients/project-scale.test.ts green and reds this one.
	it("a root .pi-lens.json maxProjectFiles=3 still warms at exactly its derived source-file budget (4 files)", () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(4), // exactly the derived budget: round(3 * 1.25)
		};
		const repo = makeMonorepo({
			packages: [pkg],
			rootPiLensConfig: { maxProjectFiles: 3 },
		});
		try {
			const ctx = resolveStartupScanContext(repo.root, {
				homeDir: repo.root + "-not-home",
			});
			expect(ctx.canWarmCaches).toBe(true);
			expect(ctx.sourceFileCount).toBe(4);
		} finally {
			repo.cleanup();
		}
	});

	it("the SAME fixture warms fine under a larger maxProjectFiles (proves the .pi-lens.json value, not a hardcoded default, drove the flip)", () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(4),
		};
		const repo = makeMonorepo({
			packages: [pkg],
			rootPiLensConfig: { maxProjectFiles: 100 },
		});
		try {
			const ctx = resolveStartupScanContext(repo.root, {
				homeDir: repo.root + "-not-home",
			});
			expect(ctx.canWarmCaches).toBe(true);
		} finally {
			repo.cleanup();
		}
	});

	it("a root .pi-lens.json maxProjectFiles=2 flips the review-graph build to skipped at its derived (0.5x) file budget", async () => {
		// reviewGraph ratio is 0.5x maxProjectFiles, so maxProjectFiles: 2 derives
		// a review-graph cap of 1 file — this fixture's 2 source files exceed it.
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(2),
		};
		const repo = makeMonorepo({
			packages: [pkg],
			rootPiLensConfig: { maxProjectFiles: 2 },
		});
		try {
			clearGraphCache();
			const graph = await buildOrUpdateGraph(repo.root, [], new FactStore());
			expect(graph.nodes.size).toBe(0);
			expect(getLastGraphBuildInfo().skipReason).toBe("too_many_files");
		} finally {
			repo.cleanup();
		}
	});

	// RECURRENCE THIS PREVENTS: the review-graph budget rounding down instead of
	// to nearest. maxProjectFiles=2 derives a cap of 1 under round and floor
	// alike, so the skip case above cannot see the rounding; maxProjectFiles=3
	// derives round(1.5) = 2 (floor gives 1). Mutation: `Math.round(linearValue)`
	// -> `Math.floor(linearValue)` in `taperedReviewGraphMaxFiles`
	// (clients/project-scale.js) leaves the skip case and
	// tests/clients/project-scale.test.ts green and reds the "builds at the cap"
	// row.
	it.each([
		{ files: 2, builds: true }, // exactly the derived cap: round(3 * 0.5)
		{ files: 3, builds: false }, // one over it
	])(
		"a root .pi-lens.json maxProjectFiles=3 derives a review-graph cap of 2: $files files build=$builds",
		async ({ files, builds }) => {
			const pkg: MonorepoPackageSpec = {
				name: "@scope/a",
				dir: "packages/a",
				files: fileMap(files),
			};
			const repo = makeMonorepo({
				packages: [pkg],
				rootPiLensConfig: { maxProjectFiles: 3 },
			});
			try {
				clearGraphCache();
				const graph = await buildOrUpdateGraph(repo.root, [], new FactStore());
				expect(graph.nodes.size > 0).toBe(builds);
				expect(getLastGraphBuildInfo().skipReason).toBe(
					builds ? undefined : "too_many_files",
				);
			} finally {
				repo.cleanup();
			}
		},
	);

	it("the SAME fixture builds fine under a larger maxProjectFiles", async () => {
		const pkg: MonorepoPackageSpec = {
			name: "@scope/a",
			dir: "packages/a",
			files: fileMap(2),
		};
		const repo = makeMonorepo({
			packages: [pkg],
			rootPiLensConfig: { maxProjectFiles: 100 },
		});
		try {
			clearGraphCache();
			const graph = await buildOrUpdateGraph(repo.root, [], new FactStore());
			expect(graph.nodes.size).toBeGreaterThan(0);
			expect(getLastGraphBuildInfo().skipReason).toBeUndefined();
		} finally {
			repo.cleanup();
		}
	});
});
