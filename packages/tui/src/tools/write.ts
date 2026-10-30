import * as path from "node:path";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { HighlightStream } from "@oh-my-pi/pi-natives";
import type { Component } from "../tui";
import { fencedCode } from "../components/markdown";
import { Text } from "../components/text";
import { getLanguageFromPath } from "../lang-from-path";
import { createHighlightStream, highlightCode, type Theme } from "../theme/theme";
import { fileHyperlink } from "../render";
import type { StatusLineOptions } from "../render/status-line";
import { framedToolCard, plainToolCard } from "../render/tool-card";
import { wrapPrefixedLine } from "../render/hanging-wrap";
import {
	cachedRenderedString,
	createRenderedStringCache,
	formatCount,
	formatErrorText,
	formatMoreRow,
	PREVIEW_LIMITS,
	type RenderedStringCache,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import { diagnosticsCardSection, flushDiagnosticsSection } from "./edit";
import type { CoordinationDetails } from "./wait";
import {
	describeAgentWrite,
	describeProcWrite,
	renderAgentWrite,
	renderProcWrite,
	type ProcWriteAction,
	type ProcWriteDetails,
} from "./proc-render";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { code, compact, md, node, span } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { diagnosticsBadge, diagnosticsSection, displayPath, errorText, fileHref, resultText } from "./native-view";
import { describeCfgWrite, renderCfgWrite, type CfgWriteDetails } from "./cfg-render";
import type { FileDiagnosticsResult } from "./lsp";
import type { OutputMeta } from "./output-meta";
import type { CardToolResult } from "./result-card";
import type {
	NativeToolHead,
	NativeToolView,
	RenderResultOptions,
	ToolActivityContext,
	ToolActivitySummary,
	ToolFigure,
	ToolRenderer,
} from "./renderer";
import { splitUrlScheme } from "./url-scheme-host";
import { couldBecomeXdUrl, parseXdUrl } from "./xd-url";
import {
	describeXdevCall,
	describeXdevResult,
	renderXdevCall,
	renderXdevResult,
	xdevActivitySummary,
	type XdevRenderDispatch,
	type XdevMountedRenderer,
} from "./xdev";
import { describeResolutionDeviceCall, isResolutionDeviceName, renderResolutionDeviceCall } from "./resolve";
import {
	describeReportIssueDeviceCall,
	REPORT_ISSUE_DEVICE_NAME,
	renderReportIssueDeviceCall,
} from "./report-tool-issue";
import { pendingFileLinkPath } from "./read";

/** Details returned by the write tool for transcript rendering. */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
	meta?: OutputMeta;
	/** Set when the file was auto-chmod'd because content begins with a `#!` shebang. */
	madeExecutable?: boolean;
	/** Absolute filesystem path the write resolved to. Used by the renderer to wrap
	 * the (possibly cwd-relative) header path in an OSC 8 `file://` hyperlink. */
	resolvedPath?: string;
	/** Set when the write dispatched an `xd://` tool device; drives renderer delegation. */
	xdev?: XdevRenderDispatch;
	message?: CoordinationDetails;
	proc?: ProcWriteDetails;
	cfg?: CfgWriteDetails;
}

interface WriteRenderArgs {
	path?: unknown;
	file_path?: unknown;
	content?: unknown;
}

const WRITE_PREVIEW_LINES = 6;
/** Collapsed native write body: the first lines of the file (§7.3). */
const NATIVE_WRITE_PREVIEW = { lines: 8 } as const;
/**
 * Collapsed clamp of a write drawn as a figure: Tern's model figure (its head
 * over a 320px stage) clears the clamp's fade at 16px lines.
 */
const NATIVE_FIGURE_PREVIEW_LINES = 26;

/**
 * Fence language per extension of a written file that transcripts draw as a
 * figure, as they draw that fence in assistant text: svg and mermaid, plus
 * the 3D formats only Tern draws (stencil-markdown's model fences).
 */
const FIGURE_FENCES: Readonly<Record<string, string>> = {
	svg: "svg",
	mmd: "mermaid",
	mermaid: "mermaid",
	obj: "obj",
	ply: "ply",
	wrl: "wrl",
	vrml: "vrml",
	x3dv: "x3dv",
	stl: "stl",
	gltf: "gltf",
	usda: "usda",
	usd: "usd",
};

/** A write tool result as the renderer receives it. */
interface WriteResult {
	content: Array<{ type: string; text?: string }>;
	details?: WriteToolDetails;
	isError?: boolean;
}

/**
 * The fence a file write draws as while its content streams and after: its
 * extension names a figure language and it has content, closed once the args
 * are final. None for URL-card writes, or after an error.
 */
function writeFigure(
	args: WriteRenderArgs | undefined,
	result: WriteResult | undefined,
	options: RenderResultOptions,
): ToolFigure | undefined {
	if (result?.isError || result?.details?.xdev) return undefined;
	const rawPath =
		typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
	const lang = FIGURE_FENCES[path.extname(rawPath).slice(1).toLowerCase()];
	const content = args?.content;
	if (!lang || typeof content !== "string" || !/\S/.test(content) || writeUrlCard(rawPath, result?.details)) {
		return undefined;
	}
	return {
		lang,
		source: content.includes("\r") ? content.replace(/\r/g, "") : content,
		closed: result !== undefined || options.argsComplete === true,
	};
}

/**
 * The `md` node drawing a figure write as its fence draws in a reply: open
 * and streaming while the content arrives. A mermaid figure waits for the
 * fence to close, as Tern shows an open one as code, which the source is.
 */
function describeFigure(figure: ToolFigure | undefined): NativeNode | undefined {
	if (!figure || (figure.lang === "mermaid" && !figure.closed)) return undefined;
	const text = fencedCode(figure.lang, figure.source, { open: !figure.closed });
	return { ...md(text, { role: "omp.tool.write.figure", stream: !figure.closed }), key: "figure" };
}

/**
 * The written content as numbered code, highlighted by Tern from the file's path,
 * keyed so it keeps its node as the figure above it comes and goes.
 */
function describeSource(rawPath: string, content: string): NativeNode {
	return { ...code(content, { path: rawPath || undefined, numbers: true, wrap: true }), key: "source" };
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

/** Bounded newline scan: whether `text` spans more than `maxLines` lines.
 *  Runs on every live compose (the repaint predicate below), so it must not
 *  materialize the split the way `countLines` does. */
function exceedsLineCount(text: string, maxLines: number): boolean {
	if (!text) return false;
	let lines = 1;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		if (++lines > maxLines) return true;
	}
	return false;
}

function writeContentOf(args: unknown): string {
	if (args == null || typeof args !== "object" || !("content" in args)) return "";
	const content = args.content;
	return typeof content === "string" ? content : "";
}

/** The status line of every file-write state: `Write: path`, the path linked to `linkTarget` when known. */
function writeStatus(
	icon: StatusLineOptions["icon"],
	rawPath: string,
	linkTarget: string | undefined,
	uiTheme: Theme,
): StatusLineOptions {
	const filePath = sanitizeText(shortenPath(rawPath));
	let description = filePath || uiTheme.format.ellipsis;
	if (filePath && linkTarget) description = fileHyperlink(linkTarget, filePath);
	return { icon, title: "Write", description };
}

/** Dim right-aligned line-number gutter of a preview row. */
function formatLineGutter(lineNumber: number, lineNumberWidth: number, uiTheme: Theme): string {
	return uiTheme.fg("dim", `${String(lineNumber).padStart(lineNumberWidth, " ")} `);
}

function normalizeDisplayText(text: unknown): string {
	let displayText = "";
	if (typeof text === "string") {
		displayText = text;
	} else if (text !== undefined && text !== null) {
		displayText = String(text);
	}
	return displayText.replace(/\r/g, "");
}

/**
 * Minimum line-number gutter width for write previews. The streaming preview's
 * gutter must stay byte-stable as the line count grows: a width derived purely
 * from `String(totalLines).length` widens at the 10/100/1000-line crossings,
 * causing the live preview to jitter. Reserving 3 digits keeps the gutter
 * constant through 999 lines and keeps the streamed rows aligned with the
 * final result render.
 */
const WRITE_GUTTER_MIN_WIDTH = 3;

const writeStreamingPreviewStateKey = Symbol("writeStreamingPreviewState");

/**
 * Per-component state for incrementally rendering a streamed write.
 * The ToolExecutionComponent's persistent render options carry the state, so
 * it lives exactly as long as the component and cannot leak across tool calls.
 */
interface WriteStreamingPreviewState {
	/** Prior full content; append-only growth is validated with an exact prefix check. */
	previous: string;
	/** `1 + count("\n")` over the scanned content. */
	lineCount: number;
	/** Raw offset immediately after the last newline consumed by `highlighter`. */
	completeLength: number;
	/** Highlighted, complete logical lines; the unfinished trailing line is rendered plain. */
	highlightedLines: string[];
	/** Stateful parser carrying syntax scopes across appended complete lines. */
	highlighter: HighlightStream | null;
	language: string | undefined;
	uiTheme: Theme;
	/** Content length for which the trailing line was flushed as final (`argsComplete`); -1 when none. */
	finalFlushedLength: number;
	/** Highlighted trailing line from the final flush; rendered in place of the plain tail. */
	finalTrailing: string;
}

interface WriteStreamingPreviewStateCarrier {
	[writeStreamingPreviewStateKey]?: WriteStreamingPreviewState;
}

function createWriteStreamingPreviewState(language: string | undefined, uiTheme: Theme): WriteStreamingPreviewState {
	return {
		previous: "",
		lineCount: 1,
		completeLength: 0,
		highlightedLines: [],
		highlighter: createHighlightStream(language, uiTheme),
		language,
		uiTheme,
		finalFlushedLength: -1,
		finalTrailing: "",
	};
}

/**
 * Advance line counting and syntax highlighting only across newly appended
 * content. Complete lines are retained because Ctrl+O can expand the preview;
 * the current partial line stays plain until its terminating newline arrives.
 * Once args are final, the trailing line is flushed through the highlighter
 * (its only push without a trailing newline) so a settled-but-queued preview
 * keeps syntax colors, including for one-line files.
 */
function updateStreamingPreview(
	streamKey: WriteStreamingPreviewStateCarrier | undefined,
	content: string,
	language: string | undefined,
	uiTheme: Theme,
	argsComplete = false,
): WriteStreamingPreviewState | undefined {
	if (streamKey === undefined) return undefined;

	let state = streamKey[writeStreamingPreviewStateKey];
	if (
		state === undefined ||
		state.language !== language ||
		state.uiTheme !== uiTheme ||
		content.length < state.previous.length ||
		!content.startsWith(state.previous) ||
		// A final flush consumed the trailing partial line; later growth would
		// re-feed it, so restart the parser instead of corrupting its state.
		(state.finalFlushedLength !== -1 && content.length !== state.finalFlushedLength)
	) {
		state = createWriteStreamingPreviewState(language, uiTheme);
		streamKey[writeStreamingPreviewStateKey] = state;
	}

	let completeLength = state.completeLength;
	for (let i = state.previous.length; i < content.length; i++) {
		if (content.charCodeAt(i) === 10) {
			state.lineCount++;
			completeLength = i + 1;
		}
	}
	if (completeLength > state.completeLength) {
		const chunk = content.slice(state.completeLength, completeLength).replace(/\r/g, "");
		let chunkHighlighted = chunk;
		if (state.highlighter) {
			try {
				chunkHighlighted = state.highlighter.push(chunk);
			} catch {
				state.highlighter = null;
			}
		}
		const lines = chunkHighlighted.split("\n");
		lines.pop();
		state.highlightedLines.push(...lines);
		state.completeLength = completeLength;
	}
	if (argsComplete && state.finalFlushedLength !== content.length && !content.endsWith("\n")) {
		const trailing = content.slice(state.completeLength).replace(/\r/g, "");
		if (trailing.length > 0) {
			let trailingHighlighted = trailing;
			if (state.highlighter) {
				try {
					trailingHighlighted = state.highlighter.push(trailing);
				} catch {
					state.highlighter = null;
				}
			}
			state.finalTrailing = trailingHighlighted;
			state.finalFlushedLength = content.length;
		}
	}
	state.previous = content;
	return state;
}

/**
 * Streaming preview rows: a tail window over the content, led by an
 * `… N earlier lines` marker once the head scrolls out. Line numbers keep a
 * fixed-width gutter so streamed rows stay byte-stable.
 */
function formatStreamingContent(
	content: string,
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	cache?: RenderedStringCache,
	streamKey?: WriteStreamingPreviewStateCarrier,
	argsComplete?: boolean,
): string[] {
	if (!content) return [];
	const bodyText = cachedRenderedString(cache, uiTheme, expanded, language ?? "", content, () => {
		const state = updateStreamingPreview(streamKey, content, language, uiTheme, argsComplete === true);
		let totalLines: number;
		let startIndex: number;
		let visibleLines: string[];
		if (state) {
			totalLines = state.lineCount;
			startIndex = expanded ? 0 : Math.max(0, totalLines - PREVIEW_LIMITS.EXPANDED_LINES);
			const flushed = argsComplete === true && state.finalFlushedLength === content.length;
			const trailingLine = flushed ? state.finalTrailing : content.slice(state.completeLength).replace(/\r/g, "");
			if (totalLines === 1 && trailingLine.length === 0) return "";
			visibleLines = [...state.highlightedLines.slice(startIndex), trailingLine];
		} else {
			const normalized = normalizeDisplayText(content);
			if (normalized.length === 0) return "";
			const lines = normalized.split("\n");
			totalLines = lines.length;
			startIndex = expanded ? 0 : Math.max(0, totalLines - PREVIEW_LIMITS.EXPANDED_LINES);
			visibleLines = highlightCode(lines.slice(startIndex).join("\n"), language);
		}
		const lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(totalLines).length);
		const rows: string[] = [];
		if (startIndex > 0) rows.push(formatMoreRow(startIndex, "line", uiTheme, { expanded, position: "earlier" }));
		for (let i = 0; i < visibleLines.length; i++) {
			const gutter = formatLineGutter(startIndex + i + 1, lineNumberWidth, uiTheme);
			rows.push(`${gutter}${replaceTabs(visibleLines[i] ?? "")}`);
		}
		return rows.join("\n");
	});
	return bodyText ? bodyText.split("\n") : [];
}

function wrapWritePreviewRows(lines: readonly string[], width: number): string[] {
	return lines.flatMap(line => {
		const gutter = /^(\x1b\[[0-9;]*m)( *\d+ )(\x1b\[[0-9;]*m)(.*)$/.exec(line);
		if (!gutter) return line;
		const prefix = `${gutter[1]}${gutter[2]}${gutter[3]}`;
		return wrapPrefixedLine(prefix, " ".repeat(Bun.stringWidth(gutter[2]!)), gutter[4] ?? "", width);
	});
}

/** The written file's head rows (`rawLines` are its display lines) and the count of lines hidden below them. */
function renderContentPreview(
	content: string,
	rawLines: readonly string[],
	expanded: boolean,
	language: string | undefined,
	uiTheme: Theme,
	cache?: RenderedStringCache,
): { lines: string[]; hidden: number } {
	const shown = expanded ? rawLines.length : Math.min(rawLines.length, WRITE_PREVIEW_LINES);
	if (shown === 0) return { lines: [], hidden: 0 };
	const text = cachedRenderedString(cache, uiTheme, expanded, language ?? "", content, () => {
		const highlighted = highlightCode(rawLines.slice(0, shown).join("\n"), language);
		const lineNumberWidth = Math.max(WRITE_GUTTER_MIN_WIDTH, String(rawLines.length).length);
		return highlighted
			.map((line, i) => `${formatLineGutter(i + 1, lineNumberWidth, uiTheme)}${replaceTabs(line)}`)
			.join("\n");
	});
	return { lines: text.split("\n"), hidden: rawLines.length - shown };
}

/** Render context for the write tool: resolves an `xd://`-mounted tool so its live renderer drives device dispatch previews. */
export interface WriteRenderContext {
	resolveXdevMounted?: (name: string) => XdevMountedRenderer | undefined;
	/** Original result metadata used only for filesystem link targets. */
	rawDetails?: unknown;
}

/** Process id and operation named by the text after `proc://`. */
function procWriteTarget(target: string): { id: string; action: ProcWriteAction } {
	if (target.endsWith("/kill")) return { id: target.slice(0, -5), action: "kill" };
	if (target.endsWith("/mode")) return { id: target.slice(0, -5), action: "mode" };
	return { id: target, action: "stdin" };
}

/** Transcript card for writes to a scheme with its own UI (peer message, process control, setting change). */
interface WriteUrlCard {
	/** Result details field whose presence identifies this card. */
	readonly detailsKey: "message" | "proc" | "cfg";
	/** Compact activity line for the text after `scheme://`. */
	activity(target: string): ToolActivitySummary;
	/** Pending call card when `result` is undefined, else the finished result card. */
	render(
		url: string,
		target: string,
		content: unknown,
		result: CardToolResult | undefined,
		details: WriteToolDetails | undefined,
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component;
}

/** Write cards keyed by URL scheme. */
const WRITE_URL_CARDS: Record<string, WriteUrlCard> = {
	agent: {
		detailsKey: "message",
		activity: target => ({ label: "Message", detail: target === "all" ? "broadcast" : target }),
		render: (_url, target, content, result, details, options, uiTheme) =>
			renderAgentWrite(
				target,
				typeof content === "string" ? content : "",
				result,
				details?.message,
				options,
				uiTheme,
			),
	},
	proc: {
		detailsKey: "proc",
		activity: target => {
			const { id, action } = procWriteTarget(target);
			return { label: "Process", detail: `${action} ${shortenPath(id)}` };
		},
		render: (_url, target, content, result, details, options, uiTheme) => {
			const { id, action } = procWriteTarget(target);
			return renderProcWrite(
				id,
				action,
				typeof content === "string" ? content : undefined,
				result,
				details?.proc,
				options,
				uiTheme,
			);
		},
	},
	cfg: {
		detailsKey: "cfg",
		activity: target => ({ label: "Config", detail: target }),
		render: (url, _target, content, result, details, options, uiTheme) =>
			renderCfgWrite(url, typeof content === "string" ? content : undefined, result, details?.cfg, options, uiTheme),
	},
};

/**
 * Card that renders a write to `rawPath` with the text after `scheme://` as its target.
 * Result details identify the card before the URL scheme does.
 */
function writeUrlCard(rawPath: string, details?: WriteToolDetails): { card: WriteUrlCard; target: string } | undefined {
	const url = splitUrlScheme(rawPath);
	const target = url?.rest ?? "";
	if (details) {
		for (const scheme in WRITE_URL_CARDS) {
			const card = WRITE_URL_CARDS[scheme];
			if (details[card.detailsKey] !== undefined) return { card, target };
		}
	}
	if (!url || !Object.hasOwn(WRITE_URL_CARDS, url.scheme)) return undefined;
	return { card: WRITE_URL_CARDS[url.scheme], target };
}

/** Whether a streaming lowercased path is, or could still become, a URL with its own write card. */
function couldBecomeWriteCardUrl(lowerPath: string): boolean {
	for (const scheme in WRITE_URL_CARDS) {
		const prefix = `${scheme}://`;
		if (prefix.startsWith(lowerPath) || lowerPath.startsWith(prefix)) return true;
	}
	return false;
}

/** Native view of a `proc://`, `agent://` or `cfg://` write. */
function describeWriteUrl(
	routed: { card: WriteUrlCard; target: string },
	url: string,
	content: unknown,
	result: CardToolResult | undefined,
	details: WriteToolDetails | undefined,
): NativeToolView {
	const body = typeof content === "string" ? content : undefined;
	switch (routed.card.detailsKey) {
		case "message":
			return describeAgentWrite(routed.target, body ?? "", result, details?.message);
		case "proc": {
			const { id, action } = procWriteTarget(routed.target);
			return describeProcWrite(id, action, body, result, details?.proc);
		}
		case "cfg":
			return describeCfgWrite(url, body, result, details?.cfg);
	}
}

function writeResolvedPath(rawDetails: unknown, fallback: string | undefined): string | undefined {
	return rawDetails !== null &&
		typeof rawDetails === "object" &&
		"resolvedPath" in rawDetails &&
		typeof rawDetails.resolvedPath === "string"
		? rawDetails.resolvedPath
		: fallback;
}

/** Native write head shared by the call and result: `Write · path · 22 lines`, executable/diagnostics chips. */
function writeToolHead(
	rawPath: string,
	content: string,
	details?: Pick<WriteToolDetails, "madeExecutable" | "resolvedPath" | "diagnostics">,
): NativeToolHead {
	const lineCount = countLines(content);
	const badges: { text: string; tone?: TspTone }[] = [];
	if (details?.madeExecutable) badges.push({ text: "executable", tone: "success" });
	const diagnostics = diagnosticsBadge([details?.diagnostics]);
	if (diagnostics) badges.push(diagnostics);
	return {
		title: "Write",
		target: rawPath ? sanitizeText(displayPath(rawPath)) : undefined,
		targetKind: "path",
		href: fileHref(details?.resolvedPath),
		meta: lineCount > 0 ? [formatCount("line", lineCount)] : undefined,
		badges: badges.length > 0 ? badges : undefined,
	};
}

/** Render file writes and delegated tool-device calls. */
export const writeToolRenderer = {
	/** Compact one-line activity: device writes read as the mounted tool (`LSP · references foo`), file writes as `Write · <path>`. */
	activitySummary(args: unknown, context: ToolActivityContext): ToolActivitySummary {
		const writeArgs = (args ?? {}) as WriteRenderArgs;
		const rawPath =
			typeof writeArgs.file_path === "string"
				? writeArgs.file_path
				: typeof writeArgs.path === "string"
					? writeArgs.path
					: "";
		if (!rawPath) return { label: "Write" };
		const routed = writeUrlCard(rawPath);
		if (routed) return routed.card.activity(routed.target);
		const xdev = parseXdUrl(rawPath);
		if (xdev?.name) {
			const resolveMounted = (context.renderContext as WriteRenderContext | undefined)?.resolveXdevMounted;
			return xdevActivitySummary(xdev.name, writeArgs.content, resolveMounted);
		}
		return { label: "Write", detail: shortenPath(rawPath) };
	},

	renderCall(
		args: WriteRenderArgs,
		options: RenderResultOptions & WriteStreamingPreviewStateCarrier & { renderContext?: WriteRenderContext },
		uiTheme: Theme,
	): Component | undefined {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		// Render NOTHING until the streamed path arrives and provably is not an
		// xd:// device. Device writes then render as queued until execution starts,
		// after which they delegate to the mounted tool's renderer.
		// A present-but-malformed path (array/object from a bad provider parse)
		// is definitively not xd:// — fall through to the legacy frame.
		if (args.path === undefined && args.file_path === undefined) return undefined;
		const pathSettled = args.content !== undefined || options.argsComplete === true;
		const hasStringPath = typeof args.file_path === "string" || typeof args.path === "string";
		if (hasStringPath && !pathSettled && couldBecomeWriteCardUrl(rawPath.toLowerCase())) return undefined;
		const routed = writeUrlCard(rawPath);
		if (routed)
			return routed.card.render(rawPath, routed.target, args.content, undefined, undefined, options, uiTheme);
		if (rawPath && couldBecomeXdUrl(rawPath)) {
			const xdev = parseXdUrl(rawPath);
			// The path string is settled once the content field started streaming.
			const pathSettled = args.content !== undefined;
			if (!xdev?.name || !pathSettled) return undefined;
			if (isResolutionDeviceName(xdev.name)) return renderResolutionDeviceCall(xdev.name, args.content, uiTheme);
			if (xdev.name === REPORT_ISSUE_DEVICE_NAME) return renderReportIssueDeviceCall(args.content, uiTheme);
			return renderXdevCall(xdev.name, args.content, options, uiTheme, options.renderContext?.resolveXdevMounted);
		}
		// The result has not resolved its target yet. Link the containing file
		// rather than an archive member or database row selector.
		const linkTarget = args.content !== undefined ? pendingFileLinkPath(rawPath) : undefined;
		const icon = options.executionStarted ? "running" : "pending";
		const status = writeStatus(icon, rawPath, linkTarget, uiTheme);
		// Raw content, not normalizeDisplayText(args.content): the collapsed
		// streaming path normalizes only its tail window, so a full-payload
		// normalize on every reveal tick would re-introduce the O(n²) streaming
		// cost formatStreamingContent avoids. Non-string content still falls
		// back to the normalizing stringify.
		const content = typeof args.content === "string" ? args.content : normalizeDisplayText(args.content);
		// Nothing streamed yet (a bare `\r` run normalizes to nothing): a flush status line.
		if (!/[^\r]/.test(content)) return plainToolCard(uiTheme, () => ({ status, phase: icon }));
		const lang = rawPath ? (getLanguageFromPath(rawPath) ?? "text") : "text";
		const streamingCache = createRenderedStringCache();
		return framedToolCard(
			uiTheme,
			({ contentWidth }) => ({
				status,
				phase: icon,
				footerMeta: options.argsComplete ? undefined : uiTheme.fg("dim", "streaming"),
				sections: [
					{
						content: wrapWritePreviewRows(
							formatStreamingContent(
								content,
								Boolean(options?.expanded),
								lang,
								uiTheme,
								streamingCache,
								// `options` is the ToolExecutionComponent's persistent
								// render-state object — a stable identity across reveal ticks
								// that keys the incremental preview state. `argsComplete`
								// flushes the trailing line through the highlighter once.
								options,
								options?.argsComplete,
							),
							contentWidth,
						),
					},
				],
			}),
			// The highlighted body in `streamingCache` does not depend on width, and re-highlighting every committed
			// card on each resize replay costs seconds; only the incremental highlighter state goes.
			{ onReleaseRenderCaches: () => delete options?.[writeStreamingPreviewStateKey] },
		);
	},

	renderResult(
		result: WriteResult,
		options: RenderResultOptions & WriteStreamingPreviewStateCarrier & { renderContext?: WriteRenderContext },
		uiTheme: Theme,
		args?: WriteRenderArgs,
	): Component {
		// Write merges call and result, so this builder runs once per display rebuild after the result arrives and the
		// call card never renders again: its incremental highlighter state is dead from here on.
		delete options[writeStreamingPreviewStateKey];
		const cardPath =
			typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
		const routed = writeUrlCard(cardPath, result.details);
		if (routed)
			return routed.card.render(cardPath, routed.target, args?.content, result, result.details, options, uiTheme);
		// xd:// dispatch results render as the mounted tool's own result.
		const xdev = result.details?.xdev;
		if (xdev) {
			const delegated = renderXdevResult(xdev, result, options, uiTheme, options.renderContext?.resolveXdevMounted);
			if (delegated) return delegated;
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			return new Text(uiTheme.fg("toolOutput", replaceTabs(text)), 0, 0);
		}
		const rawPath =
			typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
		const fileContent = normalizeDisplayText(args?.content);
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		// The header shows the cwd-relative path but links to the absolute path the
		// write resolved to (args.path may be relative, which would yield a broken
		// `file://` URI). Falls back to plain text when the result lacks a path.
		const linkTarget = writeResolvedPath(options.renderContext?.rawDetails, result.details?.resolvedPath);

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text;
			return plainToolCard(uiTheme, () => ({
				status: writeStatus("error", rawPath, linkTarget, uiTheme),
				phase: "error",
				body: [formatErrorText(errorText, uiTheme)],
			}));
		}

		const isPartial = options.isPartial === true;
		const progressText = result.content?.find(c => c.type === "text")?.text ?? "";
		const status: StatusLineOptions = {
			...writeStatus(isPartial ? "running" : "success", rawPath, linkTarget, uiTheme),
			badge: !isPartial && result.details?.madeExecutable ? { label: "executable", color: "success" } : undefined,
		};
		const diagnostics = isPartial ? undefined : result.details?.diagnostics;
		const rawLines = fileContent ? fileContent.split("\n") : [];
		const lineCount = rawLines.length > 0 ? formatCount("line", rawLines.length) : undefined;
		const progressRow =
			isPartial && progressText
				? uiTheme.fg("muted", truncateToWidth(replaceTabs(progressText), TRUNCATE_LENGTHS.LINE))
				: undefined;

		// No content block: a flush status line, with any progress or diagnostics beneath it.
		if (rawLines.length === 0) {
			return plainToolCard(uiTheme, () => {
				const diag = diagnosticsCardSection(diagnostics, options.expanded, uiTheme);
				return {
					status,
					phase: isPartial ? "partial" : "success",
					body: progressRow ? [progressRow] : undefined,
					sections: diag ? [flushDiagnosticsSection(diag)] : undefined,
				};
			});
		}

		const previewCache = createRenderedStringCache();
		return framedToolCard(
			uiTheme,
			({ contentWidth }) => {
				const { expanded } = options;
				const preview = renderContentPreview(fileContent, rawLines, expanded, lang, uiTheme, previewCache);
				const marker = preview.hidden > 0 ? formatMoreRow(preview.hidden, "line", uiTheme) : undefined;
				const diag = diagnosticsCardSection(diagnostics, expanded, uiTheme);
				const lines = wrapWritePreviewRows(preview.lines, contentWidth);
				if (progressRow) lines.unshift(progressRow);
				// The last section's marker rides the bottom border; the preview's stays in place above diagnostics.
				if (diag && marker) lines.push(marker);
				return {
					status,
					phase: isPartial ? "partial" : "success",
					footerMeta: uiTheme.fg(
						"dim",
						[lineCount, diag ? diag.marker : marker].filter(Boolean).join(uiTheme.sep.dot),
					),
					sections: [{ content: lines }, ...(diag ? [diag.section] : [])],
				};
			},
			// No release hook: `previewCache` holds the width-independent highlighted preview, which resize replay
			// would otherwise re-highlight for every committed card.
		);
	},
	describeCall(
		args: WriteRenderArgs,
		options: RenderResultOptions & { renderContext?: WriteRenderContext },
	): NativeToolView | undefined {
		const rawPath =
			typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
		// Same gating as renderCall: nothing until the path provably is not a device/card URL.
		if (args.path === undefined && args.file_path === undefined) return undefined;
		const pathSettled = args.content !== undefined || options.argsComplete === true;
		const hasStringPath = typeof args.file_path === "string" || typeof args.path === "string";
		if (hasStringPath && !pathSettled && couldBecomeWriteCardUrl(rawPath.toLowerCase())) return undefined;
		const routed = writeUrlCard(rawPath);
		if (routed) return describeWriteUrl(routed, rawPath, args.content, undefined, undefined);
		if (rawPath && couldBecomeXdUrl(rawPath)) {
			const xdev = parseXdUrl(rawPath);
			if (!xdev?.name || args.content === undefined) return undefined;
			if (isResolutionDeviceName(xdev.name)) return describeResolutionDeviceCall(xdev.name, args.content);
			if (xdev.name === REPORT_ISSUE_DEVICE_NAME) return describeReportIssueDeviceCall(args.content);
			return describeXdevCall(xdev.name, args.content, options, options.renderContext?.resolveXdevMounted);
		}
		const content = normalizeDisplayText(args.content);
		// A figure write draws as it arrives, over its streaming source.
		const figure = writeFigure(args, undefined, options);
		return {
			tool: writeToolHead(rawPath, content),
			body: content ? compact([describeFigure(figure), describeSource(rawPath, content)]) : [],
			preview: figure ? { lines: NATIVE_FIGURE_PREVIEW_LINES } : NATIVE_WRITE_PREVIEW,
		};
	},

	describeResult(
		result: WriteResult,
		options: RenderResultOptions & { renderContext?: WriteRenderContext },
		args?: WriteRenderArgs,
	): NativeToolView | undefined {
		const cardPath =
			typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
		const routed = writeUrlCard(cardPath, result.details);
		if (routed) return describeWriteUrl(routed, cardPath, args?.content, result, result.details);
		const xdev = result.details?.xdev;
		if (xdev) return describeXdevResult(xdev, result, options, options.renderContext?.resolveXdevMounted);
		const rawPath =
			typeof args?.file_path === "string" ? args.file_path : typeof args?.path === "string" ? args.path : "";
		const fileContent = normalizeDisplayText(args?.content);
		const isPartial = options.isPartial === true;
		const diagnostics = isPartial ? undefined : result.details?.diagnostics;
		const tool = writeToolHead(rawPath, fileContent, {
			madeExecutable: !isPartial && result.details?.madeExecutable === true,
			resolvedPath: writeResolvedPath(options.renderContext?.rawDetails, result.details?.resolvedPath),
			diagnostics,
		});
		if (result.isError) return { tool, tone: "error", body: [errorText(resultText(result))] };
		const progressText = resultText(result);
		// A figure write leads with the drawing, drawn as its fence in a reply;
		// its source follows below the collapsed clamp.
		const figure = writeFigure(args, result, options);
		const body = compact<NativeChild>([
			isPartial &&
				progressText.length > 0 &&
				node("text", { spans: [span(progressText, "muted")], truncate: "end" }),
			describeFigure(figure),
			fileContent.length > 0 && describeSource(rawPath, fileContent),
			diagnosticsSection(diagnostics),
		]);
		return { tool, body, preview: figure ? { lines: NATIVE_FIGURE_PREVIEW_LINES } : NATIVE_WRITE_PREVIEW };
	},
	figure: writeFigure,
	mergeCallAndResult: true,
	// The collapsed pending preview follows the streaming edge with a tail
	// window once the content outgrows it (`… N earlier lines` + last rows);
	// the first partial result re-anchors the frame to the top of the file, so
	// tail rows already committed to viewport/native scrollback would survive
	// as stale content above the new frame without a full replay. Expanded and
	// short previews stay top-anchored and skip the (scrollback-wiping) reset.
	forceFirstResultViewportRepaint: (args: unknown, options: RenderResultOptions) =>
		!options.expanded && exceedsLineCount(writeContentOf(args), PREVIEW_LIMITS.EXPANDED_LINES),
} satisfies ToolRenderer<WriteRenderArgs, WriteToolDetails>;
