/**
 * contract-surface — deterministic traversal, the repo-invariants.json envelope, and extractContractInventory. Layer doctrine: ./types.ts.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { claimPathUsable } from "../../stages/plan-feasibility.ts";
import { governedProtectedTokens } from "../claim-spine.ts";
import { mintPinId } from "./types.ts";
import type { ContractInventory, ContractPin } from "./types.ts";
import { scanSourceFile, lineAt, clampStatement, type RawHit } from "./scanners.ts";
import { windowTokenRejects } from "./tokens.ts";

// ─── traversal (deterministic order; bounded) ────────────────────────────────

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".venv", "venv", "__pycache__", ".pi", ".cache", "target", ".next", "out"]);
/** P8 bound: cap scanned files per extraction (a pathological tree degrades
 *  with a P10 line, never hangs a review dispatch). */
const MAX_SCAN_FILES = 2000;

const isTsFamily = (p: string): boolean => /\.(?:ts|tsx|js|jsx|mjs|cjs|cts|mts)$/i.test(p);
const isPyFamily = (p: string): boolean => /\.py$/i.test(p);
const isMdFamily = (p: string): boolean => /\.(?:md|markdown)$/i.test(p);
const isTestFamily = (p: string): boolean => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(p) || /(^|\/)(test_[^/]+|[^/]+_test)\.py$/i.test(p);

/** Deterministic recursive listing: depth-first, entries sorted by name. */
function walkSorted(root: string, rel: string, out: string[], budget: { left: number }): void {
	if (budget.left <= 0) return;
	let entries: string[];
	try {
		entries = readdirSync(join(root, rel)).sort();
	} catch {
		return; // unreadable dir — absent-tree fail-open (DEC-4)
	}
	for (const name of entries) {
		if (budget.left <= 0) return;
		const relPath = rel ? `${rel}/${name}` : name;
		let isDir: boolean;
		try {
			isDir = statSync(join(root, relPath)).isDirectory();
		} catch {
			continue;
		}
		if (isDir) {
			if (SKIP_DIRS.has(name)) continue;
			walkSorted(root, relPath, out, budget);
		} else {
			out.push(relPath);
			budget.left--;
		}
	}
}

// ─── repo-invariants.json envelope (backwards-compatible) ────────────────────

interface DeclaredPin { protectedFile: string; pin: string; anchor?: string }

function loadRepoInvariants(worktreePath: string, out: { declaredPins: DeclaredPin[]; mapping: Map<string, string[]>; concepts: Set<string>; errors: string[] }): void {
	const abs = join(worktreePath, "repo-invariants.json");
	if (!existsSync(abs)) return; // optional — absent = skipped silently (058 P1 contract)
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(abs, "utf8"));
	} catch {
		out.errors.push("repo-invariants.json: present but unparseable — pin anchors unavailable");
		return;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		out.errors.push("repo-invariants.json: malformed envelope (expected {protected: string[], pins?: [...]}) — pin anchors unavailable");
		return;
	}
	const obj = parsed as { protected?: unknown; pins?: unknown; mapping?: unknown; concepts?: unknown };
	// `protected` is consumed by plan-feasibility Check 3 (058 P1) — the
	// inventory only notes it (it carries no pin statement to index).
	if (obj.protected !== undefined && !(Array.isArray(obj.protected) && obj.protected.every((p) => typeof p === "string"))) {
		out.errors.push("repo-invariants.json: 'protected' is not string[] — Check 3 will report this too");
	}
	if (Array.isArray(obj.pins)) {
		for (const entry of obj.pins) {
			const e = entry as { protectedFile?: unknown; pin?: unknown; anchor?: unknown } | null;
			if (!e || typeof e !== "object" || typeof e.protectedFile !== "string" || typeof e.pin !== "string" || !e.protectedFile.trim() || !e.pin.trim()) {
				out.errors.push("repo-invariants.json: malformed pins[] entry (expected {protectedFile, pin, anchor?}) — entry skipped");
				continue;
			}
			const usable = claimPathUsable(e.protectedFile);
			if (!usable) continue;
			out.declaredPins.push({ protectedFile: usable, pin: e.pin, anchor: typeof e.anchor === "string" && e.anchor.trim() ? e.anchor : undefined });
		}
	}
	if (obj.mapping && typeof obj.mapping === "object" && !Array.isArray(obj.mapping)) {
		for (const [concept, files] of Object.entries(obj.mapping as Record<string, unknown>)) {
			if (!Array.isArray(files)) continue;
			const usable = files.filter((f): f is string => typeof f === "string").map(claimPathUsable).filter((f): f is string => f !== null);
			out.mapping.set(concept, usable);
		}
	}
	if (Array.isArray(obj.concepts)) {
		for (const c of obj.concepts) if (typeof c === "string" && c.trim()) out.concepts.add(c);
	}
}

// ─── the extractor ───────────────────────────────────────────────────────────

/** Deterministic contract-surface extraction: one walk, one inventory. Same
 *  tree ⇒ same inventory (sorted traversal, sorted pin lists). Reads are
 *  FRESH per call — no cache between stages (059 §3 R1). */
export function extractContractInventory(worktreePath: string): ContractInventory {
	const inventory: ContractInventory = {
		protectedFiles: new Map(),
		unanchored: [],
		errors: [],
		scanLines: [],
		mapping: new Map(),
		concepts: new Set(),
		counts: { specArtifacts: 0, testFiles: 0 },
	};
	const inv = { declaredPins: [] as DeclaredPin[], mapping: inventory.mapping, concepts: inventory.concepts, errors: inventory.errors };
	try {
		loadRepoInvariants(worktreePath, inv);
	} catch (err) {
		inventory.errors.push(`repo-invariants.json: read failed — ${err instanceof Error ? err.message : String(err)}`);
	}

	// Source list: docs/specifications/**/*.md + test-family files under the
	// worktree (node_modules & co. skipped; P8 file cap; sorted = deterministic).
	const budget = { left: MAX_SCAN_FILES };
	const all: string[] = [];
	try {
		walkSorted(worktreePath, "", all, budget);
	} catch (err) {
		inventory.errors.push(`worktree walk failed — ${err instanceof Error ? err.message : String(err)}`);
		return inventory;
	}
	if (budget.left <= 0) inventory.errors.push(`scan cap reached (${MAX_SCAN_FILES} files) — inventory incomplete (P8 bound)`);
	const specArtifacts = all.filter((p) => p.startsWith("docs/specifications/") && isMdFamily(p));
	const testFiles = all.filter((p) => isTestFamily(p) && (isTsFamily(p) || isPyFamily(p)));

	const rawHits: Array<RawHit & { owningSpec: string }> = [];
	for (const rel of [...specArtifacts, ...testFiles]) {
		const kind: "ts" | "py" | "md" = isTsFamily(rel) ? "ts" : isPyFamily(rel) ? "py" : "md";
		let text: string;
		try {
			text = readFileSync(join(worktreePath, rel), "utf8");
		} catch (err) {
			// DEC-4: the tree exists but the read failed — fail-loud error line.
			inventory.errors.push(`${rel}: unreadable — not scanned (${err instanceof Error ? err.message : String(err)})`);
			continue;
		}
		const hits = scanSourceFile(rel, text, kind);
		if (kind === "md") inventory.counts.specArtifacts++;
		else inventory.counts.testFiles++;
		inventory.scanLines.push(`${rel}: ${hits.length} pin(s)`);
		// 065 D2/F-4: drain the window-arm rejects for THIS file (P10 — the
		// phantoms are named, never silently dropped; capped at 4/file, P8).
		for (const r of windowTokenRejects.splice(0).slice(0, 4)) {
			inventory.scanLines.push(`${rel}: rejected token '${r}' (template/identifier form — not a repo path; 065 D2)`);
		}
		for (const h of hits) rawHits.push({ ...h, owningSpec: rel });
	}

	// Resolution: literal token first (HIGH-3 arm a), then a declared
	// repo-invariants pin whose `pin` text appears in the statement (arm b).
	const declaredUnused = new Set(inv.declaredPins);
	const addPin = (pin: ContractPin, protectedFile: string | null): void => {
		if (protectedFile) {
			const arr = inventory.protectedFiles.get(protectedFile) ?? [];
			arr.push(pin);
			inventory.protectedFiles.set(protectedFile, arr);
		} else {
			inventory.unanchored.push(pin);
		}
	};
	for (const hit of rawHits) {
		const locus = `${hit.owningSpec}:${hit.line}`;
		const pinId = mintPinId(hit.family, locus, hit.statement);
		const pin: ContractPin = {
			pinId,
			idiomFamily: hit.family,
			locus,
			owningSpec: hit.owningSpec,
			resolutionState: "active",
			statement: hit.statement,
			via: hit.via,
		};
		// 065 D2 (the core fix): a pin's protected files are the tokens its
		// statement GOVERNS (protect qualifier + list governance), never
		// pathTokens[0] by position. "extends X … never touching Y" can never
		// protect X (the write target); "A, B, C stay byte-untouched" protects
		// ALL THREE. Multi-token resolution mints one pin per governed file.
		const governed = governedProtectedTokens(hit.statement, hit.pathTokens);
		if (governed.length === 0) {
			const declared = inv.declaredPins.find((d) => hit.statement.includes(d.pin) || pinId === d.pin);
			if (declared) {
				// The envelope supplied the anchoring — provenance is the envelope,
				// not the scanner form (honest via; P10/P6).
				pin.via = "repo-invariants";
				pin.declaredPin = declared.pin;
				declaredUnused.delete(declared);
				addPin(pin, declared.protectedFile);
			} else {
				pin.resolutionState = "unanchored";
				pin.unanchoredReason = "no protect-governed path token in the pinning statement and no matching repo-invariants.json pins[] entry";
				addPin(pin, null);
			}
			continue;
		}
		for (const d of inv.declaredPins) if (governed.includes(d.protectedFile) && hit.statement.includes(d.pin)) { pin.declaredPin = d.pin; declaredUnused.delete(d); }
		for (const file of governed) addPin(pin, file);
	}
	// Declared pins never matched by a scanned statement: anchor them directly
	// (the file must exist and contain the pin text), else honest `unanchored:`.
	for (const d of declaredUnused) {
		const pin: ContractPin = {
			pinId: mintPinId("porcelain-emptiness", `repo-invariants.json:${d.protectedFile}`, d.pin),
			idiomFamily: "porcelain-emptiness",
			locus: d.anchor ?? "repo-invariants.json",
			owningSpec: d.anchor ?? "repo-invariants.json",
			resolutionState: "active",
			statement: clampStatement(d.pin),
			via: "repo-invariants",
		};
		let anchored = false;
		if (d.anchor) {
			const anchorRel = claimPathUsable(d.anchor);
			if (anchorRel && existsSync(join(worktreePath, anchorRel))) {
				try {
					const text = readFileSync(join(worktreePath, anchorRel), "utf8");
					const idx = text.indexOf(d.pin);
					if (idx >= 0) {
						pin.locus = `${anchorRel}:${lineAt(text, idx)}`;
						pin.owningSpec = anchorRel;
						anchored = true;
					}
				} catch { /* unreadable anchor — unanchored below */ }
			}
		}
		if (anchored) {
			addPin(pin, d.protectedFile);
		} else {
			pin.resolutionState = "unanchored";
			pin.unanchoredReason = d.anchor ? `declared pin not found in anchor ${d.anchor}` : "declared pin carries no anchor";
			addPin(pin, null);
		}
	}

	// Deterministic pin order per protected file (locus, then pinId).
	for (const arr of inventory.protectedFiles.values()) arr.sort((a, b) => a.locus === b.locus ? a.pinId.localeCompare(b.pinId) : a.locus.localeCompare(b.locus));
	inventory.unanchored.sort((a, b) => a.locus.localeCompare(b.locus) || a.pinId.localeCompare(b.pinId));
	return inventory;
}
