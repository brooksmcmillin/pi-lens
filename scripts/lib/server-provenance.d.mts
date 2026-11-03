// Type declarations for server-provenance.mjs (untyped .mjs imported from .ts tests).

export function versionToken(output: unknown): string | undefined;

export function serverToolId(fixture: { tools?: string[] }): string | undefined;

export function readVersionFromBinary(
	binPath: string | undefined,
	args?: readonly string[],
	timeoutMs?: number,
): string | undefined;

export function collectServerProvenance(
	fixtures: ReadonlyArray<{ lang: string; tools?: string[] }>,
	facts: {
		statuses: ReadonlyArray<{
			id: string;
			installed: boolean;
			source: string;
			path?: string;
		}>;
		readVersion?: (status: {
			id: string;
			installed: boolean;
			source: string;
			path?: string;
		}) => string | undefined;
	},
): Map<string, { install: string; version?: string }>;

export function resolveFixtureProvenance(
	fixtures: Array<{ lang: string; tools?: string[] }>,
	installer: {
		TOOLS: Array<{ id: string; verification?: string; checkArgs?: string[] }>;
		getToolVerificationTimeout(tool: object): number;
		getAllToolStatuses(
			ids: string[],
		): Promise<
			Array<{ id: string; installed: boolean; source: string; path?: string }>
		>;
	},
	readVersion?: (
		binPath: string | undefined,
		args: readonly string[],
		timeoutMs: number,
	) => string | undefined,
): Promise<Map<string, { install: string; version?: string }>>;
