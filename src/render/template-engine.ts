/**
 * Typed Jinja2-subset template renderer — zero dependencies. Ported from the
 * original super-dev-plugin's lib/template-engine.mjs (which was .mjs because
 * that project wasn't a real node project; ours is TS, so this is typed).
 *
 * Supported (matches what our templates use):
 *   {{ expr }}            interpolation        {{ feature.name }}
 *   {{ expr | filter }}   filters              {{ items | join(', ') }}
 *   {% for x in xs %}…{% endfor %}             loops (loop.index/.first/.last/…)
 *   {% if c %}…{% elif c %}…{% else %}…{% endif %}   conditionals
 *   {# comment #}         stripped
 *   {%- -%} / {{- -}}     whitespace trim
 *
 * Design: parse → AST → render. No eval(). Expressions use a safe property
 * walker. Filters: length, join, default, upper, lower, trim, round, format.
 */

/** A render context: variable name → value. */
export type Context = Record<string, unknown>;
import { readFileSync } from "node:fs";

type Filter = (value: unknown, ...args: unknown[]) => unknown;

const FILTERS: Record<string, Filter> = {
	length: (val: unknown) => (val == null ? 0 : (val as { length?: number }).length ?? 0),
	join: (val: unknown, sep = ", ") => (Array.isArray(val) ? val.join(String(sep)) : String(val ?? "")),
	default: (val: unknown, fallback = "") => (val == null || val === "" ? fallback : val),
	upper: (val: unknown) => String(val ?? "").toUpperCase(),
	lower: (val: unknown) => String(val ?? "").toLowerCase(),
	trim: (val: unknown) => String(val ?? "").trim(),
	round: (val: unknown, precision = 0) => {
		const n = Number(val);
		return precision === 0 ? Math.round(n) : Number(n.toFixed(Number(precision)));
	},
	format: (fmt: unknown, ...args: unknown[]) => {
		let i = 0;
		return String(fmt).replace(/%(\d*)([sd])/g, (_, width, type) => {
			const arg = args[i++];
			if (type === "d") {
				const num = Number(arg);
				return width ? String(num).padStart(Number(width), "0") : String(num);
			}
			return String(arg ?? "");
		});
	},
};

// ─── expression evaluation ──────────────────────────────────────────────────

function resolvePath(ctx: Context, path: string): unknown {
	const parts = path.trim().split(".");
	let val: unknown = ctx;
	for (const part of parts) {
		if (val == null) return undefined;
		val = (val as Record<string, unknown>)[part];
	}
	return val;
}

function evaluateExpr(expr: string, ctx: Context): unknown {
	const segments = splitPipes(expr.trim());
	let value = evaluateAtom(segments[0].trim(), ctx);
	for (let i = 1; i < segments.length; i++) {
		const { name, args } = parseFilter(segments[i].trim(), ctx);
		const fn = FILTERS[name];
		if (!fn) throw new Error(`Unknown filter: "${name}"`);
		value = fn(value, ...args);
	}
	return value;
}

function splitPipes(expr: string): string[] {
	const result: string[] = [];
	let current = "";
	let depth = 0;
	let inStr: string | null = null;
	for (let i = 0; i < expr.length; i++) {
		const ch = expr[i];
		if (inStr) {
			current += ch;
			if (ch === inStr && expr[i - 1] !== "\\") inStr = null;
		} else if (ch === '"' || ch === "'") {
			inStr = ch;
			current += ch;
		} else if (ch === "(") {
			depth++;
			current += ch;
		} else if (ch === ")") {
			depth--;
			current += ch;
		} else if (ch === "|" && depth === 0) {
			result.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	result.push(current);
	return result;
}

function parseFilter(filterExpr: string, ctx: Context): { name: string; args: unknown[] } {
	const parenIdx = filterExpr.indexOf("(");
	if (parenIdx === -1) return { name: filterExpr.trim(), args: [] };
	const name = filterExpr.slice(0, parenIdx).trim();
	const argsStr = filterExpr.slice(parenIdx + 1, filterExpr.lastIndexOf(")"));
	return { name, args: parseArgs(argsStr, ctx) };
}

function parseArgs(argsStr: string, ctx: Context): unknown[] {
	if (!argsStr.trim()) return [];
	const args: unknown[] = [];
	let current = "";
	let inStr: string | null = null;
	let isStringLiteral = false;
	for (let i = 0; i < argsStr.length; i++) {
		const ch = argsStr[i];
		if (inStr) {
			if (ch === inStr && argsStr[i - 1] !== "\\") inStr = null;
			else current += ch;
		} else if (ch === '"' || ch === "'") {
			inStr = ch;
			isStringLiteral = true;
		} else if (ch === ",") {
			args.push(isStringLiteral ? current : resolveArg(current.trim(), ctx));
			current = "";
			isStringLiteral = false;
		} else {
			current += ch;
		}
	}
	if (current || isStringLiteral) args.push(isStringLiteral ? current : resolveArg(current.trim(), ctx));
	return args;
}

function resolveArg(arg: string, ctx: Context): unknown {
	if (arg === "") return "";
	if (arg === "true") return true;
	if (arg === "false") return false;
	if (arg === "null" || arg === "none") return null;
	if (/^-?\d+(\.\d+)?$/.test(arg)) return Number(arg);
	return resolvePath(ctx, arg);
}

function evaluateAtom(atom: string, ctx: Context): unknown {
	const t = atom.trim();
	if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
	if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
	if (t === "true") return true;
	if (t === "false") return false;
	if (t === "null" || t === "none") return null;
	return resolvePath(ctx, t);
}

// ─── condition evaluation ───────────────────────────────────────────────────

function evaluateCondition(expr: string, ctx: Context): boolean {
	const t = expr.trim();
	if (t.startsWith("not ")) return !evaluateCondition(t.slice(4), ctx);
	const orParts = splitLogical(t, " or ");
	if (orParts.length > 1) return orParts.some((p) => evaluateCondition(p, ctx));
	const andParts = splitLogical(t, " and ");
	if (andParts.length > 1) return andParts.every((p) => evaluateCondition(p, ctx));
	const cmp = t.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
	if (cmp) {
		const left = evaluateExpr(cmp[1], ctx);
		const right = evaluateExpr(cmp[3], ctx);
		switch (cmp[2]) {
			case "==": return left == right;
			case "!=": return left != right;
			case ">": return (left as number) > (right as number);
			case "<": return (left as number) < (right as number);
			case ">=": return (left as number) >= (right as number);
			case "<=": return (left as number) <= (right as number);
		}
	}
	const val = evaluateExpr(t, ctx);
	return Array.isArray(val) ? val.length > 0 : !!val;
}

function splitLogical(expr: string, op: string): string[] {
	const parts: string[] = [];
	let current = "";
	let i = 0;
	while (i < expr.length) {
		if (expr.slice(i, i + op.length) === op) {
			parts.push(current);
			current = "";
			i += op.length;
		} else {
			current += expr[i];
			i++;
		}
	}
	parts.push(current);
	return parts.filter((p) => p.trim());
}

// ─── AST + parser ───────────────────────────────────────────────────────────

type ASTNode =
	| { type: "text"; value: string }
	| { type: "expr"; expr: string }
	| { type: "for"; varName: string; iterExpr: string; body: ASTNode[] }
	| { type: "if"; branches: Array<{ cond: string | null; body: ASTNode[] }> };

interface Token {
	type: "text" | "expr" | "tag";
	value: string;
}

function tokenize(template: string): Token[] {
	const tokens: Token[] = [];
	const regex = /(\{#[\s\S]*?#\}|\{%-?[\s\S]*?-?%\}|\{\{-?[\s\S]*?-?\}\})/;
	const parts = template.split(regex);
	for (let idx = 0; idx < parts.length; idx++) {
		const part = parts[idx];
		if (!part) continue;
		if (part.startsWith("{#") && part.endsWith("#}")) {
			if (parts[idx + 1]?.startsWith("\n")) parts[idx + 1] = parts[idx + 1].slice(1);
			continue;
		}
		if (part.startsWith("{%") && part.endsWith("%}")) {
			const trimLeft = part.startsWith("{%-");
			const trimRight = part.endsWith("-%}");
			const inner = part.slice(trimLeft ? 3 : 2, trimRight ? -3 : -2).trim();
			tokens.push({ type: "tag", value: inner });
			if (parts[idx + 1]?.startsWith("\n")) parts[idx + 1] = parts[idx + 1].slice(1);
		} else if (part.startsWith("{{") && part.endsWith("}}")) {
			const trimLeft = part.startsWith("{{-");
			const trimRight = part.endsWith("-}}");
			const inner = part.slice(trimLeft ? 3 : 2, trimRight ? -3 : -2).trim();
			tokens.push({ type: "expr", value: inner });
		} else {
			tokens.push({ type: "text", value: part });
		}
	}
	return tokens;
}

function buildAST(tokens: Token[], startIdx: number): { nodes: ASTNode[]; endIdx: number } {
	const nodes: ASTNode[] = [];
	let i = startIdx;
	while (i < tokens.length) {
		const token = tokens[i];
		if (token.type === "text") {
			nodes.push({ type: "text", value: token.value });
			i++;
		} else if (token.type === "expr") {
			nodes.push({ type: "expr", expr: token.value });
			i++;
		} else {
			const tag = token.value;
			if (tag.startsWith("for ")) {
				const m = tag.match(/^for\s+(\w+)\s+in\s+(.+)$/);
				if (!m) throw new Error(`Invalid for tag: {% ${tag} %}`);
				i++;
				const body = buildAST(tokens, i);
				i = body.endIdx;
				if (i >= tokens.length || tokens[i].value !== "endfor") throw new Error(`Missing endfor for: {% ${tag} %}`);
				i++;
				nodes.push({ type: "for", varName: m[1], iterExpr: m[2].trim(), body: body.nodes });
			} else if (tag.startsWith("if ")) {
				const branches: Array<{ cond: string | null; body: ASTNode[] }> = [];
				const cond = tag.slice(3).trim();
				i++;
				let body = buildAST(tokens, i);
				i = body.endIdx;
				branches.push({ cond, body: body.nodes });
				while (i < tokens.length && tokens[i].type === "tag") {
					const next = tokens[i].value;
					if (next.startsWith("elif ")) {
						i++;
						body = buildAST(tokens, i);
						i = body.endIdx;
						branches.push({ cond: next.slice(5).trim(), body: body.nodes });
					} else if (next === "else") {
						i++;
						body = buildAST(tokens, i);
						i = body.endIdx;
						branches.push({ cond: null, body: body.nodes });
					} else break;
				}
				if (i >= tokens.length || tokens[i].value !== "endif") throw new Error(`Missing endif for: {% if ${cond} %}`);
				i++;
				nodes.push({ type: "if", branches });
			} else if (tag === "endfor" || tag === "endif" || tag.startsWith("elif ") || tag === "else") {
				return { nodes, endIdx: i };
			} else {
				throw new Error(`Unknown tag: {% ${tag} %}`);
			}
		}
	}
	return { nodes, endIdx: i };
}

// ─── renderer ───────────────────────────────────────────────────────────────

function renderNodes(nodes: ASTNode[], ctx: Context): string {
	let out = "";
	for (const node of nodes) {
		if (node.type === "text") out += node.value;
		else if (node.type === "expr") {
			const v = evaluateExpr(node.expr, ctx);
			out += v == null ? "" : String(v);
		} else if (node.type === "for") out += renderFor(node, ctx);
		else if (node.type === "if") out += renderIf(node, ctx);
	}
	return out;
}

function renderFor(node: Extract<ASTNode, { type: "for" }>, ctx: Context): string {
	const items = evaluateExpr(node.iterExpr, ctx);
	if (!Array.isArray(items)) return "";
	let out = "";
	for (let i = 0; i < items.length; i++) {
		out += renderNodes(node.body, {
			...ctx,
			[node.varName]: items[i],
			loop: { index: i + 1, index0: i, first: i === 0, last: i === items.length - 1, length: items.length },
		});
	}
	return out;
}

function renderIf(node: Extract<ASTNode, { type: "if" }>, ctx: Context): string {
	for (const branch of node.branches) {
		if (branch.cond === null || evaluateCondition(branch.cond, ctx)) return renderNodes(branch.body, ctx);
	}
	return "";
}

// ─── public API ─────────────────────────────────────────────────────────────

/** Render a Jinja2-subset template string with the given data context. */
export function render(template: string, data: Context): string {
	return renderNodes(buildAST(tokenize(template), 0).nodes, data);
}

/** Render a template file with JSON data (reads synchronously). */
export function renderFile(templatePath: string, data: Context): string {
	return render(readFileSync(templatePath, "utf8"), data);
}
