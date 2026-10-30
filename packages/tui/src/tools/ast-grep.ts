import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { Ellipsis } from "@oh-my-pi/pi-natives";
import type { Component } from "../tui";
import type { Theme } from "../theme/theme";
import { fileHyperlink } from "../render";
import type { StatusLineOptions } from "../render/status-line";
import { plainToolCard } from "../render/tool-card";
import {
	appendParseErrorsBulletList,
	formatCount,
	formatErrorText,
	formatParseErrorsCountLabel,
	formatScopedSubject,
	PREVIEW_LIMITS,
	toDisplayPathList,
	type ToolUIStatus,
} from "../render/render-utils";
import { truncateToWidth } from "../utils";
import {
	classifyGroupedLines,
	describeGroupedOutput,
	formatGroupedFileHeader,
	groupLineIndicesByBlank,
	renderSearchPreviewRows,
	themeCodeFrameGutter,
} from "./grouped-file-output";
import { code, compact, node, span } from "../native/describe";
import type { NativeChild } from "../native/node";
import { errorText, noteText, resultText, toolHead } from "./native-view";
import type { OutputMeta } from "./output-meta";
import type { NativeToolView, RenderResultContextOptions, RenderResultOptions, ToolRenderer } from "./renderer";

/** Display metadata returned by ast-grep. */
export interface AstGrepToolDetails {
	matchCount: number;
	fileCount: number;
	filesSearched: number;
	limitReached: boolean;
	parseErrors?: string[];
	/** Total parse error count before {@link PARSE_ERRORS_LIMIT} capping. Omitted when no errors. */
	parseErrorsTotal?: number;
	scopePath?: string;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	/** Pre-formatted text for the user-visible TUI render. Mirrors `result.text` lines but uses
	 * the canonical `│` code-frame gutter (redrawn with the theme's rule at render time) and `*`
	 * to mark match lines. The TUI uses this directly so it never parses model-facing text. */
	displayContent?: string;
	/** Absolute base directory used during search. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
	/** Session cwd at search time. Display header/match paths are cwd-relative, so
	 * the renderer resolves them against this; `searchPath` is the scope target. */
	cwd?: string;
}

interface AstGrepRenderArgs {
	pat?: string;
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string[];
	skip?: number;
}

const COLLAPSED_MATCH_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;
const EXPANDED_MATCH_LIMIT = PREVIEW_LIMITS.EXPANDED_LINES * 2;

/** `pattern in scope`, the same in the call and the result. */
function astGrepSubject(args: AstGrepRenderArgs | undefined, theme: Theme, scope?: string): string | undefined {
	if (!args?.pat) return undefined;
	const paths = toDisplayPathList(args.path ?? args.paths);
	return formatScopedSubject(args.pat, scope ?? (paths.length > 0 ? paths.join(", ") : undefined), theme);
}

/** Render AST grep calls and results. */
export const astGrepToolRenderer = {
	inline: true,
	renderCall(args: AstGrepRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);
		return plainToolCard(uiTheme, () => ({
			status: {
				icon: options.executionStarted ? "running" : "pending",
				spinnerFrame: options.spinnerFrame,
				title: "AST Grep",
				description: astGrepSubject(args, uiTheme),
				meta,
			},
		}));
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstGrepToolDetails; isError?: boolean },
		options: RenderResultContextOptions,
		uiTheme: Theme,
		args?: AstGrepRenderArgs,
	): Component {
		const details = result.details;
		const status = (icon: ToolUIStatus, meta?: string[]): StatusLineOptions => ({
			icon,
			title: "AST Grep",
			description: astGrepSubject(args, uiTheme, details?.scopePath),
			meta,
		});

		if (result.isError) {
			const message = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return plainToolCard(uiTheme, () => ({
				status: status("error"),
				phase: "error",
				body: [formatErrorText(message, uiTheme)],
			}));
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;

		if (matchCount === 0) {
			const meta = ["0 matches"];
			if (filesSearched > 0) meta.push(`searched ${filesSearched}`);
			const body: string[] = [];
			if (details?.parseErrors?.length) {
				body.push(uiTheme.fg("warning", "Query may be mis-scoped; narrow `path` before concluding absence"));
				appendParseErrorsBulletList(body, details.parseErrors, uiTheme, details.parseErrorsTotal);
			}
			return plainToolCard(uiTheme, () => ({
				status: status("warning", meta),
				phase: "warning",
				body: body.length > 0 ? body : undefined,
			}));
		}

		const meta = [formatCount("match", matchCount), formatCount("file", fileCount), `searched ${filesSearched}`];
		if (limitReached) meta.push(uiTheme.fg("warning", "limit reached"));

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allLines = textContent.split("\n");
		// Resolve hyperlinks over the whole output so nested directory headers
		// reconstruct across blank-line groups.
		const contexts = classifyGroupedLines(allLines, details?.cwd ?? details?.searchPath, details?.searchPath);
		// The displayed lines are sanitized, but OSC 8 destinations must retain the
		// original path bytes. Only substitute targets for headers already linked
		// by the sanitized output; never let raw text create additional links.
		const rawDetails = options.renderContext?.rawDetails;
		const rawContent =
			isRecord(rawDetails) && typeof rawDetails.displayContent === "string" ? rawDetails.displayContent : undefined;
		const rawLines = rawContent?.split("\n");
		const rawCwd = isRecord(rawDetails) && typeof rawDetails.cwd === "string" ? rawDetails.cwd : undefined;
		const rawSearchPath =
			isRecord(rawDetails) && typeof rawDetails.searchPath === "string" ? rawDetails.searchPath : undefined;
		const rawContexts =
			rawContent !== undefined && rawLines?.length === allLines.length && sanitizeText(rawContent) === textContent
				? classifyGroupedLines(rawLines, rawCwd ?? rawSearchPath, rawSearchPath)
				: undefined;
		// Style lazily: the collapsed preview only shows the first few rows, so a
		// large result never styles/hyperlinks rows nobody sees.
		const styledLines: (string | undefined)[] = Array.from({ length: allLines.length }, () => undefined);
		const styleLine = (index: number): string => {
			const cached = styledLines[index];
			if (cached !== undefined) return cached;
			const line = allLines[index]!;
			const ctx = contexts[index]!;
			const rawContext = rawContexts?.[index];
			const target =
				ctx.headerPath && rawContext?.kind === ctx.kind && rawContext.depth === ctx.depth
					? (rawContext.headerPath ?? ctx.headerPath)
					: ctx.headerPath;
			let styled: string;
			// Directory header rows never reach here: previews drop them, since
			// file headers carry the full path.
			if (ctx.kind === "file") {
				const header = formatGroupedFileHeader(ctx, uiTheme);
				styled = target ? fileHyperlink(target, header) : header;
			} else {
				styled = uiTheme.fg(line.startsWith("  meta:") ? "dim" : "toolOutput", themeCodeFrameGutter(line, uiTheme));
			}
			styledLines[index] = styled;
			return styled;
		};
		const matchGroups = groupLineIndicesByBlank(allLines).filter(indices => {
			const first = allLines[indices[0]!]!;
			return !first.startsWith("Result limit reached") && !first.startsWith("Parse issues:");
		});

		const extraLines: string[] = [];
		if (limitReached) {
			extraLines.push(uiTheme.fg("warning", "limit reached; narrow path or use skip"));
		}
		if (details?.parseErrors?.length) {
			extraLines.push(
				uiTheme.fg("warning", formatParseErrorsCountLabel(details.parseErrors, details.parseErrorsTotal)),
			);
		}

		// Rows are clipped, never wrapped; recomputed only when width or expansion changes.
		let memo: { width: number; expanded: boolean; rows: readonly string[] } | undefined;
		return plainToolCard(
			uiTheme,
			() => ({
				status: status(limitReached ? "warning" : "success", meta),
				phase: limitReached ? "warning" : "success",
				body: width => {
					const expanded = options.expanded;
					if (memo?.width !== width || memo.expanded !== expanded) {
						const budget = (expanded ? EXPANDED_MATCH_LIMIT : COLLAPSED_MATCH_LIMIT) - extraLines.length;
						const rows = renderSearchPreviewRows(
							matchGroups,
							allLines,
							styleLine,
							{ maxLines: budget, matchCount, expanded },
							uiTheme,
						);
						rows.push(...extraLines);
						memo = { width, expanded, rows: rows.map(row => truncateToWidth(row, width, Ellipsis.Omit)) };
					}
					return memo.rows;
				},
			}),
			{ onInvalidate: () => (memo = undefined), onReleaseRenderCaches: () => (memo = undefined) },
		);
	},
	describeCall(args: AstGrepRenderArgs): NativeToolView {
		const meta: string[] = [];
		const scopePaths = toDisplayPathList(args.path ?? args.paths);
		if (scopePaths.length) meta.push(`in ${scopePaths.join(", ")}`);
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);
		return { head: toolHead("AST Grep", span(args.pat ?? "?", "code"), ...meta) };
	},

	describeResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstGrepToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		args?: AstGrepRenderArgs,
	): NativeToolView {
		const details = result.details;
		const pattern = span(args?.pat ?? "?", "code");
		if (result.isError) {
			return {
				head: toolHead("AST Grep", pattern),
				tone: "error",
				body: [errorText(resultText(result) || "Unknown error")],
			};
		}
		const matchCount = details?.matchCount ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;
		const parseErrors = details?.parseErrors ?? [];
		const parseNote =
			parseErrors.length > 0
				? node(
						"section",
						{
							head: [span(formatParseErrorsCountLabel(parseErrors, details?.parseErrorsTotal), "warning")],
							collapsible: true,
							collapsed: true,
						},
						[code(parseErrors.join("\n"))],
						"parse-errors",
					)
				: undefined;
		if (matchCount === 0) {
			const meta = ["0 matches"];
			if (details?.scopePath) meta.push(`in ${details.scopePath}`);
			if (filesSearched > 0) meta.push(`searched ${filesSearched}`);
			return {
				head: toolHead("AST Grep", pattern, ...meta),
				tone: "warning",
				body: compact<NativeChild>([
					noteText("No matches found"),
					parseErrors.length > 0 &&
						noteText("Query may be mis-scoped; narrow `path` before concluding absence", "warning"),
					parseNote,
				]),
			};
		}
		const meta = [formatCount("match", matchCount), formatCount("file", details?.fileCount ?? 0)];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		meta.push(`searched ${filesSearched}`);
		const head = toolHead("AST Grep", pattern, ...meta);
		if (limitReached) head.push(span(" limit reached", "warning"));
		const allLines = (details?.displayContent ?? resultText(result)).split("\n");
		const kept = groupLineIndicesByBlank(allLines)
			.filter(indices => {
				const first = allLines[indices[0]!]!;
				return !first.startsWith("Result limit reached") && !first.startsWith("Parse issues:");
			})
			.flatMap(indices => [...indices.map(index => allLines[index]!), ""]);
		return {
			head,
			body: compact<NativeChild>([
				...describeGroupedOutput(kept),
				limitReached && noteText("limit reached; narrow path or use skip", "warning"),
				parseNote,
			]),
			preview: { lines: COLLAPSED_MATCH_LIMIT },
		};
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<AstGrepRenderArgs, AstGrepToolDetails>;
