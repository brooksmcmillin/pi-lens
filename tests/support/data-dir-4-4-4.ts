/**
 * Where pi-lens 4.4.4 put a project's data dir (#4689).
 *
 * 4.4.4 named it from the caller's spelling of the root: both slug halves came
 * from `path.resolve(root)` (the readable half folded `/` to `-` and dropped
 * everything else, the hash half was the first 8 hex of its SHA-256). Since
 * #4689 round 4 the name comes from the root's path identity, so a test that
 * stages what 4.4.4 wrote for a root spelled through a link needs the old
 * formula. POSIX only: on win32 the name never moved.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

export function dataDir444(base: string, root: string): string {
	const spelled = path.resolve(root);
	const readable = spelled
		.replace(/\/+/g, "-")
		.replace(/[^A-Za-z0-9-]/g, "")
		.replace(/^-+/, "")
		.replace(/-+$/, "");
	const hash = createHash("sha256").update(spelled).digest("hex").slice(0, 8);
	return path.join(base, `${readable || "default"}-${hash}`);
}

/**
 * The directory pi-lens 4.1.6 and earlier named for `root` under `base`: the
 * same readable half with no hash (#4689 r6 G1; hashes arrived in v4.2.0).
 * POSIX only, like {@link dataDir444}.
 */
export function dataDir416(base: string, root: string): string {
	return dataDir444(base, root).replace(/-[0-9a-f]{8}$/, "");
}
