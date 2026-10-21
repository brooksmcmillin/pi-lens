/**
 * The population reader behind `tests/config/nightly-evaluated-floors.test.ts`
 * (#4518 r2). A `continue-on-error` step or job never reds its own row, so the
 * repository registers every such site in
 * `tests/fixtures/nightly-floors/continue-on-error-sites.json` and the census
 * derives the population from the parsed files.
 *
 * Two review findings shaped this module (#4609 r1):
 *
 * - F1: the population stopped at `.github/workflows/*.yml`. A `.yaml`
 *   workflow or a composite action's step was outside it and outside the
 *   raw-key guard, so a whole advisory producer could be added green. The file
 *   surface is now CLASSIFIED, not globbed: every file under
 *   `.github/workflows/` and `.github/actions/` is either a producer file the
 *   reader parses or a problem that reds the census.
 * - F2: the floor check matched text anywhere in a step's `run:`, so a
 *   commented-out command and an `if: false` step both satisfied it. A floor
 *   now counts only on a line the shell executes, of a step whose `if:` names
 *   a condition the runner evaluates.
 *
 * Review round 2 added three fail-closed rules (#4609 r2):
 *
 * - F-B: the `if:` check enumerated spellings of a constant false, so
 *   `${{ 1 > 2 }}` credited a step the runner skips (shape 69).
 * - F-2: the evidence matched inside a heredoc body, a quoted argument, or
 *   after an unconditional `exit`. Those regions are data the shell never
 *   executes (`evidenceIsExecutable`).
 * - The producer walk reports a non-regular entry (a symlink, a directory
 *   named `*.yml`) as unclassified instead of skipping it.
 *
 * Review round 3 showed that both round-2 rules were still deny lists with a
 * hole: `if:` admitted any expression that *mentioned* a context root or a
 * status function (so `!always()` and a root inside a quoted literal passed),
 * and the evidence rule admitted every unquoted match wherever it sat (so
 * `echo … --count "probe=` and a never-reached function body passed). Round 4
 * inverted both into ALLOWLISTS (shape 69, with 43 for text read as structure):
 *
 * - `unprovenCondition` credits only an absent `if:` or one of
 *   {@link ALWAYS_RUNNING_FORMS}. Nothing else, so an expression the reader
 *   cannot place refuses even when it is trivially true (`${{ 2 > 1 }}`).
 * - `evidenceIsExecutable` credits only a floor flag in the argument list of
 *   one of {@link FLOOR_INVOCATIONS}, on a top-level line, after no shell
 *   control operator. Every other shell form refuses; the appending of a new
 *   measuring program is a row in that table, never a new spelling to deny.
 *
 * Round 5 showed the allowlists were allowlists in SHAPE only: two admitted
 * forms still credited an input whose property they claimed to prove false
 * (r5 MEDIUM-1 and MEDIUM-2), and two site-level gates were never read at all
 * (LOW-1, LOW-2). The predicates now name the property each form proves:
 *
 * - `unprovenCondition` (the floor STEP) proves the step ALWAYS RUNS with its
 *   job: a status form, or `github.event_name`/`matrix.<name>` compared with a
 *   literal the parsed document lists (the workflow's `on:` keys, the job's
 *   `strategy.matrix` list). The round-4 `!cancelled() && <any context
 *   comparison>` door is gone: `github.event_name == 'never'` is now refused
 *   with or without the guard, and every root the document does not carry
 *   refuses.
 * - `unprovenJobCondition` (the enclosing JOB) proves the weaker property the
 *   document can carry: the job is not provably never true. A job `if:` skips
 *   the site and the floor together, so only a decided FALSE (or an atom the
 *   reader cannot place) disarms a floor; the undecided `needs`/`steps`/
 *   `inputs` value is the stated residual (shape 48).
 * - `evidenceIsExecutable` reads the LOGICAL line: a trailing `\` or an
 *   unfinished `&&`/`||`/`|` joins the next physical line (a shell
 *   continuation), so `echo \`, `[ … ] \` and `false &&` can no longer hand an
 *   argument list to a measuring invocation, while `<script> \` + newline +
 *   `<args>` is credited for the first time. An `exit` ends the script only in
 *   COMMAND position, so `echo exit` no longer refuses a floor the shell runs.
 *
 * The admitted forms for each predicate are tabulated in `STATE_TABLE.md` at
 * the repository root for #4609 round 5; the definitions below are the
 * normative copy.
 *
 * The site enumeration is the parsed document itself (a deep walk), not a
 * regex: a `continue-on-error` key inside a `run:` heredoc or a comment is
 * text, not a key, and a key in a location the reader does not classify reds
 * with its path instead of vanishing (shape 69: derive the rule from the seam).
 */

import { type Dirent as DirEnt, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "../../clients/deps/js-yaml.js";
import { toPosix } from "../../clients/path-utils.js";

/** The two repository roots that can carry a `continue-on-error` producer. */
export const PRODUCER_ROOTS = [".github/workflows", ".github/actions"] as const;

/** The two file suffixes YAML producers are written under. */
const YAML_SUFFIXES = [".yml", ".yaml"] as const;

export type ProducerKind = "workflow" | "composite";

export interface ProducerFile {
	/** Repo-relative POSIX path, the registry key's prefix. */
	path: string;
	kind: ProducerKind;
}

export interface CoeStep {
	name?: string;
	id?: string;
	uses?: string;
	if?: unknown;
	run?: string;
	shell?: string;
	"continue-on-error"?: unknown;
}

export interface CoeJob {
	steps?: CoeStep[];
	"continue-on-error"?: unknown;
	/** A job `if:` gates every floor step inside the job (#4609 r5 LOW-1). */
	if?: unknown;
	strategy?: { matrix?: unknown };
}

export interface ProducerDocument {
	jobs?: Record<string, CoeJob>;
	runs?: { using?: unknown; steps?: CoeStep[] };
	/** A workflow's `on:` block, in any of its three YAML shapes. */
	on?: unknown;
}

export type CoEStatus = "floored" | "no-floor" | "governed-by";

/** One row of `tests/fixtures/nightly-floors/continue-on-error-sites.json`. */
export interface CoERow {
	status: CoEStatus;
	/** The step in the site's own scope that carries the floor. */
	floorStep?: string;
	/** The exact text in that step's live `run:` proving the floor. */
	evidence?: string;
	/** The issue whose tests own the site (`governed-by` rows). */
	governedBy?: string;
	/** The tests that pin a `governed-by` site. */
	tests?: string[];
	/** The job carries a human-facing `# No floor` header above it. */
	header?: boolean;
	reason: string;
}

/** One `continue-on-error` site: a job, a workflow step, or a composite step. */
export interface CoESite {
	/** Registry key: `<repo path>#<job>[#<step>]`, or `<repo path>#<step>`. */
	key: string;
	file: string;
	kind: ProducerKind;
	/** The job id, or `"composite"` for a composite action's `runs.steps`. */
	scope: string;
	/** The step the key names; absent for a job-level site. */
	step?: CoeStep;
	/** Every step of the site's scope, where a floor step can live. */
	steps: CoeStep[];
	/** The site's index inside `steps`, or -1 when the site is the whole job. */
	index: number;
	/** The enclosing job's `if:`, read since #4609 r5 LOW-1. */
	jobIf?: unknown;
	/** The document facts a floor's `if:` is judged against (#4609 r5). */
	facts?: ConditionFacts;
}

export interface ProducerCensus {
	/** Every classified producer file, sorted by path. */
	files: ProducerFile[];
	/** Files under a producer root that the reader does not classify. */
	unclassified: string[];
	sites: CoESite[];
	/** Every fail-closed shape, ready to print. Empty means clean. */
	problems: string[];
}

/** `A` for an explicit value, never a silent default (GitHub's own rule). */
export const isCoe = (value: unknown): boolean =>
	value !== undefined && value !== false;

/** The step's display identity, the same one the registry key uses. */
export const stepIdentity = (step: CoeStep): string =>
	step.name ?? step.uses?.split("@")[0] ?? "(unnamed step)";

/**
 * Strip shell comments from a `run:` body, quote-aware: a `#` starts a comment
 * only at the start of a word and outside quotes (`"$#"` and `${v#p}` stay
 * code). A floor whose only occurrence sits in a comment is not a gate.
 */
export function stripShellComments(text: string): string {
	const { commentCut } = scanShell(text);
	return text
		.split("\n")
		.map((line, index) => line.slice(0, commentCut[index]))
		.join("\n");
}

/** A step's `run:` with comments removed: the text the runner will execute. */
export const liveRunText = (step: CoeStep): string =>
	stripShellComments(typeof step.run === "string" ? step.run : "");

/**
 * The `if:` atoms known to run whenever the job runs (#4609 r5 S3). An
 * allowlist, not a deny list: the round-3 rule admitted any expression that
 * *mentioned* a context root or a status function, so `${{ !always() }}`,
 * `${{ success() && failure() }}` and `${{ 'github.event_name' == 'never' }}`
 * all credited a step that never runs (shape 69, with 43 for the textual
 * match).
 */
const ALWAYS_RUNNING_FORMS: readonly RegExp[] = [
	/^always\(\)$/,
	/^success\(\)$/,
	/^!cancelled\(\)$/,
	/^true$/,
];

/**
 * The two context reads the census can settle from the parsed document: the
 * workflow's `on:` block is the set `github.event_name` takes, and one job's
 * `strategy.matrix` lists are the sets a `matrix.<name>` leg takes. Every
 * other root refused, because no part of the document carries its values
 * (#4609 r5 MEDIUM-1: a comparison the reader cannot decide is not proof).
 */
const DOCUMENT_COMPARISON =
	/^(github\.event_name|matrix\.[A-Za-z_][\w-]*)\s*(==|!=)\s*(?:'([^']*)'|"([^"]*)")$/;

/**
 * A comparison whose left side the document does not carry, but whose shape a
 * job `if:` may still be decided as PLACEABLE (#4609 r5 J4): the job or step it
 * reads exists, the value itself does not. Only the job rule admits these, and
 * only as UNKNOWN, never as proof that the job runs.
 */
const VALUE_COMPARISON =
	/^(?:needs\.[A-Za-z_][\w-]*\.outputs\.[A-Za-z_][\w-]*|steps\.[A-Za-z_][\w-]*\.outputs\.[A-Za-z_][\w-]*|inputs\.[A-Za-z_][\w-]*)\s*(?:==|!=)\s*(?:'[^']*'|"[^"]*")$/;

/** The document facts a condition is judged against (#4609 r5). */
export interface ConditionFacts {
	/** The workflow's `on:` event names; absent for a composite action. */
	triggers?: readonly string[];
	/** One job's `strategy.matrix` scalar lists, by key. */
	matrix?: Readonly<Record<string, readonly string[]>>;
}

/** Three-valued truth: the document decides an atom, or it does not. */
type Truth = "true" | "false" | "unknown";

/** An `if:` with GitHub's expression delimiters removed, or `null`. */
function conditionExpression(condition: unknown): string | null {
	if (typeof condition !== "string") return null;
	return condition
		.trim()
		.replace(/^\$\{\{/, "")
		.replace(/\}\}$/, "")
		.trim();
}

/** Split on a top-level operator, ignoring occurrences inside a quoted literal. */
function splitCondition(text: string, operator: "&&" | "||"): string[] {
	const parts: string[] = [];
	let quote: "'" | '"' | null = null;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] ?? "";
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (text.startsWith(operator, i)) {
			parts.push(text.slice(start, i));
			i += operator.length - 1;
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

/** The values the document says a comparison's left side takes. */
function documentValues(
	side: string,
	facts: ConditionFacts,
): readonly string[] | undefined {
	if (side === "github.event_name") return facts.triggers;
	const values = facts.matrix?.[side.slice("matrix.".length)];
	return values && values.length > 0 ? values : undefined;
}

/**
 * What one atom proves, or `undefined` when the reader cannot place it.
 * `admitUnknownValue` is the job rule's wider door (J4): a `needs`/`steps`/
 * `inputs` value is placeable but undecided, so it is UNKNOWN, never TRUE.
 */
function atomTruth(
	atom: string,
	facts: ConditionFacts,
	admitUnknownValue: boolean,
): Truth | undefined {
	if (atom === "false") return "false";
	if (ALWAYS_RUNNING_FORMS.some((form) => form.test(atom))) return "true";
	const comparison = DOCUMENT_COMPARISON.exec(atom);
	if (comparison) {
		const values = documentValues(comparison[1] ?? "", facts);
		if (!values) return undefined;
		const literal = comparison[3] ?? comparison[4] ?? "";
		// `==` needs the literal among the values; `!=` needs one that differs.
		const holds =
			comparison[2] === "=="
				? values.includes(literal)
				: values.some((value) => value !== literal);
		return holds ? "true" : "false";
	}
	if (admitUnknownValue && VALUE_COMPARISON.test(atom)) return "unknown";
	return undefined;
}

/** The values a disproved comparison was measured against, for its reason. */
function disprovedReason(
	condition: unknown,
	atom: string,
	facts: ConditionFacts,
): string | undefined {
	const comparison = DOCUMENT_COMPARISON.exec(atom);
	// A bare `false` literal has no value set to print; the caller states the
	// generic refusal for it instead of an empty list.
	if (!comparison) return undefined;
	const values = documentValues(comparison[1] ?? "", facts) ?? [];
	return `if: ${String(condition)} is false for every run of this workflow: ${comparison[1]} is ${values.join(", ")}`;
}

/**
 * Why a floor step's `if:` may never run, or `undefined` when every atom of it
 * is one of {@link ALWAYS_RUNNING_FORMS} or a comparison the parsed document
 * settles as true (#4609 r5 MEDIUM-1). Fail-closed as an allowlist: `||`, `!`,
 * parentheses, an unplaceable root, and a literal the document disproves all
 * refuse, so a literal that is trivially true (`${{ 2 > 1 }}`, LOW-3: stated
 * behaviour, because the predicate evaluates no arithmetic) refuses too.
 */
export function unprovenCondition(
	condition: unknown,
	facts: ConditionFacts = {},
): string | undefined {
	const unproven = (value: unknown) =>
		`if: ${String(value)} is not a condition known to run`;
	if (condition === undefined || condition === null || condition === "")
		return undefined;
	// YAML `if: true` parses as a boolean: the constant true, no expression.
	if (condition === true) return undefined;
	const expression = conditionExpression(condition);
	if (expression === null) return unproven(condition);
	// A disjunction is not a form this allowlist proves: one true disjunct is
	// enough to run, and the reader does not read `||` at all.
	if (splitCondition(expression, "||").length > 1) return unproven(condition);
	for (const atom of splitCondition(expression, "&&").map((part) =>
		part.trim(),
	)) {
		const truth = atomTruth(atom, facts, false);
		if (truth === "true") continue;
		if (truth === "false")
			return disprovedReason(condition, atom, facts) ?? unproven(condition);
		return unproven(condition);
	}
	return undefined;
}

/**
 * Why a floored site's job may never run, or `undefined` when it can (#4609 r5
 * LOW-1: the job's own `if:` gated every floor inside it and was never read).
 *
 * The property differs from the floor step's on purpose. A step made
 * conditional while its job keeps running is a false green: the site ran, the
 * floor did not. A job made conditional skips the site and the floor together,
 * so only a condition the document proves can never be true disarms a floor
 * permanently. This predicate therefore refuses a decided FALSE (every
 * disjunct false, some conjunction false) and an atom the reader cannot place,
 * and admits an UNDECIDED value (`needs`/`steps`/`inputs`), stated as the
 * residual in the module header and STATE_TABLE.md.
 */
export function unprovenJobCondition(
	condition: unknown,
	facts: ConditionFacts = {},
): string | undefined {
	if (condition === undefined || condition === null || condition === "")
		return undefined;
	if (condition === true) return undefined;
	const unplaceable = `carries an if: ${String(condition)} this reader cannot place`;
	const never = `carries an if: ${String(condition)} that is never true for this workflow`;
	// YAML `if: false` parses as a boolean: a constant that never runs.
	if (condition === false) return never;
	const expression = conditionExpression(condition);
	if (expression === null) return unplaceable;
	for (const disjunct of splitCondition(expression, "||")) {
		const truths: Truth[] = [];
		for (const atom of splitCondition(disjunct, "&&").map((part) =>
			part.trim(),
		)) {
			const truth = atomTruth(atom, facts, true);
			if (truth === undefined) return unplaceable;
			truths.push(truth);
		}
		if (truths.includes("false")) continue;
		if (truths.every((truth) => truth === "true")) return undefined;
		return undefined; // UNKNOWN: placeable, and the document does not decide it.
	}
	return never;
}

/** One line of a `run:` body, as the shell scanner read it. */
interface ShellLine {
	/** Offset of the line's first character in the `run:` text. */
	start: number;
	/** The line with its trailing comment removed. */
	code: string;
	/** Enclosing block depth when the line began: 0 is a top-level line. */
	depth: number;
	/** The previous physical line left this command unfinished (#4609 r5). */
	joinsPrevious: boolean;
	/** How this physical line hands its command to the next one. */
	continuation: "backslash" | "operator" | null;
}

interface ShellScan {
	/** 1 at every offset the shell never reaches as a command. */
	unreachable: Uint8Array;
	/** 1 at every offset inside a quoted string, delimiters excluded. */
	quoted: Uint8Array;
	/** Per line, the offset of its trailing comment, or the line's length. */
	commentCut: number[];
	/** Per line, its code text and the block depth it started at. */
	lines: ShellLine[];
}

const HEREDOC = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([^\s;|&<>()]+))/;

/**
 * A shell block the scanner tracks. Every one raises the depth of the lines
 * inside it until its closer, so evidence in a function body, an `if`/`case`
 * body or a subshell is never read as a top-level command (#4609 r3 MEDIUM-2).
 */
type ShellFrame = "if" | "case" | "loop" | "group" | "subshell";

/** Reserved words that open a block when they start a command. */
const BLOCK_OPENERS: Record<string, ShellFrame> = {
	if: "if",
	case: "case",
	for: "loop",
	while: "loop",
	until: "loop",
	select: "loop",
};

/** Reserved words that close one. */
const BLOCK_CLOSERS: Record<string, ShellFrame> = {
	fi: "if",
	esac: "case",
	done: "loop",
};

/** Reserved words that end a command, so the next word starts one. */
const COMMAND_SEPARATOR_WORDS = new Set(["then", "do", "else", "elif", "in"]);

/**
 * Words that keep the command position open for the next word, so `command
 * exit 0` and `exec \\\n exit 0` still end the script (#4609 r5 LOW-2).
 */
const COMMAND_PREFIX_WORDS = new Set([
	"command",
	"exec",
	"builtin",
	"nohup",
	"setsid",
	"time",
]);

/**
 * A trailing operator that leaves the command unfinished, so the next physical
 * line continues the same command (#4609 r5 MEDIUM-2). A lone `&` backgrounds
 * and a `;` ends a command list, so neither continues.
 */
const CONTINUATION_OPERATORS = new Set(["&&", "||", "|", "|&"]);

/** The unquoted characters the shell reads as operators. */
const SHELL_OPERATOR = /[;|&()]/;
const OPERATOR_RUN = /^[;|&()]+/;

interface ShellToken {
	text: string;
	kind: "word" | "op" | "group";
}

/** Split one line into shell words and operators, using the quote mask. */
function shellTokens(
	code: string,
	quoted: Uint8Array,
	offset: number,
): ShellToken[] {
	const tokens: ShellToken[] = [];
	let i = 0;
	while (i < code.length) {
		const ch = code[i] ?? "";
		if (/\s/.test(ch)) {
			i++;
			continue;
		}
		if (!quoted[offset + i] && SHELL_OPERATOR.test(ch)) {
			const run = OPERATOR_RUN.exec(code.slice(i))?.[0] ?? ch;
			tokens.push({ text: run, kind: "op" });
			i += run.length;
			continue;
		}
		let word = "";
		while (i < code.length) {
			const c = code[i] ?? "";
			if (!quoted[offset + i] && (/\s/.test(c) || SHELL_OPERATOR.test(c)))
				break;
			word += c;
			i++;
		}
		// `{` and `}` are reserved words only when written alone.
		tokens.push({
			text: word,
			kind: word === "{" || word === "}" ? "group" : "word",
		});
	}
	return tokens;
}

/**
 * The one quote/comment/heredoc/block scanner for a `run:` body: which offsets
 * the shell reads as inside a quoted string, which it never executes (a
 * comment, a heredoc body, or a line after an `exit`), and which lines start
 * at block depth 0.
 */
function scanShell(text: string): ShellScan {
	const unreachable = new Uint8Array(text.length);
	const quoted = new Uint8Array(text.length);
	const commentCut: number[] = [];
	const lines: ShellLine[] = [];
	const frames: ShellFrame[] = [];
	const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
	const closeFrame = (kind: ShellFrame): void => {
		for (let i = frames.length - 1; i >= 0; i--)
			if (frames[i] === kind) {
				frames.length = i;
				return;
			}
	};
	/** Walk one line's tokens: block depth, and an `exit` that ends the script. */
	const applyTokens = (tokens: readonly ShellToken[]): boolean => {
		let atCommandStart = true;
		let sawExit = false;
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (!token) continue;
			if (token.kind === "op") {
				if (token.text === "(") {
					const next = tokens[i + 1];
					// `name()` is a function definition's paren pair, not a subshell.
					if (next?.kind === "op" && next.text === ")") {
						i++;
						atCommandStart = false;
						continue;
					}
					frames.push("subshell");
					atCommandStart = true;
					continue;
				}
				if (token.text === ")") {
					closeFrame("subshell");
					atCommandStart = false;
					continue;
				}
				atCommandStart = true;
				continue;
			}
			if (token.kind === "group") {
				if (token.text === "{") {
					frames.push("group");
					atCommandStart = true;
				} else {
					closeFrame("group");
					atCommandStart = false;
				}
				continue;
			}
			if (atCommandStart) {
				const opener = BLOCK_OPENERS[token.text];
				if (opener) {
					frames.push(opener);
					atCommandStart = true;
					continue;
				}
			}
			const closer = BLOCK_CLOSERS[token.text];
			if (closer) {
				closeFrame(closer);
				atCommandStart = false;
				continue;
			}
			// An `exit` in COMMAND position ends the script. One in argument
			// position is a word the command reads (`echo exit`, `grep -n exit f`)
			// and used to end it too, which refused a floor the shell reaches
			// (#4609 r5 LOW-2: shape 43, text read as structure).
			if (atCommandStart && token.text === "exit") sawExit = true;
			atCommandStart =
				COMMAND_SEPARATOR_WORDS.has(token.text) ||
				(atCommandStart && COMMAND_PREFIX_WORDS.has(token.text));
		}
		return sawExit;
	};
	let quote: '"' | "'" | null = null;
	let terminated = false;
	/** The previous physical line's continuation, so the next one reports it. */
	let continues = false;
	let offset = 0;
	for (const line of text.split("\n")) {
		const start = offset;
		const end = offset + line.length;
		offset = end + 1;
		if (terminated) {
			unreachable.fill(1, start, end + 1);
			commentCut.push(line.length);
			lines.push({
				start,
				code: "",
				depth: frames.length,
				joinsPrevious: continues,
				continuation: null,
			});
			continues = false;
			continue;
		}
		if (heredocs.length > 0) {
			const top = heredocs[0];
			const body = top?.stripTabs ? line.replace(/^\t+/, "") : line;
			unreachable.fill(1, start, end + 1);
			commentCut.push(line.length);
			if (body.trimEnd() === top?.delimiter) heredocs.shift();
			lines.push({
				start,
				code: "",
				depth: frames.length,
				joinsPrevious: continues,
				continuation: null,
			});
			continues = false;
			continue;
		}
		let cut = line.length;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i] ?? "";
			if (quote) {
				quoted[start + i] = 1;
				if (ch === quote) quote = null;
				else if (ch === "\\" && quote === '"' && i + 1 < line.length) {
					i++;
					quoted[start + i] = 1;
				}
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			if (ch === "\\" && i + 1 < line.length) {
				i++;
				continue;
			}
			if (ch === "#" && (i === 0 || /[\s;]/.test(line[i - 1] ?? ""))) {
				cut = i;
				unreachable.fill(1, start + i, end + 1);
				break;
			}
			if (ch === "<" && line.startsWith("<<", i) && line[i + 2] !== "<") {
				const here = HEREDOC.exec(line.slice(i));
				const delimiter = here?.[2] ?? here?.[3] ?? here?.[4];
				if (delimiter)
					heredocs.push({ delimiter, stripTabs: here?.[1] === "-" });
			}
		}
		commentCut.push(cut);
		const code = line.slice(0, cut);
		const tokens = shellTokens(code, quoted, start);
		lines.push({
			start,
			code,
			depth: frames.length,
			joinsPrevious: continues,
			continuation: continuationOf(code, start, quoted, tokens),
		});
		continues = lines.at(-1)?.continuation !== null;
		if (applyTokens(tokens)) terminated = true;
	}
	return { unreachable, quoted, commentCut, lines };
}

/**
 * How a physical line hands its command to the next one, or `null` when it
 * ends it (#4609 r5 MEDIUM-2). The shell removes a trailing `\` and its
 * newline, so `<cmd> \` + newline + `<args>` is one command, and it reads a
 * trailing `&&`/`||`/`|` as needing the next command. Reading each physical
 * line as a whole command credited an argument list of the PREVIOUS program
 * (`echo \`, `[ … ] \`, `false &&`), which the shell never runs.
 */
function continuationOf(
	code: string,
	start: number,
	quoted: Uint8Array,
	tokens: readonly ShellToken[],
): "backslash" | "operator" | null {
	const trailing = /\\+$/.exec(code);
	// An odd run outside quotes escapes the newline; an even run is a literal
	// backslash before a real command boundary.
	if (
		trailing &&
		trailing[0].length % 2 === 1 &&
		!quoted[start + code.length - 1]
	)
		return "backslash";
	const last = tokens.at(-1);
	if (last?.kind === "op" && CONTINUATION_OPERATORS.has(last.text))
		return "operator";
	return null;
}

/**
 * The invocations whose argument list carries a measured floor (#4609 r3
 * MEDIUM-2). An allowlist: evidence is credited only for one of these programs
 * with its own script, so `echo scripts/complexity-report.mjs` and a flag
 * printed by another command credit nothing. A floor measured by another
 * program is a row here, never a new spelling in a deny list.
 */
const FLOOR_INVOCATIONS: ReadonlyArray<readonly [string, string]> = [
	["node", "scripts/assert-evaluated.mjs"],
	["node", "scripts/smoke-tools.mjs"],
	["node", "scripts/complexity-report.mjs"],
];

const isFloorInvocation = (program: string, script: string): boolean =>
	FLOOR_INVOCATIONS.some(([p, s]) => p === program && s === script);

/** The program and script argument a line starts with. */
const INVOCATION_PREFIX = /^(\s*)(\S+)(\s+)(\S+)/;

/**
 * A shell control operator: everything before the evidence that would put it
 * in a second command, a chained command, a subshell or a brace group (so the
 * evidence no longer sits in the first command's argument list).
 */
const SHELL_CONTROL_BEFORE = /[;&|`(){}]/;

/**
 * Whether `evidence` is a floor carried by a reached measuring command.
 *
 * Allowlist, fail-closed (#4609 r3 MEDIUM-2, r5 MEDIUM-2): the evidence must
 * occur in the argument list of one of {@link FLOOR_INVOCATIONS}, on a command
 * that starts at block depth 0, with no shell control operator between the
 * command's start and the match, and not in a comment, a quoted string, a
 * heredoc body, or after an `exit` in command position. Everything else
 * refuses: `echo … --count "probe=`, a `printf`, an uncalled function body, an
 * `if false` branch, a subshell, a line after an `exit` behind `&&` or an `if`,
 * and an argument list the previous line owns (`echo \\`, `[ … ] \\`, `false &&`).
 * The command is the LOGICAL line: a `\`-continued or operator-continued
 * physical line joins the one before it, so `<script> \\` + newline + `<args>`
 * is credited and only a line that starts a command after the join is.
 * A trailing pipeline or handler (`| tee …`, `|| floor=$?`) is allowed because
 * the invocation has already run by then.
 */
export function evidenceIsExecutable(run: string, evidence: string): boolean {
	if (!evidence) return false;
	const scan = scanShell(run);
	const lineIndexAt = (offset: number): number => {
		let low = 0;
		let high = scan.lines.length - 1;
		while (low <= high) {
			const middle = (low + high) >> 1;
			const line = scan.lines[middle];
			if (!line) break;
			if (offset < line.start) high = middle - 1;
			else if (offset > line.start + line.code.length) low = middle + 1;
			else return middle;
		}
		return -1;
	};
	/** The joined text of the physical lines before `index`, in this command. */
	const commandHead = (index: number): string => {
		let first = index;
		while (first > 0 && scan.lines[first]?.joinsPrevious) first--;
		let before = "";
		for (let i = first; i < index; i++) {
			const line = scan.lines[i];
			if (!line) continue;
			// The shell removes `\` and its newline; an operator keeps its space.
			before +=
				line.continuation === "backslash"
					? line.code.replace(/\\+$/, "")
					: line.continuation === "operator"
						? `${line.code} `
						: line.code;
		}
		return before;
	};
	for (
		let at = run.indexOf(evidence);
		at >= 0;
		at = run.indexOf(evidence, at + 1)
	) {
		if (scan.unreachable[at] || scan.quoted[at]) continue;
		const index = lineIndexAt(at);
		const line = scan.lines[index];
		if (!line || line.depth !== 0) continue;
		const before = commandHead(index);
		const inCommand = before.length + (at - line.start);
		// The whole logical command, so its program and script argument are read
		// even when the evidence IS the script, as `lint.yml`'s floor is.
		const command = before + line.code;
		let first = index;
		while (first > 0 && scan.lines[first]?.joinsPrevious) first--;
		// A command that starts inside a block body is not a top-level command.
		if ((scan.lines[first]?.depth ?? 1) !== 0) continue;
		if (SHELL_CONTROL_BEFORE.test(command.slice(0, inCommand))) continue;
		const prefix = INVOCATION_PREFIX.exec(command);
		if (!prefix) continue;
		const program = prefix[2] ?? "";
		const script = prefix[4] ?? "";
		if (!isFloorInvocation(program, script)) continue;
		const scriptAt =
			(prefix[1]?.length ?? 0) + program.length + (prefix[3]?.length ?? 0);
		if (inCommand >= scriptAt) return true;
	}
	return false;
}

/**
 * The two file names a composite action is written under. An allowlist: a
 * misnamed copy such as `action.backup.yml` is not a file GitHub runs, so it
 * refuses instead of being parsed as a producer (#4609 r3 LOW-1).
 */
const isCompositeActionFile = (file: string): boolean =>
	file === "action.yml" || file === "action.yaml";

/**
 * Which producer kind a repo-relative path is, or `null` when unclassified.
 * Derived from the path's structure, not from a list of spellings: a workflow
 * is one YAML file directly under `.github/workflows/`, and a composite action
 * is `action.yml` or `action.yaml` at least one directory below
 * `.github/actions/`.
 */
export function classifyProducerFile(path: string): ProducerKind | null {
	const segments = toPosix(path).split("/");
	const file = segments.at(-1) ?? "";
	if (!YAML_SUFFIXES.some((suffix) => file.endsWith(suffix))) return null;
	const [, area, ...rest] = segments;
	if (area === "workflows" && rest.length === 1) return "workflow";
	if (area === "actions" && rest.length >= 2 && isCompositeActionFile(file))
		return "composite";
	return null;
}

/** One entry the walk found: a path, and whether it is a regular file. */
interface WalkEntry {
	path: string;
	regularFile: boolean;
}

const walkEntries = (root: string, rel: string): WalkEntry[] => {
	let entries: DirEnt[];
	try {
		entries = readdirSync(join(root, rel), { withFileTypes: true });
	} catch {
		// A root that is absent has no producer files; the caller's floors report
		// that, so a silent empty walk cannot read as a clean tree.
		return [];
	}
	return entries.flatMap((entry) => {
		const next = `${rel}/${entry.name}`;
		if (entry.isDirectory())
			return YAML_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
				? [{ path: next, regularFile: false }]
				: walkEntries(root, next);
		// A symlink or any other non-file entry is reported, never parsed: a
		// symlinked `*.yml` is not a workflow GitHub runs, and following it could
		// read a file outside the producer roots (#4609 r2 nitpick).
		return [{ path: next, regularFile: entry.isFile() }];
	});
};

/**
 * Every entry under the producer roots, split into the ones the reader parses
 * and the ones it does not. The second list is the fail-closed surface: a
 * reader that silently ignores a file form is a guard with a hole in it.
 */
export function listProducerFiles(root: string): {
	files: ProducerFile[];
	unclassified: string[];
} {
	const files: ProducerFile[] = [];
	const unclassified: string[] = [];
	for (const dir of PRODUCER_ROOTS)
		for (const entry of walkEntries(root, dir).sort((a, b) =>
			a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
		)) {
			const kind = entry.regularFile ? classifyProducerFile(entry.path) : null;
			if (kind) files.push({ path: entry.path, kind });
			else unclassified.push(entry.path);
		}
	return { files, unclassified };
}

/** Read a producer file. Exported so a fixture tree can drive the same seam. */
export function parseProducerFile(root: string, file: string): unknown {
	return yaml.load(readFileSync(join(root, file), "utf8"));
}

/**
 * Every `continue-on-error` key in the parsed document, with its path. Derived
 * from the document, so a key inside a `run:` heredoc or a comment is not one
 * (r1 LOW-1: the raw-text guard redded a legitimate workflow).
 */
export function coeLocations(
	document: unknown,
): Array<{ path: string[]; value: unknown }> {
	const found: Array<{ path: string[]; value: unknown }> = [];
	const walk = (node: unknown, path: string[]): void => {
		if (Array.isArray(node)) {
			node.forEach((value, index) => walk(value, [...path, String(index)]));
			return;
		}
		if (!node || typeof node !== "object") return;
		for (const [key, value] of Object.entries(node)) {
			const next = [...path, key];
			if (key === "continue-on-error" && isCoe(value))
				found.push({ path: next, value });
			walk(value, next);
		}
	};
	walk(document, []);
	return found;
}

/** The event names a workflow's `on:` block declares, in its three shapes. */
export function workflowTriggers(
	value: unknown,
): readonly string[] | undefined {
	if (typeof value === "string") return [value];
	if (Array.isArray(value))
		return value.filter((entry): entry is string => typeof entry === "string");
	if (value && typeof value === "object")
		return Object.keys(value).filter((key) => key.length > 0);
	return undefined;
}

/**
 * One job's `strategy.matrix` scalar lists. A key whose value is not a list of
 * scalars (`include`, `exclude`, a nested object) carries no value set, so a
 * comparison against it refuses instead of guessing a leg (#4609 r5 MEDIUM-1).
 */
export function jobMatrix(
	job: CoeJob | undefined,
): Readonly<Record<string, readonly string[]>> {
	const matrix = job?.strategy?.matrix;
	const lists: Record<string, readonly string[]> = {};
	if (!matrix || typeof matrix !== "object" || Array.isArray(matrix))
		return lists;
	for (const [key, value] of Object.entries(
		matrix as Record<string, unknown>,
	)) {
		if (!Array.isArray(value) || value.length === 0) continue;
		if (
			!value.every(
				(entry) =>
					typeof entry === "string" ||
					typeof entry === "number" ||
					typeof entry === "boolean",
			)
		)
			continue;
		lists[key] = value.map((entry) => String(entry));
	}
	return lists;
}

/** The site a key path describes, or `null` when the location is not one. */
function siteForLocation(
	file: string,
	kind: ProducerKind,
	document: ProducerDocument,
	path: readonly string[],
): Omit<CoESite, "key"> | null {
	if (kind === "workflow") {
		if (path[0] !== "jobs" || !path[1]) return null;
		const job = document.jobs?.[path[1]];
		if (!job) return null;
		const steps = job.steps ?? [];
		// The job's own `if:` and matrix, and the workflow's events: the house
		// the floor lives in, read since #4609 r5 (LOW-1 and MEDIUM-1).
		const facts: ConditionFacts = {
			triggers: workflowTriggers(document.on),
			matrix: jobMatrix(job),
		};
		const jobIf = job.if;
		if (path.length === 2)
			return {
				file,
				kind,
				scope: path[1],
				steps,
				index: -1,
				jobIf,
				facts,
			};
		if (path.length === 4 && path[2] === "steps") {
			const index = Number(path[3]);
			const step = steps[index];
			return step
				? { file, kind, scope: path[1], step, steps, index, jobIf, facts }
				: null;
		}
		return null;
	}
	const steps = document.runs?.steps ?? [];
	if (path.length === 3 && path[0] === "runs" && path[1] === "steps") {
		const index = Number(path[2]);
		const step = steps[index];
		// A composite action has no `on:` and no matrix: every comparison in its
		// `if:` is undecidable, so none credits a floor.
		return step
			? { file, kind, scope: "composite", step, steps, index, facts: {} }
			: null;
	}
	return null;
}

const siteKey = (site: Omit<CoESite, "key">): string =>
	site.step
		? site.kind === "composite"
			? `${site.file}#${stepIdentity(site.step)}`
			: `${site.file}#${site.scope}#${stepIdentity(site.step)}`
		: `${site.file}#${site.scope}`;

/**
 * The sites one parsed producer document declares, plus every location the
 * reader could not classify (a `continue-on-error` key somewhere else in the
 * document is not a producer this census governs).
 */
export function sitesInDocument(
	file: string,
	kind: ProducerKind,
	document: ProducerDocument,
): { sites: CoESite[]; problems: string[] } {
	const sites: CoESite[] = [];
	const problems: string[] = [];
	for (const { path } of coeLocations(document)) {
		// The walk names the key itself; the site is where its parent lives.
		const owner = path.slice(0, -1);
		const site = siteForLocation(file, kind, document, owner);
		if (!site) {
			problems.push(
				`${file}: continue-on-error at an unclassified location: ${path.join(".")}`,
			);
			continue;
		}
		sites.push({ key: siteKey(site), ...site });
	}
	return { sites, problems };
}

/** Read every producer file under `root` into one census. */
export function readProducerCensus(root: string): ProducerCensus {
	const { files, unclassified } = listProducerFiles(root);
	const sites: CoESite[] = [];
	const problems: string[] = unclassified.map(
		(file) =>
			`${file}: an entry under a producer root this reader does not classify: it is not a regular file, or not a file form it parses (workflows are *.yml/*.yaml, actions are <dir>/action.yml|yaml)`,
	);
	for (const file of files) {
		let document: ProducerDocument;
		try {
			document = (parseProducerFile(root, file.path) ?? {}) as ProducerDocument;
		} catch (error) {
			problems.push(
				`${file.path}: unparseable producer file: ${(error as Error).message}`,
			);
			continue;
		}
		const read = sitesInDocument(file.path, file.kind, document);
		sites.push(...read.sites);
		problems.push(...read.problems);
	}
	return { files, unclassified, sites, problems };
}

const isGatingStep = (step: CoeStep): boolean =>
	!isCoe(step["continue-on-error"]);

/**
 * Why a `floored` row is not a gate, or `[]` when it is. The floor step must
 * exist in the site's own scope, cannot itself be `continue-on-error`, must have
 * an `if:` that always runs in its job, must come after the site, must carry the
 * evidence on text the shell executes rather than on data, and its job must not
 * carry an `if:` the document proves can never be true (#4609 r5 LOW-1).
 */
export function floorProblems(site: CoESite, row: CoERow): string[] {
	if (row.status !== "floored") return [];
	const problems: string[] = [];
	if (!row.floorStep) problems.push(`${site.key}: no floorStep`);
	if (!row.evidence) problems.push(`${site.key}: no evidence`);
	if (problems.length > 0) return problems;
	const index = site.steps.findIndex((step) =>
		stepIdentity(step).includes(row.floorStep ?? "\u0000"),
	);
	if (index < 0) return [`${site.key}: no step named like "${row.floorStep}"`];
	const floor = site.steps[index];
	if (!isGatingStep(floor))
		problems.push(
			`${site.key}: its floor step is continue-on-error, so the floor gates nothing`,
		);
	const facts = site.facts ?? {};
	const unproven = unprovenCondition(floor.if, facts);
	if (unproven)
		problems.push(
			`${site.key}: its floor step may never run (${unproven}), so the floor is unproven`,
		);
	// The job gates the site and the floor alike, so its `if:` must not be
	// provably never true; the step allowlist above would refuse a legitimate
	// condition on a live job (#4609 r5 LOW-1, decided in STATE_TABLE.md).
	const jobUnproven = unprovenJobCondition(site.jobIf, facts);
	if (jobUnproven)
		problems.push(
			`${site.key}: its job ${jobUnproven}, so the floor is unproven`,
		);
	if (!site.step && site.index < 0 && index >= 0) {
		// A job-level site is gated by a step inside it; nothing to order.
	} else if (index <= site.index)
		problems.push(
			`${site.key}: its floor step runs before the site it is meant to gate`,
		);
	if (
		!evidenceIsExecutable(
			typeof floor.run === "string" ? floor.run : "",
			row.evidence ?? "",
		)
	)
		problems.push(
			`${site.key}: "${row.evidence}" is not on an executable line of that step's run text`,
		);
	return problems;
}

/** The fields each status must carry, and the fields it must not. */
const ROW_FIELDS: Record<CoEStatus, { needs: string[]; forbids: string[] }> = {
	floored: { needs: ["floorStep", "evidence"], forbids: ["governedBy"] },
	"no-floor": { needs: [], forbids: ["floorStep", "evidence"] },
	"governed-by": {
		needs: ["governedBy", "tests"],
		forbids: ["floorStep", "evidence"],
	},
};

/** Why a row itself is not a usable record, or `[]` when it is. */
export function rowProblems(key: string, row: CoERow): string[] {
	const problems: string[] = [];
	if (!Object.hasOwn(ROW_FIELDS, row.status)) {
		problems.push(`${key}: unknown status "${String(row.status)}"`);
		return problems;
	}
	if ((row.reason ?? "").trim().length < 40)
		problems.push(`${key}: reason is missing or under 40 characters`);
	const fields = row as unknown as Record<string, unknown>;
	// An empty list is as empty as a missing one: `tests: []` names nothing.
	const present = (value: unknown) =>
		Array.isArray(value) ? value.length > 0 : Boolean(value);
	const { needs, forbids } = ROW_FIELDS[row.status];
	for (const field of needs)
		if (!present(fields[field]))
			problems.push(`${key}: a ${row.status} row needs ${field}`);
	for (const field of forbids)
		if (fields[field])
			problems.push(`${key}: a ${row.status} row does not carry ${field}`);
	if (
		row.status === "governed-by" &&
		row.governedBy !== undefined &&
		!/^#\d+$/.test(row.governedBy)
	)
		problems.push(`${key}: governed-by rows name an issue as "#<n>"`);
	return problems;
}
