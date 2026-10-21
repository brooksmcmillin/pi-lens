import { describe, it, expect } from "vitest";
import { scheduleProviders } from "../../../clients/dispatch/fact-scheduler.js";
import type { FactProvider } from "../../../clients/dispatch/fact-provider-types.js";

function makeProvider(
	id: string,
	provides: string[],
	requires: string[],
): FactProvider {
	return {
		id,
		provides,
		requires,
		appliesTo: () => true,
		run: async () => {},
	};
}

describe("scheduleProviders", () => {
	it("single provider — returned as-is", () => {
		const p = makeProvider("a", ["a.fact"], []);
		const result = scheduleProviders([p]);
		expect(result).toEqual([p]);
	});

	it("two providers A→B (B requires A's output) — A comes first", () => {
		const a = makeProvider("provider.a", ["fact.a"], []);
		const b = makeProvider("provider.b", ["fact.b"], ["fact.a"]);
		const result = scheduleProviders([b, a]);
		expect(result[0]).toBe(a);
		expect(result[1]).toBe(b);
	});

	it("tie-break: two independent providers sorted by id ascending", () => {
		const x = makeProvider("provider.x", ["fact.x"], []);
		const m = makeProvider("provider.m", ["fact.m"], []);
		const result = scheduleProviders([x, m]);
		expect(result[0]).toBe(m);
		expect(result[1]).toBe(x);
	});

	it("three providers with 2-wave dependency chain — correct order", () => {
		const a = makeProvider("provider.a", ["fact.a"], []);
		const b = makeProvider("provider.b", ["fact.b"], ["fact.a"]);
		const c = makeProvider("provider.c", ["fact.c"], ["fact.b"]);
		const result = scheduleProviders([c, b, a]);
		expect(result[0]).toBe(a);
		expect(result[1]).toBe(b);
		expect(result[2]).toBe(c);
	});

	it("cycle detection — throws an error mentioning the cycle", () => {
		const a = makeProvider("provider.a", ["fact.a"], ["fact.b"]);
		const b = makeProvider("provider.b", ["fact.b"], ["fact.a"]);
		expect(() => scheduleProviders([a, b])).toThrowError(/cycle/i);
		expect(() => scheduleProviders([a, b])).toThrowError("provider.a");
		expect(() => scheduleProviders([a, b])).toThrowError("provider.b");
	});

	it("provider requiring a fact with no provider (external dep) — treated as in-degree 0, works fine", () => {
		const p = makeProvider("provider.x", ["fact.x"], ["external.fact"]);
		const result = scheduleProviders([p]);
		expect(result).toEqual([p]);
	});

	it("empty array — returns empty array", () => {
		expect(scheduleProviders([])).toEqual([]);
	});
	// #4365 rotation batch 1: the cases below pin survivors of the per-module
	// Stryker campaign. Each comment names the mutant it kills.

	it("returns a copy for a single provider, so a caller's edit cannot reach the registry's list", () => {
		// Kills `providers.slice()` -> `providers` on the early-return path.
		const input = [makeProvider("only", ["only.fact"], [])];
		const result = scheduleProviders(input);
		expect(result).toEqual(input);
		expect(result).not.toBe(input);
	});

	it("ignores a requirement nobody provides when other providers are scheduled", () => {
		// Kills the `dep && ...` guard forced true / `||`: an external fact has no
		// provider, so `dep` is undefined and `dep.id` would throw. The single
		// provider case above never reaches this loop (early return).
		const a = makeProvider("provider.a", ["fact.a"], ["external.fact"]);
		const b = makeProvider("provider.b", ["fact.b"], ["fact.a"]);
		expect(scheduleProviders([b, a])).toEqual([a, b]);
	});

	it("ignores a provider's requirement on its own output instead of reporting a cycle", () => {
		// Kills `dep.id !== p.id` forced true: a self-requirement would count as
		// an unsatisfiable in-degree and throw "Cycle detected".
		const self = makeProvider("provider.self", ["fact.self"], ["fact.self"]);
		const other = makeProvider("provider.other", ["fact.other"], []);
		expect(scheduleProviders([self, other])).toEqual([other, self]);
	});

	it("counts a provider that supplies several required facts once", () => {
		// Kills `seenDeps.add` removed and the `!seenDeps.has` guard weakened
		// (`||`, forced true): B needs both x and y from A. Counted twice, B's
		// in-degree would stay at 1 after A runs and B would be reported as a
		// cycle member.
		const a = makeProvider("provider.a", ["fact.x", "fact.y"], []);
		const b = makeProvider("provider.b", ["fact.b"], ["fact.x", "fact.y"]);
		expect(scheduleProviders([b, a])).toEqual([a, b]);
	});

	it("runs a provider only after every distinct provider it requires, across waves", () => {
		// Kills `inDegree.get(p.id) ?? 0` -> `&& 0` (the second dependency was not
		// added to the count), `inDegree.set(depId, newDegree)` removed (counts
		// never fall, so a provider with two dependencies is reported as a cycle)
		// and `newDegree === 0` forced true (released after its FIRST dependency).
		// "provider.m" sorts before "provider.z", so a premature release would put
		// it ahead of the dependency it still waits for.
		const a = makeProvider("provider.a", ["fact.a"], []);
		const z = makeProvider("provider.z", ["fact.z"], ["fact.a"]);
		const m = makeProvider("provider.m", ["fact.m"], ["fact.a", "fact.z"]);
		expect(scheduleProviders([m, z, a])).toEqual([a, z, m]);
	});

	it("orders providers released in the same wave by id, whatever order they were registered in", () => {
		// Kills `nextWave.sort(...)` removed or comparator `() => undefined`:
		// the release order of a wave follows registration order unless sorted.
		const a = makeProvider("provider.a", ["fact.a"], []);
		const z = makeProvider("provider.z", ["fact.z"], ["fact.a"]);
		const m = makeProvider("provider.m", ["fact.m"], ["fact.a"]);
		expect(scheduleProviders([a, z, m]).map((p) => p.id)).toEqual([
			"provider.a",
			"provider.m",
			"provider.z",
		]);
	});

	it("names only the providers inside the cycle, sorted by id", () => {
		// Kills the cycle-participant mutants: the `filter` dropped (every provider
		// listed), the `sort` comparator `() => undefined` (input order kept) and
		// the `", "` separator emptied. The healthy provider must not be blamed.
		const ok = makeProvider("provider.ok", ["fact.ok"], []);
		const b = makeProvider("provider.b", ["fact.b"], ["fact.a"]);
		const a = makeProvider("provider.a", ["fact.a"], ["fact.b"]);
		// `toThrowError(string)` only checks a substring, so compare the whole
		// message: a list that also named the healthy provider must fail.
		expect(() => scheduleProviders([ok, b, a])).toThrowError(
			new Error("Cycle detected among FactProviders: provider.a, provider.b"),
		);
	});
});
