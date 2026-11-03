import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";

// flake-shape: real-process-spawn — pinned npm must regenerate the real optional binding

const { runLockfileCompleteness } =
	await import("../../scripts/lib/lockfile-completeness.mjs");
const tempDirs: string[] = [];
// #4936: CI fetches cold (12 s to 87 s for the same case on one run), so the
// budget is a ceiling widened by the lane's scale; the case budget sits above it.
const NPM_BUDGET_MS = scaledTestTimeout(60_000);
const CASE_BUDGET_MS = NPM_BUDGET_MS + scaledTestTimeout(30_000);

function fixture() {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-lock-complete-test-"),
	);
	tempDirs.push(root);
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({ name: "fixture", packageManager: "npm@11.18.0" }),
	);
	fs.writeFileSync(
		path.join(root, "package-lock.json"),
		JSON.stringify({ packages: { "": {}, "node_modules/kept": {} } }),
	);
	return root;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

describe("lockfile completeness guard", () => {
	it("names the first optional node_modules key npm would restore", () => {
		// Regression: a different npm major omitted optional platform bindings,
		// and the clean-clone production guard caught the drift only after merge.
		const root = fixture();
		const fakeSpawn = (
			_file: string,
			_args: string[],
			options: { cwd: string },
		) => {
			const lockfile = path.join(options.cwd, "package-lock.json");
			const lock = JSON.parse(fs.readFileSync(lockfile, "utf8"));
			lock.packages["node_modules/@rolldown/binding-openharmony-arm64"] = {};
			fs.writeFileSync(lockfile, JSON.stringify(lock));
			return { status: 0, stdout: "", stderr: "" };
		};
		const result = runLockfileCompleteness({
			cwd: root,
			spawn:
				fakeSpawn as unknown as typeof import("node:child_process").spawnSync,
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain(
			"added node_modules/@rolldown/binding-openharmony-arm64",
		);
	});

	it("reports npm acquisition outages as inconclusive", () => {
		const result = runLockfileCompleteness({
			cwd: fixture(),
			spawn: (() => ({
				status: 1,
				stdout: "",
				stderr:
					"npm ERR! FetchError: request to http://127.0.0.1:9/npm failed ECONNREFUSED",
			})) as unknown as typeof import("node:child_process").spawnSync,
		});
		expect(result).toMatchObject({
			ok: false,
			inconclusive: true,
			reason: "npm pin unavailable",
		});
	});

	it("names the timeout and its budget when the npm child is killed", () => {
		// Regression (#4995): ETIMEDOUT was read as an acquisition outage, so a
		// killed gate printed "npm pin unavailable" and its own reason never ran.
		const result = runLockfileCompleteness({
			cwd: fixture(),
			spawn: spawnSync,
			timeoutMs: 5,
		});
		expect(result).toMatchObject({
			ok: false,
			inconclusive: true,
			pin: "11.18.0",
			reason: "timed out after 5ms",
		});
	});

	it("names the timeout even when the killed run printed outage text", () => {
		const result = runLockfileCompleteness({
			cwd: fixture(),
			spawn: (() => ({
				error: Object.assign(new Error("spawnSync npx ETIMEDOUT"), {
					code: "ETIMEDOUT",
				}),
				status: null,
				stdout: "",
				stderr: "npm ERR! FetchError: request failed ECONNREFUSED",
			})) as unknown as typeof import("node:child_process").spawnSync,
			timeoutMs: 7,
		});
		expect(result).toMatchObject({
			ok: false,
			inconclusive: true,
			reason: "timed out after 7ms",
		});
	});

	it("fails, not inconclusive, on a spawn error that is not a timeout", () => {
		const result = runLockfileCompleteness({
			cwd: fixture(),
			spawn: (() => ({
				error: Object.assign(new Error("spawnSync npx ENOENT"), {
					code: "ENOENT",
				}),
				status: null,
				stdout: "",
				stderr: "",
			})) as unknown as typeof import("node:child_process").spawnSync,
		});
		expect(result).toMatchObject({
			ok: false,
			reason: "spawnSync npx ENOENT",
		});
		expect(result.inconclusive).toBeUndefined();
	});

	it("copies only manifests into the isolated tree", () => {
		// Regression: the old recursive copy placed arbitrary repository content
		// in the npm cwd, despite the gate requiring manifest-only isolation.
		const root = fixture();
		fs.writeFileSync(path.join(root, "unrelated.txt"), "must not copy");
		let entries: string[] = [];
		const result = runLockfileCompleteness({
			cwd: root,
			spawn: ((_file: string, _args: string[], options: { cwd: string }) => {
				entries = fs.readdirSync(options.cwd).sort();
				return { status: 0, stdout: "", stderr: "" };
			}) as unknown as typeof import("node:child_process").spawnSync,
		});
		expect(result.ok).toBe(true);
		expect(entries).toEqual(["package-lock.json", "package.json"]);
	});

	it(
		"reproduces npm's real optional-binding rewrite from the npm-9 lock shape",
		() => {
			// Regression: npm 9 wrote rolldown's optional declaration without the
			// corresponding packages/node_modules descriptor; npm 11 restored it.
			// #4936: the fixture is rolldown's closure from the repo lock, not the whole
			// lock, so npm fetches a few packages instead of ~450 (86.9 s on one CI
			// run). The spawn blocks the worker, so Vitest can only report its own
			// budget after the spawn returns: the gate's kill (NPM_BUDGET_MS) must fire
			// first and the case budget sits above it.
			const binding = "node_modules/@rolldown/binding-openharmony-arm64";
			const repoPackage = JSON.parse(
				fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
			);
			const repoLock = JSON.parse(
				fs.readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8"),
			);
			const rolldown = repoLock.packages["node_modules/rolldown"];
			expect(
				Object.keys(rolldown?.optionalDependencies ?? {}),
				"repo lock no longer holds rolldown with its optional bindings; pick another package with an optional binding",
			).toContain("@rolldown/binding-openharmony-arm64");
			expect(repoLock.packages).toHaveProperty([binding]);
			const keep = new Set(["node_modules/rolldown"]);
			const queue = ["node_modules/rolldown"];
			for (let key = queue.pop(); key; key = queue.pop()) {
				const entry = repoLock.packages[key];
				for (const name of Object.keys({
					...entry.dependencies,
					...entry.optionalDependencies,
				})) {
					const child = `node_modules/${name}`;
					if (repoLock.packages[child] && !keep.has(child)) {
						keep.add(child);
						queue.push(child);
					}
				}
			}
			keep.delete(binding);
			const packages: Record<string, unknown> = {
				"": {
					name: "fixture",
					devDependencies: { rolldown: rolldown.version },
				},
			};
			for (const key of [...keep].sort())
				packages[key] = repoLock.packages[key];
			const root = fs.mkdtempSync(
				path.join(os.tmpdir(), "pi-lens-lock-real-test-"),
			);
			tempDirs.push(root);
			fs.writeFileSync(
				path.join(root, "package.json"),
				JSON.stringify({
					name: "fixture",
					packageManager: repoPackage.packageManager,
					devDependencies: { rolldown: rolldown.version },
				}),
			);
			fs.writeFileSync(
				path.join(root, "package-lock.json"),
				JSON.stringify({
					name: "fixture",
					lockfileVersion: 3,
					requires: true,
					packages,
				}),
			);
			const result = runLockfileCompleteness({
				cwd: root,
				spawn: spawnSync,
				timeoutMs: NPM_BUDGET_MS,
				env: {
					...process.env,
					PI_LENS_HOME: path.join(process.cwd(), ".probe-home"),
					npm_config_cache: path.join(process.cwd(), ".probe-home/npm-cache"),
				},
			});
			// A timeout or outage comes back inconclusive; matching `ok` and `reason`
			// together keeps it a visible red naming that reason.
			expect(result).toMatchObject({
				ok: false,
				reason: expect.stringContaining(`added ${binding}`),
			});
		},
		CASE_BUDGET_MS,
	);

	it("accepts an unchanged lockfile after npm completes", () => {
		const result = runLockfileCompleteness({
			cwd: fixture(),
			spawn: (() => ({
				status: 0,
				stdout: "",
				stderr: "",
			})) as unknown as typeof import("node:child_process").spawnSync,
		});
		expect(result).toMatchObject({ ok: true, pin: "11.18.0" });
	});
});
