/**
 * #4589 baseline: the started servers already unproven on master, admitted so the sweep is a ratchet, not a mass edit.
 *
 * A row is `<file>:<receiver>`, keyed on the file and the started binding,
 * never on a line. It means "this start is not PROVABLY closed and awaited
 * here", so a row in a file that does close its server is honest: it shrinks
 * when the file is made readable. Why each row is admitted, and the close
 * evidence the detector found instead, lives in
 * `test-server-teardown-admissions.ts`; every row here must have an entry
 * there.
 */

export const TEST_SERVER_TEARDOWN_BASELINE: readonly string[] = [
	"tests/clients/mcp/ipc.test.ts:activeServer",
	"tests/clients/warm-attach.test.ts:sessionA",
	"tests/clients/warm-attach.test.ts:silent",
	"tests/mcp/analyze-cli.test.ts:server",
];
