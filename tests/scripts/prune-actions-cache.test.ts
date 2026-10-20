// #4358: scripts/prune-actions-cache.mjs frees the repository's 10 GB Actions
// cache of entries nothing restores again, so the smoke workflows' new caches
// are not evicted at once. The fixtures are the key shapes the live cache list
// held on 2026-10-14 (51 caches, 10282 MB: five ~614 MB CodeQL overlay base
// databases, 21 CodeQL trap caches, npm caches per OS, merged-PR copies).
// Every case names the recurrence it keeps out.
import { describe, expect, it, vi } from "vitest";
import {
	cacheFamily,
	LIST_LIMIT,
	main,
	planPrune,
	prune,
} from "../../scripts/prune-actions-cache.mjs";

// Run ids are 11 digits on the live list (38444783078).
const OVERLAY = (run: number, sha: string) =>
	`codeql-overlay-base-database-1-673738e94a8102ad-javascript-2.27.2-${sha}-${38_444_000_000 + run}-1`;
const sha = (n: number) => String(n).padStart(40, "a");

let nextId = 1;
function cache(
	key: string,
	ref: string,
	createdAt: string,
	sizeInBytes = 100,
	id = nextId++,
) {
	return { id, key, ref, sizeInBytes, createdAt };
}
const ids = (plan: Array<{ id: number }>) => plan.map((entry) => entry.id);

describe("cacheFamily", () => {
	// Recurrence: grouping by exact key would never see two saves as one cache,
	// so the five overlay copies (one per master push) would all survive.
	it("puts successive saves of one cache in one family", () => {
		expect(cacheFamily(OVERLAY(1, sha(1)))).toBe(
			cacheFamily(OVERLAY(2, sha(2))),
		);
		expect(cacheFamily(`npm-Linux-node-22-${"1".repeat(64)}`)).toBe(
			cacheFamily(`npm-Linux-node-22-${"2".repeat(64)}`),
		);
		expect(
			cacheFamily(
				"setup-zig-cache-v2-tool_smoke-zig-x86_64-linux-0.17.0--38553528097-1",
			),
		).toBe(
			cacheFamily(
				"setup-zig-cache-v2-tool_smoke-zig-x86_64-linux-0.17.0--38445971980-1",
			),
		);
	});

	// Recurrence: over-merging would let one OS's cache shadow another's.
	it("keeps different operating systems and tools apart", () => {
		expect(cacheFamily(`node-cache-Linux-x64-npm-${"1".repeat(64)}`)).not.toBe(
			cacheFamily(`node-cache-Windows-x64-npm-${"1".repeat(64)}`),
		);
		expect(
			cacheFamily(`tool-smoke-tools-Linux-X64-2026-W42-${"1".repeat(64)}`),
		).not.toBe(
			cacheFamily(`parser-smoke-tools-Linux-X64-2026-W42-${"1".repeat(64)}`),
		);
	});
});

describe("planPrune", () => {
	const base = { openPulls: [10], branches: ["feature/open"] };

	// Recurrence: the five ~614 MB overlay copies on master were 3 GB of the
	// 10 GB cap, and only the newest is read.
	it("keeps one CodeQL overlay base database and deletes the older copies", () => {
		const copies = [1, 2, 3, 4, 5].map((n) =>
			cache(OVERLAY(n, sha(n)), "refs/heads/master", `2026-10-13T18:0${n}:00Z`),
		);
		const plan = planPrune({ ...base, caches: copies });
		expect(ids(plan).sort()).toEqual(ids(copies.slice(0, 4)).sort());
		expect(plan.every((entry) => /keep 1\)$/.test(entry.reason))).toBe(true);
	});

	// Recurrence: a flat keep-1 for every family would drop the previous
	// lockfile's npm cache that a revert or a still-running job restores.
	it("keeps the two newest copies of any other family", () => {
		const copies = [1, 2, 3, 4].map((n) =>
			cache(
				`node-cache-Linux-x64-npm-${String(n).repeat(64)}`,
				"refs/heads/master",
				`2026-10-1${n}T00:00:00Z`,
			),
		);
		const plan = planPrune({ ...base, caches: copies });
		expect(ids(plan).sort()).toEqual(ids(copies.slice(0, 2)).sort());
	});

	// Recurrence: the merged-PR npm caches (~170 MB each, 25 caches / 3.8 GB on
	// refs/pull/N/merge) are never restored once the PR closes.
	it("deletes caches of pull requests that are not open and keeps open ones", () => {
		const closed = cache(
			"npm-Linux-node-22-x",
			"refs/pull/4372/merge",
			"2026-10-13T00:00:00Z",
		);
		const closedHead = cache(
			"npm-Linux-node-22-y",
			"refs/pull/4372/head",
			"2026-10-13T00:00:00Z",
		);
		const open = cache(
			"npm-Linux-node-22-z",
			"refs/pull/10/merge",
			"2026-10-13T00:00:00Z",
		);
		const plan = planPrune({ ...base, caches: [closed, closedHead, open] });
		expect(ids(plan).sort()).toEqual([closed.id, closedHead.id].sort());
		expect(plan[0].reason).toBe("PR #4372 is not open");
	});

	// Recurrence: a branch-dispatch smoke run saves a branch-scoped cache; once
	// the branch is merged and deleted nothing reads it.
	it("deletes caches of a deleted branch and keeps a live branch's", () => {
		const gone = cache(
			"tool-smoke-tools-a",
			"refs/heads/fix/4339-gone",
			"2026-10-13T00:00:00Z",
		);
		const live = cache(
			"tool-smoke-tools-b",
			"refs/heads/feature/open",
			"2026-10-13T00:00:00Z",
		);
		const plan = planPrune({ ...base, caches: [gone, live] });
		expect(ids(plan)).toEqual([gone.id]);
	});

	// Recurrence: a rule that matched the default branch by prefix would prune a
	// branch named master-backup as if it were master's family history.
	it("applies the default-branch family rule only to the default branch's ref", () => {
		const copies = [1, 2, 3].map((n) =>
			cache(
				`npm-Linux-node-22-${String(n).repeat(64)}`,
				"refs/heads/master-backup",
				`2026-10-1${n}T00:00:00Z`,
			),
		);
		expect(
			planPrune({ ...base, caches: copies, branches: ["master-backup"] }),
		).toEqual([]);
	});

	// Recurrence: an unknown ref shape (a tag) must not be guessed at.
	it("leaves a tag ref alone", () => {
		const tag = cache("npm-x", "refs/tags/v4.4.3", "2026-10-13T00:00:00Z");
		expect(planPrune({ ...base, caches: [tag] })).toEqual([]);
	});

	// Recurrence: a fresh smoke cache must survive its own cleanup: with one
	// copy per family on master nothing is deleted.
	it("deletes nothing when each default-branch family has one copy", () => {
		const caches = [
			cache(
				`tool-smoke-tools-Linux-X64-2026-W42-${"1".repeat(64)}`,
				"refs/heads/master",
				"2026-10-14T00:00:00Z",
			),
			cache(
				`parser-smoke-tools-Linux-X64-2026-W42-${"1".repeat(64)}`,
				"refs/heads/master",
				"2026-10-14T00:00:00Z",
			),
		];
		expect(planPrune({ ...base, caches })).toEqual([]);
	});
});

describe("prune (the gh boundary)", () => {
	function fakeGh(options: { caches?: unknown; failDelete?: number } = {}) {
		const calls: string[][] = [];
		const caches = options.caches ?? [
			cache(
				"npm-a",
				"refs/pull/99/merge",
				"2026-10-01T00:00:00Z",
				5_000_000,
				901,
			),
			cache(
				"npm-b",
				"refs/pull/98/merge",
				"2026-10-01T00:00:00Z",
				7_000_000,
				902,
			),
			cache("npm-c", "refs/pull/10/merge", "2026-10-01T00:00:00Z", 100, 903),
		];
		const gh = (args: string[]) => {
			calls.push(args);
			if (args[0] === "cache" && args[1] === "list")
				return JSON.stringify(caches);
			if (args[0] === "pr") return JSON.stringify([{ number: 10 }]);
			if (args[0] === "api") return "master\nfeature/open\n";
			if (args[0] === "cache" && args[1] === "delete") {
				if (Number(args[2]) === options.failDelete)
					throw new Error("HTTP 500\nboom");
				return "";
			}
			throw new Error(`unexpected gh ${args.join(" ")}`);
		};
		return { gh, calls };
	}
	const deletes = (calls: string[][]) =>
		calls.filter((args) => args[0] === "cache" && args[1] === "delete");

	// Recurrence: a cleanup that deletes on its first run, before anyone read
	// the plan, is the by-hand `gh cache delete` the workflow exists to replace.
	it("deletes nothing without --apply", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { gh, calls } = fakeGh();
		const result = prune(gh, { apply: false, defaultBranch: "master" });
		log.mockRestore();
		expect(deletes(calls)).toEqual([]);
		expect(result).toMatchObject({
			planned: 2,
			total: 3,
			bytes: 12_000_000,
			failed: 0,
		});
	});

	it("deletes exactly the planned ids with --apply", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { gh, calls } = fakeGh();
		const result = prune(gh, { apply: true, defaultBranch: "master" });
		const lines = log.mock.calls.map((call) => String(call[0]));
		log.mockRestore();
		expect(
			deletes(calls)
				.map((args) => Number(args[2]))
				.sort(),
		).toEqual([901, 902]);
		expect(result.failed).toBe(0);
		expect(lines.at(-1)).toBe(
			"cache-prune: applied, 2 of 3 caches, 12 MB of 12 MB, 0 failed",
		);
	});

	// Recurrence: one 5xx on the first delete must not stop the other deletes,
	// and must not read as success.
	it("tries every delete after a failure and reports it", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { gh, calls } = fakeGh({ failDelete: 901 });
		const result = prune(gh, { apply: true, defaultBranch: "master" });
		const lines = log.mock.calls.map((call) => String(call[0]));
		log.mockRestore();
		expect(deletes(calls)).toHaveLength(2);
		expect(result.failed).toBe(1);
		expect(
			lines.filter((line) => line.startsWith("FAILED (HTTP 500)")),
		).toHaveLength(1);
		expect(lines.filter((line) => line.startsWith("deleted 902"))).toHaveLength(
			1,
		);
	});

	// Recurrence: a listing that came back truncated or not as an array must
	// stop the run before any delete, because the plan would be against a
	// partial picture.
	it.each([
		["a non-array listing", { error: "x" }],
		[
			"a listing at the --limit ceiling",
			Array.from({ length: LIST_LIMIT }, (_, n) =>
				cache(`k${n}`, "refs/heads/master", "2026-10-01T00:00:00Z"),
			),
		],
	])("refuses to plan against %s", (_name, caches) => {
		const { gh, calls } = fakeGh({ caches });
		expect(() => prune(gh, { apply: true, defaultBranch: "master" })).toThrow(
			/refusing to plan/,
		);
		expect(deletes(calls)).toEqual([]);
	});

	// Recurrence: an `gh pr list` failure must not read as "no open PRs", which
	// would delete every open PR's cache.
	it("lets a failed open-PR listing abort before any delete", () => {
		const { gh, calls } = fakeGh();
		const failing = (args: string[]) => {
			if (args[0] === "pr") throw new Error("HTTP 502");
			return gh(args);
		};
		expect(() =>
			prune(failing, { apply: true, defaultBranch: "master" }),
		).toThrow("HTTP 502");
		expect(deletes(calls)).toEqual([]);
	});
});

describe("tool-tree caches are bounded by count (r1 F3)", () => {
	const week = (n: number) =>
		cache(
			`tool-smoke-tools-Linux-X64-2026-W${40 + n}-${"1".repeat(64)}`,
			"refs/heads/master",
			`2026-10-0${n}T04:00:00Z`,
			943_000_000,
		);

	// Recurrence: review r1 F3. The ISO week sat inside the family, so five
	// weekly 943 MB trees were five families of one and keep-2 never matched.
	it("groups weekly copies of one tree and keeps the newest two", () => {
		const copies = [1, 2, 3, 4, 5].map(week);
		const plan = planPrune({ caches: copies, openPulls: [], branches: [] });
		expect(ids(plan).sort()).toEqual(ids(copies.slice(0, 3)).sort());
	});

	// A pin change is a different hash, not a different family, so it competes
	// with last week's tree for the two slots rather than adding a third.
	it("keeps a tree per workflow prefix apart", () => {
		expect(cacheFamily(week(1).key)).not.toBe(
			cacheFamily(
				week(1).key.replace("tool-smoke-tools", "parser-smoke-tools"),
			),
		);
	});
});

describe("main (the CLI parse)", () => {
	const caches = [
		cache("npm-a", "refs/pull/99/merge", "2026-10-01T00:00:00Z", 100, 701),
		cache(
			`tool-develop-${"1".repeat(64)}`,
			"refs/heads/develop",
			"2026-10-03T00:00:00Z",
			100,
			711,
		),
		cache(
			`tool-develop-${"2".repeat(64)}`,
			"refs/heads/develop",
			"2026-10-02T00:00:00Z",
			100,
			712,
		),
		cache(
			`tool-develop-${"3".repeat(64)}`,
			"refs/heads/develop",
			"2026-10-01T00:00:00Z",
			100,
			713,
		),
	];
	function run(argv: string[]) {
		const calls: string[][] = [];
		const gh = (args: string[]) => {
			calls.push(args);
			if (args[0] === "cache" && args[1] === "list")
				return JSON.stringify(caches);
			if (args[0] === "pr") return JSON.stringify([{ number: 10 }]);
			if (args[0] === "api") return "develop\n";
			return "";
		};
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const code = main(argv, gh);
		const out = log.mock.calls.map((call) => String(call[0]));
		const err = error.mock.calls.map((call) => String(call[0]));
		log.mockRestore();
		error.mockRestore();
		const deleted = calls
			.filter((args) => args[0] === "cache" && args[1] === "delete")
			.map((args) => Number(args[2]))
			.sort();
		return { code, out, err, deleted };
	}

	// Recurrence: review r1 F1. `const apply = argv.includes("--apply")` set to
	// false makes the nightly prune a green no-op and the cap problem returns;
	// set to true, a PR dry run deletes. No test ran `main`, so both survived.
	it("deletes nothing without --apply", () => {
		const result = run(["--default-branch", "develop"]);
		expect(result.deleted).toEqual([]);
		expect(result.out.at(-1)).toMatch(/^cache-prune: dry-run, /);
		expect(result.code).toBe(0);
	});

	it("deletes the planned caches with --apply", () => {
		const result = run(["--apply", "--default-branch", "develop"]);
		expect(result.deleted).toEqual([701, 713]);
		expect(result.out.at(-1)).toMatch(/^cache-prune: applied, 2 of 4 caches/);
		expect(result.code).toBe(0);
	});

	// Recurrence: a hard-coded `master` would apply the keep-2 rule to the wrong
	// ref (here develop is the default, so its third copy is superseded).
	it("takes the default branch from --default-branch", () => {
		const result = run(["--default-branch", "develop"]);
		expect(
			result.out.filter((line) => line.includes("superseded")),
		).toHaveLength(1);
	});

	it.each([[["--default-branch"]], [["--default-branch", "--apply"]]])(
		"exits 2 on %j and calls gh never",
		(argv) => {
			const result = run(argv);
			expect(result.code).toBe(2);
			expect(result.deleted).toEqual([]);
			expect(result.err).toEqual(["--default-branch needs a branch name"]);
		},
	);
});

describe("an empty open-PR list never deletes PR caches (r1 F5)", () => {
	function fakeGh(prs: unknown[]) {
		const calls: string[][] = [];
		const caches = [
			cache(
				"npm-open",
				"refs/pull/4338/merge",
				"2026-10-13T00:00:00Z",
				100,
				801,
			),
			cache("npm-old", "refs/pull/1/merge", "2026-10-01T00:00:00Z", 100, 802),
			cache("tool-a", "refs/heads/gone", "2026-10-01T00:00:00Z", 100, 803),
		];
		const gh = (args: string[]) => {
			calls.push(args);
			if (args[0] === "cache" && args[1] === "list")
				return JSON.stringify(caches);
			if (args[0] === "pr") return JSON.stringify(prs);
			if (args[0] === "api") return "master\n";
			return "";
		};
		return { gh, calls };
	}
	const deleted = (calls: string[][]) =>
		calls
			.filter((args) => args[0] === "cache" && args[1] === "delete")
			.map((args) => Number(args[2]));

	// Recurrence: review r1 F5. A well-formed but wrong `gh pr list` (an empty
	// array) read as "no PR is open" and --apply deleted open PR 4338's cache.
	it("skips every PR-ref delete and reports why, but still prunes branches", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { gh, calls } = fakeGh([]);
		const result = prune(gh, { apply: true, defaultBranch: "master" });
		const lines = log.mock.calls.map((call) => String(call[0]));
		log.mockRestore();
		expect(deleted(calls)).toEqual([803]);
		expect(result.planned).toBe(1);
		expect(
			lines.filter((line) => line.startsWith("skipped 2 PR-cache deletions")),
		).toHaveLength(1);
	});

	it("still deletes a closed PR's cache when some PR is open", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const { gh, calls } = fakeGh([{ number: 4338 }]);
		prune(gh, { apply: true, defaultBranch: "master" });
		log.mockRestore();
		expect(deleted(calls).sort()).toEqual([802, 803]);
	});
});
