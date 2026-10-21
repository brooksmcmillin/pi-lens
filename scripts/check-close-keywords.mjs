import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchLivePrBody } from "./check-pr-body.mjs";
import { githubGet } from "./lib/github-rest.mjs";
import {
	commitCloseKeywordErrors,
	closeKeywordErrors,
	closeKeywordPlacementMessage,
	INVALID_CLOSE_KEYWORD_MESSAGE,
	NEGATED_CLOSE_KEYWORD_MESSAGE,
	lintCloseKeywordPlacement,
	lintCloseKeywords,
	lintCommitCloseKeywords,
	parseCloseKeywords,
	stripNonSemanticMarkdown,
} from "./lib/close-keywords.mjs";

export {
	commitCloseKeywordErrors,
	closeKeywordErrors,
	closeKeywordPlacementMessage,
	INVALID_CLOSE_KEYWORD_MESSAGE,
	NEGATED_CLOSE_KEYWORD_MESSAGE,
	lintCloseKeywordPlacement,
	lintCloseKeywords,
	lintCommitCloseKeywords,
	parseCloseKeywords,
	stripNonSemanticMarkdown,
};

function eventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
	return JSON.parse(readFileSync(eventPath, "utf8"));
}

// #4371: GitHub lists at most 250 commits of a pull request, 100 per page.
const COMMIT_PAGE_SIZE = 100;
const COMMIT_LIST_CAP = 250;
const COMPARISON_COMMIT_CAP = 10_000;
// Operator-approved apmantza/pi-lens snapshot; never take this pin from PR input.
const APPROVED_UPSTREAM = "7f5af3a48ce72a7ad6b2ef712b09aa113541c1ac";
const PROVENANCE_FORK = "brooksmcmillin/pi-lens";

// Unlike the PR-list endpoint, an explicitly paginated comparison includes
// the complete range. Pin both ends so pages cannot mix moving branch tips.
async function fetchComparedCommits(base, head, fetchImpl) {
	if (
		![base, head].every(
			(sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
		)
	)
		throw new Error("pinned base and head SHAs are required");
	const commits = [];
	const seen = new Set();
	let total;
	for (let page = 1; ; page++) {
		const response = await githubGet(
			`/compare/${base}...${head}?per_page=${COMMIT_PAGE_SIZE}&page=${page}`,
			fetchImpl,
		);
		if (!response.ok)
			throw new Error(`GitHub comparison returned ${response.status}`);
		const data = await response.json();
		if (
			data.base_commit?.sha !== base ||
			!Number.isSafeInteger(data.total_commits) ||
			data.total_commits < 0 ||
			(data.total_commits === 0 &&
				!["behind", "identical"].includes(data.status)) ||
			data.total_commits > COMPARISON_COMMIT_CAP ||
			(total !== undefined && total !== data.total_commits) ||
			!Array.isArray(data.commits) ||
			data.commits.length > COMMIT_PAGE_SIZE
		)
			throw new Error(
				"GitHub comparison has invalid or inconsistent range metadata",
			);
		total = data.total_commits;
		for (const entry of data.commits) {
			if (
				typeof entry?.sha !== "string" ||
				!/^[a-f0-9]{40}$/.test(entry.sha) ||
				typeof entry?.commit?.message !== "string" ||
				seen.has(entry.sha)
			)
				throw new Error("GitHub comparison has an invalid or duplicate commit");
			seen.add(entry.sha);
			commits.push({ sha: entry.sha, message: entry.commit.message });
		}
		if (
			commits.length > total ||
			(commits.length < total && data.commits.length !== COMMIT_PAGE_SIZE)
		)
			throw new Error("GitHub comparison returned an incomplete commit range");
		if (commits.length === total) {
			if (total > 0 && !seen.has(head))
				throw new Error("GitHub comparison omitted the pinned head");
			return commits;
		}
	}
}

// Throws when the list cannot be read in full, so the caller fails closed
// instead of linting a partial list.
async function fetchPrCommits(payloadPr, fetchImpl) {
	const commits = [];
	for (let page = 1; commits.length < COMMIT_LIST_CAP; page++) {
		const response = await githubGet(
			`/pulls/${payloadPr.number}/commits?per_page=${COMMIT_PAGE_SIZE}&page=${page}`,
			fetchImpl,
		);
		if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
		const data = await response.json();
		if (!Array.isArray(data))
			throw new Error("GitHub API returned no commit list");
		for (const entry of data) {
			if (typeof entry?.commit?.message !== "string")
				throw new Error("GitHub API returned a commit without a message");
			commits.push({ sha: entry.sha, message: entry.commit.message });
		}
		if (data.length < COMMIT_PAGE_SIZE) break;
	}
	if (commits.length >= COMMIT_LIST_CAP) {
		const base = payloadPr.base?.sha;
		const head = payloadPr.head?.sha;
		return fetchComparedCommits(base, head, fetchImpl);
	}
	return commits;
}

async function admitImportedClosures(result, base, fetchImpl) {
	const upstream = new Set(
		(await fetchComparedCommits(base, APPROVED_UPSTREAM, fetchImpl)).map(
			({ sha }) => sha,
		),
	);
	const imported = result.offenses.filter(({ sha }) => upstream.has(sha));
	if (imported.length === 0) return result;

	// Only a verified public repository makes a missing issue an unambiguous
	// absence rather than a private-resource authorization failure.
	const response = await githubGet("", fetchImpl);
	if (!response.ok) throw new Error(`Fork lookup returned ${response.status}`);
	const repository = await response.json();
	if (repository.full_name !== PROVENANCE_FORK || repository.private !== false)
		throw new Error("Imported references require the verified public fork");
	const harmless = new Set();
	for (const number of new Set(imported.map((offense) => offense.number))) {
		const issueResponse = await githubGet(`/issues/${number}`, fetchImpl);
		if (issueResponse.status === 404) {
			harmless.add(number);
			continue;
		}
		if (!issueResponse.ok)
			throw new Error(
				`Issue #${number} lookup returned ${issueResponse.status}`,
			);
		const issue = await issueResponse.json();
		if (issue.number !== number || !["open", "closed"].includes(issue.state))
			throw new Error(`GitHub returned an invalid issue #${number}`);
		if (issue.state === "closed") harmless.add(number);
	}
	const offenses = result.offenses.filter(
		({ sha, number }) => !(upstream.has(sha) && harmless.has(number)),
	);
	const admitted = result.offenses.length - offenses.length;
	console.log(
		`Close-keyword provenance: admitted ${admitted} imported reference(s) from ${APPROVED_UPSTREAM}.`,
	);
	return { ...result, valid: offenses.length === 0, offenses };
}

export async function lintPullRequest(
	fetchImpl = globalThis.fetch,
	event = eventPayload(),
) {
	const pullRequest = event.pull_request;
	if (!pullRequest || !process.env.GITHUB_REPOSITORY)
		throw new Error("Pull request event and GITHUB_REPOSITORY are required");
	// Same fail-closed reporting contract as verifyMergedPullRequest: a fetch
	// failure states plainly that the check did not run, instead of surfacing
	// as a bare thrown message that reads like a broken script (worst for
	// fork PRs hitting a transient 5xx).
	let body;
	let title;
	try {
		({ body, title } = await fetchLivePrBody(pullRequest, fetchImpl));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(
			`::error::Close-keyword syntax check could not fetch the live PR body, so it did not run: ${reason}`,
		);
		process.exitCode = 1;
		return;
	}
	const result = lintCloseKeywords(body);
	if (!result.valid) {
		for (const line of closeKeywordErrors(result)) console.error(line);
		process.exitCode = 1;
		return;
	}
	const placement = lintCloseKeywordPlacement(title, body);
	if (!placement.valid) {
		console.error(closeKeywordPlacementMessage(placement.missingBodyIssues));
		process.exitCode = 1;
		return;
	}
	// #4371: GitHub also closes on a keyword in a commit message that reaches
	// master (merge commits and rebase merges land every commit; a squash lands
	// a message built from them), so every listed commit is scanned, merge
	// commits included.
	let commits;
	try {
		commits = await fetchPrCommits(pullRequest, fetchImpl);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(
			`::error::Close-keyword syntax check could not read the PR commits, so it did not scan commit messages: ${reason}`,
		);
		process.exitCode = 1;
		return;
	}
	let commitResult = lintCommitCloseKeywords(commits, title, body);
	if (
		!commitResult.valid &&
		process.env.GITHUB_REPOSITORY === PROVENANCE_FORK
	) {
		try {
			commitResult = await admitImportedClosures(
				commitResult,
				pullRequest.base?.sha,
				fetchImpl,
			);
		} catch (error) {
			console.error(
				`::error::Close-keyword provenance could not be verified: ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exitCode = 1;
			return;
		}
	}
	if (!commitResult.valid) {
		for (const line of commitCloseKeywordErrors(commitResult))
			console.error(line);
		process.exitCode = 1;
		return;
	}
	console.log(
		`Close-keyword syntax OK (${result.issues.length} issue${result.issues.length === 1 ? "" : "s"} referenced).`,
	);
}

// #4371 F5: the PR number GitHub's ClosedEvent names as the closer; null when
// the issue was closed by something else, undefined when the lookup failed.
function issueCloser(repository, number) {
	const [owner, name] = repository.split("/");
	try {
		const out = execFileSync(
			"gh",
			[
				"api",
				"graphql",
				"-F",
				`owner=${owner}`,
				"-F",
				`name=${name}`,
				"-F",
				`number=${number}`,
				"-f",
				"query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{closer{... on PullRequest{number}}}}}}}}",
				"--jq",
				".data.repository.issue.timelineItems.nodes[0].closer.number",
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		).trim();
		return out === "" || out === "null" ? null : Number(out);
	} catch {
		return undefined;
	}
}

function issueState(repository, number) {
	try {
		return execFileSync(
			"gh",
			["api", `repos/${repository}/issues/${number}`, "--jq", ".state"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		).trim();
	} catch {
		return "not found";
	}
}

/**
 * @param {typeof fetch} [fetchImpl]
 * @param {object} [event] injectable event payload (tests only; defaults to
 *   the real GITHUB_EVENT_PATH payload)
 * @param {(repository: string, number: number) => string} [getIssueState]
 *   injectable issue-state lookup (tests only; defaults to the real `gh api`
 *   call)
 * @param {(repository: string, number: number) => number | null | undefined} [getIssueCloser]
 *   injectable lookup of the PR a closed issue's ClosedEvent names (tests only)
 */
export async function verifyMergedPullRequest(
	fetchImpl = globalThis.fetch,
	event = eventPayload(),
	getIssueState = issueState,
	getIssueCloser = issueCloser,
) {
	const pullRequest = event.pull_request;
	const repository = process.env.GITHUB_REPOSITORY;
	if (!pullRequest || !repository)
		throw new Error("Pull request event and GITHUB_REPOSITORY are required");

	// #2086: the closed-event payload's body is a snapshot from when the PR
	// closed. A rerun of this check after the body was edited post-merge must
	// see the edit, not replay the stale snapshot. Reuses check-pr-body.mjs's
	// fetchLivePrBody (PR #2085/#2086's own root-cause sibling) rather than
	// hand-rolling a second live-body fetch -- same env vars, same request
	// shape.
	//
	// #2267 F2: uses the STRICT fetchLivePrBody here, not resolveLivePrBody's
	// warn-and-fall-back-to-stale-payload wrapper. That wrapper is right for
	// the advisory body LINTER (check-pr-body.mjs), where degrading to the
	// stale body on a fetch hiccup is an acceptable trade. It is wrong for
	// this post-merge verification GATE: a gate that silently falls back and
	// reports "OK" on a fetch failure is indistinguishable from a gate that
	// actually checked and found nothing wrong -- the exact "fails open"
	// shape #2086 was filed to close, just moved one level up. A fetch
	// failure here fails the check LOUD instead.
	let liveBody;
	let liveTitle;
	try {
		({ body: liveBody, title: liveTitle } = await fetchLivePrBody(
			pullRequest,
			fetchImpl,
		));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(
			`::error::Post-merge close verification could not fetch the live PR body, so it did not run: ${reason}`,
		);
		process.exitCode = 1;
		return;
	}
	const titleIssues = lintCloseKeywordPlacement(liveTitle, "").titleIssues;
	const unresolvedTitle = titleIssues
		.map((number) => ({ number, state: getIssueState(repository, number) }))
		.filter(({ state }) => state !== "closed");
	if (unresolvedTitle.length > 0) {
		const details = unresolvedTitle
			.map(({ number, state }) => `#${number} (${state})`)
			.join(", ");
		console.error(
			`Post-merge close verification found title issue(s) that were not closed: ${details}.`,
		);
		process.exitCode = 1;
		return;
	}
	const { issues: allIssues, negatedIssues } = parseCloseKeywords(liveBody);
	// #4371: an issue named only in a table row or after a hedge ("not fixed:
	// #N") is closed by GitHub against the author's intent. It is the failure
	// only when THIS PR closed it (or the closer is unknown); an issue closed
	// earlier by someone else, or still open, is correct and is not expected
	// closed. The clean-issue check below still runs.
	const closedByAccident = negatedIssues.filter(
		(number) =>
			getIssueState(repository, number) === "closed" &&
			[pullRequest.number, undefined].includes(
				getIssueCloser(repository, number),
			),
	);
	if (closedByAccident.length > 0) {
		const details = closedByAccident.map((number) => `#${number}`).join(", ");
		console.error(
			`Post-merge close verification found issue(s) closed only through a table row or hedged close keyword: ${details}. Reopen them if the work is not done. ${NEGATED_CLOSE_KEYWORD_MESSAGE}`,
		);
		process.exitCode = 1;
	}
	const issues = allIssues.filter((number) => !negatedIssues.includes(number));
	const unresolved = issues
		.map((number) => ({ number, state: getIssueState(repository, number) }))
		.filter(({ state }) => state !== "closed");
	if (unresolved.length === 0) {
		if (closedByAccident.length === 0)
			console.log(
				`Post-merge close verification OK (${issues.length} issue${issues.length === 1 ? "" : "s"} closed).`,
			);
		return;
	}

	const details = unresolved
		.map(({ number, state }) => `#${number} (${state})`)
		.join(", ");
	const marker = "<!-- close-keyword-verifier -->";
	const message = `${marker}
Post-merge close verification found issue(s) that were not closed: ${details}. GitHub only applies the first issue in a comma-separated close list; use one close keyword per issue (for example, "Closes #123. Closes #456.").`;
	console.error(message);
	// Idempotence (#1355 review): a rerun must not stack duplicate comments.
	let alreadyCommented = false;
	try {
		const existing = execFileSync(
			"gh",
			[
				"pr",
				"view",
				String(pullRequest.number),
				"--repo",
				repository,
				"--json",
				"comments",
				"--jq",
				".comments[].body",
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		alreadyCommented = existing.includes(marker);
	} catch {
		// listing failed -- fall through and comment rather than stay silent
	}
	if (!alreadyCommented) {
		execFileSync(
			"gh",
			[
				"pr",
				"comment",
				String(pullRequest.number),
				"--repo",
				repository,
				"--body",
				message,
			],
			{
				stdio: "inherit",
			},
		);
	}
	process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	(async () => {
		if (process.argv[2] === "--lint-local") {
			const title = readFileSync(process.argv[3], "utf8").split(/\r?\n/, 1)[0];
			const body = readFileSync(process.argv[4], "utf8");
			const result = lintCloseKeywords(body);
			const placement = lintCloseKeywordPlacement(title, body);
			for (const line of closeKeywordErrors(result)) console.error(line);
			if (!placement.valid)
				console.error(
					closeKeywordPlacementMessage(placement.missingBodyIssues),
				);
			if (!result.valid || !placement.valid) process.exitCode = 1;
			else
				console.log(
					`Close-keyword syntax OK (${result.issues.length} issues referenced).`,
				);
		} else if (process.argv[2] === "--lint-pr") await lintPullRequest();
		else if (process.argv[2] === "--verify-merged")
			await verifyMergedPullRequest();
		else
			throw new Error(
				"Usage: node scripts/check-close-keywords.mjs --lint-pr|--verify-merged",
			);
	})().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
