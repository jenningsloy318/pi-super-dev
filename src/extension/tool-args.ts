/** Wave 3 increment 4: the tool-invocation surface — the /super-dev command
 *  args parse, the canon output-truncation pair (50KB/2000-line bounds, UTF-8
 *  byte walk with surrogate-pair safety), the removed-background-flag guard,
 *  and the foreground tool instruction builder — extracted from extension.ts
 *  verbatim. One reason to change: how the super_dev tool is invoked and its
 *  output bounded. */

export const SUPER_DEV_TOOL = "super_dev";
export const SUPER_DEV_COMMAND = "super-dev";
export const SUPER_DEV_PANEL_SHORTCUT = "ctrl+shift+d";

export interface ParsedSuperDevCommandArgs {
	task: string;
}

/** Parse `/super-dev` args. The command is foreground-only. */
export function parseSuperDevCommandArgs(args: unknown): ParsedSuperDevCommandArgs {
	return { task: String(args ?? "").trim() };
}

/** v0.3.60 R8 (canon: extensions.md Output Truncation — tools MUST truncate
 *  to ~50KB / ~2000 lines and tell the model where the full output lives).
 *  Guards the headless (print/json/RPC) `content` path; byte-identical below
 *  both bounds. The notice points at the durable run log. */
export const CANON_MAX_CONTENT_BYTES = 50_000;
export const CANON_MAX_CONTENT_LINES = 2_000;
export function canonTruncate(text: string, logPath?: string): string {
	const totalLines = text.split("\n").length;
	if (Buffer.byteLength(text, "utf8") <= CANON_MAX_CONTENT_BYTES && totalLines <= CANON_MAX_CONTENT_LINES) return text;
	// v0.3.61: the byte bound is measured in UTF-8 BYTES (canon DEFAULT_MAX_BYTES),
	// not UTF-16 code units — a 50k-char slice let CJK content through at ~3× the
	// cap — and the cut walks code points so it never splits a surrogate pair.
	let kept = text;
	if (Buffer.byteLength(text, "utf8") > CANON_MAX_CONTENT_BYTES) {
		let bytes = 0;
		let end = 0;
		for (const ch of text) {
			const w = Buffer.byteLength(ch, "utf8");
			if (bytes + w > CANON_MAX_CONTENT_BYTES) break;
			bytes += w;
			end += ch.length;
		}
		kept = text.slice(0, end);
	}
	const keptLines = kept.split("\n");
	const lineCapped = keptLines.length > CANON_MAX_CONTENT_LINES;
	if (lineCapped) keptLines.length = CANON_MAX_CONTENT_LINES;
	kept = keptLines.join("\n");
	const notice = lineCapped
		? `[Output truncated: showing ${keptLines.length} of ${totalLines} lines — full output saved to: ${logPath ?? "the run log"}]`
		: `[Output truncated: kept first ${CANON_MAX_CONTENT_BYTES} bytes (${totalLines} lines) — full output saved to: ${logPath ?? "the run log"}]`;
	return `${kept}\n${notice}`;
}

export function hasRemovedBackgroundFlag(args: unknown): boolean {
	return /^--(?:bg|background)(?:\s+|$)/.test(String(args ?? "").trim());
}

export function buildSuperDevToolInstruction(task: string): string {
	return [
		`Use the ${SUPER_DEV_TOOL} tool with these exact parameters:`,
		JSON.stringify({ task }, null, 2),
		"Call the tool now. Pass the task verbatim.",
	].join("\n");
}
