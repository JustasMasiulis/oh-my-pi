import type { NativeToolView, ToolRenderer, ToolRenderResult } from "./renderer";
import type { Component } from "../index";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { ansi, compact, item, list, md, node, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { errorView, noteText, toolHead } from "./native-view";
import type { RenderResultOptions } from "./renderer";
import type { Theme } from "../theme/theme";
import { nestRows, type StatusLineOptions } from "../render";
import { framedToolCard, plainToolCard, type ToolCardPhase, type ToolCardSection } from "../render/tool-card";

import { formatShortSha, pushLine } from "./gh-format";
import type { OutputMeta } from "./output-meta";
import type { IsoBackendKind } from "@oh-my-pi/pi-natives";
import {
	formatCount,
	formatErrorText,
	formatExpandHint,
	formatMoreRow,
	formatStatusIcon,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIStatus,
	TRUNCATE_LENGTHS,
	sanitizeDisplayWarning,
	truncateToWidth as truncateVisualWidth,
} from "../render/render-utils";

type GithubToolRenderArgs = {
	op?: string;
	run?: string;
	branch?: string;
	repo?: string;
	pr?: string | string[];
	query?: string;
};

const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
const RUNNING_STATUSES = new Set(["in_progress"]);
/** Error lines shown under a failed call's header. */
const MAX_ERROR_LINES = 5;

const GITHUB_TITLE = "GitHub";

/** The operation word(s) leading the subject (`search PRs`, `checkout PR`). */
const OP_LABELS: Record<string, string> = {
	repo_view: "repo",
	pr_checkout: "checkout PR",
	pr_push: "push PR",
	search_issues: "search issues",
	search_prs: "search PRs",
	search_code: "search code",
	search_commits: "search commits",
	search_repos: "search repos",
	run_watch: "watch",
};

function formatOpLabel(op: string | undefined): string | undefined {
	if (!op) return undefined;
	return OP_LABELS[op] ?? op.replace(/_/g, " ");
}

type FitText = (value: string, width: number) => string;

/** Native views keep full values: the terminal truncates headers itself. */
const KEEP_TEXT: FitText = value => value;

function extractIssueId(value: string | undefined, fit: FitText = truncateVisualWidth): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (/^\d+$/.test(trimmed)) return `#${trimmed}`;
	const match = trimmed.match(/\/(?:issues|pull)\/(\d+)/);
	if (match) return `#${match[1]}`;
	return fit(trimmed, TRUNCATE_LENGTHS.SHORT);
}

function formatPrIdentifier(pr: string | string[] | undefined, fit: FitText = truncateVisualWidth): string | undefined {
	if (pr === undefined) return undefined;
	if (Array.isArray(pr)) {
		const parts = pr.map(p => extractIssueId(p, fit)).filter((p): p is string => p !== undefined);
		if (parts.length === 0) return undefined;
		if (parts.length > 3) {
			return `${parts.slice(0, 3).join(", ")}, +${parts.length - 3} more`;
		}
		return parts.join(", ");
	}
	return extractIssueId(pr, fit);
}

function trimmedArg(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** What `run_watch` watches: a run id, a branch, or the current HEAD. */
function watchTarget(args: GithubToolRenderArgs): string {
	const runId = trimmedArg(args.run);
	if (runId) return `run #${runId}`;
	const branch = trimmedArg(args.branch);
	return branch ? `branch ${branch}` : "HEAD";
}

/** The header subject: the op words, then its primary argument (`search PRs is:open`). */
function githubSubject(args: GithubToolRenderArgs, fit: FitText = truncateVisualWidth): string | undefined {
	const label = formatOpLabel(args.op);
	let target: string | undefined;
	switch (args.op) {
		case "pr_checkout":
		case "pr_push":
			target = formatPrIdentifier(args.pr, fit) ?? args.branch;
			break;
		case "search_issues":
		case "search_prs":
		case "search_code":
		case "search_commits":
		case "search_repos":
			target = args.query ? fit(replaceTabs(args.query), TRUNCATE_LENGTHS.CONTENT) : undefined;
			break;
		case "repo_view":
			target = args.repo;
			break;
		case "run_watch":
			target = watchTarget(args);
			break;
	}
	const subject = [label, target].filter(Boolean).join(" ");
	return subject || undefined;
}

/** Subject context: the repository (and branch for repo views) when not already the subject. */
function githubContext(args: GithubToolRenderArgs): string[] {
	switch (args.op) {
		case "repo_view":
			return args.branch ? [args.branch] : [];
		case "search_repos":
		case "run_watch":
			return [];
		default:
			return args.repo ? [args.repo] : [];
	}
}

function githubStatus(
	args: GithubToolRenderArgs,
	icon: ToolUIStatus,
	theme: Theme,
	options: { spinnerFrame?: number; meta?: string[] } = {},
): StatusLineOptions {
	const subject = [githubSubject(args), ...githubContext(args)].filter(Boolean).join(theme.sep.dot);
	return {
		icon,
		spinnerFrame: options.spinnerFrame,
		title: GITHUB_TITLE,
		description: subject || undefined,
		meta: options.meta,
	};
}

/** Result meta for a watch: the repository, and the commit when watching one. */
function watchMeta(watch: GhRunWatchViewDetails): string[] {
	const meta = [watch.repo];
	if (watch.mode === "commit") meta.push(formatShortSha(watch.headSha) ?? "this commit");
	return meta;
}

function getRunLabel(run: GhRunWatchRunDetails): string {
	return replaceTabs(run.workflowName ?? run.displayTitle ?? "GitHub Actions");
}

function getRunMeta(run: GhRunWatchRunDetails): string[] {
	const parts: string[] = [];
	if (run.branch) {
		parts.push(replaceTabs(run.branch));
	} else if (run.headSha) {
		parts.push(formatShortSha(run.headSha) ?? run.headSha);
	}
	parts.push(`#${run.id}`);
	return parts;
}

/** The lifecycle of a workflow run or job, as a status icon state. */
function workflowStatus(entry: { status?: string; conclusion?: string }): ToolUIStatus {
	if (entry.conclusion) {
		if (SUCCESS_CONCLUSIONS.has(entry.conclusion)) return "success";
		if (entry.conclusion === "cancelled") return "aborted";
		if (FAILURE_CONCLUSIONS.has(entry.conclusion)) return "error";
	}
	if (entry.status && RUNNING_STATUSES.has(entry.status)) return "running";
	return "pending";
}

/** One run row (`<icon> <workflow> <branch> · #id`) with its jobs as tree children. */
function renderRunRows(run: GhRunWatchRunDetails, theme: Theme): string[] {
	const icon = formatStatusIcon(workflowStatus(run), theme);
	const runMeta = theme.fg("dim", getRunMeta(run).join(theme.sep.dot));
	const head = `${icon} ${theme.fg("accent", getRunLabel(run))} ${runMeta}`;
	if (run.jobs.length === 0) {
		return [head, ...nestRows([theme.fg("dim", `waiting for workflow jobs${theme.format.ellipsis}`)], theme)];
	}
	const jobRows = run.jobs.map(job => {
		const duration = job.durationSeconds !== undefined ? ` ${theme.fg("dim", `${job.durationSeconds}s`)}` : "";
		const name = theme.fg("toolOutput", replaceTabs(job.name));
		return `${formatStatusIcon(workflowStatus(job), theme)} ${name}${duration}`;
	});
	return [head, ...nestRows(jobRows, theme)];
}

function formatUnavailableLog(entry: GhRunWatchFailedLogDetails): string {
	const reason = entry.unavailableReason ? sanitizeDisplayWarning(entry.unavailableReason) : "";
	return `log tail unavailable${reason ? `: ${reason}` : ""}`;
}

/** The runs and jobs being watched. */
function renderWatchRows(watch: GhRunWatchViewDetails, theme: Theme): string[] {
	const rows: string[] = [];
	if (watch.note) rows.push(theme.fg("dim", replaceTabs(watch.note)));
	if (watch.mode === "run" && watch.run) {
		rows.push(...renderRunRows(watch.run, theme));
	} else if (watch.mode === "commit") {
		const runs = watch.runs ?? [];
		if (runs.length === 0) rows.push(theme.fg("dim", `waiting for workflow runs${theme.format.ellipsis}`));
		for (const run of runs) rows.push(...renderRunRows(run, theme));
	}
	return rows;
}

/**
 * Failed-job log tails: a job row, then its last log lines. Earlier entries keep
 * their `… N earlier log lines` marker in place; the last entry's marker is
 * returned for the bottom border.
 */
function renderFailedLogs(
	failedLogs: GhRunWatchFailedLogDetails[],
	width: number,
	theme: Theme,
	expanded: boolean,
): { lines: string[]; marker?: string } {
	const lines: string[] = [];
	let marker: string | undefined;
	failedLogs.forEach((entry, index) => {
		const context = entry.workflowName
			? `${entry.workflowName}${theme.sep.dot}#${entry.runId}`
			: `run #${entry.runId}`;
		const jobName = theme.fg("toolOutput", replaceTabs(entry.jobName));
		lines.push(`${formatStatusIcon("error", theme)} ${jobName} ${theme.fg("dim", context)}`);
		if (!entry.available || !entry.tail) {
			lines.push(theme.fg("dim", truncateVisualWidth(formatUnavailableLog(entry), Math.max(8, width))));
			return;
		}
		const tailLines = replaceTabs(entry.tail)
			.split("\n")
			.filter(line => line.length > 0);
		const shown = expanded ? tailLines : tailLines.slice(-PREVIEW_LIMITS.OUTPUT_COLLAPSED);
		const hidden = tailLines.length - shown.length;
		const entryMarker =
			hidden > 0 ? formatMoreRow(hidden, "log line", theme, { expanded, position: "earlier" }) : undefined;
		if (entryMarker && index < failedLogs.length - 1) lines.push(entryMarker);
		else marker = entryMarker;
		for (const line of shown) {
			lines.push(theme.fg("toolOutput", expanded ? line : truncateVisualWidth(line, Math.max(8, width))));
		}
	});
	return { lines, marker };
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join("\n");
}

/** Error card: the header with error status, then a few error lines. */
function renderErrorCard(status: StatusLineOptions, message: string, theme: Theme): Component {
	const lines = message
		.split("\n")
		.filter(line => line.trim().length > 0)
		.slice(0, MAX_ERROR_LINES)
		.map(line => formatErrorText(line, theme));
	return plainToolCard(theme, () => ({
		status,
		phase: "error",
		body: lines.length > 0 ? lines : [formatErrorText("request failed", theme)],
	}));
}

/** One `- <title>` entry of a search result, with its `  Key: value` fields. */
interface SearchItem {
	title: string;
	fields: Map<string, string>;
}

/** Fields summarized on a collapsed search row, per search op, in order. */
const SEARCH_SUMMARY_FIELDS: Record<string, readonly string[]> = {
	search_issues: ["State", "Author", "Updated"],
	search_prs: ["State", "Author", "Updated"],
	search_commits: ["Author", "Date"],
	search_code: ["Repo", "Match"],
	search_repos: ["Language", "Stars", "Updated"],
};

/**
 * Parse the search tool's Markdown (`Results: N`, then `- <title>` entries
 * with indented `Key: value` fields); undefined when `text` is not one.
 */
function parseSearchResults(text: string): { total: number; items: SearchItem[] } | undefined {
	let total: number | undefined;
	const items: SearchItem[] = [];
	for (const line of text.split("\n")) {
		const resultsMatch = line.match(/^Results: (\d+)$/);
		if (resultsMatch) {
			total = Number(resultsMatch[1]);
			continue;
		}
		if (line.startsWith("- ")) {
			items.push({ title: line.slice(2).trim(), fields: new Map() });
			continue;
		}
		const fieldMatch = line.match(/^ {2}([^:]+): (.*)$/);
		if (fieldMatch && items.length > 0) items[items.length - 1].fields.set(fieldMatch[1], fieldMatch[2]);
	}
	return total === undefined ? undefined : { total, items };
}

/** A field value for display: ISO timestamps shortened to their date. */
function displayField(value: string): string {
	return replaceTabs(/^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : value);
}

/**
 * Search results as a flush list: one row per result (title, then a few dim
 * facts); expanded, every field hangs beneath its result as a tree child.
 */
function renderSearchResults(
	search: { total: number; items: SearchItem[] },
	options: RenderResultOptions,
	theme: Theme,
	args: GithubToolRenderArgs,
): Component {
	const meta = [formatCount("result", search.total)];
	if (search.items.length === 0) {
		const status = githubStatus(args, "warning", theme, { meta });
		return plainToolCard(theme, () => ({ status, phase: "warning" }));
	}
	const status = githubStatus(args, "success", theme, { meta });
	const summaryFields = SEARCH_SUMMARY_FIELDS[args.op ?? ""] ?? [];
	return plainToolCard(theme, ({ contentWidth }) => {
		const { expanded } = options;
		const shown = expanded ? search.items : search.items.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS);
		const body: string[] = [];
		for (const item of shown) {
			const title = theme.fg("toolOutput", replaceTabs(item.title));
			if (expanded) {
				body.push(title);
				body.push(
					...nestRows(
						[...item.fields].map(
							([key, value]) => `${theme.fg("dim", `${key}:`)} ${theme.fg("muted", displayField(value))}`,
						),
						theme,
					),
				);
				continue;
			}
			const facts = summaryFields.flatMap(key => {
				const value = item.fields.get(key);
				return value ? [displayField(value)] : [];
			});
			const row = facts.length > 0 ? `${title} ${theme.fg("dim", facts.join(theme.sep.dot))}` : title;
			body.push(truncateVisualWidth(row, contentWidth));
		}
		const remaining = search.items.length - shown.length;
		if (remaining > 0) {
			body.push(formatMoreRow(remaining, "result", theme, { expanded }));
		} else if (!expanded && shown.some(item => [...item.fields.keys()].some(key => !summaryFields.includes(key)))) {
			// Every result fits, but Ctrl+O still reveals the fields the summary row leaves out.
			body.push(formatExpandHint(theme));
		}
		return { status, phase: "success", body };
	});
}

/** Op output (search results, repo views, checkout receipts): flush rows, capped while collapsed. */
function renderFallbackComponent(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args: GithubToolRenderArgs,
): Component {
	const text = extractText(result.content);
	if (result.isError === true) return renderErrorCard(githubStatus(args, "error", theme), text, theme);

	const search = args.op?.startsWith("search_") ? parseSearchResults(text) : undefined;
	if (search) return renderSearchResults(search, options, theme, args);

	const rows = replaceTabs(text)
		.split("\n")
		.filter(line => line.trim().length > 0);
	if (rows.length === 0) {
		const status = githubStatus(args, "warning", theme, { meta: ["no output"] });
		return plainToolCard(theme, () => ({ status, phase: "warning" }));
	}

	const status = githubStatus(args, "success", theme);
	return plainToolCard(theme, ({ contentWidth }) => {
		const { expanded } = options;
		const shown = expanded ? rows : rows.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS);
		const body = shown.map(row => theme.fg("toolOutput", expanded ? row : truncateVisualWidth(row, contentWidth)));
		const remaining = rows.length - shown.length;
		if (remaining > 0) body.push(formatMoreRow(remaining, "line", theme, { expanded }));
		return { status, phase: "success", body };
	});
}

/**
 * A run watch: the runs with their jobs as status-iconed children. Flush while
 * there is no log to show; failed-job logs are command output, so a watch with
 * them is framed, with the logs as the last section.
 */
function renderWatchResult(
	watch: GhRunWatchViewDetails,
	result: { isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args: GithubToolRenderArgs,
): Component {
	const isError = result.isError === true;
	// A partial result only arrives once the watch is executing.
	const settledIcon = isError ? "error" : "success";
	const statusFor = (): StatusLineOptions =>
		githubStatus({ ...args, op: "run_watch" }, options.isPartial ? "running" : settledIcon, theme, {
			spinnerFrame: options.spinnerFrame,
			meta: watchMeta(watch),
		});
	const phaseFor = (): ToolCardPhase => (options.isPartial ? "partial" : settledIcon);
	const watchRows = renderWatchRows(watch, theme);
	const failedLogs = watch.failedLogs ?? [];

	if (failedLogs.length === 0) {
		return plainToolCard(theme, () => ({ status: statusFor(), phase: phaseFor(), body: watchRows }));
	}
	return framedToolCard(theme, ({ contentWidth }) => {
		const { lines, marker } = renderFailedLogs(failedLogs, contentWidth, theme, options.expanded);
		const sections: ToolCardSection[] =
			watchRows.length > 0 ? [{ label: theme.fg("dim", "Failed logs"), content: lines }] : [{ content: lines }];
		return {
			status: statusFor(),
			phase: phaseFor(),
			body: watchRows.length > 0 ? watchRows : undefined,
			sections,
			footerMeta: marker,
		};
	});
}

function jobTone(job: GhRunWatchJobDetails): TspTone {
	if (job.conclusion && SUCCESS_CONCLUSIONS.has(job.conclusion)) return "success";
	if (job.conclusion && (job.conclusion === "cancelled" || FAILURE_CONCLUSIONS.has(job.conclusion))) return "error";
	if (job.status && RUNNING_STATUSES.has(job.status)) return "warning";
	return "muted";
}

/** One workflow run: a section headed by workflow + branch/sha + id, listing its jobs. */
function describeRun(run: GhRunWatchRunDetails): NativeNode {
	const metaParts = getRunMeta(run);
	const head = [span(plainText(getRunLabel(run)), "accent")];
	metaParts.forEach((part, index) => {
		head.push(span("  "), span(plainText(part), index === metaParts.length - 1 ? "muted" : "text"));
	});
	const jobs =
		run.jobs.length === 0
			? noteText("waiting for workflow jobs...")
			: list(
					run.jobs.map(job => {
						const tone = jobTone(job);
						return item(`${job.id}`, {
							label: [span(plainText(job.name), tone)],
							tone,
							icon: tone === "success" ? "check" : undefined,
							value: job.durationSeconds !== undefined ? [span(`${job.durationSeconds}s`, tone)] : undefined,
						});
					}),
				);
	return node("section", { head }, [jobs], `run:${run.id}`);
}

function describeWatch(watch: GhRunWatchViewDetails, isError: boolean, args: GithubToolRenderArgs): NativeToolView {
	const runs: NativeChild[] = [];
	if (watch.mode === "run" && watch.run) runs.push(describeRun(watch.run));
	else if (watch.mode === "commit") {
		const commitRuns = watch.runs ?? [];
		if (commitRuns.length === 0) runs.push(noteText("waiting for workflow runs..."));
		for (const run of commitRuns) runs.push(describeRun(run));
	}
	const failed = (watch.failedLogs ?? []).flatMap((entry): NativeChild[] => {
		const context = entry.workflowName ? `${entry.workflowName}  #${entry.runId}` : `run #${entry.runId}`;
		const title = text([span(plainText(entry.jobName), "error"), span(`  ${plainText(context)}`, "muted")]);
		if (!entry.available || !entry.tail) {
			return [title, noteText(formatUnavailableLog(entry))];
		}
		return [title, ansi(entry.tail, { follow: true, preview: { lines: PREVIEW_LIMITS.OUTPUT_COLLAPSED } })];
	});
	return {
		head: toolHead(GITHUB_TITLE, githubSubject({ ...args, op: "run_watch" }, KEEP_TEXT), ...watchMeta(watch)),
		tone: isError ? "error" : undefined,
		body: compact([
			watch.note ? noteText(watch.note) : undefined,
			...runs,
			failed.length > 0
				? node("section", { head: [span("failed logs", "error")], tone: "error" }, failed, "failed")
				: undefined,
		]),
	};
}

function describeFallback(result: ToolRenderResult<GhToolDetails>, args: GithubToolRenderArgs): NativeToolView {
	const output = extractText(result.content).trim();
	const meta = [githubSubject(args, KEEP_TEXT), ...githubContext(args)];
	if (result.isError === true) return errorView(GITHUB_TITLE, output || "request failed", ...meta);
	if (!output) return { head: toolHead(GITHUB_TITLE, ...meta), tone: "warning", body: [noteText("no output")] };
	return {
		head: toolHead(GITHUB_TITLE, ...meta),
		body: [md(plainText(output))],
		preview: { lines: PREVIEW_LIMITS.OUTPUT_EXPANDED },
	};
}

const githubResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Render GitHub operations and live workflow status. */
export const githubToolRenderer = {
	renderCall(args: GithubToolRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const op = trimmedArg(args.op);
		const icon: ToolUIStatus = options.executionStarted ? "running" : "pending";
		const status = githubStatus({ ...args, op }, icon, uiTheme, { spinnerFrame: options.spinnerFrame });
		return plainToolCard(uiTheme, () => ({ status }));
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GhToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GithubToolRenderArgs,
	): Component {
		const watch = result.details?.watch;
		if (watch) return renderWatchResult(watch, result, options, uiTheme, args ?? {});
		return renderFallbackComponent(result, options, uiTheme, args ?? {});
	},

	describeCall(args: GithubToolRenderArgs): NativeToolView {
		const op = trimmedArg(args.op);
		return {
			head: toolHead(GITHUB_TITLE, githubSubject({ ...args, op }, KEEP_TEXT), ...githubContext({ ...args, op })),
		};
	},

	describeResult(
		result: ToolRenderResult<GhToolDetails>,
		options: RenderResultOptions,
		args?: GithubToolRenderArgs,
	): NativeToolView | undefined {
		const watch = result.details?.watch;
		const deps = [args?.op, options.isPartial, watch?.state, watch?.pollCount];
		return githubResultMemo.get(result, deps, () =>
			watch ? describeWatch(watch, result.isError === true, args ?? {}) : describeFallback(result, args ?? {}),
		);
	},

	mergeCallAndResult: true,
} satisfies ToolRenderer<GithubToolRenderArgs, GhToolDetails>;

/** Display metadata for GitHub operations. */
export interface GhToolDetails {
	meta?: OutputMeta;
	artifactId?: string;
	repo?: string;
	branch?: string;
	worktreePath?: string;
	remote?: string;
	remoteBranch?: string;
	headSha?: string;
	runId?: number;
	runIds?: number[];
	status?: string;
	conclusion?: string;
	failedJobs?: string[];
	watch?: GhRunWatchViewDetails;
	checkouts?: GhPrCheckoutSummary[];
}

/** Checkout location and branch metadata for a pull request. */
export interface GhPrCheckoutSummary {
	prNumber?: number;
	url?: string;
	branch: string;
	worktreePath: string;
	remote: string;
	remoteBranch: string;
	reused: boolean;
	clonedWith?: IsoBackendKind;
}

/** Display state of a watched workflow job. */
export interface GhRunWatchJobDetails {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
	url?: string;
}

/** Display state of a watched workflow run. */
export interface GhRunWatchRunDetails {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	url?: string;
	jobs: GhRunWatchJobDetails[];
}

/** Captured log preview for a failed job. */
export interface GhRunWatchFailedLogDetails {
	runId: number;
	workflowName?: string;
	jobName: string;
	conclusion?: string;
	tail?: string;
	available: boolean;
	unavailableReason?: string;
}

/** Live workflow watcher display snapshot. */
export interface GhRunWatchViewDetails {
	mode: "run" | "commit";
	state: "watching" | "completed";
	repo: string;
	branch?: string;
	headSha?: string;
	pollCount?: number;
	note?: string;
	run?: GhRunWatchRunDetails;
	runs?: GhRunWatchRunDetails[];
	failedLogs?: GhRunWatchFailedLogDetails[];
}

/** Normalized status and timestamps of a workflow job. */
export interface GhRunJobSnapshot {
	id: number;
	name: string;
	status?: string;
	conclusion?: string;
	startedAt?: string;
	completedAt?: string;
	url?: string;
}

/** Normalized workflow run and job snapshot. */
export interface GhRunSnapshot {
	id: number;
	workflowName?: string;
	displayTitle?: string;
	status?: string;
	conclusion?: string;
	branch?: string;
	headSha?: string;
	createdAt?: string;
	updatedAt?: string;
	url?: string;
	jobs: GhRunJobSnapshot[];
}

/** Captured failure logs associated with a run and job. */
export interface GhFailedJobLog {
	run: GhRunSnapshot;
	job: GhRunJobSnapshot;
	full?: string;
	tail?: string;
	available: boolean;
	unavailableReason?: string;
	truncated?: boolean;
}

/** Choose the terminal conclusion or current job state. */
export function formatJobState(job: GhRunJobSnapshot): string {
	return job.conclusion ?? job.status ?? "unknown";
}

/** Format workflow jobs as a Markdown section. */
export function renderJobsSection(jobs: GhRunJobSnapshot[]): string[] {
	if (jobs.length === 0) {
		return ["## Jobs", "", "No jobs reported yet."];
	}

	const lines: string[] = [`## Jobs (${jobs.length})`, ""];
	for (const job of jobs) {
		lines.push(`- [${formatJobState(job)}] ${job.name}`);
		if (job.startedAt) {
			pushLine(lines, "  Started", job.startedAt);
		}
		if (job.completedAt) {
			pushLine(lines, "  Completed", job.completedAt);
		}
		if (job.url) {
			pushLine(lines, "  URL", job.url);
		}
	}

	return lines;
}

/** Format failed workflow logs as Markdown sections. */
export function renderFailedJobLogs(
	failedJobLogs: GhFailedJobLog[],
	options: { mode: "tail"; tail: number } | { mode: "full" },
): string[] {
	if (failedJobLogs.length === 0) {
		return [];
	}

	const lines: string[] = ["## Failed Jobs", ""];
	for (const entry of failedJobLogs) {
		lines.push(`### ${entry.job.name} [${entry.job.conclusion ?? "failed"}]`);
		pushLine(lines, "Run", `#${entry.run.id}`);
		pushLine(lines, "Workflow", entry.run.workflowName ?? undefined);
		if (entry.job.startedAt) {
			pushLine(lines, "Started", entry.job.startedAt);
		}
		if (entry.job.completedAt) {
			pushLine(lines, "Completed", entry.job.completedAt);
		}
		if (entry.job.url) {
			pushLine(lines, "URL", entry.job.url);
		}
		lines.push("");
		const logText = options.mode === "full" ? entry.full : entry.tail;
		if (entry.available && logText) {
			lines.push(
				options.mode === "full"
					? entry.truncated
						? "Partial log (capture truncated):"
						: "Full log:"
					: entry.truncated
						? `Last ${options.tail} captured log lines (log capture truncated):`
						: `Last ${options.tail} log lines:`,
			);
			lines.push("```text");
			lines.push(logText);
			lines.push("```");
		} else {
			lines.push(options.mode === "full" ? "Full log unavailable." : "Log tail unavailable.");
			if (entry.unavailableReason) pushLine(lines, "Reason", entry.unavailableReason);
		}
		lines.push("");
	}

	return lines;
}

/** Format a workflow run and its jobs as Markdown. */
export function renderRunSection(run: GhRunSnapshot): string[] {
	const label = run.workflowName ? `### Run #${run.id} - ${run.workflowName}` : `### Run #${run.id}`;
	const lines: string[] = [label, ""];
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Commit", formatShortSha(run.headSha));
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));
	return lines;
}
