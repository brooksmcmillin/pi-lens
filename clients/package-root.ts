import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { realpathOrResolve, walkUpDirs } from "./path-utils.js";

const packageRootCache = new Map<string, string>();

/**
 * Resolve the installed package root for the current module.
 * Walks upward from the caller until it finds the nearest package.json.
 *
 * This is the correct alternative to process.cwd() for resolving
 * pi-lens's own assets (rules, grammars, configs) when installed
 * globally — cwd is the user's project, not the extension root.
 *
 * Credit: alexx-ftw (PR #1)
 */
export function getPackageRoot(importMetaUrl: string): string {
	const cached = packageRootCache.get(importMetaUrl);
	if (cached) return cached;

	// #4689 item 6: the module's own directory as a path identity, so a package
	// reached through a link (`npm link`, a pnpm store) roots where its files
	// live. The directory comes from the FILE's identity: a file link's own
	// directory belongs to the link (#4966). No `package.json` on the way up
	// leaves the filesystem root.
	let root = "";
	for (const dir of walkUpDirs(
		path.dirname(realpathOrResolve(fileURLToPath(importMetaUrl))),
	)) {
		root = dir;
		if (fs.existsSync(path.join(dir, "package.json"))) break;
	}
	packageRootCache.set(importMetaUrl, root);
	return root;
}

/**
 * Resolve a path relative to the installed package root.
 */
export function resolvePackagePath(
	importMetaUrl: string,
	...segments: string[]
): string {
	return path.join(getPackageRoot(importMetaUrl), ...segments);
}
