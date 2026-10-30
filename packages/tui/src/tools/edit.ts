/**
 * Edit tool renderer.
 */

import { type EditInspection, editInspect } from "@oh-my-pi/pi-natives";
import type { Component } from "../tui";
import { sliceWithWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { NativeToolHead, NativeToolView, RenderResultOptions, ToolRenderer } from "./renderer";
import { code, compact, node, span } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import {
	diagnosticsBadge,
	diagnosticsSection,
	diffStatsMeta,
	displayPath,
	errorText,
	fileDiffSection,
	fileHref,
	noteText,
	resultText,
} from "./native-view";
import type { FileDiagnosticsResult } from "./lsp";
import { nativeDiff, renderDiff as renderDiffColored } from "../chrome/diff";
import { getLanguageFromPath } from "../lang-from-path";
import { type Theme, theme as activeTheme } from "../theme/theme";
import type { OutputMeta } from "./output-meta";
import {
	cachedRenderedString,
	cappedHeadLines,
	createRenderedStringCache,
	formatCount,
	formatDiagnostics,
	formatErrorText,
	formatExpandHint,
	formatMoreItems,
	getDiffStats,
	invalidateRenderedStringCache,
	PREVIEW_LIMITS,
	previewWindowRows,
	releaseRenderedStringCache,
	type RenderedStringCache,
	replaceTabs,
	shortenPath,
	type ToolUIStatus,
	truncateDiffByHunk,
} from "../render/render-utils";
import type { ToolActivityContext, ToolActivitySummary } from "./renderer";
import { fileHyperlink, renderStatusLine, truncateToWidth } from "../render";
import type { StatusLineOptions } from "../render/status-line";
import { framedToolCard, plainToolCard, type ToolCardSection } from "../render/tool-card";
import { HL_FILE_PREFIX, HL_FILE_SUFFIX, HL_MOVE_KEYWORD, HL_REM_KEYWORD } from "./hashline-format";

/** Edit payload syntax selected by the caller. */
export type EditMode = "replace" | "patch" | "hashline" | "apply_patch" | "sloppy";

// ═══════════════════════════════════════════════════════════════════════════
// Tool Details Types
// ═══════════════════════════════════════════════════════════════════════════

/** Filesystem operation represented by an edit. */
export type Operation = "create" | "delete" | "update";

/** Computed streaming diff or preview error for one file. */
export interface PerFileDiffPreview {
	path: string;
	diff?: string;
	firstChangedLine?: number;
	error?: string;
}

type EditDiffPreview =
	| { diff: string; firstChangedLine?: number }
	| { error: string; diff?: undefined; firstChangedLine?: undefined };

/** Result metadata for one edited file. */
export interface EditToolPerFileResult {
	path: string;
	diff: string;
	firstChangedLine?: number;
	diagnostics?: FileDiagnosticsResult;
	op?: Operation;
	move?: string;
	isError?: boolean;
	errorText?: string;
	/** TUI-friendly error text. When present, rendered to the user instead of `errorText`.
	 * Set when the underlying error carries a `displayMessage` (e.g. {@link HashlineMismatchError}). */
	displayErrorText?: string;
	meta?: OutputMeta;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
	/** True when {@link pruneOversizedEditSnapshots} dropped `oldText`/`newText` from this entry. Aggregators check this to suppress misleading combined snapshots when at least one entry of a multi-entry single-path edit was pruned. */
	snapshotsPruned?: boolean;
	/** Pre-move source path; set only when the edit moved/renamed the file. The header renders `sourcePath → path`. */
	sourcePath?: string;
}

/** Diff, diagnostics, and snapshots returned by an edit. */
export interface EditToolDetails {
	/** Unified diff of the changes made; empty when the edit failed */
	diff: string;
	/** Why the edit failed, as the engine classed it (`unseen_lines`, `stale_tag`, `parse`, …) */
	errorKind?: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** Diagnostic result (if available) */
	diagnostics?: FileDiagnosticsResult;
	/** Operation type (patch mode only) */
	op?: Operation;
	/** New path after move/rename (patch mode only) */
	move?: string;
	/** Structured output metadata */
	meta?: OutputMeta;
	/** Per-file results (multi-file edits) */
	perFileResults?: EditToolPerFileResult[];
	/** Absolute file path for single-file edit results. Required by ACP diff metadata consumers. */
	path?: string;
	/** Source-of-truth content before the edit; `undefined` for create operations. */
	oldText?: string;
	/** Source-of-truth content after the edit; `undefined` for delete operations. */
	newText?: string;
	/** True when {@link pruneOversizedEditSnapshots} dropped `oldText`/`newText` from this entry. Aggregators check this to suppress misleading combined snapshots when at least one entry of a multi-entry single-path edit was pruned. */
	snapshotsPruned?: boolean;
	/** Pre-move source path; set only when the edit moved/renamed the file. The header renders `sourcePath → path`. */
	sourcePath?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// TUI Renderer
// ═══════════════════════════════════════════════════════════════════════════

/** Memoized native inspection of the streamed payload, tagged onto the args it came from. */
const kInspectedInput = Symbol("edit.inspectedInput");

type InspectedInput = { mode: EditMode; input: string } & (
	| { entries: InspectedInputEntry[]; error?: undefined }
	| { entries?: undefined; error: unknown }
);

interface EditRenderArgs {
	path?: unknown;
	file_path?: unknown;
	oldText?: string;
	newText?: string;
	patch?: string;
	input?: string;
	_input?: string;
	replace_all?: boolean;
	// Patch mode fields
	op?: Operation;
	rename?: unknown;
	diff?: string;
	/**
	 * Computed preview diff (used when tool args don't include a diff, e.g. hashline mode).
	 */
	previewDiff?: string;
	__partialJson?: string;
	// Hashline mode fields
	edits?: EditRenderEntry[];
	[kInspectedInput]?: InspectedInput;
}

type EditRenderEntry = {
	path?: unknown;
	rename?: unknown;
	move?: unknown;
	op?: Operation;
};

interface HashlineInputEntry {
	path: string;
	op?: Operation;
	rename?: string;
}

interface HashlineInputRenderSummary {
	entries: HashlineInputEntry[];
}

interface InspectedInputEntry {
	path: string;
	op?: Operation;
	rename?: string;
}

interface ApplyPatchRenderSummary {
	entries: InspectedInputEntry[];
	error?: string;
}

/** Extended context for edit tool rendering */
export interface EditRenderContext {
	/** Edit mode resolved by the caller; lets the renderer dispatch without shape-sniffing */
	editMode?: EditMode;
	/** Pre-computed diff preview (computed before tool executes) */
	editDiffPreview?: EditDiffPreview;
	/** Multi-file streaming diff preview (edits spanning several files) */
	perFileDiffPreview?: PerFileDiffPreview[];
	/** Raw in-flight edit text shown while a computed diff preview is unavailable */
	editStreamingFallback?: string;
	/** Function to render diff text with syntax highlighting */
	renderDiff?: (diffText: string, options?: { filePath?: string }) => string;
	/** Unsanitized result metadata, used only for filesystem link targets. */
	rawDetails?: unknown;
}

const CALL_TEXT_PREVIEW_LINES = 6;
const CALL_TEXT_PREVIEW_WIDTH = 80;

/** Render replacement text until a computed diff preview is available. */
export function renderStreamingFallback(editMode: EditMode, args: unknown, theme: Theme): string {
	if (editMode !== "replace" || !args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const newString =
		typeof record.new_string === "string"
			? record.new_string
			: typeof record.newText === "string"
				? record.newText
				: undefined;
	if (!newString) return "";
	const preview = plainTextPreview(newString, theme);
	if (preview.hidden > 0) preview.lines.push(theme.fg("dim", formatMoreItems(preview.hidden, "line", theme)));
	return preview.lines.join("\n");
}

/** Extract file path from an edit entry. */
function filePathFromEditEntry(p: unknown): string | undefined {
	if (typeof p !== "string") {
		return undefined;
	}
	return p;
}

function decodePartialJsonStringFragment(fragment: string): string {
	// Trim a trailing partial escape so JSON.parse sees a well-formed string.
	let text = fragment.replace(/\\u[0-9a-fA-F]{0,3}$/, "");
	const trailingBackslashes = text.match(/\\+$/)?.[0].length ?? 0;
	if (trailingBackslashes % 2 === 1) text = text.slice(0, -1);
	try {
		return JSON.parse(`"${text}"`) as string;
	} catch {
		// Streaming fragment isn't a valid JSON string yet; surface it raw rather
		// than ad-hoc unescaping that mishandles surrogates and partial escapes.
		return text;
	}
}

// `"path": "<possibly unterminated string>` in a raw streamed args buffer.
const PARTIAL_JSON_PATH_RE = /"path"\s*:\s*"((?:\\.|[^"\\])*)/u;

function getPartialJsonEditPath(args: EditRenderArgs): string | undefined {
	const partialJson = args.__partialJson;
	if (!partialJson) return undefined;
	const match = PARTIAL_JSON_PATH_RE.exec(partialJson);
	return match ? decodePartialJsonStringFragment(match[1]!) : undefined;
}

/** Count distinct file paths in an edits array. */
function countEditFiles(edits: EditRenderEntry[]): number {
	return new Set(edits.map(edit => filePathFromEditEntry(edit.path)).filter(Boolean)).size;
}

/** Card title for an operation: a rename is a Move, whatever line edits ride along. */
function getOperationTitle(op: Operation | undefined, rename?: string): string {
	if (op === "create") return "Create";
	if (op === "delete") return "Delete";
	return rename ? "Move" : "Edit";
}

function truncateEditTitlePath(displayPath: string, maxWidth: number | undefined, ellipsis: string): string {
	if (maxWidth === undefined) return displayPath;
	const width = visibleWidth(displayPath);
	const safeMaxWidth = Math.max(0, Math.floor(maxWidth));
	if (width <= safeMaxWidth) return displayPath;

	const contentWidth = safeMaxWidth - visibleWidth(ellipsis);
	if (contentWidth <= 0) return ellipsis;

	const headWidth = Math.floor(contentWidth / 2);
	const tailWidth = contentWidth - headWidth;
	const head = sliceWithWidth(displayPath, 0, headWidth, true).text;
	const tail = sliceWithWidth(displayPath, Math.max(0, width - tailWidth), tailWidth, true).text;
	return `${head}${ellipsis}${tail}`;
}

function formatEditTitlePath(pathValue: string, uiTheme: Theme, maxWidth?: number): string {
	return truncateEditTitlePath(replaceTabs(shortenPath(sanitizeText(pathValue))), maxWidth, uiTheme.format.ellipsis);
}

/** Facts behind an edit card's status line, identical across the call and result states. */
interface EditHeaderOptions {
	icon: ToolUIStatus;
	op?: Operation;
	rawPath: string;
	rename?: string;
	firstChangedLine?: number;
	/** Absolute link target for `rawPath`; a relative `rawPath` would link against the filesystem root. */
	linkPath?: string;
	renameLinkPath?: string;
}

/** `path` or `source -> destination`, each path linked and middle-truncated to `maxPathWidth`. */
function formatEditSubject(options: EditHeaderOptions, uiTheme: Theme, maxPathWidth?: number): string {
	if (!options.rawPath) return uiTheme.format.ellipsis;
	const lineLink = options.firstChangedLine ? { line: options.firstChangedLine } : undefined;
	let subject = fileHyperlink(
		options.linkPath || options.rawPath,
		formatEditTitlePath(options.rawPath, uiTheme, maxPathWidth),
		lineLink,
	);
	if (options.rename) {
		const rename = formatEditTitlePath(options.rename, uiTheme, maxPathWidth);
		subject += ` ${uiTheme.format.arrowRight} ${fileHyperlink(options.renameLinkPath || options.rename, rename)}`;
	}
	return subject;
}

/**
 * The status line of every edit card state. Paths are middle-truncated, the
 * width split evenly between source and destination, so the row fits `budget`.
 */
function editStatus(options: EditHeaderOptions, budget: number, uiTheme: Theme): StatusLineOptions {
	const title = getOperationTitle(options.op, options.rename);
	const status: StatusLineOptions = {
		icon: options.icon,
		title,
		description: formatEditSubject(options, uiTheme),
	};
	const overflow = visibleWidth(renderStatusLine(status, uiTheme)) - budget;
	if (overflow <= 0 || !options.rawPath) return status;
	let pathWidth = visibleWidth(formatEditTitlePath(options.rawPath, uiTheme));
	if (options.rename) pathWidth += visibleWidth(formatEditTitlePath(options.rename, uiTheme));
	const fittedPathWidth = Math.max(1, Math.floor((pathWidth - overflow) / (options.rename ? 2 : 1)));
	return { ...status, description: formatEditSubject(options, uiTheme, fittedPathWidth) };
}

/** Columns a framed card's top border leaves for its status line. */
function framedHeaderBudget(width: number, uiTheme: Theme): number {
	const leftGlyphs = `${uiTheme.boxRound.topLeft}${uiTheme.boxRound.horizontal.repeat(3)}`;
	return Math.max(0, width - visibleWidth(leftGlyphs) - visibleWidth(uiTheme.boxRound.topRight) - 2);
}

/** Error body rows: the first line through `formatErrorText`, continuation lines (code frames) kept verbatim. */
export function formatErrorRows(message: string, uiTheme: Theme): string[] {
	const [first, ...rest] = message.trimEnd().split("\n");
	return [formatErrorText(first, uiTheme), ...rest.map(line => uiTheme.fg("error", replaceTabs(line)))];
}

/** Dim bottom-border facts joined by the theme separator; undefined when there are none. */
function joinFooterMeta(parts: readonly (string | undefined)[], uiTheme: Theme): string | undefined {
	const present = parts.filter((part): part is string => !!part);
	return present.length > 0 ? uiTheme.fg("dim", present.join(uiTheme.sep.dot)) : undefined;
}

/**
 * Whether a streaming single-file call has a content block to frame: a diff
 * preview, raw diff/replacement text, or the caller's streaming fallback.
 * Without one the call is a flush status line.
 */
function hasCallPreview(args: EditRenderArgs, renderContext: EditRenderContext | undefined): boolean {
	return Boolean(args.previewDiff || args.diff || args.newText || args.patch || renderContext?.editStreamingFallback);
}

/**
 * Head-window preview of streamed replacement text. Only the displayed head is
 * sanitized and split; the hidden-line count comes from a raw newline scan.
 * That matches sanitizing the whole text because, on ESC-free input,
 * `sanitizeText` only deletes individual code units and never a `\n`: the
 * cut sits on a `\n`, so it cannot split a surrogate pair. The one non-local
 * rule — a lone surrogate anywhere drops every U+FFFD — is replayed on the
 * head. ESC-bearing text (ANSI stripping can span lines) takes the full path.
 */
function plainTextPreview(text: string, uiTheme: Theme): { lines: string[]; hidden: number } {
	let previewLines: { lines: readonly string[]; hidden: number };
	let headEnd = -1;
	if (!text.includes("\x1b")) {
		for (let newlines = 0; newlines < CALL_TEXT_PREVIEW_LINES; newlines++) {
			headEnd = text.indexOf("\n", headEnd + 1);
			if (headEnd === -1) break;
		}
	}
	if (headEnd === -1) {
		previewLines = cappedHeadLines(sanitizeText(text).split("\n"), CALL_TEXT_PREVIEW_LINES);
	} else {
		let head = sanitizeText(text.slice(0, headEnd));
		if (head.includes("\ufffd") && !text.isWellFormed()) head = head.replaceAll("\ufffd", "");
		let hidden = 1;
		for (let i = text.indexOf("\n", headEnd + 1); i !== -1; i = text.indexOf("\n", i + 1)) hidden++;
		previewLines = { lines: head.split("\n"), hidden };
	}
	const lines = previewLines.lines.map(line =>
		uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(line), CALL_TEXT_PREVIEW_WIDTH)),
	);
	while (lines.length > 0 && Bun.stripANSI(lines[lines.length - 1]!).trim() === "") lines.pop();
	return { lines, hidden: previewLines.hidden };
}

interface StreamingDiffTail {
	content: string;
	/** Physical lines before the window. */
	hiddenLines: number;
}

/**
 * Visual rows a raw diff line occupies once `renderDiff` gives it a code-frame
 * gutter and `wrapEditRendererLine` hangs its continuations beneath it.
 * Canonical `+12|` rows render a padded `max(3, digits) + 1` gutter plus `│`;
 * rows already carrying a `│` rail keep their own prefix. Content wraps at the
 * width left after that gutter; unnumbered rows wrap whole.
 */
function streamingDiffLineRows(rawLine: string, innerWidth: number): number {
	const numbered = /^([+\-\s]\s*(\d+)[|│])(.*)$/s.exec(rawLine) ?? /^([+\-\s]\s*(\d+)\s)(.*)$/s.exec(rawLine);
	if (!numbered) return Math.max(1, wrapTextWithAnsi(replaceTabs(rawLine), innerWidth).length);
	const gutterWidth = Math.max(visibleWidth(numbered[1]!), Math.max(3, numbered[2]!.length) + 2);
	const contentWidth = Math.max(1, innerWidth - gutterWidth);
	return Math.max(1, wrapTextWithAnsi(replaceTabs(numbered[3] ?? ""), contentWidth).length);
}

/**
 * Select the trailing physical lines that fit the live preview budget.
 *
 * Walk backward from the end instead of splitting the complete diff. This keeps
 * allocation proportional to the visible suffix; the hidden prefix is only
 * scanned for its newline count. One physical line may exceed the budget, but
 * it is still kept so the newest change is visible.
 */
function sliceStreamingDiffTail(diff: string, innerWidth: number, budget: number): StreamingDiffTail {
	let end = diff.length;
	while (end > 0 && diff.charCodeAt(end - 1) === 10) end--;
	if (end === 0) return { content: "", hiddenLines: 0 };

	const rowLimit = Math.max(1, budget);
	let start = end;
	let cursor = end;
	let visualRows = 0;
	while (cursor >= 0) {
		const newline = cursor > 0 ? diff.lastIndexOf("\n", cursor - 1) : -1;
		const lineStart = newline + 1;
		const lineRows = streamingDiffLineRows(diff.slice(lineStart, cursor), innerWidth);
		if (visualRows > 0 && visualRows + lineRows > rowLimit) break;
		visualRows += lineRows;
		start = lineStart;
		if (newline < 0) break;
		cursor = newline;
	}

	let hiddenLines = 0;
	for (let index = diff.indexOf("\n"); index !== -1 && index < start; index = diff.indexOf("\n", index + 1)) {
		hiddenLines++;
	}
	return { content: diff.slice(start, end), hiddenLines };
}

/**
 * Rows of a streamed diff, clamped to a tail window. A tall or fast-growing
 * diff must not outgrow the live window: its mutating rows would scroll above
 * the native-scrollback commit boundary mid-stream and freeze into immutable
 * history as a stale preview snapshot, and the finalize repair would recommit
 * the final render below it — a duplicated block on the tape. Collapsed gets a
 * short fixed tail; expanded widens it to the viewport-sized window, never
 * unbounded. The budget is VISUAL rows (a long wrapped line counts for more
 * than one) at the frame's inner width; only the visible suffix is
 * syntax-colored, so the cheap raw-line wrap walk keeps the per-chunk cost
 * bounded. innerWidth/budget are in the cache salt so a resize re-slices.
 */
function formatStreamingDiff(
	diff: string,
	rawPath: string,
	innerWidth: number,
	uiTheme: Theme,
	expanded: boolean,
	cache?: RenderedStringCache,
): string[] {
	if (!diff) return [];
	const windowRows = previewWindowRows();
	const budget = expanded ? windowRows : Math.min(PREVIEW_LIMITS.EXPANDED_LINES, windowRows);
	// Ctrl+O widens the tail only when the window is taller than the collapsed budget.
	const widens = !expanded && windowRows > budget;
	const key = `${rawPath}:${innerWidth}:${budget}:${widens}`;
	const text = cachedRenderedString(cache, uiTheme, expanded, key, diff, () => {
		// "Cursor" tail window: pin the last rows to the bottom so freshly streamed
		// changes stay on screen. The whole-file diff is recomputed every chunk and
		// its Myers alignment is not monotonic in payload length, so a hunk-aware
		// window stutters as rows move between hunks. Expanded widens the window
		// to the viewport; the full diff appears once the result finalizes.
		const tail = sliceStreamingDiffTail(diff, innerWidth, budget);
		const rendered = renderDiffColored(tail.content, { filePath: rawPath, theme: uiTheme });
		if (tail.hiddenLines === 0) return rendered;
		const marker = uiTheme.fg("dim", formatMoreItems(tail.hiddenLines, "line", uiTheme, "earlier"));
		const hint = widens ? formatExpandHint(uiTheme) : "";
		return `${hint ? `${marker} ${hint}` : marker}\n${rendered}`;
	});
	return text.split("\n");
}

/** A streamed call's framed body: content rows plus its bottom-border facts. */
interface CallPreview {
	lines: string[];
	/** Liveness cue (`preview` / `streaming`) or the hidden-line marker. */
	footer?: string;
}

function getCallPreview(
	args: EditRenderArgs,
	rawPath: string,
	innerWidth: number,
	uiTheme: Theme,
	renderContext: EditRenderContext | undefined,
	expanded: boolean,
	cache?: RenderedStringCache,
): CallPreview {
	if (args.previewDiff) {
		// Expanded approval previews hide the "preview" cue (#1992).
		return {
			lines: formatStreamingDiff(args.previewDiff, rawPath, innerWidth, uiTheme, expanded, cache),
			footer: expanded ? undefined : "preview",
		};
	}
	if (args.diff && args.op) {
		return {
			lines: formatStreamingDiff(args.diff, rawPath, innerWidth, uiTheme, expanded, cache),
			footer: "streaming",
		};
	}
	const text = args.diff || args.newText || args.patch;
	if (text) {
		const preview = plainTextPreview(text, uiTheme);
		return {
			lines: preview.lines,
			footer: preview.hidden > 0 ? formatMoreItems(preview.hidden, "line", uiTheme) : undefined,
		};
	}
	if (renderContext?.editStreamingFallback) {
		return { lines: renderContext.editStreamingFallback.split("\n") };
	}
	return { lines: [] };
}

const MISSING_APPLY_PATCH_END_ERROR = "The last line of the patch must be '*** End Patch'";

function normalizeHashlineInputPreviewPath(rawPath: string): string {
	const trimmed = rawPath.trim();
	const hashStart = /#[0-9a-fA-F]{4}$/u.exec(trimmed)?.index;
	const withoutHash = hashStart === undefined ? trimmed : trimmed.slice(0, hashStart);
	if (withoutHash.length < 2) return withoutHash;
	const first = withoutHash[0];
	const last = withoutHash[withoutHash.length - 1];
	if ((first === '"' || first === "'") && first === last) {
		return withoutHash.slice(1, -1);
	}
	return withoutHash;
}

function parseHashlineInputPreviewHeader(line: string): string | null {
	const trimmed = line.trimEnd();
	if (!trimmed.startsWith(HL_FILE_PREFIX)) return null;
	// Keep streaming previews tolerant while the closing bracket is still
	// being generated; the parser enforces the final `[path#TAG]` shape.
	const bodyEnd = trimmed.endsWith(HL_FILE_SUFFIX) ? trimmed.length - HL_FILE_SUFFIX.length : trimmed.length;
	const body = trimmed.slice(HL_FILE_PREFIX.length, bodyEnd).trim();
	const previewPath = normalizeHashlineInputPreviewPath(body);
	return previewPath.length > 0 ? previewPath : null;
}

/**
 * Walk a (possibly mid-stream) hashline payload into per-section descriptors:
 * the target path plus any file-level op (`REM` → delete, `MV dest` → rename).
 * Tolerant of partial input so the call preview can label a delete/move before
 * the payload finishes streaming.
 */
function getHashlineInputSections(input: string): HashlineInputEntry[] {
	const stripped = input.startsWith("\uFEFF") ? input.slice(1) : input;
	const entries: HashlineInputEntry[] = [];
	let current: HashlineInputEntry | undefined;
	for (const rawLine of stripped.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		const headerPath = parseHashlineInputPreviewHeader(line);
		if (headerPath) {
			current = { path: headerPath };
			entries.push(current);
			continue;
		}
		if (!current) continue;
		const trimmed = line.trim();
		if (trimmed === HL_REM_KEYWORD) {
			current.op = "delete";
		} else if (trimmed.startsWith(`${HL_MOVE_KEYWORD} `)) {
			current.rename = normalizeHashlineInputPreviewPath(trimmed.slice(HL_MOVE_KEYWORD.length + 1));
		}
	}
	return entries;
}

/** Extract display targets using the existing parsers for supported freeform edit modes. */
export function getEditInputPaths(input: string, resolvedMode?: EditMode): readonly string[] {
	const mode =
		resolvedMode ??
		(/^\*\*\* (?:Add|Update|Delete) File:/m.test(input)
			? "apply_patch"
			: /^[ \t]*\*{3}[ \t]+Edit[ \t]+File:/im.test(input)
				? "sloppy"
				: undefined);
	try {
		const entries =
			mode && mode !== "hashline" ? inspectInputEntries({}, mode, input) : getHashlineInputSections(input);
		const paths: string[] = [];
		for (const entry of entries) {
			if (entry.path) paths.push(entry.path);
			if (entry.rename && entry.rename !== entry.path) paths.push(entry.rename);
		}
		return paths;
	} catch {
		return [];
	}
}

function getHashlineInputRenderSummary(
	args: EditRenderArgs,
	editMode: EditMode | undefined,
): HashlineInputRenderSummary | undefined {
	const input = args.input ?? args._input;
	if (editMode !== "hashline" || typeof input !== "string") {
		return undefined;
	}
	return { entries: getHashlineInputSections(input) };
}

/**
 * Per-file entries of a possibly partial payload. The native inspect re-parses
 * the whole payload, and the call header and compact activity row both ask on
 * every frame, so the answer (or the parser's rejection) is memoized on `args`
 * for as long as `input` is unchanged.
 */
function inspectInputEntries(args: EditRenderArgs, mode: EditMode, input: string): InspectedInputEntry[] {
	const cached = args[kInspectedInput];
	if (cached && cached.mode === mode && cached.input === input) {
		if (cached.entries) return cached.entries;
		throw cached.error;
	}
	let inspection: EditInspection;
	try {
		inspection = editInspect(mode, JSON.stringify({ input }));
	} catch (error) {
		args[kInspectedInput] = { mode, input, error };
		throw error;
	}
	const entries = new Map<string, InspectedInputEntry>();
	for (const path of inspection.paths) entries.set(path, { path });
	for (const intent of inspection.fileOps) {
		const entry = entries.get(intent.path) ?? { path: intent.path };
		if (intent.kind === "delete") {
			entry.op = "delete";
		} else if (intent.kind === "move") {
			entry.op = "update";
			entry.rename = intent.to;
		}
		entries.set(intent.path, entry);
	}
	const result = [...entries.values()];
	args[kInspectedInput] = { mode, input, entries: result };
	return result;
}

/** Per-file descriptors for a possibly partial sloppy payload. */
function getSloppyInputRenderSummary(
	args: EditRenderArgs,
	editMode: EditMode | undefined,
): { entries: InspectedInputEntry[] } | undefined {
	const input = args.input ?? args._input;
	if (editMode !== "sloppy" || typeof input !== "string") return undefined;
	try {
		const entries = inspectInputEntries(args, "sloppy", input);
		return entries.length > 0 ? { entries } : undefined;
	} catch {
		return undefined;
	}
}

function getApplyPatchRenderSummary(
	args: EditRenderArgs,
	isPartial: boolean,
	editMode: EditMode | undefined,
): ApplyPatchRenderSummary | undefined {
	if ((editMode !== undefined && editMode !== "apply_patch") || typeof args.input !== "string") return undefined;
	try {
		return { entries: inspectInputEntries(args, "apply_patch", args.input) };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return isPartial && error === MISSING_APPLY_PATCH_END_ERROR ? { entries: [] } : { entries: [], error };
	}
}
/** Header facts (path, op, rename, file count) resolved from streamed edit args; shared by the framed call header and the compact activity summary. */
interface EditCallFacts {
	rawPath: string;
	rename?: string;
	op?: Operation;
	/** Distinct files touched by the call (0 when unknown). */
	fileCount: number;
	/** Apply-patch envelope parse error, when the payload failed to parse. */
	applyPatchError?: string;
}

/**
 * Length gate for the streamed-preview facts path: payloads only grow while
 * streaming, so facts recompute only after K new bytes (the header/path/op
 * fields tolerate a small lag) or when the payload shrinks (rewind). The
 * final frame (`isPartial === false`) always recomputes. This turns the
 * per-frame O(n) stringify+parse+scan into O(n^2/K) total per call.
 *
 * The reveal hands over a fresh args object on every frame, so the gate
 * keys on the streamed raw payload (`__partialJson`) rather than on args
 * identity: a frame reuses the facts only when its payload extends, byte for
 * byte, the payload the facts were derived from, and every direct field the
 * facts read (path, file_path, rename, op, edits) is unchanged. Final args
 * carry no `__partialJson`, so the completed call always derives exact facts.
 */
const EDIT_FACTS_MIN_GROWTH = 512;
interface EditFactsCacheEntry {
	editArgs: EditRenderArgs;
	isPartial: boolean;
	editMode: EditMode | undefined;
	length: number;
	/** Streamed raw payload the facts were derived from; set only for streamed `input` payloads. */
	streamedPayload: string | undefined;
	filePath: unknown;
	path: unknown;
	rename: unknown;
	op: Operation | undefined;
	edits: EditRenderEntry[] | undefined;
	facts: EditCallFacts;
}
let lastFactsCache: EditFactsCacheEntry | undefined;

function editFactsInputLength(editArgs: EditRenderArgs): number {
	const input = editArgs.input ?? editArgs._input;
	if (typeof input === "string") return input.length;
	// Structured `edits[]` calls carry no `input` string; their facts derive
	// from the array, so length-gate on its size instead of a constant 0
	// (which would reuse forever after the first compute).
	return Array.isArray(editArgs.edits) ? editArgs.edits.length : 0;
}

/**
 * Raw streamed payload of a mid-stream `input` edit, or undefined when the
 * args are final (no `__partialJson`) or carry no `input` string — only the
 * `input` payloads pay the expensive whole-payload inspect per frame.
 */
function streamedInputPayload(editArgs: EditRenderArgs): string | undefined {
	if (typeof (editArgs.input ?? editArgs._input) !== "string") return undefined;
	const payload = editArgs.__partialJson;
	return typeof payload === "string" ? payload : undefined;
}

/**
 * Whether a fresh streamed frame continues the payload `cached` was derived
 * from within the growth gate. Exact: the cached payload must be a verbatim
 * prefix of the new one, so a rewind or another call's payload never reuses.
 */
function continuesCachedPayload(cached: EditFactsCacheEntry, editArgs: EditRenderArgs): boolean {
	const base = cached.streamedPayload;
	if (base === undefined) return false;
	const payload = streamedInputPayload(editArgs);
	if (payload === undefined || payload.length < base.length) return false;
	if (payload.length - base.length >= EDIT_FACTS_MIN_GROWTH) return false;
	if (
		editArgs.file_path !== cached.filePath ||
		editArgs.path !== cached.path ||
		editArgs.rename !== cached.rename ||
		editArgs.op !== cached.op ||
		editArgs.edits !== cached.edits
	) {
		return false;
	}
	return payload.startsWith(base);
}

function resolveEditCallFacts(
	editArgs: EditRenderArgs,
	isPartial: boolean,
	editMode: EditMode | undefined,
): EditCallFacts {
	const cached = lastFactsCache;
	if (cached !== undefined && isPartial && cached.isPartial && cached.editMode === editMode) {
		if (cached.editArgs === editArgs) {
			const length = editFactsInputLength(editArgs);
			// Same args object, still growing gradually: reuse. A rewind
			// (shorter), a jump past the gate, or the final frame recomputes.
			if (length >= cached.length && length - cached.length < EDIT_FACTS_MIN_GROWTH) {
				return cached.facts;
			}
		} else if (continuesCachedPayload(cached, editArgs)) {
			return cached.facts;
		}
	}
	const facts = resolveEditCallFactsUncached(editArgs, isPartial, editMode);
	lastFactsCache = {
		editArgs,
		isPartial,
		editMode,
		length: editFactsInputLength(editArgs),
		streamedPayload: streamedInputPayload(editArgs),
		filePath: editArgs.file_path,
		path: editArgs.path,
		rename: editArgs.rename,
		op: editArgs.op,
		edits: editArgs.edits,
		facts,
	};
	return facts;
}

function resolveEditCallFactsUncached(
	editArgs: EditRenderArgs,
	isPartial: boolean,
	editMode: EditMode | undefined,
): EditCallFacts {
	const hashlineInputSummary = getHashlineInputRenderSummary(editArgs, editMode);
	const sloppyInputSummary = getSloppyInputRenderSummary(editArgs, editMode);
	const applyPatchSummary = getApplyPatchRenderSummary(editArgs, isPartial, editMode);
	const firstApplyPatchEntry = applyPatchSummary?.entries[0];
	const firstHashlineInputEntry = hashlineInputSummary?.entries[0];
	// Extract path from first edit entry when top-level path is absent (new schema)
	const firstEdit = Array.isArray(editArgs.edits) && editArgs.edits.length > 0 ? editArgs.edits[0] : undefined;
	const rawPath =
		typeof editArgs.file_path === "string"
			? editArgs.file_path
			: typeof editArgs.path === "string"
				? editArgs.path
				: (filePathFromEditEntry(firstEdit?.path) ??
					getPartialJsonEditPath(editArgs) ??
					firstHashlineInputEntry?.path ??
					sloppyInputSummary?.entries[0]?.path ??
					firstApplyPatchEntry?.path ??
					"");
	const rename =
		(typeof editArgs.rename === "string" ? editArgs.rename : undefined) ??
		filePathFromEditEntry(firstEdit?.rename) ??
		filePathFromEditEntry(firstEdit?.move) ??
		firstApplyPatchEntry?.rename ??
		firstHashlineInputEntry?.rename;
	const op = editArgs.op || firstEdit?.op || firstApplyPatchEntry?.op || firstHashlineInputEntry?.op;
	let fileCount =
		hashlineInputSummary?.entries.length ??
		sloppyInputSummary?.entries.length ??
		applyPatchSummary?.entries.length ??
		0;
	if (Array.isArray(editArgs.edits)) {
		fileCount = countEditFiles(editArgs.edits);
	}
	return {
		rawPath,
		rename,
		op,
		fileCount,
		applyPatchError: applyPatchSummary?.error,
	};
}

/** `+N -M` change counts for the bottom border; undefined for an empty diff. */
function formatDiffStats(diff: string, uiTheme: Theme): string | undefined {
	const { added, removed } = getDiffStats(diff);
	const stats = [
		added > 0 ? uiTheme.fg("toolDiffAdded", `+${added}`) : undefined,
		removed > 0 ? uiTheme.fg("toolDiffRemoved", `-${removed}`) : undefined,
	].filter(value => value !== undefined);
	return stats.length > 0 ? stats.join(" ") : undefined;
}

/** A result diff's frame rows (pre-wrapped to the inner width) and its collapsed truncation marker. */
interface DiffSection {
	lines: string[];
	marker?: string;
}

function renderDiffSection(
	diff: string,
	rawPath: string,
	expanded: boolean,
	innerWidth: number,
	uiTheme: Theme,
	renderDiffFn: (t: string, o?: { filePath?: string }) => string,
	renderCache?: RenderedStringCache,
): DiffSection {
	const {
		text: truncatedDiff,
		hiddenHunks,
		hiddenLines: logicallyHiddenLines,
	} = expanded
		? { text: diff, hiddenHunks: 0, hiddenLines: 0 }
		: truncateDiffByHunk(diff, PREVIEW_LIMITS.DIFF_COLLAPSED_HUNKS, PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);

	const renderedDiff = cachedRenderedString(renderCache, uiTheme, expanded, rawPath, truncatedDiff, () =>
		renderDiffFn(truncatedDiff, { filePath: rawPath }),
	);
	if (expanded) {
		return { lines: renderedDiff.split("\n").flatMap(line => wrapEditRendererLine(line, innerWidth)) };
	}
	const visible = sliceCollapsedDiffRows(renderedDiff, innerWidth, PREVIEW_LIMITS.DIFF_COLLAPSED_LINES);
	const hiddenLines = logicallyHiddenLines + visible.hiddenLines;
	if (hiddenLines === 0 && hiddenHunks === 0) return { lines: visible.rows };
	const more =
		hiddenLines > 0 ? formatMoreItems(hiddenLines, "line", uiTheme) : formatMoreItems(hiddenHunks, "hunk", uiTheme);
	return { lines: visible.rows, marker: `${more} ${formatExpandHint(uiTheme)}` };
}

function wrapEditRendererLine(line: string, width: number): string[] {
	if (width <= 0) return [line];
	if (line.length === 0) return [""];

	const startAnsi = line.match(/^((?:\x1b\[[0-9;]*m)*)/)?.[1] ?? "";
	const bodyWithReset = line.slice(startAnsi.length);
	const body = bodyWithReset.endsWith("\x1b[39m") ? bodyWithReset.slice(0, -"\x1b[39m".length) : bodyWithReset;
	// Gutter shapes produced by formatCodeFrameLine, separated by the theme's
	// vertical (`│`, or `|` in ASCII): "-315│", " 313│", "+322│", plus the
	// deduplicated forms "   +│" and "    │" whose repeated line number
	// renderDiff blanked (single-line replacement pairs and insert-then-context
	// runs). Those gutters are padded to at least 4 columns. Raw canonical rows
	// ("+12|") from injected renderers always carry a marker column and a line
	// number. Anything else (a body line merely starting with "|", error text
	// like "123|…") is not a diff row and wraps generically.
	const diffMatch = /^(\s*[+-]?\s*\d*)([|│])(.*)$/s.exec(body);
	const isGutter =
		diffMatch !== null &&
		((diffMatch[1].length >= 4 && /^ *[+\-*>]?\d*$/.test(diffMatch[1])) || /^[+\-\s]\s*\d+$/.test(diffMatch[1]));
	if (!diffMatch || !isGutter) {
		return wrapTextWithAnsi(line, width);
	}

	const [, gutter, separator, content] = diffMatch;
	const prefix = `${gutter}${separator}`;
	const prefixWidth = visibleWidth(prefix);
	const contentWidth = Math.max(1, width - prefixWidth);
	const continuationPrefix = `${" ".repeat(Math.max(0, prefixWidth - 1))}${separator}`;
	const wrappedContent = wrapTextWithAnsi(content ?? "", contentWidth);

	// Each visual row is a standalone terminal line: wrapTextWithAnsi re-opens
	// active SGR state at the next row's start, so a row that breaks inside an
	// intra-line diff highlight still ends with inverse video active. Close it
	// alongside the foreground reset — otherwise the frame padding appended
	// after the row is painted as an inverse block (default-foreground cells).
	return wrappedContent.map(
		(segment, index) => `${startAnsi}${index === 0 ? prefix : continuationPrefix}${segment}\x1b[27m\x1b[39m`,
	);
}

function sliceCollapsedDiffRows(
	renderedDiff: string,
	innerWidth: number,
	maxRows: number,
): { rows: string[]; hiddenLines: number } {
	const lines = renderedDiff.split("\n");
	const visibleRows: string[] = [];
	let completeLines = 0;

	for (const line of lines) {
		const wrapped = wrapEditRendererLine(line, innerWidth);
		const remainingRows = maxRows - visibleRows.length;
		if (wrapped.length <= remainingRows) {
			visibleRows.push(...wrapped);
			completeLines++;
			continue;
		}
		if (remainingRows > 0) visibleRows.push(...wrapped.slice(0, remainingRows));
		break;
	}

	return { rows: visibleRows, hiddenLines: lines.length - completeLines };
}

/** Render edit previews and completed file diffs. */
export const editToolRenderer = {
	mergeCallAndResult: true,
	/** Compact one-line activity: operation + target path instead of the payload's first line. */
	activitySummary(args: unknown, context: ToolActivityContext): ToolActivitySummary {
		const editArgs = (args ?? {}) as EditRenderArgs;
		const editMode = (context.renderContext as EditRenderContext | undefined)?.editMode;
		const facts = resolveEditCallFacts(editArgs, context.isPartial, editMode);
		const label = getOperationTitle(facts.op, facts.rename);
		if (!facts.rawPath) return { label };
		let detail = formatEditTitlePath(facts.rawPath, activeTheme);
		if (facts.rename) detail += ` ${activeTheme.format.arrowRight} ${formatEditTitlePath(facts.rename, activeTheme)}`;
		if (facts.fileCount > 1) detail += ` (+${facts.fileCount - 1} more)`;
		return { label, detail };
	},

	renderCall(
		args: EditRenderArgs,
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
	): Component {
		const renderContext = options.renderContext;
		const editArgs = args as EditRenderArgs;
		const { rawPath, rename, op, fileCount, applyPatchError } = resolveEditCallFacts(
			editArgs,
			options.isPartial,
			renderContext?.editMode,
		);
		const icon = options.executionStarted ? "running" : "pending";
		const multi = renderContext?.perFileDiffPreview;
		if (multi && multi.length > 1 && multi.some(p => p.diff || p.error)) {
			return renderMultiFileCall(multi, icon, options, uiTheme);
		}
		const header: EditHeaderOptions = { icon: applyPatchError ? "error" : icon, op, rawPath, rename };
		const phase = applyPatchError ? "error" : icon;
		const filesMeta = fileCount > 1 ? formatCount("file", fileCount) : undefined;
		// Nothing streamed to frame yet (or a payload-less delete/move): a flush
		// status line, with any preview or envelope error beneath it.
		if (!hasCallPreview(editArgs, renderContext)) {
			const contextPreview = renderContext?.editDiffPreview;
			const errors = [
				contextPreview && "error" in contextPreview ? contextPreview.error : undefined,
				applyPatchError,
			];
			return plainToolCard(uiTheme, ({ width }) => ({
				status: { ...editStatus(header, width, uiTheme), meta: filesMeta ? [filesMeta] : undefined },
				phase,
				body: errors.flatMap(error => (error ? formatErrorRows(error, uiTheme) : [])),
			}));
		}
		const previewCache = createRenderedStringCache();
		return framedToolCard(
			uiTheme,
			({ width, contentWidth }) => {
				const preview = getCallPreview(
					editArgs,
					rawPath,
					contentWidth,
					uiTheme,
					renderContext,
					options.expanded,
					previewCache,
				);
				const lines = preview.lines.flatMap(line => wrapEditRendererLine(line, contentWidth));
				if (applyPatchError) lines.push(...formatErrorRows(applyPatchError, uiTheme));
				return {
					status: editStatus(header, framedHeaderBudget(width, uiTheme), uiTheme),
					phase,
					footerMeta: joinFooterMeta([filesMeta, preview.footer], uiTheme),
					sections: [{ content: lines }],
				};
			},
			{ onReleaseRenderCaches: () => releaseRenderedStringCache(previewCache) },
		);
	},

	describeCall(
		args: EditRenderArgs,
		options: RenderResultOptions & { renderContext?: EditRenderContext },
	): NativeToolView {
		const renderContext = options.renderContext;
		const { rawPath, rename, op, fileCount, applyPatchError } = resolveEditCallFacts(
			args,
			options.isPartial,
			renderContext?.editMode,
		);
		const body: NativeChild[] = [];
		let tool: NativeToolHead;
		const multi = renderContext?.perFileDiffPreview;
		if (multi && multi.length > 1 && multi.some(p => p.diff || p.error)) {
			let added = 0;
			let removed = 0;
			for (const preview of multi) {
				const stats = preview.diff ? getDiffStats(preview.diff) : undefined;
				added += stats?.added ?? 0;
				removed += stats?.removed ?? 0;
				body.push(
					fileDiffSection(
						{ path: preview.path, added: stats?.added, removed: stats?.removed },
						[preview.error ? errorText(preview.error) : editDiff(preview.diff ?? "", preview.path)],
						{ role: "omp.tool.edit.file", tone: preview.error ? "error" : undefined },
					),
				);
			}
			tool = editToolHead({ op, files: Math.max(fileCount, multi.length), added, removed });
		} else {
			let diffText: string | undefined;
			let firstChangedLine: number | undefined;
			if (args.previewDiff || (args.diff && args.op)) {
				diffText = args.previewDiff ?? args.diff ?? "";
				body.push(editDiff(diffText, rawPath));
			} else if (args.diff || args.newText || args.patch) {
				body.push(code(args.diff ?? args.newText ?? args.patch ?? "", { path: rawPath || undefined }));
			} else if (renderContext?.editDiffPreview) {
				const preview = renderContext.editDiffPreview;
				if ("error" in preview && preview.error) body.push(errorText(preview.error));
				else if (preview.diff) {
					diffText = preview.diff;
					firstChangedLine = preview.firstChangedLine;
					body.push(editDiff(preview.diff, rawPath));
				}
			}
			const stats = diffText ? getDiffStats(diffText) : undefined;
			tool = editToolHead({
				op,
				path: rawPath,
				files: fileCount,
				line: firstChangedLine,
				rename,
				added: stats?.added ?? 0,
				removed: stats?.removed ?? 0,
			});
		}
		if (applyPatchError) body.push(errorText(applyPatchError));
		return { tool, body, tone: applyPatchError ? "error" : undefined };
	},

	describeResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EditToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		args?: EditRenderArgs,
	): NativeToolView {
		const edits = Array.isArray(args?.edits) ? args.edits : undefined;
		const perFileResults = result.details?.perFileResults;
		const totalFiles = edits ? countEditFiles(edits) : 0;
		if (perFileResults && (perFileResults.length > 1 || totalFiles > 1)) {
			const remaining = Math.max(0, totalFiles - perFileResults.length);
			let added = 0;
			let removed = 0;
			// Files are borderless sections inside the one tool frame.
			const body: NativeChild[] = perFileResults.map((fileResult, index) => {
				const rawDetails = options.renderContext?.rawDetails;
				const rawPerFile =
					rawDetails && typeof rawDetails === "object" && "perFileResults" in rawDetails
						? rawDetails.perFileResults
						: undefined;
				const file = editFileParts(
					{ content: [], details: fileResult, isError: fileResult.isError },
					options,
					undefined,
					Array.isArray(rawPerFile) ? rawPerFile[index] : undefined,
				);
				added += file.added;
				removed += file.removed;
				return fileDiffSection(file, file.body, {
					role: "omp.tool.edit.file",
					tone: file.isError ? "error" : undefined,
				});
			});
			if (remaining > 0) {
				body.push(
					node("spinner", {
						label: [span(`${remaining} more file${remaining > 1 ? "s" : ""} pending…`, "muted")],
					}),
				);
			}
			const failed = perFileResults.some(file => file.isError);
			return {
				tool: editToolHead({
					files: Math.max(totalFiles, perFileResults.length),
					added,
					removed,
					diagnostics: perFileResults.map(file => file.diagnostics),
				}),
				body,
				tone: failed ? "error" : undefined,
			};
		}
		const file = editFileParts(result, options, args);
		return {
			tool: editToolHead({ ...file, href: fileHref(file.resolvedPath), diagnostics: [file.fileDiagnostics] }),
			body: file.body,
			tone: file.isError ? "error" : undefined,
		};
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: EditToolDetails; isError?: boolean },
		options: RenderResultOptions & { renderContext?: EditRenderContext },
		uiTheme: Theme,
		args?: EditRenderArgs,
	): Component {
		const edits = Array.isArray(args?.edits) ? args.edits : undefined;
		const perFileResults = result.details?.perFileResults;
		const totalFiles = edits ? countEditFiles(edits) : 0;
		if (perFileResults && (perFileResults.length > 1 || totalFiles > 1)) {
			return renderMultiFileResult(perFileResults, totalFiles, options, uiTheme);
		}
		return renderSingleFileResult(result, options, uiTheme, args);
	},
} satisfies ToolRenderer<EditRenderArgs, EditToolDetails>;

/** Facts behind a native edit head: one file (path, first changed line, rename) or a file count. */
interface EditHeadFacts {
	op?: Operation;
	path?: string;
	/** Distinct files in the call; more than one heads the call as `N files`. */
	files?: number;
	line?: number;
	href?: string;
	rename?: string;
	added: number;
	removed: number;
	diagnostics?: readonly (FileDiagnosticsResult | undefined)[];
}

/**
 * Native edit head (§7.3): `Edit · path:line · +8 −1 · → new/path` for one
 * file, `Edit · 3 files · +21 −4` for several; a diagnostics chip when LSP reported.
 */
function editToolHead(facts: EditHeadFacts): NativeToolHead {
	const multi = (facts.files ?? 0) > 1;
	const meta = compact([
		diffStatsMeta(facts.added, facts.removed),
		!multi && facts.rename ? `→ ${displayPath(sanitizeText(facts.rename))}` : undefined,
	]);
	const badge = facts.diagnostics && diagnosticsBadge(facts.diagnostics);
	const target = multi
		? `${facts.files} files`
		: facts.path
			? `${displayPath(sanitizeText(facts.path))}${facts.line ? `:${facts.line}` : ""}`
			: undefined;
	return {
		title: multi ? "Edit" : getOperationTitle(facts.op, facts.rename),
		target,
		targetKind: multi ? "text" : "path",
		href: multi ? undefined : facts.href,
		meta: meta.length > 0 ? meta : undefined,
		badges: badge ? [badge] : undefined,
	};
}

/** A file's diff: Tern highlights the hunks by the file's grammar and draws no path header (the head or section names the file). */
function editDiff(diffText: string, filePath: string): NativeNode {
	return nativeDiff(diffText, { path: filePath || undefined });
}

/** One file's edit result for native views: head facts plus its body (diff or error, then diagnostics). */
interface EditFileParts extends Omit<EditHeadFacts, "diagnostics"> {
	path: string;
	/** Absolute path the edit resolved to, when known. */
	resolvedPath?: string;
	isError: boolean;
	fileDiagnostics?: FileDiagnosticsResult;
	body: NativeChild[];
}

/** Raw metadata paths are reserved for link targets; visible content comes from sanitized details. */
function rawEditPaths(value: unknown): { path?: string; sourcePath?: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	return {
		path: "path" in value && typeof value.path === "string" ? value.path : undefined,
		sourcePath: "sourcePath" in value && typeof value.sourcePath === "string" ? value.sourcePath : undefined,
	};
}

function editFileParts(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: EditToolDetails | EditToolPerFileResult;
		isError?: boolean;
	},
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	args?: EditRenderArgs,
	rawFileDetails?: unknown,
): EditFileParts {
	const details = result.details;
	const rawPaths = rawEditPaths(rawFileDetails ?? options.renderContext?.rawDetails);
	const isError = result.isError ?? (details && "isError" in details ? details.isError : false) ?? false;
	const firstEdit = Array.isArray(args?.edits) ? args.edits[0] : undefined;
	const firstHashlineInputEntry = getHashlineInputRenderSummary(args ?? {}, options.renderContext?.editMode)
		?.entries[0];
	const moveSource =
		details && "sourcePath" in details && typeof details.sourcePath === "string" ? details.sourcePath : undefined;
	const detailPath = details && "path" in details && typeof details.path === "string" ? details.path : undefined;
	const rawPath =
		moveSource ??
		(typeof args?.file_path === "string"
			? args.file_path
			: typeof args?.path === "string"
				? args.path
				: (filePathFromEditEntry(firstEdit?.path) ?? detailPath ?? firstHashlineInputEntry?.path ?? ""));
	const op = args?.op || firstEdit?.op || details?.op;
	const rename =
		(typeof args?.rename === "string" ? args.rename : undefined) ??
		filePathFromEditEntry(firstEdit?.rename) ??
		filePathFromEditEntry(firstEdit?.move) ??
		(details && "move" in details && typeof details.move === "string" ? details.move : undefined);
	// Details that only class a failure leave the streamed preview to locate it.
	const editDiffPreview = details && !("errorKind" in details) ? undefined : options.renderContext?.editDiffPreview;
	const previewDiff = editDiffPreview && !("error" in editDiffPreview) ? editDiffPreview.diff : undefined;
	const diffText = isError ? undefined : details?.diff || previewDiff;
	const firstChangedLine =
		(editDiffPreview && "firstChangedLine" in editDiffPreview ? editDiffPreview.firstChangedLine : undefined) ||
		(details && !isError ? details.firstChangedLine : undefined);
	const shownPath = displayPath(sanitizeText(detailPath ?? rawPath));
	const body: NativeChild[] = [];
	if (isError) {
		const displayErrorText = details && "displayErrorText" in details ? details.displayErrorText : undefined;
		const message =
			displayErrorText || (details && "errorText" in details && details.errorText) || resultText(result);
		if (message) body.push(errorText(message));
	} else if (diffText) {
		body.push(editDiff(diffText, detailPath ?? rawPath));
	} else if (editDiffPreview && "error" in editDiffPreview) {
		body.push(errorText(editDiffPreview.error));
	} else if (details && op !== "delete" && op !== "create" && !rename) {
		body.push(noteText(`No changes were made${shownPath ? ` to ${shownPath}` : ""}.`));
	}
	const diagnostics = diagnosticsSection(details?.diagnostics);
	if (diagnostics) body.push(diagnostics);
	const stats = diffText ? getDiffStats(diffText) : undefined;
	return {
		op,
		path: sanitizeText(rawPath),
		line: firstChangedLine,
		rename: rename === undefined ? undefined : sanitizeText(rename),
		resolvedPath: rawPaths.path ?? detailPath,
		added: stats?.added ?? 0,
		removed: stats?.removed ?? 0,
		isError: Boolean(isError),
		fileDiagnostics: details?.diagnostics,
		body,
	};
}

function renderSingleFileResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: EditToolDetails | EditToolPerFileResult;
		isError?: boolean;
	},
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
	args?: EditRenderArgs,
): Component {
	const details = result.details;
	const rawPaths = rawEditPaths(options.renderContext?.rawDetails);
	const isError = result.isError ?? (details && "isError" in details ? details.isError : false);
	const edits = Array.isArray(args?.edits) ? args.edits : undefined;
	const firstEdit = edits?.[0];
	const hashlineInputSummary = getHashlineInputRenderSummary(args ?? {}, options.renderContext?.editMode);
	const firstHashlineInputEntry = hashlineInputSummary?.entries[0];
	const moveSource =
		details && "sourcePath" in details && typeof details.sourcePath === "string" ? details.sourcePath : undefined;
	const detailPath = details && "path" in details && typeof details.path === "string" ? details.path : undefined;
	const rawPath =
		moveSource ??
		(typeof args?.file_path === "string"
			? args.file_path
			: typeof args?.path === "string"
				? args.path
				: (filePathFromEditEntry(firstEdit?.path) ?? detailPath ?? firstHashlineInputEntry?.path ?? ""));
	const op = args?.op || firstEdit?.op || details?.op;
	const rename =
		(typeof args?.rename === "string" ? args.rename : undefined) ??
		filePathFromEditEntry(firstEdit?.rename) ??
		filePathFromEditEntry(firstEdit?.move) ??
		(details && "move" in details && typeof details.move === "string" ? details.move : undefined);

	const displayErrorText = isError && details && "displayErrorText" in details ? details.displayErrorText : undefined;
	const errorText = isError
		? displayErrorText ||
			(details && "errorText" in details && details.errorText) ||
			(result.content?.find(c => c.type === "text")?.text ?? "")
		: "";

	// A finalized result is authoritative: its `details` describe exactly what
	// happened. The shared streaming `editDiffPreview` is a call-phase artifact
	// (in a batch it reflects only the first file), so consulting it for an
	// empty-diff delete/move/no-op result mislabels the card. Fall back to the
	// preview only when no details exist yet, or when they only class a failure.
	const editDiffPreview = details && !("errorKind" in details) ? undefined : options.renderContext?.editDiffPreview;
	const previewError = editDiffPreview && "error" in editDiffPreview ? editDiffPreview.error : undefined;
	const previewDiff = editDiffPreview && !("error" in editDiffPreview) ? editDiffPreview.diff : undefined;
	const diff = isError ? undefined : details ? details.diff : previewDiff;
	// Authoritative result with no textual diff: a delete, a move-only rename,
	// a body-less create, or a genuine no-op. Only the no-op needs a note so an
	// empty card isn't mistaken for a stalled edit.
	const noOp = !isError && !diff && details !== undefined && op !== "delete" && op !== "create" && !rename;
	const icon: "error" | "warning" | "running" | "success" =
		isError || (!diff && previewError) ? "error" : noOp ? "warning" : options.isPartial ? "running" : "success";
	const header: EditHeaderOptions = {
		icon,
		op,
		rawPath,
		rename,
		firstChangedLine:
			(editDiffPreview && "firstChangedLine" in editDiffPreview ? editDiffPreview.firstChangedLine : undefined) ||
			(details && !isError ? details.firstChangedLine : undefined),
		linkPath: rename
			? (rawPaths.sourcePath ?? moveSource ?? rawPaths.path ?? detailPath)
			: (rawPaths.path ?? detailPath),
		renameLinkPath: rename ? (rawPaths.path ?? detailPath) : undefined,
	};
	const phase = icon === "running" ? "partial" : icon;
	const diagnostics = details?.diagnostics;

	// No diff to frame: a flush status line over the error, the no-op note, or nothing.
	if (!diff) {
		const message = isError ? errorText : previewError;
		return plainToolCard(uiTheme, ({ width }) => {
			const diag = diagnosticsCardSection(diagnostics, options.expanded, uiTheme);
			return {
				status: editStatus(header, width, uiTheme),
				phase,
				body:
					message !== undefined
						? formatErrorRows(message, uiTheme)
						: noOp
							? [uiTheme.fg("dim", "No changes were made.")]
							: undefined,
				sections: diag ? [flushDiagnosticsSection(diag)] : undefined,
			};
		});
	}

	const renderFallbackDiff = (diffText: string, diffOptions?: { filePath?: string }): string =>
		renderDiffColored(diffText, { filePath: diffOptions?.filePath, theme: uiTheme });
	const renderedDiffCache = createRenderedStringCache();
	const stats = formatDiffStats(diff, uiTheme);
	type RenderDiffFn = (t: string, o?: { filePath?: string }) => string;
	let highlightedWith: RenderDiffFn | undefined;
	let sectionMemo: { expanded: boolean; width: number; section: DiffSection } | undefined;

	return framedToolCard(
		uiTheme,
		({ width, contentWidth }) => {
			const expanded = options.expanded;
			const renderDiffFn = options.renderContext?.renderDiff ?? renderFallbackDiff;
			if (highlightedWith !== renderDiffFn) {
				highlightedWith = renderDiffFn;
				invalidateRenderedStringCache(renderedDiffCache);
				sectionMemo = undefined;
			}
			if (sectionMemo?.expanded !== expanded || sectionMemo.width !== contentWidth) {
				sectionMemo = {
					expanded,
					width: contentWidth,
					section: renderDiffSection(
						diff,
						rawPath,
						expanded,
						contentWidth,
						uiTheme,
						renderDiffFn,
						renderedDiffCache,
					),
				};
			}
			const { lines, marker } = sectionMemo.section;
			const diag = diagnosticsCardSection(diagnostics, expanded, uiTheme);
			// The last section's marker rides the bottom border; the diff's stays in place above diagnostics.
			return {
				status: editStatus(header, framedHeaderBudget(width, uiTheme), uiTheme),
				phase,
				footerMeta: joinFooterMeta([stats, diag ? diag.marker : marker], uiTheme),
				sections: [
					{ content: diag && marker ? [...lines, uiTheme.fg("dim", marker)] : lines },
					...(diag ? [diag.section] : []),
				],
			};
		},
		{
			// Only the width-keyed diff section goes; the highlighted diff does not depend on width, and
			// re-highlighting every committed card on each resize replay costs seconds.
			onReleaseRenderCaches: () => {
				sectionMemo = undefined;
			},
		},
	);
}

/** Diagnostics as a card section; the `… N more` marker split off for the framed card's bottom border. */
interface DiagnosticsCardSection {
	section: ToolCardSection;
	marker?: string;
}

/**
 * `formatDiagnostics` as a labelled card section: its first row becomes the
 * section label. A trailing `… N more diagnostics` row is returned apart so a
 * framed card can move it into the bottom border.
 */
export function diagnosticsCardSection(
	diagnostics: FileDiagnosticsResult | undefined,
	expanded: boolean,
	uiTheme: Theme,
): DiagnosticsCardSection | undefined {
	if (!diagnostics) return undefined;
	const text = formatDiagnostics(diagnostics, expanded, uiTheme, fp => uiTheme.getLangIcon(getLanguageFromPath(fp)));
	if (!text) return undefined;
	const [label, ...rows] = text.split("\n");
	const last = rows.at(-1);
	const marker = last && Bun.stripANSI(last).startsWith(uiTheme.format.ellipsis) ? rows.pop() : undefined;
	return { section: { label, content: rows }, marker };
}

/** A flush card keeps the diagnostics marker as the section's last row. */
export function flushDiagnosticsSection(diag: DiagnosticsCardSection): ToolCardSection {
	if (!diag.marker) return diag.section;
	return { ...diag.section, content: [...(diag.section.content as readonly string[]), diag.marker] };
}

/**
 * Stack per-file cards one under another, a blank row between them (the
 * multi-file layout of the transcript), plus an optional trailing status row.
 */
function stackCards(cards: readonly Component[], trailer?: () => string | undefined): Component {
	let cached: { parts: readonly (readonly string[])[]; trailer: string | undefined; lines: string[] } | undefined;
	return {
		render(width) {
			const parts = cards.map(card => card.render(width));
			const trailing = trailer?.();
			const previous = cached;
			if (
				previous !== undefined &&
				previous.trailer === trailing &&
				previous.parts.length === parts.length &&
				parts.every((part, index) => part === previous.parts[index])
			) {
				return previous.lines;
			}
			const lines: string[] = [];
			for (const part of parts) {
				if (lines.length > 0) lines.push("");
				lines.push(...part);
			}
			if (trailing) {
				if (lines.length > 0) lines.push("");
				lines.push(trailing);
			}
			cached = { parts, trailer: trailing, lines };
			return lines;
		},
		invalidate() {
			cached = undefined;
			for (const card of cards) card.invalidate?.();
		},
		releaseRenderCaches() {
			cached = undefined;
			for (const card of cards) card.releaseRenderCaches?.();
		},
		dispose() {
			for (const card of cards) card.dispose?.();
		},
	};
}

/** A streaming multi-file call: one card per file preview, as the per-file results render. */
function renderMultiFileCall(
	previews: PerFileDiffPreview[],
	icon: "pending" | "running",
	options: RenderResultOptions,
	uiTheme: Theme,
): Component {
	const cards = previews.map((preview): Component | undefined => {
		const header: EditHeaderOptions = { icon: preview.error ? "error" : icon, rawPath: preview.path };
		if (preview.error) {
			const error = preview.error;
			return plainToolCard(uiTheme, ({ width }) => ({
				status: editStatus(header, width, uiTheme),
				phase: "error",
				body: formatErrorRows(error, uiTheme),
			}));
		}
		const diff = preview.diff;
		if (!diff) return undefined;
		const cache = createRenderedStringCache();
		return framedToolCard(
			uiTheme,
			({ width, contentWidth }) => ({
				status: editStatus(header, framedHeaderBudget(width, uiTheme), uiTheme),
				phase: icon,
				footerMeta: options.expanded ? undefined : uiTheme.fg("dim", "preview"),
				sections: [
					{
						content: formatStreamingDiff(
							diff,
							preview.path,
							contentWidth,
							uiTheme,
							options.expanded,
							cache,
						).flatMap(line => wrapEditRendererLine(line, contentWidth)),
					},
				],
			}),
			{ onReleaseRenderCaches: () => releaseRenderedStringCache(cache) },
		);
	});
	return stackCards(cards.filter(card => card !== undefined));
}

function renderMultiFileResult(
	perFileResults: EditToolPerFileResult[],
	totalFiles: number,
	options: RenderResultOptions & { renderContext?: EditRenderContext },
	uiTheme: Theme,
): Component {
	const rawDetails = options.renderContext?.rawDetails;
	const rawPerFile =
		rawDetails && typeof rawDetails === "object" && "perFileResults" in rawDetails
			? rawDetails.perFileResults
			: undefined;
	const fileComponents = perFileResults.map((fileResult, index) =>
		renderSingleFileResult(
			{ content: [], details: fileResult, isError: fileResult.isError },
			Array.isArray(rawPerFile)
				? { ...options, renderContext: { ...options.renderContext, rawDetails: rawPerFile[index] } }
				: options,
			uiTheme,
		),
	);
	const remaining = Math.max(0, totalFiles - perFileResults.length);
	// Files still being processed: the same running row the transcript draws.
	return stackCards(fileComponents, () =>
		remaining > 0
			? renderStatusLine(
					{
						icon: "running",
						spinnerFrame: options.spinnerFrame,
						title: "Edit",
						description: `${remaining} more ${remaining > 1 ? "files" : "file"} pending`,
					},
					uiTheme,
				)
			: undefined,
	);
}
