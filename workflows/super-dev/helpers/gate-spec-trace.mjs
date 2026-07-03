/**
 * gate-spec-trace.mjs — Gate helper
 *
 * Validates specification output:
 * - specificationPath exists
 * - phaseCount >= 1
 * - phases array non-empty, each phase has a name
 */
export default async function helper({ sources }) {
  const spec = sources?.["write-spec"];
  const errors = [];

  if (!spec) {
    errors.push("Missing upstream: write-spec");
    return {
      schema: "helper-output-v1",
      digest: `FAIL: ${errors.length} error(s)`,
      value: { pass: false, errors, gate: "gate-spec-trace" }
    };
  }

  if (!spec.specificationPath) {
    errors.push("No specification path returned");
  }

  if (!spec.phaseCount || spec.phaseCount < 1) {
    errors.push("Phase count must be at least 1");
  }

  if (!Array.isArray(spec.phases) || spec.phases.length === 0) {
    errors.push("No implementation phases defined");
  } else {
    // Validate each phase has a name
    const unnamed = spec.phases.filter((p, i) => !p.name);
    if (unnamed.length > 0) {
      errors.push(`${unnamed.length} phase(s) missing a name`);
    }
  }

  return {
    schema: "helper-output-v1",
    digest: errors.length === 0 ? "PASS" : `FAIL: ${errors.length} error(s)`,
    value: { pass: errors.length === 0, errors, gate: "gate-spec-trace" }
  };
}
