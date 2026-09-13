/**
 * 059 R1A D-R-B — Layer R3 per-stage deterministic validators (control AST,
 * never rendered-markdown regex — grill R6 HIGH-2, P1/P6) + the Metadata
 * Strike-1 classifier/repair template (MED-3, P8). docs/requirements/
 * 059-reviewer-quality-architecture.md §3 R3 / §5 D-R-B.
 *
 * Every validator returns `{blocking, advisory}` message lists:
 *   - blocking findings feed the stage's convergence errors (replan-routable);
 *   - advisory findings are logged (and R1B will inject them into prompts).
 *
 * Pre-W re-entry (MED-1): when the control carries no `layerW` version stamp
 * (authored before Layer W — findReusableSpec re-entry / --resume), every
 * blocking finding DEGRADES to advisory plus a located P10 banner — never a
 * deterministic deadlock, never silent. Full W coverage via the normal
 * replan route remains operator-available.
 *
 * Metadata findings (malformed declaration SHAPE) are prefixed
 * `[contract-metadata]` so the Strike-1 classifier can distinguish a
 * formatting miss (one zero-attempt-cost inline retry) from a substantive
 * convergence failure (P4: mechanical, not heuristic).
 */

import { existsSync } from "node:fs";
import type { ContractInventory, ContractSlice, NormalizedAmendmentFamilyEntry } from "./contract-surface.ts";
import { buildContractSlice, contractSliceView, extractContractInventory, normalizeAmendmentFamily, readContractSliceStamp } from "./contract-surface.ts";

export const PRE_W_BANNER = "[layer-w: pre-W artifact — validation advisory; see 059 §3 R3]";

export interface ContractValidatorFinding {
	kind: "blocking" | "advisory";
	message: string;
}

const isPreW = (control: Record<string, unknown> | undefined, round?: number): boolean => {
	// Adversarial S7 (v0.3.98): degradation is a LEGACY-artifact accommodation,
	// never a fresh-run escape hatch — from round 2 on (any retry), validators
	// run at full strength regardless of the stamp.
	if (round !== undefined && round > 1) return false;
	return !(control && typeof control.layerW === "string" && control.layerW.trim() !== "");
};

/** Degrade every blocking finding to advisory + one located P10 banner
 *  (pre-W re-entry contract). */
function degradeForPreW(findings: ContractValidatorFinding[], stage: string): ContractValidatorFinding[] {
	if (!findings.some((f) => f.kind === "blocking")) return findings;
	return [
		{ kind: "advisory", message: `${PRE_W_BANNER} ${stage} artifact carries no layerW stamp — W validators run advisory-only this round` },
		...findings.map((f) => (f.kind === "blocking" ? { kind: "advisory" as const, message: `${f.message} (advisory: pre-W artifact)` } : f)),
	];
}

/** The set-inclusion core shared by the design (authoritative) and spec
 *  (Stage 6-skip fallback) family checks: family ⊇ inventory pins on every
 *  touched shared surface (059 §3 R3, blocking, ownerStage=design|spec). */
function familySetInclusionFindings(
	stage: string,
	control: Record<string, unknown> | undefined,
	slice: ContractSlice,
	inventory: ContractInventory,
): ContractValidatorFinding[] {
	const findings: ContractValidatorFinding[] = [];
	const { entries, malformed } = normalizeAmendmentFamily(control?.amendmentFamily);
	for (const m of malformed) findings.push({ kind: "blocking", message: `[contract-metadata] ${stage} ${m}` });
	const familyDeclared = entries.length > 0 || malformed.length > 0;
	const sliceFiles = new Set(slice.files);
	const touchedWithPins = [...slice.files].filter((f) => (inventory.protectedFiles.get(f)?.length ?? 0) > 0);
	if (touchedWithPins.length === 0) {
		// No pins on the touched surfaces: nothing to cover. A declared family
		// that names UNTouched files is the writer's own declaration — advisory.
		for (const entry of entries) {
			if (!sliceFiles.has(entry.sharedFile)) findings.push({ kind: "advisory", message: `${stage} amendmentFamily names ${entry.sharedFile}, which is not in this stage's contract-surface slice — declare only touched shared surfaces` });
		}
		return findings;
	}
	if (!familyDeclared) {
		findings.push({ kind: "blocking", message: `${stage} touches shared surfaces carrying baseline pins (${touchedWithPins.join(", ")}) but declares no amendmentFamily — every touched shared surface must declare its amendment family (059 §3 R3; see the injected contract-surface slice)` });
		return findings;
	}
	for (const file of touchedWithPins) {
		const covered = new Set<string>();
		for (const entry of entries) {
			if (entry.sharedFile !== file) continue;
			for (const id of entry.pinsMoved) covered.add(id);
			for (const ex of entry.exemptions) covered.add(ex.pinId);
		}
		const missing = (inventory.protectedFiles.get(file) ?? []).filter((pin) => !covered.has(pin.pinId));
		if (missing.length > 0) {
			for (const pin of missing) {
				findings.push({
					kind: "blocking",
					message: `${stage} amendmentFamily does not cover pin ${pin.pinId} (${pin.idiomFamily}) on touched shared surface ${file} — pin declared @ ${pin.locus}: move it (pinsMoved), exempt it with a non-empty justification, or amend the plan (059 §3 R3 set-inclusion)`,
				});
			}
		}
	}
	// delta-4 DEFECT-3: exemptions are STRUCTURED with mandatory non-empty
	// justification — existence alone is not a legal basis.
	for (const entry of entries) {
		for (const ex of entry.exemptions) {
			if (!ex.pinId.trim()) findings.push({ kind: "blocking", message: `[contract-metadata] ${stage} amendmentFamily exemption on ${entry.sharedFile} is missing pinId` });
			else if (!ex.justification.trim()) findings.push({ kind: "blocking", message: `[contract-metadata] ${stage} amendmentFamily exemption ${ex.pinId} on ${entry.sharedFile} carries an EMPTY justification — every exemption needs the legal basis (owner decision or upstream declaration; 059 delta-4 DEFECT-3)` });
		}
	}
	return findings;
}

/** (a) The AUTHORITATIVE design check (blocking, ownerStage=design):
 *  DesignData.amendmentFamily ⊇ inventory pins on every touched shared
 *  surface. The LLM reviews tradeoff quality and audits exemption
 *  justifications; the inclusion itself is machine-checked. */
export function designAmendmentFamilyFindings(input: {
	control: Record<string, unknown> | undefined;
	slice: ContractSlice;
	inventory: ContractInventory;
}): ContractValidatorFinding[] {
	const findings = familySetInclusionFindings("design", input.control, input.slice, input.inventory);
	return isPreW(input.control) ? degradeForPreW(findings, "design") : findings;
}

/** The Stage 6-skip FALLBACK check (blocking, ownerStage=spec, 059 §3 R3
 *  DEFECT-1): when design did not declare a family, the specification's own
 *  SpecificationData.amendmentFamily must pass the same set-inclusion. */
export function specAmendmentFamilyFindings(input: {
	specControl: Record<string, unknown> | undefined;
	designControl: Record<string, unknown> | undefined;
	slice: ContractSlice;
	inventory: ContractInventory;
	/** Convergence round — from round 2 on, pre-W degradation is disabled
	 *  (adversarial S7: retries run validators at full strength). */
	round?: number;
}): ContractValidatorFinding[] {
	const designFamily = (input.designControl as { amendmentFamily?: unknown } | undefined)?.amendmentFamily;
	if (designFamily !== undefined && designFamily !== null) return []; // design owns the authoritative declaration
	const findings = familySetInclusionFindings("spec", input.specControl, input.slice, input.inventory);
	return isPreW(input.specControl, input.round) ? degradeForPreW(findings, "spec") : findings;
}

/** Normalize a bdd control's pinOwnership entries out of the scenario AST
 *  (features[].scenarios[].pinOwnership). */
export function bddPinOwnershipEntries(control: Record<string, unknown> | undefined): Array<{ pinId: string; state: string; justification: string; scenario: string; malformed: string | null }> {
	const out: Array<{ pinId: string; state: string; justification: string; scenario: string; malformed: string | null }> = [];
	const features = Array.isArray(control?.features) ? (control!.features as Array<Record<string, unknown>>) : [];
	for (const feature of features) {
		const scenarios = Array.isArray(feature.scenarios) ? (feature.scenarios as Array<Record<string, unknown>>) : [];
		for (const s of scenarios) {
			const scenario = typeof s.id === "string" ? `SCENARIO-${s.id}` : "scenario";
			const rows = Array.isArray(s.pinOwnership) ? (s.pinOwnership as Array<Record<string, unknown>>) : [];
			for (const row of rows) {
				const pinId = typeof row.pinId === "string" ? row.pinId.trim() : "";
				const state = typeof row.state === "string" ? row.state.trim() : "";
				const justification = typeof row.justification === "string" ? row.justification.trim() : "";
				let malformed: string | null = null;
				if (!pinId) malformed = "pinOwnership entry is missing pinId";
				else if (state !== "owned" && state !== "inherited-frozen") malformed = `pinOwnership ${pinId}: state must be 'owned' or 'inherited-frozen' (got '${state}')`;
				out.push({ pinId, state, justification, scenario, malformed });
			}
		}
	}
	return out;
}

/** (b) The bdd AST validator (blocking, ownerStage=bdd): unowned pins on
 *  touched surfaces are blocking; inherited-frozen requires a non-empty
 *  justification (DEFECT-3). Unknown pinIds (not in the inventory) are
 *  advisory — grounding guidance, not a loop-killer. */
export function bddPinOwnershipFindings(input: {
	control: Record<string, unknown> | undefined;
	slice: ContractSlice;
	inventory: ContractInventory;
}): ContractValidatorFinding[] {
	const findings: ContractValidatorFinding[] = [];
	const entries = bddPinOwnershipEntries(input.control);
	for (const e of entries) {
		if (e.malformed) findings.push({ kind: "blocking", message: `[contract-metadata] bdd ${e.scenario} ${e.malformed}` });
		if (e.state === "inherited-frozen" && !e.malformed && !e.justification) {
			findings.push({ kind: "blocking", message: `[contract-metadata] bdd ${e.scenario} pinOwnership ${e.pinId} is inherited-frozen with an EMPTY justification — state the legal basis (owner decision or upstream declaration; 059 delta-4 DEFECT-3)` });
		}
	}
	const owned = new Set(entries.filter((e) => !e.malformed).map((e) => e.pinId));
	const knownPinIds = new Set([...input.inventory.protectedFiles.values()].flat().map((p) => p.pinId));
	const touchedWithPins = input.slice.files.filter((f) => (input.inventory.protectedFiles.get(f)?.length ?? 0) > 0);
	if (touchedWithPins.length > 0) {
		for (const file of touchedWithPins) {
			for (const pin of input.inventory.protectedFiles.get(file) ?? []) {
				if (owned.has(pin.pinId)) continue;
				findings.push({
					kind: "blocking",
					message: `bdd scenario set leaves pin ${pin.pinId} (${pin.idiomFamily}) on touched shared surface ${file} UNOWNED — every baseline-pinning behavior must declare prospective ownership in the typed pinOwnership field ({pinId, state: 'owned'|'inherited-frozen', justification}; 059 §3 R3 bdd duty; pin @ ${pin.locus})`,
				});
			}
		}
	}
	for (const e of entries) {
		if (e.malformed || !e.pinId) continue;
		if (!knownPinIds.has(e.pinId)) findings.push({ kind: "advisory", message: `bdd ${e.scenario} pinOwnership cites unknown pinId ${e.pinId} — cite only pinIds present in the injected slice or upstream declarations (W5 grounding)` });
	}
	return isPreW(input.control) ? degradeForPreW(findings, "bdd") : findings;
}

/** (c) The requirements intent consistency check (ADVISORY at 2B — HIGH-1:
 *  requirements legitimately may not know; blocking moves down-stack to
 *  design-review). */
export function requirementsIntentFindings(input: {
	control: Record<string, unknown> | undefined;
	slice: ContractSlice;
}): ContractValidatorFinding[] {
	const declared = input.control?.affectsSharedSurfaces;
	const hasDeclaration = Array.isArray(declared) && declared.some((v) => typeof v === "string" && v.trim() !== "");
	if (input.slice.files.length > 0 && !hasDeclaration) {
		return [{
			kind: "advisory",
			message: `requirements touch shared surfaces (${input.slice.files.join(", ")}) but declare no affectsSharedSurfaces intent hints — declare concept/shared-file hints so downstream stages can reconcile pins (ADVISORY at 2B; 059 §3 R3)`,
		}];
	}
	return [];
}

// ─── Metadata Strike-1 (MED-3, P8) ───────────────────────────────────────────

/** A W-metadata rejection: EVERY error is either a located schema error whose
 *  location names a Layer-W field, or a `[contract-metadata]` validator
 *  finding. Deterministic (P4) — metadata formatting must never be mistaken
 *  for a substantive convergence failure, nor vice versa. */
const W_FIELD_NAME_RE = /(?:^|\.)(?:pinOwnership|amendmentFamily|affectsSharedSurfaces|tradeoffs|layerW|evidenceLoci)(?:\[|\.|$|:)/;

export function isWriterMetadataRejection(errors: string[]): boolean {
	if (errors.length === 0) return false;
	return errors.every((e) => {
		const line = String(e);
		if (line.includes("[contract-metadata]")) return true;
		// Located schema error shape: "<field path>: <message>" (render.ts
		// schemaLocationWithItems) — test the location BEFORE the first ": ".
		const location = line.includes(": ") ? line.slice(0, line.indexOf(": ")) : line;
		return W_FIELD_NAME_RE.test(location);
	});
}

/** The deterministic repair template for the Strike-1 inline retry
 *  (renderRetries precedent): the exact malformed fields + the shapes to
 *  return. Zero attempt cost — metadata formatting must never exhaust the
 *  substantive convergence budget. */
export function writerMetadataRepairFeedback(stage: string, errors: string[]): string {
	return [
		`## ${stage}: contract-declaration metadata repair (Strike-1 — retry does not consume a convergence round)`,
		"The control's contract declarations are MALFORMED (shape only — the content was not judged yet). Fix EXACTLY these fields and return the same control with everything else unchanged:",
		...errors.slice(0, 8).map((e) => `- ${e}`),
		"",
		"Shapes (strict):",
		"- affectsSharedSurfaces: string[] — intent-level shared-surface hints.",
		"- pinOwnership (per scenario): [{ pinId: string, state: 'owned' | 'inherited-frozen', justification: string }] — populate the FIELD, never prose tags.",
		"- amendmentFamily: [{ sharedFile: string, pinsMoved: string[], exemptions: [{ pinId: string, justification: string }], docUpdates: string[] }].",
		"- tradeoffs: [{ decision: string, favoredQuality: string, sacrificedQuality: string, rationale: string }].",
		"- layerW: the literal string \"1\".",
	].join("\n");
}

/** Split validator findings for gate wiring: blocking → errors; advisory → log. */
export function splitContractFindings(findings: ContractValidatorFinding[]): { blocking: string[]; advisory: string[] } {
	return {
		blocking: findings.filter((f) => f.kind === "blocking").map((f) => f.message),
		advisory: findings.filter((f) => f.kind === "advisory").map((f) => f.message),
	};
}

/** The per-stage Metadata Strike-1 state key (059 MED-3; DISJOINT from 058's
 *  planned phaseProtectionStrikes — different prefix, different lifetime). */
export function writerMetadataStrikeKey(stage: string): string {
	return `writerMetadataRetryUsed:${stage}`;
}

/** Assemble the validator context for a stage: the slice the writer's prompt
 *  saw (state stamp) + the inventory it derived from; when no stamp exists
 *  (direct validator call, pre-W replay) BOTH are recomputed fresh from the
 *  evaluated texts. Null when the worktree is absent/unwalkable — every
 *  validator no-ops (fail-open harmless, never a false blocking). */
export function contractValidationContext(state: Record<string, unknown>, stage: string, texts: Array<string | undefined | null>): { inventory: ContractInventory; slice: ContractSlice } | null {
	const worktreePath = (state.setup as { worktreePath?: string } | undefined)?.worktreePath;
	if (!worktreePath || !existsSync(worktreePath)) return null;
	try {
		const stamp = readContractSliceStamp(state, stage);
		const inventory = stamp?.inventory ?? extractContractInventory(worktreePath);
		const slice = stamp ? contractSliceView(stamp) : buildContractSlice({ inventory, texts });
		return { inventory, slice };
	} catch {
		return null;
	}
}

/** The mismatch lines the reconciliation section cites (set-inclusion result). */
export function familyInclusionMismatches(
	control: Record<string, unknown> | undefined,
	slice: ContractSlice,
	inventory: ContractInventory,
): string[] {
	const { entries } = normalizeAmendmentFamily(control?.amendmentFamily);
	const out: string[] = [];
	for (const file of slice.files) {
		const covered = new Set<string>();
		for (const entry of entries) {
			if (entry.sharedFile !== file) continue;
			for (const id of entry.pinsMoved) covered.add(id);
			for (const ex of entry.exemptions) covered.add(ex.pinId);
		}
		for (const pin of inventory.protectedFiles.get(file) ?? []) {
			if (!covered.has(pin.pinId)) out.push(`${pin.pinId} on ${file} (${pin.idiomFamily} @ ${pin.locus})`);
		}
	}
	return out;
}

export type { NormalizedAmendmentFamilyEntry };
