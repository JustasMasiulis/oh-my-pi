import type { Component } from "../tui";
import { replaceTabs } from "../utils";
import type { Theme } from "../theme/theme";
import { Ellipsis, fileHyperlink, truncateToWidth } from "../render";
import type { StatusLineOptions } from "../render/status-line";
import { framedToolCard, plainToolCard } from "../render/tool-card";
import {
	formatCount,
	formatErrorText,
	formatMoreItems,
	formatMoreRow,
	formatParseErrorsCountLabel,
	formatScopedSubject,
	PREVIEW_LIMITS,
} from "../render/render-utils";
import {
	classifyGroupedLines,
	formatGroupedFileHeader,
	groupedHeaderLinkTargets,
	groupLineIndicesByBlank,
	walkGroupedOutput,
} from "./grouped-file-output";
import type { OutputMeta } from "./output-meta";
import type {
	NativeToolHead,
	NativeToolView,
	RenderResultContextOptions,
	RenderResultOptions,
	ToolRenderer,
} from "./renderer";
import { code, compact, diff, node, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { diffStatsMeta, displayPath, errorText, fileDiffSection, noteText, resultText, statsText } from "./native-view";

/** Display metadata returned by ast-edit. */
export interface AstEditToolDetails {
	totalReplacements: number;
	filesTouched: number;
	filesSearched: number;
	applied: boolean;
	limitReached: boolean;
	parseErrors?: string[];
	/** Total parse error count before {@link PARSE_ERRORS_LIMIT} capping. Omitted when no errors. */
	parseErrorsTotal?: number;
	scopePath?: string;
	files?: string[];
	fileReplacements?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	/** Pre-formatted text for the user-visible TUI render. Mirrors `result.text` lines but uses
	 * a `│` gutter (no model-only hashline anchors). The TUI uses this directly so it never parses model-facing text. */
	displayContent?: string;
	/** Absolute base directory used during the edit. Used by the renderer to resolve
	 * display-relative paths to absolute paths for OSC 8 hyperlinks. */
	searchPath?: string;
	/** Session cwd at edit time. Display header paths are cwd-relative, so the
	 * renderer resolves them against this; `searchPath` is the scope target. */
	cwd?: string;
}

interface AstEditRenderArgs {
	ops?: Array<{ pat?: string; out?: string }>;
	paths?: string[];
}

const COLLAPSED_CHANGE_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

/**
 * Flatten change groups (line indices, styled on demand) into frame body
 * lines. Groups are separated by a blank line and carry no tree guides — the
 * frame border is the container, so nested `├─ │` gutters would just be
 * noise. Collapsed mode always shows at least the first group, then fills up
 * to `budget` lines; `remaining` counts the groups left out.
 */
function buildChangeBody(
	groups: readonly (readonly number[])[],
	styleLine: (index: number) => string,
	expanded: boolean,
	budget: number,
): { lines: string[]; remaining: number } {
	const lines: string[] = [];
	let shown = 0;
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i]!;
		const separator = shown > 0 ? 1 : 0;
		// Always emit the first group; budget only gates subsequent ones.
		if (!expanded && shown > 0 && lines.length + separator + group.length > budget) break;
		if (separator) lines.push("");
		for (const index of group) lines.push(styleLine(index));
		shown++;
	}
	return { lines, remaining: groups.length - shown };
}

/** One-line header preview of an AST pattern. `renderStatusLine` only flattens
 * CR/LF, so a multi-line tab-indented pattern would otherwise punch raw tabs
 * into the status line; collapse all whitespace runs to single spaces. */
function patternPreview(pat: string | undefined): string | undefined {
	const collapsed = pat?.replace(/\s+/g, " ").trim();
	return collapsed || undefined;
}

/** The single rewrite's pattern preview, or `N rewrites` for several. */
function rewriteLabel(args: AstEditRenderArgs | undefined): string | undefined {
	const rewriteCount = args?.ops?.length ?? 0;
	if (rewriteCount === 1) return patternPreview(args?.ops?.[0]?.pat);
	return rewriteCount > 1 ? `${rewriteCount} rewrites` : undefined;
}

/** Header subject, identical across the call and result: `pattern in scope` (or `N rewrites in scope`). */
function astEditSubject(args: AstEditRenderArgs | undefined, theme: Theme, scopePath?: string): string | undefined {
	const scope = args?.paths?.length ? args.paths.join(", ") : scopePath;
	return formatScopedSubject(rewriteLabel(args), scope, theme);
}

const AST_EDIT_CHANGE_LINE_RE = /^([+\- ])\s*(\d+)(?:│|[:|])(.*)$/;

/** One file's proposed rewrite: its unified diff text and change counts. */
interface AstEditFileDiff {
	path: string;
	lines: string[];
	added: number;
	removed: number;
	lastOld?: number;
}

/**
 * Parse ast-edit display content (`# dir/`, `## file (N replacements)`,
 * `-12│old` / `+12│new`) into one unified diff per file.
 */
function parseAstEditChanges(lines: readonly string[]): AstEditFileDiff[] {
	const files: AstEditFileDiff[] = [];
	let file: AstEditFileDiff | undefined;
	const flush = () => {
		if (file && file.lines.length > 0) files.push(file);
		file = undefined;
	};
	for (const event of walkGroupedOutput(lines)) {
		if (event.kind !== "line") {
			flush();
			if (event.kind === "file") file = { path: event.path, lines: [], added: 0, removed: 0 };
			continue;
		}
		if (!file) continue;
		const change = AST_EDIT_CHANGE_LINE_RE.exec(event.text);
		if (!change) continue;
		const lineNumber = Number.parseInt(change[2]!, 10);
		if (file.lastOld === undefined || lineNumber > file.lastOld + 1 || lineNumber < file.lastOld) {
			file.lines.push(`@@ -${lineNumber} +${lineNumber} @@`);
		}
		file.lastOld = lineNumber;
		if (change[1] === "+") file.added++;
		else if (change[1] === "-") file.removed++;
		file.lines.push(`${change[1]}${change[3]}`);
	}
	flush();
	return files;
}

/** A file's proposed rewrite as a `diff`: Tern highlights it by the file's grammar and draws no path header. */
function astEditDiff(file: AstEditFileDiff): NativeNode {
	return diff(file.lines.join("\n"), { path: file.path });
}

/** The single rewrite pattern (`target:"pattern"`), or the rewrite count, for the head. */
function astEditPatternHead(args: AstEditRenderArgs | undefined): Pick<NativeToolHead, "target" | "targetKind"> {
	const rewriteCount = args?.ops?.length ?? 0;
	if (rewriteCount === 1) {
		const pattern = patternPreview(args?.ops?.[0]?.pat);
		return pattern ? { target: pattern, targetKind: "pattern" } : {};
	}
	return rewriteCount > 1 ? { target: `${rewriteCount} rewrites`, targetKind: "text" } : {};
}

/** Scope facts for the final quiet line: `in src · searched 12 files · limit reached; narrow path`. */
function astEditScopeStats(details: AstEditToolDetails | undefined): NativeNode | undefined {
	const parts: string[] = [];
	if (details?.scopePath) parts.push(`in ${details.scopePath}`);
	if (details?.filesSearched) parts.push(`searched ${formatCount("file", details.filesSearched)}`);
	if (details?.limitReached) parts.push("limit reached; narrow path");
	return statsText(parts);
}

/** Render AST edit calls and results. */
export const astEditToolRenderer = {
	inline: true,
	renderCall(args: AstEditRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const icon = options.executionStarted ? "running" : "pending";
		// The call has no content block yet: a flush status line.
		return plainToolCard(uiTheme, () => ({
			status: {
				icon,
				spinnerFrame: options.spinnerFrame,
				title: "AST Edit",
				description: astEditSubject(args, uiTheme),
			},
			phase: icon,
		}));
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstEditToolDetails; isError?: boolean },
		options: RenderResultContextOptions,
		uiTheme: Theme,
		args?: AstEditRenderArgs,
	): Component {
		const details = result.details;
		const description = astEditSubject(args, uiTheme, details?.scopePath);

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text;
			return plainToolCard(uiTheme, () => ({
				status: { icon: "error", title: "AST Edit", description },
				phase: "error",
				body: [formatErrorText(errorText, uiTheme)],
			}));
		}

		const totalReplacements = details?.totalReplacements ?? 0;
		const filesTouched = details?.filesTouched ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;
		const parseErrors = details?.parseErrors ?? [];

		if (totalReplacements === 0) {
			const meta = ["0 replacements"];
			if (filesSearched > 0) meta.push(`searched ${formatCount("file", filesSearched)}`);
			// The count rides on the status line; only parse errors are worth a body.
			const hiddenParseErrors = (details?.parseErrorsTotal ?? parseErrors.length) - parseErrors.length;
			const parseRows = parseErrors.map(error => uiTheme.fg("warning", replaceTabs(error)));
			if (hiddenParseErrors > 0) {
				parseRows.push(uiTheme.fg("dim", formatMoreItems(hiddenParseErrors, "parse issue", uiTheme)));
			}
			return plainToolCard(uiTheme, () => ({
				status: { icon: "warning", title: "AST Edit", description, meta },
				phase: "warning",
				sections:
					parseRows.length > 0
						? [{ label: formatParseErrorsCountLabel(parseErrors, details?.parseErrorsTotal), content: parseRows }]
						: undefined,
			}));
		}

		const summaryParts = [formatCount("replacement", totalReplacements), formatCount("file", filesTouched)];
		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allLines = textContent.split("\n");
		// Resolve hyperlinks over the whole output so nested directory headers
		// reconstruct across blank-line groups.
		const contexts = classifyGroupedLines(allLines, details?.cwd ?? details?.searchPath, details?.searchPath);
		const linkTarget = groupedHeaderLinkTargets(contexts, textContent, options.renderContext?.rawDetails);
		// Style lazily: collapsed bodies show only the first groups.
		const styledLines: (string | undefined)[] = Array.from({ length: allLines.length }, () => undefined);
		const styleLine = (index: number): string => {
			const cached = styledLines[index];
			if (cached !== undefined) return cached;
			const ctx = contexts[index]!;
			// Swap the inner code-frame gutter `│` for a space so it does not nest a
			// second vertical bar inside the frame border.
			const display = replaceTabs(allLines[index]!.replace("│", " "));
			let styled: string;
			// Directory header rows never reach here: the change groups drop them,
			// since file headers carry the full path.
			if (ctx.kind === "file") {
				const header = formatGroupedFileHeader(ctx, uiTheme);
				const target = linkTarget(index);
				styled = target ? fileHyperlink(target, header) : header;
			} else if (display.startsWith("+")) {
				styled = uiTheme.fg("toolDiffAdded", display);
			} else if (display.startsWith("-")) {
				styled = uiTheme.fg("toolDiffRemoved", display);
			} else {
				styled = uiTheme.fg("toolOutput", display);
			}
			styledLines[index] = styled;
			return styled;
		};
		const changeGroups = groupLineIndicesByBlank(allLines)
			.filter(indices => {
				const first = allLines[indices[0]!]!;
				return !first.startsWith("Safety cap reached") && !first.startsWith("Parse issues:");
			})
			.map(indices => indices.filter(index => contexts[index]!.kind !== "dir"))
			.filter(indices => indices.length > 0);

		const icon = limitReached ? "warning" : options.isPartial ? "running" : "success";
		const status: StatusLineOptions = {
			icon,
			title: "AST Edit",
			description,
			badge: details?.applied ? undefined : { label: "proposed", color: "warning" },
		};

		const extraLines: string[] = [];
		if (limitReached) extraLines.push(uiTheme.fg("warning", "limit reached; narrow path"));
		if (parseErrors.length > 0) {
			extraLines.push(uiTheme.fg("warning", formatParseErrorsCountLabel(parseErrors, details?.parseErrorsTotal)));
		}
		// The body is spinner-invariant: rebuild it only on expansion/width change.
		let bodyMemo:
			| { expanded: boolean; width: number; lines: readonly string[]; marker: string | undefined }
			| undefined;
		return framedToolCard(
			uiTheme,
			({ contentWidth }) => {
				const expanded = Boolean(options.expanded);
				if (bodyMemo === undefined || bodyMemo.expanded !== expanded || bodyMemo.width !== contentWidth) {
					const changes = buildChangeBody(changeGroups, styleLine, expanded, COLLAPSED_CHANGE_LIMIT);
					const more = changes.remaining > 0 ? formatMoreRow(changes.remaining, "change", uiTheme) : undefined;
					// The truncation marker rides the bottom border unless trailing notes follow it.
					const inPlace = more && extraLines.length > 0 ? [more] : [];
					const lines = [...changes.lines, ...inPlace, ...extraLines].map(l =>
						truncateToWidth(l, contentWidth, Ellipsis.Omit),
					);
					while (lines.length > 0 && lines[0].trim() === "") lines.shift();
					bodyMemo = { expanded, width: contentWidth, lines, marker: inPlace.length > 0 ? undefined : more };
				}
				const footer = [...summaryParts, bodyMemo.marker].filter(Boolean).join(uiTheme.sep.dot);
				return {
					status,
					phase: icon === "running" ? "partial" : icon,
					footerMeta: uiTheme.fg("dim", footer),
					sections: [{ content: bodyMemo.lines }],
				};
			},
			{ onInvalidate: () => (bodyMemo = undefined) },
		);
	},
	describeCall(args: AstEditRenderArgs): NativeToolView {
		return {
			tool: {
				title: "AST Edit",
				...astEditPatternHead(args),
				meta: args.paths?.length ? [`in ${args.paths.map(displayPath).join(", ")}`] : undefined,
			},
		};
	},

	describeResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstEditToolDetails; isError?: boolean },
		_options: RenderResultOptions,
		args?: AstEditRenderArgs,
	): NativeToolView {
		const details = result.details;
		const patternHead = astEditPatternHead(args);
		if (result.isError) {
			return {
				tool: { title: "AST Edit", ...patternHead },
				tone: "error",
				body: [errorText(resultText(result) || "Unknown error")],
			};
		}
		const parseErrors = details?.parseErrors ?? [];
		const parseNote: NativeChild | undefined =
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
		const totalReplacements = details?.totalReplacements ?? 0;
		if (totalReplacements === 0) {
			return {
				tool: { title: "AST Edit", ...patternHead, meta: ["0 replacements"] },
				tone: "warning",
				body: compact<NativeChild>([parseNote, astEditScopeStats(details)]),
			};
		}
		const limitReached = details?.limitReached ?? false;
		const allLines = (details?.displayContent ?? resultText(result)).split("\n");
		const kept = groupLineIndicesByBlank(allLines)
			.filter(indices => {
				const first = allLines[indices[0]!]!;
				return !first.startsWith("Safety cap reached") && !first.startsWith("Parse issues:");
			})
			.flatMap(indices => indices.map(index => allLines[index]!));
		const files = parseAstEditChanges(kept);
		const fileCount = Math.max(details?.filesTouched ?? 0, files.length);
		let added = 0;
		let removed = 0;
		for (const file of files) {
			added += file.added;
			removed += file.removed;
		}
		// Same shape as edit: one file heads the call by path with a bare diff;
		// several head it as `N files` with one borderless section per file.
		const single = fileCount === 1 && files.length === 1 ? files[0] : undefined;
		const changes: NativeChild[] = single
			? [astEditDiff(single)]
			: files.map(file => fileDiffSection(file, [astEditDiff(file)], { role: "omp.tool.ast_edit.file" }));
		// The head names the files, so a single rewrite's pattern moves to a quiet context line.
		const pattern = args?.ops?.length === 1 ? patternPreview(args.ops[0]?.pat) : undefined;
		return {
			tool: {
				title: "AST Edit",
				target: single ? displayPath(single.path) : formatCount("file", fileCount),
				targetKind: single ? "path" : "text",
				meta: compact([diffStatsMeta(added, removed), formatCount("replacement", totalReplacements)]),
				badges: details?.applied ? undefined : [{ text: "proposed", tone: "warning" }],
			},
			tone: limitReached ? "warning" : undefined,
			body: compact<NativeChild>([
				pattern !== undefined &&
					text([span(pattern, "code")], { lines: 1, truncate: "end", role: "omp.tool.context" }),
				...(changes.length > 0 ? changes : [noteText(kept.join("\n"))]),
				parseNote,
				astEditScopeStats(details),
			]),
			preview: { lines: COLLAPSED_CHANGE_LIMIT },
		};
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<AstEditRenderArgs, AstEditToolDetails>;
