import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { Type } from "../clients/deps/typebox.js";
import { hashlineFixture } from "./support/hashline-anchor-vectors.js";
import { endTurn, step } from "./support/pi-session-commit-gate.js";
import {
	fauxToolCall,
	type PiSession,
	piSessionFixture,
	startPiSession,
} from "./support/pi-session.js";

/**
 * #2423 review round 1, finding F4.
 *
 * `index.ts` gated the `tool_result_received` latency marker on
 * `rtToolName === "edit" || rtToolName === "write"` — the sixteenth literal
 * comparison, missed by the class sweep because the grep guard walked only
 * `clients/`. The marker is the row that says "pi-lens received this edit"; its
 * absence is what made a wedged edit invisible in `latency.log`, and a
 * third-party edit tool got no row at all.
 *
 * Tier 2 (#4913 L3): a REAL pi session drives the tool calls, and the marker is
 * read back from the `latency.log` the LOADED copy wrote (`latencyRows()`), not
 * from a spy on `logLatency`. The read guard refuses an edit to a file the
 * session has not read, so each mutating call follows a `read` of its file.
 */

const fixture = piSessionFixture();

/**
 * A third-party edit tool. pi-lens classifies it from its hashline-shaped input
 * (`remove_from` / `remove_to`), so the body is a no-op: the marker records that
 * pi-lens received the result, not that the bytes changed.
 */
const replaceTool: ToolDefinition = {
	name: "replace",
	label: "Replace",
	description: "Replace a line range between two hashline anchors.",
	parameters: Type.Object({
		path: Type.String(),
		remove_from: Type.String(),
		remove_to: Type.String(),
		replacement_lines: Type.Array(Type.String()),
	}),
	async execute() {
		return {
			content: [{ type: "text", text: "replaced" }],
			details: undefined,
		};
	},
};

/** One case's project directory and the file it reads and edits. */
function fixtureFile(name: string): { cwd: string; filePath: string } {
	const cwd = path.join(fixture.root, name, "proj");
	fs.mkdirSync(cwd, { recursive: true });
	const filePath = path.join(cwd, "edited.ts");
	fs.writeFileSync(filePath, hashlineFixture("simple").content, "utf8");
	return { cwd, filePath };
}

/** The marker rows the loaded copy wrote for one file, in order. */
async function markersFor(
	handle: PiSession,
	filePath: string,
): Promise<Array<Record<string, unknown>>> {
	const read = await handle.latencyRows();
	expect(read.skipped).toBe(0);
	return read.rows.filter(
		(row) => row.phase === "tool_result_received" && row.filePath === filePath,
	);
}

describe("#2423 the tool_result latency marker asks the seam", () => {
	it("marks a third-party edit tool's result", async () => {
		const { cwd, filePath } = fixtureFile("marker-third-party");
		const anchors = hashlineFixture("simple");
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			customTools: [replaceTool],
			responses: [
				step(fauxToolCall("read", { path: filePath }), "reading"),
				endTurn("read"),
				step(
					fauxToolCall("replace", {
						path: filePath,
						remove_from: anchors.anchorFor(2),
						remove_to: anchors.anchorFor(3),
						replacement_lines: ["const b = 20;"],
					}),
					"replacing",
				),
				endTurn("replaced"),
			],
		});
		await handle.prompt("read the file");
		await handle.prompt("replace lines 2 and 3");

		expect(await markersFor(handle, filePath)).toEqual([
			expect.objectContaining({
				phase: "tool_result_received",
				filePath,
				metadata: expect.objectContaining({
					toolName: "replace",
					mutationKind: "edit",
				}),
			}),
		]);
		expect(handle.errors).toEqual([]);
	}, 60_000);

	it("still marks pi's own edit tool, and still ignores a read", async () => {
		const { cwd, filePath } = fixtureFile("marker-builtin");
		const handle = await startPiSession({
			root: fixture.root,
			cwd,
			responses: [
				step(fauxToolCall("read", { path: filePath }), "reading"),
				endTurn("read"),
				step(
					fauxToolCall("edit", {
						path: filePath,
						edits: [{ oldText: "const c = 3;", newText: "const c = 4;" }],
					}),
					"editing",
				),
				endTurn("edited"),
				step(fauxToolCall("read", { path: filePath }), "reading again"),
				endTurn("read again"),
			],
		});
		await handle.prompt("read the file");
		await handle.prompt("edit the file");
		expect(await markersFor(handle, filePath)).toHaveLength(1);

		await handle.prompt("read it again");
		expect(await markersFor(handle, filePath)).toHaveLength(1);
		expect(handle.errors).toEqual([]);
	}, 60_000);
});
