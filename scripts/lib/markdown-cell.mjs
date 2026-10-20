// One Markdown table-cell escaper for every generated or issue-body table (#4490).
// Escape the backslash FIRST, then the pipe: a literal `\` in the input must not
// combine with the pipe escape (`a\|b` would otherwise render as `a\\|b`, and
// GFM reads the second backslash as the escape, so the pipe splits the cell).
// Dependency-free. Callers keep their own whitespace, newline and truncation
// handling; this only escapes.

/**
 * @param {unknown} text
 * @returns {string}
 */
export function escapeMarkdownCell(text) {
	return String(text).replaceAll("\\", "\\\\").replaceAll("|", "\\|");
}
