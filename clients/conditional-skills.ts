const AVAILABLE_SKILLS_OPEN = "<available_skills>";
const AVAILABLE_SKILLS_CLOSE = "</available_skills>";

const SKILL_TOOL_FAMILIES = new Map<string, ReadonlySet<string>>([
	[
		"pi-lens-ast-grep",
		new Set(["ast_grep_search", "ast_grep_replace", "ast_grep_outline", "ast_grep_dump"]),
	],
	["pi-lens-lsp-navigation", new Set(["lsp_navigation"])],
]);

function selectedToolNames(options: unknown): ReadonlySet<string> | undefined {
	if (!options || typeof options !== "object") return undefined;
	const selected = (options as { selectedTools?: unknown }).selectedTools;
	if (!Array.isArray(selected)) return undefined;
	return new Set(selected.filter((name): name is string => typeof name === "string"));
}

/**
 * Keep pi-lens's authoring skills discoverable, but omit navigation guide
 * entries until the corresponding lazy tool family is active. Explicit
 * `/skill:name` expansions live outside `<available_skills>` and are untouched.
 */
export function filterInactivePiLensSkills(systemPrompt: string, systemPromptOptions: unknown): string {
	const selectedTools = selectedToolNames(systemPromptOptions);
	// Older hosts do not expose selectedTools. Preserve their static-skill behavior.
	if (!selectedTools) return systemPrompt;

	const start = systemPrompt.indexOf(AVAILABLE_SKILLS_OPEN);
	if (start < 0) return systemPrompt;
	const contentStart = start + AVAILABLE_SKILLS_OPEN.length;
	const end = systemPrompt.indexOf(AVAILABLE_SKILLS_CLOSE, contentStart);
	if (end < 0) return systemPrompt;

	const catalog = systemPrompt.slice(contentStart, end);
	const filtered = catalog.replace(/\s*<skill>\s*[\s\S]*?<\/skill>/g, (block) => {
		const name = block.match(/<name>\s*([^<]+?)\s*<\/name>/)?.[1];
		if (!name) return block;
		const tools = SKILL_TOOL_FAMILIES.get(name);
		if (!tools) return block;
		return [...tools].some((tool) => selectedTools.has(tool)) ? block : "";
	});

	if (filtered === catalog) return systemPrompt;
	return `${systemPrompt.slice(0, contentStart)}${filtered}${systemPrompt.slice(end)}`;
}
