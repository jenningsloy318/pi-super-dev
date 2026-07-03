/**
 * gate-spec-review.mjs — Gate helper
 *
 * Validates spec review output:
 * - verdict is "Approved" or "Approved with Comments"
 */
export default async function helper({ sources }) {
  const review = sources?.["review-spec"];
  const errors = [];

  if (!review) {
    errors.push("Missing upstream: review-spec");
    return {
      schema: "helper-output-v1",
      digest: `FAIL: ${errors.length} error(s)`,
      value: { pass: false, errors, gate: "gate-spec-review" }
    };
  }

  if (!review.verdict) {
    errors.push("No verdict present in spec review");
  } else if (review.verdict !== "Approved" && review.verdict !== "Approved with Comments") {
    errors.push(`Verdict is "${review.verdict}" — changes requested`);
  }

  return {
    schema: "helper-output-v1",
    digest: errors.length === 0 ? "PASS" : `FAIL: ${errors.length} error(s)`,
    value: { pass: errors.length === 0, errors, gate: "gate-spec-review" }
  };
}
