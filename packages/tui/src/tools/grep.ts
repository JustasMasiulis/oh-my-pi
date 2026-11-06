import { isRecord } from "@oh-my-pi/pi-utils";
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
import { fileHyperlink } from "../render";
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
	createGroupedRowStyler,
	describeGroupedOutput,
	formatScopedSubject,
	groupedLinkTargets,
	groupLineIndicesByBlank,
	groupsByFile,
	renderSearchPreviewRows,
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
	 * `result.text` lines but uses a `│` gutter and `*` to mark match lines (vs space for
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

/** Flag arguments that differ from the defaults: `case:insensitive`, `gitignore:false`, `skip:N`. */
function grepFlagMeta(args: GrepRenderArgs): string[] {
	const meta: string[] = [];
	if (args.case === false) meta.push("case:insensitive");
	if (args.gitignore === false) meta.push("gitignore:false");
	if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);
	return meta;
}

/**
 * Header subject, `pattern in scope`. A result names the tool's display scope
 * (linked to the original search path); a call falls back to the requested paths.
 */
function grepSubject(
	pattern: string | undefined,
	args: GrepRenderArgs | undefined,
	uiTheme: Theme,
	details?: GrepToolDetails,
	searchPath?: string,
): string | undefined {
	let scope = details?.scopePath || undefined;
	if (scope && searchPath) scope = fileHyperlink(searchPath, scope);
	scope ??= toDisplayPathList(args?.path ?? args?.paths).join(", ") || undefined;
	return formatScopedSubject(pattern || undefined, scope, uiTheme);
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
				description: grepSubject(args.pattern, args, uiTheme),
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
		// The scope label links to the original (unsanitized) search path.
		const rawDetails = options.renderContext?.rawDetails;
		const searchPath =
			isRecord(rawDetails) && typeof rawDetails.searchPath === "string"
				? rawDetails.searchPath
				: details?.searchPath;
		const description = grepSubject(args?.pattern, args, uiTheme, details, searchPath);
		const status = (icon: ToolUIStatus, meta?: string[]): StatusLineOptions => ({
			icon,
			title: "Grep",
			description,
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
		// Classify the whole output so nested directory headers resolve across blank-line
		// groups. Display paths are cwd-relative (`searchPath` for results that predate
		// `cwd`); a single-file search's headerless lines belong to the searched file.
		const contexts = classifyGroupedLines(allLines, details?.cwd ?? details?.searchPath, details?.searchPath);
		const styleCodeFrame = createCodeFrameStyler(allLines, contexts, "toolOutput", uiTheme);
		const styleLine = createGroupedRowStyler(allLines, contexts, uiTheme, {
			linkTarget: groupedLinkTargets(contexts, textContent, details, rawDetails),
			styleBody: index => styleCodeFrame(index) ?? uiTheme.fg("toolOutput", allLines[index]!),
			linkLines: true,
		});
		const matchGroups = groupsByFile(groupLineIndicesByBlank(allLines), contexts);

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
	 * Inline (§7.3 grep): `Grep “pattern”  in src  5 matches · 2 files`, the scope
	 * leading the counts as in the terminal card, then
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
				tool: grepNativeHead(args, compact([scope, "0 matches"])),
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
		const head = grepNativeHead(args, compact([scope, counts]));
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
