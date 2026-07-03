/**
 * cleanup.mjs — Utility helper
 *
 * Scans the worktree for build artifacts, temporary files, and sensitive data.
 * Returns whether the merge should be blocked due to sensitive data findings.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const BUILD_DIRS = [
  "node_modules", "target", "dist", "build", "__pycache__",
  ".next", ".nuxt", ".output", "coverage", ".turbo"
];

const SENSITIVE_PATTERNS = [
  /\.env$/,
  /\.env\.local$/,
  /\.env\.production$/,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /id_ed25519/,
  /\.p12$/,
  /credentials\.json$/,
  /service[-_]account.*\.json$/
];

const SECRET_CONTENT_PATTERNS = [
  /PRIVATE KEY/,
  /sk[-_]live/,
  /sk[-_]test/,
  /api[-_]?key\s*[:=]\s*["'][^"']{20,}/i,
  /secret\s*[:=]\s*["'][^"']{20,}/i
];

export default async function helper({ sources, context }) {
  const cwd = context?.cwd;
  if (!cwd) {
    return {
      schema: "helper-output-v1",
      digest: "FAIL: no cwd in context",
      value: {
        languagesDetected: [],
        directoriesRemoved: [],
        sensitiveDataFindings: [],
        blocked: false,
        summary: "Could not scan — no working directory provided"
      }
    };
  }

  const languagesDetected = [];
  const directoriesRemoved = [];
  const sensitiveDataFindings = [];

  // Detect languages from common markers
  const languageMarkers = {
    rust: ["Cargo.toml", "Cargo.lock"],
    go: ["go.mod", "go.sum"],
    frontend: ["package.json", "tsconfig.json"],
    python: ["pyproject.toml", "setup.py", "requirements.txt"]
  };

  for (const [lang, markers] of Object.entries(languageMarkers)) {
    for (const marker of markers) {
      try {
        await stat(join(cwd, marker));
        if (!languagesDetected.includes(lang)) {
          languagesDetected.push(lang);
        }
        break;
      } catch {
        // File not found — skip
      }
    }
  }

  // Scan for build directories
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && BUILD_DIRS.includes(entry.name)) {
        directoriesRemoved.push(entry.name);
      }
    }
  } catch {
    // Cannot read directory
  }

  // Scan for sensitive files (top-level only for performance)
  try {
    const entries = await readdir(cwd);
    for (const entry of entries) {
      for (const pattern of SENSITIVE_PATTERNS) {
        if (pattern.test(entry)) {
          sensitiveDataFindings.push(`Sensitive file detected: ${entry}`);
          break;
        }
      }
    }
  } catch {
    // Cannot read directory
  }

  const blocked = sensitiveDataFindings.length > 0;

  return {
    schema: "helper-output-v1",
    digest: blocked
      ? `BLOCKED: ${sensitiveDataFindings.length} sensitive finding(s)`
      : `Clean: ${languagesDetected.length} lang(s), ${directoriesRemoved.length} build dir(s)`,
    value: {
      languagesDetected,
      directoriesRemoved,
      sensitiveDataFindings,
      blocked,
      summary: blocked
        ? `Merge blocked: found ${sensitiveDataFindings.length} sensitive data issue(s)`
        : `Worktree clean. Languages: ${languagesDetected.join(", ") || "none detected"}`
    }
  };
}
