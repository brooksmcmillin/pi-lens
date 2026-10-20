import { afterEach, describe, expect, it, vi } from "vitest";
import {
	githubFetcher,
	githubGet,
	githubHeaders,
} from "../../scripts/lib/github-rest.mjs";

afterEach(() => {
	vi.unstubAllEnvs();
});

// #4371 (#4422 review F3): five request sites each copied this env triple,
// timeout and header set. The sites keep their own failure policy; these pin
// the one shared request.
describe("githubGet", () => {
	const env = () => {
		vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
		vi.stubEnv("GITHUB_REPOSITORY", "apmantza/pi-lens");
		vi.stubEnv("GITHUB_TOKEN", "test-token");
	};

	it("sends the repository-relative path with the token, accept and version headers", async () => {
		env();
		const fetchImpl = vi.fn().mockResolvedValue(new Response("[]"));

		const response = await githubGet("/pulls/7/files?per_page=100", fetchImpl);

		expect(await response.text()).toBe("[]");
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.github.test/repos/apmantza/pi-lens/pulls/7/files?per_page=100",
			{
				signal: expect.any(AbortSignal),
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: "Bearer test-token",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);
	});

	it.each([
		["GITHUB_TOKEN", "GITHUB_TOKEN is not set"],
		["GITHUB_API_URL", "GITHUB_API_URL or GITHUB_REPOSITORY is missing"],
		["GITHUB_REPOSITORY", "GITHUB_API_URL or GITHUB_REPOSITORY is missing"],
	])(
		"rejects without calling fetch when %s is unset",
		async (name, message) => {
			env();
			vi.stubEnv(name, "");
			const fetchImpl = vi.fn();

			await expect(githubGet("/pulls/7", fetchImpl)).rejects.toThrow(message);
			expect(fetchImpl).not.toHaveBeenCalled();
		},
	);
});

// Recurrence #4422 F3 (#4427): the header block and the token-adding fetch
// wrapper were copied into check-action-pins, detect-stale-open-issues,
// lib/stale-open-issues and classify-ci-failure.
describe("githubHeaders", () => {
	it("builds the accept, version and bearer set", () => {
		expect(githubHeaders("tok")).toEqual({
			Accept: "application/vnd.github+json",
			Authorization: "Bearer tok",
			"X-GitHub-Api-Version": "2022-11-28",
		});
	});

	it("omits Authorization for an anonymous caller", () => {
		expect(githubHeaders(undefined)).toEqual({
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		});
	});
});

describe("githubFetcher", () => {
	it("adds the token and keeps the caller's own headers", async () => {
		const fetchSpy = vi.fn().mockResolvedValue(new Response("{}"));
		vi.stubGlobal("fetch", fetchSpy);
		try {
			await githubFetcher("tok")("https://api.github.test/x", {
				headers: { accept: "application/vnd.github+json" },
				method: "GET",
			});
			expect(fetchSpy).toHaveBeenCalledWith("https://api.github.test/x", {
				headers: {
					accept: "application/vnd.github+json",
					authorization: "Bearer tok",
				},
				method: "GET",
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("reads the global fetch per call, not at construction", async () => {
		const fetcher = githubFetcher("tok");
		const fetchSpy = vi.fn().mockResolvedValue(new Response("{}"));
		vi.stubGlobal("fetch", fetchSpy);
		try {
			await fetcher("https://api.github.test/y");
			expect(fetchSpy).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
