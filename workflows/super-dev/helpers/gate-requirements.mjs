/**
 * gate-requirements.mjs — Gate helper
 *
 * Validates requirements document output:
 * - docPath exists (non-null, non-empty)
 * - acCount >= 1
 * - summary present
 * - featureName non-empty
 */
export default async function helper({ sources }) {
  const req = sources?.["write-requirements"];
  const errors = [];

  if (!req) {
    errors.push("Missing upstream: write-requirements");
    return {
      schema: "helper-output-v1",
      digest: `FAIL: ${errors.length} error(s)`,
      value: { pass: false, errors, gate: "gate-requirements" }
    };
  }

  if (!req.docPath) {
    errors.push("No document path returned");
  }

  if (!req.acCount || req.acCount < 1) {
    errors.push("Missing acceptance criteria");
  }

  if (!req.summary) {
    errors.push("Missing summary section");
  }

  if (!req.featureName) {
    errors.push("Missing feature name");
  }

  return {
    schema: "helper-output-v1",
    digest: errors.length === 0 ? "PASS" : `FAIL: ${errors.length} error(s)`,
    value: { pass: errors.length === 0, errors, gate: "gate-requirements" }
  };
}
