// Fixture for the mutate.test.ts table-row case (#4490 L1): a failed test title
// holding a pipe, which the mutation-table row pastes into PR_BODY.md. The
// needle line is what mutate.test.ts mutates to make this test red.
import { expect, it } from "vitest";

const mutatePipeMarker = true;

it("pipe | in a title", () => {
	expect(mutatePipeMarker).toBe(true);
});
