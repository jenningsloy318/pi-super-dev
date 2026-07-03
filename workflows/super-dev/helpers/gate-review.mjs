/**
 * gate-review.mjs — Gate helper
 *
 * Validates merged code review verdict:
 * - verdict is "Approved" or "Approved with Comments"
 */
export default async function helper({ sources }) {
  const merged = sources?.["merge-verdicts"];
  const errors = [];

  if (!merged) {
    errors.push("Missing upstream: merge-verdicts");
    return {
      schema: "helper-output-v1",
      digest: `FAIL: ${errors.length} error(s)`,
      value: { pass: false, errors, gate: "gate-review" }
    };
  }

  if (!merged.verdict) {
    errors.push("No verdict present in merged review");
  } else if (merged.verdict !== "Approved" && merged.verdict !== "Approved with Comments") {
    errors.push(`Verdict is "${merged.verdict}" — changes requested`);
  }

  return {
    schema: "helper-output-v1",
    digest: errors.length === 0 ? "PASS" : `FAIL: ${errors.length} error(s)`,
    value: { pass: errors.length === 0, errors, gate: "gate-review" }
  };
}
