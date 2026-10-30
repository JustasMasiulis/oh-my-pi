import type { NativeToolView, ToolRenderer, ToolRenderResult } from "./renderer";
/**
 * Web Search TUI Rendering
 *
 * A framed answer card: the answer as the body, the cited sources as a flush
 * section, and provider/model/usage facts in the bottom border.
 */

import type { Component } from "../index";
import { Markdown, visibleWidth } from "../index";
import type { RenderResultOptions } from "./renderer";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import {
	cappedRowCount,
	formatAge,
	formatCount,
	formatErrorText,
	formatMoreItems,
	formatMoreRow,
	getDomain,
	PREVIEW_LIMITS,
	replaceTabs,
	truncateToWidth,
	clipCollapsed,
} from "../render/render-utils";
import { type StatusLineOptions, urlHyperlink } from "../render";
import { framedToolCard, plainToolCard } from "../render/tool-card";
import { getSearchProviderLabel, type SearchResponse } from "./web-search-types";
import { compact, md, node, span, text } from "../native/describe";
import type { NativeChild } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { errorText, noteText, resultText } from "./native-view";

const MAX_COLLAPSED_ITEMS = PREVIEW_LIMITS.COLLAPSED_ITEMS;
/** Collapsed line budget for a raw (detail-less) response. */
const FALLBACK_COLLAPSED_LINES = 6;
const SEARCH_TITLE = "Web Search";

/** Search response and optional failure shown in the transcript. */
export interface SearchRenderDetails {
	response: SearchResponse;
	error?: string;
}

/** Status line shared by every state: the fixed title and the query as subject. */
function searchStatus(query: string | undefined, options: Omit<StatusLineOptions, "title">): StatusLineOptions {
	return {
		title: SEARCH_TITLE,
		description: query ? truncateToWidth(replaceTabs(query), 80) : undefined,
		...options,
	};
}

/** Bottom-border facts, dim and dot-joined. */
function joinFooter(theme: Theme, parts: readonly string[]): string | undefined {
	const present = parts.filter(part => part.length > 0);
	return present.length > 0 ? theme.fg("dim", present.join(theme.sep.dot)) : undefined;
}

/** Truncation marker plus expand hint for the last section, destined for the bottom border. */
function moreMarker(remaining: number, itemType: string, expanded: boolean, theme: Theme): string {
	return remaining > 0 ? formatMoreRow(remaining, itemType, theme, { expanded }) : "";
}

/** A raw response without structured details: its text as the body, capped while collapsed. */
function renderFallbackText(
	contentText: string,
	query: string | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const lines = contentText.split("\n").filter(line => line.trim());
	if (lines.length === 0) {
		return plainToolCard(theme, () => ({
			status: searchStatus(query, { icon: "warning", meta: ["no response"] }),
			phase: "warning",
		}));
	}
	return framedToolCard(theme, ({ contentWidth }) => {
		const { expanded } = options;
		const shown = expanded ? lines : lines.slice(0, FALLBACK_COLLAPSED_LINES);
		return {
			status: searchStatus(query, { icon: "success" }),
			phase: "success",
			body: shown.map(line =>
				theme.fg("toolOutput", clipCollapsed(replaceTabs(line.trim()), contentWidth, expanded)),
			),
			footerMeta: joinFooter(theme, [moreMarker(lines.length - shown.length, "line", expanded, theme)]),
		};
	});
}

/** Short auth-mode label: `OAuth`, `API`, or the raw mode. */
function searchAuthLabel(authMode: SearchResponse["authMode"]): string | undefined {
	if (authMode === "oauth") return "OAuth";
	if (authMode === "api_key") return "API";
	return authMode;
}

/** A source's display title: its title, else its URL, else `Untitled`. */
function sourceTitle(src: SearchResponse["sources"][number], url: string): string {
	if (typeof src.title === "string" && src.title.trim()) return src.title;
	return url.trim() ? url : "Untitled";
}

/** Provider, model, auth mode, source count and usage for the bottom border. */
function searchFooterParts(response: SearchResponse, sourceCount: number): string[] {
	const providerLabel = response.provider !== "none" ? getSearchProviderLabel(response.provider) : "None";
	const authShort = searchAuthLabel(response.authMode);
	const parts = [authShort ? `${providerLabel} (${authShort})` : providerLabel];
	if (response.model) parts.push(response.model);
	parts.push(formatCount("source", sourceCount));
	const usage = response.usage;
	if (usage) {
		if (usage.totalTokens !== undefined) parts.push(formatCount("token", usage.totalTokens));
		else if (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
			parts.push(`${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out tokens`);
		if (usage.searchRequests !== undefined) parts.push(formatCount("search", usage.searchRequests));
	}
	return parts;
}

/** One source row: the linked title, then dim `(domain) · age`. */
function renderSourceRow(src: SearchResponse["sources"][number], width: number, theme: Theme): string {
	const url = typeof src.url === "string" ? src.url : "";
	const domain = url ? getDomain(url) : "";
	const age = formatAge(src.ageSeconds) || (typeof src.publishedDate === "string" ? src.publishedDate : "");
	const metaParts: string[] = [];
	if (domain) metaParts.push(theme.fg("dim", `(${domain})`));
	if (age) metaParts.push(theme.fg("muted", age));
	const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(theme.fg("dim", theme.sep.dot))}` : "";
	const titleBudget = Math.max(12, width - visibleWidth(metaSuffix));
	const title = theme.fg("accent", truncateToWidth(replaceTabs(sourceTitle(src, url)), titleBudget));
	return `${url ? urlHyperlink(url, title) : title}${metaSuffix}`;
}

/** Render a web search result: the answer framed as the body, then the cited sources. */
export function renderSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: SearchRenderDetails },
	options: RenderResultOptions,
	theme: Theme,
	args?: {
		query?: string;
		maxAnswerLines?: number;
	},
): Component {
	const details = result.details;
	const response = details?.response;
	const searchQueries = Array.isArray(response?.searchQueries)
		? response.searchQueries.filter(item => typeof item === "string")
		: [];
	const query = args?.query || searchQueries[0];

	// A failure is a message, not a content block: flush.
	if (details?.error) {
		const provider = response?.provider;
		const providerLabel = provider && provider !== "none" ? getSearchProviderLabel(provider) : undefined;
		const status = searchStatus(query, { icon: "error" });
		const message = formatErrorText(providerLabel ? `${providerLabel}: ${details.error}` : details.error, theme);
		return plainToolCard(theme, () => ({ status, phase: "error", body: [message] }));
	}

	const rawText = result.content?.find(block => block.type === "text")?.text?.trim() ?? "";
	if (!response) {
		return renderFallbackText(rawText, query, options, theme);
	}

	const sources = Array.isArray(response.sources) ? response.sources : [];
	const answerText = (typeof response.answer === "string" ? response.answer.trim() : "") || rawText;
	const status = searchStatus(query, { icon: sources.length > 0 ? "success" : "warning" });
	const footerParts = searchFooterParts(response, sources.length);
	const answerMarkdown = answerText ? new Markdown(answerText, 0, 0, getMarkdownTheme()) : undefined;

	return framedToolCard(theme, ({ contentWidth }) => {
		// Read mutable state at render time
		const { expanded } = options;

		// The full answer; CLI compact mode (`omp q`) caps it while collapsed.
		const renderedAnswer = answerMarkdown ? answerMarkdown.render(contentWidth) : [];
		let answerLines: readonly string[];
		if (renderedAnswer.length === 0) {
			answerLines = [theme.fg("muted", "No answer text returned")];
		} else if (args?.maxAnswerLines !== undefined && !expanded) {
			// `renderedAnswer` is the Markdown component's shared cache — slice copies before appending.
			const capped = renderedAnswer.slice(0, cappedRowCount(renderedAnswer.length, args.maxAnswerLines));
			const remaining = renderedAnswer.length - capped.length;
			if (remaining > 0) capped.push(theme.fg("dim", formatMoreItems(remaining, "line", theme)));
			answerLines = capped;
		} else {
			answerLines = renderedAnswer;
		}

		if (sources.length === 0) {
			return { status, phase: "warning", body: answerLines, footerMeta: joinFooter(theme, footerParts) };
		}
		// Sources are the last section: their truncation marker goes to the bottom border.
		const shownSources = expanded ? sources : sources.slice(0, MAX_COLLAPSED_ITEMS);
		const marker = moreMarker(sources.length - shownSources.length, "source", expanded, theme);
		return {
			status,
			phase: "success",
			body: answerLines,
			sections: [
				{
					label: theme.fg("dim", "Sources"),
					content: shownSources.map(src => renderSourceRow(src, contentWidth, theme)),
				},
			],
			footerMeta: joinFooter(theme, [...footerParts, marker]),
		};
	});
}

/** Render a web search call: the query, pending until the search runs. */
export function renderSearchCall(
	args: { query?: string; [key: string]: unknown },
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const status = searchStatus(args.query, {
		icon: options.executionStarted ? "running" : "pending",
		spinnerFrame: options.spinnerFrame,
	});
	return plainToolCard(theme, () => ({ status }));
}

type SearchRenderArgs = { query?: string; [key: string]: unknown };

function searchHead(query: string | undefined, meta?: string, badge?: { text: string; title?: string }) {
	return {
		title: SEARCH_TITLE,
		target: query ? plainText(query) : undefined,
		targetKind: "query" as const,
		meta: meta ? [meta] : undefined,
		badges: badge ? [badge] : undefined,
	};
}

/** One cited source row: domain-initial mark, linked title, muted `domain · age`. */
function sourceRow(src: SearchResponse["sources"][number], index: number): NativeChild {
	const url = typeof src.url === "string" ? src.url : "";
	const title = sourceTitle(src, url);
	const domain = url ? getDomain(url) : "";
	const age =
		formatAge(src.ageSeconds).replace(/ ago$/, "") ||
		(typeof src.publishedDate === "string" ? src.publishedDate : "");
	const meta = [domain, age].filter(Boolean).join(" · ");
	const initial = (domain.replace(/^www\./, "")[0] ?? "?").toUpperCase();
	return node(
		"row",
		{ gap: "sm", align: "baseline", role: "omp.tool.source", href: url || undefined },
		compact([
			node("badge", { text: initial, title: domain || undefined }),
			text([span(plainText(title), "link", url ? { href: url } : undefined)], { lines: 1, truncate: "end" }),
			meta ? text([span(plainText(meta), "muted")], { lines: 1 }) : undefined,
		]),
		`${index}:${url}`,
	);
}

function describeSearchResult(
	result: ToolRenderResult<SearchRenderDetails>,
	args: SearchRenderArgs | undefined,
): NativeToolView {
	const details = result.details;
	const argQuery = typeof args?.query === "string" ? args.query : undefined;
	if (details?.error) {
		const provider = details.response?.provider;
		const label = provider && provider !== "none" ? getSearchProviderLabel(provider) : undefined;
		return {
			tool: searchHead(argQuery, label),
			tone: "error",
			body: [errorText(plainText(details.error).trim() || "Web search failed")],
		};
	}

	const rawText = resultText(result).trim();
	const response = details?.response;
	if (!response) {
		return {
			tool: searchHead(argQuery),
			tone: "warning",
			body: [noteText(rawText || "No response data")],
		};
	}

	const sources = Array.isArray(response.sources) ? response.sources : [];
	const searchQueries = Array.isArray(response.searchQueries)
		? response.searchQueries.filter(entry => typeof entry === "string")
		: [];
	const providerLabel = response.provider !== "none" ? getSearchProviderLabel(response.provider) : "None";
	const query = argQuery || searchQueries[0];
	const answer = (typeof response.answer === "string" ? response.answer.trim() : "") || rawText;

	const authShort = searchAuthLabel(response.authMode);
	let providerInfo = response.model ? `${response.model} @ ${providerLabel}` : providerLabel;
	if (authShort) providerInfo += ` (${authShort})`;
	const usage = response.usage;
	const usageParts: string[] = [];
	if (usage?.inputTokens !== undefined) usageParts.push(`in ${usage.inputTokens}`);
	if (usage?.outputTokens !== undefined) usageParts.push(`out ${usage.outputTokens}`);
	if (usage?.totalTokens !== undefined) usageParts.push(`total ${usage.totalTokens}`);
	if (usage?.searchRequests !== undefined) usageParts.push(`search ${usage.searchRequests}`);
	const tooltip = plainText([providerInfo, usageParts.join(" · ")].filter(Boolean).join("\n"));
	const badge = response.model ? { text: plainText(response.model), title: tooltip } : undefined;

	return {
		tool: searchHead(query, `${providerLabel} · ${formatCount("source", sources.length)}`, badge),
		tone: sources.length > 0 ? undefined : "warning",
		body: compact([
			answer ? { ...md(plainText(answer), { title: tooltip }), key: "answer" } : noteText("No answer text returned"),
			sources.length > 0
				? node("col", { role: "omp.tool.files" }, sources.map(sourceRow), "sources")
				: noteText("No sources returned"),
		]),
	};
}

const searchResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Render web search queries, answers, and cited sources. */
export const webSearchToolRenderer = {
	renderCall: renderSearchCall,
	renderResult: renderSearchResult,
	describeCall(args: SearchRenderArgs): NativeToolView {
		return { tool: searchHead(typeof args.query === "string" ? args.query : undefined), inline: true };
	},
	describeResult(
		result: ToolRenderResult<SearchRenderDetails>,
		_options: RenderResultOptions,
		args?: SearchRenderArgs,
	): NativeToolView | undefined {
		return searchResultMemo.get(result, [args?.query ?? ""], () => describeSearchResult(result, args));
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<{ query?: string; [key: string]: unknown }, SearchRenderDetails>;
