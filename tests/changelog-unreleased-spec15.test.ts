/**
 * Phase 5 (Feature 5) — CHANGELOG `[Unreleased]` entry for spec-15
 * (pi integration modernization) — RED→GREEN tests.
 *
 * AC-11 → SCENARIO-018: the CHANGELOG.md `[Unreleased]` section gains a concise
 * Keep-a-Changelog entry that summarizes the four shipped Features 1–4 of
 * spec-15 (pi integration modernization):
 *   1. Specialists INHERIT the live main session's MODEL + THINKING level
 *      (additive inheritedModel/inheritedThinking DEFAULTS, widened precedence,
 *      explicit param / SUPER_DEV_* env never clobbered).
 *   2. CONSTRAINED (json_schema / strict) tool sampling on the
 *      structured_output tool, gated by isStrictCapable(schema); the permissive
 *      controlSchema + missingKeys() corrective re-prompt is preserved as the
 *      fallback for non-capable providers / permissive schemas.
 *   3. The registerEntryRenderer capability cast is removed; the renderer is
 *      registered directly through the typed 0.82.1 public API.
 *   4. Build-gate runs are tagged with the PI_SESSION_ID / PI_MODEL bash
 *      session-env vars for parallel-run correlation (observability-only).
 * The entry also notes the ALREADY-COMMITTED ^0.82.1 @earendil-works/pi-coding-agent
 * toolchain bump.
 *
 * These are pure file-content assertions (the spec's Phase-5 `requireContains`
 * strategy) typed against CHANGELOG.md. They define the CONTRACT any faithful
 * summary must satisfy — the concepts that MUST appear — and deliberately do
 * NOT hardcode the prose, so the entry may be written naturally.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const CHANGELOG = readFileSync(CHANGELOG_PATH, "utf8");

/**
 * Slice the Keep-a-Changelog `[Unreleased]` section — from its header up to
 * (but excluding) the next top-level version header (`## [0.x.x]`). Returns ""
 * when the section is absent. Used so feature-anchor assertions are scoped to
 * the unreleased body (not the whole history).
 */
function unreleasedSection(md: string): string {
	const startIdx = md.indexOf("## [Unreleased]");
	if (startIdx === -1) return "";
	const afterStart = startIdx + 1; // search past the `[Unreleased]` header itself
	const nextHeader = md.indexOf("\n## [", afterStart);
	const endIdx = nextHeader === -1 ? md.length : nextHeader;
	return md.slice(startIdx, endIdx);
}

const UNRELEASED = unreleasedSection(CHANGELOG);

describe("Phase 5 (Feature 5 / AC-11) — CHANGELOG [Unreleased] entry for spec-15", () => {
	describe("SCENARIO-018: a Keep-a-Changelog entry summarizes Features 1–4 under [Unreleased]", () => {
		it("the CHANGELOG still carries an `[Unreleased]` section (placement guard)", () => {
			expect(UNRELEASED.length).toBeGreaterThan(0);
			expect(UNRELEASED.startsWith("## [Unreleased]")).toBe(true);
		});

		it("the entry lives UNDER `[Unreleased]`, not under a new released-version header", () => {
			// The first released version after [Unreleased] is the newest
			// released header (0.3.31 since v0.3.31 shipped) — no premature
			// future-version header for unreleased summaries.
			const afterUnreleased = CHANGELOG.slice(
				CHANGELOG.indexOf("## [Unreleased]") + "## [Unreleased]".length,
			);
			const nextVersionMatch = afterUnreleased.match(/\n## \[(\d+\.\d+\.\d+)\]/);
			expect(nextVersionMatch).not.toBeNull();
			expect(nextVersionMatch![1]).toBe("0.3.31");
		});

		it("Feature 1: the entry mentions INHERITING the main session's model + thinking", () => {
			expect(UNRELEASED).toMatch(/inherit/i);
			expect(UNRELEASED).toMatch(/model/i);
			expect(UNRELEASED).toMatch(/thinking/i);
		});

		it("Feature 2: the entry mentions CONSTRAINED sampling for the structured_output tool", () => {
			expect(UNRELEASED).toMatch(/constrain/i);
			expect(UNRELEASED).toMatch(/structured[-_ ]?output/i);
		});

		it("Feature 3: the entry mentions the typed registerEntryRenderer (cast removed)", () => {
			expect(UNRELEASED).toContain("registerEntryRenderer");
		});

		it("Feature 4: the entry mentions the PI_SESSION_ID / PI_MODEL build-gate correlation tagging", () => {
			// At least one of the two documented env vars, or the correlation tag,
			// must surface so a reader can see the observability hook.
			expect(UNRELEASED).toMatch(/PI_SESSION_ID|PI_MODEL|correlation/i);
		});

		it("the entry notes the already-committed ^0.82.1 pi-coding-agent bump", () => {
			expect(UNRELEASED).toMatch(/0\.82\.1/);
		});

		it("the entry is written in the established bold-leading-bullet Keep-a-Changelog prose style", () => {
			// The repo's bullets are `**<Title with its period INSIDE the bold>**`
			// (e.g. `**Per-stage log sections (spec-12).**`). A bullet that starts
			// with `- **` and closes with `**` AND mentions at least one new feature
			// anchor ties the prose style to the new content — the existing
			// unreleased bullets do not mention these anchors, so they don't match.
			const boldBulletAnchored = /(^|\n)- \*\*[^*\n]*(inherit|model|thinking|constrain|structured[-_ ]?output|registerEntryRenderer|PI_SESSION_ID|PI_MODEL)[^*\n]*\*\*/i;
			expect(UNRELEASED).toMatch(boldBulletAnchored);
		});

		it("the entry sits beneath a Keep-a-Changelog `### Added` / `### Changed` / `### Fixed` subsection", () => {
			expect(UNRELEASED).toMatch(/### (Added|Changed|Fixed|Deprecated|Removed|Security)\b/);
		});
	});

	describe("SCENARIO-018 (regression): the prior [Unreleased] entries are preserved intact", () => {
		// Adding the summary must not clobber the existing entries that were
		// already under [Unreleased] before this phase.
		it("retains the per-stage log sections (spec-12) entry", () => {
			expect(UNRELEASED).toContain("Per-stage log sections");
		});

		it("retains the git change-tracker (spec-11) entry", () => {
			expect(UNRELEASED).toContain("Git change-tracker");
		});

		it("retains the cargo package-name build-gate fix", () => {
			expect(UNRELEASED).toContain("resolves real cargo package names");
		});
	});
});
