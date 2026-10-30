import type { Component } from "../tui";
import type { Theme, ThemeColor } from "../theme/theme";
import {
	formatDuration,
	formatErrorText,
	formatNumber,
	replaceTabs,
	sanitizeDisplayLines,
} from "../render/render-utils";
import { truncateToWidth } from "../utils";
import type { StatusLineOptions } from "../render/status-line";
import { plainToolCard } from "../render/tool-card";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { compact, node, span, text } from "../native/describe";
import { OwnerMemo } from "../native/memo";
import { errorView, noteText, resultText, toolHead } from "./native-view";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";
/** Lifecycle state of a tracked goal. */
export type GoalStatus = "active" | "paused" | "budget-limited" | "complete" | "dropped";

/** Serializable goal progress and resource budget. */
export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

/** Goal operation outcome displayed in the transcript. */
export interface GoalToolDetails {
	op: "create" | "get" | "complete" | "resume" | "drop";
	goal?: Goal | null;
	remainingTokens?: number | null;
	completionBudgetReport?: string | null;
}
function describeOp(op: string | undefined): string | undefined {
	switch (op) {
		case "create":
			return "set";
		case "complete":
			return "complete";
		case "get":
			return "check";
		case "resume":
			return "resume";
		case "drop":
			return "drop";
		default:
			return op;
	}
}

function goalBadgeColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "complete":
			return "success";
		case "budget-limited":
			return "warning";
		case "paused":
		case "dropped":
			return "muted";
		default:
			return "accent";
	}
}

/** The goal objective as one muted row: truncated collapsed, whole (the flush card wraps it) expanded. */
function objectiveRow(uiTheme: Theme, objective: string, width: number, expanded: boolean): string {
	const text = replaceTabs(objective);
	return uiTheme.fg("muted", expanded ? text : truncateToWidth(text, width));
}

/** Goal usage facts: tokens spent (against the budget, when set), then elapsed time. */
function goalUsageParts(goal: Goal): string[] {
	const used = formatNumber(goal.tokensUsed);
	let tokens = `${used} tokens`;
	if (goal.tokenBudget !== undefined) {
		const left = formatNumber(Math.max(0, goal.tokenBudget - goal.tokensUsed));
		tokens = `${used} / ${formatNumber(goal.tokenBudget)} tokens (${left} left)`;
	}
	const parts = [tokens];
	if (goal.timeUsedSeconds > 0) parts.push(`${formatDuration(goal.timeUsedSeconds * 1000)} elapsed`);
	return parts;
}

interface GoalRenderArgs {
	op?: GoalToolDetails["op"];
	objective?: string;
	token_budget?: number;
}

function describeGoalResult(result: ToolRenderResult<GoalToolDetails>, args?: GoalRenderArgs): NativeToolView {
	const details = result.details;
	const description = describeOp(details?.op ?? args?.op);
	if (result.isError) return errorView("Goal", resultText(result) || "Goal tool failed", description);
	const goal = details?.goal ?? null;
	if (!goal) return { head: toolHead("Goal", description, "no active goal"), tone: "warning" };

	const head = [
		...toolHead("Goal", description),
		span(" "),
		span(goal.status, `${goalBadgeColor(goal.status)} strong`),
	];
	const meta = goalUsageParts(goal);
	const report = details?.completionBudgetReport;
	return {
		head,
		body: compact([
			text([span(`"${goal.objective.trim()}"`, "muted")], { wrap: "word" }),
			text([span(meta.join(" · "), "dim")], { wrap: "word" }),
			report ? node("section", { head: [span("Report", "toolTitle")] }, [noteText(report)], "report") : undefined,
		]),
	};
}

const goalResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Renders goal creation, status, and lifecycle results. */
export const goalToolRenderer = {
	renderCall(args: GoalRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const status: StatusLineOptions = {
			icon: options.executionStarted ? "running" : "pending",
			spinnerFrame: options.spinnerFrame,
			title: "Goal",
			description: describeOp(args.op),
			meta:
				args.op === "create" && args.token_budget !== undefined
					? [`budget ${formatNumber(args.token_budget)}`]
					: undefined,
		};
		const objective = args.op === "create" ? args.objective?.trim() : undefined;
		return plainToolCard(uiTheme, ({ contentWidth }) => ({
			status,
			phase: "pending",
			body: objective ? [objectiveRow(uiTheme, objective, contentWidth, options.expanded)] : undefined,
		}));
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GoalToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GoalRenderArgs,
	): Component {
		const fallbackText = result.content?.find(c => c.type === "text")?.text ?? "";
		const details = result.details;
		const description = describeOp(details?.op ?? args?.op);

		if (result.isError) {
			return plainToolCard(uiTheme, () => ({
				status: { icon: "error", title: "Goal", description },
				phase: "error",
				body: [formatErrorText(fallbackText || "Goal tool failed", uiTheme)],
			}));
		}

		const goal = details?.goal ?? null;
		if (!goal) {
			return plainToolCard(uiTheme, () => ({
				status: { icon: "warning", title: "Goal", description, meta: ["no active goal"] },
				phase: "warning",
			}));
		}

		const status: StatusLineOptions = {
			icon: "success",
			title: "Goal",
			description,
			badge: { label: goal.status, color: goalBadgeColor(goal.status) },
		};
		const budgetLine = uiTheme.fg("dim", goalUsageParts(goal).join(uiTheme.sep.dot));
		const report = details?.completionBudgetReport;

		return plainToolCard(uiTheme, ({ contentWidth }) => ({
			status,
			phase: "success",
			body: [objectiveRow(uiTheme, goal.objective.trim(), contentWidth, options.expanded), budgetLine],
			sections: report
				? [{ label: "Report", content: sanitizeDisplayLines(report).map(line => uiTheme.fg("muted", line)) }]
				: undefined,
		}));
	},

	describeCall(args: GoalRenderArgs): NativeToolView {
		const head: TspSpan[] = toolHead("Goal", describeOp(args.op));
		const objective = args.objective?.trim();
		if (args.op === "create" && objective) head.push(span(" "), span(`"${objective}"`, "muted"));
		if (args.op === "create" && args.token_budget !== undefined) {
			head.push(span(" "), span(`budget ${formatNumber(args.token_budget)}`, "muted"));
		}
		return { head };
	},

	describeResult(
		result: ToolRenderResult<GoalToolDetails>,
		_options: RenderResultOptions,
		args?: GoalRenderArgs,
	): NativeToolView | undefined {
		return goalResultMemo.get(result, [args?.op], () => describeGoalResult(result, args));
	},

	mergeCallAndResult: true,
} satisfies ToolRenderer<GoalRenderArgs, GoalToolDetails>;
