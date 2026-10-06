const CLOSE_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi;
const CLOSE_ISSUE = /\s*:?[ \t]*#(\d+)/y;
const COMMA_ISSUE = /\s*,\s*#(\d+)/y;

export const INVALID_CLOSE_KEYWORD_MESSAGE =
	'Invalid close-keyword syntax: GitHub only applies the first issue in a comma-separated close list. Use one close keyword per issue, for example "Closes #123. Closes #456." (not "Closes #123, #456").';

export function stripNonSemanticMarkdown(body = "") {
	return body
		.replace(/```[\s\S]*?```/g, "")
		.replace(/`[^`\n]*`/g, "")
		.split("\n")
		.filter((line) => !/^\s*>/.test(line))
		.join("\n");
}

function scanCloseIssues(scanned = "") {
	const issues = [];
	const commaLists = [];
	const offendingLines = [];
	for (const match of scanned.matchAll(CLOSE_KEYWORD)) {
		const rest = scanned.slice(match.index + match[0].length);
		CLOSE_ISSUE.lastIndex = 0;
		const issue = CLOSE_ISSUE.exec(rest);
		if (!issue) continue;
		const number = Number(issue[1]);
		if (!issues.includes(number)) issues.push(number);
		COMMA_ISSUE.lastIndex = 0;
		if (COMMA_ISSUE.exec(rest.slice(issue[0].length))) {
			commaLists.push(number);
			const lineStart = scanned.lastIndexOf("\n", match.index) + 1;
			const lineEnd = scanned.indexOf("\n", match.index);
			offendingLines.push(
				scanned.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim(),
			);
		}
	}
	return { issues, commaLists, offendingLines };
}

export function parseCloseKeywords(body = "") {
	return scanCloseIssues(stripNonSemanticMarkdown(body));
}

export function lintCloseKeywords(body = "") {
	const parsed = parseCloseKeywords(body);
	return { ...parsed, valid: parsed.commaLists.length === 0 };
}

export function lintCloseKeywordPlacement(title = "", body = "") {
	const scannedTitle = String(title);
	const titleIssues = [...scanCloseIssues(scannedTitle).issues];
	for (const match of scannedTitle.matchAll(CLOSE_KEYWORD)) {
		const rest = scannedTitle.slice(match.index + match[0].length);
		CLOSE_ISSUE.lastIndex = 0;
		const issue = CLOSE_ISSUE.exec(rest);
		if (!issue) continue;
		const commaTail = rest.slice(issue[0].length).match(/^(?:\s*,\s*#\d+)+/);
		for (const number of commaTail?.[0].matchAll(/#(\d+)/g) ?? []) {
			const value = Number(number[1]);
			if (!titleIssues.includes(value)) titleIssues.push(value);
		}
	}
	const bodyIssues = parseCloseKeywords(body).issues;
	const missingBodyIssues = titleIssues.filter(
		(number) => !bodyIssues.includes(number),
	);
	return {
		valid: missingBodyIssues.length === 0,
		titleIssues,
		missingBodyIssues,
	};
}

export function closeKeywordPlacementMessage(missing) {
	const repairs = missing.map((number) => `Closes #${number}.`).join(" ");
	const alternatives = missing.map((number) => `refs #${number}`).join(", ");
	return `Invalid close-keyword placement: GitHub only honours closing keywords in the PR body, never in the title. Add the matching body keyword(s): ${repairs} Alternatively, use ${alternatives} in the title.`;
}
