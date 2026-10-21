#!/usr/bin/env node
/**
 * scripts/gen-tla-model-costs.mjs (#4672)
 *
 *   gh run view <run-id> --log --job <shard-job-id> > shard-k.log   # one per shard
 *   node scripts/gen-tla-model-costs.mjs --source 39380005583 --source 39374847276 \
 *     --log shard-1.log --log shard-2.log --log shard-3.log --log shard-4.log \
 *     --out scripts/tla-model-costs.json
 *
 * Repeat `--log` once per file: the parser reads one value per flag, so a shell
 * glob after a single `--log` (`--log log-*.txt`) exits 2 on the second file.
 *
 * Regenerates scripts/tla-model-costs.json, the per-config TLC seconds the
 * cost-weighted TLA+ shard assignment (scripts/check-tla-models.mjs) packs by.
 *
 * Why this file exists (#4672): the checker partitioned the sorted config list
 * ROUND-ROBIN BY COUNT, and the configs' costs differ by two orders of
 * magnitude, so one shard carried a third of the work. On master push run
 * 39380875926 (head e3767bd78) the four shards summed 733 s / 1255 s /
 * 1617 s / 2148 s of TLC time -- a 2.9x spread -- and the heaviest shard was
 * `cancelled` at 735 s against its 720 s cap with every step `success`.
 *
 * Each input log is one `node scripts/check-tla-models.mjs --shard i/N` job's
 * raw log; the checker already prints one line per config:
 *
 *   ok   formal/<family>/<Model>.cfg: expected pass, got pass (2.1s)
 *
 * A config's cost is the MEDIAN of its per-run seconds, so one slow runner
 * does not skew it. Keys are repo-relative posix paths and the output is
 * sorted, so regenerating from the same logs is byte-identical.
 *
 * The `--source` labels are the run ids the logs came from; they are recorded
 * in the JSON so the table names its own measurement (AGENTS.md: a measured
 * constant names its measuring command and keeps raw output as a tracked
 * artifact).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { median } from "./lib/test-shard-assignment.mjs";
// The population a table must price is the checker's own: one glob here and
// one there would let the floor below measure the wrong denominator.
import { listModelConfigs } from "./check-tla-models.mjs";

/** One `ok`/`FAIL` line the checker prints per config. Group 1 is the config's
 * repo-relative path, group 2 its TLC seconds. */
const CONFIG_LINE =
	/(?:ok  |FAIL) (formal\/\S+\.cfg): expected .+?, got .+? \(([0-9.]+)s\)/g;

/**
 * Per-config seconds from one log's text.
 *
 * @param {string} text a raw `gh run view --log --job <id>` capture
 * @returns {Map<string, number>}
 */
export function costsFromLog(text) {
	const costs = new Map();
	for (const match of String(text ?? "").matchAll(CONFIG_LINE)) {
		const seconds = Number(match[2]);
		if (!Number.isFinite(seconds) || seconds < 0) continue;
		costs.set(match[1], seconds);
	}
	return costs;
}

/**
 * The table itself: one median per config over every log that ran it.
 *
 * @param {Array<{ source: string, text: string }>} logs
 * @returns {{ files: Record<string, number>, sources: string[], perShardShares: Record<string, number> }}
 */
export function buildModelCosts(logs) {
	/** @type {Map<string, number[]>} */
	const samples = new Map();
	/** @type {Map<string, number>} */
	const shardTotals = new Map();
	for (const { source, text } of logs) {
		let total = 0;
		for (const [config, seconds] of costsFromLog(text)) {
			const list = samples.get(config) ?? [];
			list.push(seconds);
			samples.set(config, list);
			total += seconds;
		}
		shardTotals.set(source, Math.round(total * 10) / 10);
	}
	const files = {};
	for (const config of [...samples.keys()].sort((a, b) =>
		a < b ? -1 : a > b ? 1 : 0,
	)) {
		files[config] = Math.round(median(samples.get(config)) * 10) / 10;
	}
	return {
		files,
		sources: logs.map((entry) => entry.source),
		perShardShares: Object.fromEntries(shardTotals),
	};
}

/**
 * The share of the tree's configs (`listModelConfigs`) a generated table must
 * price before it may be written.
 *
 * The table's whole contract is that a config with no row costs the table's
 * MAX (never zero), so a table missing 75% of the corpus does not fail loudly
 * at the reader -- it silently prices three shards' worth of configs at one
 * fallback number, and the balance line then reports a spread that measured
 * nothing. The documented workflow captures one `--log` per shard, so a
 * complete regeneration clears 100% and a partial one is a mistake worth
 * stopping (V4). Half is the floor: it admits a regeneration from a run that
 * covered a re-sharded subset while refusing a single shard's log.
 */
export const MIN_TABLE_COVERAGE = 0.5;

/**
 * Why `files` cannot ship as the cost table, or `null` when it can.
 *
 * @param {Record<string, number>} files the per-config seconds just generated
 * @param {{ configCount: number }} args `configCount` is the tree's config count
 * @returns {string | null}
 */
export function incompleteTableReason(files, { configCount }) {
	const rows = Object.keys(files ?? {}).length;
	if (rows === 0)
		return "no per-config TLC timings found: no --log carried an `ok|FAIL formal/... (Ns)` line, so this table would price every config at the table max and leave them all in one shard";
	// #4680 r4 F5: zero rows and all-zero rows have the same max, 0, which the
	// reader refuses too: every config would cost 0 and land in shard 1.
	if (Object.values(files).every((seconds) => seconds <= 0))
		return "every measured config took 0 s, so the table max is 0 and every config would cost 0 and land in shard 1; check the --log captures";
	if (configCount > 0 && rows < Math.ceil(configCount * MIN_TABLE_COVERAGE))
		return `only ${rows} of the ${configCount} configs under formal/ have a row (floor ${Math.round(MIN_TABLE_COVERAGE * 100)}%); a config with no row costs the table max, so a partial regeneration prices the shards by fallback -- pass one --log per shard`;
	return null;
}

const USAGE =
	"usage: node scripts/gen-tla-model-costs.mjs --log <job-log> [--log <job-log> ...] [--source <label> ...] [--out <file>]";

function parse(argv) {
	const logs = [];
	const sources = [];
	let out = "scripts/tla-model-costs.json";
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--log") logs.push(argv[++i]);
		else if (arg === "--source") sources.push(argv[++i]);
		else if (arg === "--out") out = argv[++i];
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (logs.length === 0) throw new Error("at least one --log is required");
	if (logs.some((file) => !file)) throw new Error("--log needs a value");
	return { logs, sources, out };
}

export function main(
	argv = process.argv.slice(2),
	{
		root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
	} = {},
) {
	let parsed;
	try {
		parsed = parse(argv);
	} catch (error) {
		console.error(
			`${error instanceof Error ? error.message : error}\n${USAGE}`,
		);
		return 2;
	}
	const logs = parsed.logs.map((file) => ({
		source: parsed.sources[parsed.logs.indexOf(file)] ?? path.basename(file),
		text: fs.readFileSync(file, "utf8"),
	}));
	const { files, sources } = buildModelCosts(logs);
	// A table that prices almost nothing is worse than no table: `loadModelCosts`
	// would accept it, every lookup would fall back to the (now zero) max, and
	// `selectShard` would leave the whole corpus in shard 1 (V4). Refuse before
	// the write, so the committed file is never the broken one.
	const refusal = incompleteTableReason(files, {
		configCount: listModelConfigs(root).length,
	});
	if (refusal !== null) {
		console.error(refusal);
		return 2;
	}
	const payload = {
		generatedBy:
			"node scripts/gen-tla-model-costs.mjs --source <run-id> ... --log <job-log> ... (logs from `gh run view <run-id> --log --job <shard-job-id>`)",
		// The labels `buildModelCosts` used: each `--source`, else the log's
		// basename, so a run with no `--source` still names its measurement
		// (#4680 r4 F9).
		sources,
		note: "Per-config TLC seconds (median over the source runs), read from `ok|FAIL formal/<family>/<Model>.cfg: ... (Ns)` lines the checker prints. scripts/tla-model-costs.json packs the TLA+ shards with these; a config with no row costs the table's MAX so an unmeasured config can never quietly become the tail.",
		files,
	};
	fs.writeFileSync(parsed.out, `${JSON.stringify(payload, null, "\t")}\n`);
	console.log(
		`wrote ${parsed.out}: ${Object.keys(files).length} configs from ${logs.length} log(s)`,
	);
	return 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exitCode = main(process.argv.slice(2));
}
