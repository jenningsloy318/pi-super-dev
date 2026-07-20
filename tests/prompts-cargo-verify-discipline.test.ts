/**
 * Phase 3 (Fix 3) — Agent Self-Verification Prompt Discipline.
 *
 * RED-phase tests: assert that `buildImplementPrompt` and `buildQaPrompt`
 * (src/prompts.ts) carry language-scoped Rust self-verification discipline:
 *   - run `cargo test -p <pkg>` with NO `--lib` flag (so `tests/` integration
 *     binaries execute),
 *   - PLUS any spec-mandated e2e/integration target,
 *   - and an explicit instruction that `--lib`-only evidence is NOT a green.
 *
 * These are PROMPT-TEXT only assertions (no control-flow / nodes / stages).
 * Covers AC-07, SCENARIO-010 (implement) and SCENARIO-011 (qa). The
 * substring contract mirrors the spec's Testing Strategy (f).
 *
 * `classification` is passed as `null` throughout: the discipline is
 * appended UNCONDITIONALLY to the instruction arrays and scoped to Rust via
 * its wording ("When verifying a Rust crate…"), so it must appear regardless
 * of the active stack.
 */

import { describe, it, expect } from "vitest";
import { buildImplementPrompt, buildQaPrompt } from "../src/prompts.ts";
import type { SetupControl } from "../src/types.ts";

function mkSetup(language = "rust"): SetupControl {
	return {
		worktreePath: "/tmp/repo",
		specDirectory: "/tmp/repo/specs/",
		defaultBranch: "main",
		language,
		isWebUi: false,
		specIdentifier: "test",
		worktreeCreated: true,
		initializedRepo: false,
	};
}

const PHASE = { name: "Phase 3 — Agent Self-Verification Prompt Discipline", description: "Prompt-text only." };

/**
 * Normalize markdown backticks away so the assertions are robust to whether
 * the implementation styles the flag as `--lib`, ``--lib``, or --lib.
 */
const flat = (s: string) => s.replace(/`/g, "");

describe("buildImplementPrompt — cargo self-verification discipline (AC-07, SCENARIO-010)", () => {
	it("requires `cargo test -p <pkg>` (scoped test command with a package placeholder)", () => {
		const out = buildImplementPrompt(mkSetup(), null, PHASE, { languageInstructions: "" }, null);
		expect(out).toContain("cargo test -p");
		// there must be a package placeholder after `-p ` (e.g. <pkg> or <package>)
		expect(flat(out)).toMatch(/cargo test -p <[^>]+>/);
	});

	it("forbids the `--lib` flag on the cargo test verification", () => {
		const out = buildImplementPrompt(mkSetup(), null, PHASE, { languageInstructions: "" }, null);
		expect(out).toContain("--lib");
		// explicit forbiddance: "without"/"no"/"NOT … --lib"
		expect(flat(out)).toMatch(/((without|no|never|not)\b[^]*--lib|--lib\b[^]*(without|no|never|not))/i);
	});

	it("references the `tests/` integration binaries that `--lib` skips", () => {
		const out = buildImplementPrompt(mkSetup(), null, PHASE, { languageInstructions: "" }, null);
		expect(out).toContain("tests/");
		expect(out.toLowerCase()).toContain("integration");
		expect(out.toLowerCase()).toContain("binaries");
	});

	it("requires any spec-mandated e2e/integration target in addition to unit tests", () => {
		const out = buildImplementPrompt(mkSetup(), null, PHASE, { languageInstructions: "" }, null);
		expect(flat(out)).toMatch(/(e2e|end.to.end|integration)/i);
	});

	it("states that `--lib`-only evidence is NOT a green", () => {
		const out = buildImplementPrompt(mkSetup(), null, PHASE, { languageInstructions: "" }, null);
		expect(out).toContain("--lib");
		expect(out.toLowerCase()).toContain("green");
		// a forbiddance word must tie the --lib mention to the green claim
		expect(flat(out)).toMatch(/(not|never|do not|don't)[^]*green|--lib[^]*(not|never)/i);
	});

	it("appends the Rust discipline as generic wording for non-Rust stacks (language-scoped, not gated)", () => {
		// frontend setup — the discipline is still present, scoped via "when Rust"
		const out = buildImplementPrompt(mkSetup("frontend"), null, PHASE, { languageInstructions: "" }, null);
		expect(out).toContain("cargo test -p");
		expect(out).toContain("tests/");
		expect(out.toLowerCase()).toContain("rust");
	});

	it("preserves the original implement instructions (no regression)", () => {
		const out = buildImplementPrompt(mkSetup(), null, PHASE, { languageInstructions: "" }, null);
		expect(out).toContain("green phase of TDD");
		expect(out).toContain("minimal and focused");
	});

	it("still injects provided language-specific instructions AND the cargo discipline", () => {
		const out = buildImplementPrompt(
			mkSetup(),
			null,
			PHASE,
			{ languageInstructions: "## Frontend specialist profile\nUse vitest." },
			null,
		);
		expect(out).toContain("## Frontend specialist profile");
		expect(out).toContain("Use vitest.");
		// discipline survives alongside injected language instructions
		expect(out).toContain("cargo test -p");
	});
});

describe("buildQaPrompt — cargo self-verification discipline (AC-07, SCENARIO-011)", () => {
	it("requires `cargo test -p <pkg>` (scoped test command with a package placeholder)", () => {
		const out = buildQaPrompt(mkSetup(), null, PHASE);
		expect(out).toContain("cargo test -p");
		expect(flat(out)).toMatch(/cargo test -p <[^>]+>/);
	});

	it("forbids the `--lib` flag on the cargo test verification", () => {
		const out = buildQaPrompt(mkSetup(), null, PHASE);
		expect(out).toContain("--lib");
		expect(flat(out)).toMatch(/((without|no|never|not)\b[^]*--lib|--lib\b[^]*(without|no|never|not))/i);
	});

	it("references the `tests/` integration binaries that `--lib` skips", () => {
		const out = buildQaPrompt(mkSetup(), null, PHASE);
		expect(out).toContain("tests/");
		expect(out.toLowerCase()).toContain("integration");
		expect(out.toLowerCase()).toContain("binaries");
	});

	it("requires any spec-mandated e2e/integration target in addition to unit tests", () => {
		const out = buildQaPrompt(mkSetup(), null, PHASE);
		expect(flat(out)).toMatch(/(e2e|end.to.end|integration)/i);
	});

	it("states that `--lib`-only evidence is NOT a green", () => {
		const out = buildQaPrompt(mkSetup(), null, PHASE);
		expect(out).toContain("--lib");
		expect(out.toLowerCase()).toContain("green");
		expect(flat(out)).toMatch(/(not|never|do not|don't)[^]*green|--lib[^]*(not|never)/i);
	});

	it("appends the Rust discipline as generic wording for non-Rust stacks (language-scoped, not gated)", () => {
		const out = buildQaPrompt(mkSetup("frontend"), null, PHASE);
		expect(out).toContain("cargo test -p");
		expect(out).toContain("tests/");
		expect(out.toLowerCase()).toContain("rust");
	});

	it("preserves the original qa instructions (no regression)", () => {
		const out = buildQaPrompt(mkSetup(), null, PHASE);
		expect(out.toLowerCase()).toContain("coverage");
		expect(out).toContain("regressions");
	});
});

describe("Phase 3 boundary — no control-flow / stages wiring change", () => {
	it("both builders return plain strings (prompt-TEXT only; stages consume them unchanged)", () => {
		expect(typeof buildImplementPrompt(mkSetup(), null, PHASE, { languageInstructions: "" }, null)).toBe("string");
		expect(typeof buildQaPrompt(mkSetup(), null, PHASE)).toBe("string");
	});
});
