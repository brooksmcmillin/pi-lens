/** Detection logic for the scheduled stale-open-issue check (#1323). */

export const MAX_PAGES = 3;
export const PAGE_SIZE = 100;
export const MAX_COMMIT_DETAILS = 100;
export const DETECTOR_ISSUE = 1323;

const CLOSING_REFERENCE = /\b(?:closes|fixes|resolves)\s+#(\d+)\b/gi;
const ISSUE_NUMBER = /(?:^|[^\d])#?(\d+)(?!\d)/g;

function numbersFromClosingText(text) {
	const numbers = new Set();
	let scanned = String(text ?? "");
	// #1356 review: quoted keyword text and reverts are not closing intent.
	// A revert un-does the closing commit, and prose quoting the form (docs,
	// changelog snippets) merely mentions it.
	if (/^\s*Revert\b/i.test(scanned)) return numbers;
	scanned = scanned.replace(/"[^"\n]*"/g, "").replace(/`[^`\n]*`/g, "");
	for (const match of scanned.matchAll(CLOSING_REFERENCE))
		numbers.add(Number(match[1]));
	return numbers;
}

function numbersFromTestFilename(filename) {
	const normalized = String(filename).replaceAll("\\", "/");
	if (
		!/(^|\/)(?:test|tests|__tests__)(\/|$)|\.(?:test|spec)\./i.test(normalized)
	)
		return new Set();
	const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
	const numbers = new Set();
	for (const match of basename.matchAll(ISSUE_NUMBER))
		numbers.add(Number(match[1]));
	return numbers;
}

function addEvidence(byIssue, issueNumber, evidence) {
	const current = byIssue.get(issueNumber) ?? [];
	if (!current.includes(evidence)) current.push(evidence);
	byIssue.set(issueNumber, current);
}

async function getJson(fetcher, url) {
	const response = await fetcher(url, {
		headers: { accept: "application/vnd.github+json" },
	});
	if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
	return response.json();
}

async function paged(fetcher, baseUrl, params = {}) {
	const values = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const query = new URLSearchParams({
			...params,
			per_page: String(PAGE_SIZE),
			page: String(page),
		});
		const batch = await getJson(fetcher, `${baseUrl}?${query}`);
		if (!Array.isArray(batch))
			throw new Error(`GitHub API returned a non-array for ${baseUrl}`);
		values.push(...batch);
		if (batch.length < PAGE_SIZE) break;
	}
	return values;
}

export async function detectStaleOpenIssues({
	fetcher,
	repository,
	branch = "master",
}) {
	const openIssues = await paged(
		fetcher,
		`https://api.github.com/repos/${repository}/issues`,
		{ state: "open" },
	);
	const issueNumbers = new Set(
		openIssues
			.filter((issue) => !issue.pull_request)
			.map((issue) => issue.number),
	);
	const byIssue = new Map();
	const commits = await paged(
		fetcher,
		`https://api.github.com/repos/${repository}/commits`,
		{ sha: branch },
	);
	for (const commit of commits.slice(0, MAX_COMMIT_DETAILS)) {
		const commitText = commit.commit?.message ?? commit.message ?? "";
		for (const number of numbersFromClosingText(commitText)) {
			if (issueNumbers.has(number))
				addEvidence(
					byIssue,
					number,
					`closing-shaped commit ${commit.sha.slice(0, 7)}`,
				);
		}
		const detail = await getJson(
			fetcher,
			`https://api.github.com/repos/${repository}/commits/${commit.sha}`,
		);
		for (const file of Array.isArray(detail.files) ? detail.files : []) {
			for (const number of numbersFromTestFilename(file.filename)) {
				if (issueNumbers.has(number))
					addEvidence(byIssue, number, `regression-test file ${file.filename}`);
			}
		}
	}
	const candidates = openIssues
		.filter((issue) => byIssue.has(issue.number))
		.map((issue) => ({ issue, evidence: byIssue.get(issue.number) }))
		.sort((a, b) => a.issue.number - b.issue.number);
	// No silent caps (#1356 review): say how many commits went unexamined.
	return {
		candidates,
		truncatedCommits: Math.max(0, commits.length - MAX_COMMIT_DETAILS),
	};
}

export function formatSummary(
	candidates,
	{ runUrl, truncatedCommits = 0 } = {},
) {
	const lines = [
		"<!-- pi-lens-stale-open-issue-detector -->",
		"## Stale open-issue candidates",
		"",
		"Detection only: a human must verify the evidence and close or update an issue. This job never closes issues.",
		"",
	];
	if (candidates.length === 0) lines.push("No candidates found.");
	else
		for (const { issue, evidence } of candidates)
			lines.push(
				`- [#${issue.number}](${issue.html_url}) **${issue.title}** — ${evidence.join("; ")}`,
			);
	if (truncatedCommits > 0)
		lines.push(
			"",
			`Note: ${truncatedCommits} commit(s) beyond the ${MAX_COMMIT_DETAILS}-detail cap were NOT examined this run.`,
		);
	if (runUrl) lines.push("", `Workflow run: ${runUrl}`);
	return lines.join("\n");
}

export function defaultFetcher(token) {
	return (url, init) =>
		fetch(url, {
			...init,
			headers: { ...init?.headers, authorization: `Bearer ${token}` },
		});
}
