/**
 * contract-surface — write-time slice plumbing W1: state stamps, the persisted .knowledge.json stamp, and slice views. Layer doctrine: ./types.ts.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { stateFileFor } from "../../state/state-root.ts";
import { extractContractInventory } from "./inventory.ts";
import { buildContractSlice } from "./slice.ts";
import type { ContractSlice } from "./slice.ts";
import type { ContractInventory } from "./types.ts";

// ─── write-time slice plumbing (W1) ──────────────────────────────────────

/** Compute a stage's write-time slice (059 §3 W1): fresh inventory walk + the
 *  touched-set over the evaluated texts (task + classify + upstream control
 *  JSON for 2B; upstream artifacts for later stages). Returns null when the
 *  worktree is absent or the walk itself failed (DEC-4 absent-tree
 *  fail-open — the injection is simply omitted). */
export function writerContractSlice(worktreePath: string | undefined, texts: Array<string | undefined | null>): ContractSlice | null {
	if (!worktreePath) return null;
	try {
		const inventory = extractContractInventory(worktreePath);
		return buildContractSlice({ inventory, texts });
	} catch {
		return null;
	}
}

const SLICE_STAMP_PREFIX = "__contractSlice:";

/** An all-empty slice view (validators use it when no context is available —
 *  every check no-ops, fail-open harmless). */
export const EMPTY_CONTRACT_SLICE: ContractSlice = { empty: true, block: "", pinCount: 0, truncated: false, unmappedConcepts: [], files: [], pinIds: [] };

export interface ContractSliceStamp {
	files: Set<string>;
	pinIds: Set<string>;
	/** The inventory the slice derived from (same-process reuse: the stage's
	 *  writer computed it this round; validators must not re-walk). */
	inventory?: ContractInventory;
}

/** Stamp a stage's slice identity on the pipeline state (the R4 exemption's
 *  `injectedSlice` source — the review loop reads what the writer saw).
 *  v0.4.12 (live resume incident): the stamp ALSO persists to the track's
 *  external .knowledge.json (files + pinIds only) — the state copy dies with
 *  the process, and a resume re-walking fresh validated REPLAYED artifacts
 *  against a LATER inventory (pins minted by docs written after the artifact)
 *  — the temporal hole that rejected a replayed BDD round live. */
export function stampContractSlice(state: Record<string, unknown>, stage: string, slice: ContractSlice, inventory?: ContractInventory): void {
	// v0.4.13: STATE ONLY — the prompt-build path re-stamps on EVERY dispatch
	// (memo-hit rounds included), so persisting here let a replay round pollute
	// the persisted truth with a fresh walk before its validation read it (the
	// bootstrap stamp was overwritten exactly this way). Persistence moved to
	// the memoizer's LIVE-append path (persistCurrentStateStamp).
	state[`${SLICE_STAMP_PREFIX}${stage}`] = { files: slice.files, pinIds: slice.pinIds, ...(inventory ? { inventory } : {}) };
}

/** v0.4.13: persist the CURRENT state stamp for a stage — invoked from the
 *  resume memoizer's LIVE-append path only (a completed live writer round is
 *  the only event whose write-time slice is truth worth persisting). */
export function persistCurrentStateStamp(state: Record<string, unknown>, stage: string): void {
	const v = state[`${SLICE_STAMP_PREFIX}${stage}`] as { files?: unknown; pinIds?: unknown } | undefined;
	if (!v || !Array.isArray(v.files) || !Array.isArray(v.pinIds)) return;
	persistStampToKnowledge(state, stage, { files: v.files as string[], pinIds: v.pinIds as string[] } as ContractSlice);
}

/** v0.4.14: monotonic tmp-name counter for stamp writes (F-08 — same-ms
 *  writes would otherwise reuse an identical tmp basename). */
let stampTmpSeq = 0;

function persistStampToKnowledge(state: Record<string, unknown>, stage: string, slice: ContractSlice): void {
	let tmpWritten: string | undefined;
	try {
		const specDir = (state.setup as { specDirectory?: string } | undefined)?.specDirectory;
		if (!specDir) return;
		const rf = readFileSync, wf = writeFileSync, md = mkdirSync, rn = renameSync;
		const path = stateFileFor(specDir, ".knowledge.json");
		md(dirname(path), { recursive: true });
		let knowledge: Record<string, unknown> = {};
		try { knowledge = JSON.parse(rf(path, "utf8") as string) as Record<string, unknown>; } catch { /* absent — create */ }
		const stages = (knowledge.stages as Record<string, { data?: Record<string, unknown> }> | undefined) ?? {};
		const entry = stages[stage] ?? {};
		entry.data = { ...(entry.data ?? {}), __contractSliceStamp: { files: [...slice.files], pinIds: [...slice.pinIds] } };
		stages[stage] = entry;
		knowledge.stages = stages;
		// v0.4.14 (dual-gate F2/B2): ATOMIC write (tmp + rename) — G31/F-08's
		// crash-safety technique. A torn write here corrupts the whole store:
		// appendToKnowledge would reset it to {stages:{}} and every reader
		// (amendmentExemptFiles, loadPersistedStamp) fails closed to zero
		// exemptions/stamps. Same-process interleaving is impossible (both writers
		// synchronous), so the surviving window is cross-process only, and THAT is
		// serialized by the run lock (setup.ts), not by this rename — rename closes
		// TORN writes, not concurrent lost updates (dual-gate v0.4.16 nit).
		tmpWritten = `${path}.tmp-stamp-${process.pid}-${Date.now()}-${stampTmpSeq++}`;
		wf(tmpWritten, JSON.stringify(knowledge), "utf8");
		rn(tmpWritten, path);
		tmpWritten = undefined; // renamed — nothing to clean
	} catch (err) {
		// P10 (dual-gate F2/v0.4.16): name WHAT was lost and WHY — a silent catch
		// made an ENOSPC/EACCES stamp loss undiagnosable on the next resume.
		console.error(`[super-dev] persistStampToKnowledge: writing the slice stamp for stage "${stage}" FAILED (${err instanceof Error ? err.message : String(err)}) — the stamp degrades to the fresh re-walk (pre-v0.4.12 behavior)`);
		if (tmpWritten) { try { unlinkSync(tmpWritten); } catch { /* best-effort cleanup of the orphaned tmp */ } }
	}
}

function loadPersistedStamp(state: Record<string, unknown>, stage: string): ContractSliceStamp | undefined {
	try {
		const specDir = (state.setup as { specDirectory?: string } | undefined)?.specDirectory;
		if (!specDir) return undefined;
		const rf = readFileSync;
		const knowledge = JSON.parse(rf(stateFileFor(specDir, ".knowledge.json"), "utf8") as string) as { stages?: Record<string, { data?: { __contractSliceStamp?: { files?: unknown; pinIds?: unknown } } }> };
		const stamp = knowledge.stages?.[stage]?.data?.__contractSliceStamp;
		if (!stamp || !Array.isArray(stamp.files) || !Array.isArray(stamp.pinIds)) return undefined;
		return { files: new Set(stamp.files as string[]), pinIds: new Set(stamp.pinIds as string[]) };
	} catch { return undefined; }
}

/** Read the STATE-ONLY slice stamp — the fresh write-time walk the stage just
 *  stamped (design.ts stamps even on its skip path). v0.4.16 (atria gate AV4):
 *  ROUTING decisions about the CURRENT tree must read the fresh state stamp,
 *  NOT the persisted one — disk-first serves `contractValidationContext` (the
 *  consumer that needs the last-live round's truth for replay coherence), but
 *  a routing predicate reading a stale persisted stamp can bypass design
 *  review or burn a null-producing stage to the cap. */
export function readStateSliceStamp(state: Record<string, unknown>, stage: string): ContractSliceStamp | undefined {
	const v = state[`${SLICE_STAMP_PREFIX}${stage}`] as { files?: unknown; pinIds?: unknown; inventory?: ContractInventory } | undefined;
	if (!v || !Array.isArray(v.files) || !Array.isArray(v.pinIds)) return undefined;
	return { files: new Set(v.files as string[]), pinIds: new Set(v.pinIds as string[]), inventory: v.inventory };
}

/** Read a stage's stamped slice identity (absent on pre-W/resume replays —
 *  callers treat that as no exemption eligibility, fail-closed harmless). */
export function readContractSliceStamp(state: Record<string, unknown>, stage: string): ContractSliceStamp | undefined {
	// v0.4.13: DISK FIRST — the prompt-build path re-stamps state on memo-hit
	// replay rounds (fresh walk = temporal pollution); the persisted stamp is
	// the LAST LIVE round's write-time truth. State is the fallback for
	// pre-v0.4.12 tracks and for the inventory passthrough.
	// v0.4.16 note: the `inventory` passthrough is DEAD IN PRODUCTION — all four
	// stampContractSlice call sites (writers.ts x3, design.ts) pass a 3-arg slice
	// with no inventory, so contractValidationContext always re-walks; the field
	// survives as a test seam. Not a v0.4.14 regression (verified against both
	// the concurrency gate's claim and the call sites).
	const persisted = loadPersistedStamp(state, stage);
	if (persisted) return persisted;
	return readStateSliceStamp(state, stage);
}

/** A minimal slice VIEW over a stamp (validators only need .files). */
export function contractSliceView(stamp: ContractSliceStamp | undefined): ContractSlice {
	if (!stamp) return EMPTY_CONTRACT_SLICE;
	return { empty: stamp.files.size === 0, block: "", pinCount: stamp.pinIds.size, truncated: false, unmappedConcepts: [], files: [...stamp.files], pinIds: [...stamp.pinIds] };
}