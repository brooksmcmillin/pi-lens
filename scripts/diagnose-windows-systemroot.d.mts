export interface SpawnObservation {
	label: string;
	durationMs: number;
	status: number | null;
	signal: NodeJS.Signals | null;
	error: { code: string | null; message: string } | null;
	stdout: string;
	stderr: string;
	stdoutOmitted: number;
	stderrOmitted: number;
}

export function observe(
	label: string,
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	windowsVerbatimArguments: boolean,
): SpawnObservation;
export function checkLiteralArgument(observation: SpawnObservation): {
	label: string;
	passed: boolean;
};
export function main(): Promise<number>;
