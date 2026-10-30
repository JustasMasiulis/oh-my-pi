import type { Component } from "../tui";
import type { Theme } from "../theme/theme";
import type { StatusLineOptions } from "../render/status-line";
import { framedToolCard, plainToolCard, type ToolCardSection } from "../render/tool-card";
import {
	clipCollapsed,
	formatErrorText,
	formatExpandHint,
	formatMoreItems,
	PREVIEW_LIMITS,
	replaceTabs,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import type { NativeToolView, RenderResultOptions, ToolRenderer, ToolRenderResult } from "./renderer";
import { ansi, kv } from "../native/describe";
import type { NativeChild } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { errorView, noteText, resultText, toolHead } from "./native-view";

/** Display fields captured from a debugger session. */
export interface DebugSessionSnapshot {
	id: string;
	adapter: string;
	status: string;
	cwd: string;
	program?: string;
	stopReason?: string;
	frameName?: string;
	instructionPointerReference?: string;
	source?: { path?: string };
	line?: number;
	column?: number;
	needsConfigurationDone: boolean;
	exitCode?: number;
}

/** Debug execution metadata consumed by the transcript. */
export interface DebugToolDetails {
	action: string;
	success: boolean;
	snapshot?: DebugSessionSnapshot;
}

/** Debug arguments used to describe a pending request. */
export interface DebugRenderArgs {
	action?: string;
	program?: string;
	file?: string;
	line?: number;
	function?: string;
	expression?: string;
	command?: string;
	memory_reference?: string;
	instruction_reference?: string;
	data_id?: string;
	name?: string;
}

/** Formats a debugger stop location as a source path and coordinates. */
export function formatLocation(snapshot: DebugSessionSnapshot | undefined): string | null {
	if (!snapshot?.source?.path || snapshot.line === undefined) {
		return null;
	}
	return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ""}`;
}

/** Formats the debugger session snapshot for model and terminal output. */
export function formatSessionSnapshot(snapshot: DebugSessionSnapshot): string[] {
	const lines = [
		`Session ${snapshot.id}`,
		`Adapter: ${snapshot.adapter}`,
		`Status: ${snapshot.status}`,
		`CWD: ${snapshot.cwd}`,
	];
	if (snapshot.program) lines.push(`Program: ${snapshot.program}`);
	if (snapshot.stopReason) lines.push(`Stop reason: ${snapshot.stopReason}`);
	if (snapshot.frameName) lines.push(`Frame: ${snapshot.frameName}`);
	if (snapshot.instructionPointerReference) {
		lines.push(`Instruction pointer: ${snapshot.instructionPointerReference}`);
	}
	const location = formatLocation(snapshot);
	if (location) lines.push(`Location: ${location}`);
	if (snapshot.needsConfigurationDone) {
		lines.push("Configuration: pending configurationDone; set breakpoints, then continue.");
	}
	if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`);
	return lines;
}

function summarizeDebugCall(args: DebugRenderArgs): string {
	const action = args.action ? args.action.replaceAll("_", " ") : "request";
	if (args.program) {
		return `${action} ${truncateToWidth(args.program, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.file && args.line !== undefined) {
		return `${action} ${truncateToWidth(`${args.file}:${args.line}`, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.function) {
		return `${action} ${truncateToWidth(args.function, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.expression) {
		return `${action} ${truncateToWidth(args.expression, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.command) {
		return `${action} ${truncateToWidth(args.command, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.memory_reference) {
		return `${action} ${truncateToWidth(args.memory_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.instruction_reference) {
		return `${action} ${truncateToWidth(args.instruction_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.data_id) {
		return `${action} ${truncateToWidth(args.data_id, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.name) {
		return `${action} ${truncateToWidth(args.name, TRUNCATE_LENGTHS.TITLE)}`;
	}
	return action;
}

/** Untruncated `[action, target]` for native heads; mirrors {@link summarizeDebugCall}'s field precedence. */
function debugCallParts(args: DebugRenderArgs | undefined, fallbackAction: string): [string, string | undefined] {
	const action = (args?.action ?? fallbackAction).replaceAll("_", " ");
	if (!args) return [action, undefined];
	const target =
		args.program ||
		(args.file && args.line !== undefined ? `${args.file}:${args.line}` : undefined) ||
		args.function ||
		args.expression ||
		args.command ||
		args.memory_reference ||
		args.instruction_reference ||
		args.data_id ||
		args.name ||
		undefined;
	return [action, target];
}

function describeDebugResult(
	result: ToolRenderResult<DebugToolDetails>,
	args: DebugRenderArgs | undefined,
): NativeToolView {
	const [action, target] = debugCallParts(args, result.details?.action ?? "debug");
	const output = resultText(result);
	if (result.isError) return errorView("Debug", output || "Debug failed", action, target);
	const snapshot = result.details?.snapshot;
	const body: NativeChild[] = [];
	let sessionRows = 0;
	if (snapshot) {
		const location = formatLocation(snapshot);
		const rows: [string, string | undefined][] = [
			["Session", snapshot.id],
			["Adapter", snapshot.adapter],
			["Status", snapshot.status],
			["CWD", snapshot.cwd],
			["Program", snapshot.program],
			["Stop reason", snapshot.stopReason],
			["Frame", snapshot.frameName],
			["Instruction pointer", snapshot.instructionPointerReference],
			["Location", location ?? undefined],
			[
				"Configuration",
				snapshot.needsConfigurationDone ? "pending configurationDone; set breakpoints, then continue." : undefined,
			],
			["Exit code", snapshot.exitCode !== undefined ? String(snapshot.exitCode) : undefined],
		];
		const grid = kv(rows);
		if (grid) {
			body.push(grid);
			sessionRows = rows.filter(([, value]) => value).length;
		}
	}
	body.push(output ? ansi(output) : noteText("No output"));
	return {
		head: toolHead("Debug", action, target),
		body,
		preview: { lines: sessionRows + PREVIEW_LIMITS.COLLAPSED_LINES },
	};
}

const debugResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** The Debug header in every state: the call's action and target as the subject. */
function debugStatus(args: DebugRenderArgs, icon: StatusLineOptions["icon"], spinnerFrame?: number): StatusLineOptions {
	return {
		icon,
		spinnerFrame,
		title: "Debug",
		description: summarizeDebugCall(args),
	};
}

/** Renders debugger calls and captured execution snapshots. */
export const debugToolRenderer = {
	animatedPartialResult: true,
	renderCall(args: DebugRenderArgs, options: RenderResultOptions, theme: Theme): Component {
		return plainToolCard(theme, () => {
			const phase = options.executionStarted ? "running" : "pending";
			return { status: debugStatus(args, phase, options.spinnerFrame), phase };
		});
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: DebugToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: DebugRenderArgs,
	): Component {
		const callArgs = args ?? { action: result.details?.action };
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		if (result.isError) {
			return plainToolCard(theme, () => ({
				status: debugStatus(callArgs, "error"),
				phase: "error",
				body: [formatErrorText(text || "Debug failed", theme)],
			}));
		}
		const sessionLines = result.details?.snapshot
			? formatSessionSnapshot(result.details.snapshot).map(line => theme.fg("muted", replaceTabs(line)))
			: [];
		const outputLines = text.trim() ? replaceTabs(text).split("\n") : [];
		if (sessionLines.length === 0 && outputLines.length === 0) {
			return plainToolCard(theme, () => {
				const partial = options.isPartial === true;
				return {
					status: debugStatus(callArgs, partial ? "running" : "success", options.spinnerFrame),
					phase: partial ? "partial" : "success",
				};
			});
		}
		return framedToolCard(theme, () => {
			const partial = options.isPartial === true;
			const previewLimit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
			const displayedLines = outputLines
				.slice(0, previewLimit)
				.map(line => clipCollapsed(line, TRUNCATE_LENGTHS.LINE, options.expanded));
			const remaining = outputLines.length - displayedLines.length;
			const hint = formatExpandHint(theme, options.expanded, remaining > 0);
			const marker = formatMoreItems(remaining, "line", theme);
			// Session facts open the frame unlabelled; the output follows under its own bar.
			const sections: ToolCardSection[] = [];
			if (sessionLines.length > 0) sections.push({ content: sessionLines });
			if (displayedLines.length > 0) {
				sections.push({
					label: sessionLines.length > 0 ? theme.fg("toolTitle", "Output") : undefined,
					content: displayedLines,
				});
			}
			return {
				status: debugStatus(callArgs, partial ? "running" : "success"),
				phase: partial ? "partial" : "success",
				footerMeta: remaining > 0 ? theme.fg("dim", hint ? `${marker} ${hint}` : marker) : undefined,
				sections,
			};
		});
	},
	describeCall(args: DebugRenderArgs): NativeToolView {
		const [action, target] = debugCallParts(args, "request");
		return { head: toolHead("Debug", action, target) };
	},
	describeResult(
		result: ToolRenderResult<DebugToolDetails>,
		_options: RenderResultOptions,
		args?: DebugRenderArgs,
	): NativeToolView | undefined {
		return debugResultMemo.get(result, [], () => describeDebugResult(result, args));
	},
	mergeCallAndResult: true,
	inline: true,
} satisfies ToolRenderer<DebugRenderArgs, DebugToolDetails>;
