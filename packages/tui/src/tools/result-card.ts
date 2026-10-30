/**
 * Line-based status cards shared by the internal-URL renderers (`proc://`,
 * `agent://`, `cfg://`): a header plus sanitized, width-truncated body lines.
 */
import type { Component } from "../tui";
import { createCachedComponent } from "../render";
import { wrapGuidedLine, wrapPrefixedLine } from "../render/hanging-wrap";
import { replaceTabs } from "../render/render-utils";
import { FLUSH_BODY_INDENT } from "../render/tool-card";
import { theme } from "../theme/theme";
import type { RenderResultOptions } from "./renderer";

/** Tool result fields the card renderers read. */
export interface CardToolResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

/** First text block of a tool result, or `""`. */
export function firstText(result: CardToolResult): string {
	return result.content.find(item => item.type === "text")?.text ?? "";
}

/** Sanitize one display line: tabs become spaces, carriage returns are dropped. */
export function safe(value: string): string {
	return replaceTabs(value).replace(/\r/g, "");
}

const INDENT = " ".repeat(FLUSH_BODY_INDENT);

/** Wrap one flush row: indented body rows hang under the body column (or their tree guides). */
function wrapRow(line: string, width: number): string[] {
	if (!line.startsWith(INDENT)) return wrapGuidedLine(line, width, theme);
	const rest = line.slice(INDENT.length);
	return wrapGuidedLine(rest, Math.max(1, width - INDENT.length), theme).map(row => `${INDENT}${row}`);
}

/**
 * Flush card whose lines are sanitized and wrapped, re-rendered when the
 * expanded state flips. The first line is the header; it hangs its
 * continuations at the body column so trailing facts stay visible.
 */
export function card(lines: (width: number, expanded: boolean) => string[], options: RenderResultOptions): Component {
	return createCachedComponent(
		() => Boolean(options.expanded),
		(width, expanded) => {
			const rows = lines(width, expanded)
				.flatMap(line => line.split("\n"))
				.map(safe);
			const [header, ...body] = rows;
			if (header === undefined) return [];
			return [...wrapPrefixedLine("", INDENT, header, width), ...body.flatMap(row => wrapRow(row, width))];
		},
	);
}
