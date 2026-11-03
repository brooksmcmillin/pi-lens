/**
 * `dispatch.disabledRunners`: the operator's denial list for dispatch
 * runners. The runner-level sibling of `lsp.disabledServers`.
 *
 * RESOLUTION. The schema (`clients/config-schema.ts`) annotates the key
 * `array-union`, so `resolvePiLensConfig` hands this module the UNION of every
 * tier's members: `~/.pi-lens/config.json`, the project `.pi-lens.json`, and
 * each nested one. A nearer tier can add a runner and can never re-enable one a
 * farther tier denied, which is what lets a user switch a runner off once for
 * every project without a repository lifting the denial. The dispatcher hands
 * it the file's config-owner resolution (`resolveDispatchPolicyConfigForFile`),
 * the same one `rules` reads, so a nested file governs only its own files.
 *
 * SEMANTICS. A disabled runner never runs: the dispatcher skips it with
 * {@link DISABLED_BY_CONFIG_SKIP_REASON} before its `when` or `run`, so its tool
 * never spawns. The skip is an operator decision, not a failure — it carries a
 * stated skip reason, so it is never counted as a runner that broke, and a
 * `mode: "fallback"` group moves on to the next member exactly as it does for
 * any other skip. Other runners in the group are untouched.
 *
 * IDENTITY. An id that names no registered runner is dropped with a
 * `PILENS_CFG_0005` record naming it (a typo must not read as a runner that was
 * turned off). Identity comes from the registry (`known-runner-ids.ts`); when no
 * registry has populated the process yet the entry is kept unvalidated, the
 * same fail direction `lsp.servers.<id>.covers` takes.
 */

import {
	type PiLensConfigResolution,
	reportPiLensConfigRecords,
} from "../config-resolve.js";
import {
	boundedKeyLabel,
	finalizeRecords,
	type MigrationRecord,
	migrationSubject,
} from "../config-core/records.js";
import type { Provenance } from "../config-core/provenance.js";
import {
	isKnownRunnerId,
	runnerIdentityPopulated,
} from "./known-runner-ids.js";

/** The closed skip reason a disabled runner reports (`RUNNER_SKIP_REASONS`). */
export const DISABLED_BY_CONFIG_SKIP_REASON = "disabled-by-config" as const;

/** JSON pointer of the denial list inside the resolved value. */
const DISABLED_RUNNERS_POINTER = "/dispatch/disabledRunners";

/** One denied runner and the config leaf that denied it. */
interface DisabledRunner {
	readonly id: string;
	/** The tier and file that first contributed this member, when known. */
	readonly decidedBy?: Provenance;
}

interface DisabledRunnersResolution {
	/** Denied runner ids that name a registered runner, in resolved order. */
	readonly runners: readonly DisabledRunner[];
	/** `PILENS_CFG_0005` records for members that name no registered runner. */
	readonly records: readonly MigrationRecord[];
}

function memberPointer(index: number): string {
	return `${DISABLED_RUNNERS_POINTER}/${index}`;
}

/**
 * The provenance of the member at `index`, falling back to the array's own
 * entry (`merge()` records one for the array and one per surviving member).
 */
function memberProvenance(
	resolution: PiLensConfigResolution,
	index: number,
): Provenance | undefined {
	return (
		resolution.provenance.get(memberPointer(index)) ??
		resolution.provenance.get(DISABLED_RUNNERS_POINTER)
	);
}

function dispatchSection(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const section = value.dispatch;
	return section && typeof section === "object" && !Array.isArray(section)
		? (section as Record<string, unknown>)
		: {};
}

/**
 * The denied runners of one resolution, validated against the registry.
 *
 * Pure: reads the resolution and the identity registry and writes nothing.
 * {@link disabledRunnerIdsFor} bounds and reports the records.
 */
export function disabledRunnersOf(
	resolution: PiLensConfigResolution,
): DisabledRunnersResolution {
	const members = dispatchSection(resolution.value).disabledRunners;
	if (!Array.isArray(members)) return { runners: [], records: [] };
	const validate = runnerIdentityPopulated();
	const seen = new Set<string>();
	const runners: DisabledRunner[] = [];
	const records: MigrationRecord[] = [];
	members.forEach((member, index) => {
		// validate() already dropped non-string members at the leaf; this keeps a
		// hand-built resolution from smuggling one through.
		if (typeof member !== "string" || seen.has(member)) return;
		const decidedBy = memberProvenance(resolution, index);
		if (validate && !isKnownRunnerId(member)) {
			const pointer = memberPointer(index);
			const file = decidedBy?.file ?? resolution.documents.at(-1)?.file ?? "";
			records.push({
				code: "PILENS_CFG_0005",
				file,
				key: pointer,
				subject: migrationSubject(file, pointer),
				reason:
					`dispatch.disabledRunners entry "${boundedKeyLabel(member)}" ` +
					"is not a recognized dispatch runner id; dropped",
				...(decidedBy?.tier ? { tier: decidedBy.tier } : {}),
			});
			return;
		}
		seen.add(member);
		runners.push({ id: member, ...(decidedBy ? { decidedBy } : {}) });
	});
	return { runners, records };
}

/**
 * The denied ids a dispatch consults. Reports the unknown-entry records (the
 * warn-once latch makes the per-dispatch call cheap) and returns the ids, or
 * `undefined` when nothing is denied — the hot path for almost every project.
 */
export function disabledRunnerIdsFor(
	resolution: PiLensConfigResolution,
): ReadonlySet<string> | undefined {
	const resolved = disabledRunnersOf(resolution);
	if (resolved.records.length > 0) {
		// A pasted list can name any number of unknown ids; bound the notices the
		// way every other config record is (`MAX_MIGRATION_RECORDS`, one slot for
		// the suppression count), anchored at the last record: the
		// highest-precedence document, whose entries the bound drops first. The
		// list spans tiers, so member zero can belong to a tier that lost nothing.
		const anchor = resolved.records.at(-1);
		const file = anchor?.file ?? resolution.documents.at(-1)?.file ?? "";
		reportPiLensConfigRecords(
			finalizeRecords(resolved.records, {
				file,
				...(anchor?.tier ? { tier: anchor.tier } : {}),
			}),
		);
	}
	return resolved.runners.length === 0
		? undefined
		: new Set(resolved.runners.map((runner) => runner.id));
}
