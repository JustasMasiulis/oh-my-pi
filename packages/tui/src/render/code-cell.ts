/**
 * Render a code or markdown cell with optional output section. The header is
 * the owning tool's status line; facts and the trailing truncation marker
 * ride the bottom border.
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { Markdown } from "../components/markdown";
import { code, md, span } from "../native/describe";
import type { NativeNode } from "../native/node";
import { getMarkdownTheme, highlightCode, type Theme } from "../theme/theme";
import { cappedRowCount, formatMoreRow, replaceTabs } from "./render-utils";
import { wrapPrefixedLine } from "./hanging-wrap";
import {
	describeOutputBlock,
	type NativeOutputBlockSection,
	outputBlockContentWidth,
	outputBlockHeaderWidth,
	renderOutputBlock,
} from "./output-block";
import {
	describeOutputLines,
	formatOutputPaneLines,
	splitTerminalOutputLines,
	styleToolOutputLine,
} from "./output-pane";
import { renderFittedStatusLine, type StatusLineOptions, statusLineSpans } from "./status-line";
import type { State } from "./types";

/** Header, facts, and display limits shared by code and markdown cells. */
interface CellOptions {
	/** The owning tool's header row. Framed headers never animate: a running status draws the static glyph. */
	header: StatusLineOptions;
	/** Styled facts for the bottom border (language, duration, counts); the cell adds only its truncation marker. */
	footerMeta?: string;
	output?: string;
	outputMaxLines?: number;
	expanded?: boolean;
	width: number;
}

/** Content and display limits for a code preview with optional output. */
export interface CodeCellOptions extends CellOptions {
	code: string;
	language?: string;
	codeMaxLines?: number;
	/**
	 * Show the LAST `codeMaxLines` rows (the live streaming edge) instead of the
	 * first, with a "… N earlier lines" marker on top. Lets a pending preview
	 * follow code as it is written while staying bounded. Ignored when `expanded`.
	 */
	codeTail?: boolean;
	codeStartLine?: number;
	codeLineNumbers?: Array<number | null>;
}

/** Content and display limits for a Markdown preview with optional output. */
export interface MarkdownCellOptions extends CellOptions {
	content: string;
	contentMaxLines?: number;
}

function getState(header: StatusLineOptions): State | undefined {
	switch (header.icon) {
		case "success":
			return "success";
		case "error":
		case "aborted":
			return "error";
		case "warning":
			return "warning";
		case "running":
			return "running";
		case "pending":
			return "pending";
		default:
			return undefined;
	}
}

/** The caller's styled facts, then the last section's dim truncation marker, for the bottom border. */
function joinFooter(theme: Theme, footerMeta: string | undefined, marker: string | undefined): string | undefined {
	if (!marker) return footerMeta;
	const dimMarker = theme.fg("dim", marker);
	return footerMeta ? `${footerMeta}${theme.fg("dim", theme.sep.dot)}${dimMarker}` : dimMarker;
}

/** Output rows plus the count hidden below them; the caller places the marker. */
function renderCellOutput(
	output: string | undefined,
	expanded: boolean,
	outputMaxLines: number,
	theme: Theme,
): { lines: readonly string[]; hidden: number } {
	if (!output?.trim()) return { lines: [], hidden: 0 };
	const result = formatOutputPaneLines(
		{
			lines: splitTerminalOutputLines(output),
			expanded,
			collapsedMaxLines: outputMaxLines,
			edge: "head",
			styleLine: line => styleToolOutputLine(line, theme),
			showHiddenMarker: false,
		},
		theme,
	);
	return { lines: result.lines, hidden: result.hiddenCount };
}

/**
 * Assemble the frame: the content section, then the output section. The last
 * section's truncation marker moves into the bottom border; an earlier
 * section's marker stays in place as a dim row.
 */
function renderCellBlock(
	options: CellOptions,
	content: { lines: string[]; hidden: number; gutterPad: string },
	theme: Theme,
): string[] {
	const { expanded = false, outputMaxLines = 6, width } = options;
	const output = renderCellOutput(options.output, expanded, outputMaxLines, theme);
	const hasOutput = output.lines.length > 0;

	let footerMarker: string | undefined;
	if (content.hidden > 0) {
		const marker = formatMoreRow(content.hidden, "line", theme, { expanded });
		if (hasOutput) content.lines.push(content.gutterPad + marker);
		else footerMarker = marker;
	}
	if (output.hidden > 0) footerMarker = formatMoreRow(output.hidden, "line", theme, { expanded });

	const sections: Array<{ label?: string; lines: readonly string[] }> = [{ lines: content.lines }];
	if (hasOutput) sections.push({ label: theme.fg("toolTitle", "Output"), lines: output.lines });

	return renderOutputBlock(
		{
			// Framed headers never animate: a spinner would pin the scrollback commit boundary.
			header: renderFittedStatusLine(
				{ ...options.header, spinnerFrame: undefined },
				theme,
				outputBlockHeaderWidth(width, theme),
			),
			footerMeta: joinFooter(theme, options.footerMeta, footerMarker),
			state: getState(options.header),
			sections,
			width,
		},
		theme,
	);
}

/** Render a syntax-highlighted code preview and its optional output block. */
export function renderCodeCell(options: CodeCellOptions, theme: Theme): string[] {
	const { code, language, expanded = false, codeMaxLines = 12, width, codeStartLine, codeLineNumbers } = options;

	const normalizedCode = replaceTabs(code ?? "");
	const rawCodeLines = splitTerminalOutputLines(normalizedCode);
	// The hidden-line marker takes its own row when tailing or above an output section; there a lone hidden line shows instead.
	const ownRowMarker = options.codeTail === true || Boolean(options.output?.trim());
	const collapsedCodeLines = ownRowMarker
		? cappedRowCount(rawCodeLines.length, codeMaxLines)
		: Math.min(rawCodeLines.length, codeMaxLines);
	const maxCodeLines = expanded ? rawCodeLines.length : collapsedCodeLines;
	const hiddenCodeLines = rawCodeLines.length - maxCodeLines;
	const tail = options.codeTail === true && !expanded && hiddenCodeLines > 0;
	const startIndex = tail ? rawCodeLines.length - maxCodeLines : 0;
	const visibleCode = rawCodeLines.slice(startIndex, startIndex + maxCodeLines).join("\n");
	const codeLines = highlightCode(visibleCode, language);

	let visibleLineNumbers: Array<number | null> | undefined;
	let lineNumberWidth = 0;
	if (codeLineNumbers) {
		visibleLineNumbers = codeLineNumbers.slice(startIndex, startIndex + maxCodeLines);
	} else if (codeStartLine !== undefined) {
		visibleLineNumbers = Array.from({ length: maxCodeLines }, (_, i) => codeStartLine + startIndex + i);
	}

	if (visibleLineNumbers) {
		const validLineNums = visibleLineNumbers.filter((n): n is number => n !== null && n !== undefined);
		const maxVal = validLineNums.length > 0 ? Math.max(...validLineNums) : 0;
		if (maxVal > 0) {
			lineNumberWidth = Math.max(2, String(maxVal).length);
		}
	}

	const numberedCodeLines: string[] = [];
	if (lineNumberWidth > 0 && visibleLineNumbers) {
		for (let i = 0; i < codeLines.length; i++) {
			const lineNum = visibleLineNumbers[i];
			const gutter =
				lineNum !== null && lineNum !== undefined
					? String(lineNum).padStart(lineNumberWidth, " ")
					: " ".repeat(lineNumberWidth);
			const prefix = theme.fg("dim", `${gutter} `);
			numberedCodeLines.push(
				...wrapPrefixedLine(prefix, " ".repeat(lineNumberWidth + 1), codeLines[i]!, outputBlockContentWidth(width)),
			);
		}
	}

	const displayCodeLines = lineNumberWidth > 0 ? numberedCodeLines : [...codeLines];
	const gutterPad = lineNumberWidth > 0 ? " ".repeat(lineNumberWidth + 1) : "";
	if (tail) {
		// Earlier rows scrolled above the live tail window — mark them on top so
		// the newest streamed line stays pinned to the bottom of the box.
		const earlier = formatMoreRow(hiddenCodeLines, "line", theme, { expanded, position: "earlier" });
		displayCodeLines.unshift(gutterPad + earlier);
	}

	return renderCellBlock(options, { lines: displayCodeLines, hidden: tail ? 0 : hiddenCodeLines, gutterPad }, theme);
}

/** Render a Markdown preview and its optional output block. */
export function renderMarkdownCell(options: MarkdownCellOptions, theme: Theme): string[] {
	const { content, expanded = false, contentMaxLines = 12, width } = options;

	// Markdown component manages its own wrapping at the same inner width as
	// `renderOutputBlock`, so collapsed row caps are applied after final wrapping.
	const innerWidth = Math.max(20, outputBlockContentWidth(width));
	const allLines = content.trim() ? new Markdown(content, 0, 0, getMarkdownTheme()).render(innerWidth) : [];
	const collapsedContentLines = options.output?.trim()
		? cappedRowCount(allLines.length, contentMaxLines)
		: Math.min(allLines.length, contentMaxLines);
	const maxContentLines = expanded ? allLines.length : collapsedContentLines;

	return renderCellBlock(
		options,
		{ lines: allLines.slice(0, maxContentLines), hidden: allLines.length - maxContentLines, gutterPad: "" },
		theme,
	);
}

function describeCellOutput(
	output: string | undefined,
	expanded: boolean,
	outputMaxLines: number,
): NativeOutputBlockSection | undefined {
	if (!output?.trim()) return undefined;
	return {
		label: [span("Output", "toolTitle")],
		key: "output",
		body: [describeOutputLines(splitTerminalOutputLines(output), { expanded, collapsedMaxLines: outputMaxLines })],
	};
}

function describeFooter(options: Omit<CellOptions, "width">): TspSpan[] | undefined {
	return options.footerMeta ? [span(Bun.stripANSI(options.footerMeta), "dim")] : undefined;
}

/**
 * The native form of {@link renderCodeCell}: a collapsible `card` holding a
 * `code` node (numbered from `codeStartLine`, or the first explicit line
 * number) and an `ansi` output section. The collapsed code clamp is the
 * card preview; highlighting and gutters are the terminal's.
 */
export function describeCodeCell(options: Omit<CodeCellOptions, "width">, theme: Theme): NativeNode {
	const { expanded = false, outputMaxLines = 6, codeMaxLines = 12 } = options;
	const start = options.codeStartLine ?? options.codeLineNumbers?.find((line): line is number => line != null);
	const sections: NativeOutputBlockSection[] = [
		{
			key: "code",
			body: [
				code(options.code ?? "", {
					lang: options.language,
					start,
					numbers: start !== undefined || undefined,
					wrap: true,
				}),
			],
		},
	];
	const output = describeCellOutput(options.output, expanded, outputMaxLines);
	if (output) sections.push(output);
	return describeOutputBlock({
		head: statusLineSpans(options.header, theme),
		meta: describeFooter(options),
		state: getState(options.header),
		role: "omp.cell.code",
		sections,
		collapsible: true,
		collapsed: !expanded,
		preview: { lines: codeMaxLines },
	});
}

/** The native form of {@link renderMarkdownCell}: a collapsible `card` holding `md` source and optional output. */
export function describeMarkdownCell(options: Omit<MarkdownCellOptions, "width">, theme: Theme): NativeNode {
	const { expanded = false, outputMaxLines = 6, contentMaxLines = 12 } = options;
	const sections: NativeOutputBlockSection[] = [];
	if (options.content.trim()) sections.push({ key: "content", body: [md(options.content)] });
	const output = describeCellOutput(options.output, expanded, outputMaxLines);
	if (output) sections.push(output);
	return describeOutputBlock({
		head: statusLineSpans(options.header, theme),
		meta: describeFooter(options),
		state: getState(options.header),
		role: "omp.cell.markdown",
		sections,
		collapsible: true,
		collapsed: !expanded,
		preview: { lines: contentMaxLines },
	});
}
