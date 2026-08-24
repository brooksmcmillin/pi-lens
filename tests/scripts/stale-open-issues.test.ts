import { describe, expect, it } from "vitest";
import {
	detectStaleOpenIssues,
	formatSummary,
	MAX_COMMIT_DETAILS,
	MAX_PAGES,
	PAGE_SIZE,
} from "../../scripts/lib/stale-open-issues.mjs";

function fakeGithub(data: Record<string, unknown>) {
	const calls: string[] = [];
	const fetcher = async (url: string) => {
		calls.push(url);
		const key = url.replace("https://api.github.com", "").split("?")[0];
		return { ok: true, status: 200, json: async () => data[key] ?? [] };
	};
	return { fetcher, calls };
}

describe("stale open-issue detector (#1323)", () => {
	it("flags open issues from closing-shaped commits and issue-named regression tests", async () => {
		const { fetcher } = fakeGithub({
			"/repos/acme/repo/issues": [
				{
					number: 10,
					title: "still open",
					html_url: "https://github.com/acme/repo/issues/10",
				},
				{
					number: 11,
					title: "already a PR",
					pull_request: {},
					html_url: "https://github.com/acme/repo/issues/11",
				},
			],
			"/repos/acme/repo/commits": [
				{
					sha: "abcdef123",
					commit: { message: "fix: finished it (closes #10)" },
				},
			],
			"/repos/acme/repo/commits/abcdef123": {
				files: [{ filename: "tests/regression-10.test.ts" }],
			},
		});
		const { candidates, truncatedCommits } = await detectStaleOpenIssues({
			fetcher,
			repository: "acme/repo",
		});
		expect(candidates).toEqual([
			{
				issue: expect.objectContaining({ number: 10 }),
				evidence: [
					"closing-shaped commit abcdef1",
					"regression-test file tests/regression-10.test.ts",
				],
			},
		]);
		expect(truncatedCommits).toBe(0);
	});

	it("ignores issues absent from the open-issue response and non-test filenames", async () => {
		const { fetcher } = fakeGithub({
			"/repos/acme/repo/issues": [
				{ number: 10, title: "open" },
				{ number: 12, title: "pull request", pull_request: {} },
			],
			"/repos/acme/repo/commits": [
				{ sha: "abc", commit: { message: "docs: mention fixes #12" } },
			],
			"/repos/acme/repo/commits/abc": { files: [{ filename: "src/12.ts" }] },
		});
		expect(
			(await detectStaleOpenIssues({ fetcher, repository: "acme/repo" }))
				.candidates,
		).toEqual([]);
	});

	// #1356 review: quoted keyword text and reverts are not closing intent.
	it("ignores quoted and reverted closing-shaped text", async () => {
		const { fetcher } = fakeGithub({
			"/repos/acme/repo/issues": [{ number: 42, title: "open" }],
			"/repos/acme/repo/commits": [
				{
					sha: "a1",
					commit: { message: 'docs: quote "closes #42" as an example' },
				},
				{ sha: "a2", commit: { message: 'Revert "fix: closes #42"' } },
			],
			"/repos/acme/repo/commits/a1": { files: [] },
			"/repos/acme/repo/commits/a2": { files: [] },
		});
		expect(
			(await detectStaleOpenIssues({ fetcher, repository: "acme/repo" }))
				.candidates,
		).toEqual([]);
	});

	// #1356 review: the commit-detail cap must be reported, never silent.
	it("reports commits beyond the detail cap in the summary", async () => {
		const commits = Array.from({ length: MAX_COMMIT_DETAILS + 5 }, (_, i) => ({
			sha: `sha${i}`,
			commit: { message: "chore: routine" },
		}));
		const data: Record<string, unknown> = {
			"/repos/acme/repo/issues": [],
			"/repos/acme/repo/commits": commits,
		};
		for (const c of commits)
			data[`/repos/acme/repo/commits/${c.sha}`] = { files: [] };
		// Page-aware: the commit list is served once, then empty, so pagination
		// terminates and the cap arithmetic sees exactly `commits.length`.
		const served = new Set<string>();
		const fetcher = async (url: string) => {
			const key = url.replace("https://api.github.com", "").split("?")[0];
			let payload = data[key] ?? [];
			if (key === "/repos/acme/repo/commits") {
				payload = served.has(url) || served.has(key) ? [] : payload;
				served.add(key);
			}
			return { ok: true, status: 200, json: async () => payload };
		};
		const { candidates, truncatedCommits } = await detectStaleOpenIssues({
			fetcher,
			repository: "acme/repo",
		});
		expect(truncatedCommits).toBe(5);
		expect(formatSummary(candidates, { truncatedCommits })).toContain(
			"5 commit(s) beyond",
		);
	});

	it("keeps API work bounded and formats one detection-only summary", async () => {
		const { fetcher, calls } = fakeGithub({
			"/repos/acme/repo/issues": [],
			"/repos/acme/repo/commits": [],
		});
		expect(
			(await detectStaleOpenIssues({ fetcher, repository: "acme/repo" }))
				.candidates,
		).toEqual([]);
		expect(MAX_PAGES).toBe(3);
		expect(PAGE_SIZE).toBe(100);
		expect(MAX_COMMIT_DETAILS).toBe(100);
		expect(calls[0]).toContain("per_page=100");
		expect(formatSummary([], { runUrl: "https://example/run" })).toContain(
			"never closes issues",
		);
	});
});
