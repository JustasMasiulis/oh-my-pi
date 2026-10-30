/**
 * LSP Tool TUI Rendering
 *
 * Renders LSP tool calls and results in the TUI with:
 * - Syntax-highlighted hover information
 * - Color-coded diagnostics by severity
 * - Grouped references and symbols
 * - Collapsible/expandable views
 */
import type { TspSpan, TspText, TspTone, TspTreeNode } from "@oh-my-pi/pi-wire";
import type { NativeToolHead, NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";
import type { Component } from "../tui";
import { highlightCode as highlightThemeCode, type Theme } from "../theme/theme";
import {
	formatCount,
	formatErrorText,
	formatExpandHint,
	formatMoreItems,
	formatStyledPath,
	type ParsedDiagnostic,
	PREVIEW_LIMITS,
	parseDiagnosticMessage,
	replaceTabs,
	sanitizeDiagnosticDisplayText,
	shortenPath,
	TRUNCATE_LENGTHS,
	type ToolUIStatus,
	truncateToWidth,
} from "../render/render-utils";
import type { StatusLineOptions } from "../render/status-line";
import { plainToolCard } from "../render/tool-card";
import { visibleWidth } from "../utils";
import { ansi, code, col, compact, keyed, md, node, row, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { walkGroupedOutput } from "./grouped-file-output";
import { diagnosticGlyph, fileHref, fileRow, inlineErrorView } from "./native-view";
import { activeThemeSymbol } from "../theme/active-symbols";

/** Display arguments for an LSP tool request. */
export interface LspParams {
	action:
		| "diagnostics"
		| "definition"
		| "references"
		| "hover"
		| "symbols"
		| "rename"
		| "rename_file"
		| "code_actions"
		| "type_definition"
		| "implementation"
		| "status"
		| "reload"
		| "capabilities"
		| "request";
	file?: string;
	line?: number;
	symbol?: string;
	query?: string;
	new_name?: string;
	apply?: boolean;
	timeout?: number;
	payload?: string;
}

/** Details accompanying an LSP tool response. */
export interface LspToolDetails {
	serverName?: string;
	action: string;
	success: boolean;
	request?: LspParams;
}

/** Diagnostics and formatting status for one file. */
export interface FileDiagnosticsResult {
	/** Name of the LSP server used (if available) */
	server?: string;
	/** Formatted diagnostic messages */
	messages: string[];
	/** Summary string (e.g., "2 error(s), 1 warning(s)") */
	summary: string;
	/** Whether there are any errors (severity 1) */
	errored: boolean;
	/** Servers that sent no fresh report in time: the file is unverified for them, not clean. */
	unreported?: string[];
	/** Whether the file was formatted */
	formatter?: FileFormatResult;
}

/** Outcome of automatic file formatting. */
export enum FileFormatResult {
	UNCHANGED = "unchanged",
	FORMATTED = "formatted",
	FAILED = "failed",
	UNSUPPORTED = "unsupported",
}

// =============================================================================
// Call Rendering
// =============================================================================

function sanitizeInlineText(value: string): string {
	return replaceTabs(value).replaceAll(/\r?\n/g, " ");
}

/** The header subject: `action target`, e.g. `references src/a.ts:42 (validateToken)`. */
function lspSubject(args: Partial<LspParams> | undefined, theme: Theme): string {
	const actionLabel = (args?.action ?? "request").replace(/_/g, " ");
	const queryPreview = args?.query
		? truncateToWidth(sanitizeInlineText(args.query), TRUNCATE_LENGTHS.SHORT)
		: undefined;
	const symbolPreview = args?.symbol
		? truncateToWidth(sanitizeInlineText(args.symbol), TRUNCATE_LENGTHS.SHORT)
		: undefined;

	let target: string | undefined;
	if (args?.file) {
		target = shortenPath(args.file);
		if (args.line !== undefined) target += `:${args.line}`;
	} else if (args?.line !== undefined) {
		target = `line ${args.line}`;
	}
	if (target && args?.line !== undefined && symbolPreview) target += ` (${symbolPreview})`;
	if (!target) target = queryPreview;

	const parts = [actionLabel];
	if (target) parts.push(target);
	if (args?.new_name) parts.push(theme.format.arrowRight, sanitizeInlineText(args.new_name));
	return parts.join(" ");
}

/** Call facts not already in the subject. */
function lspCallMeta(args: Partial<LspParams> | undefined): string[] {
	const meta: string[] = [];
	if (args?.query && (args.file || args.line !== undefined)) {
		meta.push(`query:${truncateToWidth(sanitizeInlineText(args.query), TRUNCATE_LENGTHS.SHORT)}`);
	}
	if (args?.apply !== undefined) meta.push(`apply:${args.apply ? "true" : "false"}`);
	return meta;
}

function lspStatus(
	args: Partial<LspParams> | undefined,
	icon: ToolUIStatus,
	theme: Theme,
	options: { spinnerFrame?: number; meta?: string[] } = {},
): StatusLineOptions {
	return {
		icon,
		spinnerFrame: options.spinnerFrame,
		title: "LSP",
		description: lspSubject(args, theme),
		meta: [...lspCallMeta(args), ...(options.meta ?? [])],
	};
}

/** Render the LSP tool call: the status line, pending until the request runs. */
export function renderCall(args: LspParams, options: RenderResultOptions, theme: Theme): Component {
	const icon: ToolUIStatus = options.executionStarted ? "running" : "pending";
	const status = lspStatus(args, icon, theme, { spinnerFrame: options.spinnerFrame });
	return plainToolCard(theme, () => ({ status }));
}

// =============================================================================
// Result Rendering
// =============================================================================

/** A diagnostics status line for a file no server reported on in time: unverified, never "No issues". */
const UNREPORTED_LINE_RE = /\bno diagnostics report yet\b/;
/** Files shown while a references result is collapsed. */
const COLLAPSED_REFERENCE_FILES = 3;
/** Locations shown per file while a references result is collapsed. */
const COLLAPSED_REFERENCE_LOCATIONS = 2;
/** Diagnostics shown while collapsed. */
const COLLAPSED_DIAGNOSTICS = 3;
/** Output lines shown while a generic response is collapsed. */
const COLLAPSED_GENERIC_LINES = 4;

/**
 * Body rows for one expansion state. Rows are unclipped; collapsed rows are
 * clipped to the width afterwards. `more` is the trailing `… N more <items>`
 * marker; `markerLast` says the last row is already a (nested) truncation marker.
 */
interface LspRows {
	rows: string[];
	more?: string;
	markerLast?: boolean;
}

/** A parsed LSP response: the header outcome and meta, and the body rows per expansion. */
interface LspResultView {
	icon: ToolUIStatus;
	meta: string[];
	rows(expanded: boolean): LspRows;
}

/**
 * Lay out a view's rows: expanded rows stay whole (the flush card wraps them
 * under their tree guides); collapsed rows clip to one line each, and the
 * expand hint closes the body whenever the collapsed view hides anything (a
 * truncation marker or a clipped row).
 */
function layoutRows(view: LspResultView, expanded: boolean, width: number, theme: Theme): string[] {
	const { rows, more, markerLast } = view.rows(expanded);
	if (expanded) return rows;
	const clipped = rows.some(row => visibleWidth(row) > width);
	const fitted = rows.map(row => truncateToWidth(row, width));
	const hint = formatExpandHint(theme, false, true);
	if (more) fitted.push(`${theme.fg("dim", more)} ${hint}`);
	else if (markerLast) fitted[fitted.length - 1] += ` ${hint}`;
	else if (clipped) fitted.push(hint);
	return fitted;
}

/** A tree child row under a flush item. */
function childRow(content: string, isLast: boolean, theme: Theme): string {
	return `${theme.fg("dim", isLast ? theme.tree.last : theme.tree.branch)} ${content}`;
}

/**
 * Render LSP tool result as a flush card: the status line (outcome and counts)
 * over the result list. Detects hover, diagnostics, references and symbols.
 */
export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: LspToolDetails; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args?: LspParams,
): Component {
	const request = args ??
		result.details?.request ?? { action: (result.details?.action ?? "request") as LspParams["action"] };
	const content = result.content?.[0];
	const text = content?.type === "text" ? (content.text ?? "") : "";

	if (result.isError) {
		const lines = (text.trim() || "LSP request failed")
			.split("\n")
			.filter(line => line.trim().length > 0)
			.map(line => formatErrorText(line, theme));
		const status = lspStatus(request, "error", theme);
		return plainToolCard(theme, () => ({ status, phase: "error", body: lines }));
	}
	if (!text) {
		const status = lspStatus(request, "warning", theme, { meta: ["no result"] });
		return plainToolCard(theme, () => ({ status, phase: "warning" }));
	}

	const view = parseLspResult(text, result.details?.action ?? request.action, theme);
	// The rows depend only on the (immutable) text, theme, width and `expanded`.
	const cache: Array<{ width: number; rows: string[] } | undefined> = [undefined, undefined];
	return plainToolCard(theme, ({ contentWidth }) => {
		const { expanded, isPartial, spinnerFrame } = options;
		const slot = expanded ? 1 : 0;
		let cached = cache[slot];
		if (!cached || cached.width !== contentWidth) {
			cached = { width: contentWidth, rows: layoutRows(view, expanded, contentWidth, theme) };
			cache[slot] = cached;
		}
		const icon: ToolUIStatus = isPartial ? "running" : view.icon;
		return {
			status: lspStatus(request, icon, theme, { spinnerFrame, meta: view.meta }),
			phase: isPartial ? "partial" : view.icon === "success" ? "success" : "warning",
			body: cached.rows,
		};
	});
}

/** Detect the response kind and build its view. */
function parseLspResult(text: string, action: string, theme: Theme): LspResultView {
	const lines = text.split("\n");
	const codeBlockMatch = text.match(/```(\w*)\n([\s\S]*?)```/);
	if (codeBlockMatch) return hoverView(codeBlockMatch, text, theme);

	const errorMatch = text.match(/(\d+)\s+error\(s\)/);
	const warningMatch = text.match(/(\d+)\s+warning\(s\)/);
	const unreportedCount = lines.filter(line => UNREPORTED_LINE_RE.test(line)).length;
	if (errorMatch || warningMatch || text.includes(theme.status.error) || unreportedCount > 0) {
		return diagnosticsView(errorMatch, warningMatch, lines, theme);
	}

	const refMatch = text.match(/(\d+)\s+reference\(s\)/);
	if (refMatch) return referencesView(Number.parseInt(refMatch[1], 10), lines, theme);

	if (/Symbols in (.+):/.test(text)) return symbolsView(lines, theme);

	if (action === "diagnostics" && text.trim() === "OK")
		return { icon: "success", meta: ["no issues"], rows: () => ({ rows: [] }) };
	return genericView(text, lines, theme);
}

// =============================================================================
// Hover Rendering
// =============================================================================

/** Hover: the highlighted signature, framed by any surrounding documentation. */
function hoverView(codeBlockMatch: RegExpMatchArray, fullText: string, theme: Theme): LspResultView {
	const lang = codeBlockMatch[1] || "";
	const codeStart = codeBlockMatch.index ?? 0;
	const beforeCode = fullText.slice(0, codeStart).trim();
	const afterCode = fullText.slice(codeStart + codeBlockMatch[0].length).trim();
	const codeLines = highlightThemeCode(codeBlockMatch[2].trim(), lang, theme);
	const docLines = (doc: string) => (doc ? doc.split("\n").map(line => theme.fg("muted", replaceTabs(line))) : []);

	return {
		icon: "success",
		meta: [],
		rows(expanded) {
			const before = docLines(beforeCode);
			const after = docLines(afterCode);
			if (expanded) return { rows: [...before, ...codeLines, ...after] };
			const hidden = before.length + codeLines.length - 1 + after.length;
			return {
				rows: [codeLines[0] ?? ""],
				more: hidden > 0 ? formatMoreItems(hidden, "line", theme) : undefined,
			};
		},
	};
}

// =============================================================================
// Diagnostics Rendering
// =============================================================================

interface RawDiagnostic {
	raw: string;
}

type DiagnosticItem = ParsedDiagnostic | RawDiagnostic;

function formatDiagnosticMessage(diagnostic: ParsedDiagnostic): string {
	const source = diagnostic.source ? `[${diagnostic.source}] ` : "";
	const code = diagnostic.code ? ` (${diagnostic.code})` : "";
	return `${source}${diagnostic.message}${code}`;
}

function severityToColor(severity: ParsedDiagnostic["severity"]): "error" | "warning" | "accent" | "dim" {
	switch (severity) {
		case "error":
			return "error";
		case "warning":
			return "warning";
		case "info":
			return "accent";
		default:
			return "dim";
	}
}

/** Diagnostics as flush rows: `file:line:col [severity] message`, unverified files first. */
function diagnosticsView(
	errorMatch: RegExpMatchArray | null,
	warningMatch: RegExpMatchArray | null,
	lines: string[],
	theme: Theme,
): LspResultView {
	const errorCount = errorMatch ? Number.parseInt(errorMatch[1], 10) : 0;
	const warnCount = warningMatch ? Number.parseInt(warningMatch[1], 10) : 0;
	const unreportedLines = lines.filter(line => UNREPORTED_LINE_RE.test(line));

	const meta: string[] = [];
	if (errorCount > 0) meta.push(formatCount("error", errorCount));
	if (warnCount > 0) meta.push(formatCount("warning", warnCount));
	if (unreportedLines.length > 0) meta.push(formatCount("unverified file", unreportedLines.length));
	if (meta.length === 0) meta.push("no issues");

	const diagLines = lines.filter(l => l.includes(theme.status.error) || /:\d+:\d+/.test(l));
	const parsedDiagnostics = diagLines
		.map(line => parseDiagnosticMessage(line.trim()))
		.filter((diag): diag is ParsedDiagnostic => diag !== null);
	// Unverified files lead: they are the rows a reader must not miss among diagnostics.
	const items: DiagnosticItem[] = [
		...unreportedLines.map(line => ({ raw: sanitizeDiagnosticDisplayText(line.trim()) })),
		...(parsedDiagnostics.length > 0
			? parsedDiagnostics
			: diagLines.map(line => ({ raw: sanitizeDiagnosticDisplayText(line.trim()) }))),
	];

	const renderItem = (item: DiagnosticItem): string => {
		if ("raw" in item) return theme.fg("warning", item.raw);
		const location = `${formatStyledPath(item.filePath, theme)}${theme.fg("muted", `:${item.line}:${item.col}`)}`;
		const head = `${location} ${theme.fg(severityToColor(item.severity), `[${item.severity}]`)}`;
		const message = formatDiagnosticMessage(item);
		return message ? `${head} ${theme.fg("muted", message)}` : head;
	};

	return {
		// Unverified files are a partial delivery; diagnostics themselves are the result.
		icon: unreportedLines.length > 0 ? "warning" : "success",
		meta,
		rows(expanded) {
			const shown = expanded ? items : items.slice(0, COLLAPSED_DIAGNOSTICS);
			const remaining = items.length - shown.length;
			return {
				rows: shown.map(renderItem),
				more: remaining > 0 ? formatMoreItems(remaining, "diagnostic", theme) : undefined,
			};
		},
	};
}

// =============================================================================
// References Rendering
// =============================================================================

/** References grouped by file: `file (N)` rows with their `line:col` locations as children. */
function referencesView(refCount: number, lines: string[], theme: Theme): LspResultView {
	const byFile = new Map<string, string[]>();
	for (const loc of lines) {
		const match = loc.trim().match(/^(.+):(\d+):(\d+)$/);
		if (!match) continue;
		const [, file, line, col] = match;
		let locs = byFile.get(file);
		if (!locs) {
			locs = [];
			byFile.set(file, locs);
		}
		locs.push(`${line}:${col}`);
	}
	const files = Array.from(byFile.keys());

	return {
		icon: refCount > 0 ? "success" : "warning",
		meta:
			files.length > 0
				? [formatCount("reference", refCount), formatCount("file", files.length)]
				: [formatCount("reference", refCount)],
		rows(expanded) {
			const maxFiles = expanded ? files.length : COLLAPSED_REFERENCE_FILES;
			const maxLocs = expanded ? Number.POSITIVE_INFINITY : COLLAPSED_REFERENCE_LOCATIONS;
			const rows: string[] = [];
			let lastLocMarker = -1;
			for (const file of files.slice(0, maxFiles)) {
				const locs = byFile.get(file)!;
				rows.push(`${formatStyledPath(replaceTabs(file), theme)} ${theme.fg("dim", `(${locs.length})`)}`);
				const shown = locs.slice(0, maxLocs);
				const hiddenLocs = locs.length - shown.length;
				shown.forEach((loc, index) => {
					rows.push(childRow(theme.fg("muted", loc), index === shown.length - 1 && hiddenLocs === 0, theme));
				});
				if (hiddenLocs > 0) {
					lastLocMarker = rows.length;
					rows.push(childRow(theme.fg("dim", formatMoreItems(hiddenLocs, "location", theme)), true, theme));
				}
			}
			return {
				rows,
				more: files.length > maxFiles ? formatMoreItems(files.length - maxFiles, "file", theme) : undefined,
				markerLast: lastLocMarker >= 0 && lastLocMarker === rows.length - 1,
			};
		},
	};
}

// =============================================================================
// Symbols Rendering
// =============================================================================

interface SymbolInfo {
	name: string;
	line: string;
	indent: number;
	icon: string;
}

/** Document symbols: top-level symbols flush, nested symbols as tree children. */
function symbolsView(lines: string[], theme: Theme): LspResultView {
	const symbols: SymbolInfo[] = [];
	for (const line of lines) {
		if (!line.includes("@") || !line.includes("line")) continue;
		const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
		const symMatch = line.trim().match(/^(\S+)\s+(.+?)\s*@\s*line\s*(\d+)/);
		if (symMatch) symbols.push({ icon: symMatch[1], name: symMatch[2], line: symMatch[3], indent });
	}
	const topLevelIndent = symbols.reduce((min, sym) => Math.min(min, sym.indent), Number.POSITIVE_INFINITY);

	// One linear pass each: `isLast[i]` — the next symbol at indent <= mine is
	// not a sibling (monotonic stack, right to left); `prefixes[i]` — per
	// nesting level below the top, the nearest ancestor decides the rail.
	const isLast = Array.from({ length: symbols.length }, () => false);
	const pending: number[] = [];
	for (let i = symbols.length - 1; i >= 0; i--) {
		const myIndent = symbols[i].indent;
		while (pending.length > 0 && symbols[pending[pending.length - 1]].indent > myIndent) pending.pop();
		const next = pending.length > 0 ? pending[pending.length - 1] : -1;
		isLast[i] = next < 0 || symbols[next].indent !== myIndent;
		pending.push(i);
	}
	const prefixes: string[] = [];
	const lastAtIndent = new Map<number, number>();
	for (let i = 0; i < symbols.length; i++) {
		const myIndent = symbols[i].indent;
		let prefix = "";
		if (myIndent > topLevelIndent) {
			// Ancestor rails for levels strictly between the top level and my parent.
			for (let level = topLevelIndent + 2; level < myIndent; level += 2) {
				const ancestorIdx = lastAtIndent.get(level);
				prefix += ancestorIdx !== undefined && isLast[ancestorIdx] ? "   " : `${theme.tree.vertical}  `;
			}
			prefix = `${theme.fg("dim", prefix)}${theme.fg("dim", isLast[i] ? theme.tree.last : theme.tree.branch)} `;
		}
		prefixes.push(prefix);
		lastAtIndent.set(myIndent, i);
	}
	const symbolLabel = (sym: SymbolInfo) =>
		`${theme.fg("accent", sym.icon)} ${theme.fg("accent", sym.name)} ${theme.fg("dim", `line ${sym.line}`)}`;
	const topLevel = symbols.filter(sym => sym.indent === topLevelIndent);

	return {
		icon: symbols.length > 0 ? "success" : "warning",
		meta: [formatCount("symbol", symbols.length)],
		rows(expanded) {
			if (expanded) return { rows: symbols.map((sym, i) => `${prefixes[i]}${symbolLabel(sym)}`) };
			const shown = topLevel.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS);
			const hidden = symbols.length - shown.length;
			return {
				rows: shown.map(symbolLabel),
				more: hidden > 0 ? formatMoreItems(hidden, "symbol", theme) : undefined,
			};
		},
	};
}

// =============================================================================
// Generic Rendering
// =============================================================================

/** Any other response (rename, code actions, status…): its lines, capped while collapsed. */
function genericView(text: string, lines: string[], theme: Theme): LspResultView {
	const hasError = text.includes("Error:") || text.includes(theme.status.error);
	const hasSuccess = text.includes(theme.status.success) || text.includes("Applied");
	const outputLines = lines.filter(line => line.trim().length > 0).map(line => replaceTabs(line));
	return {
		// The call completed; an error reported inside its output, or an empty
		// answer ("No definition found"), needs attention.
		icon: (hasError && !hasSuccess) || /^no\b.*\bfound\b/i.test(text.trim()) ? "warning" : "success",
		meta: [],
		rows(expanded) {
			const shown = expanded ? outputLines : outputLines.slice(0, COLLAPSED_GENERIC_LINES);
			const remaining = outputLines.length - shown.length;
			return {
				rows: shown.map(line => theme.fg("toolOutput", line)),
				more: remaining > 0 ? formatMoreItems(remaining, "line", theme) : undefined,
			};
		},
	};
}

// =============================================================================
// Native (TSP) Description
// =============================================================================

/** The head verb for an LSP action (`type_definition` → `Type definition`). */
function lspActionTitle(action: string | undefined): string {
	if (!action || action === "request") return "LSP";
	const words = action.replace(/_/g, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Native head (§7.3 lsp): the action as the verb; the file (`:line`) as a
 * path target, else the query; then the symbol and option facts, then the
 * result `meta` (a count chip).
 */
function lspNativeHead(
	request: Partial<LspParams> | undefined,
	fallbackAction: string,
	meta: readonly TspText[] = [],
): NativeToolHead {
	const facts: string[] = [];
	const symbol = request?.symbol ? plainText(request.symbol).replaceAll(/\r?\n/g, " ") : undefined;
	let target: string | undefined;
	let targetKind: NativeToolHead["targetKind"];
	if (request?.file) {
		target = request.line !== undefined ? `${shortenPath(request.file)}:${request.line}` : shortenPath(request.file);
		targetKind = "path";
	} else if (request?.query) {
		target = request.query;
		targetKind = "query";
	} else if (request?.line !== undefined) {
		facts.push(`line ${request.line}`);
	}
	if (symbol) facts.push(symbol);
	if (request?.query && target !== request.query) facts.push(`query:${request.query}`);
	if (request?.new_name) facts.push(`\u2192 ${request.new_name}`);
	if (request?.apply !== undefined) facts.push(`apply:${request.apply ? "true" : "false"}`);
	return {
		title: lspActionTitle(request?.action ?? fallbackAction),
		target,
		targetKind,
		href: request?.file ? fileHref(request.file) : undefined,
		meta: [...(facts.length > 0 ? [plainText(facts.join(" \u00b7 "))] : []), ...meta],
	};
}

/** A diagnostics response, parsed: diagnostics, server failures and partial-failure warnings. */
interface LspDiagnosticsParse {
	diagnostics: ParsedDiagnostic[];
	failures: string[];
	warnings: string[];
	/** Files a server sent no report for in time: unverified, never "No issues". */
	unreported: string[];
	/** Lines neither a diagnostic nor a status line (kept verbatim). */
	other: string[];
}

const DIAGNOSTIC_AT_RE = /^\d+:\d+\s+\[/;
const DIAGNOSTICS_SUMMARY_RE = /^\d+ \w+\(s\)(?:, \d+ \w+\(s\))*:?$/;
/** A per-file status line's leading status glyph (`✘`, `⚠`, a Nerd Font glyph, ASCII `[-]`). */
const STATUS_GLYPH_RE = /^(?:\[[^\]\s]*\]|[^\p{L}\p{N}\s./~\\]+)\s+/u;
/** Per-file summaries (`✗ a.ts: 2 error(s)`, `✓ a.ts: no issues`) repeat what the rows and head count. */
const FILE_SUMMARY_RE = /: (?:no issues|\d+ \w+\(s\)(?:, \d+ \w+\(s\))*)$/;

/**
 * Parse a diagnostics response: grouped (`# dir/`, `## file`, `  12:5 [error] …`)
 * or flat (`file:12:5 [error] …`) diagnostic lines, and the per-file status
 * lines (`✗ file: all language servers failed (…)`, `⚠ …some servers failed`,
 * `⚠ file: no diagnostics report yet from …`, `✓ file: no issues`, `✗ file: 2 error(s)`).
 */
function parseLspDiagnostics(lines: readonly string[]): LspDiagnosticsParse {
	const out: LspDiagnosticsParse = { diagnostics: [], failures: [], warnings: [], unreported: [], other: [] };
	let file: string | undefined;
	for (const event of walkGroupedOutput(lines)) {
		if (event.kind !== "line") {
			file = event.kind === "file" ? event.path : undefined;
			continue;
		}
		const line = event.text.trim();
		if (line === "OK" || DIAGNOSTICS_SUMMARY_RE.test(line)) continue;
		// Matched by wording, not glyph: a transcript may outlive the theme that wrote it.
		if (/\ball language servers failed\b/.test(line)) {
			out.failures.push(line.replace(STATUS_GLYPH_RE, ""));
			continue;
		}
		if (/\bsome servers failed\b/.test(line)) {
			out.warnings.push(line.replace(STATUS_GLYPH_RE, ""));
			continue;
		}
		if (UNREPORTED_LINE_RE.test(line)) {
			out.unreported.push(line.replace(STATUS_GLYPH_RE, ""));
			continue;
		}
		if (FILE_SUMMARY_RE.test(line)) continue;
		const parsed = parseDiagnosticMessage(file && DIAGNOSTIC_AT_RE.test(line) ? `${file}:${line}` : line);
		if (parsed) out.diagnostics.push(parsed);
		else out.other.push(line);
	}
	return out;
}

/** `2 errors · 1 warning` in the severity tones, or undefined when there are none. */
function diagnosticCounts(diagnostics: readonly ParsedDiagnostic[]): TspSpan[] | undefined {
	const counts: Record<ParsedDiagnostic["severity"], number> = { error: 0, warning: 0, info: 0, hint: 0 };
	for (const d of diagnostics) counts[d.severity]++;
	const spans: TspSpan[] = [];
	for (const severity of ["error", "warning", "info", "hint"] as const) {
		const n = counts[severity];
		if (!n) continue;
		if (spans.length > 0) spans.push(span(" \u00b7 ", "dim"));
		spans.push(span(formatCount(severity, n), severityTone(severity)));
	}
	return spans.length > 0 ? spans : undefined;
}

function severityTone(severity: ParsedDiagnostic["severity"]): TspTone {
	switch (severity) {
		case "error":
			return "error";
		case "warning":
			return "warning";
		case "info":
			return "info";
		default:
			return "muted";
	}
}

/** One diagnostic row (role `omp.tool.diagnostic`): severity icon, mono `file:line:col`, source chip, message. */
function diagnosticRow(diag: ParsedDiagnostic, key: string): NativeNode {
	const message: TspSpan[] = [span(diag.message)];
	if (diag.code) message.push(span(` ${diag.code}`, "muted"));
	return keyed(
		row(
			compact([
				diagnosticGlyph(diag.severity),
				text([span(`${diag.filePath}:${diag.line}:${diag.col}`, "mono muted")], { wrap: "none" }),
				diag.source ? node("badge", { text: diag.source }) : undefined,
				text(message, { wrap: "word", grow: 1 }),
			]),
			{ role: "omp.tool.diagnostic" },
		),
		key,
	);
}

/** A server failure / partial-failure row: the status icon and the message, in its tone. */
function statusRow(message: string, tone: "error" | "warning", key: string): NativeNode {
	return keyed(
		row([diagnosticGlyph(tone), text([span(plainText(message), tone)], { wrap: "word", grow: 1 })], {
			role: tone === "error" ? "omp.tool.error" : "omp.tool.diagnostic",
		}),
		key,
	);
}

/**
 * Diagnostics view: a card when there are diagnostics, failures or unverified files
 * (rows of severity icon · `file:line:col` · source · message), an inline `No issues`
 * otherwise. A failed server or a missing report is a row, never "No issues".
 */
function describeLspDiagnostics(request: Partial<LspParams> | undefined, fallbackAction: string, lines: string[]) {
	const parsed = parseLspDiagnostics(lines);
	const counts = diagnosticCounts(parsed.diagnostics);
	const failed =
		parsed.failures.length > 0 ? [span(formatCount("server failure", parsed.failures.length), "error")] : undefined;
	const unverified =
		parsed.unreported.length > 0
			? [span(formatCount("unverified file", parsed.unreported.length), "warning")]
			: undefined;
	const rows: NativeNode[] = [
		...parsed.failures.map((message, i) => statusRow(message, "error", `x${i}`)),
		...parsed.unreported.map((message, i) => statusRow(message, "warning", `u${i}`)),
		...parsed.diagnostics.map((diag, i) => diagnosticRow(diag, `d${i}`)),
		...parsed.warnings.map((message, i) => statusRow(message, "warning", `w${i}`)),
	];
	if (parsed.other.length > 0) rows.push(keyed(code(parsed.other.join("\n"), { wrap: true }), "other"));
	const hasErrors = parsed.failures.length > 0 || parsed.diagnostics.some(d => d.severity === "error");
	const meta = compact<TspText>([counts, failed, unverified, !counts && !failed && !unverified && "No issues"]);
	const head = lspNativeHead(request, fallbackAction, meta);
	if (parsed.diagnostics.length === 0 && parsed.failures.length === 0 && parsed.unreported.length === 0) {
		return { tool: head, inline: true, body: rows.length > 0 ? rows : undefined } satisfies NativeToolView;
	}
	return {
		tool: head,
		tone: hasErrors ? "error" : "warning",
		body: rows,
		preview: { lines: 8 },
	} satisfies NativeToolView;
}

/** References grouped by file (§7.3): a file row with the count, then the `line:col` positions. */
function describeLspReferences(lines: string[]): NativeNode[] {
	const byFile = new Map<string, string[]>();
	for (const loc of lines) {
		const match = loc.trim().match(/^(.+):(\d+):(\d+)$/);
		if (!match) continue;
		const [, file, line, col] = match;
		let locs = byFile.get(file);
		if (!locs) {
			locs = [];
			byFile.set(file, locs);
		}
		locs.push(`${line}:${col}`);
	}
	const nodes: NativeNode[] = [];
	for (const [file, locs] of byFile) {
		const name = plainText(file);
		nodes.push(
			keyed(
				col(
					[
						fileRow(name, { chip: { text: String(locs.length), title: formatCount("reference", locs.length) } }),
						text([span(locs.join("  "), "mono muted")], { wrap: "word" }),
					],
					{ gap: "xs" },
				),
				name,
			),
		);
	}
	return nodes;
}

function describeLspSymbols(lines: string[]): NativeNode | undefined {
	const roots: TspTreeNode[] = [];
	const stack: { indent: number; children: TspTreeNode[] }[] = [];
	let index = 0;
	for (const line of lines) {
		if (!line.includes("@") || !line.includes("line")) continue;
		const symMatch = line.trim().match(/^(\S+)\s+(.+?)\s*@\s*line\s*(\d+)/);
		if (!symMatch) continue;
		const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
		const children: TspTreeNode[] = [];
		const treeNode: TspTreeNode = {
			id: `${index++}`,
			label: [
				span(plainText(symMatch[1]), "accent"),
				span(" "),
				span(plainText(symMatch[2]), "accent"),
				span(` line ${symMatch[3]}`, "muted"),
			],
			open: true,
			children,
		};
		while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
		(stack[stack.length - 1]?.children ?? roots).push(treeNode);
		stack.push({ indent, children });
	}
	return roots.length > 0 ? node("tree", { nodes: roots }) : undefined;
}

function describeLspResult(result: ToolRenderResult<LspToolDetails>, args: LspParams | undefined): NativeToolView {
	const request = args ?? result.details?.request;
	const fallbackAction = result.details?.action ?? "request";
	const content = result.content?.[0];
	const text = content?.type === "text" ? (content.text ?? "") : "";
	if (result.isError) return inlineErrorView(lspNativeHead(request, fallbackAction), text || "LSP request failed");
	if (!text) return { tool: lspNativeHead(request, fallbackAction, ["No result"]), tone: "warning", inline: true };

	const lines = text.split("\n");
	const statusError = activeThemeSymbol("status.error");
	const refMatch = text.match(/(\d+)\s+reference\(s\)/);
	const symbolsMatch = text.match(/Symbols in (.+):/);

	if (/```(\w*)\n([\s\S]*?)```/.test(text)) {
		return { tool: lspNativeHead(request, fallbackAction), inline: true, body: [md(text)], preview: { lines: 4 } };
	}
	if (
		/\d+\s+(?:error|warning)\(s\)/.test(text) ||
		text.includes(statusError) ||
		(request?.action ?? fallbackAction) === "diagnostics"
	) {
		return describeLspDiagnostics(request, fallbackAction, lines);
	}
	if (refMatch) {
		const refCount = Number.parseInt(refMatch[1], 10);
		const body = describeLspReferences(lines);
		return {
			tool: lspNativeHead(request, fallbackAction, [formatCount("reference", refCount)]),
			tone: refCount > 0 ? undefined : "warning",
			inline: true,
			body: body.length > 0 ? body : undefined,
			preview: { lines: 8 },
		};
	}
	if (symbolsMatch) {
		const body = describeLspSymbols(lines);
		return {
			tool: lspNativeHead(request, fallbackAction, [`in ${symbolsMatch[1]}`]),
			inline: true,
			body: body ? [body] : undefined,
			preview: { lines: 8 },
		};
	}
	const hasError = text.includes("Error:") || text.includes(statusError);
	const hasSuccess = text.includes(activeThemeSymbol("status.success")) || text.includes("Applied");
	return {
		tool: lspNativeHead(request, fallbackAction),
		tone: hasError && !hasSuccess ? "error" : undefined,
		inline: true,
		body: [ansi(text)],
		preview: { lines: 4 },
	};
}

const lspResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Render LSP requests and responses in the transcript. */
export const lspToolRenderer = {
	renderCall,
	renderResult,
	describeCall(args: LspParams): NativeToolView {
		return { tool: lspNativeHead(args, "request"), inline: true };
	},
	describeResult(
		result: ToolRenderResult<LspToolDetails>,
		_options: RenderResultOptions,
		args?: LspParams,
	): NativeToolView | undefined {
		return lspResultMemo.get(result, [], () => describeLspResult(result, args));
	},
	mergeCallAndResult: true,
	inline: true,
} satisfies ToolRenderer<LspParams, LspToolDetails>;
