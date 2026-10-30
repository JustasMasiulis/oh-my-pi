import { formatContextUsage } from "../chrome/context-thresholds";
import {
	FEED_MODEL_BADGE_WIDTH,
	formatDuration,
	formatFeedModelBadge,
	formatNumber,
	formatStatusIcon,
	isFeedModelBadgeEnabled,
	truncateToWidth,
	type ConfiguredThinkingLevel,
} from "../render/render-utils";
import type { Theme } from "../theme/theme";
import { visibleWidth } from "../utils";

/** Counters displayed alongside an agent name. */
export interface AgentStats {
	toolCount?: number;
	requests?: number;
	contextTokens?: number;
	contextWindow?: number;
	cost?: number;
}

/** Format the shared tool-count, request, context, and cost stats as separate, individually styled parts. */
export function formatAgentStats(stats: AgentStats, theme: Theme): string[] {
	const parts: string[] = [];
	if (stats.toolCount) {
		parts.push(theme.fg("dim", `${formatNumber(stats.toolCount)} ${theme.icon.extensionTool}`));
	}
	if (stats.requests) {
		parts.push(theme.fg("dim", `${formatNumber(stats.requests)} req`));
	}
	if (stats.contextTokens && stats.contextTokens > 0) {
		const context =
			stats.contextWindow && stats.contextWindow > 0
				? formatContextUsage((stats.contextTokens / stats.contextWindow) * 100, stats.contextWindow)
				: formatNumber(stats.contextTokens);
		parts.push(theme.fg("dim", context));
	}
	if (stats.cost && stats.cost > 0) parts.push(theme.fg("statusLineCost", `$${stats.cost.toFixed(2)}`));
	return parts;
}

/** Map an agent lifecycle state onto the shared tool status icon vocabulary. */
export function agentStatusIcon(status: AgentTreeRowOptions["status"], theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "completed":
			return formatStatusIcon("success", theme);
		case "failed":
			return formatStatusIcon("error", theme);
		case "running":
			return formatStatusIcon("running", theme, spinnerFrame);
		default:
			return formatStatusIcon(status, theme);
	}
}

/** Tool-specific presentation layered onto a bounded agent progress row. */
export interface AgentTreeRowOptions {
	/** Lifecycle state; `warning` marks a settled agent whose result needs attention. */
	status: "pending" | "running" | "completed" | "failed" | "aborted" | "warning";
	presentation: "task" | "eval";
	prefix: string;
	id: string;
	width: number;
	model?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	advisor?: boolean;
	spinnerFrame?: number;
	frozen?: boolean;
	roleBadge?: string;
	statusBadge?: string;
	description?: string;
	preview?: string;
	stats?: AgentStats;
	/** The agent's own completion estimate (0–100); shown only while live. */
	completionPercent?: number;
	durationMs?: number;
}

/** Render an agent row while reserving its identifier and required status badges. */
export function renderAgentTreeRow(
	options: AgentTreeRowOptions,
	theme: Theme,
): { line: string; descriptionShown: boolean } {
	const { status, width, description } = options;
	const task = options.presentation === "task";
	const live = status === "pending" || status === "running";
	const nameColor = live && options.frozen ? "dim" : "accent";
	const descriptionColor = live && options.frozen ? "dim" : "text";
	// Task rows sit inside a framed card whose committed rows must not repaint, so they never animate.
	const animate = !task && live && !options.frozen;
	const icon = agentStatusIcon(status, theme, animate ? options.spinnerFrame : undefined);
	const lead = `${options.prefix}${options.prefix ? " " : ""}${icon} `;
	const statusBadge = options.statusBadge ?? "";
	const id = Number.isFinite(width)
		? truncateToWidth(options.id, Math.max(0, width - visibleWidth(lead) - visibleWidth(statusBadge)))
		: options.id;
	const roleBadge =
		options.roleBadge && Number.isFinite(width)
			? truncateToWidth(
					options.roleBadge,
					Math.max(0, width - visibleWidth(lead) - visibleWidth(id) - visibleWidth(statusBadge)),
				)
			: (options.roleBadge ?? "");
	const badges = `${roleBadge}${statusBadge}`;
	const modelWidth = width - visibleWidth(lead) - visibleWidth(id) - visibleWidth(badges) - 1;
	const model =
		isFeedModelBadgeEnabled() && (task || options.model)
			? formatFeedModelBadge(
					options.model,
					options.thinkingLevel,
					options.advisor,
					theme,
					Math.min(FEED_MODEL_BADGE_WIDTH, task ? Math.max(0, modelWidth) : modelWidth),
				)
			: "";
	const modelLead = model ? `${model} ` : "";
	const descriptionShown = Boolean(
		description && visibleWidth(`${lead}${modelLead}${id}: ${description}${badges}`) <= width,
	);
	const name = theme.fg(nameColor, theme.bold(id));
	const title = descriptionShown
		? `${name}${theme.fg(nameColor, ":")} ${theme.fg(descriptionColor, description!)}`
		: name;
	let line = `${lead}${modelLead}${title}${badges}`;
	if (options.preview) line += options.preview;
	const meta: string[] = [];
	if (live && options.completionPercent !== undefined) {
		meta.push(theme.fg("accent", `${options.completionPercent}%`));
	}
	if (options.stats) meta.push(...formatAgentStats(options.stats, theme));
	if (options.durationMs !== undefined && options.durationMs > 0) {
		meta.push(theme.fg("dim", formatDuration(options.durationMs)));
	}
	if (meta.length > 0) line += ` ${meta.join(theme.fg("dim", theme.sep.dot))}`;
	return { line: Number.isFinite(width) ? truncateToWidth(line, width, "") : line, descriptionShown };
}
