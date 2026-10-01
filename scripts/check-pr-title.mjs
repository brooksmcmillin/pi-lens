import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Keep merge-commit subjects conventional; issue references are optional.
const CONVENTIONAL_PREFIX =
	/^(feat|fix|chore|docs|refactor|test|ci|perf)(\([^)]+\))?: .+/;

export const MISSING_PREFIX_MESSAGE =
	'PR title must start with a conventional prefix and a colon, for example "fix: repair the widget cache". ' +
	"Allowed prefixes: feat, fix, chore, docs, refactor, test, ci, perf.";

export function lintPrTitle(title = "") {
	const errors = [];
	if (!CONVENTIONAL_PREFIX.test(title.trim())) {
		errors.push(MISSING_PREFIX_MESSAGE);
	}
	return { valid: errors.length === 0, errors };
}

export async function resolveLivePrTitle(
	payloadPr,
	fetchImpl = globalThis.fetch,
) {
	const fallbackTitle = payloadPr.title ?? "";
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		console.warn(
			"::warning::PR title live fetch failed: GITHUB_TOKEN is missing; using event payload title",
		);
		return fallbackTitle;
	}
	try {
		const apiUrl = process.env.GITHUB_API_URL;
		const repository = process.env.GITHUB_REPOSITORY;
		if (!apiUrl || !repository) {
			throw new Error("GITHUB_API_URL or GITHUB_REPOSITORY is missing");
		}
		const response = await fetchImpl(
			`${apiUrl}/repos/${repository}/pulls/${payloadPr.number}`,
			{
				signal: AbortSignal.timeout(10_000),
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
				},
			},
		);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const livePr = await response.json();
		if (typeof livePr?.title !== "string") {
			throw new Error("response has no title");
		}
		return livePr.title;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(
			`::warning::PR title live fetch failed: ${reason}; using event payload title`,
		);
		return fallbackTitle;
	}
}

function eventPayload() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
	return JSON.parse(readFileSync(eventPath, "utf8"));
}

async function lintPullRequestEvent() {
	const pullRequest = eventPayload().pull_request;
	if (!pullRequest) throw new Error("Event payload has no pull_request");
	const title = await resolveLivePrTitle(pullRequest);
	const result = lintPrTitle(title);
	if (!result.valid) {
		for (const error of result.errors) console.error(error);
		process.exitCode = 1;
		return;
	}
	console.log(`PR title OK: "${title}"`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const localTitle =
		process.argv[2] === "--lint-local" && process.argv[3]
			? readFileSync(process.argv[3], "utf8").split(/\r?\n/, 1)[0]
			: null;
	if (localTitle !== null) {
		const result = lintPrTitle(localTitle);
		for (const error of result.errors) console.error(error);
		process.exitCode = result.valid ? 0 : 1;
	} else
		lintPullRequestEvent().catch((error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		});
}
