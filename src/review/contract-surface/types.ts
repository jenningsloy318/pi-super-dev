/**
 * 059 R1A D-R-A — Layer R1 contract-surface inventory (mechanical, single
 * source). docs/requirements/059-reviewer-quality-architecture.md §3 R1.
 *
 * A deterministic extractor walks each `<worktree>/docs/specifications/<spec>/`
 * artifacts plus the test suite and indexes baseline pins by protected file:
 * `inventory[protectedFile] → Array<{pinId, idiomFamily, locus(file:line),
 * owningSpec, resolutionState}>`. Detection is HYBRID (DEC-2): this module
 * produces candidates with loci; the LLM adjudicates. P4: purely mechanical
 * (regex/grammar tables), zero LLM, zero network.
 *
 * P6 (binding): the porcelain-emptiness TS/test form COMPOSES the landed
 * `scanImmutabilityIdioms` from src/stages/plan-feasibility.ts (058 P1 D-A)
 * and every path containment check goes through its exported `claimPathUsable`
 * — the regex/window/quote logic of that scanner is NEVER re-implemented here.
 * The OTHER grammar families' token extraction (exactly-N / no-Xth /
 * ownership) is NEW grammar (the §3 table's remaining columns) and lives only
 * in this module.
 *
 * Idiom grammar (059 §3 table, v1 scope — additions require a grammar-table
 * row + fixture pair):
 *
 * | Family             | TS/JS test form                                        | Python test form                    | Markdown/prose form                       |
 * |--------------------|--------------------------------------------------------|-------------------------------------|-------------------------------------------|
 * | porcelain-emptiness| scanImmutabilityIdioms (porcelain + toBe("")/wording)  | subprocess git + assert == ""       | "stays byte-untouched in git", "working tree clean for X" |
 * | exactly-N membership| toHaveLength(N) / expect(x.length).toBe(N) / .size    | len(X) == N / assertEqual(len(x),N) | "pinned at exactly N members", "closed set of N" |
 * | no-Xth closure     | not.toContain("x")                                     | assert "x" not in …                 | "no fifteenth module", "gains no new member" |
 * | ownership table    | exported OWNERSHIP_PINS/*_OWNERS compared verbatim     | dict-equality asserts               | "OWNER '14'", ownership-table rows        |
 *
 * Path-resolution rule (HIGH-3): a pin enters the inventory keyed by a
 * protected file ONLY via (a) a literal path token in the pinning statement
 * (backtick/quote-symmetric token, or a repo-rooted plain token), or (b) an
 * entry in repo-invariants.json `pins: Array<{protectedFile, pin, anchor}>`
 * (backwards-compatible envelope — the `protected` key keeps 058 P1's landed
 * plan-feasibility.ts validator working unchanged). Unresolvable pins are
 * listed in the slice header as `unanchored:` lines (P10 — never dropped).
 *
 * DEC-4: absent tree/suite ⇒ silent fail-open (empty inventory); an extraction
 * ERROR on an existing tree ⇒ fail-loud `[contract-inventory: extraction
 * failed — review slice incomplete]` banner carried by the slice.
 */

// ─── types ───────────────────────────────────────────────────────────────────

/** The §3 grammar table's four v1 families (closed set). */
export type IdiomFamily = "porcelain-emptiness" | "exactly-n-membership" | "no-xth-closure" | "ownership-table";

/** Which column of the grammar table produced the pin. */
export type PinSourceForm = "ts-test" | "python-test" | "markdown-prose" | "repo-invariants";

/** One indexed baseline pin. */
export interface ContractPin {
	/** Deterministic stable id (minted from family+locus+statement). */
	pinId: string;
	idiomFamily: IdiomFamily;
	/** Locus of the pinning statement, repo-relative `file:line` (1-based). */
	locus: string;
	/** The artifact (spec doc or test file) that carries the pin. */
	owningSpec: string;
	/** `active` = keyed to a resolved protected file; `unanchored` = listed
	 *  in the slice header instead (P10). */
	resolutionState: "active" | "unanchored";
	/** Proof text: the matched statement (trimmed, bounded). */
	statement: string;
	via: PinSourceForm;
	/** Set when a repo-invariants.json pins[] entry supplied (or corroborated)
	 *  the anchoring — the envelope's backwards-compatibility trace. */
	declaredPin?: string;
	/** unanchored only: why the protected file could not be resolved. */
	unanchoredReason?: string;
}

export interface ContractInventory {
	/** protectedFile (normalized repo-relative) → pins (sorted by locus, pinId). */
	protectedFiles: Map<string, ContractPin[]>;
	/** Pins whose protected file could not be resolved (P10: listed, never dropped). */
	unanchored: ContractPin[];
	/** DEC-4 fail-loud extraction errors (existing tree, failed read/parse). */
	errors: string[];
	/** P10 scan visibility: one line per scanned source (file: N pin(s) / skipped). */
	scanLines: string[];
	/** repo-invariants.json `mapping`: shared concept → protectedFile[]. */
	mapping: Map<string, string[]>;
	/** repo-invariants.json `concepts`: the declared shared-concept vocabulary. */
	concepts: Set<string>;
	/** Counts for the reconciliation section. */
	counts: { specArtifacts: number; testFiles: number };
}

// ─── pinId minting (deterministic) ───────────────────────────────────────────

const FAMILY_CODE: Record<IdiomFamily, string> = {
	"porcelain-emptiness": "pe",
	"exactly-n-membership": "xn",
	"no-xth-closure": "nx",
	"ownership-table": "ot",
};

/** Stable, content-derived pin id: `pin-<family-code>-<base36 djb2>`. Same
 *  tree + same statement ⇒ same id (slice citations and the R4 exemption's
 *  pinId matching depend on this). */
export function mintPinId(family: IdiomFamily, locus: string, statement: string): string {
	let hash = 5381;
	const input = `${family}\u0000${locus}\u0000${statement}`;
	for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
	return `pin-${FAMILY_CODE[family]}-${(hash >>> 0).toString(36).padStart(7, "0")}`;
}
