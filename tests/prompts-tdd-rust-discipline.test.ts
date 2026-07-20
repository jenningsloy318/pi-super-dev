/**
 * Phase P4 — no-`--lib` discipline parity for the TDD (RED-phase) prompt
 * (Gap 3, AC-03 → SCENARIO-010 RED).
 *
 * RED-phase tests written BEFORE the P4 implementation exists. Today
 * `src/prompts.ts`:
 *   - declares `RUST_SELF_VERIFY_DISCIPLINE` as a private `const`,
 *   - declares `rustDiscipline(s: SetupControl)` as a PRIVATE (non-exported)
 *     function used by `buildImplementPrompt` and `buildQaPrompt`,
 *   - and `buildTddPrompt(s, c, phase, specControl, langInstructions = "")`
 *     ALREADY accepts a `langInstructions` arg and renders it under a
 *     "## Language-Specific Instructions" header — but it does NOT bake the
 *     Rust discipline into its body.
 *
 * P4's deliverable (spec §C / phase description): export `rustDiscipline` from
 * prompts.ts (single source of truth — `buildTddPrompt` and `buildImplementPrompt`
 * MUST reference the IDENTICAL `RUST_SELF_VERIFY_DISCIPLINE` string) so that
 * `src/stages/implementation.ts` can pass `rustDiscipline(setup)` as the
 * `langInstructions` arg. The discipline TEXT itself (prompts.ts:99/105) is
 * UNCHANGED — the fix is an export + a caller-side wiring change.
 *
 * So every assertion that requires the `rustDiscipline` export is RED today
 * (the named import does not exist), and the snapshot assertions about the
 * rendered TDD prompt only go GREEN once a caller passes the discipline in.
 *
 * Contract (spec Testing Strategy — Phase 4):
 *   - the TDD prompt for a `rust` setup contains the no-`--lib` clause PLUS the
 *     integration-target instruction; a non-rust setup OMITS it;
 *   - `buildTddPrompt` and `buildImplementPrompt` share the IDENTICAL
 *     `RUST_SELF_VERIFY_DISCIPLINE` substring (single source of truth).
 *
 * NOTE on `--test <stem>`: the spec's testing-strategy prose mentions a
 * "cargo test --test <stem>" instruction, but the phase description is
 * explicit that prompts.ts:99/105 text is UNCHANGED and the existing
 * `RUST_SELF_VERIFY_DISCIPLINE` const only carries `cargo test -p <pkg>` plus
 * the "PLUS any spec-mandated e2e or integration target" clause. We therefore
 * assert the integration-target instruction via the EXISTING wording rather
 * than a stem that the discipline text does not (and must not) contain.
 */

import { describe, it, expect } from "vitest";
import { buildTddPrompt, buildImplementPrompt, rustDiscipline } from "../src/prompts.ts";
import type { SetupControl } from "../src/types.ts";

function mkSetup(language = "rust"): SetupControl {
	return {
		worktreePath: "/tmp/repo",
		specDirectory: "/tmp/repo/specs/",
		defaultBranch: "main",
		language,
		isWebUi: false,
		specIdentifier: "p4",
		worktreeCreated: true,
		initializedRepo: false,
	};
}

const PHASE = { name: "P4 — Mirror no-`--lib` discipline into the TDD prompt (Gap 3)", description: "Prompt-text + export only." };

/** Strip markdown backticks so assertions are robust to `--lib` styling. */
const flat = (s: string) => s.replace(/`/g, "");

/** Stable substring unique to the Rust self-verify discipline. */
const RUST_DISCIPLINE_MARKER = "never sufficient proof";

describe("P4 — rustDiscipline export (AC-03 foundation, single source of truth)", () => {
	it("exports rustDiscipline as a function", () => {
		expect(typeof rustDiscipline).toBe("function");
	});

	it("returns a non-empty discipline string for a rust setup", () => {
		const out = rustDiscipline(mkSetup("rust"));
		expect(typeof out).toBe("string");
		expect(out.length).toBeGreaterThan(0);
		expect(out).toContain(RUST_DISCIPLINE_MARKER);
	});

	it("returns the empty string for every non-rust stack (language-gated, not broadcast)", () => {
		for (const lang of ["frontend", "backend", "python", "mixed", ""]) {
			expect(rustDiscipline(mkSetup(lang as SetupControl["language"]))).toBe("");
		}
	});

	it("degrades to the empty string on null/undefined setup (never throws)", () => {
		expect(rustDiscipline(null as unknown as SetupControl)).toBe("");
		expect(rustDiscipline(undefined as unknown as SetupControl)).toBe("");
		// setup with no `language` field must not throw either
		expect(rustDiscipline({} as SetupControl)).toBe("");
	});
});

describe("P4 — buildTddPrompt carries the no-`--lib` discipline for rust (AC-03, SCENARIO-010 RED)", () => {
	it("renders the discipline when rustDiscipline(setup) is passed as langInstructions", () => {
		const setup = mkSetup("rust");
		const out = buildTddPrompt(setup, null, PHASE, null, rustDiscipline(setup));

		// scoped cargo test command with a package placeholder
		expect(out).toContain("cargo test -p");
		expect(flat(out)).toMatch(/cargo test -p <[^>]+>/);

		// explicit forbiddance of the --lib flag
		expect(out).toContain("--lib");
		expect(flat(out)).toMatch(/((without|no|never|not)\b[^]*--lib|--lib\b[^]*(without|no|never|not))/i);

		// integration-target instruction (spec-mandated e2e/integration target)
		expect(flat(out)).toMatch(/(e2e|end.to.end|integration)/i);

		// references the tests/ integration binaries that --lib skips
		expect(out).toContain("tests/");
		expect(out.toLowerCase()).toContain("integration");

		// the unique marker survives in the rendered TDD prompt
		expect(out).toContain(RUST_DISCIPLINE_MARKER);
	});

	it("omits the discipline when a non-rust setup is passed (frontend)", () => {
		const setup = mkSetup("frontend");
		const out = buildTddPrompt(setup, null, PHASE, null, rustDiscipline(setup));
		expect(out).not.toContain("cargo test -p");
		expect(out).not.toContain(RUST_DISCIPLINE_MARKER);
	});

	it("omits the discipline for rust when NO langInstructions are passed (proves the discipline is NOT baked into buildTddPrompt's body — the caller MUST pass it)", () => {
		const setup = mkSetup("rust");
		// default arg (omitted) — this is the PRE-P4 shape; it documents WHY the
		// caller-side wiring (implementation.ts) is required for parity.
		const out = buildTddPrompt(setup, null, PHASE, null);
		expect(out).not.toContain("cargo test -p");
		expect(out).not.toContain(RUST_DISCIPLINE_MARKER);
	});

	it("renders the discipline under the Language-Specific Instructions header", () => {
		const setup = mkSetup("rust");
		const out = buildTddPrompt(setup, null, PHASE, null, rustDiscipline(setup));
		expect(out).toContain("## Language-Specific Instructions");
		// discipline body appears within that section, before the Instructions block
		expect(out.indexOf(RUST_DISCIPLINE_MARKER)).toBeGreaterThan(out.indexOf("## Language-Specific Instructions"));
		expect(out.indexOf("## Instructions")).toBeGreaterThan(out.indexOf(RUST_DISCIPLINE_MARKER));
	});

	it("preserves the original TDD (RED-phase) instructions (no regression)", () => {
		const setup = mkSetup("rust");
		const out = buildTddPrompt(setup, null, PHASE, null, rustDiscipline(setup));
		expect(out).toContain("Write failing tests FIRST");
		expect(out).toContain("red phase of TDD");
		// control contract still present
		expect(out).toContain("testFiles");
		expect(out).toContain("allFailing");
	});
});

describe("P4 — single source of truth: TDD + implement prompts share the identical discipline substring", () => {
	it("buildTddPrompt and buildImplementPrompt embed the SAME discipline substring for a rust setup", () => {
		const setup = mkSetup("rust");
		const discipline = rustDiscipline(setup);
		expect(discipline.length).toBeGreaterThan(0);

		const tddOut = buildTddPrompt(setup, null, PHASE, null, discipline);
		const implOut = buildImplementPrompt(setup, null, PHASE, { languageInstructions: "" }, null);

		// both contain the verbatim discipline string (single source of truth)
		expect(tddOut).toContain(discipline);
		expect(implOut).toContain(discipline);
		// both contain the unique marker
		expect(tddOut).toContain(RUST_DISCIPLINE_MARKER);
		expect(implOut).toContain(RUST_DISCIPLINE_MARKER);
	});

	it("neither prompt embeds the discipline for a non-rust setup", () => {
		const setup = mkSetup("frontend");
		const discipline = rustDiscipline(setup);
		expect(discipline).toBe("");

		const tddOut = buildTddPrompt(setup, null, PHASE, null, discipline);
		const implOut = buildImplementPrompt(setup, null, PHASE, { languageInstructions: "" }, null);
		expect(tddOut).not.toContain(RUST_DISCIPLINE_MARKER);
		expect(implOut).not.toContain(RUST_DISCIPLINE_MARKER);
	});
});

describe("P4 boundary — prompt-TEXT + export only (no control-flow / stage contract change)", () => {
	it("buildTddPrompt returns a plain string for both rust and non-rust setups", () => {
		const rust = mkSetup("rust");
		const frontend = mkSetup("frontend");
		expect(typeof buildTddPrompt(rust, null, PHASE, null, rustDiscipline(rust))).toBe("string");
		expect(typeof buildTddPrompt(frontend, null, PHASE, null, rustDiscipline(frontend))).toBe("string");
	});
});
