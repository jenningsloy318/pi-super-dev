/**
 * Deterministic build/test/typecheck gate — the HARD test oracle.
 *
 * Barrel re-exporting the cohesive sub-modules so every existing
 * `import { ... } from "../build-runner.ts"` keeps working unchanged.
 *   - detect.ts : project + cargo-metadata detection + shared utils
 *   - scope.ts  : git/cargo scoping + in/out-of-scope classification
 *   - gates.ts  : runBuildGate / runRedCheck / runDeliverableCheck / computeChangeGate + types
 */
export * from "./build-runner/detect.ts";
export * from "./build-runner/coverage-gate.ts";
export * from "./build-runner/scope.ts";
export * from "./build-runner/gates/index.ts"; // v0.4.17: gates.ts -> {build-gate,red-check,deliverable}.ts
