/** HOME, USERPROFILE, the XDG base directories and PI_LENS_HOME, all under `home`. */
export function scratchHomeEnv(
	home: string,
	lensHome?: string,
): Record<
	| "HOME"
	| "USERPROFILE"
	| "XDG_CONFIG_HOME"
	| "XDG_CACHE_HOME"
	| "XDG_DATA_HOME"
	| "PI_LENS_HOME",
	string
>;
