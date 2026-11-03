import * as path from "node:path";

/**
 * The home pin an operator script or gate gives every child it spawns (#4789,
 * AGENTS.md shape 82: one home variable pinned, the rest left at the real
 * home). `home` becomes HOME and USERPROFILE (`os.homedir()`'s source on
 * Windows), the three XDG base directories sit under it, and `lensHome` is
 * PI_LENS_HOME (default: `home`). Pure: no I/O and no `process.env` reads, so
 * the caller decides whether the pin lands in a child env object or in
 * `process.env` itself.
 */
export function scratchHomeEnv(home, lensHome = home) {
	return {
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		XDG_CACHE_HOME: path.join(home, ".cache"),
		XDG_DATA_HOME: path.join(home, ".local", "share"),
		PI_LENS_HOME: lensHome,
	};
}
