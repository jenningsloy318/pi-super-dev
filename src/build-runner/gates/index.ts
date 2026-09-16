// v0.4.17: gates.ts split into 3 modules (pure code motion — every name below
// keeps its pre-split resolution path "../build-runner/gates").
export { RedCheckPlan, RedCheckDiagnostic, DEFAULT_TIMEOUT_MS, resolveTimeoutMs, CmdKey, BuildGateResult, buildGateCorrelationLine, GateOptions, BASELINE_VERIFY_ERROR_PREFIX, resolveInScopePassWithBaseline } from "./build-gate.ts";
export { runBuildGate, RedStatus, RedCheckOptions, classifyFromEvidence } from "./red-check.ts";
export { runRedCheck, DeliverableContract, DeliverableCheckResult, DeliverableCheckOptions, resetDeliverableCheckCache, tolerantMatch, ChangeGateResult, computeChangeGate, SymbolGateResult, stripCommentsAndBlanks, computeSymbolGate, runDeliverableCheck, deliverablesAlreadyMet } from "./deliverable.ts";
