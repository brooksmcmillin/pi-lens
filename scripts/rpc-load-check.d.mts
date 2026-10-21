export const FORCE_WORKER_FAIL_ENV: string;
export const FORCED_ERROR_MARKER: string;
export function rpcMessageFailure(message: unknown): string | undefined;
export function logRecordFailure(
	file: "extension.log" | "latency.log",
	record: unknown,
	allowFallbackReason?: string,
): string | undefined;
export function isExtensionError(message: unknown): boolean;
export interface RpcSession {
	child: import("node:child_process").ChildProcess;
	failures: string[];
	extensionErrors: unknown[];
	stderrTail: string[];
	exited: { code: number | null; signal: string | null } | undefined;
	commandsResponse: { data?: { commands?: unknown[] } } | undefined;
	agentEnd:
		| { messages?: Array<{ role?: string; stopReason?: string }> }
		| undefined;
	onMessage(fn: (message: Record<string, unknown>) => void): void;
	onExit(fn: (code: number | null, signal: string | null) => void): void;
	send(message: unknown): void;
	kill(): void;
}
export function startRpcSession(
	piBin: string,
	options: {
		args: string[];
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		shell?: boolean;
		stderr?: "pipe" | "inherit";
	},
): RpcSession;
export function run(
	piBin: string,
	options: { extension?: string; failWorker?: boolean },
): Promise<{ code: number; installFailed: boolean }>;

export function tsServerOutcome(
	latencyRecords: ReadonlyArray<Record<string, any>>,
	sessionstartText: string,
): { started: true } | { started: false; line: string } | undefined;
