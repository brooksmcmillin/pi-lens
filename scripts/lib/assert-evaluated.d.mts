export const MAX_DROP_FRACTION: number;
export const EVALUATED_DIR_ENV: string;

export interface EvaluatedRecord {
	producer: string;
	evaluated: number;
	floor: number;
	prevEvaluated: number | null;
	ok: boolean;
	reason: string;
}

export interface EvaluatedProducer {
	floor: number;
	doc?: {
		path: string;
		floor: number;
		count(text: string): number | null;
		comparableToRecord?: boolean;
		cells?: boolean;
	};
}

export const EVALUATED_PRODUCERS: Record<string, EvaluatedProducer>;

export function assertEvaluated(input: {
	producer: string;
	evaluated: number;
	expectedAtLeast: number;
	previous?: number | null;
}): EvaluatedRecord;

export function missingRecord(
	producer: string,
	floor: number,
	previous?: number | null,
): EvaluatedRecord;

export const EVALUATED_COUNTS: Record<string, (input: any) => number>;

export function countEvaluated(producer: string, input: unknown): number;

export function matrixCells(text: string): Map<string, string> | null;

export function lostClassifiedCells(headText: string, text: string): string[];

export function writeEvaluatedRecord(input: {
	producer: string;
	input: unknown;
}): void;

export function readEvaluatedRecord(
	dir: string,
	producer: string,
): number | null;
