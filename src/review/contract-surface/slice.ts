/**
 * contract-surface — Layer R2 slice construction (touched-set + the bounded injected block). Layer doctrine: ./types.ts.
 */
import type { ContractInventory } from "./types.ts";

// ─── Layer R2 slice construction (deterministic injection) ───────────────────

/** W1/grill R6 MED-2 caps: at most 15 pins / 60 lines per injected slice. */
export const CONTRACT_SLICE_MAX_PINS = 15;
export const CONTRACT_SLICE_MAX_LINES = 60;
export const CONTRACT_SLICE_TRUNCATION_MARKER = "[contract-inventory: slice truncated at 15 pins; see repo-invariants.json]";
export const CONTRACT_INVENTORY_ERROR_BANNER = "[contract-inventory: extraction failed — review slice incomplete]";

export interface ContractSlice {
	/** True ⇒ callers OMIT the section entirely (W1: zero noise). */
	empty: boolean;
	/** The rendered markdown block (header + `unanchored:`/`unmapped-concept:`
	 *  lines + truncation marker), bounded by the caps. */
	block: string;
	/** Total pins in the touched slice BEFORE the cap. */
	pinCount: number;
	truncated: boolean;
	/** Known shared concepts named in the texts with no mapping entry
	 *  (honest gap — never a silent empty slice). */
	unmappedConcepts: string[];
	/** The touched protected files (normalized keys), in slice order. */
	files: string[];
	/** The pinIds present in the slice (cap-excluded ones are honest losses
	 *  covered by the truncation marker). */
	pinIds: string[];
}

/** Touched-set algorithm (059 §3 R2/MED-1): inventory keys appearing as a
 *  literal path/backtick token in the evaluated texts ∪ mapping[concept] for
 *  a concept named in the texts. */
export function touchedProtectedFiles(inventory: ContractInventory, texts: Array<string | undefined | null>): { files: string[]; unmappedConcepts: string[] } {
	const corpus = texts.filter((t): t is string => typeof t === "string" && t.length > 0).join("\n");
	const touched = new Set<string>();
	if (corpus) {
		for (const key of inventory.protectedFiles.keys()) {
			if (new RegExp(`(?<![\\w/])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/])`).test(corpus)) touched.add(key);
		}
	}
	const unmappedConcepts: string[] = [];
	for (const concept of inventory.concepts) {
		if (!new RegExp(`(?<![\\w-])${concept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(corpus)) continue;
		const mapped = inventory.mapping.get(concept);
		if (mapped && mapped.length > 0) for (const f of mapped) touched.add(f);
		else if (!unmappedConcepts.includes(concept)) unmappedConcepts.push(concept);
	}
	return { files: [...touched].sort(), unmappedConcepts };
}

/** Build the deterministic contract-surface slice for prompt injection.
 *  Empty touched-set (and no errors/unmapped concepts) ⇒ `empty: true` —
 *  the caller omits the section (W1 zero-noise rule). */
export function buildContractSlice(input: { inventory: ContractInventory; texts: Array<string | undefined | null> }): ContractSlice {
	const { files, unmappedConcepts } = touchedProtectedFiles(input.inventory, input.texts);
	const errors = input.inventory.errors;
	const empty = files.length === 0 && unmappedConcepts.length === 0 && errors.length === 0;
	const pinIds: string[] = [];
	const lines: string[] = ["## Contract Surface Slice — shared baseline pins this change may touch"];
	if (errors.length > 0) {
		// DEC-4 fail-loud banner: an extraction error on an existing tree must
		// never silently shrink the review inputs.
		lines.push(CONTRACT_INVENTORY_ERROR_BANNER, ...errors.slice(0, 4).map((e) => `- extraction: ${e}`));
	}
	let rendered = 0;
	for (const file of files) {
		if (lines.length >= CONTRACT_SLICE_MAX_LINES - 1) break;
		const pins = input.inventory.protectedFiles.get(file) ?? [];
		for (const pin of pins) {
			if (rendered >= CONTRACT_SLICE_MAX_PINS || lines.length >= CONTRACT_SLICE_MAX_LINES - 1) break;
			lines.push(`- ${file}: ${pin.pinId} ${pin.idiomFamily} @ ${pin.locus} — ${pin.statement}`);
			pinIds.push(pin.pinId);
			rendered++;
		}
	}
	const totalPins = files.reduce((n, f) => n + (input.inventory.protectedFiles.get(f)?.length ?? 0), 0);
	for (const pin of input.inventory.unanchored) {
		if (lines.length >= CONTRACT_SLICE_MAX_LINES - 1) break;
		lines.push(`unanchored: ${pin.pinId} "${pin.statement}" @ ${pin.locus} — ${pin.unanchoredReason ?? "unresolved"}`);
	}
	for (const concept of unmappedConcepts) {
		if (lines.length >= CONTRACT_SLICE_MAX_LINES - 1) break;
		lines.push(`unmapped-concept: ${concept}`);
	}
	let truncated = totalPins > rendered;
	if (lines.length > CONTRACT_SLICE_MAX_LINES - 1) truncated = true;
	let blockLines = lines;
	if (truncated) {
		blockLines = [...lines.slice(0, CONTRACT_SLICE_MAX_LINES - 1), CONTRACT_SLICE_TRUNCATION_MARKER];
	}
	return { empty, block: empty ? "" : blockLines.join("\n"), pinCount: totalPins, truncated, unmappedConcepts, files, pinIds };
}
