/**
 * #4535 slice 3: the consumer census (`clients/disk-change-consumers.ts`) is
 * held to the code it describes, in both directions.
 *
 * Recurrence this prevents: slice 2 shipped `diagnosticsCacheSubscriber` with an
 * `if (change.origin !== "out-of-band") return` inside its own handler. Three
 * detectors published and the cache learned about one of them, and nothing
 * listed which consumer heard which detector, so the gap waited for the next
 * audit. A consumer added with no row, a row whose code is gone, or a
 * `subscriber` cell the registry does not back fails here instead.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	DISK_CHANGE_CONSUMERS,
	type DiskChangeConsumer,
} from "../../clients/disk-change-consumers.js";
import { ensureDiskChangeSubscribers } from "../../clients/disk-change-subscribers.js";
import {
	DISK_CHANGE_ORIGINS,
	diskChangeSubscriberOrigins,
} from "../../clients/disk-changes.js";
import { stripCommentsAndStrings } from "../support/session-state-scan.js";
import {
	assertNonEmptyScan,
	escapeRegExp,
	listSourceFiles,
	stripSource,
} from "../support/sweep-kit.js";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** Production directories and files that could register a subscriber. */
const PRODUCTION_ROOTS = ["clients", "tools", "mcp", "scripts"] as const;

function productionSources(): string[] {
	const sources = [
		path.join(repoRoot, "index.ts"),
		...PRODUCTION_ROOTS.flatMap((root) =>
			listSourceFiles(path.join(repoRoot, root), { skipTests: true }),
		),
	];
	assertNonEmptyScan("production source population", sources.length, 400);
	return sources;
}

/** The publisher's registration export, and the module that declares it. */
const PUBLISHER_EXPORT = "subscribeDiskChange";
const PUBLISHER_SPECIFIER = /["'][^"']*disk-changes\.js["']/g;
const PUBLISHER_NAMED_IMPORT =
	/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(["'][^"']*disk-changes\.js["'])/g;

/** The local binding each named-import clause gives the registration export. */
function registrationBindings(clause: string): string[] {
	return clause.split(",").flatMap((item) => {
		const named = item.trim().replace(/^type\s+/, "");
		if (named.length === 0) return [];
		const [imported, local] = named
			.split(/\s+as\s+/)
			.map((part) => part.trim());
		return imported === PUBLISHER_EXPORT ? [local ?? imported] : [];
	});
}

/**
 * How one source file reaches `subscribeDiskChange`. The registration bindings
 * are DERIVED from every import whose specifier ends `disk-changes.js`, so an
 * aliased clause counts; the one use admitted is a call of such a binding.
 * Everything else the scan cannot read is an `unknown` use, and it refuses
 * rather than reports zero: a specifier no named-import clause consumed
 * (`import * as`, an `export … from`, a dynamic import) and every other mention
 * of the identifier (a value passed on, a property, a re-export). A
 * registration the scan cannot read is a subscriber the census cannot see.
 *
 * Recurrence: round 2's scan blanked `import … { … } from …;` and counted the
 * literal name, so `import { subscribeDiskChange as onDiskChange }` registered a
 * live subscriber the census stayed green on (F2 of that round).
 */
function registrationUses(source: string): {
	calls: number;
	unknown: number;
} {
	// Comments blanked and strings KEPT: the publisher path is a string literal
	// and the clause around it is code. Both strip policies preserve length and
	// line breaks, so a match index is the same offset in the string-blanked copy.
	const readable = stripSource(source, { strings: "keep" });
	const imports = [...readable.matchAll(PUBLISHER_NAMED_IMPORT)];
	const bindings = new Set(
		imports.flatMap((match) => registrationBindings(match[1])),
	);
	// Every publisher specifier must be consumed by a named-import clause; the
	// remainder is a form this scan cannot follow.
	let unknown =
		[...readable.matchAll(PUBLISHER_SPECIFIER)].length - imports.length;
	// Blank the admitted import statements before counting, so the clause's own
	// mention of the export is not read as a use.
	const code = [...stripSource(source, { strings: "blank" })];
	for (const match of imports)
		for (
			let index = match.index;
			index < match.index + match[0].length;
			index++
		)
			if (code[index] !== "\n") code[index] = " ";
	const body = code.join("");
	let calls = 0;
	for (const name of new Set([...bindings, PUBLISHER_EXPORT])) {
		const called = [
			...body.matchAll(
				new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*\\(`, "g"),
			),
		].length;
		calls += called;
		unknown +=
			[...body.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\b`, "g"))]
				.length - called;
	}
	return { calls, unknown };
}

function reasonOf(
	cell: DiskChangeConsumer["cells"][keyof DiskChangeConsumer["cells"]],
): string {
	switch (cell.wire) {
		case "subscriber":
			return "subscriber";
		case "fed":
			return cell.by;
		case "pull":
		case "n/a":
			return cell.why;
		case "pending":
			return cell.gap;
	}
}

describe("the consumer census", () => {
	it("answers every origin for every consumer, with a reason on every cell that is not a subscriber", () => {
		const ids = new Set<string>();
		for (const consumer of DISK_CHANGE_CONSUMERS) {
			expect(ids.has(consumer.id), `duplicate row ${consumer.id}`).toBe(false);
			ids.add(consumer.id);
			expect(Object.keys(consumer.cells).sort()).toEqual(
				[...DISK_CHANGE_ORIGINS].sort(),
			);
			for (const origin of DISK_CHANGE_ORIGINS) {
				const cell = consumer.cells[origin];
				if (cell.wire !== "subscriber")
					expect(
						reasonOf(cell).trim().length,
						`${consumer.id} x ${origin} gives no reason`,
					).toBeGreaterThan(20);
			}
		}
	});

	it("backs every subscriber cell with the registry, and every registered subscriber with a row", () => {
		ensureDiskChangeSubscribers();
		const registered = diskChangeSubscriberOrigins();
		for (const consumer of DISK_CHANGE_CONSUMERS) {
			const claimed = DISK_CHANGE_ORIGINS.filter(
				(origin) => consumer.cells[origin].wire === "subscriber",
			);
			if (consumer.subscriberId === undefined) {
				expect(claimed, `${consumer.id} claims a subscription`).toEqual([]);
				continue;
			}
			expect(
				[...(registered.get(consumer.subscriberId) ?? [])].sort(),
				`${consumer.id} is delivered other origins than its row claims`,
			).toEqual([...claimed].sort());
		}
		const rowIds = new Set(
			DISK_CHANGE_CONSUMERS.flatMap((consumer) =>
				consumer.subscriberId === undefined ? [] : [consumer.subscriberId],
			),
		);
		// One production registration site per row. The publisher's own file
		// defines the function; every other file may only import it and call it.
		let calls = 0;
		const unreadable: string[] = [];
		for (const file of productionSources()) {
			if (file.endsWith(path.join("clients", "disk-changes.ts"))) continue;
			const uses = registrationUses(fs.readFileSync(file, "utf8"));
			calls += uses.calls;
			if (uses.unknown > 0) unreadable.push(path.relative(repoRoot, file));
		}
		expect(unreadable, "a use the scan cannot read").toEqual([]);
		expect(calls).toBe(rowIds.size);
		// The registry cell itself is a second way in: nothing but the publisher
		// names its family.
		const family = productionSources().filter(
			(file) =>
				!file.endsWith(path.join("clients", "disk-changes.ts")) &&
				fs.readFileSync(file, "utf8").includes("disk-changes.subscribers"),
		);
		expect(family).toEqual([]);
	});

	it("derives the registration bindings from the import, and refuses every form it cannot follow", () => {
		// Recurrence: an enumerated gate admits the forms its author thought of
		// and passes the next spelling. Each plant below would register a
		// subscriber the census never sees if the scan counted only the literal
		// `subscribeDiskChange(`.
		const alias = [
			'import { subscribeDiskChange } from "./disk-changes.js";',
			"const on = subscribeDiskChange;",
			'on("x", () => undefined);',
		].join("\n");
		const indirect = [
			'import { subscribeDiskChange } from "./disk-changes.js";',
			'[subscribeDiskChange].forEach((register) => register("x", () => undefined));',
		].join("\n");
		const throughBinding = [
			'import { subscribeDiskChange } from "./disk-changes.js";',
			"const bus = { on: subscribeDiskChange };",
			'bus.on("x", () => undefined);',
		].join("\n");
		for (const planted of [alias, indirect, throughBinding])
			expect(registrationUses(planted).unknown).toBeGreaterThan(0);
		// A specifier no named import clause consumed is a form the scan cannot
		// follow, so it refuses rather than reporting zero registrations.
		const namespaceImport = [
			'import * as publisher from "./disk-changes.js";',
			'publisher.subscribeDiskChange("x", () => undefined);',
		].join("\n");
		const reExport = 'export { subscribeDiskChange } from "./disk-changes.js";';
		// The one plant the specifier refusal alone catches: a barrel re-export
		// never spells the identifier, so without it the file reads as zero
		// registrations while a consumer of the barrel registers through it.
		const barrelExport = 'export * from "./disk-changes.js";';
		const dynamicImport = [
			'const publisher = await import("./disk-changes.js");',
			'publisher.subscribeDiskChange("x", () => undefined);',
		].join("\n");
		for (const planted of [
			namespaceImport,
			reExport,
			barrelExport,
			dynamicImport,
		]) {
			const uses = registrationUses(planted);
			expect(uses.unknown).toBeGreaterThan(0);
			expect(uses.calls).toBe(0);
		}
		// The admitted forms stay readable: a plain import plus a call, and an
		// aliased import plus a call of the alias (F2 of review round 2, which the
		// literal-name scan read as zero).
		for (const admitted of [
			[
				'import { subscribeDiskChange } from "./disk-changes.js";',
				'subscribeDiskChange("x", () => undefined);',
			].join("\n"),
			[
				'import { subscribeDiskChange as onDiskChange } from "./disk-changes.js";',
				'onDiskChange("x", () => undefined);',
			].join("\n"),
			[
				'import { type DiskChange, subscribeDiskChange as on } from "./disk-changes.js";',
				'on("x", () => undefined);',
			].join("\n"),
		])
			expect(registrationUses(admitted)).toEqual({ calls: 1, unknown: 0 });
		// A sibling import from the same module is not a registration binding.
		expect(
			registrationUses(
				'import { DISK_CHANGE_ORIGINS } from "./disk-changes.js";\nconst all = [...DISK_CHANGE_ORIGINS];',
			),
		).toEqual({ calls: 0, unknown: 0 });
		// A comment or a string naming the call is neither a call nor a use.
		expect(
			registrationUses(
				'// subscribeDiskChange("x", fn)\nconst s = "subscribeDiskChange(";',
			),
		).toEqual({ calls: 0, unknown: 0 });
	});

	it("keeps each row's anchor in the file it names", () => {
		for (const consumer of DISK_CHANGE_CONSUMERS) {
			const file = path.join(repoRoot, consumer.anchor.file);
			expect(
				fs.existsSync(file),
				`${consumer.id}: ${consumer.anchor.file}`,
			).toBe(true);
			const code = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));
			expect(
				new RegExp(`\\b${consumer.anchor.symbol}\\b`).test(code),
				`${consumer.id}: ${consumer.anchor.symbol} is gone from ${consumer.anchor.file}`,
			).toBe(true);
		}
	});

	it("pins the pending cells, so a wire that lands removes one and a new gap is a deliberate edit", () => {
		const pendingByConsumer = Object.fromEntries(
			DISK_CHANGE_CONSUMERS.flatMap((consumer) => {
				const count = DISK_CHANGE_ORIGINS.filter(
					(origin) => consumer.cells[origin].wire === "pending",
				).length;
				return count === 0 ? [] : [[consumer.id, count]];
			}),
		);
		expect(pendingByConsumer).toEqual({
			"lsp-unheld-modules": 1,
			"dispatch-delta-baseline": 4,
			"inline-blocker-records": 4,
			"record-carry-position-stale": 3,
			"widget-rows": 1,
			"widget-dependency-demotion": 4,
			"advisory-and-project-diagnostics": 1,
			"actionable-warnings-merge": 3,
			"cascade-carry-over-supersede": 3,
			"review-graph-and-reverse-deps": 4,
			"review-graph-answers-trust-note": 3,
			"word-index": 4,
			"project-snapshot": 4,
			"call-graph-and-codebase-model": 5,
			"knip-analysis-memo": 4,
			"formatter-detection-cache": 4,
			"workspace-modules-cache": 1,
		});
	});
});
