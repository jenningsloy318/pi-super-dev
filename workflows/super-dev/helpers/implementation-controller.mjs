/**
 * implementation-controller.mjs — Dynamic controller for the super-dev pipeline.
 *
 * Orchestrates Stages 2-13 after the declarative setup stage completes.
 * Each ctx.agent() call uses a deterministic task ID for replay/resume support.
 *
 * Pipeline phases:
 *   2A. Classify Task (helper)
 *   2B. Requirements Loop (agent + gate, max 3)
 *   2C. BDD Loop (agent + gate, max 3)
 *    3. Research Loop (agent + check, max 3)
 *    4. Debug Analysis (conditional: bug only)
 *    5. Code Assessment (always)
 *    6. Route Designer + Design (conditional: non-bug)
 *  6.5. Check Prototype + Prototype Loop (conditional)
 *    7. Specification Loop (agent + gate, max 3)
 *    8. Spec Review Loop (agent + gate, max 3)
 *    9. Implementation — per-phase TDD (tdd → implement → qa → gate)
 *   10. Code Review Loop (parallel reviewers + merge, max 3)
 *   11. Documentation (agent)
 *   12. Cleanup (helper)
 *   13. Merge (conditional: not blocked)
 */

// ─── Utilities ──────────────────────────────────────────────────────────────

function padRound(round) {
  return String(round).padStart(2, "0");
}

function ensureBudget(ctx, phase) {
  if (!ctx.budget.check()) {
    ctx.log(`Budget exhausted before ${phase} — terminating gracefully`);
    return false;
  }
  return true;
}

function extractFulfilled(results) {
  return results.map((r) => {
    if (r.status === "fulfilled") return r.value;
    throw r.reason;
  });
}

// ─── Prompt Builders ────────────────────────────────────────────────────────

function buildContextBlock(setup, classification) {
  return [
    "## Context",
    `- Worktree: ${setup.worktreePath}`,
    `- Spec Directory: ${setup.specDirectory}`,
    `- Language: ${classification?.language ?? setup.language}`,
    `- Task Type: ${classification?.taskType ?? "unknown"}`,
    `- UI Scope: ${classification?.uiScope ?? "none"}`,
    `- Default Branch: ${setup.defaultBranch ?? "main"}`,
  ].join("\n");
}

function buildRequirementsPrompt(setup, classification, task) {
  return [
    buildContextBlock(setup, classification),
    "",
    "## Task",
    task,
    "",
    "## Instructions",
    "Produce an implementation-ready requirements document.",
    `Write the document to: ${setup.specDirectory}01-requirements.md`,
    "Include: feature name, acceptance criteria (numbered AC-XX), open questions, and a summary.",
    "",
    "Output <control> JSON with: docPath, featureName, acCount, openQuestions, summary.",
  ].join("\n");
}

function buildBddPrompt(setup, classification, task, requirements) {
  return [
    buildContextBlock(setup, classification),
    "",
    "## Upstream Artifacts",
    `- Requirements: ${requirements?.docPath ?? "N/A"}`,
    "",
    "## Task",
    task,
    "",
    "## Instructions",
    "Write BDD behavior scenarios in Gherkin-like markdown from the requirements acceptance criteria.",
    `Write to: ${setup.specDirectory}02-bdd-scenarios.md`,
    "Cover happy paths, edge cases, and error scenarios.",
    "",
    "Output <control> JSON with: docPath, scenarioCount, edgeCasesCovered, coverageScore, summary.",
  ].join("\n");
}

function buildResearchPrompt(setup, classification, task, requirements, bdd, prevResearch) {
  const parts = [
    buildContextBlock(setup, classification),
    "",
    "## Upstream Artifacts",
    `- Requirements: ${requirements?.docPath ?? "N/A"}`,
    `- BDD Scenarios: ${bdd?.docPath ?? "N/A"}`,
  ];
  if (prevResearch?.docPath) {
    parts.push(`- Previous Research: ${prevResearch.docPath}`);
    if (prevResearch.openIssues?.length) {
      parts.push(`- Open Issues to resolve: ${prevResearch.openIssues.join(", ")}`);
    }
  }
  parts.push(
    "",
    "## Task",
    task,
    "",
    "## Instructions",
    "Research best practices, documentation, and patterns relevant to this task.",
    `Write to: ${setup.specDirectory}03-research-report.md`,
    "Identify options, tradeoffs, and open issues. Resolve any previously open issues.",
    "",
    "Output <control> JSON with: docPath, options (array), openIssues (array), iteration, summary.",
  );
  return parts.join("\n");
}

function buildDebugPrompt(setup, classification, task, requirements, research) {
  return [
    buildContextBlock(setup, classification),
    "",
    "## Upstream Artifacts",
    `- Requirements: ${requirements?.docPath ?? "N/A"}`,
    `- Research: ${research?.docPath ?? "N/A"}`,
    "",
    "## Task",
    task,
    "",
    "## Instructions",
    "Perform systematic root-cause debugging with evidence collection.",
    `Write to: ${setup.specDirectory}04-debug-analysis.md`,
    "Include: hypotheses, reproduction steps, root cause, and recommended fix.",
    "",
    "Output <control> JSON with: docPath, hypotheses (array), rootCause, reproductionSteps, summary.",
  ].join("\n");
}

function buildAssessmentPrompt(setup, classification, task, research, debug) {
  const parts = [
    buildContextBlock(setup, classification),
    "",
    "## Upstream Artifacts",
    `- Research: ${research?.docPath ?? "N/A"}`,
  ];
  if (debug?.docPath) {
    parts.push(`- Debug Analysis: ${debug.docPath}`);
  }
  parts.push(
    "",
    "## Task",
    task,
    "",
    "## Instructions",
    "Assess the existing codebase: architecture patterns, coding standards, dependencies, and framework conventions.",
    `Write to: ${setup.specDirectory}05-code-assessment.md`,
    "Identify patterns to follow, anti-patterns to avoid, and relevant files.",
    "",
    "Output <control> JSON with: docPath, patterns (array of objects), filesAssessed, recommendations, summary.",
  );
  return parts.join("\n");
}

function buildDesignPrompt(setup, classification, task, requirements, research, assessment, designerAgent) {
  return [
    buildContextBlock(setup, classification),
    "",
    "## Upstream Artifacts",
    `- Requirements: ${requirements?.docPath ?? "N/A"}`,
    `- Research: ${research?.docPath ?? "N/A"}`,
    `- Code Assessment: ${assessment?.docPath ?? "N/A"}`,
    "",
    "## Task",
    task,
    "",
    "## Instructions",
    `You are the ${designerAgent}. Design the architecture/UI for this feature.`,
    `Write to: ${setup.specDirectory}06-design.md`,
    "Include: module decomposition, interfaces, data flow, and any numeric constants that need validation.",
    "",
    "Output <control> JSON with: designer, docs (array of paths), modules (array of objects), hasNumericConstants, summary.",
  ].join("\n");
}

function buildPrototypePrompt(setup, classification, task, design, constants, round) {
  return [
    buildContextBlock(setup, classification),
    "",
    "## Design",
    `- Design doc: ${design?.docs?.[0] ?? "N/A"}`,
    `- Constants to validate: ${(constants ?? []).join(", ")}`,
    "",
    "## Task",
    task,
    "",
    "## Instructions",
    `Prototype round ${round}: Empirically validate the numeric design constants.`,
    "Build a minimal prototype, measure against representative input, and report pass/fail.",
    "",
    "Output <control> JSON with: verdict ('pass' or 'fail'), measurements (array), adjustments (array), summary.",
  ].join("\n");
}

function buildSpecPrompt(setup, classification, task, requirements, bdd, research, assessment, design) {
  const parts = [
    buildContextBlock(setup, classification),
    "",
    "## Upstream Artifacts",
    `- Requirements: ${requirements?.docPath ?? "N/A"}`,
    `- BDD Scenarios: ${bdd?.docPath ?? "N/A"}`,
    `- Research: ${research?.docPath ?? "N/A"}`,
    `- Code Assessment: ${assessment?.docPath ?? "N/A"}`,
  ];
  if (design?.docs?.length) {
    parts.push(`- Design: ${design.docs.join(", ")}`);
  }
  parts.push(
    "",
    "## Task",
    task,
    "",
    "## Instructions",
    "Write the technical specification, implementation plan, and task list.",
    `Write specification to: ${setup.specDirectory}06-specification.md`,
    `Write plan to: ${setup.specDirectory}07-implementation-plan.md`,
    `Write task list to: ${setup.specDirectory}08-task-list.md`,
    "Break implementation into phases. Each phase must be independently testable.",
    "",
    "Output <control> JSON with: specificationPath, planPath, tasksPath, phaseCount, phases (array with name/description per phase), summary.",
  );
  return parts.join("\n");
}

function buildSpecReviewPrompt(setup, classification, specControl) {
  return [
    buildContextBlock(setup, classification),
    "",
    "## Specification to Review",
    `- Specification: ${specControl?.specificationPath ?? "N/A"}`,
    `- Plan: ${specControl?.planPath ?? "N/A"}`,
    `- Tasks: ${specControl?.tasksPath ?? "N/A"}`,
    `- Phases: ${specControl?.phaseCount ?? 0}`,
    "",
    "## Instructions",
    "Review the specification across 8 quality dimensions: completeness, correctness, consistency,",
    "testability, feasibility, security, performance, and maintainability.",
    "Score each dimension 1-5. Produce a verdict.",
    "",
    "Output <control> JSON with: docPath, verdict ('Approved'|'Approved with Comments'|'Changes Requested'), findings (array), dimensionsScored (array), summary.",
  ].join("\n");
}

function buildTddPrompt(setup, classification, phase, specControl) {
  return [
    buildContextBlock(setup, classification),
    "",
    "## Implementation Phase",
    `- Phase: ${phase.name}`,
    `- Description: ${phase.description ?? ""}`,
    `- Specification: ${specControl?.specificationPath ?? "N/A"}`,
    "",
    "## Instructions",
    "Write failing tests FIRST for this implementation phase.",
    "Tests should cover the acceptance criteria and edge cases.",
    "Run the tests to confirm they fail (red phase of TDD).",
    "",
    "Output <control> JSON with: testsWritten (number), testFiles (array of paths), allFailing (boolean), summary.",
  ].join("\n");
}

function buildImplementPrompt(setup, classification, phase, specialist, specControl) {
  const langInstructions = specialist?.languageInstructions ?? "";
  return [
    buildContextBlock(setup, classification),
    "",
    "## Implementation Phase",
    `- Phase: ${phase.name}`,
    `- Description: ${phase.description ?? ""}`,
    `- Specification: ${specControl?.specificationPath ?? "N/A"}`,
    "",
    langInstructions ? `## Language-Specific Instructions\n${langInstructions}\n` : "",
    "## Instructions",
    "Implement the code to make the failing tests pass (green phase of TDD).",
    "Follow existing patterns from the code assessment. Keep changes minimal and focused.",
    "",
    "Output <control> JSON with: filesModified (array), testsPassCount (number), summary.",
  ].join("\n");
}

function buildQaPrompt(setup, classification, phase) {
  return [
    buildContextBlock(setup, classification),
    "",
    "## Implementation Phase",
    `- Phase: ${phase.name}`,
    "",
    "## Instructions",
    "Run the full test suite and verify build succeeds.",
    "Check coverage meets threshold. Report any regressions.",
    "",
    "Output <control> JSON with: allTestsPass (boolean), buildSuccess (boolean), coveragePercent (number), regressions (array), summary.",
  ].join("\n");
}

function buildCodeReviewPrompt(setup, classification, task, specControl, implControl) {
  return [
    buildContextBlock(setup, classification),
    "",
    "## Upstream Artifacts",
    `- Specification: ${specControl?.specificationPath ?? "N/A"}`,
    `- Phases Completed: ${implControl?.phasesCompleted ?? 0}/${implControl?.totalPhases ?? 0}`,
    "",
    "## Task",
    task,
    "",
    "## Instructions",
    "Review the implementation against the specification for correctness, security, performance, and maintainability.",
    "Produce a verdict and list findings with severity.",
    "",
    "Output <control> JSON with: verdict ('Approved'|'Approved with Comments'|'Changes Requested'), findings (array), dimensionsCovered (array), summary.",
  ].join("\n");
}

function buildAdversarialPrompt(setup, classification, task, specControl, implControl) {
  return [
    buildContextBlock(setup, classification),
    "",
    "## Upstream Artifacts",
    `- Specification: ${specControl?.specificationPath ?? "N/A"}`,
    `- Phases Completed: ${implControl?.phasesCompleted ?? 0}/${implControl?.totalPhases ?? 0}`,
    "",
    "## Task",
    task,
    "",
    "## Instructions",
    "Challenge the implementation from three critical lenses: Skeptic, Architect, Minimalist.",
    "Look for issues standard review misses: over-engineering, hidden complexity, missing error paths.",
    "",
    "Output <control> JSON with: verdict ('Approved'|'Approved with Comments'|'Changes Requested'), findings (array), dimensionsCovered (array), summary.",
  ].join("\n");
}

function buildFixPrompt(setup, classification, findings) {
  const findingsList = (findings ?? [])
    .map((f) => `- [${f.severity ?? "medium"}] ${f.title ?? f.message ?? JSON.stringify(f)}`)
    .join("\n");
  return [
    buildContextBlock(setup, classification),
    "",
    "## Code Review Findings to Address",
    findingsList || "- (no specific findings)",
    "",
    "## Instructions",
    "Fix the issues identified in code review. Make minimal, targeted changes.",
    "Run tests after each fix to ensure no regressions.",
    "",
    "Output <control> JSON with: filesModified (array), fixesApplied (number), summary.",
  ].join("\n");
}

function buildDocsPrompt(setup, classification, task, specControl) {
  return [
    buildContextBlock(setup, classification),
    "",
    "## Task",
    task,
    "",
    "## Upstream Artifacts",
    `- Specification: ${specControl?.specificationPath ?? "N/A"}`,
    `- Spec Directory: ${setup.specDirectory}`,
    "",
    "## Instructions",
    "Update documentation to reflect the implementation:",
    "- Review spec directory files for accuracy against the code",
    "- Update README, CHANGELOG, API docs as needed",
    "- Document any deviations from the specification",
    "",
    "Output <control> JSON with: docsUpdated (boolean), specDirFilesReviewed (array), deviationsDocumented (array), summary.",
  ].join("\n");
}

function buildCommitPrompt(setup, phaseName) {
  return [
    `## Context`,
    `- Worktree: ${setup.worktreePath}`,
    "",
    "## Instructions",
    `Commit all changes for implementation phase: ${phaseName}`,
    "Use a conventional commit message that describes the phase work.",
    "Stage only files relevant to this phase.",
  ].join("\n");
}

function buildMergePrompt(setup) {
  return [
    `## Context`,
    `- Worktree: ${setup.worktreePath}`,
    `- Default Branch: ${setup.defaultBranch ?? "main"}`,
    "",
    "## Instructions",
    "Merge the feature branch back into the default branch.",
    "Ensure all changes are committed. Create a merge commit with a summary of all work done.",
    "If there are conflicts, resolve them preserving the feature branch changes.",
    "",
    "Output <control> JSON with: merged (boolean), commitSha, mergeCommand, summary.",
  ].join("\n");
}

// ─── Pipeline Phase Functions ───────────────────────────────────────────────

async function runClassifyTask(ctx, setup) {
  ctx.phase("Stage 2A — Classify Task");
  const result = await ctx.helper("classify-task", {
    sources: { setup },
    options: { runtimeTask: ctx.task },
  });
  ctx.log(`Classified: type=${result.value.taskType}, scope=${result.value.uiScope}`);
  return result.value;
}

async function runRequirementsLoop(ctx, setup, classification) {
  ctx.phase("Stage 2B — Requirements");
  let reqControl = null;

  for (let round = 1; round <= 3; round++) {
    if (!ensureBudget(ctx, `requirements round ${round}`)) break;

    const result = await ctx.agent({
      id: `pipeline.requirements.r${padRound(round)}.write`,
      agent: "requirements-clarifier",
      prompt: buildRequirementsPrompt(setup, classification, ctx.task),
    });
    reqControl = result?.control ?? result;

    const gate = await ctx.helper("gate-requirements", {
      sources: { "write-requirements": reqControl },
    });
    if (gate.value.pass) {
      ctx.log(`Requirements gate PASS on round ${round}`);
      return reqControl;
    }
    ctx.log(`Requirements gate FAIL round ${round}/3: ${(gate.value.errors ?? []).join(", ")}`);
  }

  ctx.log("Requirements: exhausted 3 rounds — continuing with best effort");
  return reqControl;
}

async function runBddLoop(ctx, setup, classification, requirements) {
  ctx.phase("Stage 2C — BDD Scenarios");
  let bddControl = null;

  for (let round = 1; round <= 3; round++) {
    if (!ensureBudget(ctx, `BDD round ${round}`)) break;

    const result = await ctx.agent({
      id: `pipeline.bdd.r${padRound(round)}.write`,
      agent: "bdd-scenario-writer",
      prompt: buildBddPrompt(setup, classification, ctx.task, requirements),
    });
    bddControl = result?.control ?? result;

    const gate = await ctx.helper("gate-bdd", {
      sources: { "write-bdd": bddControl },
    });
    if (gate.value.pass) {
      ctx.log(`BDD gate PASS on round ${round}`);
      return bddControl;
    }
    ctx.log(`BDD gate FAIL round ${round}/3: ${(gate.value.errors ?? []).join(", ")}`);
  }

  ctx.log("BDD: exhausted 3 rounds — continuing with best effort");
  return bddControl;
}

async function runResearchLoop(ctx, setup, classification, requirements, bdd) {
  ctx.phase("Stage 3 — Research");
  let researchControl = null;

  for (let round = 1; round <= 3; round++) {
    if (!ensureBudget(ctx, `research round ${round}`)) break;

    const result = await ctx.agent({
      id: `pipeline.research.r${padRound(round)}.write`,
      agent: "research-agent",
      prompt: buildResearchPrompt(setup, classification, ctx.task, requirements, bdd, researchControl),
    });
    researchControl = result?.control ?? result;

    const openIssues = researchControl?.openIssues ?? [];
    if (openIssues.length === 0) {
      ctx.log(`Research complete on round ${round} — no open issues`);
      return researchControl;
    }
    ctx.log(`Research round ${round}/3: ${openIssues.length} open issues remain`);
  }

  ctx.log("Research: exhausted 3 rounds — continuing with remaining open issues");
  return researchControl;
}

async function runDebugAnalysis(ctx, setup, classification, requirements, research) {
  if (classification.taskType !== "bug") return null;

  ctx.phase("Stage 4 — Debug Analysis");
  if (!ensureBudget(ctx, "debug analysis")) return null;

  const result = await ctx.agent({
    id: "pipeline.debug",
    agent: "debug-analyzer",
    prompt: buildDebugPrompt(setup, classification, ctx.task, requirements, research),
  });
  ctx.log("Debug analysis complete");
  return result?.control ?? result;
}

async function runCodeAssessment(ctx, setup, classification, research, debug) {
  ctx.phase("Stage 5 — Code Assessment");
  if (!ensureBudget(ctx, "code assessment")) return null;

  const result = await ctx.agent({
    id: "pipeline.assessment",
    agent: "code-assessor",
    prompt: buildAssessmentPrompt(setup, classification, ctx.task, research, debug),
  });
  ctx.log("Code assessment complete");
  return result?.control ?? result;
}

async function runDesign(ctx, setup, classification, requirements, research, assessment) {
  ctx.phase("Stage 6 — Design");

  const routing = await ctx.helper("route-designer", {
    sources: { "classify-task": classification },
  });

  if (!routing.value.designerAgent) {
    ctx.log(`Design skipped: ${routing.value.reason}`);
    return null;
  }

  if (!ensureBudget(ctx, "design")) return null;

  const result = await ctx.agent({
    id: "pipeline.design",
    agent: routing.value.designerAgent,
    prompt: buildDesignPrompt(
      setup, classification, ctx.task,
      requirements, research, assessment,
      routing.value.designerAgent,
    ),
  });
  ctx.log(`Design complete (agent: ${routing.value.designerAgent})`);
  return result?.control ?? result;
}

async function runPrototype(ctx, setup, classification, design) {
  if (!design) return null;

  const check = await ctx.helper("check-prototype-needed", {
    sources: { design },
  });

  if (!check.value.needed) {
    ctx.log("Prototype not needed — no numeric constants to validate");
    return null;
  }

  ctx.phase("Stage 6.5 — Prototype");
  let protoControl = null;

  for (let round = 1; round <= 3; round++) {
    if (!ensureBudget(ctx, `prototype round ${round}`)) break;

    const result = await ctx.agent({
      id: `pipeline.prototype.r${padRound(round)}`,
      agent: "prototype-runner",
      prompt: buildPrototypePrompt(setup, classification, ctx.task, design, check.value.constants, round),
    });
    protoControl = result?.control ?? result;

    if (protoControl?.verdict === "pass") {
      ctx.log(`Prototype validation PASS on round ${round}`);
      return protoControl;
    }
    ctx.log(`Prototype round ${round}/3: verdict=${protoControl?.verdict ?? "unknown"}`);
  }

  ctx.log("Prototype: exhausted 3 rounds — continuing with last result");
  return protoControl;
}

async function runSpecLoop(ctx, setup, classification, requirements, bdd, research, assessment, design) {
  ctx.phase("Stage 7 — Specification");
  let specControl = null;

  for (let round = 1; round <= 3; round++) {
    if (!ensureBudget(ctx, `spec round ${round}`)) break;

    const result = await ctx.agent({
      id: `pipeline.spec.r${padRound(round)}.write`,
      agent: "spec-writer",
      prompt: buildSpecPrompt(setup, classification, ctx.task, requirements, bdd, research, assessment, design),
    });
    specControl = result?.control ?? result;

    const gate = await ctx.helper("gate-spec-trace", {
      sources: { "write-spec": specControl },
    });
    if (gate.value.pass) {
      ctx.log(`Spec gate PASS on round ${round}`);
      return specControl;
    }
    ctx.log(`Spec gate FAIL round ${round}/3: ${(gate.value.errors ?? []).join(", ")}`);
  }

  ctx.log("Specification: exhausted 3 rounds — continuing with best effort");
  return specControl;
}

async function runSpecReviewLoop(ctx, setup, classification, specControl) {
  ctx.phase("Stage 8 — Spec Review");

  for (let round = 1; round <= 3; round++) {
    if (!ensureBudget(ctx, `spec-review round ${round}`)) break;

    const result = await ctx.agent({
      id: `pipeline.spec-review.r${padRound(round)}.review`,
      agent: "spec-reviewer",
      prompt: buildSpecReviewPrompt(setup, classification, specControl),
    });
    const reviewControl = result?.control ?? result;

    const gate = await ctx.helper("gate-spec-review", {
      sources: { "review-spec": reviewControl },
    });
    if (gate.value.pass) {
      ctx.log(`Spec review gate PASS on round ${round}: verdict=${reviewControl?.verdict}`);
      return reviewControl;
    }
    ctx.log(`Spec review gate FAIL round ${round}/3: ${(gate.value.errors ?? []).join(", ")}`);
  }

  ctx.log("Spec review: exhausted 3 rounds — continuing");
  return null;
}

async function runImplementation(ctx, setup, classification, specControl) {
  ctx.phase("Stage 9 — Implementation");

  const phases = specControl?.phases ?? [];
  if (phases.length === 0) {
    ctx.log("Implementation: no phases defined in spec — skipping");
    return { phasesCompleted: 0, totalPhases: 0, allGreen: false };
  }

  let phasesCompleted = 0;
  let allGreen = true;
  const filesModified = [];

  for (const [idx, phase] of phases.entries()) {
    const phaseId = `phase-${padRound(idx + 1)}`;
    let phaseGreen = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!ensureBudget(ctx, `implementation ${phaseId} attempt ${attempt}`)) {
        allGreen = false;
        return { phasesCompleted, totalPhases: phases.length, allGreen, filesModified, summary: "Budget exhausted" };
      }

      // 1. TDD: write failing tests
      await ctx.agent({
        id: `pipeline.implementation.${phaseId}.tdd.a${attempt}`,
        agent: "tdd-guide",
        prompt: buildTddPrompt(setup, classification, phase, specControl),
      });

      // 2. Route specialist and implement
      const specialist = await ctx.helper("route-specialist", {
        sources: { "classify-task": classification },
        options: { phase },
      });

      await ctx.agent({
        id: `pipeline.implementation.${phaseId}.implement.a${attempt}`,
        agent: "implementer",
        prompt: buildImplementPrompt(setup, classification, phase, specialist.value, specControl),
      });

      // 3. QA: verify tests pass
      const qaResult = await ctx.agent({
        id: `pipeline.implementation.${phaseId}.qa.a${attempt}`,
        agent: "qa-agent",
        prompt: buildQaPrompt(setup, classification, phase),
      });
      const qaControl = qaResult?.control ?? qaResult;

      // 4. Gate: validate build
      const gate = await ctx.helper("gate-build", {
        sources: { "qa-check": qaControl },
      });

      if (gate.value.pass) {
        phaseGreen = true;
        ctx.log(`Implementation ${phaseId} GREEN on attempt ${attempt}`);
        break;
      }
      ctx.log(`Implementation ${phaseId} attempt ${attempt}/3 FAIL: ${(gate.value.errors ?? []).join(", ")}`);
    }

    if (!phaseGreen) {
      ctx.log(`Implementation ${phaseId} failed after 3 attempts — terminating early`);
      allGreen = false;
      break;
    }

    // 5. Commit phase changes
    phasesCompleted++;
    if (ensureBudget(ctx, `commit ${phaseId}`)) {
      await ctx.agent({
        id: `pipeline.implementation.${phaseId}.commit`,
        agent: "orchestrator",
        prompt: buildCommitPrompt(setup, phase.name),
      });
    }
  }

  return {
    phasesCompleted,
    totalPhases: phases.length,
    allGreen,
    filesModified,
    summary: allGreen
      ? `All ${phases.length} phases completed successfully`
      : `${phasesCompleted}/${phases.length} phases completed`,
  };
}

async function runCodeReviewLoop(ctx, setup, classification, specControl, implControl) {
  ctx.phase("Stage 10 — Code Review");

  for (let round = 1; round <= 3; round++) {
    if (!ensureBudget(ctx, `code-review round ${round}`)) break;
    const rId = padRound(round);

    // Parallel: code-reviewer + adversarial-reviewer
    const results = await ctx.parallel([
      () => ctx.agent({
        id: `pipeline.code-review.r${rId}.review`,
        agent: "code-reviewer",
        prompt: buildCodeReviewPrompt(setup, classification, ctx.task, specControl, implControl),
      }),
      () => ctx.agent({
        id: `pipeline.code-review.r${rId}.adversarial`,
        agent: "adversarial-reviewer",
        prompt: buildAdversarialPrompt(setup, classification, ctx.task, specControl, implControl),
      }),
    ]);

    const [codeReviewResult, adversarialResult] = extractFulfilled(results);
    const codeReviewControl = codeReviewResult?.control ?? codeReviewResult;
    const adversarialControl = adversarialResult?.control ?? adversarialResult;

    // Merge verdicts
    const merged = await ctx.helper("merge-review-verdicts", {
      sources: {
        "code-review": codeReviewControl,
        "adversarial-review": adversarialControl,
      },
    });

    const verdict = merged.value.verdict;
    if (verdict === "Approved" || verdict === "Approved with Comments") {
      ctx.log(`Code review PASS on round ${round}: ${verdict}`);
      return merged.value;
    }

    ctx.log(`Code review round ${round}/3: ${verdict}`);

    // Fix issues (if rounds remaining)
    if (round < 3) {
      if (!ensureBudget(ctx, `code-review fix round ${round}`)) break;
      await ctx.agent({
        id: `pipeline.code-review.r${rId}.fix`,
        agent: "implementer",
        prompt: buildFixPrompt(setup, classification, merged.value.findings),
      });
    }
  }

  ctx.log("Code review: exhausted 3 rounds — continuing");
  return { verdict: "Changes Requested", findings: [], summary: "Exhausted review rounds" };
}

async function runDocs(ctx, setup, classification, specControl) {
  ctx.phase("Stage 11 — Documentation");
  if (!ensureBudget(ctx, "documentation")) return null;

  const result = await ctx.agent({
    id: "pipeline.docs",
    agent: "docs-executor",
    prompt: buildDocsPrompt(setup, classification, ctx.task, specControl),
  });
  ctx.log("Documentation complete");
  return result?.control ?? result;
}

async function runCleanup(ctx, setup, docsControl) {
  ctx.phase("Stage 12 — Cleanup");

  const result = await ctx.helper("cleanup", {
    sources: { docs: docsControl ?? {} },
    context: { cwd: setup.worktreePath },
  });
  ctx.log(`Cleanup: blocked=${result.value.blocked}`);
  return result.value;
}

async function runMerge(ctx, setup, cleanupResult) {
  if (cleanupResult?.blocked) {
    ctx.log("Merge skipped: cleanup reported blocking issues");
    return null;
  }

  ctx.phase("Stage 13 — Merge");
  if (!ensureBudget(ctx, "merge")) return null;

  const result = await ctx.agent({
    id: "pipeline.merge",
    agent: "orchestrator",
    prompt: buildMergePrompt(setup),
  });
  ctx.log("Merge complete");
  return result?.control ?? result;
}

// ─── Main Controller ────────────────────────────────────────────────────────

export default async function controller(ctx) {
  const setup = ctx.sources.setup;
  if (!setup?.worktreePath) {
    ctx.log("ERROR: Setup control missing worktreePath — cannot proceed");
    return;
  }

  ctx.log(`Pipeline starting for task: ${ctx.task}`);
  ctx.log(`Worktree: ${setup.worktreePath}`);

  // Phase 2A: Classify Task
  const classification = await runClassifyTask(ctx, setup);

  // Phase 2B: Requirements Loop
  const requirements = await runRequirementsLoop(ctx, setup, classification);

  // Phase 2C: BDD Loop
  const bdd = await runBddLoop(ctx, setup, classification, requirements);

  // Phase 3: Research Loop
  const research = await runResearchLoop(ctx, setup, classification, requirements, bdd);

  // Phase 4: Debug Analysis (conditional)
  const debug = await runDebugAnalysis(ctx, setup, classification, requirements, research);

  // Phase 5: Code Assessment
  const assessment = await runCodeAssessment(ctx, setup, classification, research, debug);

  // Phase 6: Design (routed)
  const design = await runDesign(ctx, setup, classification, requirements, research, assessment);

  // Phase 6.5: Prototype (conditional)
  await runPrototype(ctx, setup, classification, design);

  // Phase 7: Specification Loop
  const specControl = await runSpecLoop(ctx, setup, classification, requirements, bdd, research, assessment, design);

  // Phase 8: Spec Review Loop
  await runSpecReviewLoop(ctx, setup, classification, specControl);

  // Phase 9: Implementation (per-phase TDD)
  const implControl = await runImplementation(ctx, setup, classification, specControl);

  // Phase 10: Code Review Loop
  await runCodeReviewLoop(ctx, setup, classification, specControl, implControl);

  // Phase 11: Documentation
  const docsControl = await runDocs(ctx, setup, classification, specControl);

  // Phase 12: Cleanup
  const cleanupResult = await runCleanup(ctx, setup, docsControl);

  // Phase 13: Merge (conditional)
  await runMerge(ctx, setup, cleanupResult);

  ctx.log("Pipeline complete");
}
