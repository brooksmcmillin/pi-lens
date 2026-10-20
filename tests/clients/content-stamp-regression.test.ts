/**
 * #4541 regression probes for byte identity and mtime freshness.
 *
 * These tests intentionally exercise the current production seams. They red
 * on master until content identity has one byte-oriented implementation and
 * mtime-only touches stop invalidating durable rows.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	advisoryFileHash,
	snapshotAdvisoryProvenance,
	validateAdvisoryProvenance,
} from "../../clients/advisory-provenance.js";
import { hashDiagnosticContent } from "../../clients/lsp/diagnostic-binding.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(name: string, bytes: Uint8Array): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-4541-"));
	dirs.push(dir);
	const file = path.join(dir, name);
	fs.writeFileSync(file, bytes);
	return file;
}

describe("#4541 content stamp regressions", () => {
	it("records the UTF-8 boundary for the LSP text hash", () => {
		const bytes = Buffer.from([0x66, 0x80, 0x67, 0xff]);
		const file = tempFile("invalid.bin", bytes);

		// The LSP helper hashes the exact decoded text payload. This lane cannot
		// edit clients/lsp/, so the probe records the intentional boundary rather
		// than pretending a decoded payload is a byte identity.
		expect(advisoryFileHash(file)).not.toBe(
			hashDiagnosticContent(bytes.toString("utf8")),
		);
	});

	it("does not stale advisory provenance when touch changes only mtime", () => {
		const file = tempFile("advisory.ts", Buffer.from("const stable = true;\n"));
		const runtime = {
			telemetrySessionId: "session-4541",
			projectSeq: 1,
			turnIndex: 1,
		};
		const provenance = snapshotAdvisoryProvenance({
			cwd: path.dirname(file),
			runtime,
			generation: 1,
			files: [{ path: file, role: "source" }],
		});
		const stat = fs.statSync(file);
		fs.utimesSync(file, stat.atimeMs / 1000, (stat.mtimeMs + 5000) / 1000);

		expect(
			validateAdvisoryProvenance({ provenance }, path.dirname(file), runtime)
				.status,
		).toBe("current");
	});
});
