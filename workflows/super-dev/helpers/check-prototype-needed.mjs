/**
 * check-prototype-needed.mjs — Utility helper
 *
 * Checks if the design contains numeric constants requiring
 * empirical validation via a prototype stage.
 */
export default async function helper({ sources }) {
  const design = sources?.["design"];
  if (!design) {
    return {
      schema: "helper-output-v1",
      digest: "No design source — prototype not needed",
      value: { needed: false, constants: [] }
    };
  }

  const needed = design.hasNumericConstants === true;
  const constants = [];

  // Extract constant names from modules if available
  if (needed && Array.isArray(design.modules)) {
    for (const mod of design.modules) {
      if (mod.constants && Array.isArray(mod.constants)) {
        constants.push(...mod.constants);
      }
    }
  }

  return {
    schema: "helper-output-v1",
    digest: needed ? `Prototype needed: ${constants.length} constant(s)` : "Prototype not needed",
    value: { needed, constants }
  };
}
