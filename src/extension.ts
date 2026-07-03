import { existsSync, mkdirSync, symlinkSync, readlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/** Minimal Pi extension API surface we use. */
interface ExtensionAPI {
  registerCommand(
    name: string,
    opts: {
      description: string;
      handler: (args: string, ctx: any) => Promise<void> | void;
    },
  ): void;
}

/**
 * Ensure our workflow spec is discoverable by pi-workflow.
 *
 * pi-workflow discovers workflows from `~/.pi/agent/workflows/`.
 * We symlink our `workflows/super-dev/` bundle there so it's
 * globally available regardless of cwd.
 */
function ensureWorkflowSymlink(): void {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const sourceDir = join(packageRoot, "workflows", "super-dev");
  const targetParent = join(homedir(), ".pi", "agent", "workflows");
  const targetLink = join(targetParent, "super-dev");

  if (!existsSync(sourceDir)) return; // safety: don't link if source missing

  // Create ~/.pi/agent/workflows/ if it doesn't exist
  if (!existsSync(targetParent)) {
    mkdirSync(targetParent, { recursive: true });
  }

  // Create or update symlink
  if (existsSync(targetLink)) {
    try {
      const current = readlinkSync(targetLink);
      if (resolve(current) === resolve(sourceDir)) return; // already correct
    } catch {
      // exists but not a symlink — don't overwrite
      return;
    }
  }

  try {
    symlinkSync(sourceDir, targetLink);
  } catch {
    // Permission denied or other OS error — non-fatal
  }
}

export default function activate(pi: ExtensionAPI): void {
  // Make workflow discoverable by pi-workflow
  ensureWorkflowSymlink();

  // Register /super-dev command
  pi.registerCommand("super-dev", {
    description:
      "Run the 13-stage super-dev pipeline: requirements → research → design → spec → implement → review → merge",
    handler: async (args: string, ctx: any) => {
      if (!args.trim()) {
        ctx.output(
          "Usage: /super-dev <task description>\n\n" +
            "Examples:\n" +
            "  /super-dev implement user authentication with OAuth2\n" +
            "  /super-dev fix the crash when uploading large files\n" +
            "  /super-dev refactor database layer to use connection pooling\n\n" +
            "This starts the full 13-stage pipeline: classify → requirements → BDD → research → " +
            "assessment → design → spec → spec-review → implementation (TDD) → code-review → " +
            "docs → cleanup → merge\n\n" +
            "Requires: @agwab/pi-workflow (pi install npm:@agwab/pi-workflow)",
        );
        return;
      }

      // Delegate to workflow_run tool (provided by @agwab/pi-workflow)
      const workflowRunTool = ctx.getTool?.("workflow_run");
      if (workflowRunTool) {
        await workflowRunTool.execute(
          "",
          { workflow: "super-dev", task: args.trim() },
          ctx.signal,
          undefined,
          ctx,
        );
      } else {
        ctx.output(
          "Error: @agwab/pi-workflow is not installed.\n\n" +
            "The super-dev pipeline requires the pi-workflow engine.\n" +
            "Install it with:\n\n" +
            "  pi install npm:@agwab/pi-workflow\n\n" +
            "Then restart Pi and try again.",
        );
      }
    },
  });
}
