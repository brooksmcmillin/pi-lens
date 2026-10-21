export interface TouchDiagnostic {
	message?: string;
	source?: string;
	severity?: number;
	serverId?: string;
}
export declare function touchAnsweredDiagnostics(
	touched:
		| { diags?: TouchDiagnostic[]; inconclusiveReason?: string }
		| undefined,
	touchOptions: { auxiliaryServerIds?: readonly string[] } | undefined,
	service: { getAliveServerIds(): string[] },
): TouchDiagnostic[] | undefined;
