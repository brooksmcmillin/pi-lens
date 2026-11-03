import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Whether selfUrl (import.meta.url) is the process entry point. Resolve both
// paths: Node normally resolves the module URL but leaves argv[1] symlinked;
// --preserve-symlinks-main keeps the URL symlinked too (#4086, #4096).
// native realpath also canonicalises Windows casing and short-name spellings.
// An absent argv path means an import (node -e, stdin, or a removed launcher).
// An unresolvable module URL throws so a broken CLI cannot silently succeed.
export function isMainModule(
	selfUrl,
	{ argv1 = process.argv[1], realpath = realpathSync.native } = {},
) {
	let invoked;
	try {
		invoked = realpath(argv1);
	} catch {
		return false;
	}
	try {
		return invoked === realpath(fileURLToPath(selfUrl));
	} catch (error) {
		throw new Error(
			`[is-main-module] cannot resolve the entry-point path of ${selfUrl}: ${error instanceof Error ? error.message : error}`,
		);
	}
}
