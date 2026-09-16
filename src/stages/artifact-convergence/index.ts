// v0.4.17e: artifact-convergence.ts split into 5 modules (pure code motion —
// every name below keeps its pre-split resolution path).
export { ArtifactValidator, ArtifactReviewOptions, ArtifactConvergenceOptions, MAX_CONVERGENCE_ROUNDS, requirementsComplete, bddComplete, researchComplete } from "./validators.ts";
export { setArtifactFeedback, readRenderErrors, recordArtifactErrors, compactReviewFindings, setReviewFeedback, blockingSignature, getEscalate, reviewVerdictApproves, deliverCarriedDebt, judgeEscalateEvidencePresent } from "./feedback.ts";
export { PROGRESS_EXTENSION_ROUNDS, MAX_TOTAL_ROUND_MULTIPLE, effectiveRoundCap, extendedRoundCap } from "./rounds.ts";
export { artifactConvergenceNode } from "./node.ts";
export { requirementsConvergenceNode, bddConvergenceNode, researchConvergenceNode, designComplete, designConvergenceNode } from "./nodes.ts";
