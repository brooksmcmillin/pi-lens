/**
 * The seam's per-install reset, observed through the surface production reads
 * (#4720 review F1/F2, on #4709's helper).
 *
 * Recurrence: deleting `resetInstalledLspService()` from either installer left
 * all 165 cases of the moved files green, because every override in those files
 * is a file-scoped hoisted spy and a stale cached double answers identically to
 * a fresh one. The next slice installs a DIFFERENT double per case, so the reset
 * is the only thing that makes a reinstall produce a new service.
 *
 * Each case installs twice inside itself, so the witness depends on no sibling
 * case's state (AGENTS.md test screen: a case never reads what a sibling wrote).
 */
import { describe, expect, it, vi } from "vitest";
import {
	getLSPService,
	resetLSPService,
} from "../../clients/lsp/capabilities.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
import {
	installLspService,
	installLspServiceDouble,
} from "../support/lsp-service-seam.js";

describe("installLspServiceDouble replaces the cached service", () => {
	it("reads the second double after a second install", async () => {
		await installLspServiceDouble({ getAliveClientCount: () => 1 });
		expect(getLSPService().getAliveClientCount()).toBe(1);
		await installLspServiceDouble({ getAliveClientCount: () => 2 });
		expect(getLSPService().getAliveClientCount()).toBe(2);
	});
});

describe("installLspService replaces the cached service", () => {
	it("reads the second double after a second install", () => {
		installLspService(makeLspServiceDouble({ getAliveClientCount: () => 1 }));
		expect(getLSPService().getAliveClientCount()).toBe(1);
		installLspService(makeLspServiceDouble({ getAliveClientCount: () => 2 }));
		expect(getLSPService().getAliveClientCount()).toBe(2);
	});
});

/**
 * The two seam forms #4709 slice 1b added for the files that mocked
 * `getLSPService: vi.fn()` (no service until a case sets one) and
 * `resetLSPService` (a spy on the reset call).
 *
 * Recurrence: a file moved off `vi.mock("…/capabilities.js")` that asserts on
 * the module-level reset CALL (`index-lsp-idle-reset`, `index-integration`) or
 * on the absence of a service (`pipeline-lsp-sync`'s "failed: the service
 * lookup threw") stays green only if these forms reach the same surface
 * production reads. Each case installs inside itself, so none reads a sibling's
 * state.
 */
describe("installLspServiceDouble(null) installs no service", () => {
	it("makes getLSPService() throw until a service is installed again", async () => {
		await installLspServiceDouble({ getAliveClientCount: () => 1 });
		expect(getLSPService().getAliveClientCount()).toBe(1);

		await installLspServiceDouble(null);
		expect(() => getLSPService()).toThrow(/no LSP service installed/);

		installLspService(makeLspServiceDouble({ getAliveClientCount: () => 3 }));
		expect(getLSPService().getAliveClientCount()).toBe(3);
	});
});

describe("installLspServiceDouble({ beforeReset }) observes the reset call", () => {
	it("hands the hook the options resetLSPService was called with", async () => {
		const beforeReset = vi.fn();
		await installLspServiceDouble({}, { beforeReset });
		const reason = {
			fast: true,
			processExiting: true,
			reason: "session_shutdown",
		};

		resetLSPService(reason);
		resetLSPService({ reason: "idle" });

		expect(beforeReset.mock.calls).toEqual([[reason], [{ reason: "idle" }]]);
	});

	it("is dropped by the next install, so a case never hears a sibling's reset", async () => {
		const first = vi.fn();
		await installLspServiceDouble({}, { beforeReset: first });
		await installLspServiceDouble({});
		// The second install's reset-first step ran the first lifecycle's hook once,
		// with no options; what matters is that the reset after it is not heard.
		// The first assertion is the red: a seam that never installs the hook
		// (pre-fix) never calls `first` here, so the case reds on it.
		expect(first).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenCalledWith({});
		first.mockClear();

		resetLSPService({ reason: "idle" });

		expect(first).not.toHaveBeenCalled();
	});
});
