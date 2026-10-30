import type { Component } from "../tui";
import { describeShimmer, shimmerEnabled, shimmerText } from "../theme/shimmer";
import type { TspCardStatus, TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { compact, elapsed, node, row, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { errorView, noteText, resultText, toolHead } from "./native-view";
import type { Theme } from "../theme/theme";
import { oneLineLabel } from "./task";
import { formatCount } from "@oh-my-pi/pi-utils";
import { plainToolCard } from "../render/tool-card";
import { nestRows } from "../render/utils";
import {
	cappedRowCount,
	formatBadge,
	formatDuration,
	formatErrorText,
	formatMoreRow,
	formatStatusIcon,
	replaceTabs,
	sanitizeDisplayLines,
	type ToolUIStatus,
} from "../render/render-utils";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";
/** Operation represented by a worker-session tool result. */
export type VibeOp = "spawn" | "send" | "wait" | "kill" | "list";

/** Details payload shared by every vibe tool for TUI rendering. */
export interface VibeToolDetails {
	op: VibeOp;
	/** Live TV-wall snapshot of the owner's worker sessions at (or during) the call. */
	screens: VibeScreenSnapshot[];
	/** Sessions the director killed, left off `screens`; shown as a count. */
	hiddenKilled?: string[];
	spawned?: { id: string; cli: VibeCli; jobId: string };
	send?: VibeSendOutcome;
	wait?: {
		settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled" }>;
		stillRunning: string[];
		timedOut: boolean;
		/** True on interim progress emissions while the wait is still blocking. */
		waiting?: boolean;
	};
	killed?: VibeKillOutcome;
}
/** Worker session lifecycle as shown to the director. */
export type VibeSessionState = "starting" | "running" | "idle" | "dead";

/**
 * Live per-session "screen" for rich rendering: what the worker is doing right
 * now (tool trace, current tool, streamed text tail) plus roster metadata.
 * Every string is already one-line sanitized.
 */
export interface VibeScreenSnapshot {
	id: string;
	cli: VibeCli;
	state: VibeSessionState;
	/** Terminated by the director (`vibe_kill`) or mode teardown; unset for workers that died on their own. */
	killed?: boolean;
	model?: string;
	turns: number;
	queued: number;
	/** Start of the in-flight turn, when running. */
	turnStartedAt?: number;
	/** Gist of the message that started the in-flight turn. */
	turnMessage?: string;
	currentTool?: string;
	currentToolArgs?: string;
	lastIntent?: string;
	/** Completed tool calls of the in-flight turn, oldest first (tail). */
	trace: string[];
	/** Latest streamed worker text lines, oldest first. */
	outputTail: string[];
	lastActivity?: string;
	lastActivityAt: number;
}

/** Worker identity and job handle returned by a spawn. */
export interface VibeSpawnOutcome {
	id: string;
	jobId: string;
}

/** Delivery mode and optional turn job for a worker message. */
export interface VibeSendOutcome {
	id: string;
	/**
	 * - `turn`: a new background turn was started (`jobId` set).
	 * - `steered`: worker was mid-turn and streaming; delivered as steering.
	 * - `queued`: worker was mid-turn but not steerable; drained into the next turn.
	 */
	mode: "turn" | "steered" | "queued";
	jobId?: string;
}

/** Worker shutdown outcome including any cancelled turn. */
export interface VibeKillOutcome {
	id: string;
	/** True when an in-flight turn job was cancelled along the way. */
	cancelledTurn: boolean;
}

/** Settled and still-running worker turns observed by a wait. */
export interface VibeWaitOutcome {
	/** Watched sessions whose snapshotted turn settled during (or before) the wait.
	 * May overlap `stillRunning` when a queued follow-up turn already started. */
	settled: Array<{ id: string; jobId: string; status: "completed" | "failed" | "cancelled"; resultText: string }>;
	/** Watched sessions with a turn in flight when the wait returned. */
	stillRunning: string[];
	timedOut: boolean;
}
/** The two worker CLI flavors the director drives. */
export type VibeCli = "fast" | "good";
// =============================================================================
// TUI Renderer — mini composer (spawn/send) + TV wall (wait/list)
// =============================================================================

const TITLE = "Vibe";
const COMPOSER_ROWS_COLLAPSED = 2;
const COMPOSER_ROWS_EXPANDED = 6;
const COMPOSER_LINE_MAX = 96;
const TV_LINE_MAX = 110;
const TV_TRACE_COLLAPSED = 2;
const TV_TRACE_EXPANDED = 6;
const TV_OUTPUT_COLLAPSED = 1;
const TV_OUTPUT_EXPANDED = 3;

/** A worker's lifecycle as an item status icon. */
function screenStatus(state: VibeSessionState, settled?: "completed" | "failed" | "cancelled"): ToolUIStatus {
	if (settled === "failed") return "error";
	if (settled === "cancelled") return "aborted";
	if (settled === "completed") return "success";
	switch (state) {
		case "running":
			return "running";
		case "starting":
			return "pending";
		case "idle":
			return "success";
		case "dead":
			return "aborted";
	}
}

interface VibeRenderArgs {
	cli?: VibeCli;
	prompt?: string;
	name?: string;
	session?: string;
	message?: string;
	sessions?: string[];
}

/** One-line, escape-stripped fragment for embedding in a row. */
function frameText(text: string, max: number): string {
	return oneLineLabel(replaceTabs(text), max);
}

/** Header subject `op target`, shared by the call, the result, and the native head. */
function vibeSubject(op: VibeOp, args: VibeRenderArgs | undefined, sep: string, details?: VibeToolDetails): string {
	switch (op) {
		case "spawn": {
			const cli = details?.spawned?.cli ?? args?.cli ?? "fast";
			const name = details?.spawned?.id ?? args?.name;
			return name ? `spawn ${cli}${sep}${frameText(name, 40)}` : `spawn ${cli}`;
		}
		case "send":
			return args?.session ? `send ${frameText(args.session, 40)}` : "send";
		case "wait":
			return args?.sessions?.length ? `wait ${frameText(args.sessions.join(", "), 60)}` : "wait all";
		case "kill": {
			const target = details?.killed?.id ?? args?.session;
			return target ? `kill ${frameText(target, 40)}` : "kill";
		}
		case "list":
			return "list";
	}
}

/** The director's message being sent, indented as body rows. */
function messageRows(uiTheme: Theme, message: string, expanded: boolean): string[] {
	const rawLines = message.split(/\r?\n/).filter(line => line.trim().length > 0);
	const maxRows = cappedRowCount(rawLines.length, expanded ? COMPOSER_ROWS_EXPANDED : COMPOSER_ROWS_COLLAPSED);
	const rows = rawLines.slice(0, maxRows).map(line => uiTheme.fg("toolOutput", frameText(line, COMPOSER_LINE_MAX)));
	const hidden = rawLines.length - maxRows;
	if (hidden > 0) rows.push(formatMoreRow(hidden, "line", uiTheme, { expanded }));
	return rows;
}

/** The director's message a composer op sends: the spawn prompt or the send body; empty otherwise. */
function vibeMessage(op: VibeOp, args: VibeRenderArgs | undefined): string {
	if (op === "spawn") return args?.prompt ?? "";
	if (op === "send") return args?.message ?? "";
	return "";
}

/** One worker: `<icon> id [cli] - state - 3t - 1m2s - model`, its live trace nested below. */
function screenRows(
	uiTheme: Theme,
	screen: VibeScreenSnapshot,
	options: RenderResultOptions,
	settledStatus: "completed" | "failed" | "cancelled" | undefined,
	nowMs: number,
): string[] {
	const live = screen.state === "running" || screen.state === "starting";
	const animate = live && options.spinnerFrame !== undefined;
	const icon = formatStatusIcon(
		screenStatus(screen.state, settledStatus),
		uiTheme,
		animate ? options.spinnerFrame : undefined,
	);
	const idText = animate && shimmerEnabled() ? shimmerText(screen.id, uiTheme) : uiTheme.fg("accent", screen.id);
	const facts = compact([
		uiTheme.fg("muted", settledStatus ? `turn ${settledStatus}` : screen.state),
		uiTheme.fg("muted", `${screen.turns}t${screen.queued > 0 ? `+${screen.queued}q` : ""}`),
		screen.turnStartedAt !== undefined ? uiTheme.fg("dim", formatDuration(nowMs - screen.turnStartedAt)) : undefined,
		screen.model ? uiTheme.fg("dim", frameText(screen.model, 40)) : undefined,
	]).join(uiTheme.sep.dot);
	const head = `${icon} ${idText} ${formatBadge(screen.cli, "muted", uiTheme)}${uiTheme.sep.dot}${facts}`;

	const details: string[] = [];
	if (live) {
		if (screen.turnMessage) details.push(uiTheme.fg("dim", frameText(screen.turnMessage, TV_LINE_MAX)));
		const traceCap = options.expanded ? TV_TRACE_EXPANDED : TV_TRACE_COLLAPSED;
		for (const line of screen.trace.slice(-traceCap)) details.push(uiTheme.fg("dim", frameText(line, TV_LINE_MAX)));
		const toolDetail = screen.lastIntent ?? screen.currentToolArgs;
		const toolLabel = toolDetail ? `${screen.currentTool}: ${toolDetail}` : screen.currentTool;
		const current = screen.currentTool ? toolLabel : screen.lastIntent;
		if (current) {
			const label = frameText(current, TV_LINE_MAX);
			details.push(animate && shimmerEnabled() ? shimmerText(label, uiTheme) : uiTheme.fg("muted", label));
		}
		const outputCap = options.expanded ? TV_OUTPUT_EXPANDED : TV_OUTPUT_COLLAPSED;
		for (const line of screen.outputTail.slice(-outputCap)) {
			if (line.trim()) details.push(uiTheme.fg("toolOutput", frameText(line, TV_LINE_MAX)));
		}
	} else if (screen.lastActivity) {
		details.push(uiTheme.fg("muted", frameText(screen.lastActivity, TV_LINE_MAX)));
	}
	return [head, ...nestRows(details, uiTheme)];
}

// =============================================================================
// Native (TSP) Description — the terminal clocks spinners, shimmer and timers
// =============================================================================

/** The director's composed message as `>`-prefixed wrapped text, or undefined when empty. */
function vibeComposer(message: string): NativeNode | undefined {
	const trimmed = plainText(message).trim();
	if (!trimmed) return undefined;
	return text([span("> ", "accent"), span(trimmed, "toolOutput")], { wrap: "word", role: "omp.vibe.composer" });
}

function vibeScreenStatus(
	screen: VibeScreenSnapshot,
	settled: "completed" | "failed" | "cancelled" | undefined,
): [TspCardStatus, TspTone] {
	if (settled === "failed") return ["error", "error"];
	if (settled === "cancelled") return ["cancelled", "warning"];
	if (settled === "completed") return ["done", "success"];
	switch (screen.state) {
		case "running":
			return ["running", "accent"];
		case "starting":
			return ["pending", "accent"];
		case "idle":
			return ["done", "success"];
		case "dead":
			return ["cancelled", "muted"];
	}
}

/** One worker "TV" as a nested card: identity head, roster meta, live trace, output tail. */
function describeVibeScreen(
	screen: VibeScreenSnapshot,
	settled: "completed" | "failed" | "cancelled" | undefined,
	nowMs: number,
): NativeNode {
	const live = screen.state === "running" || screen.state === "starting";
	const [status, tone] = vibeScreenStatus(screen, settled);
	const head: TspSpan[] = [
		live && shimmerEnabled()
			? span(screen.id, "accent", { fx: "shimmer" })
			: span(screen.id, live ? "accent" : "toolOutput"),
		span(` ${settled ?? screen.state}`, "dim"),
		span(` ${screen.turns}t${screen.queued > 0 ? `+${screen.queued}q` : ""}`, "muted"),
	];
	if (screen.model) head.push(span(` ${plainText(screen.model)}`, "muted"));
	const body: NativeChild[] = [
		row(
			compact([
				node("badge", { text: screen.cli, tone }),
				screen.turnStartedAt !== undefined ? elapsed(nowMs - screen.turnStartedAt, !live) : undefined,
			]),
			{ gap: "sm" },
		),
	];
	if (live) {
		if (screen.turnMessage) {
			body.push(text([span("> ", "accent"), span(plainText(screen.turnMessage), "dim")], { truncate: "end" }));
		}
		for (const line of screen.trace.slice(-TV_TRACE_EXPANDED)) {
			body.push(text([span(plainText(line), "dim")], { truncate: "end" }));
		}
		const detail = screen.lastIntent ?? screen.currentToolArgs;
		if (screen.currentTool) {
			body.push(describeShimmer([{ text: plainText(`${screen.currentTool}${detail ? `: ${detail}` : ""}`) }]));
		} else if (screen.lastIntent) {
			body.push(text([span(plainText(screen.lastIntent), "muted")], { truncate: "end" }));
		}
		for (const line of screen.outputTail.slice(-TV_OUTPUT_EXPANDED)) {
			if (line.trim().length > 0) body.push(text([span(plainText(line), "muted")], { truncate: "end" }));
		}
	} else if (screen.lastActivity) {
		body.push(text([span(plainText(screen.lastActivity), "muted")], { truncate: "end" }));
	}
	if (settled) {
		body.push(
			text([
				span(
					`turn ${settled}, result delivered`,
					settled === "completed" ? "success" : settled === "failed" ? "error" : "warning",
				),
			]),
		);
	}
	return node(
		"card",
		{
			role: "omp.vibe.screen",
			status,
			tone,
			head,
			collapsible: true,
			preview: { lines: 1 + TV_TRACE_COLLAPSED + TV_OUTPUT_COLLAPSED + 1 },
			inset: true,
		},
		body,
		screen.id,
	);
}

function describeVibeResult(
	op: VibeOp,
	result: ToolRenderResult<VibeToolDetails>,
	args: VibeRenderArgs | undefined,
): NativeToolView {
	const details = result.details;
	const label = vibeSubject(op, args, " · ", details);
	if (result.isError) return { ...errorView("Vibe", resultText(result) || "vibe failed", label), inline: true };
	if (!details) {
		const fallback = resultText(result).trim();
		return { head: toolHead("Vibe", label), inline: true, body: fallback ? [noteText(fallback)] : [] };
	}

	if (op === "spawn" || op === "send") {
		const message = vibeMessage(op, args);
		const head = toolHead("Vibe", label);
		const ack: TspSpan =
			op === "spawn"
				? span(`turn started${details.spawned ? ` (job ${details.spawned.jobId})` : ""}`, "success")
				: details.send?.mode === "steered"
					? span("steered into the running turn", "success")
					: details.send?.mode === "queued"
						? span("mid-turn, queued as the next turn", "warning")
						: span(`turn started${details.send?.jobId ? ` (job ${details.send.jobId})` : ""}`, "success");
		return {
			head,
			inline: true,
			tone: details.send?.mode === "queued" ? "warning" : undefined,
			body: compact([vibeComposer(message), text([ack], { wrap: "word" })]),
			preview: { lines: 3 },
		};
	}

	if (op === "kill") {
		const note = details.killed?.cancelledTurn ? "in-flight turn cancelled" : undefined;
		return { head: toolHead("Vibe", label, note), inline: true };
	}

	const screens = details.screens;
	const hiddenKilled = details.hiddenKilled?.length ?? 0;
	const killedMeta = hiddenKilled > 0 ? span(` · ${hiddenKilled} killed hidden`, "dim") : undefined;
	if (screens.length === 0) {
		const gist = hiddenKilled > 0 ? "no live sessions" : resultText(result).trim() || "no sessions";
		const head = toolHead("Vibe", label, gist);
		if (killedMeta) head.push(killedMeta);
		return { head, tone: "warning", inline: true };
	}
	const settledById = new Map(details.wait?.settled.map(entry => [entry.id, entry.status] as const) ?? []);
	const running = screens.filter(screen => screen.state === "running" || screen.state === "starting").length;
	const head: TspSpan[] = toolHead("Vibe", label, `${screens.length} sessions`);
	if (running > 0) head.push(span(` · ${running} on air`, "accent"));
	if (settledById.size > 0) head.push(span(` · ${settledById.size} settled`, "success"));
	if (details.wait?.timedOut) head.push(span(" · timed out", "warning"));
	if (killedMeta) head.push(killedMeta);
	const nowMs = Date.now();
	return {
		head,
		inline: true,
		tone: details.wait?.timedOut ? "warning" : undefined,
		body: screens.map(screen => describeVibeScreen(screen, settledById.get(screen.id), nowMs)),
		preview: "auto",
	};
}

/** Build the shared vibe renderer for one tool name. */
export function createVibeToolRenderer(op: VibeOp) {
	const composerOp = op === "spawn" || op === "send";
	const callMemo = new OwnerMemo<NativeToolView | undefined>();
	const resultMemo = new OwnerMemo<NativeToolView | undefined>();
	return {
		inline: true,
		mergeCallAndResult: true,
		animatedPendingPreview: composerOp,
		animatedPartialResult: op === "wait",

		renderCall(args: VibeRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
			const message = vibeMessage(op, args);
			return plainToolCard(uiTheme, () => ({
				status: {
					icon: options.executionStarted ? "running" : "pending",
					spinnerFrame: options.spinnerFrame,
					title: TITLE,
					description: vibeSubject(op, args, uiTheme.sep.dot),
				},
				phase: options.executionStarted ? "running" : "pending",
				body: messageRows(uiTheme, message, options.expanded),
			}));
		},

		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: VibeToolDetails; isError?: boolean },
			options: RenderResultOptions,
			uiTheme: Theme,
			args?: VibeRenderArgs,
		): Component {
			const details = result.details;
			const subject = vibeSubject(op, args, uiTheme.sep.dot, details);
			const fallback = result.content.find(part => part.type === "text")?.text?.trim() ?? "";
			if (!details || result.isError) {
				return plainToolCard(uiTheme, () => ({
					status: { icon: result.isError ? "error" : "success", title: TITLE, description: subject },
					phase: result.isError ? "error" : "success",
					body: fallback
						? sanitizeDisplayLines(fallback).map(line =>
								result.isError ? formatErrorText(line, uiTheme) : uiTheme.fg("muted", line),
							)
						: [],
				}));
			}

			if (composerOp) {
				const message = vibeMessage(op, args);
				const queued = details.send?.mode === "queued";
				const jobId = op === "spawn" ? details.spawned?.jobId : details.send?.jobId;
				const mode = op === "send" ? details.send?.mode : undefined;
				return plainToolCard(uiTheme, () => ({
					status: {
						icon: queued ? "warning" : "success",
						title: TITLE,
						description: subject,
						badge: mode ? { label: mode, color: queued ? "warning" : "success" } : undefined,
						meta: jobId ? [`job ${jobId}`] : undefined,
					},
					phase: queued ? "warning" : "success",
					body: messageRows(uiTheme, message, options.expanded),
				}));
			}

			if (op === "kill") {
				return plainToolCard(uiTheme, () => ({
					status: {
						icon: "success",
						title: TITLE,
						description: subject,
						meta: details.killed?.cancelledTurn ? ["in-flight turn cancelled"] : undefined,
					},
					phase: "success",
				}));
			}

			// wait/list: the TV wall. Director-killed sessions arrive pre-filtered
			// (see `hiddenKilled`) so a long-running director's wall stays legible.
			const screens = details.screens;
			const hiddenKilled = details.hiddenKilled?.length ?? 0;
			const killedMeta = hiddenKilled > 0 ? [`${hiddenKilled} killed hidden`] : [];
			if (screens.length === 0) {
				return plainToolCard(uiTheme, () => ({
					status: {
						icon: "warning",
						title: TITLE,
						description: subject,
						meta: ["0 sessions", ...killedMeta],
					},
					phase: "warning",
				}));
			}
			const settledById = new Map(details.wait?.settled.map(entry => [entry.id, entry.status] as const) ?? []);
			const snapshotTime = Date.now();
			const wallOptions = options.isPartial ? options : { ...options, spinnerFrame: undefined };
			return plainToolCard(uiTheme, () => {
				const running = screens.filter(screen => screen.state === "running" || screen.state === "starting").length;
				const meta = [formatCount("session", screens.length)];
				if (running > 0) meta.push(`${running} on air`);
				if (settledById.size > 0) meta.push(`${settledById.size} settled`);
				if (details.wait?.timedOut) meta.push("timed out");
				meta.push(...killedMeta);
				let icon: "warning" | "success" | "running" | "pending" = details.wait?.timedOut ? "warning" : "success";
				if (options.isPartial) icon = options.spinnerFrame !== undefined ? "running" : "pending";
				const nowMs = options.isPartial ? Date.now() : snapshotTime;
				return {
					status: { icon, spinnerFrame: wallOptions.spinnerFrame, title: TITLE, description: subject, meta },
					phase: icon === "pending" ? "partial" : icon,
					body: screens.flatMap(screen =>
						screenRows(uiTheme, screen, wallOptions, settledById.get(screen.id), nowMs),
					),
				};
			});
		},

		describeCall(args: VibeRenderArgs): NativeToolView | undefined {
			const message = vibeMessage(op, args);
			const label = vibeSubject(op, args, " · ");
			return callMemo.get(args, [label, message], () => {
				const head = toolHead("Vibe", label);
				if (!composerOp) return { head, inline: true };
				return {
					head,
					inline: true,
					body: compact([
						vibeComposer(message),
						node("spinner", { label: [span(op === "spawn" ? "booting CLI…" : "delivering…", "dim")] }),
					]),
					preview: { lines: 3 },
				};
			});
		},

		describeResult(
			result: ToolRenderResult<VibeToolDetails>,
			_options: RenderResultOptions,
			args?: VibeRenderArgs,
		): NativeToolView | undefined {
			return resultMemo.get(result, [], () => describeVibeResult(op, result, args));
		},
	} satisfies ToolRenderer<VibeRenderArgs, VibeToolDetails>;
}
