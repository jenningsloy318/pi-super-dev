/**
 * contract-surface — literal path-token extraction (the OTHER families' token arm) plus the P10 reject accumulator. Layer doctrine: ./types.ts.
 */
import { claimPathUsable, isUsableProtectedToken } from "../../stages/plan-feasibility.ts";

// ─── path-token extraction (the OTHER families' literal-token arm) ───────────

/** Repo-path-looking tokens (extension-bounded). New grammar for the
 *  exactly-N/no-Xth/ownership columns — the porcelain column reuses the
 *  landed scanner and never touches this. */
const PATH_TOKEN_RE = /[A-Za-z0-9_.\-/]+\.(?:ts|tsx|js|jsx|mjs|cjs|cts|mts|py|json|md|markdown|rs|go|toml|yaml|yml)\b/g;
/** Plain (unquoted) tokens count only when repo-rooted under a known source
 *  root — the HIGH-3 "literal path token" reading for prose/markdown. */
/** Single spelling with claim-spine REPO_ROOTED_RE (P6/065 grill F-4:
 *  python/ tokens were invisible to the md arm). */
const REPO_ROOTED_PREFIX_RE = /^(?:\.\/)?(?:src|tests|test|lib|libs|docs|python|scripts|internal|pkg|cmd|__tests__|tools|app|server|client)\//;

/** 065 D2: template/interpolation tokens are NEVER protected paths — the
 *  observed phantoms (`${wiredFile}` financials-contract.test.ts:843,
 *  `${pathspec}` prosperity-contract.test.ts:439) entered via both the
 *  porcelain-pathspec arm and this window arm. ONE spelling (P6):
 *  isUsableProtectedToken from plan-feasibility (the DAG root). */

/** Literal path tokens in text[from..to]: backtick/quote-symmetric tokens
 *  (mirrors the porcelain scanner's symmetric-quote guard) ∪ repo-rooted
 *  plain tokens. Every token must survive claimPathUsable (P6). */
export function literalPathTokens(text: string, from: number, to: number, rejectSink?: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const window = text.slice(Math.max(0, from), Math.min(text.length, to));
	PATH_TOKEN_RE.lastIndex = 0;
	for (let m = PATH_TOKEN_RE.exec(window); m !== null; m = PATH_TOKEN_RE.exec(window)) {
		const absIdx = Math.max(0, from) + m.index;
		const before = absIdx > 0 ? text[absIdx - 1] : "";
		const afterIdx = absIdx + m[0].length;
		const after = afterIdx < text.length ? text[afterIdx] : "";
		const symmetric = (before === '"' && after === '"') || (before === "'" && after === "'") || (before === "`" && after === "`");
		if (!symmetric && !REPO_ROOTED_PREFIX_RE.test(m[0])) continue;
		if (!isUsableProtectedToken(m[0])) {
			// 065 D2/F-4 (grill round 1): rejects are LOUD (P10) — collected
			// here, drained per file into inventory.scanLines by the walk.
			if (!windowTokenRejects.includes(m[0])) windowTokenRejects.push(m[0]);
			if (rejectSink && !rejectSink.includes(m[0])) rejectSink.push(m[0]);
			continue;
		}
		const usable = claimPathUsable(m[0]);
		if (usable && !seen.has(usable)) {
			seen.add(usable);
			out.push(usable);
		}
	}
	return out;
}

/** 065 D2/F-4: the P10 reject accumulator — drained per file by
 *  extractContractInventory into scanLines, never silently dropped. */
export const windowTokenRejects: string[] = [];
