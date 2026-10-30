/**
 * The one header row every tool card renders, framed or flush:
 *
 *     <status> <Title>: <subject> [badge] <meta · meta>
 *
 * The status slot always carries a `status.*` lifecycle glyph, and the title
 * alone names the tool. The title is the fixed tool name and the subject the
 * call's primary argument, identical across the call, success, and failure.
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { span } from "../native/describe";
import { styledSpans } from "../native/spans";
import type { Theme, ThemeColor } from "../theme/theme";
import { visibleWidth } from "../utils";
import { formatStatusIcon, type ToolUIStatus, truncateMiddleToWidth } from "./render-utils";

/** Status icon, title, description, and metadata for a single header row. */
export interface StatusLineOptions {
	icon?: ToolUIStatus;
	spinnerFrame?: number;
	title: string;
	description?: string;
	badge?: { label: string; color: ThemeColor };
	meta?: string[];
}

/**
 * Flatten CR/LF runs in caller-supplied header fragments so a single newline
 * embedded in `description` or `meta` cannot expand the status line into
 * multiple rows — which would otherwise break the bordered output block the
 * header sits on. Tab characters are left alone; tool renderers that need
 * tab-safe text run `replaceTabs()` themselves.
 */
function flattenForHeader(text: string): string {
	return text.replace(/\r\n?|\n/g, " ");
}

/** Render a single-line status header, flattening multiline fields. */
export function renderStatusLine(options: StatusLineOptions, theme: Theme): string {
	const icon = options.icon ? `${formatStatusIcon(options.icon, theme, options.spinnerFrame)} ` : "";
	let line = `${icon}${theme.fg("accent", flattenForHeader(options.title))}`;

	if (options.description) {
		line += `: ${theme.fg("muted", flattenForHeader(options.description))}`;
	}

	if (options.badge) {
		const { label, color } = options.badge;
		line += ` ${theme.fg(color, `${theme.format.bracketLeft}${flattenForHeader(label)}${theme.format.bracketRight}`)}`;
	}

	const meta = options.meta?.map(flattenForHeader).filter(value => value.trim().length > 0) ?? [];
	if (meta.length > 0) {
		line += ` ${theme.fg("dim", meta.join(theme.sep.dot))}`;
	}

	return line;
}

/**
 * {@link renderStatusLine} kept to one row of `width` columns: an overlong
 * subject is cut in its middle, so the title, badge and meta stay readable and
 * the header never wraps into the body rows below it.
 */
export function renderFittedStatusLine(options: StatusLineOptions, theme: Theme, width: number): string {
	const line = renderStatusLine(options, theme);
	const overflow = visibleWidth(line) - width;
	if (overflow <= 0 || !options.description) return line;
	const description = flattenForHeader(options.description);
	const budget = Math.max(1, visibleWidth(description) - overflow);
	return renderStatusLine(
		{ ...options, description: truncateMiddleToWidth(description, budget, theme.format.ellipsis) },
		theme,
	);
}

/**
 * The native form of {@link renderStatusLine}: header spans without the status
 * glyph, which the native card draws as its status chip.
 */
export function statusLineSpans(options: StatusLineOptions, theme: Theme): TspSpan[] {
	// Callers may pre-style parts of a subject or meta (a dim `in`, a warning
	// fact); convert those escapes to spans instead of passing them through.
	const part = (text: string, color: ThemeColor): TspSpan[] =>
		text.includes("\x1b") ? styledSpans(theme.fg(color, text)) : [span(text, color)];
	const spans: TspSpan[] = [span(flattenForHeader(options.title), "accent")];
	if (options.description) spans.push(span(": "), ...part(flattenForHeader(options.description), "muted"));
	if (options.badge) {
		const label = `${theme.format.bracketLeft}${flattenForHeader(options.badge.label)}${theme.format.bracketRight}`;
		spans.push(span(" "), span(label, options.badge.color));
	}
	const meta = options.meta?.map(flattenForHeader).filter(value => value.trim().length > 0) ?? [];
	if (meta.length > 0) spans.push(span(" "), ...part(meta.join(theme.sep.dot), "dim"));
	return spans;
}
