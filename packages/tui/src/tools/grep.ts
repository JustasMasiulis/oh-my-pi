import * as path from "node:path";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Component } from "../tui";
import type {
	NativeToolHead,
	NativeToolView,
	RenderResultContextOptions,
	RenderResultOptions,
	ToolRenderer,
} from "./renderer";
import { compact } from "../native/describe";
import type { NativeChild } from "../native/node";
import { footnoteText, inlineErrorView, resultText } from "./native-view";
import { type Theme } from "../theme/theme";
import type { OutputMeta } from "./output-meta";
import type { TruncationResult } from "./streaming-output";
import { fileHyperlink, uriHyperlink } from "../render";
import type { StatusLineOptions } from "../render/status-line";
import { CardRowsMemo, plainToolCard } from "../render/tool-card";
import {
	clipRows,
	formatCount,
	formatErrorText,
	formatMissingPathRows,
	formatMoreRow,
	PREVIEW_LIMITS,
	replaceTabs,
	toDisplayPathList,
	type ToolUIStatus,
} from "../render/render-utils";
import {
	classifyGroupedLines,
	createCodeFrameStyler,
	describeGroupedOutput,
	formatGroupedFileHeader,
	groupLineIndicesByBlank,
	renderSearchPreviewRows,
	searchSubject,
	themeCodeFrameGutter,
} from "./grouped-file-output";

/** Display metadata for grep tool results. */
export interface GrepToolDetails {
	truncation?: TruncationResult;
	fileLimitReached?: number;
	perFileLimitReached?: number;
	linesTruncated?: boolean;
	meta?: OutputMeta;
	scopePath?: string;
	matchCount?: number;
	fileCount?: number;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	truncated?: boolean;
	error?: string;
	/** Pre-formatted text for the user-visible TUI render. Mirrors the model-facing
	 * `result.text` lines but uses the canonical `│` code-frame gutter (redrawn with
	 * the theme's rule at render time) and `*` to mark match lines (vs space for
	 * context). The TUI uses this directly so it never parses model-facing hashline anchors. */
	displayContent?: string;
	/** Filesystem hyperlink targets resolved for internal URL headers at execution time. */
	displayTargets?: Record<string, string>;
	/** Absolute base directory used during search. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
	/** Session cwd at search time. The renderer resolves the display-relative
	 * (cwd-relative) header/match paths against this for OSC 8 hyperlinks;
	 * `searchPath` is the scope label target, not the display-path base. */
	cwd?: string;
	/** User-supplied paths whose base directory was missing on disk. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface GrepRenderArgs {
	pattern: string;
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string | string[];
	case?: boolean;
	gitignore?: boolean;
	skip?: number;
}

const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;
/** Line budget for the expanded view. Larger than collapsed so expanding
 * reveals more matches with context, but still bounded so a single hot file
 * whose matches span the whole file can't dump its entire length. */
const EXPANDED_TEXT_LIMIT = PREVIEW_LIMITS.EXPANDED_LINES * 2;

/** Files a collapsed native grep shows (§7.3). */
const NATIVE_COLLAPSED_FILES = 2;

const SEARCH_CODE_FRAME_LINE_RE = /^\s*\*?(\d+)│/;

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!isRecord(value)) return false;
	for (const key in value) {
		if (typeof value[key] !== "string") return false;
	}
	return true;
}

function samePath(filePath: string): string {
	return filePath;
}

/** Keep only path metadata from the original details; display text always comes from sanitized details. */
function grepLinkTargets(details: GrepToolDetails | undefined, rawDetails: unknown) {
	if (details === rawDetails) {
		return {
			target: samePath,
			searchPath: details?.searchPath,
			fileScope: details?.searchPath,
			displayTargets: details?.displayTargets,
		};
	}
	const raw = typeof rawDetails === "object" && rawDetails !== null ? rawDetails : {};
	const rawCwd = "cwd" in raw && typeof raw.cwd === "string" ? raw.cwd : undefined;
	const rawSearchPath = "searchPath" in raw && typeof raw.searchPath === "string" ? raw.searchPath : undefined;
	const rawFiles = "files" in raw && isStringArray(raw.files) ? raw.files : undefined;
	const rawDisplayTargets =
		"displayTargets" in raw && isStringRecord(raw.displayTargets) ? raw.displayTargets : undefined;
	let displayTargets = details?.displayTargets;
	if (rawDisplayTargets) {
		displayTargets = {};
		for (const label in rawDisplayTargets) {
			displayTargets[sanitizeText(label)] = rawDisplayTargets[label]!;
		}
	}

	const pathTargets = new Map<string, string>();
	const displayBase = details?.cwd ?? details?.searchPath;
	const rawBase = rawCwd ?? rawSearchPath ?? displayBase;
	if (displayBase && rawBase && rawFiles && details?.files) {
		for (let index = 0; index < Math.min(details.files.length, rawFiles.length); index++) {
			const displayFile = path.resolve(displayBase, details.files[index]!);
			const rawFile = path.resolve(rawBase, rawFiles[index]!);
			pathTargets.set(displayFile, rawFile);
			// Folded directory headers must retain the original path as well.
			let displayDir = path.dirname(displayFile);
			let rawDir = path.dirname(rawFile);
			while (displayDir !== path.dirname(displayDir) && rawDir !== path.dirname(rawDir)) {
				pathTargets.set(displayDir, rawDir);
				displayDir = path.dirname(displayDir);
				rawDir = path.dirname(rawDir);
			}
		}
	}
	const target = (displayPath: string): string => {
		const known = pathTargets.get(displayPath);
		if (known) return known;
		if (rawCwd && details?.cwd) return path.resolve(rawCwd, path.relative(details.cwd, displayPath));
		return displayPath;
	};
	return {
		target,
		searchPath: rawSearchPath ?? details?.searchPath,
		fileScope: rawSearchPath ?? details?.searchPath,
		displayTargets,
	};
}

function parseSearchDisplayLineNumber(line: string): number | undefined {
	const match = SEARCH_CODE_FRAME_LINE_RE.exec(line);
	if (!match) return undefined;
	return Number.parseInt(match[1]!, 10);
}

const URL_HEADER_PREFIX_RE = /^#+\s+/;

/**
 * Build a memoized per-line styler for search display output. Classification
 * and URL-target tracking walk the whole output once (nested directory stacks
 * span blank-line groups), but styling and hyperlinking run only for the rows
 * a preview actually shows.
 */
function createSearchLineStyler(
	lines: readonly string[],
	headerBase: string | undefined,
	fileScope: string | undefined,
	uiTheme: Theme,
	displayTargets: Record<string, string> | undefined,
	target: (displayPath: string) => string,
): (index: number) => string {
	const contexts = classifyGroupedLines(lines, headerBase, fileScope);
	const styleCodeFrame = createCodeFrameStyler(lines, contexts, "toolOutput", uiTheme);
	// `classifyGroupedLines` can't resolve internal URLs (TUI-only), so track the
	// resolved URL target here and use it for the body lines that follow.
	const urlRaw: (string | undefined)[] = Array.from({ length: lines.length }, () => undefined);
	const urlFiles: (string | undefined)[] = Array.from({ length: lines.length }, () => undefined);
	let urlFile: string | undefined;
	for (let index = 0; index < lines.length; index++) {
		const ctx = contexts[index]!;
		if (ctx.kind === "dir") {
			urlFile = undefined;
		} else if (ctx.kind === "file") {
			if (ctx.isUrl) {
				const raw = lines[index]!.replace(URL_HEADER_PREFIX_RE, "")
					.trimEnd()
					.replace(/\s+\([^)]*\)\s*$/, "");
				urlRaw[index] = raw;
				urlFile = displayTargets?.[raw];
			} else {
				urlFile = undefined;
			}
		} else {
			urlFiles[index] = urlFile;
		}
	}
	const styledLines: (string | undefined)[] = Array.from({ length: lines.length }, () => undefined);
	return index => {
		const cached = styledLines[index];
		if (cached !== undefined) return cached;
		const line = lines[index]!;
		const ctx = contexts[index]!;
		let styled: string;
		// Directory header rows never reach here: previews drop them, since file
		// headers carry the full path.
		if (ctx.kind === "file") {
			const header = formatGroupedFileHeader(ctx, uiTheme);
			const raw = urlRaw[index];
			if (raw === undefined) {
				styled = ctx.headerPath ? fileHyperlink(target(ctx.headerPath), header) : header;
			} else {
				const resolved = displayTargets?.[raw];
				styled = resolved ? fileHyperlink(resolved, header) : uriHyperlink(raw, header);
			}
		} else {
			const tinted = styleCodeFrame(index) ?? uiTheme.fg("toolOutput", themeCodeFrameGutter(line, uiTheme));
			const lineNumber = parseSearchDisplayLineNumber(line);
			const filePath = ctx.filePath ? target(ctx.filePath) : urlFiles[index];
			styled = filePath && lineNumber !== undefined ? fileHyperlink(filePath, tinted, { line: lineNumber }) : tinted;
		}
		styledLines[index] = styled;
		return styled;
	};
}

/** Non-default flag arguments: `case:insensitive`, `gitignore:false`, `skip:N`. */
function grepFlagMeta(args: GrepRenderArgs): string[] {
	const meta: string[] = [];
	if (args.case === false) meta.push("case:insensitive");
	if (args.gitignore === false) meta.push("gitignore:false");
	if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);
	return meta;
}

/** Render grep calls and results in the transcript. */
export const grepToolRenderer = {
	inline: true,
	renderCall(args: GrepRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const meta = grepFlagMeta(args);
		return plainToolCard(uiTheme, () => ({
			status: {
				icon: options.executionStarted ? "running" : "pending",
				spinnerFrame: options.spinnerFrame,
				title: "Grep",
				description: searchSubject(args.pattern, args.path ?? args.paths, uiTheme),
				meta,
			},
		}));
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GrepToolDetails; isError?: boolean },
		options: RenderResultContextOptions,
		uiTheme: Theme,
		args?: GrepRenderArgs,
	): Component {
		const details = result.details;
		const linkTargets = grepLinkTargets(details, options.renderContext?.rawDetails);
		let scope = details?.scopePath || undefined;
		if (scope && linkTargets.searchPath) scope = fileHyperlink(linkTargets.searchPath, scope);
		const status = (icon: ToolUIStatus, meta?: string[]): StatusLineOptions => ({
			icon,
			title: "Grep",
			description: searchSubject(args?.pattern, args?.path ?? args?.paths, uiTheme, scope),
			meta,
		});

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return plainToolCard(uiTheme, () => ({
				status: status("error"),
				phase: "error",
				body: [formatErrorText(errorText, uiTheme)],
			}));
		}

		const missingRows = formatMissingPathRows(details?.missingPaths ?? [], uiTheme);
		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;
		const textContent = details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const matchCount = details?.matchCount ?? 0;

		if (hasDetailedData ? matchCount === 0 : !textContent || textContent === "No matches found") {
			return plainToolCard(uiTheme, () => ({
				status: status("warning", ["0 matches"]),
				phase: "warning",
				body: missingRows.length > 0 ? missingRows : undefined,
			}));
		}

		// Rows are clipped, never wrapped; recomputed only when width or expansion changes.
		const memo = new CardRowsMemo();
		const cachedRows = (width: number, build: (expanded: boolean) => string[]): readonly string[] =>
			memo.rows(width, options.expanded, () => clipRows(build(options.expanded), width));
		const cardOptions = memo.cardOptions;

		if (!hasDetailedData) {
			const lines = textContent.split("\n").filter(line => line.trim() !== "");
			return plainToolCard(
				uiTheme,
				() => ({
					status: status("success", [formatCount("item", lines.length)]),
					phase: "success",
					body: width =>
						cachedRows(width, expanded => {
							const limit =
								expanded || lines.length <= COLLAPSED_TEXT_LIMIT ? lines.length : COLLAPSED_TEXT_LIMIT - 1;
							const rows = lines.slice(0, limit).map(line => uiTheme.fg("toolOutput", replaceTabs(line)));
							if (limit < lines.length) rows.push(formatMoreRow(lines.length - limit, "item", uiTheme));
							return rows;
						}),
				}),
				cardOptions,
			);
		}

		const truncation = details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || limits?.columnTruncated);
		const meta = [formatCount("match", matchCount), formatCount("file", details?.fileCount ?? 0)];
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));

		const allLines = textContent.split("\n");
		// Resolve hyperlinks once over the whole output so a nested directory stack
		// reconstructs correctly across blank-line group boundaries.
		// Header/match display paths are cwd-relative, so resolve them against cwd
		// (falling back to searchPath for legacy results that predate `cwd`); the
		// scoped file's absolute path seeds body lines in single-file searches.
		const styleLine = createSearchLineStyler(
			allLines,
			details?.cwd ?? details?.searchPath,
			linkTargets.fileScope,
			uiTheme,
			linkTargets.displayTargets,
			linkTargets.target,
		);
		const matchGroups = groupLineIndicesByBlank(allLines);

		return plainToolCard(
			uiTheme,
			() => ({
				status: status(truncated ? "warning" : "success", meta),
				phase: truncated ? "warning" : "success",
				body: width =>
					cachedRows(width, expanded => {
						const rows = renderSearchPreviewRows(
							matchGroups,
							allLines,
							styleLine,
							{
								collapsedMaxLines: Math.max(1, COLLAPSED_TEXT_LIMIT - missingRows.length),
								expandedMaxLines: Math.max(1, EXPANDED_TEXT_LIMIT - missingRows.length),
								matchCount,
								expanded,
							},
							uiTheme,
						);
						rows.push(...missingRows);
						return rows;
					}),
			}),
			cardOptions,
		);
	},
	describeCall(args: GrepRenderArgs): NativeToolView {
		return { tool: grepNativeHead(args), inline: true };
	},

	/**
	 * Inline (§7.3 grep): `Grep “pattern”  5 matches · 2 files  in src`, then
	 * the matches grouped by file; collapsed shows the first two files.
	 */
	describeResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GrepToolDetails; isError?: boolean },
		options: RenderResultOptions,
		args?: GrepRenderArgs,
	): NativeToolView {
		const details = result.details;
		if (result.isError || details?.error) {
			return inlineErrorView(grepNativeHead(args), details?.error || resultText(result) || "Unknown error");
		}
		const textContent = details?.displayContent ?? resultText(result);
		const missing = details?.missingPaths ?? [];
		const missingNote = missing.length > 0 ? `skipped missing: ${missing.join(", ")}` : undefined;
		const scope = details?.scopePath ? `in ${details.scopePath}` : undefined;
		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;
		const matchCount = details?.matchCount ?? 0;
		if (
			(!hasDetailedData && (!textContent || textContent === "No matches found")) ||
			(hasDetailedData && matchCount === 0)
		) {
			const foot = footnoteText(compact([missingNote]));
			return {
				tool: grepNativeHead(args, compact(["0 matches", scope])),
				tone: "warning",
				inline: true,
				body: foot ? [foot] : undefined,
			};
		}
		const truncated = Boolean(
			details?.truncated || details?.meta?.truncation || details?.meta?.limits?.columnTruncated,
		);
		const fileCount = details?.fileCount ?? 0;
		const counts = hasDetailedData
			? `${formatCount("match", matchCount)} · ${formatCount("file", fileCount)}`
			: undefined;
		const head = grepNativeHead(args, compact([counts, scope]));
		const hiddenFiles = options.expanded ? 0 : Math.max(0, fileCount - NATIVE_COLLAPSED_FILES);
		const foot = footnoteText(
			compact([hiddenFiles > 0 && formatCount("more file", hiddenFiles), missingNote]),
			details?.meta,
		);
		return {
			tool: truncated ? { ...head, badges: [{ text: "truncated", tone: "warning" }] } : head,
			inline: true,
			body: compact<NativeChild>([
				...describeGroupedOutput(textContent.split("\n"), {
					maxFiles: options.expanded ? undefined : NATIVE_COLLAPSED_FILES,
					file: details?.files?.length === 1 ? details.files[0] : undefined,
				}),
				foot,
			]),
			preview: { lines: PREVIEW_LIMITS.EXPANDED_LINES },
		};
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<GrepRenderArgs, GrepToolDetails>;

/** Native grep head: the pattern, then the result `meta` or, before a result, the scope/flag arguments. */
function grepNativeHead(args: GrepRenderArgs | undefined, meta?: readonly string[]): NativeToolHead {
	const parts = meta ? [...meta] : [];
	if (!meta && args) {
		const paths = toDisplayPathList(args.path ?? args.paths);
		if (paths.length) parts.push(`in ${paths.join(", ")}`);
		parts.push(...grepFlagMeta(args));
	}
	return { title: "Grep", target: args?.pattern || "?", targetKind: "pattern", meta: parts };
}
