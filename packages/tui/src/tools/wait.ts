import type { Component } from "../tui";
import { Text } from "../components/text";
import { visibleWidth } from "../utils";
import { formatAge, formatCount } from "@oh-my-pi/pi-utils";
import { shimmerEnabled, shimmerText } from "../theme/shimmer";
import type { Theme } from "../theme/theme";
import {
	FLUSH_BODY_INDENT,
	Hasher,
	nestRows,
	type RenderCache,
	renderFittedStatusLine,
	renderStatusLine,
	type StatusLineOptions,
	renderTreeList,
	truncateToWidth,
} from "../render/index";
import { formatArtifactErrorNotice, stripOutputNotice, type OutputMeta } from "./output-meta";
import {
	FEED_MODEL_BADGE_WIDTH,
	formatBadge,
	formatDuration,
	formatErrorText,
	formatExpandHint,
	formatMoreRow,
	sanitizeDisplayLines,
	formatFeedModelBadge,
	formatStatusIcon,
	getPreviewLines,
	isFeedModelBadgeEnabled,
	PREVIEW_LIMITS,
	replaceTabs,
	cappedRowCount,
	type ToolUIStatus,
	cappedHeadLines,
	createCachedComponent,
	type ConfiguredThinkingLevel,
} from "../render/render-utils";
import type { StructuredSubagentOutput } from "./task";
import { describeJobTiles, type JobTile, type JobWidgetView, renderJobTileLines } from "./job-widget";
import type { RenderResultOptions, ToolRenderer, ToolActivitySummary } from "./renderer";
import type { IrcDeliveryReceipt, IrcMessage } from "./irc";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { card as cardNode, compact, elapsed, keyed, md, node, row, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { errorView, resultText, toolHead } from "./native-view";
import type { NativeToolView, ToolRenderResult } from "./renderer";

/** Whether a wait snapshot contains only running jobs and no cancellations. */
export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as CoordinationDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(job => job?.status === "running");
}
/** Coordination details retained by wait and background job operations. */
export type CoordinationOp = "send" | "wait" | "cancel";

/** Background-job row surfaced by `wait`/`cancel` results and `proc://` listings. */
export interface JobSnapshot {
	id: string;
	type: "bash" | "task" | "eval";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	/** Process exit status when the job reports one. */
	exitCode?: number;
	/** Effective task model selector, including an explicit reasoning suffix when configured. */
	resolvedModel?: string;
	/** Provider/id including routing, with no added thinking suffix. */
	resolvedModelIdentity?: string;
	/** Explicit thinking metadata, independent of the model identity. */
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	/** True when the task progress reports an attached live advisor. */
	advisor?: boolean;
	/** The task agent's latest self-estimated completion (0–100); see `AgentProgress.completionPercent`. */
	completionPercent?: number;
	/** The task agent's latest stage in its own words; see `AgentProgress.stage`. */
	stage?: string;
	/** Running task only: assistant requests so far; see `AgentProgress.requests`. */
	requests?: number;
	/** Running task only: cumulative cost in USD; see `AgentProgress.cost`. */
	cost?: number;
	/** Running task only: latest per-turn context size; see `AgentProgress.contextTokens`. */
	contextTokens?: number;
	/** Running task only: the model's context window; see `AgentProgress.contextWindow`. */
	contextWindow?: number;
	/** The job's live widget, while one is being drawn; frozen at its last state once the job settles. */
	widget?: JobWidgetView;
	resultText?: string;
	errorText?: string;
	/** Source-output metadata retained for per-job warnings and persisted row rendering. */
	meta?: OutputMeta;
	/** Capture error in historical snapshots; new snapshots store source metadata in `meta`. */
	artifactError?: OutputMeta["artifactError"];
	structured?: StructuredSubagentOutput;
	/**
	 * `agent://<id>` handle backing this job's artifacts — the job-row's
	 * registry `agentId` when the manager disambiguated a requested job id
	 * on collision, else the job id itself. See {@link AsyncJob.agentId}.
	 */
	agentUrlId?: string;
	/**
	 * Whether this job's turn published `<agentUrlId>.md`. False where the job
	 * body reported that it wrote none, so `agent://` still holds an earlier
	 * turn's output; undefined where the body does not report it.
	 */
	agentOutputPublished?: boolean;
}

/** Outcome of cancelling one background job. */
export type CancelStatus = "cancelled" | "not_found" | "already_completed";

/** Cancellation outcome and its model-facing explanation. */
export interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

/**
 * A live subagent from the AgentRegistry that has no backing job in the
 * AsyncJobManager — e.g. an idle agent woken (or a parked agent revived) via
 * a peer message, or a spawn owned by another agent. Surfaced by background
 * snapshots so the displayed picture matches the UI's running-agent
 * count.
 */
export interface AgentActivitySnapshot {
	id: string;
	parentId?: string;
	/** Latest activity gist recorded by the registry (display-only). */
	activity?: string;
	/** Time since the agent was registered. */
	ageMs: number;
	/**
	 * Whether an attached session corroborates the `running` claim. False marks
	 * a ref that says `running` with no turn in flight — either a spawn still
	 * wiring up or a stale registration that an explicit cancellation clears (#8634).
	 */
	live: boolean;
	/**
	 * Acceptance time of the agent's final result, when the registry recorded
	 * one. With `live: false` this is an accepted run the parent may cancel
	 * instead of waiting on (#11079).
	 */
	acceptedAt?: number;
}

/** Details shared by messaging receipts and job/wait results. */
export interface CoordinationDetails {
	meta?: OutputMeta;
	op: CoordinationOp;
	from?: string;
	to?: string;
	receipts?: IrcDeliveryReceipt[];
	/** Message consumed by `wait`. */
	waited?: IrcMessage | null;
	jobs?: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
	/** Running subagents not represented by a job row in this result. */
	agents?: AgentActivitySnapshot[];
	/** `wait` was cut short by steering, a peer message, or a completion notice that injects next. */
	interrupted?: boolean;
}

// =============================================================================
// TUI Renderer
// =============================================================================

const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const LABEL_LINES_EXPANDED = 3;
const PREVIEW_LINE_WIDTH = 80;
/** Body rows of a flush card sit under the header at this indent. */
const INDENT = " ".repeat(FLUSH_BODY_INDENT);

/**
 * Fit a self-built flush card to `width`: the header stays on one row with its
 * subject cut in the middle, and body rows, which reserve their own facts,
 * truncate.
 */
function fitFlushRows(header: StatusLineOptions, body: readonly string[], width: number, theme: Theme): string[] {
	return [
		truncateToWidth(renderFittedStatusLine(header, theme, width), width),
		...body.map(row => truncateToWidth(row, width)),
	];
}

/** A job's lifecycle as a row status glyph. */
export function jobStatusIcon(status: JobSnapshot["status"]): ToolUIStatus {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "aborted";
		case "running":
			return "running";
	}
}

/**
 * Facts that follow a job's id on its row, in the shared order: type, a
 * non-zero exit, live progress, duration. The status glyph carries the state.
 */
export function jobRowFacts(job: JobSnapshot, theme: Theme): string[] {
	return compact([
		theme.fg("dim", job.type),
		job.exitCode !== undefined && job.exitCode !== 0 ? theme.fg("error", `exit ${job.exitCode}`) : undefined,
		job.status === "running" && job.completionPercent !== undefined
			? theme.fg("accent", `${job.completionPercent}%`)
			: undefined,
		theme.fg("dim", formatDuration(job.durationMs)),
	]);
}

/**
 * Task job results are delivered in the model-facing `<task-result>` envelope
 * (prompts/tools/task-summary.md) so the parent agent can parse status and the
 * `agent://` pointer. The wrapper markup is noise to a human — preview the
 * inner <output>/<preview> body instead.
 */
function stripTaskResultEnvelope(text: string): string {
	if (!text.startsWith("<task-result")) return text;
	const body = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(text)?.[2];
	return body?.trim() || text;
}

/**
 * Pretty-printed JSON output wastes the collapsed one-line preview on a lone
 * "{" — flatten structured-looking bodies onto a single line. Slice first:
 * downstream truncation keeps at most a few hundred columns, so collapsing
 * whitespace across a multi-KB body would be pure waste.
 */
function flattenStructuredPreview(text: string): string {
	const first = text[0];
	if (first !== "{" && first !== "[") return text;
	return text.slice(0, PREVIEW_LINES_EXPANDED * PREVIEW_LINE_WIDTH * 2).replace(/\s+/g, " ");
}

/** The row label: a running task's own stage line when it reports one, else the job's label. */
function jobRowLabel(job: JobSnapshot): string {
	return job.type === "task" && job.status === "running" && job.stage?.trim() ? job.stage : job.label;
}

/** A job as its tile; `live` while the card's clocks run. */
function jobTile(job: JobSnapshot, live: boolean): JobTile {
	return {
		id: job.id,
		type: job.type,
		status: job.status,
		label: job.label,
		durationMs: job.durationMs,
		live: live && job.status === "running",
		...(job.widget ? { widget: job.widget } : {}),
		...(job.status === "running" && job.completionPercent !== undefined
			? { completionPercent: job.completionPercent }
			: {}),
		...(job.stage ? { stage: job.stage } : {}),
		...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
	};
}

/** Identity of the widgets a job list draws: changes whenever any widget's data or state does. */
function widgetStamp(jobs: readonly JobSnapshot[] | undefined): string {
	if (!jobs) return "";
	let stamp = "";
	for (const job of jobs) if (job.widget) stamp += `${job.id}:${job.widget.updatedAt}:${job.widget.state};`;
	return stamp;
}

/** Tiles a native wait card shows before it counts the rest. */
const TILES_SHOWN = 9;

/** Sort order: running first (what is still pending), then failed, cancelled, completed. */
const JOB_STATUS_ORDER: Record<JobSnapshot["status"], number> = { running: 0, failed: 1, cancelled: 2, completed: 3 };

/** Card subject: the job count, or the agent count for an agents-only roster. */
function waitSubject(jobs: number, agents: number): string {
	return jobs > 0 || agents === 0 ? formatCount("job", jobs) : formatCount("agent", agents);
}

/** Header meta: per-outcome job counts and the agent count. */
function waitMeta(jobs: readonly JobSnapshot[], agents: number): string[] {
	const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
	for (const job of jobs) counts[job.status]++;
	const meta: string[] = [];
	if (counts.completed > 0) meta.push(`${counts.completed} done`);
	if (counts.failed > 0) meta.push(`${counts.failed} failed`);
	if (counts.cancelled > 0) meta.push(`${counts.cancelled} cancelled`);
	if (counts.running > 0) meta.push(`${counts.running} running`);
	if (agents > 0 && jobs.length > 0) meta.push(formatCount("agent", agents));
	return meta;
}

/**
 * Outcome of a settled wait: a failed job is a partial failure (warning); jobs
 * or agents still running make it a poll snapshot (neutral info); otherwise done.
 */
function waitOutcome(jobs: readonly JobSnapshot[], agents: number): "warning" | "info" | "success" {
	if (jobs.some(job => job.status === "failed")) return "warning";
	if (agents > 0 || jobs.some(job => job.status === "running")) return "info";
	return "success";
}

/** Columns {@link nestRows} spends on its connector and the space after it. */
function nestedRowIndent(theme: Theme): number {
	return Math.max(visibleWidth(theme.tree.branch), visibleWidth(theme.tree.last)) + 1;
}

/** Pending wait frame. */
function waitRenderCall(_args: object, options: RenderResultOptions, uiTheme: Theme): Component {
	return new Text(
		renderStatusLine(
			{
				icon: options.executionStarted ? "running" : "pending",
				spinnerFrame: options.spinnerFrame,
				title: "Wait",
			},
			uiTheme,
		),
		0,
		0,
	);
}

/** Result frame for wait snapshots and the agents roster. */
function jobsRenderResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: CoordinationDetails;
		isError?: boolean;
	},
	options: RenderResultOptions,
	uiTheme: Theme,
): Component {
	const jobs = result.details?.jobs ?? [];
	const agents = result.details?.agents ?? [];

	if (jobs.length === 0 && agents.length === 0) {
		const fallback = result.content?.find(c => c.type === "text")?.text?.trim() || "No jobs to process";
		const header = renderStatusLine({ icon: "warning", title: "Wait", meta: ["0 jobs"] }, uiTheme);
		return new Text([header, `${INDENT}${uiTheme.fg("muted", fallback)}`].join("\n"), 0, 0);
	}

	const runningCount = jobs.filter(job => job.status === "running").length;
	const headerIcon: ToolUIStatus = options.isPartial ? "running" : waitOutcome(jobs, agents.length);
	const header: StatusLineOptions = {
		icon: headerIcon,
		spinnerFrame: options.spinnerFrame,
		title: "Wait",
		description: waitSubject(jobs.length, agents.length),
		meta: waitMeta(jobs, agents.length),
	};

	const outputMeta = result.details?.meta;
	// Historical snapshots promoted a job failure to the root. Render it there
	// only when no row identifies that failure; new report capture errors are distinct.
	const aggregateArtifactError =
		outputMeta?.artifactError &&
		(outputMeta.source?.type === "report" ||
			!jobs.some(job => (job.meta?.artifactError ?? job.artifactError) === outputMeta.artifactError))
			? outputMeta.artifactError
			: undefined;

	const sortedJobs = [...jobs].sort(
		(a, b) => JOB_STATUS_ORDER[a.status] - JOB_STATUS_ORDER[b.status] || b.durationMs - a.durationMs,
	);

	/** Detail rows nested under a job: label overflow, failure reason, capture warning, output preview. */
	const jobDetails = (job: JobSnapshot, expanded: boolean, width: number, labelLines: readonly string[]): string[] => {
		const details = labelLines.map(line => uiTheme.fg("toolOutput", truncateToWidth(line, width)));
		const artifactError = job.meta?.artifactError ?? job.artifactError;
		if (artifactError) {
			details.push(uiTheme.fg("warning", truncateToWidth(formatArtifactErrorNotice(artifactError), width)));
		}
		// Legacy rows did not retain full metadata. Strip the known warning
		// footer so the dedicated row/root warning remains the only copy.
		const previewError =
			artifactError ?? (outputMeta?.source?.type !== "report" ? outputMeta?.artifactError : undefined);
		const previewMeta = job.meta ?? (previewError ? { artifactError: previewError } : undefined);
		// Collapsed, only a failure says why; the rest of the output stays behind Ctrl+O.
		const source = expanded
			? job.errorText?.trim() || job.resultText?.trim() || ""
			: job.status === "failed"
				? (job.errorText ?? "")
				: "";
		const preview = flattenStructuredPreview(stripTaskResultEnvelope(stripOutputNotice(source, previewMeta).trim()));
		if (preview) {
			const tone = job.errorText ? "error" : "dim";
			const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
			for (const line of getPreviewLines(preview, maxLines, Math.min(PREVIEW_LINE_WIDTH, width))) {
				details.push(uiTheme.fg(tone, replaceTabs(line)));
			}
		}
		return details;
	};

	/** Whether Ctrl+O shows more of `job`: further label lines, its output, or a longer failure. */
	const jobHidesDetail = (job: JobSnapshot, width: number): boolean => {
		const labelLineCount = jobRowLabel(job)
			.split(/\r?\n/)
			.filter(line => line.trim()).length;
		if (labelLineCount > 1) return true;
		const collapsed = jobDetails(job, false, width, []);
		const expanded = jobDetails(job, true, width, []);
		return expanded.length !== collapsed.length || expanded.some((line, index) => line !== collapsed[index]);
	};

	/** One job: `<icon> id - type - exit N - 40% - 4.1s - model - label`, details nested below. */
	const jobLines = (job: JobSnapshot, expanded: boolean, width: number, live: boolean): string[] => {
		const sep = uiTheme.sep.dot;
		const running = job.status === "running";
		const icon = formatStatusIcon(
			jobStatusIcon(job.status),
			uiTheme,
			running && live ? options.spinnerFrame : undefined,
		);
		const facts = jobRowFacts(job, uiTheme).join(sep);
		const rawLabel = jobRowLabel(job);
		const labelLines =
			rawLabel.trim() && rawLabel.trim() !== job.id ? rawLabel.split(/\r?\n/).filter(l => l.trim()) : [];
		const detailWidth = Math.max(1, width - nestedRowIndent(uiTheme));

		if (job.widget?.state === "live") {
			// The tile's own chart carries the state; its meta is just progress and age.
			const tileMeta = compact([
				running && job.completionPercent !== undefined
					? uiTheme.fg("accent", `${job.completionPercent}%`)
					: undefined,
				uiTheme.fg("dim", formatDuration(job.durationMs)),
			]).join(" ");
			return [
				...renderJobTileLines(jobTile(job, live), width, uiTheme, {
					lead: `${icon} `,
					meta: tileMeta,
					full: expanded,
				}),
				...nestRows(jobDetails(job, expanded, detailWidth, []), uiTheme),
			];
		}

		// The outcome is reserved first; a long id gives way so a failure is never cut off the row.
		const idBudget = Math.max(1, width - visibleWidth(`${icon} `) - visibleWidth(`${sep}${facts}`));
		const id = truncateToWidth(replaceTabs(job.id).replace(/\s+/g, " "), idBudget);
		const idText = live && running && shimmerEnabled() ? shimmerText(id, uiTheme) : uiTheme.fg("accent", id);
		const modelIdentity = job.resolvedModelIdentity ?? job.resolvedModel;
		let row = `${icon} ${idText}${sep}${facts}`;
		if (job.type === "task" && isFeedModelBadgeEnabled() && typeof modelIdentity === "string") {
			const badgeWidth = Math.min(FEED_MODEL_BADGE_WIDTH, width - visibleWidth(row) - visibleWidth(sep));
			if (badgeWidth > 0) {
				const badge = formatFeedModelBadge(
					modelIdentity,
					job.resolvedThinkingLevel,
					job.advisor === true,
					uiTheme,
					badgeWidth,
				);
				if (badge) row += `${sep}${badge}`;
			}
		}
		const firstLabel = replaceTabs(labelLines[0] ?? "").trim();
		const labelBudget = Math.min(LABEL_MAX_WIDTH, width - visibleWidth(row) - visibleWidth(sep));
		const labelInline = firstLabel !== "" && labelBudget >= 8;
		if (labelInline) row += `${sep}${uiTheme.fg("muted", truncateToWidth(firstLabel, labelBudget))}`;
		const extraLabels = expanded ? labelLines.slice(labelInline ? 1 : 0, LABEL_LINES_EXPANDED).map(replaceTabs) : [];
		return [
			truncateToWidth(row, width, ""),
			...nestRows(jobDetails(job, expanded, detailWidth, extraLabels), uiTheme),
		];
	};

	const agentLine = (agent: AgentActivitySnapshot, width: number): string => {
		const sep = uiTheme.sep.dot;
		const icon = agent.live
			? formatStatusIcon("running", uiTheme, options.spinnerFrame)
			: formatStatusIcon("warning", uiTheme);
		const badge = agent.live ? formatBadge("agent", "accent", uiTheme) : formatBadge("no turn", "warning", uiTheme);
		const facts = compact([
			uiTheme.fg("dim", formatDuration(agent.ageMs)),
			agent.parentId ? uiTheme.fg("dim", `${uiTheme.format.arrowLeft} ${replaceTabs(agent.parentId)}`) : undefined,
			agent.activity
				? uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(agent.activity), LABEL_MAX_WIDTH))
				: undefined,
		]).join(sep);
		const id = uiTheme.fg("accent", replaceTabs(agent.id).replace(/\s+/g, " "));
		return truncateToWidth(`${icon} ${id} ${badge}${sep}${facts}`, width);
	};

	let cached: RenderCache | undefined;
	return {
		render(width: number): readonly string[] {
			const expanded = options.expanded;
			const spinnerFrame = options.spinnerFrame ?? 0;
			// Running-job labels shimmer while the wait block is live; the band
			// phase is Date.now()-sampled at render time, so serving cached bytes
			// would pin it to the spinner cadence. Bypass the cache while any row
			// animates, and key on the animation state so a sealed block never
			// hits stale shimmered bytes.
			const shimmerActive = runningCount > 0 && options.spinnerFrame !== undefined && shimmerEnabled();
			const key = new Hasher()
				.bool(expanded)
				.u32(width)
				.u32(spinnerFrame)
				.bool(shimmerActive)
				.bool(isFeedModelBadgeEnabled())
				.str(widgetStamp(jobs))
				.digest();
			if (!shimmerActive && cached?.key === key) return cached.lines;

			const rowWidth = Math.max(1, width - INDENT.length);
			const live = options.spinnerFrame !== undefined;
			const body: string[] = [];
			if (aggregateArtifactError) {
				body.push(uiTheme.fg("warning", formatArtifactErrorNotice(aggregateArtifactError)));
			}
			const listRows = (rowsExpanded: boolean): string[] => {
				const rows = renderTreeList<JobSnapshot>(
					{
						items: sortedJobs,
						flush: true,
						expanded: rowsExpanded,
						maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
						itemType: "job",
						width: rowWidth,
						renderItem: job => jobLines(job, rowsExpanded, rowWidth, live),
					},
					uiTheme,
				);
				if (agents.length === 0) return rows;
				return rows.concat(
					renderTreeList<AgentActivitySnapshot>(
						{
							items: agents,
							flush: true,
							expanded: rowsExpanded,
							maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
							itemType: "agent",
							width: rowWidth,
							renderItem: agent => agentLine(agent, rowWidth),
						},
						uiTheme,
					),
				);
			};
			let rows = listRows(expanded);
			// A capped list carries the hint on its `… N more` row; otherwise say so when a row holds back detail.
			const cap = PREVIEW_LIMITS.COLLAPSED_ITEMS;
			const jobsCapped =
				cappedRowCount(sortedJobs.length, cap, rowWidth, () =>
					jobLines(sortedJobs[cap], false, rowWidth, live).join("\n"),
				) < sortedJobs.length;
			const agentsCapped =
				cappedRowCount(agents.length, cap, rowWidth, () => agentLine(agents[cap], rowWidth)) < agents.length;
			const capped = jobsCapped || agentsCapped;
			if (!expanded && !capped) {
				if (sortedJobs.some(job => jobHidesDetail(job, rowWidth))) rows.push(formatExpandHint(uiTheme));
				// A settled block whose Ctrl+O draws in no more rows (the hint's included) shows expanded.
				const full = runningCount === 0 ? listRows(true) : undefined;
				if (full && full.length <= rows.length) rows = full;
			}
			body.push(...rows);
			const all = fitFlushRows(
				header,
				body.map(line => `${INDENT}${line}`),
				width,
				uiTheme,
			);
			cached = { key, lines: all };
			return all;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

// =============================================================================
// Display-only IRC cards and wait-message results
// =============================================================================

const BODY_LINES_COLLAPSED = 2;
const BODY_LINES_EXPANDED = 12;
const BODY_LINE_WIDTH = 100;

function messageAge(ts: number | undefined): string {
	if (!ts) return "";
	return formatAge(Math.max(1, Math.round((Date.now() - ts) / 1000)));
}

/** Message body preview rows, indented under the header; a trailing dim row counts elided lines. */
function bodyLines(
	body: string,
	expanded: boolean,
	theme: Theme,
	width: number,
	collapsedLines = BODY_LINES_COLLAPSED,
): string[] {
	const max = expanded ? BODY_LINES_EXPANDED : collapsedLines;
	const rows = body.split("\n").filter(line => line.trim());
	// A lone hidden line shows only when it draws unclipped: within the width and the per-line clip.
	const fitWidth = Math.min(width, INDENT.length + BODY_LINE_WIDTH);
	const shownCount = cappedRowCount(
		rows.length,
		max,
		fitWidth,
		() => `${INDENT}${theme.fg("toolOutput", replaceTabs(rows[max].trim()))}`,
	);
	const preview = cappedHeadLines(rows, shownCount);
	const lines = preview.lines.map(
		line => `${INDENT}${theme.fg("toolOutput", replaceTabs(truncateToWidth(line.trim(), BODY_LINE_WIDTH)))}`,
	);
	if (preview.hidden > 0) lines.push(`${INDENT}${formatMoreRow(preview.hidden, "line", theme, { expanded })}`);
	return lines;
}

/** A display-only IRC traffic card: who sent what to whom, and when. */
export interface IrcMessageCard {
	kind: "incoming" | "autoreply" | "relay" | "workpool";
	from?: string;
	to?: string;
	body?: string;
	replyTo?: string;
	timestamp?: number;
	pool?: string;
	mode?: string;
}

/** IRC card subject: the sender, the recipient, or both, joined by direction arrows. */
function ircCardSubject(card: IrcMessageCard, theme: Theme): string {
	const { arrowLeft, arrowRight } = theme.format;
	const from = replaceTabs(card.from?.trim() || "?");
	const to = replaceTabs(card.to?.trim() || "?");
	switch (card.kind) {
		case "incoming":
			return `${arrowLeft} ${from}`;
		case "autoreply":
			return `${arrowRight} ${to}`;
		case "workpool":
			return `${replaceTabs(card.pool?.trim() || "?")} ${arrowRight} ${to}`;
		case "relay":
			return `${from} ${arrowRight} ${to}`;
	}
}

/**
 * Display-only transcript card for live IRC traffic: `irc:incoming` DMs
 * delivered to this session, `irc:autoreply` side-channel replies sent on
 * this session's behalf, and `irc:relay` observations of agent↔agent
 * traffic. Shares the IRC tool card's header and body conventions.
 */
export function createIrcMessageCard(card: IrcMessageCard, getExpanded: () => boolean, uiTheme: Theme): Component {
	const title = card.kind === "workpool" ? "Pool" : "IRC";
	const subject = ircCardSubject(card, uiTheme);
	const body = card.body ?? "";
	const meta: string[] = [];
	if (card.kind === "autoreply") meta.push("auto");
	if (card.kind === "workpool" && card.mode) meta.push(replaceTabs(card.mode));
	if (card.replyTo) meta.push("reply");
	const age = messageAge(card.timestamp);
	if (age) meta.push(age);
	const component = createCachedComponent(getExpanded, (width, expanded) => {
		const header: StatusLineOptions = { icon: "info", title, description: subject, meta };
		const lines = body.trim() ? bodyLines(body, expanded, uiTheme, width, 3) : [];
		return fitFlushRows(header, lines, width, uiTheme);
	});
	// Terminal-local collapse replaces `getExpanded`; the node never changes after creation.
	const described = cardNode(
		{
			role: `omp.irc.${card.kind}`,
			tone: "info",
			head: [
				span(title, "accent"),
				span(": "),
				span(plainText(subject), "muted"),
				...meta.filter(part => part !== age).map(part => span(` ${part}`, "dim")),
			],
			collapsible: body.trim().length > 0,
			preview: { lines: 3 },
		},
		compact([
			card.timestamp
				? row([elapsed(Date.now() - card.timestamp), text([span("ago", "dim")])], { gap: "xs" })
				: undefined,
			body.trim() ? md(body) : undefined,
		]),
	);
	return Object.assign(component, { describe: () => described });
}

function describeJobsResult(
	result: ToolRenderResult<CoordinationDetails>,
	isPartial: boolean,
): NativeToolView | undefined {
	const jobs = result.details?.jobs ?? [];
	const agents = result.details?.agents ?? [];
	if (jobs.length === 0 && agents.length === 0) {
		return {
			head: toolHead("Wait", "0 jobs"),
			tone: "warning",
			body: [text([span(plainText(resultText(result) || "No jobs to process"), "muted")])],
		};
	}
	const outcome = waitOutcome(jobs, agents.length);
	const head: TspSpan[] = [span("Wait", "accent"), span(": "), span(waitSubject(jobs.length, agents.length), "muted")];
	const meta = waitMeta(jobs, agents.length);
	if (meta.length > 0) head.push(span(` ${meta.join(" · ")}`, "dim"));
	const sorted = [...jobs].sort(
		(a, b) => JOB_STATUS_ORDER[a.status] - JOB_STATUS_ORDER[b.status] || b.durationMs - a.durationMs,
	);
	// One frame of tiles: each job's status, title, figure and widget together. The job's output
	// and errors fill the card of the call that started it (`parksAsBackground`), so no previews.
	const body: NativeNode[] = [];
	// Tiles span several rows: a lone hidden job keeps its `+1 more` row.
	const shownTiles = Math.min(sorted.length, TILES_SHOWN);
	if (shownTiles > 0) {
		body.push(keyed(describeJobTiles(sorted.slice(0, shownTiles).map(job => jobTile(job, isPartial))), "tiles"));
	}
	const rest = sorted.length - shownTiles;
	if (rest > 0) body.push(text([span(`+${rest} more jobs · /jobs`, "dim")], { role: "omp.wait.more" }));
	for (const agent of agents) {
		const spans: TspSpan[] = [span(plainText(agent.id), "accent")];
		if (agent.parentId) spans.push(span(` ← ${plainText(agent.parentId)}`, "dim"));
		if (agent.activity) spans.push(span(` ${plainText(agent.activity)}`, "toolOutput"));
		body.push(
			node(
				"row",
				{ gap: "sm", role: "omp.wait.agent" },
				[
					node("badge", {
						text: agent.live ? "agent" : "no turn",
						tone: agent.live ? "accent" : "warning",
					}),
					text(spans, { truncate: "end", grow: 1 }),
					elapsed(agent.ageMs, !agent.live || !isPartial),
				],
				`agent:${agent.id}`,
			),
		);
	}
	return {
		head,
		tone: outcome,
		// The tiles are what a wait shows: clamping the body by lines would cut them.
		preview: "children",
		body,
	};
}

/** Received-message view: `Wait` head with the sender and age, markdown body. */
function describeMessage(
	from: string,
	ts: number | undefined,
	bodyText: string,
	meta: readonly string[],
): NativeToolView {
	const head: TspSpan[] = [span("Wait", "accent"), span(": "), span(`← ${plainText(from)}`, "muted")];
	for (const part of meta) head.push(span(` ${part}`, "dim"));
	return {
		head,
		tone: "success",
		preview: { lines: BODY_LINES_COLLAPSED + 1 },
		body: compact([
			ts
				? row([text([span("received", "dim")]), elapsed(Date.now() - ts), text([span("ago", "dim")])], {
						gap: "xs",
					})
				: undefined,
			bodyText.trim() ? md(bodyText) : undefined,
		]),
	};
}

const waitResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Render either a received message or a background-job snapshot. */
export const waitToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	activitySummary(): ToolActivitySummary {
		return { label: "Wait", detail: "Background work or peer message" };
	},
	renderCall: waitRenderCall,
	describeCall(): NativeToolView {
		return { head: toolHead("Wait"), inline: true };
	},
	describeResult(
		result: ToolRenderResult<CoordinationDetails>,
		options: RenderResultOptions,
	): NativeToolView | undefined {
		return waitResultMemo.get(result, [options.isPartial, widgetStamp(result.details?.jobs)], () => {
			if (result.isError) return errorView("Wait", resultText(result));
			const details = result.details;
			if (details?.interrupted) {
				return {
					head: toolHead("Wait", "interrupted by message"),
					tone: "warning",
					inline: true,
				};
			}
			const waited = details?.waited;
			if (!waited) return describeJobsResult(result, options.isPartial);
			return describeMessage(waited.from, waited.ts, waited.body, waited.replyTo ? ["reply"] : []);
		});
	},
	renderResult(
		result: {
			content: Array<{ type: string; text?: string }>;
			details?: CoordinationDetails;
			isError?: boolean;
		},
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		if (result.isError) {
			const message = result.content?.find(c => c.type === "text")?.text;
			return new Text(
				[
					renderStatusLine({ icon: "error", title: "Wait" }, uiTheme),
					...sanitizeDisplayLines(message?.trim() || "Wait failed").map(
						line => `${INDENT}${formatErrorText(line, uiTheme)}`,
					),
				].join("\n"),
				0,
				0,
			);
		}
		if (result.details?.interrupted) {
			return new Text(
				renderStatusLine({ icon: "warning", title: "Wait", meta: ["interrupted by message"] }, uiTheme),
				0,
				0,
			);
		}
		const waited = result.details?.waited;
		if (!waited) return jobsRenderResult(result, options, uiTheme);
		return createCachedComponent(
			() => options.expanded,
			(width, expanded) =>
				fitFlushRows(
					{
						icon: "success",
						title: "Wait",
						description: `${uiTheme.format.arrowLeft} ${replaceTabs(waited.from)}`,
						meta: [messageAge(waited.ts), ...(waited.replyTo ? ["reply"] : [])],
					},
					bodyLines(waited.body, expanded, uiTheme, width),
					width,
					uiTheme,
				),
		);
	},
} satisfies ToolRenderer<object, CoordinationDetails>;
