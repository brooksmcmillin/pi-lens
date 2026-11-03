// flake-shape: real-process-spawn — the subject is what a fresh `node` resolves from a scripts tree with no node_modules (the CI jobs that run without an install); an in-process import shares vitest's resolved modules and cannot prove that boundary.
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// #4717: the PR-body lint reads markdown through `marked`, loaded lazily by
// `scripts/lib/markdown-lexer.mjs`. Two jobs import `scripts/check-pr-body.mjs`
// with NO install (`Close-keyword syntax`, which gates, and `Verify merged PR
// close keywords`): a top-level `import "marked"` anywhere in that graph would
// red both with ERR_MODULE_NOT_FOUND. The `PR body (advisory)` job installs
// marked alone. Each case runs the real entry point in a fresh `node` from a
// copy of `scripts/` that no node_modules sits above; the control case proves
// the copy cannot resolve marked, so the green cases are not vacuous.

const repositoryRoot = resolve(import.meta.dirname, "../..");
let root = "";

const run = (cwd: string, args: string[], env: Record<string, string> = {}) =>
	spawnSync(process.execPath, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", ...env },
	});

const lintBody = (scripts: string) => [
	"--input-type=module",
	"-e",
	`const m = await import(${JSON.stringify(join(scripts, "check-pr-body.mjs"))});` +
		'console.log("errors", m.lintPrBody("## Tests\\nx").errors.length);',
];

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "pi-lens-markdown-lexer-entry-"));
	for (const tree of ["bare", "marked-only"]) {
		cpSync(join(repositoryRoot, "scripts"), join(root, tree, "scripts"), {
			recursive: true,
		});
		mkdirSync(join(root, tree, ".github"));
		cpSync(
			join(repositoryRoot, ".github/PULL_REQUEST_TEMPLATE.md"),
			join(root, tree, ".github/PULL_REQUEST_TEMPLATE.md"),
		);
	}
	// What the PR-body job installs: the marked package and nothing else.
	mkdirSync(join(root, "marked-only", "node_modules"));
	symlinkSync(
		join(repositoryRoot, "node_modules", "marked"),
		join(root, "marked-only", "node_modules", "marked"),
		"junction",
	);
	writeFileSync(
		join(root, "fetch-stub.mjs"),
		[
			"globalThis.fetch = async (url) => {",
			"\tconst path = new URL(url).pathname;",
			"\tconst json = /\\/pulls\\/\\d+$/.test(path)",
			'\t\t? { body: "A body that references nothing.", title: "docs: a title" }',
			"\t\t: [];",
			"\treturn new Response(JSON.stringify(json), { status: 200 });",
			"};",
		].join("\n"),
	);
	writeFileSync(
		join(root, "event.json"),
		JSON.stringify({ pull_request: { number: 7, body: "x", merged: true } }),
	);
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("markdown-lexer entry points with no install (#4717)", () => {
	const github = () => ({
		GITHUB_EVENT_PATH: join(root, "event.json"),
		GITHUB_REPOSITORY: "o/r",
		GITHUB_TOKEN: "t",
		GITHUB_API_URL: "https://api.github.com",
	});

	it.each([
		["--lint-pr", "Close-keyword syntax OK"],
		["--verify-merged", "Post-merge close verification OK"],
	])("runs check-close-keywords %s with no marked", (mode, verdict) => {
		const result = run(
			join(root, "bare"),
			[
				"--import",
				join(root, "fetch-stub.mjs"),
				"scripts/check-close-keywords.mjs",
				mode,
			],
			github(),
		);
		expect(result.stderr).not.toContain("Cannot find module");
		expect(result.stdout).toContain(verdict);
		expect(result.status).toBe(0);
	});

	it("cannot read a PR body without marked (control)", () => {
		const result = run(root, lintBody(join(root, "bare", "scripts")));
		expect(result.stderr).toContain("Cannot find module 'marked'");
		expect(result.status).not.toBe(0);
	});

	it("reads a PR body with marked alone installed, as the PR-body job does", () => {
		const result = run(root, lintBody(join(root, "marked-only", "scripts")));
		expect(result.stderr).toBe("");
		expect(result.stdout).toMatch(/^errors \d+$/m);
		expect(result.status).toBe(0);
	});
});
