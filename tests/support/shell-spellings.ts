/**
 * The spelling generator shared by the real-bash composition tests (#4713 R11,
 * #4739): every way to write one shell token with quoting that emits nothing
 * or wraps part of it. The header of `tests/clients/bash-word-composition.test.ts`
 * says why the rows are generated, not written by hand.
 */

/** Quoting that emits no character, inserted at one position of a token. */
const EMPTY_FORMS = ["''", '""', "$''", '$""', "\\\n"] as const;
/** Quoting forms wrapped around part of a token. */
const WRAPS = [
	["'", "'"],
	['"', '"'],
	["$'", "'"],
	['$"', '"'],
] as const;

/** Every composed spelling of one token, as the header describes. */
export function spellings(token: string): string[] {
	const n = token.length;
	const out = new Set<string>();
	for (let escape = -1; escape <= n; escape++) {
		const inserts: Array<readonly [number, string] | undefined> = [undefined];
		for (let at = 0; at <= n; at++)
			for (const form of EMPTY_FORMS) inserts.push([at, form]);
		for (const insert of inserts) {
			let spelled = "";
			for (let at = 0; at <= n; at++) {
				if (insert?.[0] === at) spelled += insert[1];
				if (at < n) spelled += (escape === at ? "\\" : "") + token[at];
				else if (escape === n) spelled += "\\";
			}
			out.add(spelled);
		}
	}
	const middle = Math.floor(n / 2);
	for (const [from, to] of [
		[0, n],
		[0, 1],
		[n - 1, n],
		[middle, middle + 1],
	] as const)
		for (const [open, close] of WRAPS)
			for (const inside of ["", "\\", "\\\n"])
				out.add(
					`${token.slice(0, from)}${open}${inside}${token.slice(from, to)}${close}${token.slice(to)}`,
				);
	return [...out];
}

/**
 * Subshell, group and `eval` forms around one command (#4739 r2, r3), nested
 * and mixed: bash runs the command inside each, and a gate that reads `(git`
 * as a word, or never reads an `eval` string, misses it. Each takes the command text and returns the wrapped command.
 */
export const COMMAND_WRAPPERS: ReadonlyArray<(command: string) => string> = [
	(command) => `(${command})`,
	(command) => `{ ${command}; }`,
	(command) => `(cd . && ${command})`,
	(command) => `( (${command}) )`,
	// A literal string handed to `eval` (#4739 r3): single-quoted, so bash
	// hands `eval` the command text as written.
	(command) => `eval '${command.replaceAll("'", "'\\''")}'`,
];
