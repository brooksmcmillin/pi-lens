#!/usr/bin/env node
// Bump-time changelog rollup entry point. It validates and consumes every
// `.changelog/*.md` entry, merges those entries with any legacy content still
// under `## [Unreleased]`, writes the dated package-version section, and opens
// a fresh empty `## [Unreleased]`. The tag-time release workflow only reads
// and verifies the already-rolled CHANGELOG; it never mutates it.
//
//   node scripts/changelog-release.mjs            # package version, today
//   node scripts/changelog-release.mjs 3.8.61     # explicit version
//   node scripts/changelog-release.mjs 3.8.61 --date 2026-06-25

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rollupChangelog } from "./rollup-changelog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = join(__dirname, "..", "package.json");

function parseArgs(argv) {
	const args = { version: undefined, date: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--date") args.date = argv[++i];
		else if (!args.version) args.version = arg;
	}
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const version =
		args.version ?? JSON.parse(readFileSync(PKG_PATH, "utf8")).version;
	const date = args.date ?? new Date().toISOString().slice(0, 10);

	try {
		const result = rollupChangelog(version, {
			rootDir: join(__dirname, ".."),
			date,
		});
		console.log(
			`Rolled [Unreleased] and ${result.files.length} per-entry changelog file${result.files.length === 1 ? "" : "s"} into [${version}] - ${date}.`,
		);
	} catch (error) {
		console.error(String(error.message || error));
		process.exit(1);
	}
}

main();
