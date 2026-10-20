import { describe, expect, it } from "vitest";
import { FactStore } from "../../../clients/dispatch/fact-store.js";
import {
	functionFactProvider,
	type FunctionSummary,
} from "../../../clients/dispatch/facts/function-facts.js";

async function run(content: string): Promise<FunctionSummary[]> {
	const facts = new FactStore();
	const filePath = "/tmp/fn-single-walk.ts";
	facts.setFileFact(filePath, "file.content", content);
	await functionFactProvider.run({ filePath } as never, facts);
	return (
		facts.getFileFact<FunctionSummary[]>(filePath, "file.functionSummaries") ??
		[]
	);
}
const get = (s: FunctionSummary[], name: string) =>
	s.find((f) => f.name === name)!;

// Recurrence: refs #1740 folded seven per-field body walks into one pass.
// A wrong attribution (stopping at nested functions, or gating a field on
// depth) would change every summary field with no other test failing.
describe("functionFactProvider - one pass over each body", () => {
	it("attributes nested function content to every enclosing function", async () => {
		const s = await run(`
function outer(a: Foo) {
  const inner = async () => {
    const d = new Qux();
    await d.run();
    return await fetch("x");
  };
  return inner();
}`);
		const outer = get(s, "outer");
		const inner = get(s, "inner");
		for (const fn of [outer, inner]) {
			expect(fn.hasAwait).toBe(true);
			expect(fn.hasReturnAwaitCall).toBe(true);
			expect(fn.outgoingCalls).toEqual(
				fn === outer ? ["d.run", "fetch", "inner"] : ["d.run", "fetch"],
			);
			expect(fn.memberCallSites).toEqual([{ receiver: "d", method: "run" }]);
		}
		expect(outer.receiverTypes).toEqual({ a: "Foo", d: "Qux" });
		expect(inner.receiverTypes).toEqual({ d: "Qux" });
	});

	it("counts nested branches in the outer function and measures absolute depth", async () => {
		const s = await run(`
function outer(x: number) {
  const f = () => { if (x) { for (const y of [x]) { y; } } };
  return x ? 1 : 2;
}
function flat() { return 1; }`);
		// 1 + if + for-of + ternary.
		expect(get(s, "outer").cyclomaticComplexity).toBe(4);
		expect(get(s, "outer").maxNestingDepth).toBe(2);
		expect(get(s, "f").maxNestingDepth).toBe(2);
		// The body block itself is not a nesting level.
		expect(get(s, "flat").maxNestingDepth).toBe(0);
	});

	it("flags return await only for `return await call()`", async () => {
		const s = await run(`
async function yes() { return await foo(); }
async function noCall() { return await foo; }
async function noAwait() { return foo()(); }
async function nested() { const g = async () => { return await foo(); }; return g; }`);
		expect(get(s, "yes").hasReturnAwaitCall).toBe(true);
		expect(get(s, "noCall").hasReturnAwaitCall).toBe(false);
		expect(get(s, "noAwait").hasReturnAwaitCall).toBe(false);
		expect(get(s, "nested").hasReturnAwaitCall).toBe(true);
	});

	it("keeps member call sites to plain `identifier.method()` receivers", async () => {
		const s = await run(`
function f(a: A) { a.b(); a.b.c(); a().d(); this.e(); a[0].g(); }`);
		expect(get(s, "f").memberCallSites).toEqual([
			{ receiver: "a", method: "b" },
		]);
	});

	it("lets a later `new` assignment override a typed parameter", async () => {
		const s = await run(`
function f(a: Foo) { const a2 = new Bar(); const a = new Baz(); a.go(); }`);
		expect(get(s, "f").receiverTypes).toEqual({ a: "Baz", a2: "Bar" });
	});

	it("drops callee text of 80 characters or more from outgoingCalls", async () => {
		const long = "a".repeat(40) + "." + "b".repeat(39); // 80 chars
		const short = "a".repeat(40) + "." + "b".repeat(38); // 79 chars
		const s = await run(`function f(a: A) { ${long}(); ${short}(); }`);
		expect(get(s, "f").outgoingCalls).toEqual([short]);
	});
});
