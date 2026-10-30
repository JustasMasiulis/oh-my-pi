import type { NativeToolView, ToolRenderer } from "./renderer";
/**
 * Inline TUI renderers for the long-term memory tools (`retain`, `recall`,
 * `reflect`).
 *
 * These keep the transcript terse — one status line plus, for `retain`, one
 * row per stored item — instead of the generic JSON arg tree, which exploded
 * multi-line memory blobs into an unreadable wall. They are flush cards: a
 * status line over a few indented rows reads far cleaner than boxing a
 * one-line memory note.
 */
import type { Component } from "../index";
import type { RenderResultOptions } from "./renderer";
import type { Theme } from "../theme/theme";
import { Ellipsis, plainToolCard, type StatusLineOptions, truncateToWidth } from "../render";
import {
	formatErrorText,
	formatExpandHint,
	formatMoreItems,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIStatus,
} from "../render/render-utils";
import { item, list, md, span, text } from "../native/describe";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { errorView, resultText, toolHead } from "./native-view";

interface RetainRenderArgs {
	items?: unknown;
}

interface QueryRenderArgs {
	query?: string;
}

function retainContents(args: RetainRenderArgs | undefined): string[] {
	const items = args?.items;
	if (!Array.isArray(items)) return [];

	const contents: string[] = [];
	for (const item of items) {
		if (!item || typeof item !== "object" || !("content" in item) || typeof item.content !== "string") continue;
		const content = replaceTabs(item.content.trim());
		if (content.length > 0) contents.push(content);
	}
	return contents;
}

/** `pending` before execution starts, `running` (spinner) while it executes. */
function callIcon(options: RenderResultOptions): ToolUIStatus {
	return options.executionStarted ? "running" : "pending";
}

/** Status line for a memory tool: the fixed title and, for recall/reflect, the query as subject. */
function memoryStatus(
	title: string,
	query: string | undefined,
	icon: ToolUIStatus,
	options?: { spinnerFrame?: number; meta?: string[] },
): StatusLineOptions {
	const trimmed = replaceTabs((query ?? "").trim());
	return {
		icon,
		spinnerFrame: options?.spinnerFrame,
		title,
		description: trimmed ? truncateToWidth(trimmed, 80, Ellipsis.Unicode) : undefined,
		meta: options?.meta,
	};
}

/** Flush card: the status line, then `rows` clipped to one line each while collapsed, then a truncation row. */
function memoryCard(
	theme: Theme,
	status: StatusLineOptions,
	options: RenderResultOptions,
	buildRows: (expanded: boolean) => { rows: string[]; more?: string },
): Component {
	return plainToolCard(theme, ({ contentWidth }) => {
		const { expanded } = options;
		const { rows, more } = buildRows(expanded);
		const body = expanded ? [...rows] : rows.map(row => truncateToWidth(row, contentWidth));
		if (more) body.push(more);
		return { status, body };
	});
}

/** Error card: the tool's header with error status, then the error text. */
function memoryErrorCard(theme: Theme, status: StatusLineOptions, message: string): Component {
	return plainToolCard(theme, () => ({ status, phase: "error", body: [formatErrorText(message, theme)] }));
}

/** Stored memories as plain rows (no bullet: it reads as a status glyph in ASCII), clamped while collapsed. */
function retainRows(contents: string[], theme: Theme): (expanded: boolean) => { rows: string[]; more?: string } {
	return expanded => {
		const shown = expanded ? contents : contents.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS);
		const remaining = contents.length - shown.length;
		return {
			rows: shown.map(content => theme.fg("toolOutput", content)),
			more:
				remaining > 0
					? `${theme.fg("dim", formatMoreItems(remaining, "memory", theme))} ${formatExpandHint(theme, expanded, true)}`
					: undefined,
		};
	};
}

/** Retained memories as a list, clamped to the collapsed item budget. */
function describeRetain(contents: string[], summary?: string): NativeToolView {
	return {
		head: toolHead("Retain", summary),
		inline: true,
		body:
			contents.length > 0
				? [list(contents.map((content, i) => item(String(i), { label: plainText(content) })))]
				: [],
		preview: { lines: PREVIEW_LIMITS.COLLAPSED_ITEMS },
	};
}

const retainCallMemo = new OwnerMemo<NativeToolView | undefined>();
const retainResultMemo = new OwnerMemo<NativeToolView | undefined>();
const recallResultMemo = new OwnerMemo<NativeToolView | undefined>();
const reflectResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Render retained memory items and their storage summary. */
export const retainToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: RetainRenderArgs, options: RenderResultOptions, theme: Theme): Component {
		const status = memoryStatus("Retain", undefined, callIcon(options), {
			spinnerFrame: options.spinnerFrame,
		});
		return memoryCard(theme, status, options, retainRows(retainContents(args), theme));
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: { count?: number }; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: RetainRenderArgs,
	): Component {
		if (result.isError) {
			const status = memoryStatus("Retain", undefined, "error");
			return memoryErrorCard(theme, status, resultText(result).trim() || "Retain failed");
		}
		// `summary` is the tool's own "N memories stored/queued." line; drop the
		// trailing period so it reads cleanly as a status meta segment.
		const summary = resultText(result).trim().replace(/\.$/, "");
		const status = memoryStatus("Retain", undefined, "success", { meta: summary ? [summary] : undefined });
		return memoryCard(theme, status, options, retainRows(retainContents(args), theme));
	},
	describeCall(args: RetainRenderArgs): NativeToolView | undefined {
		const contents = retainContents(args);
		return retainCallMemo.get(args, [contents.join("\0")], () => describeRetain(contents));
	},
	describeResult(
		result: { content: Array<{ type: string; text?: string }>; details?: MemoryRetainDetails; isError?: boolean },
		_options: RenderResultOptions,
		args?: RetainRenderArgs,
	): NativeToolView | undefined {
		return retainResultMemo.get(result, [], () => {
			if (result.isError)
				return { ...errorView("Retain", resultText(result).trim() || "Retain failed"), inline: true };
			return describeRetain(retainContents(args), resultText(result).trim().replace(/\.$/, ""));
		});
	},
} satisfies ToolRenderer<RetainRenderArgs, MemoryRetainDetails>;

/** Render recalled memories with an expandable body. */
export const recallToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: QueryRenderArgs, options: RenderResultOptions, theme: Theme): Component {
		const status = memoryStatus("Recall", args.query, callIcon(options), {
			spinnerFrame: options.spinnerFrame,
		});
		return memoryCard(theme, status, options, () => ({ rows: [] }));
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: QueryRenderArgs,
	): Component {
		if (result.isError) {
			const status = memoryStatus("Recall", args?.query, "error");
			return memoryErrorCard(theme, status, resultText(result).trim() || "Recall failed");
		}
		const text = resultText(result).trim();
		const found = Number(text.match(/^Found (\d+) relevant/)?.[1] ?? 0);
		const status = memoryStatus("Recall", args?.query, found > 0 ? "success" : "warning", {
			meta: [`${found} found`],
		});
		if (found === 0) return memoryCard(theme, status, options, () => ({ rows: [] }));
		// Collapsed view is the header and the expand hint; expanding reveals the
		// recalled memories without dumping the whole block into the transcript.
		const memoryLines = text
			.replace(/^[^\n]*\n+/, "")
			.split("\n")
			.slice(0, PREVIEW_LIMITS.OUTPUT_EXPANDED)
			.map(line => theme.fg("muted", replaceTabs(line)));
		return memoryCard(theme, status, options, expanded =>
			expanded ? { rows: memoryLines } : { rows: [], more: formatExpandHint(theme, false, true) },
		);
	},
	describeCall(args: QueryRenderArgs): NativeToolView {
		return { head: toolHead("Recall", args.query?.trim()), inline: true };
	},
	describeResult(
		result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
		_options: RenderResultOptions,
		args?: QueryRenderArgs,
	): NativeToolView | undefined {
		return recallResultMemo.get(result, [], () => {
			const query = args?.query?.trim();
			const output = resultText(result).trim();
			if (result.isError) return { ...errorView("Recall", output || "Recall failed", query), inline: true };
			const found = Number(output.match(/^Found (\d+) relevant/)?.[1] ?? 0);
			if (found === 0) return { head: toolHead("Recall", query, "no matches"), tone: "warning", inline: true };
			// Collapsed keeps to the header; expanding reveals the recalled memories.
			const memories = output
				.replace(/^[^\n]*\n+/, "")
				.split("\n")
				.slice(0, PREVIEW_LIMITS.OUTPUT_EXPANDED)
				.join("\n");
			return {
				head: toolHead("Recall", query, `${found} found`),
				inline: true,
				body: memories.trim() ? [text([span(plainText(memories), "muted")], { wrap: "word" })] : [],
				preview: { lines: 0 },
			};
		});
	},
} satisfies ToolRenderer<QueryRenderArgs, unknown>;

/** Render synthesized memory reflections. */
export const reflectToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	renderCall(args: QueryRenderArgs, options: RenderResultOptions, theme: Theme): Component {
		const status = memoryStatus("Reflect", args.query, callIcon(options), {
			spinnerFrame: options.spinnerFrame,
		});
		return memoryCard(theme, status, options, () => ({ rows: [] }));
	},
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: QueryRenderArgs,
	): Component {
		if (result.isError) {
			const status = memoryStatus("Reflect", args?.query, "error");
			return memoryErrorCard(theme, status, resultText(result).trim() || "Reflect failed");
		}
		const status = memoryStatus("Reflect", args?.query, "success");
		const answerLines = resultText(result)
			.trim()
			.split("\n")
			.filter(line => line.trim().length > 0)
			.map(line => theme.fg("toolOutput", replaceTabs(line)));
		return memoryCard(theme, status, options, expanded => {
			const shown = answerLines.slice(
				0,
				expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED,
			);
			const remaining = answerLines.length - shown.length;
			return {
				rows: shown,
				more:
					remaining > 0
						? `${theme.fg("dim", formatMoreItems(remaining, "line", theme))} ${formatExpandHint(theme, expanded, true)}`
						: undefined,
			};
		});
	},
	describeCall(args: QueryRenderArgs): NativeToolView {
		return { head: toolHead("Reflect", args.query?.trim()), inline: true };
	},
	describeResult(
		result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
		_options: RenderResultOptions,
		args?: QueryRenderArgs,
	): NativeToolView | undefined {
		return reflectResultMemo.get(result, [], () => {
			const query = args?.query?.trim();
			const answer = resultText(result).trim();
			if (result.isError) return { ...errorView("Reflect", answer || "Reflect failed", query), inline: true };
			const shown = answer.split("\n").slice(0, PREVIEW_LIMITS.OUTPUT_EXPANDED).join("\n").trim();
			return {
				head: toolHead("Reflect", query),
				inline: true,
				body: shown ? [md(shown, { role: "omp.memory.reflect" })] : [],
				preview: { lines: PREVIEW_LIMITS.OUTPUT_COLLAPSED },
			};
		});
	},
} satisfies ToolRenderer<QueryRenderArgs, unknown>;

/** Number of memories accepted by retain. */
export interface MemoryRetainDetails {
	count: number;
}
