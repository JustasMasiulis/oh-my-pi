import type { Component } from "../tui";
import { renderStatusLine, renderTreeList, truncateToWidth } from "../render";
import {
	cappedHeadLines,
	formatBadge,
	formatDuration,
	formatErrorText,
	formatMoreItems,
	formatStatusIcon,
	PREVIEW_LIMITS,
	pluralize,
	TRUNCATE_LENGTHS,
	type ToolUIStatus,
} from "../render/render-utils";
import type { Theme } from "../theme/theme";
import type { NativeToolView, RenderResultOptions } from "./renderer";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { ansi, compact, node, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { errorText, noteText, toolHead } from "./native-view";
import {
	type AgentActivitySnapshot,
	type CoordinationDetails,
	fitFlushRows,
	jobRowFacts,
	jobStatusIcon,
	type JobSnapshot,
} from "./wait";
import type { IrcDeliveryReceipt } from "./irc";
import type { DaemonSnapshot } from "./daemon";
import { styleTerminalRow } from "./terminal-output";
import { card, type CardToolResult as ToolResult, firstText, safe } from "./result-card";

export interface ProcReadDetails {
	jobs?: JobSnapshot[];
	agents?: AgentActivitySnapshot[];
	daemons?: DaemonSnapshot[];
	job?: JobSnapshot;
	daemon?: DaemonSnapshot;
	log?: string;
	terminalRows?: string[];
}

export type ProcWriteDetails =
	| CoordinationDetails
	| { action: "stop" | "stdin" | "mode"; daemon: DaemonSnapshot; input?: string; mode?: string };

/** Process operation selected by a write URL, independent of its content. */
export type ProcWriteAction = "stdin" | "mode" | "kill";

/** Body indent for flush proc cards. */
const INDENT = "  ";

function preview(body: string, expanded: boolean, theme: Theme, tone: "dim" | "toolOutput" = "dim"): string[] {
	if (!body.trim()) return [];
	const limit = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
	const shown = cappedHeadLines(
		body.split("\n").filter(line => line.trim()),
		limit,
	);
	const lines = shown.lines.map(
		line => `${INDENT}${theme.fg(tone, truncateToWidth(safe(line.trim()), TRUNCATE_LENGTHS.LINE))}`,
	);
	if (shown.hidden) lines.push(`${INDENT}${theme.fg("dim", formatMoreItems(shown.hidden, "line", theme))}`);
	return lines;
}

/** A receipt's outcome as a status; its word rides beside it as a gray badge. */
function receiptStatus(outcome: IrcDeliveryReceipt["outcome"]): "success" | "warning" | "error" {
	return outcome === "failed" ? "error" : outcome === "revived" ? "warning" : "success";
}

/** Status of a call whose result has not landed: queued, or executing once started. */
function inFlightStatus(options: RenderResultOptions): "pending" | "running" {
	return options.executionStarted ? "running" : "pending";
}

/**
 * Header outcome of an IRC write: error when nothing landed, warning when only
 * some did or nobody was listening. A result without details predates delivery
 * receipts and counts as delivered.
 */
function agentWriteStatus(
	result: ToolResult | undefined,
	details: CoordinationDetails | undefined,
	options: RenderResultOptions,
): ToolUIStatus {
	if (result === undefined) return inFlightStatus(options);
	const receipts = details?.receipts ?? [];
	const failed = receipts.filter(receipt => receipt.outcome === "failed").length;
	if (result.isError || (failed > 0 && failed === receipts.length)) return "error";
	if (failed > 0 || (details !== undefined && receipts.length === 0)) return "warning";
	return "success";
}

export function renderAgentWrite(
	to: string,
	body: string,
	result: ToolResult | undefined,
	details: CoordinationDetails | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return card((width, expanded) => {
		const recipient = safe(details?.to || to || theme.format.ellipsis);
		const receipts = details?.receipts ?? [];
		const delivered = receipts.filter(receipt => receipt.outcome !== "failed").length;
		const failed = receipts.length - delivered;
		const single = receipts.length === 1 ? receipts[0] : undefined;
		const meta: string[] = [];
		if (receipts.length > 1) {
			if (delivered) meta.push(`${delivered} delivered`);
			if (failed) meta.push(`${failed} failed`);
		}
		const header = renderStatusLine(
			{
				icon: agentWriteStatus(result, details, options),
				title: "IRC",
				description: `${theme.format.arrowRight} ${recipient}`,
				badge: single ? { label: single.outcome, color: "muted" } : undefined,
				meta,
			},
			theme,
		);
		const lines = [header];
		if (result?.isError && receipts.length === 0) {
			lines.push(`${INDENT}${formatErrorText(firstText(result) || "Message delivery failed.", theme)}`);
			return fitFlushRows(lines, width);
		}
		if (single?.error) lines.push(`${INDENT}${formatErrorText(single.error, theme)}`);
		lines.push(...preview(body, expanded, theme, "toolOutput"));
		if (result && receipts.length === 0)
			lines.push(`${INDENT}${theme.fg("muted", firstText(result) || "No live peers to broadcast to.")}`);
		if (receipts.length > 1) {
			const rows = renderTreeList(
				{
					items: receipts,
					flush: true,
					expanded,
					maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
					itemType: "recipient",
					renderItem: receipt =>
						`${formatStatusIcon(receiptStatus(receipt.outcome), theme)} ${theme.fg("accent", safe(receipt.to))} ${formatBadge(receipt.outcome, "muted", theme)}${receipt.error ? `${theme.sep.dot}${theme.fg("error", safe(receipt.error))}` : ""}`,
				},
				theme,
			);
			lines.push(...rows.map(row => `${INDENT}${row}`));
		}
		return fitFlushRows(lines, width);
	}, options);
}

function daemonMeta(daemon: DaemonSnapshot, theme: Theme): string[] {
	const stateColor =
		daemon.state === "ready" || daemon.state === "running"
			? "success"
			: daemon.state === "failed"
				? "error"
				: "warning";
	const meta = [theme.fg(stateColor, daemon.state)];
	if (daemon.pid !== undefined) meta.push(`pid ${daemon.pid}`);
	meta.push(
		`${daemon.exitedAt === undefined ? "up" : "ran"} ${formatDuration(Math.max(0, (daemon.exitedAt ?? Date.now()) - daemon.startedAt))}`,
	);
	if (daemon.detached) meta.push("detached");
	else if (daemon.persist) meta.push("persistent");
	return meta;
}

/** `<icon> <id> - <facts> - <label>`: the job row grammar wait cards share, plus an optional outcome fact. */
function jobRow(job: JobSnapshot, theme: Theme, outcome?: string): string {
	const facts = jobRowFacts(job, theme);
	if (outcome) facts.push(theme.fg("dim", outcome));
	const label = safe(job.label);
	if (label && label !== job.id) facts.push(theme.fg("muted", label));
	return itemRow(jobStatusIcon(job.status), job.id, facts, theme);
}

/** `<icon> <id> - <fact> - <fact>`: one flush list item. */
function itemRow(status: ToolUIStatus, id: string, facts: readonly string[], theme: Theme): string {
	return [`${formatStatusIcon(status, theme)} ${theme.fg("accent", safe(id))}`, ...facts].join(theme.sep.dot);
}

function serviceRow(service: DaemonSnapshot, theme: Theme): string {
	const status: ToolUIStatus =
		service.state === "failed"
			? "error"
			: service.state === "ready" || service.state === "running"
				? "success"
				: "warning";
	const facts = ["service", ...daemonMeta(service, theme)].map(fact => theme.fg("dim", fact));
	return itemRow(status, service.name, facts, theme);
}

function errorRows(header: string, message: string, theme: Theme): string[] {
	return [header, ...message.split("\n").map(line => `${INDENT}${formatErrorText(line, theme)}`)];
}

function writeSubject(action: ProcWriteAction, id: string, content: string | undefined, theme: Theme): string {
	const target = safe(id) || theme.format.ellipsis;
	if (action === "mode" && content?.trim()) return `mode ${target} ${safe(content.trim())}`;
	return `${action} ${target}`;
}

/** Render live and completed process writes with the URL-selected operation. */
export function renderProcWrite(
	id: string,
	action: ProcWriteAction,
	content: string | undefined,
	result: ToolResult | undefined,
	details: ProcWriteDetails | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return card((_width, expanded) => {
		const daemon = details && "daemon" in details ? details.daemon : undefined;
		const header = renderStatusLine(
			{
				icon: result === undefined ? inFlightStatus(options) : result.isError ? "error" : "success",
				title: "Proc",
				description: writeSubject(action, id, content, theme),
				meta: daemon ? daemonMeta(daemon, theme) : [],
			},
			theme,
		);
		if (result?.isError) return errorRows(header, firstText(result) || "Process operation failed.", theme);
		const lines = [header];
		if (content && action === "stdin") lines.push(...preview(content, expanded, theme));
		if (details && "op" in details && details.op === "cancel") {
			const jobs = details.jobs ?? [];
			const outcomes = details.cancelled ?? [];
			lines.push(
				...renderTreeList(
					{
						items: outcomes,
						expanded,
						flush: true,
						maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
						itemType: "job",
						renderItem: outcome => {
							const job = jobs.find(item => item.id === outcome.id);
							if (job) return jobRow(job, theme, outcome.status);
							const status = outcome.status === "cancelled" ? "aborted" : "error";
							return itemRow(status, outcome.id, [theme.fg("dim", outcome.status)], theme);
						},
					},
					theme,
				).map(line => `${INDENT}${line}`),
			);
		}
		return lines;
	}, options);
}

export function renderProcRead(
	id: string,
	result: ToolResult | undefined,
	details: ProcReadDetails | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return card((_width, expanded) => {
		const description = id ? safe(id) : "jobs & services";
		const daemon = details?.daemon;
		const headerFor = (icon: ToolUIStatus, meta: string[] = []) =>
			renderStatusLine({ icon, title: "Proc", description, meta }, theme);
		if (!result) return [headerFor(inFlightStatus(options))];
		if (result.isError) return errorRows(headerFor("error"), firstText(result) || "Process read failed.", theme);
		if (details?.job)
			return [
				headerFor("success"),
				`${INDENT}${jobRow(details.job, theme)}`,
				...preview(
					details.log ?? details.job.errorText ?? details.job.resultText ?? "",
					expanded,
					theme,
					"toolOutput",
				),
			];
		if (daemon) {
			const output = details.terminalRows ?? (details.log ?? "").split("\n").filter(Boolean);
			const limit = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
			const visible = output
				.slice(-limit)
				.map(
					line =>
						`${INDENT}${styleTerminalRow(truncateToWidth(safe(line), TRUNCATE_LENGTHS.LINE), theme.fg("toolOutput", ""))}`,
				);
			if (output.length > limit)
				visible.unshift(
					`${INDENT}${theme.fg("dim", formatMoreItems(output.length - limit, "line", theme, "earlier"))}`,
				);
			return [headerFor("success", daemonMeta(daemon, theme)), ...visible];
		}
		if (id && !details?.jobs && !details?.daemons && !details?.agents) {
			return [headerFor("success"), ...preview(firstText(result), expanded, theme, "toolOutput")];
		}
		const jobs = details?.jobs ?? [];
		const services = details?.daemons ?? [];
		const agents = details?.agents ?? [];
		const meta = [
			`${jobs.length} ${pluralize("job", jobs.length)}`,
			`${services.length} ${pluralize("service", services.length)}`,
		];
		if (agents.length) meta.push(`${agents.length} ${pluralize("agent", agents.length)}`);
		const items = [
			...jobs.map(job => jobRow(job, theme)),
			...services.map(service => serviceRow(service, theme)),
			...agents.map(agent =>
				itemRow(
					agent.live ? "running" : "success",
					agent.id,
					[theme.fg("dim", "agent"), theme.fg("dim", formatDuration(agent.ageMs))],
					theme,
				),
			),
		];
		return [
			headerFor(items.length ? "success" : "warning", meta),
			...renderTreeList(
				{
					items,
					expanded,
					flush: true,
					maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
					itemType: "process",
					renderItem: item => item,
				},
				theme,
			).map(line => `${INDENT}${line}`),
		];
	}, options);
}

// =============================================================================
// Native (TSP) views
// =============================================================================

function daemonMetaText(daemon: DaemonSnapshot): string {
	const meta: string[] = [daemon.state];
	if (daemon.pid !== undefined) meta.push(`pid ${daemon.pid}`);
	meta.push(
		`${daemon.exitedAt === undefined ? "up" : "ran"} ${formatDuration(Math.max(0, (daemon.exitedAt ?? Date.now()) - daemon.startedAt))}`,
	);
	if (daemon.detached) meta.push("detached");
	else if (daemon.persist) meta.push("persistent");
	return meta.join(" · ");
}

function jobTone(status: JobSnapshot["status"]): TspTone {
	return status === "failed"
		? "error"
		: status === "cancelled"
			? "warning"
			: status === "running"
				? "info"
				: "success";
}

function jobItem(job: JobSnapshot, badge?: { text: string; tone: TspTone }): NativeNode {
	return node(
		"item",
		{
			label: [span(job.type, "accent"), span(" "), span(safe(job.id), "toolOutput")],
			detail: [span(safe(job.label), "muted")],
			value: badge ? [span(badge.text, badge.tone)] : [span(formatDuration(job.durationMs), "muted")],
			tone: badge?.tone ?? jobTone(job.status),
		},
		undefined,
		job.id,
	);
}

function quotedPreview(body: string, tone = "muted"): NativeNode | undefined {
	if (!body.trim()) return undefined;
	return text([span(body, tone)], { wrap: "word", role: "omp.tool.proc.preview" });
}

const RECEIPT_TONE: Record<IrcDeliveryReceipt["outcome"], TspTone> = {
	injected: "success",
	woken: "success",
	revived: "warning",
	failed: "error",
};

/** TSP view of an `agent://` write (IRC message). */
export function describeAgentWrite(
	to: string,
	body: string,
	result: ToolResult | undefined,
	details: CoordinationDetails | undefined,
): NativeToolView {
	const recipient = safe(details?.to || to || "…");
	const receipts = details?.receipts ?? [];
	const delivered = receipts.filter(receipt => receipt.outcome !== "failed").length;
	const failed = receipts.length - delivered;
	const meta: TspSpan[] = [];
	if (recipient === "all") meta.push(span("broadcast", "muted"));
	if (receipts.length === 1) meta.push(span(receipts[0]!.outcome, "muted"));
	else if (receipts.length > 1) {
		if (delivered) meta.push(span(`${delivered} delivered`, "muted"));
		if (failed) meta.push(span(`${failed} failed`, "muted"));
	}
	const head = toolHead("IRC", span(`→ ${recipient}`, "accent"), ...meta);
	const error = result?.isError === true || (failed > 0 && delivered === 0);
	if (result?.isError && receipts.length === 0) {
		return { head, tone: "error", body: [errorText(firstText(result) || "Message delivery failed.")] };
	}
	const children = compact<NativeChild>([
		quotedPreview(body),
		result !== undefined && receipts.length === 0 && noteText(firstText(result) || "No live peers to broadcast to."),
		(receipts.length > 1 || failed > 0) &&
			node(
				"list",
				{ role: "omp.tool.irc.receipts" },
				receipts.map(receipt =>
					node(
						"item",
						{
							label: [span(safe(receipt.to), "toolOutput")],
							value: [span(receipt.outcome, "muted")],
							detail: receipt.error ? [span(safe(receipt.error), "error")] : undefined,
							tone: RECEIPT_TONE[receipt.outcome],
						},
						undefined,
						receipt.to,
					),
				),
			),
	]);
	return { head, tone: error ? "error" : undefined, body: children };
}

/** TSP view of a `proc://` write (stdin, mode change, kill). */
export function describeProcWrite(
	id: string,
	action: ProcWriteAction,
	content: string | undefined,
	result: ToolResult | undefined,
	details: ProcWriteDetails | undefined,
): NativeToolView {
	const daemon = details && "daemon" in details ? details.daemon : undefined;
	const head = toolHead(
		"Proc",
		span(
			action === "mode" && content?.trim() ? `mode ${safe(id)} ${safe(content.trim())}` : `${action} ${safe(id)}`,
			"accent",
		),
		daemon ? daemonMetaText(daemon) : undefined,
	);
	if (result?.isError) {
		return { head, tone: "error", body: [errorText(firstText(result) || "Process operation failed.")] };
	}
	const body = compact<NativeChild>([content && action === "stdin" ? quotedPreview(content) : undefined]);
	if (details && "op" in details && details.op === "cancel") {
		const jobs = details.jobs ?? [];
		body.push(
			node(
				"list",
				{ role: "omp.tool.proc.cancelled" },
				(details.cancelled ?? []).map(outcome => {
					const job = jobs.find(item => item.id === outcome.id);
					const badge = {
						text: outcome.status,
						tone: outcome.status === "cancelled" ? "warning" : "error",
					} as const;
					return job
						? jobItem(job, badge)
						: node(
								"item",
								{ label: [span(safe(outcome.id), "toolOutput")], value: [span(badge.text, badge.tone)] },
								undefined,
								outcome.id,
							);
				}),
			),
		);
	}
	return { head, body };
}

/** TSP view of a `proc://` read: job/service detail, logs, or the process table. */
export function describeProcRead(
	id: string,
	result: ToolResult | undefined,
	details: ProcReadDetails | undefined,
): NativeToolView {
	const daemon = details?.daemon;
	const subject = span(id ? safe(id) : "jobs & services", "accent");
	const head = toolHead("Proc", subject, daemon ? daemonMetaText(daemon) : undefined);
	if (result?.isError) {
		return { head, tone: "error", body: [errorText(firstText(result) || "Process read failed.")] };
	}
	if (!result) return { head };
	if (details?.job) {
		const log = details.log ?? details.job.errorText ?? details.job.resultText ?? "";
		return {
			head,
			body: compact<NativeChild>([
				node("list", {}, [jobItem(details.job)]),
				log.trim().length > 0 && ansi(log, { role: "omp.tool.proc.log" }),
			]),
		};
	}
	if (daemon) {
		const output = details.terminalRows?.join("\n") ?? details.log ?? "";
		return { head, body: [ansi(output, { follow: daemon.exitedAt === undefined, role: "omp.tool.proc.log" })] };
	}
	if (id && !details?.jobs && !details?.daemons && !details?.agents) {
		return { head, body: compact<NativeChild>([quotedPreview(firstText(result), "toolOutput")]) };
	}
	const jobs = details?.jobs ?? [];
	const services = details?.daemons ?? [];
	const agents = details?.agents ?? [];
	const items: NativeNode[] = [
		...jobs.map(job => jobItem(job)),
		...services.map(service =>
			node(
				"item",
				{
					label: [span("service", "accent"), span(" "), span(safe(service.name), "toolOutput")],
					detail: [span(daemonMetaText(service), "muted")],
					tone:
						service.state === "failed"
							? "error"
							: service.state === "ready" || service.state === "running"
								? "success"
								: "warning",
				},
				undefined,
				`service:${service.name}`,
			),
		),
		...agents.map(agent =>
			node(
				"item",
				{
					label: [span("agent", agent.live ? "accent" : "warning"), span(" "), span(safe(agent.id), "toolOutput")],
					value: [span(formatDuration(agent.ageMs), "muted")],
				},
				undefined,
				`agent:${agent.id}`,
			),
		),
	];
	const counts = [
		`${jobs.length} ${pluralize("job", jobs.length)}`,
		`${services.length} ${pluralize("service", services.length)}`,
	];
	if (agents.length) counts.push(`${agents.length} ${pluralize("agent", agents.length)}`);
	return {
		head: toolHead("Proc", subject, counts.join(" · ")),
		body: [node("list", { empty: "No background jobs or services.", role: "omp.tool.proc.table" }, items)],
	};
}
