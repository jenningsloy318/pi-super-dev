/**
 * gate-build.mjs — Gate helper
 *
 * Validates build and test results from the QA agent:
 * - allTestsPass === true
 * - buildSuccess === true
 */
export default async function helper({ sources }) {
  const qa = sources?.["qa-check"];
  const errors = [];

  if (!qa) {
    errors.push("Missing upstream: qa-check");
    return {
      schema: "helper-output-v1",
      digest: `FAIL: ${errors.length} error(s)`,
      value: { pass: false, errors, gate: "gate-build" }
    };
  }

  if (qa.buildSuccess !== true) {
    errors.push("Build failed");
  }

  if (qa.allTestsPass !== true) {
    errors.push("Tests failing");
  }

  return {
    schema: "helper-output-v1",
    digest: errors.length === 0 ? "PASS" : `FAIL: ${errors.length} error(s)`,
    value: { pass: errors.length === 0, errors, gate: "gate-build" }
  };
}
