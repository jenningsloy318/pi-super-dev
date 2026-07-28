/**
 * Phase: CHANGELOG `[Unreleased]` entry for spec-17
 * (ambient extension inheritance + excludeTools) — RED→GREEN tests.
 *
 * AC-07 → SCENARIO-012: the CHANGELOG.md `[Unreleased]` section gains a
 * Keep-a-Changelog `### Added` bullet summarizing the opt-in. The bullet's
 * bold (`**...**`) span text MUST carry the contract anchor token `inherit`
 * (so the shared `boldBulletAnchored` regex of
 * tests/changelog-unreleased-spec15.test.ts matches it), and the prose MUST
 * surface the recursion-safe self-exclusion (`excludeTools` + `super_dev`). No previously
 * matched anchor / bullet may be removed or reordered.
 *
 * These are pure file-content assertions typed against CHANGELOG.md. They are
 * written BEFORE the entry exists so they FAIL (RED); adding the bullet turns
 * them GREEN. The prose itself is intentionally NOT hardcoded — only the
 * contract concepts that MUST appear are asserted.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CHANGELOG_PATH = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const CHANGELOG = readFileSync(CHANGELOG_PATH, "utf8");

/**
 * Slice the Keep-a-Changelog `[Unreleased]` section — from its header up to
 * (but excluding) the next top-level version header (`## [0.x.x]`). Returns ""
 * when the section is absent. Mirrors the helper in
 * tests/changelog-unreleased-spec15.test.ts so the two contracts stay in sync.
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

/**
 * The shared boldBulletAnchored regex (mirrored from the spec-15 contract
 * test). A bullet that starts with `- **`, contains one of the anchor tokens
 * (case-insensitive), and closes with `**`.
 */
const BOLD_BULLET_ANCHORED =
	/(^|\n)- \*\*[^*\n]*(inherit|model|thinking|constrain|structured[-_ ]?output|registerEntryRenderer|PI_SESSION_ID|PI_MODEL)[^*\n]*\*\*/i;

describe("CHANGELOG [Unreleased] entry for spec-17 (ambient extension inheritance + excludeTools)", () => {
	describe("AC-07 / SCENARIO-012: a new ### Added bullet summarizes the change", () => {
		it("the CHANGELOG still carries an `[Unreleased]` section (placement guard)", () => {
			expect(UNRELEASED.length).toBeGreaterThan(0);
			expect(UNRELEASED.startsWith("## [Unreleased]")).toBe(true);
		});

		it("the entry documents the recursion-safe self-exclusion (excludeTools + super_dev)", () => {
			expect(UNRELEASED).toMatch(/excludeTools/);
			expect(UNRELEASED).toMatch(/super_dev/);
		});

		it("the entry is tagged spec-17 so it is attributable", () => {
			expect(UNRELEASED).toMatch(/spec-17/);
		});

		it("the entry sits beneath a Keep-a-Changelog subsection header", () => {
			expect(UNRELEASED).toMatch(/### (Added|Changed|Fixed|Deprecated|Removed|Security)\b/);
		});

		it("a bold-leading bullet whose bold span carries the `inherit` anchor token exists", () => {
			// The boldBulletAnchored regex shared with the spec-15 contract test.
			expect(UNRELEASED).toMatch(BOLD_BULLET_ANCHORED);
		});

		it("the spec-17 bullet is itself a bold-leading bullet whose bold span carries `inherit`", () => {
			// The specific spec-17 bullet: a bold bullet that mentions the
			// recursion-safe self-exclusion (excludeTools) AND whose bold span
			// carries `inherit` (extensions/provider alone must NOT satisfy).
			const lines = UNRELEASED.split("\n");
			const spec17BoldBullet = lines.some((line) => {
				if (!/^\s*-\s+\*\*/.test(line)) return false;
				if (!/excludeTools/.test(line)) return false;
				const boldSpan = line.match(/\*\*([^*]*)\*\*/);
				if (!boldSpan) return false;
				return /inherit/i.test(boldSpan[1]);
			});
			expect(spec17BoldBullet).toBe(true);
		});
	});

	describe("SCENARIO-012 (regression): prior [Unreleased] anchors/bullets are preserved", () => {
		it("retains the spec-15 model-wholesale fix entry", () => {
			expect(UNRELEASED).toContain("Inherit the main session's model WHOLESALE");
		});

		it("retains the spec-15 pi integration modernization entry", () => {
			expect(UNRELEASED).toContain("pi integration modernization");
		});

		it("retains the per-stage log sections (spec-12) entry", () => {
			expect(UNRELEASED).toContain("Per-stage log sections");
		});

		it("retains the git change-tracker (spec-11) entry", () => {
			expect(UNRELEASED).toContain("Git change-tracker");
		});

		it("retains the cargo package-name build-gate fix", () => {
			expect(UNRELEASED).toContain("resolves real cargo package names");
		});

		it("the next released version after [Unreleased] is still 0.3.0 (no premature release header)", () => {
			const afterUnreleased = CHANGELOG.slice(
				CHANGELOG.indexOf("## [Unreleased]") + "## [Unreleased]".length,
			);
			const nextVersionMatch = afterUnreleased.match(/\n## \[(\d+\.\d+\.\d+)\]/);
			expect(nextVersionMatch).not.toBeNull();
			expect(nextVersionMatch![1]).toBe("0.3.0");
		});
	});
});
