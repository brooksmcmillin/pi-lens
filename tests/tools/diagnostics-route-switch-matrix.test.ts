/**
 * #4403: every diagnostics entry route, under every switch that selects
 * servers, starts the same servers and gives the same confirmation verdict.
 *
 * Recurrence: #4322 (a missing primary reported clean from an auxiliary alone)
 * and #4323 (explicit checks started a switched-off Opengrep). Both were fixed
 * route by route (#4390, #4391), and #4391's review found a seventh route still
 * drifting. Nothing stopped the next route from drifting the same way.
 *
 * Two halves:
 *
 * 1. The route list is derived from code. Every production access to an
 *    `LSPService` member that starts a server or returns diagnostics
 *    (`DIAGNOSTICS_ENTRY_MEMBERS`) is a site, and the scan fails closed: an
 *    access it cannot classify as a site, a definition or a local alias reds
 *    under a quoted key until it is exempted (see `deriveSites`). The AST scan
 *    never sees a comment, so prose cannot add or satisfy a site. Each site
 *    maps to a matrix route or carries an exemption whose key holds the site's
 *    `clientScope` and `diagnostics` options, so a site that widens its scope
 *    gets a new key and has to be placed again. A new site reds; so does a
 *    registry entry whose site is gone, and a route the registry names that the
 *    matrix does not drive. Out of reach: a member name built at run time, and
 *    a new caller of a route's existing helper.
 *
 * 2. The matrix drives each route through its real entry: pi's `tool_result`
 *    and `turn_end` hooks and the `lens_diagnostics` and `lsp_navigation`
 *    tools that the real extension activation registers, and the real MCP
 *    server over stdio. Language servers are the host boundary: each one's
 *    command is a project override pointing at a shim that appends the server
 *    id to a marker file and then runs the shared fake server, which answers
 *    every pull with no findings. A missing primary's command points at a path
 *    that does not exist. Each cell gets a fresh LSP service, so the marker
 *    lines a cell adds are the servers that route started. Each cell asserts
 *    its row of the state table (PR #4411): the servers started, the verdict
 *    read from what the route shows, and the exact lines it shows. A disabled
 *    primary and a missing one are both unconfirmed, and each line that gives
 *    a reason names which (#4403, the #4322 rule extended to
 *    `lsp.disabledServers`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Lang, parse } from "@ast-grep/napi";
import { afterAll, describe, expect, it } from "vitest";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { getLensFlagSpec } from "../../clients/lens-flag-registry.js";
import { getLSPService, resetLSPService } from "../../clients/lsp/index.js";
import { clearWorkspaceDiagnosticsCache } from "../../clients/lsp/workspace-diagnostics-cache.js";
import {
	cleanupTestEnvironmentsDrained,
	setupTestEnvironment,
} from "../clients/test-utils.js";
import { McpHarness } from "../mcp/harness.js";
import { scaledTestTimeout } from "../support/test-timeout-scale.js";
import { makeSessionStartEvent } from "../support/host-event-factory.js";
import { createPiMock, makeCtx } from "../support/pi-mock.js";
import {
	auditRegistry,
	findEnclosingSymbol,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const fakeServer = path.join(
	repoRoot,
	"tests",
	"fixtures",
	"fake-lsp-server.mjs",
);
const PREFIX = "pi-lens-4403-matrix-";

// ── The routes and switches ─────────────────────────────────────────────────

const ROUTES = [
	"write-time dispatch",
	"lsp_diagnostics file",
	"lsp_diagnostics batch",
	"lsp_diagnostics directory",
	"lsp_diagnostics primary-only",
	"MCP pilens_diagnostics",
	"lsp_navigation workspaceDiagnostics",
	"turn-end actionable warnings",
	"lens_diagnostics mode=full",
] as const;
type RouteId = (typeof ROUTES)[number];

/**
 * Which servers a route asks for, given the servers the configuration selects:
 * `all` asks every selected server; `primary` asks the language server, and
 * when none could start its clientless fallback asks every selected server
 * (#4322);
 * `sweep` is the `mode=full` engine, which leaves Opengrep to its CLI extractor
 * (`WORKSPACE_SWEEP_EXCLUDED_SERVER_IDS`, #584) and starts nothing for a file
 * whose language server cannot start.
 */
type RouteScope = "all" | "primary" | "sweep";
const ROUTE_SCOPE: Record<RouteId, RouteScope> = {
	"write-time dispatch": "all",
	"lsp_diagnostics file": "all",
	"lsp_diagnostics batch": "all",
	"lsp_diagnostics directory": "all",
	"lsp_diagnostics primary-only": "primary",
	"MCP pilens_diagnostics": "all",
	"lsp_navigation workspaceDiagnostics": "all",
	"turn-end actionable warnings": "all",
	"lens_diagnostics mode=full": "sweep",
};

/**
 * A route that renders no confirmation verdict, with the reason. Every other
 * route's verdict is read from what it shows the agent.
 */
const NO_VERDICT_SURFACE: Partial<Record<RouteId, string>> = {
	"turn-end actionable warnings":
		"it reports only warnings that carry a code action; a file with none adds nothing, clean or not",
};

type ColumnId =
	| "present"
	| "disabled"
	| "disabled, fallback"
	| "missing"
	| "present, no aux"
	| "disabled, no aux"
	| "missing, no aux"
	| "--no-opengrep"
	| "opengrep.enabled=false";

interface Column {
	id: ColumnId;
	/** pi CLI flags. */
	piFlags: Record<string, boolean>;
	/** `~/.pi-lens/config.json`, through PI_LENS_CONFIG_PATH. */
	globalConfig: Record<string, unknown>;
	/**
	 * The language server: a working fake, off in lsp.json, or a missing
	 * binary. `disabledFallback` is a TypeScript file whose primary is off in
	 * lsp.json while its `fallbackFor` alternate (deno) is a missing binary
	 * (#4403 round 4, N1).
	 */
	primary: "fake" | "disabled" | "disabledFallback" | "missing";
	/** typos and Opengrep running; false turns both off in `lsp.disabledServers`. */
	aux: boolean;
	opengrepOff: boolean;
	/** Opengrep is off through its own switch, which the file renderer names. */
	opengrepSwitchedOff: boolean;
}

const column = (
	id: ColumnId,
	primary: Column["primary"],
	aux: boolean,
	switches: Partial<Pick<Column, "piFlags" | "globalConfig">> = {},
): Column => ({
	id,
	piFlags: switches.piFlags ?? {},
	globalConfig: switches.globalConfig ?? {},
	primary,
	aux,
	opengrepOff:
		!aux ||
		switches.piFlags !== undefined ||
		switches.globalConfig !== undefined,
	opengrepSwitchedOff:
		switches.piFlags !== undefined || switches.globalConfig !== undefined,
});

/**
 * The state table's six columns (the primary present, disabled in config, or
 * missing, each with and without an auxiliary), the disabled primary whose
 * fallback cannot start, then the two switches that turn Opengrep off, which
 * must change nothing but the servers started.
 */
const COLUMNS: readonly Column[] = [
	column("present", "fake", true),
	column("disabled", "disabled", true),
	column("disabled, fallback", "disabledFallback", true),
	column("missing", "missing", true),
	column("present, no aux", "fake", false),
	column("disabled, no aux", "disabled", false),
	column("missing, no aux", "missing", false),
	column("--no-opengrep", "fake", true, { piFlags: { "no-opengrep": true } }),
	column("opengrep.enabled=false", "fake", true, {
		globalConfig: { opengrep: { enabled: false } },
	}),
];

/**
 * A cell that cannot exist, with the reason. The MCP server has no CLI flags:
 * it resolves `no-opengrep` from config only (`createMcpHost`), so its switch
 * is the `opengrep.enabled=false` column. A case below reds if the flag ever
 * gains an environment spelling the MCP host could read.
 */
const NOT_APPLICABLE: ReadonlyArray<{
	route: RouteId;
	column: ColumnId;
	why: string;
}> = [
	{
		route: "MCP pilens_diagnostics",
		column: "--no-opengrep",
		why: "the MCP host has no CLI flags; it reads no-opengrep from config only",
	},
];

type Verdict = "clean" | "unconfirmed" | "findings" | "unsupported";

/**
 * The file language a column checks. The fallback column is TypeScript: JSON
 * has no `fallbackFor` alternate. The rule it pins is read from that link, so
 * python/python-jedi, csharp/omnisharp, docker/docker-official and
 * elixir/expert take the same path.
 */
const LANGUAGE = {
	json: {
		ext: ".json",
		label: "JSON",
		kind: "json",
		/** The primaries a file line names when none answered. */
		unanswered: "json",
		content: (name: string, n: number) => `{"${name}": ${n}}\n`,
	},
	ts: {
		ext: ".ts",
		label: "JavaScript/TypeScript",
		kind: "jsts",
		unanswered: "deno, typescript",
		content: (name: string, n: number) =>
			`export const ${name.replace(/\W/g, "_")} = ${n};\n`,
	},
} as const;
type Language = (typeof LANGUAGE)[keyof typeof LANGUAGE];

function languageOf(column: Column): Language {
	return column.primary === "disabledFallback" ? LANGUAGE.ts : LANGUAGE.json;
}

/** The servers a column's configuration selects that can start. */
function selectedServers(column: Column): string[] {
	return [
		...(column.primary === "fake" ? ["json"] : []),
		...(column.opengrepOff ? [] : ["opengrep"]),
		...(column.aux ? ["typos"] : []),
	].sort();
}

function expectedStarted(route: RouteId, column: Column): string[] {
	const selected = selectedServers(column);
	switch (ROUTE_SCOPE[route]) {
		case "all":
			return selected;
		case "primary":
			// A disabled primary makes the touch inconclusive at once, so the
			// clientless fallback that would ask the others never runs.
			return column.primary === "fake"
				? ["json"]
				: column.primary === "missing"
					? selected
					: [];
		case "sweep":
			// A fallback that cannot start fails the sweep's warm-up like a
			// missing primary, so its group is skipped before any touch.
			return column.primary === "missing" ||
				column.primary === "disabledFallback"
				? []
				: selected.filter((id) => id !== "opengrep");
	}
}

/**
 * The column's verdict, from the rules alone: a working language server that
 * answers clean confirms the file, switches that drop only Opengrep change
 * nothing about that, and no primary answering is never clean, whether it
 * could not start (#4322) or is off in config (#4403), with or without an
 * auxiliary.
 */
function expectedVerdict(column: Column): Verdict {
	return column.primary === "fake" ? "clean" : "unconfirmed";
}

// ── The state table's lines ────────────────────────────────────────────────
//
// The exact user-facing lines of the round-3 state table (PR #4411): each
// route's verdict line and the cause it gives, `<ws>` for the workspace and
// `Nms` for a timing. Literal on purpose: the table is the spec, so a wording
// change reds here and is decided, not inherited from a shared constant.

const CAUSE = {
	disabled: "it is disabled in config by lsp.disabledServers",
	disabledFallback:
		"it is disabled in config by lsp.disabledServers, and its fallback could not be started, or was still starting",
	missing: "it could not be started, or was still starting",
} as const;

const NOTE_GENERIC =
	"🟡 1 warning(s):\nPi-lens json analysis unavailable — a language tool is missing, timed out, or failed to run, or the LSP server isn't ready yet, so this file was not fully checked (not a clean result).";
const NOTE_DISABLED =
	"🟡 1 warning(s):\nPi-lens json analysis unconfirmed — Primary LSP (json) is disabled in config by lsp.disabledServers, so no language server checks these files this session (not a clean result).";
const NOTE_DISABLED_FALLBACK =
	"🟡 1 warning(s):\nPi-lens jsts analysis unconfirmed — Primary LSP (typescript) is disabled in config by lsp.disabledServers and its fallback did not answer, so no language server checked these files (not a clean result).";

function fileLine(column: Column): string {
	const { primary } = column;
	return primary === "fake"
		? "Primary LSP (json): confirmed clean."
		: `Primary LSP (${languageOf(column).unanswered}): not available — no language server answered for this file (${CAUSE[primary]}). NOT the same as 0 diagnostics; auxiliary scanners do not check the language itself.`;
}

/**
 * The single-file renderer's second line: the auxiliaries' answer, which names
 * a switched-off Opengrep when the read asked every server, or, when no client
 * answered at all, the health record.
 */
function fileSecondLine(column: Column, file: string, route: RouteId): string {
	if (column.primary === "missing" && !column.aux)
		return `LSP unavailable for <ws>/${file}: no LSP client is currently ready; ready=0/1. candidates=json. No diagnostics were collected.`;
	return column.opengrepSwitchedOff && ROUTE_SCOPE[route] === "all"
		? "No auxiliary findings. Switched off, not run: opengrep."
		: "No auxiliary findings.";
}

function tallyLine(primary: Column["primary"], count: number): string {
	return `${count} with no language server answer (${CAUSE[primary as Exclude<Column["primary"], "fake">]}). NOT the same as 0 diagnostics.`;
}

function expectedLines(route: RouteId, column: Column): string[] {
	const { primary } = column;
	const { ext, label } = languageOf(column);
	const clean = primary === "fake";
	switch (route) {
		case "write-time dispatch": {
			if (clean)
				return [
					"✓ JSON clean · Nms",
					"✓ JSON clean · Nms",
					"✓ JSON clean · Nms",
				];
			const status = `⚠ ${label} unconfirmed — no language server answered (${CAUSE[primary]}) · Nms`;
			// First write, a later write of it, then a second file's first write:
			// one note per disabled server per session, one per file otherwise.
			return primary === "disabled"
				? [NOTE_DISABLED, status, status]
				: primary === "disabledFallback"
					? [NOTE_DISABLED_FALLBACK, status, status]
					: [NOTE_GENERIC, status, NOTE_GENERIC];
		}
		case "lsp_diagnostics file":
			return [fileLine(column), fileSecondLine(column, `file${ext}`, route)];
		case "lsp_diagnostics primary-only":
			return [fileLine(column), fileSecondLine(column, `primary${ext}`, route)];
		case "MCP pilens_diagnostics":
			return [fileLine(column), fileSecondLine(column, `mcp${ext}`, route)];
		case "lsp_diagnostics batch": {
			if (clean)
				return [
					"Outcomes: clean=2, findings=0, unsupported=0, unavailable=0, failed=0, too_large=0, inconclusive=0",
					"No diagnostics found.",
				];
			const unavailable = primary === "missing" && !column.aux;
			return [
				`Outcomes: clean=0, findings=0, unsupported=0, unavailable=${unavailable ? 2 : 0}, failed=0, too_large=0, inconclusive=${unavailable ? 0 : 2}`,
				`0 files confirmed clean, 2 unconfirmed: ${tallyLine(primary, 2)}`,
			];
		}
		case "lsp_diagnostics directory":
			if (clean) return ["No diagnostics found."];
			return [
				...(primary === "missing" && !column.aux
					? [
							"LSP unavailable for one or more files:",
							"LSP unavailable for <ws>/dir/inner.json: no LSP client is currently ready; ready=0/1. candidates=json. No diagnostics were collected.",
						]
					: []),
				`0 clean · 1 unconfirmed: ${tallyLine(primary, 1)}`,
			];
		case "lsp_navigation workspaceDiagnostics":
			return clean
				? ["ok=true status=empty"]
				: ["ok=true status=empty unconfirmed", fileLine(column)];
		case "lens_diagnostics mode=full":
			// #4403 N3: no retry hint where only a denial kept the server out.
			return clean
				? []
				: [
						`⚠ LSP sweep: 0 file(s) confirmed via LSP, 1 unconfirmed (no primary language server answered (${CAUSE[primary]})) — NOT the same as 0 diagnostics for: <ws>/sweep${ext}. These files' LSP contribution is excluded from this result${primary === "disabled" ? "" : "; re-run mode=full to retry them"} (they may still show findings above from cached/project-runner state).`,
					];
		case "turn-end actionable warnings":
			return [];
	}
}

type Cell = {
	started: string[] | "n/a";
	verdict: string;
	lines: string[] | "n/a";
};

function expectedRow(column: Column): Record<RouteId, Cell> {
	const row = {} as Record<RouteId, Cell>;
	for (const route of ROUTES) {
		if (
			NOT_APPLICABLE.some((na) => na.route === route && na.column === column.id)
		) {
			row[route] = { started: "n/a", verdict: "n/a", lines: "n/a" };
			continue;
		}
		row[route] = {
			started: expectedStarted(route, column),
			verdict:
				NO_VERDICT_SURFACE[route] !== undefined
					? "none"
					: expectedVerdict(column),
			lines: expectedLines(route, column),
		};
	}
	return row;
}

// ── Readers: what each route shows the agent ───────────────────────────────

/** Trimmed, non-empty lines, with the workspace and timings normalised. */
function shownLines(text: string, workspace: string): string[] {
	return text
		.split(workspace)
		.join("<ws>")
		.replace(/\d+ms\b/g, "Nms")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * What a write shows the agent about the file's check: its tool result minus
 * the tool's own output and the read-guard advisories, which speak to the
 * edit, not the check.
 */
function writeOutcome(text: string, workspace: string): string {
	return shownLines(text, workspace)
		.filter(
			(line) =>
				line !== "wrote" &&
				!line.startsWith("⚠ BLIND WRITE") &&
				!line.startsWith("🔴 THRASHING"),
		)
		.join("\n");
}

function writeTimeVerdict(outcomes: readonly string[]): string {
	const verdicts = new Set(
		outcomes.map((outcome) =>
			/^✓ \S+ clean · Nms$/.test(outcome)
				? "clean"
				: /not a clean result|unconfirmed/.test(outcome)
					? "unconfirmed"
					: `unread: ${outcome}`,
		),
	);
	return verdicts.size === 1
		? ([...verdicts][0] as string)
		: `mixed: ${[...verdicts].join(",")}`;
}

/** The single-file renderer's verdict line, shared by pi and MCP. */
function fileModeVerdict(text: string): string {
	const line = text.split("\n")[0] ?? "";
	if (/^Primary LSP[^:]*: confirmed clean\./.test(line)) return "clean";
	if (/^Primary LSP[^:]*: (not available|unconfirmed|timed out)/.test(line))
		return "unconfirmed";
	return `unread: ${line}`;
}

const BATCH_OUTCOME_VERDICT: Record<string, Verdict> = {
	clean: "clean",
	findings: "findings",
	inconclusive: "unconfirmed",
	unavailable: "unconfirmed",
	unsupported: "unsupported",
};

function batchVerdict(details: Record<string, unknown> | undefined): string {
	const outcomes = (details?.outcomes ?? []) as Array<{ outcome?: string }>;
	const verdicts = [
		...new Set(
			outcomes.map(
				(entry) =>
					BATCH_OUTCOME_VERDICT[entry.outcome ?? ""] ??
					`unread: ${entry.outcome}`,
			),
		),
	];
	return verdicts.length === 1
		? (verdicts[0] as string)
		: `mixed: ${verdicts.join(",")}`;
}

/** The batch's outcome tally and its unconfirmed (or clean) summary. */
function batchLines(text: string, workspace: string): string[] {
	return shownLines(text, workspace).filter(
		(line) =>
			line.startsWith("Outcomes:") ||
			/^\d+ files? confirmed clean, /.test(line) ||
			line === "No diagnostics found.",
	);
}

/** The directory scan's lines between its header and its delivery footer. */
function directoryLines(text: string, workspace: string): string[] {
	const lines = shownLines(text.split("\n\nresult ")[0] ?? "", workspace);
	return lines.filter(
		(line) =>
			!line.startsWith("Directory:") && !line.startsWith("Files scanned:"),
	);
}

type NavigationEnvelope = {
	ok?: boolean;
	status?: string;
	resultCount?: number;
	notes?: string[];
	metadata?: { unconfirmed?: boolean };
};

function navigationEnvelope(text: string): NavigationEnvelope {
	return JSON.parse(text.split("\n\nresult ")[0] ?? "") as NavigationEnvelope;
}

/**
 * The navigation envelope pi delivers (before the delivery footer). #4403 F5:
 * an envelope that is not `ok` never answered for the file, so it cannot be
 * clean; `no_server` used to score clean here.
 */
function navigationVerdict(text: string): string {
	const envelope = navigationEnvelope(text);
	if (envelope.ok !== true || envelope.metadata?.unconfirmed === true)
		return "unconfirmed";
	return (envelope.resultCount ?? 0) > 0 ? "findings" : "clean";
}

/** The envelope's state, then each note about the primary. */
function navigationLines(text: string): string[] {
	const envelope = navigationEnvelope(text);
	return [
		`ok=${envelope.ok} status=${envelope.status}${envelope.metadata?.unconfirmed === true ? " unconfirmed" : ""}`,
		...(envelope.notes ?? []).filter((note) => note.startsWith("Primary LSP")),
	];
}

function sweepVerdict(details: Record<string, unknown> | undefined): string {
	const confirmed = Number(details?.lspFilesConfirmed ?? 0);
	const unconfirmed = Number(details?.lspFilesUnconfirmed ?? 0);
	if (unconfirmed > 0) return "unconfirmed";
	if (confirmed > 0) return "clean";
	return "unread: no LSP file counted";
}

function sweepLines(text: string, workspace: string): string[] {
	return shownLines(text, workspace).filter((line) =>
		line.startsWith("⚠ LSP sweep:"),
	);
}

// ── Fixture ─────────────────────────────────────────────────────────────────

interface Fixture {
	workspace: string;
	marker: string;
	configPath: string;
	/** Writes `<relative><ext>` in the column's language and returns its path. */
	file: (relative: string, n?: number) => string;
}

function makeFixture(column: Column): Fixture {
	const env = setupTestEnvironment(PREFIX);
	// The real path: on macOS the tmpdir is a `/var` -> `/private/var` alias.
	const workspace = fs.realpathSync(env.tmpDir);
	const marker = path.join(workspace, "server-starts.txt");
	const shim = (serverId: string): string[] => {
		const file = path.join(workspace, `${serverId}-server.mjs`);
		fs.writeFileSync(
			file,
			[
				'import { appendFileSync } from "node:fs";',
				`appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(`${serverId}\n`)});`,
				'process.env.FAKE_LSP_RESPOND_PULL_WITH = "empty";',
				`import(${JSON.stringify(pathToFileURL(fakeServer).href)});`,
				"",
			].join("\n"),
		);
		return [process.execPath, file];
	};
	fs.writeFileSync(
		path.join(workspace, "package.json"),
		'{"name":"synthetic-4403-fixture","private":true}\n',
	);
	// typos and Opengrep root at the nearest `.git` (clients/lsp/server.ts);
	// #4560: the fixture root already carries the shared marker.
	fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
	const language = languageOf(column);
	fs.writeFileSync(
		path.join(workspace, ".pi-lens", "lsp.json"),
		JSON.stringify({
			serverOverrides: {
				json: {
					command:
						column.primary === "missing"
							? [
									path.join(workspace, "missing", "json-language-server"),
									"--stdio",
								]
							: shim("json"),
				},
				// The fallback column's alternate; never started by another one.
				deno: {
					command: [path.join(workspace, "missing", "deno"), "lsp"],
				},
				typos: { command: shim("typos") },
				opengrep: { command: shim("opengrep") },
			},
			// `rust` is a disabled primary that can never root here (there is no
			// `Cargo.toml`): no cell may name it (#4403 F7).
			disabledServers: [
				"ast-grep",
				"zizmor",
				"rust",
				...(column.primary === "disabled" ? ["json"] : []),
				...(column.primary === "disabledFallback" ? ["typescript"] : []),
				...(column.aux ? [] : ["typos", "opengrep"]),
			],
			// A configured warm file that does not exist: session_start's
			// dominant-language warm-up would otherwise start the JSON server in
			// the background, inside whichever cell runs next.
			warmFiles: ["no-such-warm-file.json"],
		}),
	);
	// Outside `.pi-lens`, so it is a global config file only.
	const configPath = path.join(workspace, "global-config.json");
	fs.writeFileSync(configPath, `${JSON.stringify(column.globalConfig)}\n`);
	return {
		workspace,
		marker,
		configPath,
		file: (relative, n = 1) => {
			const target = path.join(workspace, `${relative}${language.ext}`);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, language.content(path.basename(relative), n));
			return target;
		},
	};
}

function markerLines(marker: string): string[] {
	if (!fs.existsSync(marker)) return [];
	return fs.readFileSync(marker, "utf8").split("\n").filter(Boolean);
}

type ToolLike = {
	execute: (...args: unknown[]) => Promise<{
		content: Array<{ text?: string }>;
		details?: Record<string, unknown>;
	}>;
};

/** Runs every in-process route of one column through pi, then the MCP route. */
async function runColumn(column: Column): Promise<Record<RouteId, Cell>> {
	const fx = makeFixture(column);
	const observed = {} as Record<RouteId, Cell>;
	const savedConfigPath = process.env.PI_LENS_CONFIG_PATH;
	const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;
	// The harness points PI_LENS_CONFIG_PATH at a missing file
	// (tests/support/vitest-setup.ts); this column's global config replaces it.
	process.env.PI_LENS_CONFIG_PATH = fx.configPath;
	// Never fetch a real vscode-json-language-server for the missing primary.
	process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
	try {
		const config = await import("../../clients/lsp/config.js");
		await config.initLSPConfig(fx.workspace);
		const { default: extension } = await import("../../index.js");
		const { getLatencyReports, clearLatencyReports } =
			await import("../../clients/dispatch/dispatcher.js");
		const { _awaitDeferredLspPullForTest } =
			await import("../../clients/actionable-warnings.js");
		const pi = createPiMock({
			...column.piFlags,
			"lens-actionable-warnings": true,
			"lens-actionable-warning-actions": true,
		});
		extension(pi.asExtensionAPI());
		// The host's own trust decision, which session_start latches: the
		// command overrides are project config (#4248).
		const ctx = makeCtx({
			cwd: fx.workspace,
			sessionId: `matrix-4403-${column.id}`,
			isProjectTrusted: true,
		});
		await pi.emit("session_start", makeSessionStartEvent(), ctx);
		await pi.emit("turn_start", {}, ctx);

		/** A fresh service, so the marker lines `work` adds are its starts. */
		const cell = async (
			route: RouteId,
			work: () => Promise<{ verdict: string; lines: string[] }>,
		): Promise<void> => {
			resetLSPService();
			getLSPService();
			clearWorkspaceDiagnosticsCache(fx.workspace);
			const from = markerLines(fx.marker).length;
			const { verdict, lines } = await work();
			observed[route] = {
				started: [...new Set(markerLines(fx.marker).slice(from))].sort(),
				verdict,
				lines,
			};
		};
		const lens = pi.tools.get("lens_diagnostics") as ToolLike;
		const nav = pi.tools.get("lsp_navigation") as ToolLike;
		const lspCheck = (params: Record<string, unknown>) =>
			lens.execute(
				"matrix-4403",
				{ source: "lsp", waitMs: 3000, ...params },
				undefined,
				null,
				{ cwd: fx.workspace },
			);

		await cell("write-time dispatch", async () => {
			clearLatencyReports();
			const written: string[] = [];
			const write = async (relative: string, n: number): Promise<string> => {
				const target = fx.file(relative, n);
				written.push(target);
				const result = (await pi.emit(
					"tool_result",
					{
						toolName: "write",
						input: { path: target, content: fs.readFileSync(target, "utf8") },
						content: [{ type: "text", text: "wrote" }],
					},
					ctx,
				)) as { content?: Array<{ text?: string }> } | undefined;
				return writeOutcome(
					(result?.content ?? []).map((part) => part.text ?? "").join("\n"),
					fx.workspace,
				);
			};
			const outcomes = [
				await write("write", 1),
				await write("write", 2),
				await write("write-2", 3),
			];
			// The runner row agrees with what the agent was shown. Judge only the
			// reports these writes produced: another dispatch of the same file can
			// land inside this window under load and plan no `lsp` runner at all,
			// which #4634 captured as `runner rows skipped,,skipped,skipped` at
			// load 74. #4634's review (F1) could not prove that filter through
			// `scripts/mutate.mjs`, which blanks the `"lsp"` literal before it
			// searches, so this case drives the off-plan dispatch itself: with the
			// runner flag set, dispatch planning drops every `lsp` runner
			// (`withPrimaryPolicyGroup`), the write still produces a latency report
			// with no `lsp` row, and the filter is what keeps that missing row from
			// standing in for one of the three writes above.
			pi.setFlag("no-lsp", true);
			try {
				await write("write", 4);
			} finally {
				pi.setFlag("no-lsp", false);
			}
			const rows = getLatencyReports()
				.filter(
					(report) =>
						written.includes(report.filePath) &&
						report.runners.some((runner) => runner.runnerId === "lsp"),
				)
				.map(
					(report) =>
						report.runners.find((runner) => runner.runnerId === "lsp")?.status,
				);
			const verdict = writeTimeVerdict(outcomes);
			const rowsAgree =
				rows.length >= outcomes.length &&
				rows.every((status) =>
					verdict === "clean" ? status === "succeeded" : status === "skipped",
				);
			return {
				verdict: rowsAgree ? verdict : `runner rows ${rows.join(",")}`,
				lines: outcomes,
			};
		});
		const fileCell = async (
			params: Record<string, unknown>,
		): Promise<{ verdict: string; lines: string[] }> => {
			const result = await lspCheck(params);
			const text = String(result.content[0]?.text);
			return {
				verdict: fileModeVerdict(text),
				lines: shownLines(text, fx.workspace).slice(0, 2),
			};
		};
		await cell("lsp_diagnostics file", () =>
			fileCell({ path: fx.file("file") }),
		);
		await cell("lsp_diagnostics batch", async () => {
			const result = await lspCheck({
				paths: [fx.file("batch-a"), fx.file("batch-b")],
			});
			return {
				verdict: batchVerdict(result.details),
				lines: batchLines(String(result.content[0]?.text), fx.workspace),
			};
		});
		await cell("lsp_diagnostics directory", async () => {
			fx.file("dir/inner");
			const result = await lspCheck({ path: path.join(fx.workspace, "dir") });
			return {
				verdict: batchVerdict(result.details),
				lines: directoryLines(String(result.content[0]?.text), fx.workspace),
			};
		});
		await cell("lsp_diagnostics primary-only", () =>
			fileCell({ path: fx.file("primary"), serverScope: "primary" }),
		);
		await cell("lsp_navigation workspaceDiagnostics", async () => {
			const result = await nav.execute(
				"matrix-4403-nav",
				{ operation: "workspaceDiagnostics", path: fx.file("nav") },
				new AbortController().signal,
				null,
				ctx,
			);
			const text = String(result.content[0]?.text);
			return { verdict: navigationVerdict(text), lines: navigationLines(text) };
		});
		await cell("lens_diagnostics mode=full", async () => {
			const result = await lens.execute(
				"matrix-4403-full",
				{ mode: "full", paths: [fx.file("sweep")] },
				undefined,
				null,
				{ cwd: fx.workspace },
			);
			return {
				verdict: sweepVerdict(result.details),
				lines: sweepLines(String(result.content[0]?.text), fx.workspace),
			};
		});
		// The turn's edit runs its own dispatch first; the cell starts after it,
		// with a fresh service, so turn_end's cold read is the only reader left.
		const edited = fx.file("turn");
		await pi.emit(
			"tool_result",
			{
				toolName: "edit",
				input: { path: edited },
				details: { diff: "+  1 changed();" },
				content: [{ type: "text", text: "changed" }],
			},
			ctx,
		);
		await cell("turn-end actionable warnings", async () => {
			const before = pi.sentMessages.length;
			await pi.emit("turn_end", {}, ctx);
			await _awaitDeferredLspPullForTest();
			return {
				verdict: "none",
				lines: pi.sentMessages
					.slice(before)
					.map((message) => JSON.stringify(message.content)),
			};
		});
		await pi.emit("session_shutdown", { reason: "quit" }, ctx);
		await getLSPService().shutdown();
		resetLSPService();

		observed["MCP pilens_diagnostics"] = NOT_APPLICABLE.some(
			(na) => na.route === "MCP pilens_diagnostics" && na.column === column.id,
		)
			? { started: "n/a", verdict: "n/a", lines: "n/a" }
			: await runMcpCell(fx);
	} finally {
		if (savedConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
		else process.env.PI_LENS_CONFIG_PATH = savedConfigPath;
		if (savedInstall === undefined)
			delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
		else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
	}
	return observed;
}

/** `pilens_diagnostics source=lsp` through the real MCP server process. */
async function runMcpCell(fx: Fixture): Promise<Cell> {
	const from = markerLines(fx.marker).length;
	const probe = fx.file("mcp");
	const harness = new McpHarness({
		cwd: fx.workspace,
		env: {
			PI_LENS_CONFIG_PATH: fx.configPath,
			PI_LENS_DISABLE_LSP_INSTALL: "1",
			PI_LENS_DISABLE_TOOL_INSTALL: "1",
		},
	});
	try {
		await harness.request(1, "initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "matrix-4403", version: "0" },
		});
		harness.notify("notifications/initialized");
		const response = await harness.request(
			2,
			"tools/call",
			{
				name: "pilens_diagnostics",
				arguments: {
					source: "lsp",
					path: probe,
					serverScope: "all",
					waitMs: 3000,
				},
			},
			scaledTestTimeout(60_000),
		);
		const result = response.result as { content: Array<{ text: string }> };
		const text = result.content[0]?.text ?? "";
		return {
			started: [...new Set(markerLines(fx.marker).slice(from))].sort(),
			verdict: fileModeVerdict(text),
			lines: shownLines(text, fx.workspace).slice(0, 2),
		};
	} finally {
		harness.dispose();
	}
}

// ── Route derivation ────────────────────────────────────────────────────────

/**
 * The `LSPService` members a route enters the diagnostics pipeline through:
 * each one starts a server or returns diagnostics rows. A case below checks
 * every name is still a method of the service, so a rename cannot leave the
 * scan looking for a name nothing calls.
 */
const DIAGNOSTICS_ENTRY_MEMBERS = [
	"getAllDiagnostics",
	"getAuxiliaryClientsForFile",
	"getClientsForFile",
	"getDiagnostics",
	"getLastKnownDiagnostics",
	"readCachedDiagnosticsForServers",
	"runWorkspaceDiagnostics",
	"touchFile",
] as const;

/**
 * #4403 round 4 (N5): every other public `LSPService` method, by why it is
 * not a diagnostics entry. The scan above reads only the entry members, so a
 * new public method that returns diagnostics would be invisible to it; the
 * pin below reds on any method not placed here or there.
 */
const NAVIGATION =
	"a navigation or edit request: it returns locations, symbols, text or edits, never diagnostics or a verdict";
const SYNC =
	"document sync: it sends text or file events to servers and returns no diagnostics";
const STATUS =
	"a status read: it returns readiness, capability or health facts, never diagnostics rows";
const NON_ENTRY_MEMBERS: Record<string, string> = {
	constructor: "builds the service",
	shutdown: "stops every server",
	restartPrimaryClientsUnder:
		"stops the primary servers under a root after a dependency install; the next touch spawns fresh ones, and it returns a count, never diagnostics",
	checkDestroyed: STATUS,
	getOpenDocumentPaths: STATUS,
	getTrackedContent: STATUS,
	getClientForFile:
		"returns one primary client; a diagnostics read on it is a member access the scan reads as its own site",
	getWarmClientForFile:
		"returns an already-running client without starting one; a diagnostics read on it is its own site",
	hasServerPublishedForFileRoot: STATUS,
	observeLateAuxiliaryAnswer:
		"records how late an auxiliary answered; it returns nothing",
	notifyExternalFileChange: SYNC,
	notifyOutOfBandFileChanges: SYNC,
	announceCreatedFiles: SYNC,
	resyncGitChangedFiles: SYNC,
	resyncHeldPrimaries: SYNC,
	sweepDocumentDrift: SYNC,
	_driftTrackedCountForTests: STATUS,
	openFile: SYNC,
	updateFile: SYNC,
	getDiagnosticsHealth:
		"returns the health record a diagnostics read left, not rows; the routes that read it are pinned by the matrix",
	definition: NAVIGATION,
	typeDefinition: NAVIGATION,
	declaration: NAVIGATION,
	references: NAVIGATION,
	hover: NAVIGATION,
	signatureHelp: NAVIGATION,
	documentSymbol: NAVIGATION,
	workspaceSymbol: NAVIGATION,
	getAdvertisedCommands: STATUS,
	executeCommand: NAVIGATION,
	executeReadOnlyCommandOnLiveClient: NAVIGATION,
	getOperationSupport: STATUS,
	getCapabilitySnapshots: STATUS,
	getWorkspaceDiagnosticsSupport: STATUS,
	codeAction: NAVIGATION,
	rename: NAVIGATION,
	renameFile: NAVIGATION,
	implementation: NAVIGATION,
	prepareCallHierarchy: NAVIGATION,
	incomingCalls: NAVIGATION,
	outgoingCalls: NAVIGATION,
	ensureWarmForSweep:
		"warms the server a `runWorkspaceDiagnostics` group gates on; only that entry member calls it",
	supportsLSP: STATUS,
	describeTouchCandidates: STATUS,
	hasWarmLSP: STATUS,
	hasLSP: STATUS,
	isSpawnInFlight: STATUS,
	getStatus: STATUS,
	getBrokenStatus: STATUS,
	getAliveClientCount: STATUS,
	getAliveServerIds: STATUS,
};

/**
 * The public methods of `LSPService`, read from its class body with comments
 * and strings blanked: a one-tab-indented method head or function-valued
 * field that is not `private` or `protected` (neither word can be the name
 * the head pattern captures). Round 5 (V4): `public m()`, `async *m()`,
 * `m = async () => …` and `m = (x) => …` are methods the pin must see. The
 * napi TypeScript grammar is no help here: it fails on this file's
 * `import("…")` types and folds later members into error nodes.
 */
function lspServicePublicMethods(): string[] {
	const source = stripSource(
		fs.readFileSync(path.join(repoRoot, "clients", "lsp", "index.ts"), "utf8"),
	);
	const start = source.search(/^export class LSPService\b/m);
	const end = source.indexOf("\n}", start);
	const head =
		/^\t(?:public\s+)?(?:static\s+)?(?:readonly\s+)?(?:async\s+)?(?:\*\s*)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*(?:[<(]|=\s*(?:async\s+)?(?:[<(]|function\b|[A-Za-z_$][\w$]*\s*=>))/gm;
	return [
		...new Set(
			[...source.slice(start, end).matchAll(head)].map(
				(match) => match[1] as string,
			),
		),
	].sort();
}

type SiteEntry = { routes: readonly RouteId[] } | { exempt: string };

/**
 * `getLSPService()` hands out a proxy that binds each service method by name
 * (`bindGroup` in clients/lsp/capabilities.ts). The names in its lists are
 * not reads: every caller goes through the facade with a member expression,
 * and each of those is a site the scan reads.
 */
const CAPABILITY_FACADE_BINDING =
	"the capability facade binds the method by name; each call through the facade is a member access the scan reads as its own site";

const LSP_DIAGNOSTICS_TOOL_ROUTES: readonly RouteId[] = [
	"lsp_diagnostics file",
	"lsp_diagnostics batch",
	"lsp_diagnostics directory",
	"lsp_diagnostics primary-only",
	"MCP pilens_diagnostics",
];

/**
 * Every derived site: the matrix routes that reach it, or why none does. The
 * key is `<file>#<enclosing declaration>:<member>` plus the site's
 * `clientScope` and `diagnostics` options as written.
 */
const SITE_REGISTRY: Record<string, SiteEntry> = {
	"clients/actionable-warnings.ts#buildActionableWarningsReport:getLastKnownDiagnostics":
		{
			exempt:
				"the in-band read of a file the turn already primed: it starts no server and returns the store an earlier touch filled; pinned by tests/tools/lsp-diagnostics-opengrep-disabled-4323.test.ts 'does not start Opengrep for a cold file read after a primed one'",
		},
	"clients/actionable-warnings.ts#enrichFileFromLsp:getDiagnostics": {
		routes: ["turn-end actionable warnings"],
	},
	"clients/dispatch/integration.ts#computeCascadeForFile:getAllDiagnostics": {
		exempt:
			"the cascade's snapshot of running clients' rows for import neighbours of a written file; it starts no server",
	},
	// #4485: the silent-push wait's read of what the touched client published
	// for the neighbour after the touch.
	"clients/dispatch/integration.ts#computeCascadeForFile:getDiagnostics": {
		exempt:
			"an LSPClient's own per-file read on the client the cascade just touched (spawned.client), not the service: it starts nothing",
	},
	'clients/dispatch/integration.ts#computeCascadeForFile:touchFile{clientScope: "primary", diagnostics: "document"}':
		{
			exempt:
				"a cascade neighbour's primary-only re-check: its scope cannot select an auxiliary",
		},
	'clients/dispatch/integration.ts#computeCascadeForFile:touchFile{clientScope: "primary", diagnostics: "none"}':
		{
			exempt:
				"a cascade neighbour's primary-only sync with no diagnostics: no auxiliary, no verdict",
		},
	'clients/dispatch/runners/lsp.ts#lspRunner:touchFile{clientScope: auxiliaryServerIds.length > 0 ? "with-auxiliary" : "primary", diagnostics: "document"}':
		{ routes: ["write-time dispatch"] },
	'clients/lsp/capabilities.ts#adaptLspService:"touchFile"': {
		exempt: CAPABILITY_FACADE_BINDING,
	},
	'clients/lsp/capabilities.ts#adaptLspService:"getAllDiagnostics"': {
		exempt: CAPABILITY_FACADE_BINDING,
	},
	'clients/lsp/capabilities.ts#adaptLspService:"getDiagnostics"': {
		exempt: CAPABILITY_FACADE_BINDING,
	},
	'clients/lsp/capabilities.ts#adaptLspService:"getLastKnownDiagnostics"': {
		exempt: CAPABILITY_FACADE_BINDING,
	},
	'clients/lsp/capabilities.ts#adaptLspService:"readCachedDiagnosticsForServers"':
		{
			exempt: CAPABILITY_FACADE_BINDING,
		},
	'clients/lsp/capabilities.ts#adaptLspService:"runWorkspaceDiagnostics"': {
		exempt: CAPABILITY_FACADE_BINDING,
	},
	// #4485: the expiry read of an outstanding touch's own client, held by a
	// WeakRef, so a dead client is never revived.
	"clients/lsp/cascade-tier.ts#readTouchedClient:getAllDiagnostics": {
		exempt:
			"an LSPClient's own getAllDiagnostics on the client the touch was sent to, read through a WeakRef at expiry: it starts nothing",
	},
	"clients/lsp/cascade-tier.ts#reconcileOutstandingCascadeTouches:getAllDiagnostics":
		{
			exempt:
				"an LSPClient's own getAllDiagnostics on a warm client (spawned.client), not the service: it starts nothing",
		},
	'clients/mcp/analyze.ts#warmLspForFile:touchFile{clientScope: "primary", diagnostics: "document"}':
		{
			exempt:
				"pilens_analyze's primary-only warm-up; its result is discarded and the dispatch runner (the write-time route's site) gives the verdict",
		},
	'clients/persistent-reverify.ts#runPersistentReverify:touchFile{clientScope: "primary", diagnostics: "document"}':
		{
			exempt:
				"the turn-end re-check of persistent warnings is primary-only: its scope cannot select an auxiliary",
		},
	"clients/pipeline.ts#resyncLspFile:getAuxiliaryClientsForFile": {
		routes: ["write-time dispatch"],
	},
	'clients/pipeline.ts#resyncLspFile:touchFile{clientScope: "primary", diagnostics: "none"}':
		{ routes: ["write-time dispatch"] },
	"clients/runtime-turn.ts#handleTurnEnd:readCachedDiagnosticsForServers": {
		exempt:
			"turn-end late coverage reads cached rows of the server ids the dispatch already named; it starts no server",
	},
	'clients/runtime-session.ts#igniteDominantLanguageWarm:touchFile{clientScope: "primary", diagnostics: "none"}':
		{
			exempt:
				"session_start's primary-only warm-up with no diagnostics: no auxiliary, no verdict",
		},
	'clients/runtime-session.ts#igniteWarmFiles:touchFile{clientScope: "primary", diagnostics: "none"}':
		{
			exempt:
				"session_start's configured warm files, primary-only with no diagnostics: no auxiliary, no verdict",
		},
	'clients/runtime-tool-call.ts#handleToolCallImpl:touchFile{clientScope: "primary", diagnostics: "none"}':
		{
			exempt:
				"the pre-tool warm touch, primary-only with no diagnostics: no auxiliary, no verdict",
		},
	'clients/warm-attach.ts#serveRequest:touchFile{clientScope: "with-auxiliary", diagnostics: "document"}':
		{
			exempt:
				"the warm-attach incumbent serves another process's dispatch runner; with-auxiliary with no auxiliaryServerIds acquires no auxiliary (touchFile reads `auxiliaryServerIds ?? []`)",
		},
	"tools/lens-diagnostics.ts#formatFullMode:runWorkspaceDiagnostics": {
		routes: ["lens_diagnostics mode=full"],
	},
	"tools/lsp-diagnostics.ts#collectDiagnosticsForFile:getDiagnostics": {
		routes: LSP_DIAGNOSTICS_TOOL_ROUTES,
	},
	'tools/lsp-diagnostics.ts#collectDiagnosticsForFile:touchFile{clientScope: serverScope, diagnostics: "document"}':
		{ routes: LSP_DIAGNOSTICS_TOOL_ROUTES },
	"tools/lsp-navigation.ts#createLspNavigationTool:getAllDiagnostics": {
		exempt:
			"the path-less workspaceDiagnostics snapshot starts no server and claims no verdict; a switched-off server's rows are pinned out by tests/tools/lsp-diagnostics-opengrep-disabled-4323.test.ts 'leaves a running Opengrep's rows out of the path-less lsp_navigation snapshot'",
	},
	"tools/lsp-navigation.ts#createLspNavigationTool:getDiagnostics": {
		routes: ["lsp_navigation workspaceDiagnostics"],
	},
	'tools/lsp-navigation.ts#openFileBestEffort:touchFile{clientScope: waitForDiagnostics ? "all" : "primary", diagnostics: waitForDiagnostics ? "document" : "none"}':
		{ routes: ["lsp_navigation workspaceDiagnostics"] },
};

interface SourceFile {
	rel: string;
	source: string;
}

/** The production trees a route can live in; the service itself is excluded. */
function productionSources(): SourceFile[] {
	const files = [
		...["clients", "tools", "mcp"].flatMap((dir) =>
			listSourceFiles(path.join(repoRoot, dir)),
		),
		path.join(repoRoot, "index.ts"),
	];
	return files
		.map((file) => ({
			rel: relativePosix(repoRoot, file),
			source: fs.readFileSync(file, "utf8"),
		}))
		.filter((file) => file.rel !== "clients/lsp/index.ts");
}

/** `clientScope` and `diagnostics` as written in a call's last object argument. */
function selectorSuffix(call: SgNode | undefined): string {
	const options = call
		?.field("arguments")
		?.namedChildren()
		.filter((arg) => arg.kind() === "object")
		.at(-1);
	if (!options) return "";
	const parts: string[] = [];
	for (const pair of options.namedChildren()) {
		if (pair.kind() !== "pair") continue;
		const key = pair.field("key")?.text();
		if (key !== "clientScope" && key !== "diagnostics") continue;
		parts.push(`${key}: ${pair.field("value")?.text().replace(/\s+/g, " ")}`);
	}
	return parts.length > 0 ? `{${parts.sort().join(", ")}}` : "";
}

/**
 * Node kinds whose member-named leaf DEFINES a member (an interface's method
 * or property, a class's or object's method), never a read of the service's.
 * Only kinds production uses: any other, such as an object literal key, reds
 * as unclassified until it is exempted.
 */
const DEFINITION_PARENTS = new Set([
	"method_signature",
	"method_definition",
	"property_signature",
]);

/**
 * Every access to a diagnostics entry member in `files`, failing closed.
 *
 * A leaf whose text is exactly a member name is one of:
 *  - a site: a member expression (`svc.touchFile(...)`, `svc?.getDiagnostics`,
 *    `const run = svc.runWorkspaceDiagnostics`), a destructured name, renamed
 *    (`{ touchFile: t } = svc`, also in a parameter) or not, or a literal
 *    subscript (`svc["touchFile"]`);
 *  - ignored: a definition (see {@link DEFINITION_PARENTS}), a class's own
 *    `this.<name>` (its own method; the service's file is excluded), a string
 *    in a type (`Pick<S, "touchFile">`), or a local alias of a site in the same
 *    declaration (`run(...)` after `const run = svc.run...`);
 *  - unclassified: anything else, such as `Reflect.get(svc, "touchFile")`, a
 *    name kept in a variable for a computed key, or a string list. It is
 *    recorded as `<file>#<declaration>:"<member>"`, so it reds until it is
 *    exempted with a reason (#4403 F3).
 *
 * Parsed from the AST, so a comment, or a string that is not exactly a
 * member name, is never an access. Out of reach: a name built at run time
 * (`"touch" + "File"`) and a new caller of an existing route's helper; the
 * matrix drives the helpers, not their callers.
 */
function deriveSites(
	files: readonly SourceFile[],
): Array<{ key: string; detail: string }> {
	const members = new Set<string>(DIAGNOSTICS_ENTRY_MEMBERS);
	const sites: Array<{ key: string; detail: string }> = [];
	for (const file of files) {
		if (!DIAGNOSTICS_ENTRY_MEMBERS.some((name) => file.source.includes(name)))
			continue;
		const lines = file.source.split("\n");
		const ownerOf = (node: SgNode) =>
			findEnclosingSymbol(lines, node.range().start.line) ?? "(top level)";
		const record = (node: SgNode, member: string, suffix = "") => {
			sites.push({
				key: `${file.rel}#${ownerOf(node)}:${member}${suffix}`,
				detail: `${file.rel}:${node.range().start.line + 1}`,
			});
		};
		const unclassified = (node: SgNode, member: string) =>
			record(node, `"${member}"`);
		// `<declaration>:<name>` for each local bound to a site's member.
		const aliases = new Set<string>();
		const leaves: SgNode[] = [];
		const collect = (node: SgNode): void => {
			const children = node.children();
			if (children.length === 0) {
				if (members.has(node.text())) leaves.push(node);
				return;
			}
			if (node.kind() === "variable_declarator") {
				const name = node.field("name");
				const value = node.field("value");
				if (
					name?.kind() === "identifier" &&
					value?.kind() === "member_expression" &&
					value.field("object")?.kind() !== "this" &&
					value.field("property")?.text() === name.text()
				)
					aliases.add(`${ownerOf(node)}:${name.text()}`);
			}
			if (node.kind() === "shorthand_property_identifier_pattern")
				aliases.add(`${ownerOf(node)}:${node.text()}`);
			for (const child of children) collect(child);
		};
		collect(parse(Lang.TypeScript, file.source).root());
		for (const leaf of leaves) {
			const member = leaf.text();
			const parent = leaf.parent();
			const parentKind = String(parent?.kind() ?? "");
			switch (leaf.kind()) {
				case "property_identifier": {
					if (parentKind === "member_expression") {
						if (parent?.field("object")?.kind() === "this") break;
						const call = parent?.parent();
						const isCallee =
							call?.kind() === "call_expression" &&
							call.field("function")?.range().start.index ===
								parent?.range().start.index;
						record(leaf, member, isCallee ? selectorSuffix(call) : "");
					} else if (
						parentKind === "pair_pattern" &&
						parent?.field("key")?.range().start.index ===
							leaf.range().start.index
					) {
						record(leaf, member);
					} else if (!DEFINITION_PARENTS.has(parentKind)) {
						unclassified(leaf, member);
					}
					break;
				}
				case "shorthand_property_identifier_pattern":
					record(leaf, member);
					break;
				case "identifier":
				case "shorthand_property_identifier":
					if (!aliases.has(`${ownerOf(leaf)}:${member}`))
						unclassified(leaf, member);
					break;
				case "string_fragment": {
					const literal = parent;
					const holder = literal?.parent();
					if (literal?.kind() === "string" && holder?.kind() === "literal_type")
						break;
					if (
						literal?.kind() === "string" &&
						holder?.kind() === "subscript_expression" &&
						holder.field("index")?.range().start.index ===
							literal.range().start.index &&
						holder.field("object")?.kind() !== "this"
					) {
						record(leaf, member);
						break;
					}
					unclassified(leaf, member);
					break;
				}
				default:
					unclassified(leaf, member);
			}
		}
	}
	return sites;
}

/** Every problem with the derived sites against the registry and the matrix. */
function auditRoutes(
	scannedCount: number,
	sites: ReadonlyArray<{ key: string; detail: string }>,
	registry: Record<string, SiteEntry>,
	routes: readonly string[],
): string[] {
	const registered: string[] = [];
	const exemptions: Record<string, string> = {};
	for (const [key, entry] of Object.entries(registry)) {
		if ("routes" in entry) registered.push(key);
		else exemptions[key] = entry.exempt;
	}
	const problems = [
		...auditRegistry({
			sweepName: "diagnostics route derivation (#4403)",
			flagged: sites,
			registered,
			exemptions,
			minFlagged: 10,
			// 518 production files on 2026-10-14; a walk under half is blind.
			scannedCount,
			minScanned: 250,
			remediation:
				"A new read of an LSPService diagnostics member is a diagnostics route. Add it to ROUTES and drive it through the matrix, or exempt its key with the reason it cannot start a switched-off server or give a verdict.",
		}).problems,
	];
	// auditRegistry tolerates a registered key the scan no longer finds; a
	// route mapping is a claim about a live site, so a gone site is stale.
	const flagged = new Set(sites.map((site) => site.key));
	const stale = registered.filter((key) => !flagged.has(key));
	if (stale.length > 0) {
		problems.push(
			`registry routes name a site the scan no longer finds:\n${stale.map((key) => `  ${key}`).join("\n")}`,
		);
	}
	const named = new Set<string>();
	for (const [key, entry] of Object.entries(registry)) {
		if (!("routes" in entry)) continue;
		if (entry.routes.length === 0) problems.push(`${key}: names no route`);
		for (const route of entry.routes) {
			named.add(route);
			if (!routes.includes(route))
				problems.push(
					`${key}: names "${route}", which the matrix does not drive`,
				);
		}
	}
	for (const route of routes) {
		if (!named.has(route))
			problems.push(`matrix route "${route}" has no derived site`);
	}
	return problems;
}

describe("diagnostics routes are derived from code (#4403)", () => {
	it(
		"maps every LSPService diagnostics read to a matrix route or a reasoned exemption",
		() => {
			const sources = productionSources();
			const problems = auditRoutes(
				sources.length,
				deriveSites(sources),
				SITE_REGISTRY,
				ROUTES,
			);

			expect(problems).toEqual([]);
		},
		scaledTestTimeout(60_000),
	);

	it(
		"reds a new route the matrix does not drive, and never reads one from a comment or a string",
		() => {
			// The fixture route: one real read, and two members named only in a
			// comment and a string (#4403: prose must not add or satisfy a site).
			const fixture: SourceFile = {
				rel: "tools/fixture-new-route.ts",
				source: [
					"export async function newRoute(svc: any, file: string) {",
					"\t// svc.touchFile(file, '', {}) is only prose here",
					"\tconst note = 'svc.getAllDiagnostics()';",
					"\treturn [note, await svc.getDiagnostics(file)];",
					"}",
					"",
				].join("\n"),
			};

			const sites = deriveSites([fixture]);
			const sources = productionSources();
			const problems = auditRoutes(
				sources.length,
				[...deriveSites(sources), ...sites],
				SITE_REGISTRY,
				ROUTES,
			);

			expect(sites.map((site) => site.key)).toEqual([
				"tools/fixture-new-route.ts#newRoute:getDiagnostics",
			]);
			expect(problems.join("\n")).toContain(
				"tools/fixture-new-route.ts#newRoute:getDiagnostics (tools/fixture-new-route.ts:4)",
			);
		},
		scaledTestTimeout(60_000),
	);

	it(
		"fails closed on a spelling it cannot read as a site (#4403 F3)",
		() => {
			// The review's five spellings that each derived no site in round 2,
			// and a local of the same name that is not bound to a member access. A
			// renamed destructure and a literal subscript are sites; a name kept in
			// a variable, passed to Reflect, or bound to something else is
			// unclassified, as is any other node kind that carries the name (an
			// enum member, a type name). Either reds until it is mapped or exempted. A
			// definition and a type-level name do not.
			const spellings: Record<string, string> = {
				renamedDestructure:
					"export function r(svc: any, f: string) {\n\tconst { touchFile: t } = svc;\n\treturn t(f, '', {});\n}\n",
				paramDestructureRenamed:
					"export function r(\n\t{ getDiagnostics: g }: any,\n\tf: string,\n) {\n\treturn g(f);\n}\n",
				bracket:
					"export function r(svc: any, f: string) {\n\treturn svc['touchFile'](f, '', {});\n}\n",
				computedKey:
					"export function r(svc: any, f: string) {\n\tconst M = 'getDiagnostics';\n\treturn svc[M](f);\n}\n",
				reflect:
					"export function r(svc: any, f: string) {\n\treturn Reflect.get(svc, 'getDiagnostics').call(svc, f);\n}\n",
				enumMember: "export enum E {\n\ttouchFile = 1,\n}\n",
				typeNamed: "export type getDiagnostics = (f: string) => void;\n",
				aliasFromCall:
					"export function r(svc: any, f: string) {\n\tconst getDiagnostics = pick(svc);\n\treturn getDiagnostics(f);\n}\n",
				definitionsOnly:
					"interface S { touchFile(f: string): void }\nexport function r(): Pick<S, 'touchFile'> {\n\treturn { touchFile() {} };\n}\n",
			};
			const derived = Object.fromEntries(
				Object.entries(spellings).map(([name, source]) => [
					name,
					deriveSites([{ rel: `tools/${name}.ts`, source }]).map(
						(site) => site.key,
					),
				]),
			);

			expect(derived).toEqual({
				renamedDestructure: ["tools/renamedDestructure.ts#r:touchFile"],
				paramDestructureRenamed: [
					"tools/paramDestructureRenamed.ts#r:getDiagnostics",
				],
				bracket: ["tools/bracket.ts#r:touchFile"],
				computedKey: ['tools/computedKey.ts#r:"getDiagnostics"'],
				reflect: ['tools/reflect.ts#r:"getDiagnostics"'],
				enumMember: ['tools/enumMember.ts#(top level):"touchFile"'],
				typeNamed: ['tools/typeNamed.ts#(top level):"getDiagnostics"'],
				aliasFromCall: [
					'tools/aliasFromCall.ts#r:"getDiagnostics"',
					'tools/aliasFromCall.ts#r:"getDiagnostics"',
				],
				definitionsOnly: [],
			});
		},
		scaledTestTimeout(60_000),
	);

	// Also the rename guard: an entry member that is no longer a method fails
	// the equality, so the scan cannot keep looking for a name nothing calls.
	it(
		"places every public LSPService method as a diagnostics entry or not (#4403 N5)",
		() => {
			expect(lspServicePublicMethods()).toEqual(
				[
					...DIAGNOSTICS_ENTRY_MEMBERS,
					...Object.keys(NON_ENTRY_MEMBERS),
				].sort(),
			);
		},
		scaledTestTimeout(60_000),
	);

	it(
		"keeps the MCP --no-opengrep cell inapplicable only while the flag has no environment spelling",
		() => {
			// createMcpHost resolves env, then config; a CLI-only flag cannot reach it.
			expect(getLensFlagSpec("no-opengrep")?.env).toBeUndefined();
		},
		scaledTestTimeout(10_000),
	);
});

// #4403: the matrix's disabled and missing columns each have one cause. A file
// whose primaries mix the two must not be told only one of them, and the cause
// comes from the read's own record, never from a second look at config.
describe("the primary-unavailable note's cause (#4403)", () => {
	it(
		"names a disabled primary, an unstarted one, and both when they mix",
		async () => {
			const { describePrimaryUnavailable } =
				await import("../../tools/lsp-diagnostics.js");
			const note = (ids: string[], disabled: string[]) =>
				describePrimaryUnavailable(undefined, {
					unavailablePrimaryServerIds: ids,
					disabledPrimaryServerIds: disabled,
				})?.text ?? "";

			expect(note(["json"], ["json"])).toContain(
				"(it is disabled in config by lsp.disabledServers)",
			);
			expect(note(["yaml"], [])).toContain(
				"(it could not be started, or was still starting)",
			);
			expect(note(["json", "yaml"], ["json"])).toContain(
				"(it could not be started, was still starting, or is disabled in config by lsp.disabledServers)",
			);
		},
		scaledTestTimeout(10_000),
	);

	// #4403 F7: review r1 read the raw `server.root` detectors, found rust
	// rootless outside a crate, and asked that a disabled primary be named only
	// where it would root. The service's own root rule has a marker fallback
	// (#3750), so an enabled rust IS tried for a `.rs` file outside any crate,
	// and named when it does not answer. A disabled one is named exactly there.
	it(
		"names a disabled primary exactly where an enabled one that cannot start is named",
		async () => {
			const trust = await import("../../clients/project-trust.js");
			const config = await import("../../clients/lsp/config.js");
			const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;
			process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
			trust.setProjectTrustState("trusted");
			const unanswered = async (rust: "missing" | "disabled") => {
				const env = setupTestEnvironment(PREFIX);
				const workspace = fs.realpathSync(env.tmpDir);
				fs.writeFileSync(path.join(workspace, "package.json"), "{}\n");
				fs.mkdirSync(path.join(workspace, ".pi-lens"));
				fs.writeFileSync(
					path.join(workspace, ".pi-lens", "lsp.json"),
					JSON.stringify(
						rust === "disabled"
							? { disabledServers: ["rust"] }
							: {
									serverOverrides: {
										rust: {
											command: [
												path.join(workspace, "missing", "rust-analyzer"),
											],
										},
									},
								},
					),
				);
				// Outside any crate: no Cargo.toml anywhere above it.
				const loose = path.join(workspace, "loose", "main.rs");
				fs.mkdirSync(path.dirname(loose), { recursive: true });
				fs.writeFileSync(loose, "fn main() {}\n");
				config.resetLSPConfigStateForTests();
				await config.initLSPConfig(workspace);
				resetLSPService();
				const service = getLSPService();
				await service.getDiagnostics(loose);
				const health = service.getDiagnosticsHealth(loose);
				await service.shutdown();
				return {
					named: health?.unavailablePrimaryServerIds ?? [],
					disabled: health?.disabledPrimaryServerIds ?? [],
				};
			};
			try {
				expect(await unanswered("missing")).toEqual({
					named: ["rust"],
					disabled: [],
				});
				expect(await unanswered("disabled")).toEqual({
					named: ["rust"],
					disabled: ["rust"],
				});
			} finally {
				resetLSPService();
				trust.resetProjectTrust();
				config.resetLSPConfigStateForTests();
				if (savedInstall === undefined)
					delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
				else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
			}
		},
		scaledTestTimeout(120_000),
	);
});

// #4403 F5: the reader scored `ok:false, status:no_server` clean, so the
// navigation cell of a primary disabled with no auxiliary read as agreeing.
describe("the navigation reader (#4403)", () => {
	it(
		"never scores an envelope that did not answer as clean",
		() => {
			const noServer = JSON.stringify({
				tool: "lsp_navigation",
				operation: "workspaceDiagnostics",
				ok: false,
				status: "no_server",
				resultCount: 0,
			});

			expect(navigationVerdict(`${noServer}\n\nresult error`)).toBe(
				"unconfirmed",
			);
		},
		scaledTestTimeout(10_000),
	);
});

// #4403 round 4 (N4): hover and documentSymbol gate on `supportsLSP` alone,
// which a disabled primary fails, so they told the reader to install a server
// the operator had turned off. They now give the cause the workspaceDiagnostics
// gate gives.
// Round 5 (V5): where `supportsLSP` holds but no client answers (a missing
// binary, an auxiliary serving the file, a disabled owner whose fallback is
// missing), they answered "No results", ok, as if the file had been read.
describe("navigation operations on a file no primary answers for (#4403 N4, V5)", () => {
	const NAV_DISABLED =
		"No LSP server available for a.json: Primary LSP (json) did not answer (it is disabled in config by lsp.disabledServers).";
	const NAV_UNSTARTED =
		"No LSP server available for a.json: no language server answered (it could not be started, or was still starting).";
	const NAV_FALLBACK =
		"No LSP server available for a.ts: Primary LSP (typescript) did not answer (it is disabled in config by lsp.disabledServers, and its fallback could not be started, or was still starting).";
	const noServer = (text: string): string[] =>
		["hover", "documentSymbol"].map(
			(operation) => `${operation} ok=false status=no_server: ${text}`,
		);

	const navOps = async (
		columnId: ColumnId,
		extra: "unserved" | "findSymbol" | undefined = undefined,
	): Promise<string[]> => {
		const column = COLUMNS.find((entry) => entry.id === columnId);
		if (!column) throw new Error(`no ${columnId} column`);
		const fx = makeFixture(column);
		const savedConfigPath = process.env.PI_LENS_CONFIG_PATH;
		const savedInstall = process.env.PI_LENS_DISABLE_LSP_INSTALL;
		process.env.PI_LENS_CONFIG_PATH = fx.configPath;
		process.env.PI_LENS_DISABLE_LSP_INSTALL = "1";
		const config = await import("../../clients/lsp/config.js");
		const { default: extension } = await import("../../index.js");
		const pi = createPiMock({});
		const ctx = makeCtx({
			cwd: fx.workspace,
			sessionId: `matrix-4403-nav-ops-${columnId}`,
			isProjectTrusted: true,
		});
		let started = false;
		try {
			await config.initLSPConfig(fx.workspace);
			extension(pi.asExtensionAPI());
			resetLSPService();
			getLSPService();
			await pi.emit("session_start", makeSessionStartEvent(), ctx);
			started = true;
			const nav = pi.tools.get("lsp_navigation") as ToolLike;
			const targets: Array<[string, string, Record<string, string>?]> = [
				["hover", fx.file("a")],
				["documentSymbol", fx.file("a")],
			];
			if (extra === "unserved") {
				const unserved = path.join(fx.workspace, "notes.unserved");
				fs.writeFileSync(unserved, "plain text\n");
				targets.push(["hover", unserved]);
			}
			// The fake answers every request it advertises; a name it has no
			// symbol for is an empty answer from a running server.
			if (extra === "findSymbol")
				targets.push(["findSymbol", fx.file("a"), { query: "noSuchName" }]);
			const lines: string[] = [];
			for (const [operation, target, params] of targets) {
				const result = await nav.execute(
					"matrix-4403-nav-op",
					{ operation, path: target, line: 1, character: 2, ...params },
					new AbortController().signal,
					null,
					ctx,
				);
				const envelope = navigationEnvelope(String(result.content[0]?.text));
				lines.push(
					`${operation} ok=${envelope.ok} status=${envelope.status}: ${envelope.notes?.join(" | ")}`,
				);
			}
			return lines;
		} finally {
			if (started) await pi.emit("session_shutdown", { reason: "quit" }, ctx);
			await getLSPService().shutdown();
			resetLSPService();
			if (savedConfigPath === undefined) delete process.env.PI_LENS_CONFIG_PATH;
			else process.env.PI_LENS_CONFIG_PATH = savedConfigPath;
			if (savedInstall === undefined)
				delete process.env.PI_LENS_DISABLE_LSP_INSTALL;
			else process.env.PI_LENS_DISABLE_LSP_INSTALL = savedInstall;
		}
	};

	it(
		"names a disabled primary, and keeps the install hint for a file no server serves",
		async () => {
			expect(await navOps("disabled, no aux", "unserved")).toEqual([
				...noServer(NAV_DISABLED),
				"hover ok=false status=no_server: No LSP server available for notes.unserved. Check that the language server is installed.",
			]);
		},
		scaledTestTimeout(120_000),
	);

	const CASES: ReadonlyArray<[ColumnId, string[]]> = [
		["disabled", noServer(NAV_DISABLED)],
		["disabled, fallback", noServer(NAV_FALLBACK)],
		["missing", noServer(NAV_UNSTARTED)],
		["missing, no aux", noServer(NAV_UNSTARTED)],
	];
	for (const [columnId, expected] of CASES) {
		it(
			`answers no_server with the cause, not "No results": ${columnId}`,
			async () => {
				expect(await navOps(columnId)).toEqual(expected);
			},
			scaledTestTimeout(120_000),
		);
	}

	// A running primary's answer, empty or not, is an answer.
	it(
		"keeps a running primary's answers, and its empty answer as No results",
		async () => {
			expect(await navOps("present", "findSymbol")).toEqual([
				"hover ok=true status=success: undefined",
				"documentSymbol ok=true status=success: undefined",
				"findSymbol ok=true status=empty: No results for findSymbol at a.json:1:2",
			]);
		},
		scaledTestTimeout(120_000),
	);
});

describe("every diagnostics route under every server-selecting switch (#4403)", () => {
	afterAll(async () => {
		await cleanupTestEnvironmentsDrained(PREFIX, {
			beforeDrain: async () => {
				await getLSPService().shutdown();
			},
		});
	});

	for (const column of COLUMNS) {
		it(
			`starts the same servers and gives the same verdict on every route: ${column.id}`,
			async () => {
				const observed = await runColumn(column);

				expect(observed).toEqual(expectedRow(column));
			},
			scaledTestTimeout(180_000),
		);
	}

	it(
		"declares inapplicable cells only for a real route and column",
		() => {
			const columns = new Set<string>(COLUMNS.map((column) => column.id));
			for (const row of NOT_APPLICABLE) {
				expect(ROUTES).toContain(row.route);
				expect(columns.has(row.column)).toBe(true);
			}
			for (const route of Object.keys(NO_VERDICT_SURFACE))
				expect(ROUTES).toContain(route);
		},
		scaledTestTimeout(10_000),
	);
});
