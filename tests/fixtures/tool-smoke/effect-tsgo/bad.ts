// Known defect: assigning a string to a number — the project-local
// `effect-tsgo tsc --lsp --stdio` server (@effect/tsgo on TypeScript 7) must
// flag this as a type error (tool-smoke fixture for #4914).
export const count: number = "not a number";

export function double(n: number): number {
	return n * 2;
}
