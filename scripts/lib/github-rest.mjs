const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

/**
 * The one place a GitHub REST request header block is built (#4427): the
 * Accept and API-version pair, plus `Authorization: Bearer` when a token is
 * given. A caller with no token (the anonymous action-pin reads) gets no
 * Authorization header. `tests/config/github-bearer-ratchet.test.ts` reds on a
 * `Bearer` header built anywhere else in `scripts/`.
 *
 * @param {string | undefined} token
 * @returns {Record<string, string>}
 */
export function githubHeaders(token) {
	return {
		Accept: ACCEPT,
		...(token ? { Authorization: `Bearer ${token}` } : {}),
		"X-GitHub-Api-Version": API_VERSION,
	};
}

/**
 * A fetch that adds the token to each request and keeps the caller's own
 * headers (the callers send their own `accept`). Reads the global `fetch` per
 * call so a test that stubs it after construction is still seen.
 *
 * @param {string} token
 * @returns {(url: string, init?: RequestInit) => Promise<Response>}
 */
export function githubFetcher(token) {
	return (url, init) =>
		fetch(url, {
			...init,
			headers: { ...init?.headers, authorization: `Bearer ${token}` },
		});
}

/**
 * The one GitHub REST read the PR-metadata scripts share (#4371): the
 * GITHUB_TOKEN / GITHUB_API_URL / GITHUB_REPOSITORY env triple, a 10 s timeout
 * and the Bearer / Accept / API-version headers. It was copied into five
 * request sites. Rejects (never returns a partial request) when the env is
 * unset, so each caller keeps its own fail-closed or warn-and-skip policy.
 *
 * @param {string} path repository-relative, e.g. `/pulls/7/commits?page=1`
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<Response>}
 */
export async function githubGet(path, fetchImpl) {
	const token = process.env.GITHUB_TOKEN;
	if (!token) throw new Error("GITHUB_TOKEN is not set");
	const apiUrl = process.env.GITHUB_API_URL;
	const repository = process.env.GITHUB_REPOSITORY;
	if (!apiUrl || !repository)
		throw new Error("GITHUB_API_URL or GITHUB_REPOSITORY is missing");
	return fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
		signal: AbortSignal.timeout(10_000),
		headers: githubHeaders(token),
	});
}

/**
 * Parses `owner/repo` out of a `git remote get-url origin` value -- both the
 * SSH (`git@github.com:owner/repo.git`) and HTTPS
 * (`https://github.com/owner/repo.git`) forms this repo's own clones use.
 * `gh repo view` resolves the current repository the same way (from the
 * checkout's remote), so this is the REST transport's equivalent when `gh`
 * itself cannot be asked to do it.
 */
export function parseOwnerRepoFromGitRemote(remoteUrl) {
	const match = /github\.com[:/]{1,2}([^/\s]+)\/([^/\s.]+?)(?:\.git)?\/?$/.exec(
		String(remoteUrl ?? "").trim(),
	);
	return match ? `${match[1]}/${match[2]}` : null;
}
