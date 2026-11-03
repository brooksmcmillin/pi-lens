import type { LSPServerInfo } from "./server.js";
import { isOptInAuxiliaryServerId } from "../dispatch/auxiliary-lsp.js";
import { getServersForFileWithConfig } from "./config.js";

/**
 * #4929: the servers the aggregate `clientScope: "all"` door may start for a
 * file. An opt-in auxiliary (off unless the operator turned it on) is never one
 * of them: that door takes its exclusions from the caller, and a caller with no
 * flag access, or one that never asked, would start a scanner the operator did
 * not enable. The per-edit `with-auxiliary` door admits an opt-in server by its
 * enabled id list instead (`getAuxiliaryClientsForFile`). The workspace sweep
 * groups by the same list, so a server the sweep never starts cannot make a
 * group read as multi-server (#4956 F1).
 */
export function aggregateServersForFile(filePath: string): LSPServerInfo[] {
	return getServersForFileWithConfig(filePath).flatMap((s) =>
		isOptInAuxiliaryServerId(s.id) ? [] : [s],
	);
}

export function groupFilesByPrimaryServer(
	files: readonly string[],
): Array<{ files: string[]; multiServer: boolean }> {
	const byServer = new Map<string, { files: string[]; multiServer: boolean }>();
	for (const filePath of files) {
		const servers = aggregateServersForFile(filePath);
		const primary = servers[0]?.id ?? "none";
		const group = byServer.get(primary);
		const fallbackFamilyHeads = new Map<string, string>();
		const familyHeads = servers.map((server) => {
			const head = server.fallbackFor
				? (fallbackFamilyHeads.get(server.fallbackFor) ?? server.fallbackFor)
				: server.id;
			fallbackFamilyHeads.set(server.id, head);
			return head;
		});
		const multiServer = new Set(familyHeads).size > 1;
		if (group) {
			group.files.push(filePath);
			if (multiServer) group.multiServer = true;
		} else {
			byServer.set(primary, { files: [filePath], multiServer });
		}
	}
	return [...byServer.values()];
}

export async function runPerServerGroups<
	G extends { files: readonly string[]; multiServer?: boolean },
>(
	groups: readonly G[],
	concurrency: number,
	processGroup: (group: G) => Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	let nextGroup = 0;
	const workers = Math.min(Math.max(1, concurrency), groups.length);
	await Promise.all(
		Array.from({ length: workers }, async () => {
			while (!signal?.aborted) {
				const gi = nextGroup;
				nextGroup += 1;
				if (gi >= groups.length) break;
				await processGroup(groups[gi]!);
			}
			return true;
		}),
	);
}
