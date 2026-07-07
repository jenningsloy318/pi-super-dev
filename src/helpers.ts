/**
 * Deterministic pipeline helpers — pure functions over control JSON. Ported
 * from the original pi-workflow `helpers/*.mjs` so agent contracts are
 * unchanged. `runHelper(name, sources, options, context)` dispatches.
 */

import type { ControlObj, HelperCall, HelperResult, SetupControl } from "./types.ts";
import {
	readSpecDoc,
	specDocExists,
	toNumber,
	toBool,
	isApprovedVerdict,
	requirementsContentErrors,
	bddContentErrors,
	specContentErrors,
	specReviewContentErrors,
} from "./doc-validators.ts";

const ok = (digest: string, value: ControlObj): HelperResult => ({ value, digest });
const fail = (gate: string, errors: string[]): HelperResult => ({
	value: { pass: errors.length === 0, errors, gate },
	digest: errors.length === 0 ? "PASS" : `FAIL: ${errors.length} error(s)`,
});

// ─── classify-task ──────────────────────────────────────────────────────────

const BUG_RE = /\b(bug|fix|broken|crash|error|panic|fail|regression)\b/i;
const REFACTOR_RE = /\b(refactor|restructure|improve|cleanup|clean up)\b/i;

function classifyTask(s: Record<string, unknown>, o?: Record<string, unknown>): HelperResult {
	const setup = s["setup"] as { language?: string; isWebUi?: boolean } | undefined;
	if (!setup) return ok("FAIL: missing setup source", { taskType: "feature", uiScope: "none", language: "mixed", isWebUi: false, skipStages: [] });
	const language = setup.language ?? "mixed";
	const isWebUi = setup.isWebUi ?? false;
	const task = (o?.runtimeTask as string) ?? "";
	const taskType: "bug" | "feature" | "refactor" = BUG_RE.test(task) ? "bug" : REFACTOR_RE.test(task) ? "refactor" : "feature";
	const uiScope = isWebUi ? "ui+arch" : "none";
	return ok(`Task: ${taskType}, UI: ${uiScope}, Lang: ${language}`, { taskType, uiScope, language, isWebUi, skipStages: [] });
}

// ─── route-designer ─────────────────────────────────────────────────────────

function routeDesigner(s: Record<string, unknown>): HelperResult {
	const c = s["classify-task"] as { taskType?: string; uiScope?: string } | undefined;
	if (!c) return ok("FAIL: missing classify-task source", { designerAgent: null, reason: "Missing upstream: classify-task" });
	let designerAgent: string | null = null;
	let reason = "";
	if (c.taskType === "bug") reason = "Bug fixes do not redesign";
	else if (c.uiScope === "ui+arch") { designerAgent = "product-designer"; reason = "Both UI and architecture changes needed"; }
	else if (c.uiScope === "ui-only") { designerAgent = "ui-ux-designer"; reason = "UI-only changes"; }
	else if (c.taskType === "refactor") { designerAgent = "architecture-improver"; reason = "Refactoring existing architecture"; }
	else { designerAgent = "architecture-designer"; reason = "New feature requires architecture design"; }
	return ok(designerAgent ? `Route to ${designerAgent}` : "Skip design (bug fix)", { designerAgent, reason });
}

// ─── check-prototype-needed ──────────────────────────────────────────────────

function checkPrototypeNeeded(s: Record<string, unknown>): HelperResult {
	const design = s["design"] as { hasNumericConstants?: boolean; modules?: Array<{ constants?: string[] }> } | undefined;
	if (!design) return ok("No design source — prototype not needed", { needed: false, constants: [] });
	const needed = design.hasNumericConstants === true;
	const constants: string[] = [];
	if (needed && Array.isArray(design.modules)) for (const m of design.modules) if (Array.isArray(m.constants)) constants.push(...m.constants);
	return ok(needed ? `Prototype needed: ${constants.length} constant(s)` : "Prototype not needed", { needed, constants });
}

// ─── route-specialist ────────────────────────────────────────────────────────
// Per-language specialist guidance lives in `agents/lang/<lang>.md` (prose
// profiles: commands, coverage, file-organization, idioms) and is injected into
// the implementer + tdd-guide prompts. This keeps a single generic implementer
// agent but gives it language-specific guardrails (Gap 4.1).
import { loadLangProfile } from "./agents.ts";

function routeSpecialist(s: Record<string, unknown>): HelperResult {
	const c = s["classify-task"] as { language?: string } | undefined;
	if (!c) return ok("FAIL: missing classify-task source", { specialistAgent: "implementer", languageInstructions: "", reason: "Missing upstream: classify-task" });
	const languageInstructions = loadLangProfile(c.language ?? "mixed");
	return ok(`Specialist: implementer (${c.language ?? "mixed"})`, { specialistAgent: "implementer", languageInstructions, reason: `Generic implementer with ${c.language ?? "mixed"}-specific prompt augmentation` });
}

// ─── gates ──────────────────────────────────────────────────────────────────
// Each spec-stage gate validates the ACTUAL .md file the agent wrote (via
// doc-validators.ts), falling back to the agent's self-reported control JSON
// only when no doc can be found on disk. Content checks are authoritative —
// they catch false negatives where the doc is good but the control object is
// misshapen (the BDD gate failure). Metadata gates (build, review) coerce
// string↔number↔boolean so a model returning "13"/"true" doesn't trip them.

function setupSpecDir(s: Record<string, unknown>): string {
	return (s["setup"] as SetupControl | undefined)?.specDirectory ?? "";
}

function gateRequirements(s: Record<string, unknown>): HelperResult {
	const req = s["write-requirements"] as ControlObj | undefined;
	const errors: string[] = [];
	if (!req) errors.push("Missing upstream: write-requirements");
	else {
		const doc = readSpecDoc(setupSpecDir(s), req, "*-requirements.md");
		if (doc) errors.push(...requirementsContentErrors(doc.content));
		else {
			// No doc on disk — fall back to self-reported metadata.
			if (!req.docPath) errors.push("No requirements doc found (no docPath, and no *-requirements.md in the spec dir)");
			if ((toNumber(req.acCount) ?? 0) < 1) errors.push("Missing acceptance criteria");
			if (!req.summary) errors.push("Missing summary section");
			if (!req.featureName) errors.push("Missing feature name");
		}
	}
	return fail("gate-requirements", errors);
}

function gateBdd(s: Record<string, unknown>): HelperResult {
	const bdd = s["write-bdd"] as ControlObj | undefined;
	const errors: string[] = [];
	if (!bdd) errors.push("Missing upstream: write-bdd");
	else {
		const doc = readSpecDoc(setupSpecDir(s), bdd, "*-bdd-scenarios.md");
		if (doc) {
			errors.push(...bddContentErrors(doc.content));
		} else {
			// No doc on disk — fall back to self-reported metadata (coerced).
			if (!bdd.docPath) errors.push("No BDD doc found (no docPath, and no *-bdd-scenarios.md in the spec dir)");
			if ((toNumber(bdd.scenarioCount) ?? 0) < 1) errors.push("No scenarios written");
			const score = toNumber(bdd.coverageScore);
			const edgeOk = toBool(bdd.edgeCasesCovered) || (score !== null && score >= 0.6);
			if (!edgeOk) errors.push("Insufficient edge case coverage (need edgeCasesCovered or coverageScore >= 0.6)");
		}
	}
	return fail("gate-bdd", errors);
}

function gateSpecTrace(s: Record<string, unknown>): HelperResult {
	const spec = s["write-spec"] as ControlObj | undefined;
	const errors: string[] = [];
	if (!spec) errors.push("Missing upstream: write-spec");
	else {
		// The implementation stage reads spec.phases from the CONTROL object, so it
		// MUST be a usable array — validate this ALWAYS, not only on the metadata
		// fallback path. (A good doc content but malformed phases control crashed
		// Stage 9 with "phases.entries is not a function".)
		if (!Array.isArray(spec.phases) || spec.phases.length === 0) errors.push("spec.phases must be a non-empty array of {name, description} objects (the implementation stage iterates it)");
		else {
			const unnamed = (spec.phases as Array<{ name?: string }>).filter((p) => !p?.name);
			if (unnamed.length > 0) errors.push(`${unnamed.length} phase(s) missing a name`);
		}
		if ((toNumber(spec.phaseCount) ?? 0) < 1) errors.push("Phase count must be at least 1");
		const dir = setupSpecDir(s);
		const doc = readSpecDoc(dir, spec, "*-specification.md", ["specificationPath", "docPath"]);
		if (doc) {
			errors.push(...specContentErrors(doc.content));
			if (!specDocExists(dir, "*-task-list.md")) errors.push("Task list file (*-task-list.md) missing");
			if (!specDocExists(dir, "*-implementation-plan.md")) errors.push("Implementation plan file (*-implementation-plan.md) missing");
		} else if (!spec.specificationPath) {
			errors.push("No specification path returned and no *-specification.md in the spec dir");
		}
	}
	return fail("gate-spec-trace", errors);
}

function gateSpecReview(s: Record<string, unknown>): HelperResult {
	const review = s["review-spec"] as ControlObj | undefined;
	const errors: string[] = [];
	if (!review) errors.push("Missing upstream: review-spec");
	else {
		const doc = readSpecDoc(setupSpecDir(s), review, "*-spec-review*.md");
		if (doc) errors.push(...specReviewContentErrors(doc.content));
		if (!isApprovedVerdict(review.verdict)) errors.push(`Verdict is "${review.verdict ?? ""}" — changes requested`);
	}
	return fail("gate-spec-review", errors);
}

function gateBuild(s: Record<string, unknown>): HelperResult {
	const qa = s["qa-check"] as ControlObj | undefined;
	const errors: string[] = [];
	if (!qa) errors.push("Missing upstream: qa-check");
	else {
		if (!toBool(qa.buildSuccess)) errors.push("Build failed");
		if (!toBool(qa.allTestsPass)) errors.push("Tests failing");
	}
	return fail("gate-build", errors);
}

function gateReview(s: Record<string, unknown>): HelperResult {
	const merged = s["merge-verdicts"] as ControlObj | undefined;
	const errors: string[] = [];
	if (!merged) errors.push("Missing upstream: merge-verdicts");
	else if (!isApprovedVerdict(merged.verdict)) errors.push(`Verdict is "${merged.verdict ?? ""}" — changes requested`);
	return fail("gate-review", errors);
}

// ─── merge-review-verdicts ──────────────────────────────────────────────────

const VERDICT_RANK: Record<string, number> = { Approved: 0, "Approved with Comments": 1, "Changes Requested": 2 };

function mergeReviewVerdicts(s: Record<string, unknown>): HelperResult {
	const codeReview = s["code-review"] as ControlObj | undefined;
	const adversarial = s["adversarial-review"] as ControlObj | undefined;
	if (!codeReview && !adversarial) return ok("FAIL: missing both review sources", { verdict: "Changes Requested", findings: [], dimensionsCovered: [] });
	const codeVerdict = (codeReview?.verdict as string) ?? "Approved";
	const advVerdict = (adversarial?.verdict as string) ?? "Approved";
	const verdict = (VERDICT_RANK[codeVerdict] ?? 0) >= (VERDICT_RANK[advVerdict] ?? 0) ? codeVerdict : advVerdict;
	const findings = [...((codeReview?.findings as unknown[]) ?? []), ...((adversarial?.findings as unknown[]) ?? [])];
	const dims = [...new Set([...((codeReview?.dimensionsCovered as unknown[]) ?? []), ...((adversarial?.dimensionsCovered as unknown[]) ?? [])] as string[])];
	return ok(`Merged verdict: ${verdict} (${findings.length} finding(s))`, { verdict, findings, dimensionsCovered: dims });
}

// ─── cleanup ────────────────────────────────────────────────────────────────

const BUILD_DIRS = new Set(["node_modules", "target", "dist", "build", "__pycache__", ".next", ".nuxt", ".output", "coverage", ".turbo"]);
const SENSITIVE_RE = [/\.env$/, /\.env\.local$/, /\.env\.production$/, /\.pem$/, /\.key$/, /id_rsa/, /id_ed25519/, /\.p12$/, /credentials\.json$/, /service[-_]account.*\.json$/];
const LANG_MARKERS: Record<string, string[]> = {
	rust: ["Cargo.toml", "Cargo.lock"], go: ["go.mod", "go.sum"], frontend: ["package.json", "tsconfig.json"], python: ["pyproject.toml", "setup.py", "requirements.txt"],
};

async function cleanup(_s: Record<string, unknown>, context?: Record<string, unknown>): Promise<HelperResult> {
	const cwd = context?.cwd as string | undefined;
	if (!cwd) return ok("FAIL: no cwd in context", { languagesDetected: [], directoriesRemoved: [], sensitiveDataFindings: [], blocked: false, summary: "Could not scan — no working directory provided" });
	const { readdir, stat } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const languagesDetected: string[] = [];
	for (const [lang, markers] of Object.entries(LANG_MARKERS)) {
		for (const marker of markers) {
			try { await stat(join(cwd, marker)); if (!languagesDetected.includes(lang)) languagesDetected.push(lang); break; } catch { /* absent */ }
		}
	}
	const directoriesRemoved: string[] = [];
	try { for (const e of await readdir(cwd, { withFileTypes: true })) if (e.isDirectory() && BUILD_DIRS.has(e.name)) directoriesRemoved.push(e.name); } catch { /* unreadable */ }
	const sensitiveDataFindings: string[] = [];
	try { for (const e of await readdir(cwd)) for (const re of SENSITIVE_RE) if (re.test(e)) { sensitiveDataFindings.push(`Sensitive file detected: ${e}`); break; } } catch { /* unreadable */ }
	const blocked = sensitiveDataFindings.length > 0;
	return ok(blocked ? `BLOCKED: ${sensitiveDataFindings.length} sensitive finding(s)` : `Clean: ${languagesDetected.length} lang(s), ${directoriesRemoved.length} build dir(s)`, {
		languagesDetected, directoriesRemoved, sensitiveDataFindings, blocked,
		summary: blocked ? `Merge blocked: found ${sensitiveDataFindings.length} sensitive data issue(s)` : `Worktree clean. Languages: ${languagesDetected.join(", ") || "none detected"}`,
	});
}

// ─── dispatcher ─────────────────────────────────────────────────────────────

const SYNC: Record<string, (s: Record<string, unknown>, o?: Record<string, unknown>) => HelperResult> = {
	"classify-task": classifyTask,
	"route-designer": routeDesigner,
	"check-prototype-needed": checkPrototypeNeeded,
	"route-specialist": routeSpecialist,
	"gate-requirements": gateRequirements,
	"gate-bdd": gateBdd,
	"gate-spec-trace": gateSpecTrace,
	"gate-spec-review": gateSpecReview,
	"gate-build": gateBuild,
	"gate-review": gateReview,
	"merge-review-verdicts": mergeReviewVerdicts,
};

export async function runHelper(call: HelperCall): Promise<HelperResult> {
	if (call.name === "cleanup") return cleanup(call.sources, call.context);
	const fn = SYNC[call.name];
	if (!fn) return ok(`FAIL: unknown helper "${call.name}"`, {});
	return fn(call.sources, call.options);
}

export const HELPER_NAMES = [...Object.keys(SYNC), "cleanup"];
