/**
 * CONTAMINATION FIREWALL (P3 / D4 / §8.1 H1 fold) — the measurement-side
 * half of the flywheel's honesty contract: the measuring instrument must not
 * perturb the measured system (golden-case scenario text leaking into
 * learned-index → Tier-1 full-text injection → a future agent's context
 * would contaminate every later measurement; a saturated case retained
 * forever is the maximal exposure surface — §8.1 verbatim).
 *
 * Two detection methods (the standard techniques per the §8.1 research
 * fold, arXiv:2502.14425 + canary-string practice):
 *   (a) literal canary GUID — a learned-index entry quoting makeCanary(id)
 *       is PROOF of golden-case leakage (eval-shared's single derivation);
 *   (b) 7-gram overlap — |entry n-grams ∩ scenario n-grams| / |scenario
 *       n-grams| > CONTAMINATION_OVERLAP_THRESHOLD flags paraphrased
 *       leakage even after the canary is stripped.
 *
 * Detection consequence: LOUD warning + the offending entry QUARANTINED —
 * never injected (the learned.ts injection seam filters on every load), and
 * first detections are appended to ~/.super-dev/evals/contamination.jsonl
 * (ts + entry id + trigger + case id) by the flywheel-run scan. The scan is
 * PURE/leaf (eval-shared + super-dev-dir only — no eval-layer import, so
 * learned.ts can call it without the learned→eval-layer→register-agents→
 * agents→learned import cycle) and NEVER throws (fail-open advisory).
 *
 * Division of labor with the reflection exclusion (§8.1's other half): the
 * reflection AGENT owns learned-index writes, and prompts are advisory (P4),
 * so the mechanical guarantee lives HERE — at the injection seam — where
 * disobeying the reflection prompt still cannot leak a quarantined entry.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getLearnedIndexPath } from "../render/super-dev-dir.ts";
import { casesDir, contaminationLedgerPath, makeCanary, readContaminationLedger } from "./eval-shared.ts";

/** The standard n-gram size (§8.1: the survey's canonical contamination
 *  detector; 7 words — long enough that incidental agreement is rare, short
 *  enough to catch partial quotes). */
export const CONTAMINATION_NGRAM_SIZE = 7;

/** Overlap ratio above which an entry is flagged: |shared 7-grams| /
 *  |golden-scenario 7-grams|. 0.1 — a deliberately low bar for an
 *  instrument-protection tripwire (a false positive costs one manually
 *  reviewed learned-index entry; a false negative poisons every future
 *  measurement). */
export const CONTAMINATION_OVERLAP_THRESHOLD = 0.1;

/** The minimal shape the scan needs from a golden-case file (raw read —
 *  deliberately independent of the loader's validation: a case file skipped
 *  by validation can still be quoted verbatim, so the scan reads the
 *  conservative SUPERSET of what the loader admits). */
export interface GoldenCaseText {
	id: string;
	scenario: string;
}

/** Raw {id, scenario} pairs from every *.json under the cases dir (cold
 *  start → []; malformed files skipped — the firewall never throws). */
export function loadGoldenCaseTexts(dir: string = casesDir()): GoldenCaseText[] {
	let files: string[];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const out: GoldenCaseText[] = [];
	for (const file of files) {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as { id?: unknown; scenario?: unknown };
			if (typeof parsed?.id === "string" && parsed.id !== "" && typeof parsed?.scenario === "string") {
				out.push({ id: parsed.id, scenario: parsed.scenario });
			}
		} catch { /* skip unparseable case files — never throw from the firewall */ }
	}
	return out;
}

/** CJK ranges split per-CHARACTER in the tokenizer (adversarial-gate F-07):
 *  CJK ideographs/kana/Hangul carry meaning per character, and word-boundary
 *  tokenization (splitting on non-alphanumerics) would glue a whole Chinese
 *  run into ONE token — a verbatim quote of a golden scenario then shares
 *  ZERO n-grams with it and the contamination detector goes blind on exactly
 *  the language this repo's golden cases use. Deterministic character-range
 *  test ONLY — Intl.Segmenter is locale-dependent and forbidden here. */
const CJK_CHAR_RE = /[\u2E80-\u2EFF\u3040-\u30FF\u31C0-\u31EF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/;
const WORD_CHAR_RE = /[a-z0-9]/;

/** F-07 tokenization: lowercase; [a-z0-9] runs become words; each CJK
 *  character is its OWN token; everything else is a boundary. Exported for
 *  tests (the latin path is byte-identical to the previous split-on-
 *  non-alphanumeric behavior — pinned by existing tests). */
export function tokenizeText(text: string): string[] {
	const out: string[] = [];
	let buf = "";
	for (const ch of String(text ?? "").toLowerCase()) {
		if (CJK_CHAR_RE.test(ch)) {
			if (buf !== "") { out.push(buf); buf = ""; }
			out.push(ch);
		} else if (WORD_CHAR_RE.test(ch)) {
			buf += ch;
		} else if (buf !== "") {
			out.push(buf);
			buf = "";
		}
	}
	if (buf !== "") out.push(buf);
	return out;
}

/** Lowercased n-grams over the F-07 token stream (words for latin text; each
 *  CJK character is a token — see tokenizeText). */
export function wordNgrams(text: string, n: number = CONTAMINATION_NGRAM_SIZE): string[] {
	const words = tokenizeText(text);
	if (words.length < n) return [];
	const out: string[] = [];
	for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
	return out;
}

/** Containment overlap: how much of the golden scenario's n-gram mass also
 *  appears in the entry text (0 when the scenario has no n-grams — a
 *  sub-n-word scenario cannot contaminate via this detector; the canary
 *  arm still covers it). */
export function overlapRatio(entryText: string, scenarioText: string): number {
	const scenario = new Set(wordNgrams(scenarioText));
	if (scenario.size === 0) return 0;
	const entry = new Set(wordNgrams(entryText));
	let shared = 0;
	for (const g of scenario) if (entry.has(g)) shared += 1;
	return shared / scenario.size;
}

export type ContaminationTrigger = "canary" | "ngram-overlap";

export interface ContaminationFinding {
	/** The learned-index entry id (its record key). */
	entryId: string;
	/** The golden case whose text was matched. */
	caseId: string;
	trigger: ContaminationTrigger;
	detail: string;
}

/** The learned-index entry shape the scan reads (title + summary are the
 *  fields the Tier-1 injection renders — tags/scores cannot carry
 *  contamination). */
interface ScannedEntry {
	title?: unknown;
	summary?: unknown;
}

/** PURE detection over a parsed learned-index value: never throws, returns
 *  findings in deterministic (entryId, caseId, trigger) order. */
export function scanLearnedIndexEntries(learnedIndex: unknown, caseTexts: readonly GoldenCaseText[]): ContaminationFinding[] {
	const findings: ContaminationFinding[] = [];
	if (learnedIndex === null || typeof learnedIndex !== "object" || Array.isArray(learnedIndex)) return findings;
	const entries = (learnedIndex as { entries?: unknown }).entries;
	if (entries === null || typeof entries !== "object" || Array.isArray(entries)) return findings;
	for (const [entryId, raw] of Object.entries(entries as Record<string, ScannedEntry>)) {
		const entry = raw ?? {};
		const text = `${String(entry.title ?? "")}\n${String(entry.summary ?? "")}`;
		if (text.trim() === "") continue;
		for (const c of caseTexts) {
			if (text.includes(makeCanary(c.id))) {
				findings.push({ entryId, caseId: c.id, trigger: "canary", detail: `entry quotes the literal canary GUID of golden case "${c.id}" — proof of leakage (§8.1)` });
				continue; // the canary is conclusive; no need to also n-gram this pair
			}
			const ratio = overlapRatio(text, c.scenario);
			if (ratio > CONTAMINATION_OVERLAP_THRESHOLD) {
				findings.push({ entryId, caseId: c.id, trigger: "ngram-overlap", detail: `${CONTAMINATION_NGRAM_SIZE}-gram overlap ${(ratio * 100).toFixed(1)}% > ${(CONTAMINATION_OVERLAP_THRESHOLD * 100).toFixed(0)}% of golden case "${c.id}" scenario — probable paraphrased leakage (§8.1)` });
			}
		}
	}
	return findings.sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : a.trigger < b.trigger ? -1 : 1));
}

export interface ContaminationScanOutcome {
	findings: ContaminationFinding[];
	/** Unique entry ids to quarantine (never inject). */
	quarantined: string[];
	entriesScanned: number;
	casesScanned: number;
	/** Rows appended THIS scan (first detections only — the ledger is
	 *  deduplicated on (entryId, caseId, trigger)). */
	ledgerRowsAppended: number;
}

/**
 * The full scan face (the flywheel-run invocation): load learned-index +
 * raw case texts, detect, append first-detection rows to the quarantine
 * ledger, and log every finding LOUDLY. Missing/unreadable learned-index or
 * cases dir = an honest no-op (nothing to protect / nothing to scan — the
 * cold-start doctrine). Best-effort writes; NEVER throws.
 */
export function scanLearnedIndexForContamination(opts: {
	learnedIndexPath?: string;
	casesDirPath?: string;
	ledgerPath?: string;
	log?: (m: string) => void;
} = {}): ContaminationScanOutcome {
	const empty: ContaminationScanOutcome = { findings: [], quarantined: [], entriesScanned: 0, casesScanned: 0, ledgerRowsAppended: 0 };
	try {
		const indexPath = opts.learnedIndexPath ?? getLearnedIndexPath();
		const caseTexts = loadGoldenCaseTexts(opts.casesDirPath ?? casesDir());
		if (caseTexts.length === 0) return { ...empty, casesScanned: 0 };
		if (!existsSync(indexPath)) return { ...empty, casesScanned: caseTexts.length }; // cold start: no learned index yet
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(indexPath, "utf8"));
		} catch (err) {
			opts.log?.(`contamination scan: learned-index unreadable (${err instanceof Error ? err.message : String(err)}) — scan skipped, fail-open (§8.1)`);
			return { ...empty, casesScanned: caseTexts.length };
		}
		const entries = (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { entries?: unknown }).entries : null);
		const entriesScanned = entries !== null && typeof entries === "object" && !Array.isArray(entries) ? Object.keys(entries as Record<string, unknown>).length : 0;
		const findings = scanLearnedIndexEntries(parsed, caseTexts);
		const ledgerPath = opts.ledgerPath ?? contaminationLedgerPath();
		const known = new Set(readContaminationLedger(ledgerPath).map((r) => `${r.entryId}\u0000${String(r.caseId ?? "")}\u0000${r.trigger}`));
		const fresh = findings.filter((f) => !known.has(`${f.entryId}\u0000${f.caseId}\u0000${f.trigger}`));
		if (fresh.length > 0) {
			try {
				mkdirSync(dirname(ledgerPath), { recursive: true });
				appendFileSync(ledgerPath, fresh.map((f) => JSON.stringify({ ts: Date.now(), entryId: f.entryId, trigger: f.trigger, caseId: f.caseId, detail: f.detail })).join("\n") + "\n", "utf8");
			} catch (err) {
				opts.log?.(`contamination scan: quarantine ledger append failed (quarantine STILL enforced at the injection seam; continuing): ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		for (const f of findings) {
			opts.log?.(`contamination firewall: learned-index entry "${f.entryId}" QUARANTINED — ${f.detail}; never injected (§8.1); ledger: ${ledgerPath}`);
		}
		return { findings, quarantined: [...new Set(findings.map((f) => f.entryId))].sort(), entriesScanned, casesScanned: caseTexts.length, ledgerRowsAppended: fresh.length };
	} catch (err) {
		// Fail-open hard constraint: the firewall can never break its caller.
		opts.log?.(`contamination scan: failed open (${err instanceof Error ? err.message : String(err)}) — advisory surface, never fatal (§8.1)`);
		return empty;
	}
}
