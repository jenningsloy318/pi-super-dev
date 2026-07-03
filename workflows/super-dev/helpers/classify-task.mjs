/**
 * classify-task.mjs — Routing helper
 *
 * Determines taskType (bug/feature/refactor), uiScope, and language
 * from the setup control data and the runtime task text.
 */
export default async function helper({ sources, options }) {
  const setup = sources?.["setup"];
  if (!setup) {
    return {
      schema: "helper-output-v1",
      digest: "FAIL: missing setup source",
      value: { taskType: "feature", uiScope: "none", language: "mixed", isWebUi: false, skipStages: [] }
    };
  }

  const { language = "mixed", isWebUi = false } = setup;
  const task = options?.runtimeTask ?? "";

  // Detect task type from keywords
  const bugKeywords = /\b(bug|fix|broken|crash|error|panic|fail|regression)\b/i;
  const refactorKeywords = /\b(refactor|restructure|improve|cleanup|clean up)\b/i;

  const taskType = bugKeywords.test(task) ? "bug"
    : refactorKeywords.test(task) ? "refactor"
    : "feature";

  // Detect UI scope
  const uiScope = isWebUi ? "ui+arch" : "none";

  return {
    schema: "helper-output-v1",
    digest: `Task: ${taskType}, UI: ${uiScope}, Lang: ${language}`,
    value: { taskType, uiScope, language, isWebUi, skipStages: [] }
  };
}
