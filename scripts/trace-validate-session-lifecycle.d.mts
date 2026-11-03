export type TraceEvent =
	| { a: "retire"; k: string; scope: number }
	| {
			a: "begin";
			k: string;
			scope: number;
			role: "primary";
			parent: number;
			src: "slot" | "other";
			sameAs: number[];
	  }
	| { a: "continue"; scope: number; effect: "ctx-read" };
export type TraceVerdict =
	| { status: "producible" }
	| { status: "not-producible"; searchDepth: number | undefined }
	| { status: "error"; detail: string };
export declare function extractTraces(
	rows: ReadonlyArray<Record<string, unknown>>,
): Array<{ pid: number; events: TraceEvent[]; rejected: string[] }>;
export declare function unsupportedReason(
	events: ReadonlyArray<TraceEvent>,
): string | undefined;
export declare function renderTraceModule(
	events: ReadonlyArray<TraceEvent>,
): string;
export declare function renderTraceConfig(
	baseConfig: string,
	retires: number,
): string;
export declare function firstUnmatchedEvent(
	events: ReadonlyArray<TraceEvent>,
	searchDepth: number | undefined,
): number | undefined;
export declare function classifyTraceOutput(output: string): TraceVerdict;
export declare function checkTrace(
	events: ReadonlyArray<TraceEvent>,
	options: { jar: string },
): Promise<TraceVerdict & { seconds: number }>;
export declare function readJsonRecords(text: string): unknown[];
export declare function loadTraces(
	text: string,
	source: { kind: "rows" | "events"; file: string },
): Array<{ pid: number; events: TraceEvent[]; rejected: string[] }>;
export declare function runCli(
	argv: string[],
	log?: (line: string) => void,
): Promise<number>;
