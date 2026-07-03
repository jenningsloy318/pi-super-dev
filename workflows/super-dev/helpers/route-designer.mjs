/**
 * route-designer.mjs — Routing helper
 *
 * Selects the appropriate design agent based on taskType and uiScope.
 */
export default async function helper({ sources }) {
  const classification = sources?.["classify-task"];
  if (!classification) {
    return {
      schema: "helper-output-v1",
      digest: "FAIL: missing classify-task source",
      value: { designerAgent: null, reason: "Missing upstream: classify-task" }
    };
  }

  const { taskType, uiScope } = classification;

  let designerAgent = null;
  let reason = "";

  if (taskType === "bug") {
    reason = "Bug fixes do not redesign — pivot-protocol owns design changes";
  } else if (uiScope === "ui+arch") {
    designerAgent = "product-designer";
    reason = "Both UI and architecture changes needed";
  } else if (uiScope === "ui-only") {
    designerAgent = "ui-ux-designer";
    reason = "UI-only changes";
  } else if (taskType === "refactor") {
    designerAgent = "architecture-improver";
    reason = "Refactoring existing architecture";
  } else {
    designerAgent = "architecture-designer";
    reason = "New feature requires architecture design";
  }

  return {
    schema: "helper-output-v1",
    digest: designerAgent ? `Route to ${designerAgent}` : "Skip design (bug fix)",
    value: { designerAgent, reason }
  };
}
