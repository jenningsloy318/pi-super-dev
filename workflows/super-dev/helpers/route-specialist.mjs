/**
 * route-specialist.mjs — Routing helper
 *
 * Determines implementation specialist based on detected language.
 * Always returns "implementer" with language-specific prompt augmentation.
 */
export default async function helper({ sources }) {
  const classification = sources?.["classify-task"];
  if (!classification) {
    return {
      schema: "helper-output-v1",
      digest: "FAIL: missing classify-task source",
      value: { specialistAgent: "implementer", languageInstructions: "", reason: "Missing upstream: classify-task" }
    };
  }

  const { language } = classification;

  const instructionMap = {
    rust: "Follow Rust Edition 2024 idioms. Use thiserror for errors, tokio for async. Prefer zero-copy and ownership patterns. Run cargo clippy and cargo test.",
    go: "Follow Go 1.24+ idioms. Use structured errors with fmt.Errorf and %w. Prefer table-driven tests. Run go vet and go test ./...",
    frontend: "Use React 19+ patterns with TypeScript strict mode. Prefer server components where applicable. Follow existing component patterns and design tokens.",
    backend: "Follow existing backend patterns. Use dependency injection. Write integration tests alongside unit tests. Validate error handling paths.",
    mixed: "Respect the dominant language patterns in each file. Match surrounding code style. Test both frontend and backend changes."
  };

  const languageInstructions = instructionMap[language] || instructionMap.mixed;

  return {
    schema: "helper-output-v1",
    digest: `Specialist: implementer (${language})`,
    value: {
      specialistAgent: "implementer",
      languageInstructions,
      reason: `Generic implementer with ${language}-specific prompt augmentation`
    }
  };
}
