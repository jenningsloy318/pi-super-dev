/**
 * gate-bdd.mjs — Gate helper
 *
 * Validates BDD scenarios output:
 * - docPath exists
 * - scenarioCount >= 1
 * - edgeCasesCovered === true OR coverageScore >= 0.6
 */
export default async function helper({ sources }) {
  const bdd = sources?.["write-bdd"];
  const errors = [];

  if (!bdd) {
    errors.push("Missing upstream: write-bdd");
    return {
      schema: "helper-output-v1",
      digest: `FAIL: ${errors.length} error(s)`,
      value: { pass: false, errors, gate: "gate-bdd" }
    };
  }

  if (!bdd.docPath) {
    errors.push("No document path returned");
  }

  if (!bdd.scenarioCount || bdd.scenarioCount < 1) {
    errors.push("No scenarios written");
  }

  // Edge cases: either explicit flag or coverage score threshold
  const edgeCasesOk = bdd.edgeCasesCovered === true ||
    (typeof bdd.coverageScore === "number" && bdd.coverageScore >= 0.6);

  if (!edgeCasesOk) {
    errors.push("Insufficient edge case coverage (need edgeCasesCovered or coverageScore >= 0.6)");
  }

  return {
    schema: "helper-output-v1",
    digest: errors.length === 0 ? "PASS" : `FAIL: ${errors.length} error(s)`,
    value: { pass: errors.length === 0, errors, gate: "gate-bdd" }
  };
}
