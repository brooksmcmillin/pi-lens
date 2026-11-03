/**
 * The cooked value of a JavaScript string literal or identifier, for source
 * scanners that must judge what the program holds rather than what the source
 * spells (AGENTS.md shape 69). Moved out of
 * `tests/config/env-path-key-composition-sweep.test.ts` (#4600 R4-1) when the
 * path identity sweep (#4689) needed the same answer; both import it here.
 */

/** The simple one-character escapes a string literal can carry. */
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
	"0": "\0",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
	v: "\v",
	"\\": "\\",
	"'": "'",
	'"': '"',
	"`": "`",
};

/** A hex escape body as its character, or `undefined` when it is not one. */
function fromHex(hex: string, maxLength: number): string | undefined {
	if (hex.length === 0 || hex.length > maxLength) return undefined;
	if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined;
	const value = Number.parseInt(hex, 16);
	return value > 0x10ffff ? undefined : String.fromCodePoint(value);
}

/**
 * The COOKED value of a string literal: what the program holds at runtime, not
 * what the source spells. `"Pa\x74h"` is `Path` and `"\u0050ATH"` is `PATH`,
 * so reading the source text instead passes every value the detector cannot
 * see (AGENTS.md shape 69; #4600 R4-1).
 *
 * `undefined` means "not decodable with certainty": an unterminated token, a
 * legacy octal escape, `\8`, `\9`, or an escape this reader does not know. A
 * caller must fail CLOSED on it, never read it as a proven non-path value.
 */
export function cookedString(text: string): string | undefined {
	const quote = text[0];
	if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
	if (text.length < 2 || !text.endsWith(quote)) return undefined;
	const body = text.slice(1, -1);
	let cooked = "";
	for (let i = 0; i < body.length; i++) {
		const char = body[i] as string;
		if (char !== "\\") {
			cooked += char;
			continue;
		}
		const escape = body[i + 1];
		if (escape === undefined) return undefined;
		i += 1;
		// A line continuation contributes no character.
		if (escape === "\n") continue;
		if (escape === "\r") {
			if (body[i + 1] === "\n") i += 1;
			continue;
		}
		if (escape === "x" || escape === "u") {
			let hex: string;
			if (escape === "u" && body[i + 1] === "{") {
				const close = body.indexOf("}", i + 2);
				if (close < 0) return undefined;
				hex = body.slice(i + 2, close);
				i = close;
			} else {
				const width = escape === "x" ? 2 : 4;
				hex = body.slice(i + 1, i + 1 + width);
				if (hex.length !== width) return undefined;
				i += width;
			}
			const decoded = fromHex(hex, 6);
			if (decoded === undefined) return undefined;
			cooked += decoded;
			continue;
		}
		const simple = SIMPLE_ESCAPES[escape];
		// `\0` before a digit is a legacy octal escape, which is not decoded here.
		if (
			simple === undefined ||
			(escape === "0" && /\d/.test(body[i + 1] ?? ""))
		)
			return undefined;
		cooked += simple;
	}
	return cooked;
}

/**
 * An identifier's cooked NAME: `\u0050ATH` is `PATH`. A JavaScript identifier
 * carries non-ASCII characters only as `\u` escapes, so any other backslash
 * leaves the name as written, which matches no spelling.
 */
export function cookedIdentifier(text: string): string {
	if (!text.includes("\\")) return text;
	let cooked = "";
	for (let i = 0; i < text.length; i++) {
		const char = text[i] as string;
		if (char !== "\\" || text[i + 1] !== "u") {
			cooked += char;
			continue;
		}
		let hex: string;
		if (text[i + 2] === "{") {
			const close = text.indexOf("}", i + 3);
			if (close < 0) return text;
			hex = text.slice(i + 3, close);
			i = close;
		} else {
			hex = text.slice(i + 2, i + 6);
			if (hex.length !== 4) return text;
			i += 5;
		}
		const decoded = fromHex(hex, 6);
		if (decoded === undefined) return text;
		cooked += decoded;
	}
	return cooked;
}
