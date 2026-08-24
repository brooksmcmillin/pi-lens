#!/usr/bin/env node
/**
 * Fail if package-lock.json's root entry drifts from package.json's declared
 * dependency specs. This catches the exact class of bug that broke extension
 * updates: editing package.json (e.g. pinning web-tree-sitter to "0.25.10")
 * without regenerating the lock (which still recorded "^0.25.10"). A committed
 * lock that disagrees with package.json makes `npm ci` wipe node_modules and
 * hard-fail.
 *
 * Deterministic on purpose — it compares dependency SPEC STRINGS, not resolved
 * transitive versions, so it never flags spurious upstream republishes. Fix any
 * failure with `npm install` (which rewrites the lock) and commit the result.
 */
import * as fs from "node:fs";

function read(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (err) {
		console.error(`Cannot read ${file}: ${err.message}`);
		process.exit(1);
	}
}

const pkg = read("package.json");
const lock = read("package-lock.json");
const root = lock.packages?.[""] ?? {};

const SECTIONS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
];

const problems = [];
for (const section of SECTIONS) {
	const pkgDeps = pkg[section] ?? {};
	const lockDeps = root[section] ?? {};
	for (const [name, spec] of Object.entries(pkgDeps)) {
		if (lockDeps[name] !== spec) {
			problems.push(
				`${section}.${name}: package.json="${spec}" lock="${lockDeps[name] ?? "(missing)"}"`,
			);
		}
	}
	for (const name of Object.keys(lockDeps)) {
		if (!(name in pkgDeps)) {
			problems.push(`${section}.${name}: in lock but not package.json`);
		}
	}
}

if (problems.length > 0) {
	console.error("package-lock.json is out of sync with package.json:\n");
	for (const p of problems) console.error(`  • ${p}`);
	console.error(
		"\nRun `npm install` and commit the updated package-lock.json.",
	);
	process.exit(1);
}

console.log("package-lock.json is in sync with package.json ✓");
