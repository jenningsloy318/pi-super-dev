/**
 * v0.3.71 W4 — REVIEW POLICY CAPS (F10-4) + PLAN Risks/Proof (F10-7).
 *
 * F10-4: review outputs feed writer re-prompt rounds — verbose, low-signal
 * findings inflate EVERY downstream round (SDLC REVIEW.md play: "cap the
 * nits"; OpenAI guidance: concise high-signal, verbose responses get
 * ignored). Both reviewer prompts gain: Important-vs-Nit definitions, a nit
 * cap (≤3 total; blocking findings suppress nits entirely), a do-not-report
 * list, and one-line-fix output discipline.
 *
 * F10-7: plan.md play — every phase carries Risks (what can go wrong) and
 * Proof (how completion is proven) so reviewers/judges/implementers share a
 * grounding anchor; optional fields keep old specs/resumes valid.
 *
 * Source-contract tests (prompt files + schema + template as the contract).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import { SpecPhase } from "../src/render/schemas.ts";
import { render } from "../src/render/template-engine.ts";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("v0.3.71 W4 — review prompt discipline (F10-4)", () => {
	it("code-reviewer defines Important vs Nit, caps nits at 3, and suppresses nits when blocking findings exist", () => {
		const md = read("agents/code-reviewer.md");
		expect(md).toMatch(/## Finding Discipline/);
		expect(md).toMatch(/Important.*correctness|correctness.*Important/i);
		expect(md).toMatch(/Nit.*style|style.*Nit/i);
		expect(md).toMatch(/at most 3 nits|≤ *3 nits|no more than 3 nits/i);
		expect(md).toMatch(/only (the )?blocking|report only Important/i); // nits suppressed under blocking findings
	});

	it("code-reviewer carries a do-not-report list and one-line-fix output discipline", () => {
		const md = read("agents/code-reviewer.md");
		expect(md).toMatch(/Do not report/i);
		expect(md).toMatch(/formatting|lint/i); // lint-covered issues
		expect(md).toMatch(/hypothetical/i); // hypotheticals without evidence
		expect(md).toMatch(/one-line fix|one-line suggested fix/i);
		expect(md).toMatch(/no code restatement|do not restate/i);
	});

	it("adversarial-reviewer carries the same discipline (adapted to its verdict contract)", () => {
		const md = read("agents/adversarial-reviewer.md");
		expect(md).toMatch(/## Finding Discipline/);
		expect(md).toMatch(/at most 3 nits|≤ *3 nits|no more than 3 nits/i);
		expect(md).toMatch(/Do not report/i);
		expect(md).toMatch(/severity inflation/i); // existing honesty rule kept
	});
});

describe("v0.3.71 W4 — plan Risks/Proof sections (F10-7)", () => {
	const TEMPLATE = "src/render/templates/implementation-plan.md.njk";

	it("SpecPhase accepts optional risks/proof arrays (backward compatible)", () => {
		expect(Value.Check(SpecPhase, { name: "p", description: "d" })).toBe(true); // old shape still valid
		expect(Value.Check(SpecPhase, { name: "p", description: "d", risks: ["concurrency: two writers"], proof: ["gate: build+deliverables"] })).toBe(true);
		expect(Value.Check(SpecPhase, { name: "p", description: "d", risks: "not-an-array" })).toBe(false);
	});

	it("the plan template renders Risks/Proof per phase, and renders fine without them", () => {
		const tpl = readFileSync(join(process.cwd(), TEMPLATE), "utf8");
		const withFields = render(tpl, { title: "T", date: "d", generatedAt: "g", phases: [{ name: "P1", description: "x", risks: ["data loss on partial write"], proof: ["deliverables clause: requireFiles"] }] });
		expect(withFields).toContain("### Risks");
		expect(withFields).toContain("data loss on partial write");
		expect(withFields).toContain("### Proof");
		expect(withFields).toContain("requireFiles");
		const without = render(tpl, { title: "T", date: "d", generatedAt: "g", phases: [{ name: "P1", description: "x" }] });
		expect(without).not.toContain("### Risks");
		expect(without).not.toContain("### Proof");
	});

	it("spec-writer prompt instructs per-phase risks and proof (token-bounded)", () => {
		const md = read("agents/spec-writer.md");
		expect(md).toMatch(/risks/i);
		expect(md).toMatch(/proof/i);
		expect(md).toMatch(/at most 3|max(imum)? 3|≤ *3/i); // bounded
	});
});
