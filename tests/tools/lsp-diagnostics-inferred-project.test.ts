/**
 * #1645 review F3: `lsp_diagnostics` writes the SAME widget store as
 * `lens_diagnostics mode=full`. One store, one demotion rule — otherwise an
 * orphan file blocks or does not depending purely on which tool ran last.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetWarmAttachForTests } from "../../clients/warm-attach.js";
import {
	clearWidgetState,
	getFileDiagnostics,
} from "../../clients/widget-state.js";
import { removeTempDirSync } from "../clients/test-utils.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import { installLspService } from "../support/lsp-service-seam.js";

vi.mock("../../clients/lsp/wait-policy/index.js", () => ({
	classifyCascadeWaitTier: () => "waits",
}));

beforeEach(() => {
	_resetWarmAttachForTests();
	clearWidgetState();
});
afterEach(() => {
	_resetWarmAttachForTests();
	clearWidgetState();
});

import { createLspDiagnosticsTool } from "../../tools/lsp-diagnostics.js";

const INFERRED_BODY = { configFileName: "/dev/null/inferredProject1*" };

function makeService() {
	return makeLspServiceDouble({
		getDiagnostics: vi.fn(async () => [
			{
				severity: 1,
				message: "Cannot find name 'describe'.",
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 8 },
				},
				source: "typescript",
				code: 2582,
			},
		]),
		getDiagnosticsHealth: vi.fn().mockReturnValue(undefined),
		getCapabilitySnapshots: vi.fn().mockResolvedValue([]),
		runWorkspaceDiagnostics: vi.fn(),
		executeReadOnlyCommandOnLiveClient: vi.fn(async () => ({
			executed: true,
			result: { success: true, body: INFERRED_BODY },
		})),
		// #2598: the tool touches unconditionally now. `undefined` is the real
		// `touchFile`'s answer when it resolves no client for the file
		// (clients/lsp/index.ts, `no_clients`), which is what routes this case
		// through `getDiagnostics` — the source of the demotable TS error the
		// demotion under test has to rewrite.
		touchFile: vi.fn(async () => undefined),
	});
}

describe("lsp_diagnostics — inferred-project demotion (#1645 F3)", () => {
	let cwd: string;

	beforeEach(async () => {
		installLspService(makeService());
		cwd = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lspdiag-inferred-")),
		);
		fs.mkdirSync(path.join(cwd, "tests"), { recursive: true });
	});

	it("writes DEMOTED diagnostics into the shared widget store", async () => {
		const file = path.join(cwd, "tests", "spawn.test.ts");
		fs.writeFileSync(file, "describe('spawn', () => {});\n");
		try {
			const result = (await createLspDiagnosticsTool().execute(
				"diag-inferred",
				{ paths: [file], severity: "all" },
				new AbortController().signal,
				null,
				{ cwd },
			)) as unknown as { content: Array<{ text: string }> };

			const written = getFileDiagnostics(file);
			expect(written).toBeDefined();
			expect(written?.length).toBeGreaterThan(0);
			// The store must not receive a blocker for a file no tsconfig owns.
			expect(written?.every((d) => d.semantic !== "blocking")).toBe(true);
			expect(written?.[0]?.message).toContain(
				"not in any tsconfig project — checked with inferred settings",
			);
			// …and the tool's own text agrees with what it wrote.
			expect(String(result.content[0]?.text)).toContain(
				"not in any tsconfig project",
			);
		} finally {
			removeTempDirSync(cwd);
		}
	});
});
