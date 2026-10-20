import { afterEach, describe, it, expect } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	FactStore,
	getFactStoreEvictionReporter,
	setFactStoreEvictionReporter,
} from "../../../clients/dispatch/fact-store.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
// Side-effect import: loading integration.ts runs its module-scope
// `setFactStoreEvictionReporter(...)` call, wiring the REAL production
// reporter into fact-store's module-scope slot. #2243 review round 3 (F4):
// a prior version of this file hand-copied that wiring
// (`recordDegradationOnce({kind, subject, reason})`) into a local test
// helper — a shared-seam double that never actually exercised the reporter
// body integration.ts installs, so a mutation to its `kind` or `subject`
// there went unnoticed here. Capture the REAL reporter reference now, at
// module load, before any test's `afterEach` below can clear the slot.
import "../../../clients/dispatch/integration.js";
const productionEvictionReporter = getFactStoreEvictionReporter();

afterEach(() => setFactStoreEvictionReporter(undefined));

// The store caps file records at 1024 and exempts in-flight dispatches from
// eviction. A dispatch pins its file at start and releases it at completion.
const MAX_RECORDS = 1024;
const BATCH = 2000;
const MIB = 1024 * 1024;

function contentOfBytes(bytes: number): string {
	return "x".repeat(bytes);
}

function batchPaths(prefix: string, count = BATCH): string[] {
	return Array.from({ length: count }, (_, i) => `/repo/src/${prefix}-${i}.ts`);
}

function retained(store: FactStore, paths: string[]): number {
	return paths.filter((p) => store.hasFileFact(p, "file.content")).length;
}

describe("FactStore file-fact bound (#2240)", () => {
	it("caps distinct file records so a large batch cannot exhaust the heap", () => {
		const store = new FactStore();
		const paths = batchPaths("batch");
		store.setSessionFact("session.toolCache.biome", true);

		for (const p of paths) store.setFileFact(p, "file.content", "x");

		expect(retained(store, paths)).toBeLessThanOrEqual(MAX_RECORDS);
		expect(store.hasFileFact(paths[0], "file.content")).toBe(false);
		expect(store.hasFileFact(paths[BATCH - 1], "file.content")).toBe(true);
		// Eviction is capacity-only — session baselines and tool caches stay.
		expect(store.getSessionFact("session.toolCache.biome")).toBe(true);
	});

	it("evicts least-recently-used records, keeping the ones still being read", () => {
		const store = new FactStore();
		const paths = batchPaths("lru");
		for (const p of paths.slice(0, MAX_RECORDS)) {
			store.setFileFact(p, "file.content", "x");
		}
		// Re-read the oldest record: an LRU touch must move it off the victim end.
		expect(store.getFileFact(paths[0], "file.content")).toBe("x");

		for (const p of paths.slice(MAX_RECORDS)) {
			store.setFileFact(p, "file.content", "x");
		}

		expect(store.hasFileFact(paths[0], "file.content")).toBe(true);
		expect(store.hasFileFact(paths[1], "file.content")).toBe(false);
	});

	it("evicts on retained content bytes before the record cap is reached", () => {
		const store = new FactStore();
		const paths = batchPaths("byte-pressure", 3);
		for (const p of paths) {
			store.setFileFact(p, "file.content", contentOfBytes(24 * MIB));
		}

		expect(store.hasFileFact(paths[0], "file.content")).toBe(false);
		expect(retained(store, paths)).toBe(2);
	});

	it("weighs retained content as UTF-8 bytes rather than string length", () => {
		const store = new FactStore();
		const paths = batchPaths("utf8-byte-pressure", 2);
		// Two strings total 36 MiB in JavaScript length but 72 MiB in UTF-8.
		for (const p of paths) {
			store.setFileFact(p, "file.content", "😀".repeat(9 * MIB));
		}

		expect(store.hasFileFact(paths[0], "file.content")).toBe(false);
		expect(store.hasFileFact(paths[1], "file.content")).toBe(true);
	});

	it("keeps pinned content under byte pressure and evicts it after unpin", () => {
		const store = new FactStore();
		const active = "/repo/src/byte-pinned.ts";
		store.clearFileFactsFor(active);
		store.setFileFact(active, "file.content", contentOfBytes(40 * MIB));
		store.setFileFact(
			"/repo/src/pressure-1.ts",
			"file.content",
			contentOfBytes(20 * MIB),
		);
		store.setFileFact(
			"/repo/src/pressure-2.ts",
			"file.content",
			contentOfBytes(20 * MIB),
		);

		expect(store.hasFileFact(active, "file.content")).toBe(true);
		store.endDispatchFor(active);
		store.setFileFact(
			"/repo/src/pressure-3.ts",
			"file.content",
			contentOfBytes(20 * MIB),
		);
		expect(store.hasFileFact(active, "file.content")).toBe(false);
	});

	it("never evicts the file whose dispatch is in flight", () => {
		const store = new FactStore();
		const active = "/repo/src/active.ts";
		// What every per-file dispatch does before its providers run.
		store.clearFileFactsFor(active);
		store.setFileFact(active, "file.content", "const x = 1;");

		// The fire-and-forget blast-radius build walks the whole project against
		// this same store while the dispatch is still running.
		for (const p of batchPaths("walk"))
			store.setFileFact(p, "file.content", "");

		expect(store.getFileFact(active, "file.content")).toBe("const x = 1;");
	});

	it("retains every in-flight dispatch record until it settles", () => {
		const store = new FactStore();
		const dispatched = batchPaths("dispatched", MAX_RECORDS + 1);
		for (const [index, p] of dispatched.entries()) {
			store.clearFileFactsFor(p);
			store.setFileFact(p, "file.content", `value-${index}`);
		}

		// While these files are in-flight, they must survive a large store flood.
		for (const p of batchPaths("walk"))
			store.setFileFact(p, "file.content", "");

		for (const [index, p] of dispatched.entries()) {
			expect(store.getFileFact(p, "file.content")).toBe(`value-${index}`);
		}

		store.endDispatchFor(dispatched[0]);
		expect(store.getFileFact(dispatched[0], "file.content")).toBeUndefined();

		for (const p of dispatched.slice(1)) store.endDispatchFor(p);
	});

	it("clearAll releases the pins with the records", () => {
		const store = new FactStore();
		const active = "/repo/src/active.ts";
		store.clearFileFactsFor(active);
		store.setFileFact(active, "file.content", "const x = 1;");

		store.clearAll();

		store.setFileFact(active, "file.content", "const x = 1;");
		for (const p of batchPaths("walk"))
			store.setFileFact(p, "file.content", "");

		expect(store.hasFileFact(active, "file.content")).toBe(false);
	});

	// #2243 item 2: the pin is released at dispatch END, so the pin set tracks
	// dispatches actually in flight.
	it("a completed dispatch releases its pin, so later completed dispatches keep an in-flight file", () => {
		const store = new FactStore();
		const active = "/repo/src/active.ts";
		// The in-flight dispatch: begins, but has not settled.
		store.clearFileFactsFor(active);
		store.setFileFact(active, "file.content", "const x = 1;");

		// 17 later dispatches that each BEGIN and SETTLE.
		for (const p of batchPaths("later", 17)) {
			store.clearFileFactsFor(p);
			store.setFileFact(p, "file.content", "y");
			store.endDispatchFor(p);
		}

		// The fire-and-forget project walk floods the store.
		for (const p of batchPaths("walk"))
			store.setFileFact(p, "file.content", "");

		expect(store.getFileFact(active, "file.content")).toBe("const x = 1;");
	});

	// #2243: dropFileFacts clears without pinning, so a scan's own store keeps
	// the capacity cap effective. clearFileFactsFor pins; dropFileFacts must not.
	it("dropFileFacts does not pin — a dropped file stays evictable", () => {
		const store = new FactStore();
		const viaDrop = "/repo/src/via-drop.ts";
		const viaClear = "/repo/src/via-clear.ts";
		store.dropFileFacts(viaDrop);
		store.setFileFact(viaDrop, "file.content", "d");
		store.clearFileFactsFor(viaClear);
		store.setFileFact(viaClear, "file.content", "c");

		for (const p of batchPaths("walk"))
			store.setFileFact(p, "file.content", "");

		// clearFileFactsFor pinned viaClear (in flight) → survives.
		expect(store.getFileFact(viaClear, "file.content")).toBe("c");
		// dropFileFacts did not pin viaDrop → the walk evicts it.
		expect(store.hasFileFact(viaDrop, "file.content")).toBe(false);
	});

	// #2243 item 4: the cap evicts silently, and the victim can be a fact a live
	// dispatch still needs. Record ONE bounded degradation on the first capacity
	// eviction per session, stamped with the evicted path, re-arming per session.
	//
	// #2243 review round 3 (F1/F4): this drives the REAL, actually-installed
	// production reporter (imported from integration.ts, not hand-copied), and
	// a store labeled "dispatch" — the same subject integration.ts's own
	// `sessionFacts` carries — so a mutation to either the reporter's `kind` /
	// `subject` wiring in integration.ts, or the per-store subject label, reds
	// this test.
	//
	// #2247 review F1: the ledger subject now carries `<store>:<axis>`, so a
	// count-axis and a byte-axis eviction on the SAME store no longer share
	// one dedupe key.
	it("records one capacity-eviction degradation per session, naming the evicted path", () => {
		expect(productionEvictionReporter).toBeDefined();
		resetDegradationLedger();
		setFactStoreEvictionReporter(productionEvictionReporter);
		const store = new FactStore("dispatch");
		const paths = batchPaths("evict");
		for (const p of paths) store.setFileFact(p, "file.content", "x");

		const find = () =>
			getDegradationSummary().find(
				(g) => g.kind === "fact-store-capacity-eviction",
			);
		const group = find();
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		// One record per session per store per axis; the reason names the FIRST
		// evicted path (oldest inserted).
		expect(group?.latestReasons.at(-1)?.subject).toBe("dispatch:count");
		expect(group?.latestReasons.at(-1)?.reason).toContain(
			normalizeMapKey(paths[0]),
		);
		expect(group?.latestReasons.at(-1)?.reason).toContain("axis=count");

		// Further evictions in the same session do not add a second record.
		for (const p of batchPaths("evict2"))
			store.setFileFact(p, "file.content", "x");
		expect(find()?.count).toBe(1);

		// A new session (ledger re-arm) records again.
		resetDegradationLedger();
		const store2 = new FactStore("dispatch");
		for (const p of batchPaths("evict3"))
			store2.setFileFact(p, "file.content", "x");
		expect(find()?.count).toBe(1);
	});

	it("records the byte axis when retained content triggers eviction", () => {
		resetDegradationLedger();
		setFactStoreEvictionReporter(productionEvictionReporter);
		const store = new FactStore("dispatch-byte-axis");
		for (const p of batchPaths("byte-axis", 3)) {
			store.setFileFact(p, "file.content", contentOfBytes(24 * MIB));
		}

		const group = getDegradationSummary().find(
			(g) => g.kind === "fact-store-capacity-eviction",
		);
		expect(group?.latestReasons.at(-1)?.subject).toBe(
			"dispatch-byte-axis:bytes",
		);
		expect(group?.latestReasons.at(-1)?.reason).toContain("axis=bytes");
	});

	// #2247 review F1: the reviewer's missing case — the SAME store trips the
	// count axis first (its guaranteed order: 1024 typical files land far
	// under 64 MiB), then a later byte-axis eviction happens on that store
	// too. Both must produce distinct records; before the fix the count-axis
	// record consumed the `${kind}\0${subject}` dedupe key and the byte-axis
	// eviction recorded nothing.
	it("records both axes for the same store when count then bytes eviction fire in sequence", () => {
		resetDegradationLedger();
		setFactStoreEvictionReporter(productionEvictionReporter);
		const store = new FactStore("dispatch");

		// Count axis fires first: exceed the 1024-record cap with tiny content.
		for (const p of batchPaths("count-then-bytes", MAX_RECORDS + 1)) {
			store.setFileFact(p, "file.content", "x");
		}
		// Byte axis fires next, on the SAME store: push large content past the
		// 64 MiB retained-bytes budget.
		for (const p of batchPaths("count-then-bytes-big", 3)) {
			store.setFileFact(p, "file.content", contentOfBytes(24 * MIB));
		}

		const group = getDegradationSummary().find(
			(g) => g.kind === "fact-store-capacity-eviction",
		);
		expect(group?.count).toBe(2);
		const subjects = group?.latestReasons.map((r) => r.subject) ?? [];
		expect(subjects).toContain("dispatch:count");
		expect(subjects).toContain("dispatch:bytes");
	});

	// #2243 review round 3 (F1): a DIFFERENT store — a different subject —
	// still gets its OWN once-per-session record, even after "dispatch" (or
	// any other subject) already fired one in this session. Before F1, the
	// constant subject meant only the FIRST store to evict in a session ever
	// recorded anything.
	it("gives a differently-labeled store its own record after another store already fired", () => {
		resetDegradationLedger();
		setFactStoreEvictionReporter(productionEvictionReporter);
		const graphWalkStore = new FactStore("runtime-session-call-graph");
		for (const p of batchPaths("graph-walk"))
			graphWalkStore.setFileFact(p, "file.content", "x");

		const dispatchStore = new FactStore("dispatch");
		for (const p of batchPaths("dispatch-evict"))
			dispatchStore.setFileFact(p, "file.content", "x");

		const groups = getDegradationSummary().filter(
			(g) => g.kind === "fact-store-capacity-eviction",
		);
		expect(groups).toHaveLength(1); // one GROUP (kind), two entries within it
		const subjects = groups[0]?.latestReasons.map((r) => r.subject) ?? [];
		expect(subjects).toContain("runtime-session-call-graph:count");
		expect(subjects).toContain("dispatch:count");
	});

	// #2247 review F2: a leaked (or several overlapping) pin(s) whose bytes
	// alone exceed the 64 MiB budget must not silently wedge the store —
	// before the fix, every subsequent unpinned insert was evicted on the
	// same call it was admitted, forever, because it was always the sole
	// remaining unpinned key.
	it("does not silently collapse unpinned writes when pinned content alone exceeds the byte budget", () => {
		resetDegradationLedger();
		setFactStoreEvictionReporter(productionEvictionReporter);
		const store = new FactStore("dispatch");
		const pinnedA = "/repo/src/pinned-a.ts";
		const pinnedB = "/repo/src/pinned-b.ts";
		store.clearFileFactsFor(pinnedA);
		store.setFileFact(pinnedA, "file.content", contentOfBytes(40 * MIB));
		store.clearFileFactsFor(pinnedB);
		store.setFileFact(pinnedB, "file.content", contentOfBytes(40 * MIB));
		// 80 MiB pinned against a 64 MiB budget.

		const normalPaths = batchPaths("normal-under-pin-pressure", 50);
		for (const p of normalPaths) store.setFileFact(p, "file.content", "small");

		expect(retained(store, normalPaths)).toBe(50);
		expect(store.hasFileFact(pinnedA, "file.content")).toBe(true);
		expect(store.hasFileFact(pinnedB, "file.content")).toBe(true);

		const group = getDegradationSummary().find(
			(g) => g.kind === "fact-store-pinned-over-budget",
		);
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons.at(-1)?.subject).toBe("dispatch");
		expect(group?.latestReasons.at(-1)?.reason).toContain(
			"pinned content bytes",
		);

		// A regular byte-axis eviction still applies once pins release and
		// pressure is unpinned-driven again.
		store.endDispatchFor(pinnedA);
		store.endDispatchFor(pinnedB);
		store.setFileFact(
			"/repo/src/after-unpin.ts",
			"file.content",
			contentOfBytes(20 * MIB),
		);
		expect(store.hasFileFact(pinnedA, "file.content")).toBe(false);
	});

	// #2247 review F3: three accounting paths (overwrite's subtract-old,
	// delete's subtraction, clearAll's reset) were mutation-vacuous — nothing
	// in the suite caught their removal. Recompute a fresh sum over every
	// path this test ever touched after a mixed operation sequence and
	// assert it matches the running total exactly, rather than only
	// asserting individual hasFileFact booleans.
	it("keeps the running retained-bytes total equal to a fresh sum after a mixed op sequence", () => {
		const store = new FactStore();
		const touched = new Set<string>();
		const freshSum = () => {
			let total = 0;
			for (const p of touched) {
				const content = store.getFileFact<string>(p, "file.content");
				if (typeof content === "string") {
					total += Buffer.byteLength(content, "utf8");
				}
			}
			return total;
		};
		// #2247 review F4: companion sum over pinnedFiles ∩ fileFacts. Tracked
		// separately from `touched` because a record can be retained without
		// being pinned.
		const pinnedTouched = new Set<string>();
		const freshPinnedSum = () => {
			let total = 0;
			for (const p of pinnedTouched) {
				const content = store.getFileFact<string>(p, "file.content");
				if (typeof content === "string") {
					total += Buffer.byteLength(content, "utf8");
				}
			}
			return total;
		};

		const a = "/repo/src/crosscheck-a.ts";
		const b = "/repo/src/crosscheck-b.ts";
		const c = "/repo/src/crosscheck-c.ts";
		const pinned = "/repo/src/crosscheck-pinned.ts";
		touched.add(a).add(b).add(c).add(pinned);

		store.setFileFact(a, "file.content", contentOfBytes(1000));
		expect(store.getRetainedContentBytes()).toBe(freshSum());

		// Overwrite with a DIFFERENT size — exercises subtract-old-on-overwrite.
		store.setFileFact(a, "file.content", contentOfBytes(300));
		expect(store.getRetainedContentBytes()).toBe(freshSum());

		// Multibyte content: UTF-8 byte length differs from string length.
		store.setFileFact(b, "file.content", "😀".repeat(500));
		expect(store.getRetainedContentBytes()).toBe(freshSum());

		// deleteFileFact subtraction.
		store.setFileFact(c, "file.content", contentOfBytes(700));
		store.deleteFileFact(c, "file.content");
		touched.delete(c);
		expect(store.getRetainedContentBytes()).toBe(freshSum());

		// clearFileFactsFor / endDispatchFor pin lifecycle, then dropFileFacts.
		store.clearFileFactsFor(pinned);
		pinnedTouched.add(pinned);
		store.setFileFact(pinned, "file.content", contentOfBytes(2000));
		expect(store.getRetainedContentBytes()).toBe(freshSum());
		expect(store.getPinnedContentBytes()).toBe(freshPinnedSum());
		store.endDispatchFor(pinned);
		pinnedTouched.delete(pinned);
		expect(store.getPinnedContentBytes()).toBe(freshPinnedSum());
		store.dropFileFacts(pinned);
		touched.delete(pinned);
		expect(store.getRetainedContentBytes()).toBe(freshSum());

		// #2247 review F4 (M10 probe): beginDispatchFor pins a WARM record — one
		// that already carries content — without clearing it first. The pin's
		// 0→1 transition is the ONLY place that pre-existing content joins the
		// pinned subset for this call shape; clearFileFactsFor above always
		// clears before pinning, so it never exercises that add.
		const warm = "/repo/src/crosscheck-warm.ts";
		touched.add(warm);
		store.setFileFact(warm, "file.content", contentOfBytes(1500));
		store.beginDispatchFor(warm);
		pinnedTouched.add(warm);
		expect(store.getPinnedContentBytes()).toBe(freshPinnedSum());

		// #2247 review F4 (M9 probe): clearAll must reset the pinned total too,
		// not just the overall total. The pin on `warm` is still held when
		// clearAll runs — the shape that exposes a stale pinned total
		// (integration.ts:482 calls clearAll() on session reset; a pin held at
		// that moment previously left `pinnedContentBytesTotal` nonzero with
		// `pinnedFiles` emptied, permanently disabling the byte budget).
		store.setFileFact(a, "file.content", contentOfBytes(50));
		store.clearAll();
		touched.clear();
		pinnedTouched.clear();
		expect(store.getRetainedContentBytes()).toBe(0);
		expect(store.getRetainedContentBytes()).toBe(freshSum());
		expect(store.getPinnedContentBytes()).toBe(0);
		expect(store.getPinnedContentBytes()).toBe(freshPinnedSum());
	});

	// fact-store must stay an import leaf: it emits eviction telemetry only
	// through the injected reporter, never by importing the ledger directly
	// (that re-enters the safe-spawn ↔ degradation-ledger cycle).
	it("emits capacity eviction through the injected reporter", () => {
		const reasons: string[] = [];
		const subjects: string[] = [];
		setFactStoreEvictionReporter((subject, _axis, reason) => {
			subjects.push(subject);
			reasons.push(reason);
		});
		const store = new FactStore("emit-subject");
		for (const p of batchPaths("emit"))
			store.setFileFact(p, "file.content", "x");
		expect(reasons.length).toBeGreaterThan(0);
		expect(reasons[0]).toContain("exceeded");
		expect(subjects[0]).toBe("emit-subject");
	});
});

// #4365 rotation batch 1: survivors of the per-module Stryker campaign. Every
// case drives the real FactStore; each comment names the mutants it kills.
describe("FactStore accounting and pin survivors (#4365)", () => {
	const keep = "/repo/src/survivor-keep.ts";
	const content100 = contentOfBytes(100);

	it("counts only file.content toward the retained byte total, on write and on delete", () => {
		// Kills `factId === "file.content"` forced true in setFileFact and in
		// deleteFileFact: a string-valued fact under any other id was weighed as
		// content, inflating the byte budget that drives eviction.
		const store = new FactStore();
		store.setFileFact(keep, "other.fact", "not file content at all");
		expect(store.getRetainedContentBytes()).toBe(0);

		store.setFileFact(keep, "file.content", contentOfBytes(5));
		store.deleteFileFact(keep, "other.fact");

		expect(store.getRetainedContentBytes()).toBe(5);
	});

	it("tolerates deleting, dropping or clearing a file it has never seen", () => {
		// Kills the `!facts` guards forced false in deleteFileFact and
		// deleteFileFactsRecord (a TypeError on `facts.get` for an unseen path).
		const store = new FactStore();
		expect(() =>
			store.deleteFileFact("/repo/src/never-a.ts", "x"),
		).not.toThrow();
		expect(() => store.dropFileFacts("/repo/src/never-b.ts")).not.toThrow();
		expect(() => store.clearFileFactsFor("/repo/src/never-c.ts")).not.toThrow();
	});

	it("keeps the pinned byte total exact when a pinned file's content is deleted or its record cleared", () => {
		// Kills `this.pinnedFiles.has(key)` forced false in deleteFileFact and in
		// deleteFileFactsRecord, and their `-=` turned `+=` (both were uncovered):
		// the pinned total fed the pinned-over-budget decision and drifted.
		const store = new FactStore();
		store.beginDispatchFor(keep);
		store.setFileFact(keep, "file.content", content100);
		expect(store.getPinnedContentBytes()).toBe(100);

		store.deleteFileFact(keep, "file.content");
		expect(store.getPinnedContentBytes()).toBe(0);
		expect(store.getRetainedContentBytes()).toBe(0);

		store.setFileFact(keep, "file.content", content100);
		// A second, overlapping dispatch of the same pinned file clears its record.
		store.clearFileFactsFor(keep);
		expect(store.getPinnedContentBytes()).toBe(0);
		expect(store.getRetainedContentBytes()).toBe(0);
	});

	it("frees a file's record slot when its last fact is deleted", () => {
		// Kills `facts.size === 0` forced false and `this.fileFacts.delete(key)`
		// removed in deleteFileFact: an emptied record kept counting toward the
		// 1024-record cap, so refilling the store evicted live files.
		const reports: string[] = [];
		setFactStoreEvictionReporter((_subject, axis) => reports.push(axis));
		const store = new FactStore();
		const first = batchPaths("slot-first", MAX_RECORDS);
		for (const p of first) store.setFileFact(p, "only.fact", 1);
		for (const p of first) store.deleteFileFact(p, "only.fact");

		const second = batchPaths("slot-second", MAX_RECORDS);
		for (const p of second) store.setFileFact(p, "file.content", "x");

		expect(reports).toEqual([]);
		expect(retained(store, second)).toBe(MAX_RECORDS);
	});

	it("holds an overlapped pin until the LAST dispatch ends, and counts its content once", () => {
		// Kills pinFile `count === 0` forced true (content counted again for the
		// second dispatch), `count + 1` turned `count - 1` (the refcount never
		// reached 2), and unpinFile `count <= 1` forced true (the first end
		// released a pin the second dispatch still holds).
		const store = new FactStore();
		store.setFileFact(keep, "file.content", content100);
		store.beginDispatchFor(keep);
		store.beginDispatchFor(keep);
		expect(store.getPinnedContentBytes()).toBe(100);

		store.endDispatchFor(keep);
		for (const p of batchPaths("overlap-a", MAX_RECORDS + 100))
			store.setFileFact(p, "file.content", "x");
		expect(store.hasFileFact(keep, "file.content")).toBe(true);
		expect(store.getPinnedContentBytes()).toBe(100);

		store.endDispatchFor(keep);
		expect(store.getPinnedContentBytes()).toBe(0);
		for (const p of batchPaths("overlap-b", MAX_RECORDS + 100))
			store.setFileFact(p, "file.content", "x");
		expect(store.hasFileFact(keep, "file.content")).toBe(false);
	});

	it("ignores endDispatchFor for a file that was never pinned", () => {
		// Kills unpinFile `count === undefined` forced false: the missing count
		// became NaN and pinned the file for good, exempting it from the cap.
		const store = new FactStore();
		store.setFileFact(keep, "file.content", content100);
		store.endDispatchFor(keep);

		for (const p of batchPaths("never-pinned", MAX_RECORDS + 100))
			store.setFileFact(p, "file.content", "x");

		expect(store.hasFileFact(keep, "file.content")).toBe(false);
	});

	it("still enforces the record cap while pinned content alone is over the byte budget, with no reporter wired", () => {
		// Kills `axis === "bytes"` forced true in evictColdFileFacts (the pinned
		// guard fired on the COUNT axis too, so no record was ever evicted), and
		// `capacityEvictionReporter?.(...)` made unconditional in
		// reportPinnedOverBudget (a TypeError once pinned bytes alone exceed the
		// budget and nothing is wired).
		setFactStoreEvictionReporter(undefined);
		const store = new FactStore();
		const pinned = "/repo/src/survivor-pinned-big.ts";
		store.clearFileFactsFor(pinned);
		store.setFileFact(pinned, "file.content", contentOfBytes(65 * MIB));

		const normal = batchPaths("pinned-pressure", MAX_RECORDS + 100);
		for (const p of normal) store.setFileFact(p, "file.content", "x");

		expect(store.hasFileFact(pinned, "file.content")).toBe(true);
		expect(retained(store, normal)).toBeLessThanOrEqual(MAX_RECORDS - 1);
	});

	it("treats pinned content of exactly the byte budget as within budget", () => {
		// Kills `pinnedContentBytesTotal > MAX` turned `>=`: exactly 64 MiB pinned
		// is not over budget, so a cold unpinned record must still be evicted
		// instead of the store giving up on eviction.
		const store = new FactStore();
		const pinned = "/repo/src/survivor-pinned-exact.ts";
		store.clearFileFactsFor(pinned);
		store.setFileFact(pinned, "file.content", contentOfBytes(64 * MIB));
		const cold = "/repo/src/survivor-cold.ts";

		store.setFileFact(cold, "file.content", "tiny");

		expect(store.hasFileFact(pinned, "file.content")).toBe(true);
		expect(store.hasFileFact(cold, "file.content")).toBe(false);
	});

	it("retains unpinned content of exactly the byte budget, and evicts one byte more", () => {
		// Kills `retainedContentBytes > MAX` turned `>=` in overCapacity.
		const store = new FactStore();
		const exact = "/repo/src/survivor-exact.ts";
		store.setFileFact(exact, "file.content", contentOfBytes(64 * MIB));
		expect(store.hasFileFact(exact, "file.content")).toBe(true);

		store.setFileFact("/repo/src/survivor-one-more.ts", "file.content", "x");
		expect(store.hasFileFact(exact, "file.content")).toBe(false);
	});

	it("names the bytes axis when the store holds exactly the record cap and is over the byte budget", () => {
		// Kills `fileFacts.size > MAX_FILE_FACT_RECORDS` turned `>=` in
		// capacityAxis: at exactly 1024 records the pressure is bytes, and the
		// ledger row (and its once-per-session slot) must say so.
		const axes: string[] = [];
		setFactStoreEvictionReporter((_subject, axis) => axes.push(axis));
		const store = new FactStore();
		for (const p of batchPaths("axis-small", MAX_RECORDS - 1))
			store.setFileFact(p, "file.content", "x");

		store.setFileFact(
			"/repo/src/survivor-axis-big.ts",
			"file.content",
			contentOfBytes(65 * MIB),
		);

		expect(axes[0]).toBe("bytes");
	});

	it("leaves no phantom record behind when a path it never stored is read", () => {
		// Kills `!facts` forced false in touchFileFacts (campaign id 61): a read
		// miss re-inserted `undefined` under the key, so the lone read of a missing
		// path counted as a record and pushed the oldest real file out at the cap.
		const store = new FactStore();
		const paths = batchPaths("phantom", MAX_RECORDS);
		for (const p of paths) store.setFileFact(p, "file.content", "x");

		expect(
			store.getFileFact("/repo/src/never-stored.ts", "file.content"),
		).toBeUndefined();
		store.setFileFact(paths[MAX_RECORDS - 1] as string, "other.fact", 1);

		expect(store.hasFileFact(paths[0] as string, "file.content")).toBe(true);
	});

	it("labels an unnamed store's eviction record with the default subject", () => {
		// Kills the constructor default `"session-fact-store"` emptied: the ledger
		// dedupes on kind + subject, so an empty subject merges unrelated stores.
		const subjects: string[] = [];
		setFactStoreEvictionReporter((subject) => subjects.push(subject));
		const store = new FactStore();
		for (const p of batchPaths("default-subject", MAX_RECORDS + 1))
			store.setFileFact(p, "file.content", "x");

		expect(subjects[0]).toBe("session-fact-store");
	});
});
