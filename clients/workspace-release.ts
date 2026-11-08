import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute } from "node:path";
import { getLSPService } from "./lsp/capabilities.js";
import { isSameOrWithin } from "./lsp/server.js";
import { realpathOrResolve } from "./path-utils.js";

/** In-process handshake only: callers await every owner before probing OS liveness. */
export interface WorkspaceReleaseRequest {
	root: string;
	pending: Promise<string[]>[];
}

export function registerWorkspaceRelease(
	pi: Pick<ExtensionAPI, "events">,
): () => void {
	return pi.events.on("pilens:workspace:release", (data) => {
		const request = data as WorkspaceReleaseRequest;
		if (
			!request ||
			typeof request.root !== "string" ||
			!Array.isArray(request.pending)
		)
			return;
		request.pending.push(
			(async () => {
				if (!isAbsolute(request.root))
					throw new Error("Workspace release requires an absolute path");
				const root = realpathOrResolve(request.root);
				if (isSameOrWithin(root, realpathOrResolve(process.cwd()))) {
					throw new Error(
						"Cannot release the workspace containing the Pi process cwd",
					);
				}
				return getLSPService().releaseWorkspace(root);
			})(),
		);
	});
}
