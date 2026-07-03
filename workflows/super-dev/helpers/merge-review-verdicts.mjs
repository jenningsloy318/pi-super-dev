/**
 * merge-review-verdicts.mjs — Merge helper
 *
 * Merges code-reviewer and adversarial-reviewer verdicts into a single
 * final verdict, taking the stricter result.
 *
 * Strictness order: "Changes Requested" > "Approved with Comments" > "Approved"
 */

const VERDICT_RANK = {
  "Approved": 0,
  "Approved with Comments": 1,
  "Changes Requested": 2
};

export default async function helper({ sources }) {
  const codeReview = sources?.["code-review"];
  const adversarialReview = sources?.["adversarial-review"];

  if (!codeReview && !adversarialReview) {
    return {
      schema: "helper-output-v1",
      digest: "FAIL: missing both review sources",
      value: {
        verdict: "Changes Requested",
        findings: [],
        dimensionsCovered: []
      }
    };
  }

  // Default to "Approved" if one source is missing
  const codeVerdict = codeReview?.verdict ?? "Approved";
  const adversarialVerdict = adversarialReview?.verdict ?? "Approved";

  // Take the stricter verdict
  const codeRank = VERDICT_RANK[codeVerdict] ?? 0;
  const adversarialRank = VERDICT_RANK[adversarialVerdict] ?? 0;
  const verdict = codeRank >= adversarialRank ? codeVerdict : adversarialVerdict;

  // Merge findings from both reviews
  const findings = [
    ...(Array.isArray(codeReview?.findings) ? codeReview.findings : []),
    ...(Array.isArray(adversarialReview?.findings) ? adversarialReview.findings : [])
  ];

  // Merge dimensions covered
  const dimensionsCovered = [
    ...(Array.isArray(codeReview?.dimensionsCovered) ? codeReview.dimensionsCovered : []),
    ...(Array.isArray(adversarialReview?.dimensionsCovered) ? adversarialReview.dimensionsCovered : [])
  ];

  // Deduplicate dimensions
  const uniqueDimensions = [...new Set(dimensionsCovered)];

  return {
    schema: "helper-output-v1",
    digest: `Merged verdict: ${verdict} (${findings.length} finding(s))`,
    value: { verdict, findings, dimensionsCovered: uniqueDimensions }
  };
}
