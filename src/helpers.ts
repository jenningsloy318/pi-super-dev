/**
 * Deterministic pipeline helpers — pure functions over control JSON. Ported
 * from the original pi-workflow `helpers/*.mjs` so agent contracts are
 * unchanged. `runHelper(name, sources, options, context)` dispatches.
 */

import type { ControlObj, HelperCall, HelperResult, SetupControl } from "./types.ts";
import { spawnSync } from "node:child_process";
import { reviewHasBlockingFinding, reviewHasFindings, reviewHasHighSeverityFinding, inferReviewFindingStatus, reviewFindingSeverity } from "./review-findings.ts";
import {
	readSpecDoc,
	specDocExists,
	toNumber,
	toBool,
	isApprovedVerdict,
	requirementsContentErrors,
	bddContentErrors,
	bddTraceabilityErrors,
	specContentErrors,
	specGroundingErrors,
	specTraceabilityErrors,
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
		const dir = setupSpecDir(s);
		const doc = readSpecDoc(dir, bdd, "*-bdd-scenarios.md");
		if (doc) {
			errors.push(...bddContentErrors(doc.content));
			const requirementsDoc = readSpecDoc(dir, s["write-requirements"] as ControlObj | undefined, "*-requirements.md");
			if (requirementsDoc) errors.push(...bddTraceabilityErrors(requirementsDoc.content, doc.content));
			else errors.push("No requirements doc found for BDD traceability (no docPath, and no *-requirements.md in the spec dir)");
		} else {
			// No doc on disk: metadata is useful diagnostics, but cannot satisfy the
			// traceability gate because there is no artifact for downstream stages.
			errors.push("No BDD doc found (docPath missing/unreadable, and no *-bdd-scenarios.md in the spec dir)");
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
			errors.push(...specGroundingErrors(((s["setup"] as SetupControl | undefined)?.worktreePath ?? ""), doc.content));
			const bddDoc = readSpecDoc(dir, s["write-bdd"] as ControlObj | undefined, "*-bdd-scenarios.md");
			const requirementsDoc = readSpecDoc(dir, s["write-requirements"] as ControlObj | undefined, "*-requirements.md");
			if (bddDoc) errors.push(...specTraceabilityErrors(bddDoc.content, doc.content, spec, requirementsDoc?.content));
			else errors.push("No BDD doc found for spec traceability (no docPath, and no *-bdd-scenarios.md in the spec dir)");
			if (!requirementsDoc) errors.push("No requirements doc found for spec acceptance-criteria traceability (no docPath, and no *-requirements.md in the spec dir)");
			if (!specDocExists(dir, "*-task-list.md")) errors.push("Task list file (*-task-list.md) missing");
			if (!specDocExists(dir, "*-implementation-plan.md")) errors.push("Implementation plan file (*-implementation-plan.md) missing");
		} else {
			errors.push("No specification doc found (specificationPath/docPath missing or unreadable, and no *-specification.md in the spec dir)");
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

const VERDICT_RANK: Record<string, number> = { Approved: 0, "Approved with Comments": 1, "Changes Requested": 2, Blocked: 3 };

function normalizeReviewVerdict(sourceName: string, review: ControlObj | undefined): { verdict: string; syntheticFindings: ControlObj[] } {
	const fail = (reason: string) => ({
		verdict: "Changes Requested",
		syntheticFindings: [{ id: `${sourceName}-invalid`, severity: "high", title: `${sourceName} review unavailable`, detail: reason }],
	});
	if (!review || Object.keys(review).length === 0) return fail(`Missing or empty ${sourceName} review output`);
	const raw = String(review.verdict ?? "").trim();
	if (!raw) return fail(`Missing verdict in ${sourceName} review output`);
	if (raw === "PASS") return { verdict: "Approved", syntheticFindings: [] };
	if (raw === "CONTEST") {
		// The adversarial reviewer contract says CONTEST is for medium/low quality
		// concerns that need an author response, while REJECT is the production/data
		// loss/security veto. Do not let advisory red-team comments create an endless
		// merge blocker once code review approves. If a CONTEST payload nevertheless
		// carries high/critical findings, keep it blocking for safety. Blocking is
		// judged by the blocking flag OR the severity fallback (a high finding is
		// blocking even when the reviewer followed the "blocking = must stop merge"
		// narrow convention and left it false).
		return { verdict: reviewHasBlockingFinding(review) || reviewHasHighSeverityFinding(review) ? "Changes Requested" : "Approved with Comments", syntheticFindings: [] };
	}
	if (raw === "REJECT") return { verdict: "Blocked", syntheticFindings: [] };
	if (raw === "Approved" || raw === "Approved with Comments") {
		return { verdict: reviewHasBlockingFinding(review) ? "Changes Requested" : raw, syntheticFindings: [] };
	}
	if (raw === "Changes Requested") {
		// Reviewers use "blocking" narrowly ("true only when it must stop merge"),
		// so an explicit Changes Requested can arrive with a High finding flagged
		// blocking:false. Downgrade to Approved with Comments ONLY when every
		// finding is non-blocking AND none carries a high/critical-class severity
		// (open findings only — verified/resolved highs no longer pin the verdict).
		const downgrade = reviewHasFindings(review) && !reviewHasBlockingFinding(review) && !reviewHasHighSeverityFinding(review);
		return { verdict: downgrade ? "Approved with Comments" : "Changes Requested", syntheticFindings: [] };
	}
	if (raw === "Blocked") return { verdict: "Blocked", syntheticFindings: [] };
	return fail(`Invalid verdict in ${sourceName} review output: ${raw}`);
}

function mergeReviewVerdicts(s: Record<string, unknown>): HelperResult {
	const codeReview = s["code-review"] as ControlObj | undefined;
	const adversarial = s["adversarial-review"] as ControlObj | undefined;
	const testsReview = s["tests-review"] as ControlObj | undefined;
	const code = normalizeReviewVerdict("code-review", codeReview);
	const adv = normalizeReviewVerdict("adversarial-review", adversarial);
	// R-2: the optional tests/validation source — present ONLY when the spec
	// declares test deliverables (the join excludes it otherwise). Same
	// normalization; participates in the strictest-verdict ranking.
	const tst = testsReview && Object.keys(testsReview).length > 0 ? normalizeReviewVerdict("tests-review", testsReview) : null;
	const candidates = [code, adv, ...(tst ? [tst] : [])];
	const verdict = candidates.reduce((acc, cur) => (VERDICT_RANK[cur.verdict] >= VERDICT_RANK[acc.verdict] ? cur : acc)).verdict;
	const findings = [
		...((codeReview?.findings as unknown[]) ?? []),
		...((adversarial?.findings as unknown[]) ?? []),
		...((testsReview?.findings as unknown[]) ?? []),
		...code.syntheticFindings,
		...adv.syntheticFindings,
		...(tst?.syntheticFindings ?? []),
	];
	// R-1: deterministic merge-layer finding triage (industry: only in-scope
	// findings above the severity threshold should drive the fix loop). The
	// merged `findings` returned to state.review now carries ONLY actionable
	// fix-now items (open ∧ blocking/high); verified/resolved confirmations are
	// dropped from the fix loop entirely, and advisory / needs-human /
	// cross-stage items move to the `deferredFindings` ledger (surfaced in the
	// escalation evidence, never fed back into reviewer prompts).
	const triaged = triageReviewFindings(findings);
	const dims = [...new Set([...((codeReview?.dimensionsCovered as unknown[]) ?? []), ...((adversarial?.dimensionsCovered as unknown[]) ?? [])] as string[])];
	return ok(
		`Merged verdict: ${verdict} (${triaged.fixNow.length} actionable, ${triaged.deferred.length} deferred, ${triaged.droppedVerified} verified/resolved)`,
		{ verdict, findings: triaged.fixNow, deferredFindings: triaged.deferred, dimensionsCovered: dims },
	);
}

/** Stages whose findings the code implementer may legitimately act on. */
const IMPLEMENTATION_OWNER_STAGES = new Set(["implementation", "verification", "environment", ""]);

export interface ReviewFindingTriage {
	/** Open ∧ (blocking ∨ high/critical severity) — the ONLY findings routed to the fix writer. */
	fixNow: unknown[];
	/** Advisory / needs-human / cross-stage items — logged, never fixed, never shown to reviewers. */
	deferred: Array<Record<string, unknown> & { deferralReason: string }>;
	/** Count of status=verified/addressed/resolved/fixed findings dropped from the fix loop. */
	droppedVerified: number;
}

/**
 * R-1 deterministic finding triage. Pure (no spawn, no LLM); keys on the
 * structured finding contract (status / blocking / severity / ownerStage).
 * Order of precedence per finding:
 *   1. verified-class status → dropped (confirmations are not work items);
 *   2. needs-human → deferred "needs human verification" (never the fixer's);
 *   3. cross-stage ownerStage (∉ implementation/verification/environment) →
 *      deferred "cross-stage owner" (upstream artifact defect the code fixer
 *      cannot legitimately fix — log-and-exclude, the documented pattern for
 *      cross-boundary findings);
 *   4. blocking flag ∨ high/critical severity → fixNow;
 *   5. otherwise (incl. explicit status=deferred) → deferred "advisory".
 * Cross-language by construction (structured fields only). NEVER throws.
 */
export function triageReviewFindings(findings: unknown[]): ReviewFindingTriage {
	const fixNow: unknown[] = [];
	const deferred: Array<Record<string, unknown> & { deferralReason: string }> = [];
	let droppedVerified = 0;
	for (const f of Array.isArray(findings) ? findings : []) {
		try {
			const o = (f ?? {}) as Record<string, unknown>;
			const status = inferReviewFindingStatus(o);
			if (["verified", "addressed", "resolved", "fixed"].includes(status)) {
				droppedVerified++;
				continue;
			}
			if (status === "needs-human") {
				deferred.push({ ...o, deferralReason: "needs human verification" });
				continue;
			}
			if (status === "deferred") {
				deferred.push({ ...o, deferralReason: "reviewer-deferred" });
				continue;
			}
			const ownerStage = String(o.ownerStage ?? "").trim().toLowerCase();
			if (!IMPLEMENTATION_OWNER_STAGES.has(ownerStage)) {
				deferred.push({ ...o, deferralReason: `cross-stage owner: ${ownerStage || "unknown"}` });
				continue;
			}
			const blockingFlag = o.blocking === true || /^(true|yes|1)$/i.test(String(o.blocking ?? "").trim());
			const high = /^(critical|blocker|fatal|high|error|fail|reject)/.test(reviewFindingSeverity(o).toLowerCase());
			if (blockingFlag || high) {
				fixNow.push(f);
			} else {
				deferred.push({ ...o, deferralReason: "advisory (non-blocking, below high)" });
			}
		} catch {
			// Unreadable finding — keep it actionable so it can never silently vanish.
			fixNow.push(f);
		}
	}
	return { fixNow, deferred, droppedVerified };
}

// ─── cleanup ────────────────────────────────────────────────────────────────

const BUILD_DIRS = new Set(["node_modules", "target", "dist", "build", "__pycache__", ".next", ".nuxt", ".output", "coverage", ".turbo"]);
const SENSITIVE_RE = [/\.env$/, /\.env\.local$/, /\.env\.production$/, /\.pem$/, /\.key$/, /id_rsa/, /id_ed25519/, /\.p12$/, /credentials\.json$/, /service[-_]account.*\.json$/];
const LANG_MARKERS: Record<string, string[]> = {
	rust: ["Cargo.toml", "Cargo.lock"], go: ["go.mod", "go.sum"], frontend: ["package.json", "tsconfig.json"], python: ["pyproject.toml", "setup.py", "requirements.txt"],
};

/** A-3: files that would actually be carried into the merge — committed
 *  changes vs the default-branch merge-base, plus staged and tracked
 *  working-tree modifications. Untracked files never qualify (git ignores them
 *  at merge time), so pipeline-copied env files cannot block. Returns null
 *  when git is unavailable / not a repo so the caller can fall back to the
 *  legacy root scan. NEVER throws. */
function gitCarriedFiles(cwd: string, defaultBranch?: string): string[] | null {
	const run = (args: string[]): string[] | null => {
		try {
			const r = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 15_000 });
			if (r.error || r.status !== 0) return null;
			return String(r.stdout).split("\n").map((l: string) => l.trim()).filter(Boolean);
		} catch { return null; }
	};
	const tracked = run(["ls-files"]);
	if (tracked === null) return null;
	const files = new Set<string>();
	let baselineWorked = false;
	if (defaultBranch) {
		const base = run(["merge-base", "HEAD", defaultBranch]);
		const diff = base && base[0] ? run(["diff", "--name-only", "--diff-filter=ACMR", `${base[0]}...HEAD`]) : null;
		if (diff) { baselineWorked = true; for (const f of diff) files.add(f); }
	}
	if (!baselineWorked) {
		// No usable baseline (missing default ref / orphan history): the
		// conservative superset is the full tracked list — still excludes
		// untracked files, so copied env files never block.
		for (const f of tracked) files.add(f);
	}
	for (const args of [["diff", "--name-only", "--cached", "--diff-filter=ACMR"], ["diff", "--name-only", "--diff-filter=ACMR"]]) {
		const d = run(args);
		if (d) for (const f of d) files.add(f);
	}
	return [...files];
}

async function cleanup(_s: Record<string, unknown>, context?: Record<string, unknown>): Promise<HelperResult> {
	const cwd = context?.cwd as string | undefined;
	const worktreeCreated = context?.worktreeCreated === true;
	if (!cwd) return ok("FAIL: no cwd in context", { languagesDetected: [], directoriesRemoved: [], commandsRun: [], sensitiveDataFindings: [], blocked: false, summary: "Could not scan — no working directory provided" });
	const { readdir, stat } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const languagesDetected: string[] = [];
	for (const [lang, markers] of Object.entries(LANG_MARKERS)) {
		for (const marker of markers) {
			try { await stat(join(cwd, marker)); if (!languagesDetected.includes(lang)) languagesDetected.push(lang); break; } catch { /* absent */ }
		}
	}

	// --- ACTUAL CLEANUP: only when running in a WORKTREE (never the main checkout) ---
	// When in-place (no worktree), skip removal — cleaning the user's main repo
	// node_modules/target/ would be destructive. Detection + sensitive scan still run.
	const commandsRun: string[] = [];
	const directoriesRemoved: string[] = [];

	if (worktreeCreated) {
		const { rmSync } = await import("node:fs");
		const { spawnSync } = await import("node:child_process");

		// Language-specific clean commands (deterministic, never-throw, bounded timeout).
		if (languagesDetected.includes("rust")) {
			try {
				const r = spawnSync("cargo", ["clean"], { cwd, encoding: "utf8", timeout: 60_000 });
				commandsRun.push(`cargo clean (${r.status === 0 ? "ok" : "exit " + String(r.status)})`);
			} catch { commandsRun.push("cargo clean (skipped — cargo unavailable)"); }
		}
		if (languagesDetected.includes("go")) {
			try {
				const r = spawnSync("go", ["clean", "-cache", "-testcache"], { cwd, encoding: "utf8", timeout: 30_000 });
				commandsRun.push(`go clean -cache -testcache (${r.status === 0 ? "ok" : "exit " + String(r.status)})`);
			} catch { commandsRun.push("go clean (skipped — go unavailable)"); }
		}

		// Remove all detected build directories (node_modules, target, dist, etc.).
		try {
			for (const e of await readdir(cwd, { withFileTypes: true })) {
				if (e.isDirectory() && BUILD_DIRS.has(e.name)) {
					try { rmSync(join(cwd, e.name), { recursive: true, force: true }); directoriesRemoved.push(e.name); }
					catch { /* best-effort — skip unreadable/locked */ }
				}
			}
		} catch { /* unreadable cwd */ }
	} else {
		// In-place run: detection only (report what WOULD be cleaned, don't remove).
		try { for (const e of await readdir(cwd, { withFileTypes: true })) if (e.isDirectory() && BUILD_DIRS.has(e.name)) directoriesRemoved.push(`${e.name} (skipped — in-place run)`); } catch { /* unreadable */ }
	}

	// A-3 (audit): scan the GIT-CARRIED view — only content that would actually
	// reach the merge (committed changes vs the default-branch baseline, staged
	// entries, tracked working-tree modifications). Untracked worktree files —
	// notably the .env files setup itself copies into worktrees so integration
	// tests can authenticate — are never merged and must not block. Falls back
	// to the legacy root readdir scan only when git is unusable (non-repo dir).
	const sensitiveDataFindings: string[] = [];
	const carried = gitCarriedFiles(cwd, context?.defaultBranch as string | undefined);
	if (carried !== null) {
		for (const rel of carried) {
			const base = rel.split("/").pop() ?? rel;
			for (const re of SENSITIVE_RE) if (re.test(base)) { sensitiveDataFindings.push(`Sensitive file in merge set: ${rel}`); break; }
		}
	} else {
		try { for (const e of await readdir(cwd)) for (const re of SENSITIVE_RE) if (re.test(e)) { sensitiveDataFindings.push(`Sensitive file detected: ${e}`); break; } } catch { /* unreadable */ }
	}
	const blocked = sensitiveDataFindings.length > 0;
	const mode = worktreeCreated ? "worktree cleaned" : "in-place — detection only (no removal)";
	const cleanSummary = worktreeCreated ? `${commandsRun.length} command(s), ${directoriesRemoved.length} dir(s) removed` : `${directoriesRemoved.length} dir(s) detected (not removed)`;
	return ok(blocked ? `BLOCKED: ${sensitiveDataFindings.length} sensitive finding(s)` : `Clean: ${languagesDetected.length} lang(s), ${cleanSummary}`, {
		languagesDetected, directoriesRemoved, commandsRun, sensitiveDataFindings, blocked,
		summary: blocked ? `Merge blocked: found ${sensitiveDataFindings.length} sensitive data issue(s)` : `${mode}: ${cleanSummary}. Languages: ${languagesDetected.join(", ") || "none detected"}`,
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
