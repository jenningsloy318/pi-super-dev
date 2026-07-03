import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function activate(pi: ExtensionAPI): void {
  // Register /super-dev command
  pi.registerCommand("super-dev", {
    description:
      "Run the 13-stage super-dev pipeline: requirements → research → design → spec → implement → review → merge",
    handler: async (args: string, ctx: any) => {
      if (!args.trim()) {
        ctx.output(
          "Usage: /super-dev <task description>\n\n" +
            "Examples:\n" +
            '  /super-dev implement user authentication with OAuth2\n' +
            '  /super-dev fix the crash when uploading large files\n' +
            '  /super-dev refactor database layer to use connection pooling\n\n' +
            "This starts the full 13-stage pipeline: classify → requirements → BDD → research → " +
            "assessment → design → spec → spec-review → implementation (TDD) → code-review → " +
            "docs → cleanup → merge",
        );
        return;
      }

      // Delegate to workflow_run tool (provided by @agwab/pi-workflow)
      const workflowRunTool = ctx.getTool?.("workflow_run");
      if (workflowRunTool) {
        await workflowRunTool.execute("", {
          workflow: "super-dev",
          task: args.trim(),
        }, ctx.signal, undefined, ctx);
      } else {
        // Fallback: instruct the LLM to call workflow_run
        ctx.output(
          `Starting super-dev pipeline for: "${args.trim()}"\n\n` +
            "Dispatching to workflow engine...\n\n" +
            'Use `workflow_run({ workflow: "super-dev", task: "' +
            args.trim() +
            '" })` to execute.',
        );
      }
    },
  });
}
