// v0.4.20: eval-layer.ts split into 5 modules (pure code motion — every name
// below keeps its pre-split resolution path). The layer's doctrine doc lives
// at the head of ./closure.ts.
export { VERDICT_CLOSURE, TARGET_STAGES, TARGET_AGENTS, TARGET_SEPARATOR, TARGET_VERDICT_FAMILIES, VERDICT_FAMILY_VALUES, targetVerdictFamilies, allowedVerdictsForTarget, makeCanary } from "./closure.ts";
export type { VerdictFamily } from "./closure.ts";
export { repoRoot, validateGoldenCase, loadGoldenCases, defaultCasesDir } from "./cases.ts";
export type { GoldenCase, GoldenCaseTarget, Validation, SkippedFile, LoadedGoldenCases } from "./cases.ts";
export { RUBRIC_SCALE, validateRubric, loadRubrics, defaultRubricsDir, writeGoldenCaseTemplate, writeRubricTemplate } from "./rubrics.ts";
export type { Rubric, RubricDimension, RubricDimensionBandMap, RubricScale, LoadedRubrics } from "./rubrics.ts";
export { bandKey, caseSetOf } from "./bands.ts";
export { validateGateLabels, loadGateLabels, defaultLabelsDir, computeGateAgreement, gatePasses, GATE_MIN_AGREEMENT, GATE_MIN_MATCHED_PAIRS, GATE_BOOTSTRAP_RESAMPLES, GATE_BOOTSTRAP_SEED } from "./agreement.ts";
export type { ScorerVerdictRow, MaintainerVerdict, GateLabels, LoadedGateLabels, CalibrationBucket, TargetAgreement, GateAgreement, GateDecision } from "./agreement.ts";
