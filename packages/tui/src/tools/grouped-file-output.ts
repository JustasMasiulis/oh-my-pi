import * as path from "node:path";

import {
	buildPathTree,
	isRecord,
	isUrlLikePath,
	type PathTreeInput,
	sanitizeText,
	walkPathTree,
} from "@oh-my-pi/pi-utils";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { code, col, keyed, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import {
	CODE_FRAME_GUTTER,
	FILE_NAME_COLOR,
	formatMoreRow,
	formatScopedSubject,
	formatStyledPath,
	replaceTabs,
	toDisplayPathList,
} from "../render/render-utils";
import type { Theme } from "../theme/theme";
import { formatHashlineHeader } from "./hashline-format";
import { fileRow } from "./native-view";

// =============================================================================
// Grouped file output (grep / ast-grep / ast-edit / lsp diagnostics)
// =============================================================================

/**
 * One file's contribution to a grouped file output. The header itself is generated
 * by `formatGroupedFiles` (one `#` per nesting level); use `headerSuffix` to tack
 * on extras like ` (1 replacement)`.
 */
export interface GroupedFileSection {
	/** Optional suffix appended to the file header. */
	headerSuffix?: string;
	/** Body lines emitted into the textual model output. */
	modelLines: string[];
	/** Body lines emitted into the display output. Defaults to `modelLines`. */
	displayLines?: string[];
	/** When true, the file (and its header) is omitted entirely. */
	skip?: boolean;
}

/** Parallel model-facing and display-facing lines for grouped files. */
export interface GroupedFilesOutput {
	model: string[];
	display: string[];
	/** Per file, the `model` index just past its last line: a head cut keeping `n` lines shows it whole when this is <= n. */
	modelEnds: Map<string, number>;
}

/**
 * Render a list of files as a multi-level, prefix-folded directory tree shared by
 * grep, ast-grep, ast-edit, and the LSP diagnostic formatter.
 *
 * Layout (one `#` per level; the shared prefix folds into the top header):
 *   # packages/pkg/src/
 *   ## root.ts
 *   …body…
 *   ## nested/
 *   ### child.ts
 *   …body…
 *
 * Files in the (folded) project root become single-`#` headers with no parent
 * directory line. A blank line precedes every directory header and every
 * root-level file so the renderers can split the output into collapsible groups.
 */
export function formatGroupedFiles(
	files: string[],
	renderFile: (filePath: string) => GroupedFileSection,
): GroupedFilesOutput {
	const sections = new Map<string, GroupedFileSection>();
	const inputs: PathTreeInput[] = [];
	for (const filePath of files) {
		if (sections.has(filePath)) continue;
		const section = renderFile(filePath);
		if (section.skip) continue;
		sections.set(filePath, section);
		inputs.push({ path: filePath, isDir: false, key: filePath });
	}

	const tree = buildPathTree(inputs);
	const model: string[] = [];
	const display: string[] = [];
	const modelEnds = new Map<string, number>();
	let emitted = false;

	for (const event of walkPathTree(tree)) {
		const hashes = "#".repeat(event.depth + 1);
		const needsSeparator = emitted && (event.depth === 0 || event.kind === "dir");
		if (needsSeparator) {
			model.push("");
			display.push("");
		}
		emitted = true;
		if (event.kind === "dir") {
			const header = `${hashes} ${event.name}/`;
			model.push(header);
			display.push(header);
			continue;
		}
		const section = sections.get(event.key)!;
		const header = `${hashes} ${event.name}${section.headerSuffix ?? ""}`;
		model.push(header, ...section.modelLines);
		display.push(header, ...(section.displayLines ?? section.modelLines));
		modelEnds.set(event.key, model.length);
	}

	return { model, display, modelEnds };
}

/** One file's rendered search matches, plus its hashline tag when editable. */
export interface FileMatchSection {
	model: string[];
	display: string[];
	tag?: string;
}

/**
 * Render per-file search matches (grep / ast-grep). Grouped mode nests files
 * via {@link formatGroupedFiles}, appending `#tag` to headers; flat mode
 * blank-separates files and prefixes each with a hashline header when tagged.
 * Files with no model lines are omitted.
 */
export function formatFileMatches(
	files: string[],
	grouped: boolean,
	renderFile: (filePath: string) => FileMatchSection,
): GroupedFilesOutput {
	if (grouped) {
		return formatGroupedFiles(files, filePath => {
			const rendered = renderFile(filePath);
			return {
				modelLines: rendered.model,
				displayLines: rendered.display,
				headerSuffix: rendered.tag ? `#${rendered.tag}` : "",
				skip: rendered.model.length === 0,
			};
		});
	}
	const model: string[] = [];
	const display: string[] = [];
	const modelEnds = new Map<string, number>();
	for (const filePath of files) {
		const rendered = renderFile(filePath);
		if (rendered.model.length === 0) continue;
		if (model.length > 0) {
			model.push("");
			display.push("");
		}
		if (rendered.tag) model.push(formatHashlineHeader(filePath, rendered.tag));
		model.push(...rendered.model);
		display.push(...rendered.display);
		modelEnds.set(filePath, model.length);
	}
	return { model, display, modelEnds };
}

// =============================================================================
// Parsing grouped output back into per-line context (TUI renderers)
// =============================================================================

const GROUPED_HEADER_RE = /^(#+)\s+(.*)$/;
const HEADER_SUFFIX_RE = /\s+\([^)]*\)\s*$/;
const HEADER_HASH_TAG_RE = /#[0-9a-f]+$/i;

/** Per-line classification of grouped output, used by renderers for header display and hyperlinks. */
export interface GroupedLineContext {
	/** Directory header, file header, or any non-header body/content line. */
	kind: "dir" | "file" | "content";
	/** Number of leading `#` for headers; 0 for content lines. */
	depth: number;
	/** Resolved absolute path of the dir/file a header points at (when resolvable). */
	headerPath?: string;
	/**
	 * For file headers, the full display path: the folded directory chain joined
	 * with the name, without `#` markers or the hashline tag.
	 */
	displayPath?: string;
	/** For file headers, a trailing parenthesized note such as `(2 replacements)`. */
	suffix?: string;
	/** For content lines, the absolute path of the owning file (line hyperlinks). */
	filePath?: string;
	/** Header is an internal/url-like target the caller resolves itself. */
	isUrl?: boolean;
}

function resolveGroupedPath(parent: string | undefined, name: string): string | undefined {
	if (parent === undefined) return undefined;
	if (name === "" || name === ".") return parent;
	// `path.resolve` keeps an absolute `name` intact (out-of-cwd results) while
	// joining a relative folded chain (`packages/pkg/src`) onto the parent.
	return path.resolve(parent, name);
}

/** `# dir/`: a directory header row of grouped output. */
function isGroupedDirHeader(line: string): boolean {
	const match = GROUPED_HEADER_RE.exec(line);
	if (!match) return false;
	const rest = match[2]!.trimEnd();
	return rest.endsWith("/") && !isUrlLikePath(rest);
}

/**
 * Walk grouped output lines, tracking a directory stack keyed by header depth, so
 * each header and body line can be linked back to its absolute filesystem path
 * and each file header to its full display path.
 * Reconstruction is stack-based (not per-blank-group) so nested directory headers
 * resolve correctly across the whole output.
 *
 * `headerBase` is the directory the displayed (folded) header paths are relative
 * to — for grep/ast tools that is the session cwd, since display paths are
 * formatted relative to cwd regardless of the (sub)directory the search was
 * scoped to. `fileScope` is the initial owning file for body lines that appear
 * before any header (single-file scopes have no `#` headers); it defaults to
 * `headerBase` and should be passed the scoped file's absolute path.
 */
export function classifyGroupedLines(
	lines: readonly string[],
	headerBase: string | undefined,
	fileScope: string | undefined = headerBase,
): GroupedLineContext[] {
	const result: GroupedLineContext[] = [];
	const dirAtDepth = new Map<number, string>();
	const displayDirAtDepth: string[] = [];
	// Body lines before any header (single-file scopes) link to the scoped file.
	let currentFile = fileScope;

	const clearDeeper = (depth: number) => {
		for (const key of dirAtDepth.keys()) {
			if (key >= depth) dirAtDepth.delete(key);
		}
		displayDirAtDepth.length = depth - 1;
	};

	for (const line of lines) {
		const match = GROUPED_HEADER_RE.exec(line);
		if (!match) {
			result.push({ kind: "content", depth: 0, filePath: currentFile });
			continue;
		}
		const depth = match[1]!.length;
		const rest = match[2]!.trimEnd();
		const suffix = HEADER_SUFFIX_RE.exec(rest)?.[0].trim();
		if (isUrlLikePath(rest)) {
			clearDeeper(depth);
			currentFile = undefined;
			const displayPath = rest.replace(HEADER_SUFFIX_RE, "").replace(HEADER_HASH_TAG_RE, "");
			result.push({ kind: "file", depth, isUrl: true, displayPath, suffix });
			continue;
		}
		const parent = depth > 1 ? dirAtDepth.get(depth - 1) : headerBase;
		if (rest.endsWith("/")) {
			const name = rest.slice(0, -1).replace(HEADER_SUFFIX_RE, "");
			const abs = resolveGroupedPath(parent, name);
			clearDeeper(depth);
			if (abs !== undefined) dirAtDepth.set(depth, abs);
			displayDirAtDepth[depth - 1] = name;
			currentFile = undefined;
			result.push({ kind: "dir", depth, headerPath: abs });
			continue;
		}
		const name = rest.replace(HEADER_SUFFIX_RE, "").replace(HEADER_HASH_TAG_RE, "");
		const abs = name ? resolveGroupedPath(parent, name) : undefined;
		const prefix = displayDirAtDepth
			.slice(0, depth - 1)
			.filter(Boolean)
			.join("/");
		const displayPath = prefix ? `${prefix}/${name}` : name;
		currentFile = abs;
		result.push({ kind: "file", depth, headerPath: abs, displayPath, suffix });
	}

	return result;
}

/**
 * A file header row: the full path with a dim directory and bronze name, then
 * any dim suffix. URL-like headers stay whole in the name color.
 */
export function formatGroupedFileHeader(ctx: GroupedLineContext, theme: Theme): string {
	const display = replaceTabs(ctx.displayPath ?? "");
	const styledPath = ctx.isUrl ? theme.fg(FILE_NAME_COLOR, display) : formatStyledPath(display, theme);
	const suffix = ctx.suffix ? ` ${theme.fg("dim", replaceTabs(ctx.suffix))}` : "";
	return `${styledPath}${suffix}`;
}

/**
 * OSC 8 targets for the header rows of sanitized grouped output. Destinations
 * must keep the original path bytes, so when the raw `displayContent` still
 * aligns line-for-line with the sanitized `displayText`, a header links to its
 * raw classification's path. Raw text never creates links the sanitized
 * output lacks.
 */
export function groupedHeaderLinkTargets(
	contexts: readonly GroupedLineContext[],
	displayText: string,
	rawDetails: unknown,
): (index: number) => string | undefined {
	const raw: Record<string, unknown> = isRecord(rawDetails) ? rawDetails : {};
	const rawContent = typeof raw.displayContent === "string" ? raw.displayContent : undefined;
	const rawLines = rawContent?.split("\n");
	const rawCwd = typeof raw.cwd === "string" ? raw.cwd : undefined;
	const rawSearchPath = typeof raw.searchPath === "string" ? raw.searchPath : undefined;
	const rawContexts =
		rawContent !== undefined && rawLines?.length === contexts.length && sanitizeText(rawContent) === displayText
			? classifyGroupedLines(rawLines, rawCwd ?? rawSearchPath, rawSearchPath)
			: undefined;
	return index => {
		const ctx = contexts[index]!;
		const rawContext = rawContexts?.[index];
		if (!ctx.headerPath || rawContext?.kind !== ctx.kind || rawContext.depth !== ctx.depth) return ctx.headerPath;
		return rawContext.headerPath ?? ctx.headerPath;
	};
}

/**
 * Split line indices into blank-line-separated groups, mirroring
 * `splitGroupsByBlankLine`: when any blank line is present, break on runs of
 * blanks; otherwise return a single group of the non-empty lines. Returning
 * indices lets callers slice parallel arrays (raw lines, styled lines, contexts).
 */
export function groupLineIndicesByBlank(rawLines: readonly string[]): number[][] {
	const hasSeparators = rawLines.some(line => line.trim().length === 0);
	const groups: number[][] = [];
	if (hasSeparators) {
		let current: number[] = [];
		for (let i = 0; i < rawLines.length; i++) {
			if (rawLines[i]!.trim().length === 0) {
				if (current.length > 0) {
					groups.push(current);
					current = [];
				}
				continue;
			}
			current.push(i);
		}
		if (current.length > 0) groups.push(current);
	} else {
		const current: number[] = [];
		for (let i = 0; i < rawLines.length; i++) {
			if (rawLines[i]!.trim().length > 0) current.push(i);
		}
		if (current.length > 0) groups.push(current);
	}
	return groups;
}

// =============================================================================
// Flush search previews (grep / ast-grep TUI renderers)
// =============================================================================

/** A persisted code-frame row up to its gutter: optional marker, line number, then {@link CODE_FRAME_GUTTER}. */
const CODE_FRAME_ROW_RE = new RegExp(`^(\\s*[*+\\->]?\\s*\\d*)${CODE_FRAME_GUTTER}`);

/**
 * Redraw a persisted code-frame row's canonical gutter with the theme's
 * vertical rule (`|` in ASCII). Rows without that gutter (older transcripts'
 * `12|text` / `12:text`, headers, notes) pass through unchanged.
 */
export function themeCodeFrameGutter(line: string, theme: Theme): string {
	const match = CODE_FRAME_ROW_RE.exec(line);
	if (!match) return line;
	return `${match[1]}${theme.boxSharp.vertical}${line.slice(match[0].length)}`;
}

/** `*12│`, `*12|`, `*12:`: a match row of search display output. */
const SEARCH_MATCH_LINE_RE = /^\s*\*\d+(?:│|[:|])/;

function isSearchMatchLine(line: string): boolean {
	return SEARCH_MATCH_LINE_RE.test(line);
}

function isSearchHeaderLine(line: string): boolean {
	return /^#+ /.test(line);
}

/** Headers and match rows only; falls back to the whole group when it has neither. */
function compactSearchPreviewGroup(group: readonly number[], lines: readonly string[]): readonly number[] {
	const compact = group.filter(index => isSearchHeaderLine(lines[index]!) || isSearchMatchLine(lines[index]!));
	return compact.length > 0 ? compact : group;
}

function countPreviewMatches(group: readonly number[], lines: readonly string[], hasMarkedMatches: boolean): number {
	let count = 0;
	for (const index of group) {
		const line = lines[index]!;
		if (hasMarkedMatches ? isSearchMatchLine(line) : !isSearchHeaderLine(line) && line.length > 0) count++;
	}
	return count;
}

/** Line budget and expansion state for {@link renderSearchPreviewRows}. */
export interface SearchPreviewOptions {
	/** Rows available, including the trailing `… N more` row. */
	maxLines: number;
	/** Reported match total; used when the display output marks no match rows. */
	matchCount: number;
	expanded: boolean;
}

/**
 * Flush rows of grouped search output (`## file`, `*18│ line`) within a line
 * budget. Directory headers are dropped: callers style each file header with
 * its full path ({@link formatGroupedFileHeader}). Collapsed, groups keep only
 * their headers and match rows. When rows are cut, the last row is
 * `… N more matches` (or lines) with the expand hint.
 */
export function renderSearchPreviewRows(
	groups: readonly (readonly number[])[],
	lines: readonly string[],
	styleLine: (index: number) => string,
	options: SearchPreviewOptions,
	theme: Theme,
): string[] {
	const { maxLines, matchCount, expanded } = options;
	if (maxLines <= 0) return [];
	const renderedGroups = groups
		.map(group => group.filter(index => !isGroupedDirHeader(lines[index]!)))
		.map(group => (expanded ? group : compactSearchPreviewGroup(group, lines)))
		.filter(group => group.length > 0);
	if (renderedGroups.length === 0) return [];

	let totalLines = 0;
	let totalMarkedMatches = 0;
	let totalFallbackMatches = 0;
	for (const group of renderedGroups) {
		totalLines += group.length;
		totalMarkedMatches += countPreviewMatches(group, lines, true);
		totalFallbackMatches += countPreviewMatches(group, lines, false);
	}
	const hasMarkedMatches = totalMarkedMatches > 0;
	const needsSummary = totalLines > maxLines;
	const contentBudget = needsSummary ? Math.max(maxLines - 1, 0) : maxLines;
	const visible: number[] = [];
	for (const group of renderedGroups) {
		const take = Math.min(group.length, contentBudget - visible.length);
		if (take <= 0) break;
		visible.push(...group.slice(0, take));
	}
	// A cut preview never ends on a header whose body it hides.
	if (needsSummary) {
		while (visible.length > 1 && isSearchHeaderLine(lines[visible[visible.length - 1]!]!)) visible.pop();
	}

	const out = visible.map(index => replaceTabs(styleLine(index)));
	const visibleMatches = countPreviewMatches(visible, lines, hasMarkedMatches);
	const totalMatches = hasMarkedMatches ? totalMarkedMatches : Math.max(matchCount, totalFallbackMatches);
	const hiddenMatches = Math.max(totalMatches - visibleMatches, 0);
	const hiddenLines = Math.max(totalLines - visible.length, 0);
	if (needsSummary && (hiddenMatches > 0 || hiddenLines > 0)) {
		out.push(
			hiddenMatches > 0
				? formatMoreRow(hiddenMatches, "match", theme, { expanded })
				: formatMoreRow(hiddenLines, "line", theme, { expanded }),
		);
	}
	return out;
}

/**
 * Search header subject, `pattern in scope`, the same in the call and the
 * result. A result names the tool's display scope; a call falls back to the
 * requested paths.
 */
export function searchSubject(
	pattern: string | undefined,
	pathArg: string | string[] | undefined,
	theme: Theme,
	scope?: string,
): string | undefined {
	if (!pattern) return undefined;
	const paths = toDisplayPathList(pathArg);
	return formatScopedSubject(pattern, scope ?? (paths.length > 0 ? paths.join(", ") : undefined), theme);
}

// =============================================================================
// Native (TSP) description of grouped output
// =============================================================================

/** One event of {@link walkGroupedOutput}: a directory header, a file header, or a non-blank body line. */
export type GroupedOutputEvent =
	| { readonly kind: "dir" }
	| { readonly kind: "file"; readonly path: string; readonly suffix?: string }
	| { readonly kind: "line"; readonly text: string };

/**
 * Walk grouped output (`# dir/`, `## file.ts (suffix)`, body lines), resolving
 * each file header to its full display path ({@link classifyGroupedLines})
 * and dropping blank separator lines.
 */
export function* walkGroupedOutput(lines: readonly string[]): Generator<GroupedOutputEvent> {
	const contexts = classifyGroupedLines(lines, undefined);
	for (let index = 0; index < lines.length; index++) {
		const ctx = contexts[index]!;
		const line = lines[index]!;
		if (ctx.kind === "dir") yield { kind: "dir" };
		else if (ctx.kind === "file") yield { kind: "file", path: ctx.displayPath ?? "", suffix: ctx.suffix };
		else if (line.trim().length > 0) yield { kind: "line", text: line };
	}
}

/** `*12│text`, ` 12|text`, `*12:text`: optional match marker, line number, gutter, content. */
const GROUPED_NUMBERED_LINE_RE = /^\s*(\*?)(\d+)(?:│|[:|])(.*)$/;
/** `    │...`: grep's gap between non-adjacent context runs (drawn as {@link numberedCode}'s `…` row). */
const GROUPED_GAP_LINE_RE = /^\s*│\.\.\.$/;

/** One source line for {@link numberedCode}: its number (`null` for an elision marker), text and match mark. */
export interface NumberedLine {
	n: number | null;
	text: string;
	mark?: boolean;
}

/**
 * Numbered `code` for possibly non-contiguous source lines: one block per run
 * of consecutive line numbers (`start` = the run's first line, match lines
 * `mark`ed), with a `…` row wherever the numbers jump or an elision marker
 * (`n: null`) sits. `path` is the file the lines come from: Tern picks their
 * grammar from it and draws no header (the row or head above names the file).
 * `wrap` soft-wraps long lines instead of scrolling the block sideways.
 */
export function numberedCode(
	lines: readonly NumberedLine[],
	opts: { path?: string; wrap?: boolean } = {},
): NativeNode[] {
	const out: NativeNode[] = [];
	let run: { start: number; text: string[]; marks: { line: number; tone: TspTone }[] } | undefined;
	const flush = () => {
		if (!run) return;
		// The quiet `…` row between two non-adjacent runs.
		if (out.length > 0) out.push(keyed(text([span("…", "dim")], { wrap: "none" }), `g${run.start}`));
		out.push(
			keyed(
				code(run.text.join("\n"), {
					start: run.start,
					numbers: true,
					path: opts.path,
					wrap: opts.wrap,
					marks: run.marks.length > 0 ? run.marks : undefined,
				}),
				`c${run.start}`,
			),
		);
		run = undefined;
	};
	for (const line of lines) {
		if (line.n === null) {
			flush();
			continue;
		}
		if (run && run.start + run.text.length !== line.n) flush();
		run ??= { start: line.n, text: [], marks: [] };
		run.text.push(line.text);
		if (line.mark) run.marks.push({ line: line.n, tone: "accent" });
	}
	flush();
	return out;
}

/**
 * Describe grouped search output (grep / ast-grep / ast-edit display content)
 * by file (§7.3 grep): per file a 22px path row (dim dir, strong name, the
 * header's suffix or the match count as a chip), then its lines as
 * {@link numberedCode} with match lines marked and `…` between non-adjacent
 * runs. Unnumbered body lines stay plain `code`. `maxFiles` keeps only the
 * first files (the caller says how many were left out). `file` owns the lines
 * before any header: a single-file search prints none, yet its lines get the
 * same file row as a directory search's.
 */
export function describeGroupedOutput(
	lines: readonly string[],
	options: { maxFiles?: number; file?: string } = {},
): NativeNode[] {
	const files: NativeNode[] = [];
	const loose: NativeNode[] = [];
	let current: { path: string; suffix?: string; children: NativeNode[]; marks: number } | undefined;
	let numbered: NumberedLine[] = [];
	let plain: string[] = [];
	// `options.file` until the first line or header claims it.
	let headless = options.file;

	const flushLines = () => {
		const target = current?.children ?? loose;
		if (numbered.length > 0) {
			target.push(...numberedCode(numbered, { path: current?.path }));
			numbered = [];
		}
		if (plain.length > 0) {
			target.push(keyed(code(plain.join("\n")), `p${target.length}`));
			plain = [];
		}
	};
	const flushFile = () => {
		flushLines();
		if (!current) return;
		const count = current.marks;
		const chip = current.suffix
			? { text: current.suffix.replace(/^\(|\)$/g, "") }
			: count > 0
				? { text: String(count), title: count === 1 ? "1 match" : `${count} matches` }
				: undefined;
		const head = fileRow(current.path, { chip, key: "file" });
		files.push(
			keyed(col([head, ...current.children], { gap: "xs", role: "omp.tool.search.file" }), `f:${current.path}`),
		);
		current = undefined;
	};

	for (const event of walkGroupedOutput(lines)) {
		if (event.kind !== "line") {
			headless = undefined;
			flushFile();
			if (options.maxFiles !== undefined && files.length >= options.maxFiles) break;
			if (event.kind === "file") current = { path: event.path, suffix: event.suffix, children: [], marks: 0 };
			continue;
		}
		if (headless !== undefined) {
			current = { path: headless, children: [], marks: 0 };
			headless = undefined;
		}
		if (GROUPED_GAP_LINE_RE.test(event.text)) {
			numbered.push({ n: null, text: "" });
			continue;
		}
		const match = GROUPED_NUMBERED_LINE_RE.exec(event.text);
		if (!match) {
			if (numbered.length > 0) flushLines();
			plain.push(event.text);
			continue;
		}
		if (plain.length > 0) flushLines();
		const mark = match[1] === "*";
		if (mark && current) current.marks++;
		numbered.push({ n: Number.parseInt(match[2]!, 10), text: match[3]!, mark });
	}
	flushFile();
	return [...loose, ...files];
}
