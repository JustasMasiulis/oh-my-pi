import type { Usage } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ThemeColor } from "../theme/theme";
import type { ConfiguredThinkingLevel } from "../render/render-utils";
import type { ToolRenderer } from "./renderer";
/**
 * TUI rendering for task tool.
 *
 * Provides renderCall and renderResult functions for displaying
 * task execution in the terminal UI.
 */
import * as path from "node:path";
import { Container, type Component } from "../tui";
import { Markdown } from "../components/markdown";
import { Text } from "../components/text";
import { visibleWidth, wrapTextWithAnsi } from "../utils";
import { formatCount, sanitizeText } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "./renderer";
import { type AgentTreeRowOptions, renderAgentTreeRow } from "./agent-tree";
import { getMarkdownTheme, type Theme } from "../theme/theme";
import { stripGeneratedOutputNotice, stripRawOutputArtifactNotice, stripTrailingNotice } from "./output-meta";
import {
	capPreviewLines,
	formatBadge,
	formatDuration,
	formatErrorText,
	formatExpandHint,
	formatMoreItems,
	formatMoreRow,
	formatNumber,
	isFeedModelBadgeEnabled,
	formatStatusIcon,
	previewLine,
	clipCollapsed,
	flattenLine,
	previewWindowRows,
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	shortenToolArgumentPaths,
	type ToolUIStatus,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../render/render-utils";
import type { StatusLineOptions } from "../render/status-line";
import { framedToolCard, plainToolCard, type ToolCardSection } from "../render/tool-card";
import { wrapPrefixedLine } from "../render/hanging-wrap";
import { formatOutputInline, renderJsonTreeLines } from "./json-tree";
import { repairDoubleEncodedJsonString } from "./task-repair-args";
import { getSubprocessToolRenderer } from "./subprocess";
import { assembleYieldResult, type YieldSectionShapes } from "./task-yield-assembly";
import type { TspAgentProps, TspProps, TspTone } from "@oh-my-pi/pi-wire";
import { compact, kv, md, node, propNode, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { OwnerMemo, sameItems } from "../native/memo";
import { plainText } from "../native/spans";
import { errorText, noteText, resultText } from "./native-view";
import { describeJsonValue } from "./json-tree";
import { taskSummary } from "../overlays/agent-hub-renderer";
import type { NativeToolView, ToolRenderResult } from "./renderer";

/** Render context threaded in from `ToolExecutionComponent.#buildRenderContext`. */
interface TaskRenderContext {
	hasResult?: boolean;
	/**
	 * The block left the transcript live region (detached spawn the transcript
	 * has moved past, or a sealed block): progress rows render static gray, so
	 * commit-eligible rows do not repaint after entering native scrollback.
	 */
	frozen?: boolean;
	/**
	 * Wall clock for time-derived rows (current-tool elapsed, retry countdown).
	 * The component freezes it once the block settles or any of its rows enter
	 * native scrollback, so identical-input rebuilds stay byte-identical with
	 * committed history. Absent: render with the live clock.
	 */
	nowMs?: number;
}
type TaskRenderOptions = RenderResultOptions & { renderContext?: TaskRenderContext };

const MAX_NESTED_TASK_RENDER_DEPTH = 8;

function renderNestedCycleLine(theme: Theme): string {
	return theme.fg("dim", `${theme.format.ellipsis} nested task progress already shown`);
}

function renderNestedDepthLimitLine(theme: Theme): string {
	return theme.fg("dim", `${theme.format.ellipsis} nested task depth limit reached`);
}

function formatFindingSummary(findings: FindingDetails[], theme: Theme): string {
	if (findings.length === 0) return theme.fg("dim", "Findings: none");

	const counts: { [P in FindingPriority]?: number } = {};
	for (const finding of findings) {
		counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
	}

	const parts: string[] = [];
	for (const label of PRIORITY_LABELS) {
		const { symbol, color } = getPriorityInfo(label);
		const count = counts[label] ?? 0;
		const text = theme.fg(color, `${label}:${count}`);
		parts.push(theme.styledSymbol(symbol, color) ? `${theme.styledSymbol(symbol, color)} ${text}` : text);
	}

	return `${theme.fg("dim", "Findings:")} ${parts.join(theme.sep.dot)}`;
}

function normalizeFindings(value: unknown): FindingDetails[] {
	if (!Array.isArray(value)) return [];
	const findings: FindingDetails[] = [];
	for (const item of value) {
		const finding = parseFindingDetails(item);
		if (finding) findings.push(finding);
	}
	return findings;
}

/** Reviewer output shapes: `findings` is an array (a lone finding still assembles as a list); the verdict fields are scalars. */
const REVIEWER_SECTION_SHAPES: YieldSectionShapes = new Map([
	["findings", "array"],
	["overall_correctness", "scalar"],
	["explanation", "scalar"],
	["confidence", "scalar"],
]);

function extractIncrementalReviewResult(
	items: RenderYieldItem[],
): { summary: SubmitReviewDetails; findings: FindingDetails[] } | undefined {
	const yieldItems: YieldItem[] = items.map(item => ({
		data: item.data,
		type: item.type,
		status: item.status === "aborted" ? "aborted" : item.status === "success" ? "success" : undefined,
		useLastTurn: item.useLastTurn,
	}));
	const assembled = assembleYieldResult(yieldItems, undefined, REVIEWER_SECTION_SHAPES);
	const data = assembled?.data;
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const record = data as Record<string, unknown>;
	const overallCorrectness = record.overall_correctness;
	const explanation = record.explanation;
	const confidence = record.confidence;
	if (
		(overallCorrectness !== "correct" && overallCorrectness !== "incorrect") ||
		typeof explanation !== "string" ||
		typeof confidence !== "number"
	) {
		return undefined;
	}
	return {
		summary: {
			overall_correctness: overallCorrectness,
			explanation,
			confidence,
		},
		findings: normalizeFindings(record.findings),
	};
}

interface RenderYieldItem {
	data?: unknown;
	type?: string | string[];
	status?: string;
	useLastTurn?: boolean;
}

/**
 * Normalize the `yield` slot of `extractedToolData` into an array of
 * yield-detail records. The subprocess executor always populates this slot as
 * `unknown[]` (see `executor.ts` `extractData` handler), but the renderer
 * MUST also tolerate a stray single object — optional chaining short-circuits
 * on `null`/`undefined` only, so calling `.map` on a plain object would throw
 * `TypeError: completeData?.map is not a function` and crash the TUI.
 * A single object is wrapped as a 1-element array so the review verdict still
 * renders; non-object primitives drop out.
 */
function normalizeYieldData(value: unknown): RenderYieldItem[] {
	const items = Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
	const normalized: RenderYieldItem[] = [];
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const typeValue = record.type;
		let type: RenderYieldItem["type"];
		if (typeof typeValue === "string") {
			type = typeValue;
		} else if (Array.isArray(typeValue)) {
			const labels: string[] = [];
			let allLabels = true;
			for (const label of typeValue) {
				if (typeof label !== "string") {
					allLabels = false;
					break;
				}
				labels.push(label);
			}
			if (allLabels) type = labels;
		}
		normalized.push({
			data: record.data,
			type,
			status: typeof record.status === "string" ? record.status : undefined,
			useLastTurn: record.useLastTurn === true ? true : undefined,
		});
	}
	return normalized;
}

function getRenderYieldLabels(type: RenderYieldItem["type"]): string[] {
	if (typeof type === "string") {
		const label = type.trim();
		return label ? [label] : [];
	}
	if (!Array.isArray(type)) return [];
	const labels: string[] = [];
	for (const value of type) {
		const label = value.trim();
		if (label) labels.push(label);
	}
	return labels;
}

function formatYieldPreview(item: RenderYieldItem): string {
	if (item.useLastTurn === true && item.data === undefined) return "last assistant turn";
	if (item.data === undefined) return "last assistant turn";
	if (typeof item.data === "string") return previewLine(sanitizeText(item.data), 70);
	try {
		return previewLine(sanitizeText(JSON.stringify(item.data) ?? "null"), 70);
	} catch {
		return previewLine(sanitizeText(String(item.data)), 70);
	}
}

function renderTypedYieldSections(value: unknown, continuePrefix: string, expanded: boolean, theme: Theme): string[] {
	const typedItems: Array<{ item: RenderYieldItem; labels: string[] }> = [];
	for (const item of normalizeYieldData(value)) {
		const labels = getRenderYieldLabels(item.type);
		if (labels.length === 0) continue;
		typedItems.push({ item, labels });
	}
	const displayCount = expanded ? typedItems.length : 3;
	const lines: string[] = [];
	for (const { item, labels } of typedItems.slice(-displayCount)) {
		const terminal = !Array.isArray(item.type);
		const prefix = terminal ? "yield" : "yield+";
		const label = `${prefix}[${labels.join(", ")}]`;
		lines.push(`${continuePrefix}${theme.fg("dim", label)}: ${theme.fg("dim", formatYieldPreview(item))}`);
	}
	if (typedItems.length > displayCount) {
		lines.push(
			`${continuePrefix}${theme.fg("dim", formatMoreItems(typedItems.length - displayCount, "yield", theme))}`,
		);
	}
	return lines;
}

/**
 * Per-frame memo for derived agent rows. Live task cards re-render at spinner
 * cadence, while yield/recent-output arrays only change when the subagent
 * reports. Entries are keyed by the source array (or object) and validated
 * against a shallow snapshot of its elements plus the render deps, so in-place
 * pushes/shifts invalidate correctly.
 */
interface SnapshotMemoEntry<T> {
	items: unknown[];
	deps: unknown[];
	value: T;
}

function memoBySnapshot<T>(
	cache: WeakMap<object, SnapshotMemoEntry<T>>,
	source: unknown,
	deps: unknown[],
	compute: () => T,
): T {
	if (source === null || typeof source !== "object") return compute();
	const items: unknown[] = Array.isArray(source) ? source.slice() : [source];
	const entry = cache.get(source);
	if (entry && sameItems(entry.items, items) && sameItems(entry.deps, deps)) return entry.value;
	const value = compute();
	cache.set(source, { items, deps, value });
	return value;
}

const yieldSectionsMemo = new WeakMap<object, SnapshotMemoEntry<string[]>>();
const completedReviewMemo = new WeakMap<object, SnapshotMemoEntry<string[] | null>>();
const recentOutputMemo = new WeakMap<object, SnapshotMemoEntry<string[]>>();
const agentResultMemo = new WeakMap<object, SnapshotMemoEntry<string[]>>();
const agentResultFoldsMemo = new WeakMap<object, SnapshotMemoEntry<boolean>>();

/** Formats sanitized task identifiers as hierarchy breadcrumbs. */
export function formatTaskId(id: string): string {
	// Ids are name-based (e.g. "Anna", "Anna-2"); a "." separates nesting levels
	// (e.g. "Anna.Bob"). Render the hierarchy with a ">" breadcrumb.
	const sanitizedId = sanitizeText(id);
	const segments = sanitizedId.split(".");
	return segments.length < 2 ? sanitizedId : segments.join(">");
}

const MISSING_YIELD_WARNING_PREFIX = "SYSTEM WARNING: Subagent exited without calling yield tool";

function extractMissingYieldWarning(output: string): { warning?: string; rest: string } {
	const lines = output.split("\n");
	const firstLine = lines[0]?.trim() ?? "";
	if (!firstLine.startsWith(MISSING_YIELD_WARNING_PREFIX)) {
		return { rest: output };
	}
	const rest = lines
		.slice(1)
		.join("\n")
		.replace(/^\s*\n+/, "");
	return { warning: firstLine, rest };
}

const BASH_WALL_TIME_NOTICE_RE = /^Wall time: \d+(?:\.\d+)? seconds$/u;
const BASH_EXIT_CODE_NOTICE_RE = /^Command exited with code -?\d+$/u;

function sanitizeRecentOutput(output: string): string {
	let text = sanitizeText(output).trimEnd();
	while (text) {
		const withoutArtifactNotice = stripRawOutputArtifactNotice(text).text;
		if (withoutArtifactNotice !== text) {
			text = withoutArtifactNotice;
			continue;
		}
		const withoutOutputNotice = stripGeneratedOutputNotice(text);
		if (withoutOutputNotice !== text) {
			text = withoutOutputNotice;
			continue;
		}
		const withoutRuntimeNotice = stripTrailingNotice(
			text,
			line => BASH_WALL_TIME_NOTICE_RE.test(line) || BASH_EXIT_CODE_NOTICE_RE.test(line),
		);
		if (withoutRuntimeNotice !== text) {
			text = withoutRuntimeNotice;
			continue;
		}
		break;
	}
	return text;
}

/**
 * Rows for `content` after `prefix`; once the width is known, continuation
 * rows hang at the content column under the same prefix.
 */
function hangingRows(prefix: string, content: string, maxWidth: number): string[] {
	return Number.isFinite(maxWidth) ? wrapPrefixedLine(prefix, prefix, content, maxWidth) : [`${prefix}${content}`];
}

function renderOutputSection(
	output: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxCollapsed = 3,
	maxExpanded = 10,
	warning?: string,
	maxWidth = Number.POSITIVE_INFINITY,
): string[] {
	const lines: string[] = [];
	const trimmedOutput = sanitizeText(output).trimEnd();
	if (!trimmedOutput && !warning) return lines;

	const label = `${continuePrefix}${theme.fg("dim", "Output")}`;
	const indent = `${continuePrefix}  `;
	// A warning opens the section with its label; otherwise the label leads
	// only the expanded body, and a collapsed JSON summary sits flush.
	if (warning) {
		const warningText = theme.fg("dim", clipCollapsed(sanitizeText(warning), 80, expanded));
		lines.push(label, `${indent}${formatStatusIcon("warning", theme)} ${warningText}`);
		if (!trimmedOutput) return lines;
	}

	if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmedOutput);

			// Collapsed: inline format like Args
			if (!expanded) {
				lines.push(`${warning ? indent : continuePrefix}${theme.fg("dim", formatOutputInline(parsed))}`);
				return lines;
			}

			// Expanded: tree format
			const tree = renderJsonTreeLines(parsed, theme, {
				maxDepth: 6,
				maxLines: 24,
				maxScalarLen: 70,
				sanitizeText,
				hiddenRootKeys: [],
				multilineStrings: true,
				rootConnectors: "siblings",
				escapeStringWhitespace: false,
			});
			if (tree.lines.length > 0) {
				if (!warning) lines.push(label);
				for (const line of tree.lines) lines.push(`${indent}${line}`);
				if (tree.truncated) lines.push(`${indent}${theme.fg("dim", theme.format.ellipsis)}`);
				return lines;
			}
		} catch {
			// Fall back to raw output
		}
	}

	if (!warning) lines.push(label);
	const outputLines = trimmedOutput.split("\n");
	const previewCount = expanded ? maxExpanded : maxCollapsed;
	for (const line of outputLines.slice(0, previewCount)) {
		lines.push(...hangingRows(indent, theme.fg("dim", clipCollapsed(replaceTabs(line), 70, expanded)), maxWidth));
	}
	if (outputLines.length > previewCount) {
		lines.push(`${indent}${theme.fg("dim", formatMoreItems(outputLines.length - previewCount, "line", theme))}`);
	}
	return lines;
}

function renderTaskSection(
	task: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxWidth: number,
	maxExpanded = 20,
): string[] {
	const lines: string[] = [];
	const trimmed = sanitizeText(task).trim();
	if (!expanded || !trimmed) return lines;

	lines.push(`${continuePrefix}${theme.fg("dim", "Task")}`);
	const indent = `${continuePrefix}  `;
	const taskLines = trimmed
		.split("\n")
		.flatMap(line => hangingRows(indent, theme.fg("dim", replaceTabs(line)), maxWidth));
	lines.push(...taskLines.slice(0, maxExpanded));
	if (taskLines.length > maxExpanded) {
		lines.push(`${indent}${theme.fg("dim", formatMoreItems(taskLines.length - maxExpanded, "line", theme))}`);
	}

	return lines;
}

function taskPreviewText(task: unknown, taskFile: unknown): string {
	if (typeof task === "string") return task;
	if (typeof taskFile !== "string") return "";
	return flattenLine(replaceTabs(shortenPath(sanitizeText(taskFile))));
}

/**
 * First line of a streamed `task` brief, trimmed — a row's secondary text.
 * The args stream in token by token, so non-string values fall through to "".
 */
function taskFirstLine(task: unknown): string {
	if (typeof task !== "string") return "";
	const trimmed = sanitizeText(task).trim();
	const newline = trimmed.indexOf("\n");
	return newline === -1 ? trimmed : trimmed.slice(0, newline);
}

/** Headline cap for a single agent's subject when it falls back to the assignment's first line. */
const SUBJECT_PREVIEW_WIDTH = 48;

/**
 * Header subject: the single agent's description (its name until a
 * description lands), or `N agents` for a batch. The args stream in token by
 * token, so every field access is defensive.
 */
function taskSubject(args: Partial<TaskParams> | undefined, details?: TaskToolDetails): string | undefined {
	const spawned = new Map<string, { id: string; description?: string }>();
	for (const result of details?.results ?? []) spawned.set(result.id, result);
	for (const progress of details?.progress ?? []) if (!spawned.has(progress.id)) spawned.set(progress.id, progress);
	if (spawned.size > 1) return formatCount("agent", spawned.size);
	const [agent] = spawned.values();
	if (agent) {
		const description = agent.description ? flattenLine(sanitizeText(agent.description)).trim() : "";
		return description || formatTaskId(agent.id);
	}
	if (!args) return undefined;
	const items = Array.isArray(args.tasks) ? args.tasks : [];
	if (items.length > 1) return formatCount("agent", items.length);
	const single: Partial<TaskItem> = items[0] ?? args;
	const name = typeof single.name === "string" ? single.name.trim() : "";
	if (name) return formatTaskId(name);
	const brief = taskFirstLine(taskPreviewText(single.task, single.taskFile));
	return brief ? previewLine(brief, SUBJECT_PREVIEW_WIDTH) : undefined;
}

/** Header status line shared by every task card state. */
function taskStatusLine(
	icon: ToolUIStatus,
	args: Partial<TaskParams> | undefined,
	details?: TaskToolDetails,
): StatusLineOptions {
	return {
		icon,
		title: "Task",
		description: taskSubject(args, details),
		badge: args?.isolated === true ? { label: "isolated", color: "muted" } : undefined,
	};
}

/** Dim `⟨agent⟩` badge for a non-default agent type; empty for the generic worker. */
export function agentTypeBadge(agent: string | undefined, theme: Theme): string {
	const trimmed = agent?.trim();
	if (!trimmed || trimmed === "task") return "";
	return ` ${theme.fg("dim", `${theme.format.bracketLeft}${trimmed}${theme.format.bracketRight}`)}`;
}

/**
 * Render the call preview lines for the single spawned agent. The
 * args stream in token by token, so every field access is defensive.
 */
function renderTaskCallLines(args: Partial<TaskParams> | undefined, theme: Theme): string[] {
	if (!args) return [];
	const bullet = formatStatusIcon("pending", theme);
	const lines: string[] = [];

	const rawName = typeof args.name === "string" ? args.name.trim() : "";
	const idLabel = rawName ? formatTaskId(rawName) : "";
	// The flat form's brief is the card's prompt block; only a task file needs a row preview.
	const brief = typeof args.task === "string" ? "" : taskFirstLine(taskPreviewText(args.task, args.taskFile));
	if (idLabel || brief) {
		let line = `${bullet} ${theme.fg("accent", theme.bold(idLabel || "agent"))}`;
		if (brief) {
			line += `${theme.fg("accent", ":")} ${theme.fg("muted", previewLine(brief, 64))}`;
		}
		line += agentTypeBadge(args.agent, theme);
		lines.push(line);
	}
	lines.push(...renderTaskItemLines(args.tasks, theme));
	return lines;
}

/**
 * Agent rows shown per collapsed task list; the rest fold into a single
 * `… N more agents` summary line (expand uncaps).
 */
const COLLAPSED_AGENT_LIMIT = 4;

/**
 * Render the per-item list (`name` + `task` brief) for a batch call's
 * streaming preview. The args stream in token by token, so the array grows
 * over time and trailing entries may be partially parsed — every field access
 * is defensive.
 */
function renderTaskItemLines(tasks: TaskItem[] | undefined, theme: Theme): string[] {
	if (!Array.isArray(tasks) || tasks.length === 0) return [];

	const bullet = formatStatusIcon("pending", theme);
	const cap = Math.min(tasks.length, COLLAPSED_AGENT_LIMIT);
	const lines: string[] = [];
	for (let i = 0; i < cap; i++) {
		const item = tasks[i] as Partial<TaskItem> | undefined;
		const rawName = typeof item?.name === "string" ? item.name.trim() : "";
		const idLabel = rawName ? formatTaskId(rawName) : `#${i + 1}`;
		let line = `${bullet} ${theme.fg("accent", theme.bold(idLabel))}`;
		const brief = taskFirstLine(taskPreviewText(item?.task, item?.taskFile));
		if (brief) {
			line += `${theme.fg("accent", ":")} ${theme.fg("muted", previewLine(brief, 64))}`;
		}
		line += agentTypeBadge(item?.agent, theme);
		if (item?.isolated === true) {
			line += ` ${formatBadge("isolated", "muted", theme)}`;
		}
		lines.push(line);
	}
	if (cap < tasks.length) {
		lines.push(theme.fg("dim", formatMoreItems(tasks.length - cap, "agent", theme)));
	}
	return lines;
}

type AssignmentSectionRenderer = (width: number) => ToolCardSection;

// Default output-block layout is: left border + one-cell content inset + right
// border. Render markdown at that inner width so the output block does not need
// to rewrap already-rendered assignment lines.
const ASSIGNMENT_FRAME_INSET = 3;

/**
 * Build the assignment section (the markdown brief handed to the subagent).
 * Rendered in both the streaming call preview and the result frame so the
 * brief stays visible for the whole task lifecycle — not just until the first
 * progress snapshot replaces the call view.
 */
function createAssignmentSectionRenderer(
	args: Partial<TaskParams> | undefined,
	theme: Theme,
): AssignmentSectionRenderer | undefined {
	// `renderResult` receives the raw tool args (unlike `renderCall`, which is
	// fed through `repairTaskParams`), so undo any per-field double-encoding
	// here too. The repair is idempotent on already-clean text.
	const assignment = sanitizeText(
		repairDoubleEncodedJsonString(typeof args?.task === "string" ? args.task : ""),
	).trim();
	if (!assignment) return undefined;
	return createMarkdownSectionRenderer(assignment, theme);
}

/**
 * Build the shared-context section (the `# Goal / # Contract` background a
 * batch call hands every subagent). Rendered like the assignment brief so the
 * shared background stays visible for the whole task lifecycle.
 */
function createContextSectionRenderer(
	args: Partial<TaskParams> | undefined,
	theme: Theme,
): AssignmentSectionRenderer | undefined {
	const context = sanitizeText(
		repairDoubleEncodedJsonString(typeof args?.context === "string" ? args.context : ""),
	).trim();
	if (!context) return undefined;
	return createMarkdownSectionRenderer(context, theme);
}

function createMarkdownSectionRenderer(text: string, theme: Theme): AssignmentSectionRenderer {
	const markdown = new Markdown(text, 0, 0, getMarkdownTheme(), {
		color: line => theme.fg("muted", line),
	});
	return width => ({ content: markdown.render(Math.max(1, width - ASSIGNMENT_FRAME_INSET)) });
}

/**
 * Render the tool call arguments.
 */
export function renderCall(args: TaskParams, options: TaskRenderOptions, theme: Theme): Component {
	const icon: ToolUIStatus = options.executionStarted ? "running" : "pending";
	const status = taskStatusLine(icon, args);
	const assignmentSection = createAssignmentSectionRenderer(args, theme);
	const contextSection = createContextSectionRenderer(args, theme);
	// The call preview only surfaces the dispatched agents while the args
	// stream in. Once a result snapshot exists, `renderResult` draws them (and
	// the brief) itself.
	const hasResult = options.renderContext?.hasResult === true;
	const callLines = hasResult ? [] : renderTaskCallLines(args, theme);
	if (hasResult || !(contextSection || assignmentSection)) {
		return plainToolCard(theme, () => ({ status, body: callLines, phase: icon }));
	}
	return framedToolCard(theme, ({ width }) => ({
		status,
		// Mirror renderResult's layout (context, assignment, then the agent
		// list) so the streaming preview grows append-only and rows do not
		// jump when the first progress snapshot replaces the call view.
		sections: taskSections(width, [contextSection, assignmentSection], callLines),
		phase: icon,
	}));
}

/**
 * Frame sections: the markdown prompt blocks, then the agent rows. Each
 * section after the first opens with a section bar, so the prompt and the
 * agents are divided inside one frame (never a bar right under the top border).
 */
function taskSections(
	width: number,
	prompts: readonly (AssignmentSectionRenderer | undefined)[],
	rows: readonly string[],
): ToolCardSection[] {
	const sections: ToolCardSection[] = [];
	for (const prompt of prompts) {
		if (prompt) sections.push({ ...prompt(width), separator: sections.length > 0 });
	}
	if (rows.length > 0) sections.push({ content: rows, separator: sections.length > 0 });
	return sections;
}

function truncateTaskRow(text: string, width: number, ellipsis?: ""): string {
	return Number.isFinite(width) ? truncateToWidth(text, width, ellipsis) : text;
}

function renderDescriptionLines(description: string, prefix: string, width: number, theme: Theme): string[] {
	if (!Number.isFinite(width)) return description.split("\n").map(line => `${prefix}${theme.fg("dim", line)}`);
	const boundedPrefix = truncateToWidth(prefix, Math.max(0, width - 1), "");
	const contentWidth = Math.max(1, width - visibleWidth(boundedPrefix));
	return wrapTextWithAnsi(description, contentWidth).map(line => `${boundedPrefix}${theme.fg("dim", line)}`);
}

/** `routed:` note from a `before_subagent_spawn` model replacement; empty when unrouted. */
function renderRouteLine(route: string | undefined, continuePrefix: string, maxWidth: number, theme: Theme): string[] {
	if (!route) return [];
	return [
		truncateTaskRow(
			`${continuePrefix}${theme.fg("dim", `routed: ${replaceTabs(sanitizeText(route))}`)}`,
			maxWidth,
			"",
		),
	];
}

/** A tool call's own intent, else its argument, with home paths shortened as the subagent HUD does. */
function toolCallDetail(intent: string | undefined, args: string | undefined, argsKey: string | undefined): string {
	return intent ? shortenEmbeddedPaths(intent) : shortenToolArgumentPaths(args ?? "", argsKey);
}

/** Inputs shared by the per-agent row renderers and the nested task trees below them. */
interface AgentRowContext {
	expanded: boolean;
	theme: Theme;
	/** Live spinner frame; undefined draws static icons. */
	spinnerFrame?: number;
	/** Progress rows render static gray; see {@link TaskRenderContext.frozen}. */
	frozen?: boolean;
	/** Wall clock for time-derived rows; see {@link TaskRenderContext.nowMs}. */
	nowMs?: number;
	maxWidth?: number;
	/** Nested snapshots on the current branch, for cycle detection. */
	seenNestedTasks?: WeakSet<object>;
	nestedDepth?: number;
	/** The card's prompt block already shows this agent's assignment. */
	assignmentShown?: boolean;
}

/** One agent's row leads within its list. */
interface AgentRowOptions extends AgentRowContext {
	/** Lead of the agent row: a tree connector when nested, else empty. */
	prefix: string;
	/** Lead of the rows under the agent row. */
	continuePrefix: string;
}

/**
 * Render streaming progress for a single agent.
 */
function renderAgentProgress(progress: AgentProgress, options: AgentRowOptions): string[] {
	const {
		prefix,
		continuePrefix,
		expanded,
		theme,
		spinnerFrame,
		frozen = false,
		seenNestedTasks,
		nestedDepth = 0,
		nowMs = Date.now(),
		maxWidth = Number.POSITIVE_INFINITY,
		assignmentShown = false,
	} = options;
	const lines: string[] = [];

	const fullDescription = progress.description ? replaceTabs(sanitizeText(progress.description)).trim() : undefined;
	let statusBadge: string | undefined;
	if (progress.retryState && progress.status === "running") {
		statusBadge = ` ${formatBadge("retrying", "warning", theme)}`;
	} else if (progress.retryFailure && (progress.status === "failed" || progress.status === "aborted")) {
		statusBadge = ` ${formatBadge("rate-limited", "error", theme)}`;
	}
	const row = renderAgentTreeRow(
		{
			presentation: "task",
			status: progress.status,
			prefix,
			id: formatTaskId(progress.id),
			width: maxWidth,
			model: progress.resolvedModelIdentity ?? progress.resolvedModel,
			thinkingLevel: progress.resolvedThinkingLevel,
			advisor: progress.advisor,
			spinnerFrame,
			frozen,
			roleBadge: agentTypeBadge(progress.agent, theme),
			statusBadge,
			description: fullDescription,
			preview:
				progress.status === "running" && !fullDescription
					? ` ${theme.fg("muted", previewLine(sanitizeText(progress.assignment ?? progress.task), 40))}`
					: undefined,
			stats: progress.status === "running" || progress.status === "completed" ? progress : undefined,
			completionPercent: progress.completionPercent,
		},
		theme,
	);
	lines.push(row.line);
	if (fullDescription && !row.descriptionShown) {
		lines.push(...renderDescriptionLines(fullDescription, continuePrefix, maxWidth, theme));
	}
	lines.push(...renderRouteLine(progress.resolvedModelRoute, continuePrefix, maxWidth, theme));

	if (!assignmentShown) {
		lines.push(...renderTaskSection(progress.assignment ?? progress.task, continuePrefix, expanded, theme, maxWidth));
	}

	// Current tool (if running) or most recent completed tool
	if (progress.status === "running") {
		if (progress.stage) {
			lines.push(
				truncateTaskRow(
					`${continuePrefix}${theme.fg("muted", replaceTabs(sanitizeText(progress.stage)))}`,
					maxWidth,
					"",
				),
			);
		}
		if (progress.currentTool) {
			const runningIcon = formatStatusIcon("running", theme);
			let toolLine = `${continuePrefix}${runningIcon} ${theme.fg("muted", sanitizeText(progress.currentTool))}`;
			const toolDetail = toolCallDetail(
				progress.currentToolIntent,
				progress.currentToolArgs,
				progress.currentToolArgsKey,
			);
			if (toolDetail) {
				toolLine += `: ${theme.fg("dim", previewLine(sanitizeText(toolDetail), 40))}`;
			}
			if (progress.currentToolStartMs) {
				const elapsed = nowMs - progress.currentToolStartMs;
				if (elapsed > 5000) {
					toolLine += `${theme.sep.dot}${theme.fg("warning", formatDuration(elapsed))}`;
				}
			}
			lines.push(toolLine);
		} else if (progress.recentTools.length > 0) {
			// Show most recent completed tool when idle between tools
			const recent = progress.recentTools[0];
			const recentIcon = formatStatusIcon(recent.isError ? "error" : "success", theme);
			let toolLine = `${continuePrefix}${recentIcon} ${theme.fg("dim", sanitizeText(recent.tool))}`;
			const toolDetail = toolCallDetail(recent.intent, recent.args, recent.argsKey);
			if (toolDetail) {
				toolLine += `: ${theme.fg("dim", previewLine(sanitizeText(toolDetail), 40))}`;
			}
			lines.push(toolLine);
		}
	}

	// Retry detail line: surface why the subagent is paused and roughly how
	// long until the next attempt. Without this, the parent UI would just
	// keep spinning while a child sleeps on a 3-hour provider rate-limit.
	if (progress.retryState && progress.status === "running") {
		const remainingMs = Math.max(0, progress.retryState.startedAtMs + progress.retryState.delayMs - nowMs);
		const waitLabel = remainingMs > 0 ? `in ${formatDuration(remainingMs)}` : "now";
		const summary =
			`retrying ${progress.retryState.attempt}/${progress.retryState.maxAttempts} ${waitLabel}: ` +
			previewLine(sanitizeText(progress.retryState.errorMessage), 60);
		lines.push(`${continuePrefix}${formatStatusIcon("warning", theme)} ${theme.fg("warning", summary)}`);
	} else if (progress.retryFailure && progress.status !== "running") {
		const attempts = formatCount("attempt", progress.retryFailure.attempt);
		const reason = previewLine(sanitizeText(progress.retryFailure.errorMessage), 80);
		const summary = `auto-retry gave up after ${attempts}: ${reason}`;
		lines.push(`${continuePrefix}${formatStatusIcon("error", theme)} ${formatErrorText(summary, theme)}`);
	}

	// Render extracted tool data inline (e.g., review findings)
	if (progress.extractedToolData) {
		// For completed tasks, render review verdicts assembled from incremental
		// yield sections.
		if (progress.status === "completed") {
			const yieldValue = progress.extractedToolData.yield;
			const reviewLines = memoBySnapshot(
				completedReviewMemo,
				yieldValue,
				[continuePrefix, expanded, theme],
				(): string[] | null => {
					const completeData = normalizeYieldData(yieldValue);
					const incrementalReview = extractIncrementalReviewResult(completeData);
					if (incrementalReview) {
						return renderReviewResult(
							incrementalReview.summary,
							incrementalReview.findings,
							continuePrefix,
							expanded,
							theme,
						);
					}
					const reviewData = completeData
						.map(c => c.data as SubmitReviewDetails)
						.filter(d => d && typeof d === "object" && "overall_correctness" in d);
					if (reviewData.length === 0) return null;
					return renderReviewResult(reviewData[reviewData.length - 1], [], continuePrefix, expanded, theme);
				},
			);
			if (reviewLines) {
				lines.push(...reviewLines);
				return lines; // Review result handles its own rendering
			}
		}

		for (const toolName in progress.extractedToolData) {
			const dataArray = progress.extractedToolData[toolName];
			if (toolName === "yield") {
				lines.push(
					...memoBySnapshot(yieldSectionsMemo, dataArray, [continuePrefix, expanded, theme], () =>
						renderTypedYieldSections(dataArray, continuePrefix, expanded, theme),
					),
				);
				continue;
			}

			// Nested `task` data has its own dedicated tree renderer below that
			// also merges in the in-flight snapshot — skip the generic inline
			// path so we don't render twice.
			if (toolName === "task") continue;

			const handler = getSubprocessToolRenderer(toolName);
			if (handler?.renderInline) {
				const displayCount = expanded ? (dataArray as unknown[]).length : 3;
				const recentData = (dataArray as unknown[]).slice(-displayCount);
				for (const data of recentData) {
					const component = handler.renderInline(data, theme);
					if (component instanceof Text) {
						lines.push(`${continuePrefix}${component.getText()}`);
					}
				}
				if ((dataArray as unknown[]).length > displayCount) {
					lines.push(
						`${continuePrefix}${theme.fg(
							"dim",
							formatMoreItems((dataArray as unknown[]).length - displayCount, "item", theme),
						)}`,
					);
				}
			}
		}
	}

	// Nested `task` tree: completed sub-calls from `extractedToolData.task` plus
	// the in-flight snapshot (if any). Surfacing this in the live view means
	// the user sees deep-tree progress without waiting for this agent to finish
	// its own turn.
	const completedTaskCalls = (progress.extractedToolData?.task as TaskToolDetails[] | undefined) ?? [];
	const inflight = progress.inflightTaskDetails;
	if (completedTaskCalls.length > 0 || inflight) {
		const snapshots = inflight ? [...completedTaskCalls, inflight] : completedTaskCalls;
		const nestedLines = renderNestedTasks(
			snapshots,
			{
				expanded,
				theme,
				spinnerFrame,
				frozen,
				nowMs,
				seenNestedTasks,
				nestedDepth,
				maxWidth: Math.max(0, maxWidth - visibleWidth(continuePrefix)),
			},
			true,
		);
		for (const line of nestedLines) {
			lines.push(`${continuePrefix}${line}`);
		}
	}

	// Expanded view: recent output and tools
	if (expanded && progress.status === "running") {
		const previewRows = previewWindowRows();
		lines.push(
			...memoBySnapshot(
				recentOutputMemo,
				progress.recentOutput,
				[continuePrefix, theme, previewRows, maxWidth],
				() => {
					const output = capPreviewLines(
						sanitizeRecentOutput([...progress.recentOutput].reverse().join("\n")).split("\n"),
						theme,
						{
							max: previewRows,
							expandHint: false,
						},
					).join("\n");
					return renderOutputSection(output, continuePrefix, expanded, theme, 2, previewRows, undefined, maxWidth);
				},
			),
		);
	}

	return lines;
}

/**
 * Render review result with combined verdict + findings in tree structure.
 */
function renderReviewResult(
	summary: SubmitReviewDetails,
	findings: FindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	// Verdict line
	const verdictColor = summary.overall_correctness === "correct" ? "success" : "error";
	const verdictIcon = formatStatusIcon(summary.overall_correctness === "correct" ? "success" : "error", theme);
	lines.push(
		`${continuePrefix}Patch is ${theme.fg(verdictColor, summary.overall_correctness)} ${verdictIcon} ${theme.fg(
			"dim",
			`(${(summary.confidence * 100).toFixed(0)}% confidence)`,
		)}`,
	);

	// Explanation preview (first ~80 chars when collapsed, full when expanded)
	if (summary.explanation) {
		if (expanded) {
			lines.push(`${continuePrefix}${theme.fg("dim", "Summary")}`);
			const explanationLines = sanitizeText(summary.explanation).split("\n");
			for (const line of explanationLines) {
				lines.push(`${continuePrefix}  ${theme.fg("dim", replaceTabs(line))}`);
			}
		} else {
			// Preview: first sentence or ~100 chars (flatten tabs/newlines first)
			const flat = replaceTabs(sanitizeText(summary.explanation)).replace(/[\r\n]+/g, " ");
			const firstSentence = flat.split(/[.!?]/)[0].trim();
			const preview = truncateToWidth(`${firstSentence}.`, 100);
			lines.push(`${continuePrefix}${theme.fg("dim", preview)}`);
		}
	}

	// Findings summary + list
	lines.push(`${continuePrefix}${formatFindingSummary(findings, theme)}`);

	if (findings.length > 0) {
		lines.push(...renderFindings(findings, continuePrefix, expanded, theme));
	}

	return lines;
}

/**
 * Render review findings list.
 */
function renderFindings(findings: FindingDetails[], continuePrefix: string, expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];

	// Sort by priority (lower = more severe) when collapsed to show most important first
	const sortedFindings = expanded
		? findings
		: [...findings].sort((a, b) => getPriorityInfo(a.priority).ord - getPriorityInfo(b.priority).ord);
	const displayCount = expanded ? sortedFindings.length : Math.min(3, sortedFindings.length);

	for (let i = 0; i < displayCount; i++) {
		const finding = sortedFindings[i];
		const isLastFinding = i === displayCount - 1 && (expanded || sortedFindings.length <= 3);
		const findingPrefix = isLastFinding ? theme.tree.last : theme.tree.branch;
		const findingContinue = isLastFinding ? "   " : `${theme.tree.vertical}  `;

		const { color } = getPriorityInfo(finding.priority);
		const rawTitle = sanitizeText(finding.title?.replace(/^\[P\d\]\s*/, "") ?? "Untitled");
		const titleText = replaceTabs(rawTitle).replace(/[\r\n]+/g, " ");
		const loc = `${path.basename(sanitizeText(finding.file_path || "<unknown>"))}:${finding.line_start}`;

		lines.push(
			`${continuePrefix}${findingPrefix} ${theme.fg(color, `[${finding.priority}]`)} ${titleText} ${theme.fg("dim", loc)}`,
		);

		// Show body when expanded
		if (expanded && finding.body) {
			// Wrap body text
			const bodyLines = sanitizeText(finding.body).split("\n");
			for (const bodyLine of bodyLines) {
				lines.push(`${continuePrefix}${findingContinue}${theme.fg("dim", replaceTabs(bodyLine))}`);
			}
		}
	}

	if (!expanded && findings.length > 3) {
		lines.push(`${continuePrefix}${theme.fg("dim", formatMoreItems(findings.length - 3, "finding", theme))}`);
	}

	return lines;
}

/**
 * Render final result for a single agent.
 */
function renderAgentResult(result: SingleResult, options: AgentRowOptions): string[] {
	const {
		prefix,
		continuePrefix,
		expanded,
		theme,
		seenNestedTasks,
		nestedDepth = 0,
		maxWidth = Number.POSITIVE_INFINITY,
		assignmentShown = false,
	} = options;
	const lines: string[] = [];

	const { warning: missingCompleteWarning, rest: outputWithoutWarning } = extractMissingYieldWarning(result.output);
	const aborted = result.aborted ?? false;
	const mergeFailed = !aborted && result.exitCode === 0 && !!result.error;
	const success = !aborted && result.exitCode === 0 && !result.error;
	const needsWarning = Boolean(missingCompleteWarning) && success;
	let status: AgentTreeRowOptions["status"] = success ? "completed" : "failed";
	if (needsWarning || mergeFailed) status = "warning";
	if (aborted) status = "aborted";

	const fullDescription = result.description ? replaceTabs(sanitizeText(result.description)).trim() : undefined;
	let statusBadge = mergeFailed ? ` ${formatBadge("merge failed", "warning", theme)}` : "";
	if (result.truncated) statusBadge += ` ${formatBadge("truncated", "warning", theme)}`;
	const row = renderAgentTreeRow(
		{
			presentation: "task",
			status,
			prefix,
			id: formatTaskId(result.id),
			width: maxWidth,
			model: result.resolvedModelIdentity ?? result.resolvedModel,
			thinkingLevel: result.resolvedThinkingLevel,
			advisor: result.advisor,
			roleBadge: agentTypeBadge(result.agent, theme),
			statusBadge,
			description: fullDescription,
			stats: {
				requests: result.requests,
				contextTokens: result.contextTokens,
				contextWindow: result.contextWindow,
				cost: result.usage?.cost.total ?? 0,
			},
			durationMs: result.durationMs,
		},
		theme,
	);

	lines.push(row.line);
	if (fullDescription && !row.descriptionShown) {
		lines.push(...renderDescriptionLines(fullDescription, continuePrefix, maxWidth, theme));
	}
	lines.push(...renderRouteLine(result.resolvedModelRoute, continuePrefix, maxWidth, theme));

	if (!assignmentShown) {
		lines.push(...renderTaskSection(result.assignment ?? result.task, continuePrefix, expanded, theme, maxWidth));
	}

	if (aborted && result.abortReason) {
		lines.push(
			`${continuePrefix}${theme.fg(
				"dim",
				clipCollapsed(flattenLine(sanitizeText(result.abortReason)), 80, expanded),
			)}`,
		);
	}
	// Check for review result from incremental yield sections.
	// `normalizeYieldData` guards against a stray non-array `yield` slot —
	// optional chaining on `.map` only short-circuits on null/undefined and
	// would otherwise crash the renderer with `TypeError: completeData?.map
	// is not a function` when the slot is a plain object (see issue #1987).
	const completeData = normalizeYieldData(result.extractedToolData?.yield);
	const incrementalReview = extractIncrementalReviewResult(completeData);

	if (incrementalReview) {
		lines.push(
			...renderReviewResult(incrementalReview.summary, incrementalReview.findings, continuePrefix, expanded, theme),
		);
		return lines;
	}

	// Extract review verdict from legacy yield summary objects if present.
	const reviewData = completeData
		.map(c => c.data as SubmitReviewDetails)
		.filter(d => d && typeof d === "object" && "overall_correctness" in d);
	const submitReviewData = reviewData.length > 0 ? reviewData : undefined;

	if (submitReviewData) {
		const summary = submitReviewData[submitReviewData.length - 1];
		const findings: FindingDetails[] = [];
		lines.push(...renderReviewResult(summary, findings, continuePrefix, expanded, theme));
		return lines;
	}

	// Check for extracted tool data with custom renderers (skip review tools)
	let hasCustomRendering = false;
	const deferredToolLines: string[] = [];
	if (result.extractedToolData) {
		for (const toolName in result.extractedToolData) {
			const dataArray = result.extractedToolData[toolName];
			if (toolName === "yield") {
				const yieldLines = renderTypedYieldSections(dataArray, continuePrefix, expanded, theme);
				if (yieldLines.length > 0) {
					hasCustomRendering = true;
					lines.push(...yieldLines);
				}
				continue;
			}

			const isTaskTool = toolName === "task";
			if (isTaskTool && (dataArray as unknown[]).length > 0) {
				const nestedLines = renderNestedTasks(
					dataArray as TaskToolDetails[],
					{
						expanded,
						theme,
						seenNestedTasks,
						nestedDepth,
						maxWidth: Math.max(0, maxWidth - visibleWidth(continuePrefix)),
					},
					false,
				);
				for (const line of nestedLines) {
					deferredToolLines.push(`${continuePrefix}${line}`);
				}
				continue;
			}

			const handler = getSubprocessToolRenderer(toolName);
			if (handler?.renderFinal && (dataArray as unknown[]).length > 0) {
				const component = handler.renderFinal(dataArray as unknown[], theme, expanded);
				const target = lines;
				if (!isTaskTool) {
					hasCustomRendering = true;
					target.push(`${continuePrefix}${theme.fg("dim", `Tool: ${toolName}`)}`);
				}
				if (component instanceof Text) {
					// Prefix each line with continuePrefix
					const text = component.getText();
					for (const line of text.split("\n")) {
						target.push(`${continuePrefix}${line}`);
					}
				} else if (component instanceof Container) {
					// For containers, render each child
					for (const child of (component as Container).children) {
						if (child instanceof Text) {
							target.push(`${continuePrefix}${child.getText()}`);
						}
					}
				}
			}
		}
	}

	if (hasCustomRendering && missingCompleteWarning) {
		lines.push(
			`${continuePrefix}${formatStatusIcon("warning", theme)} ${theme.fg(
				"dim",
				clipCollapsed(sanitizeText(missingCompleteWarning), 80, expanded),
			)}`,
		);
	}

	// Fallback to output preview if no custom rendering
	if (!hasCustomRendering) {
		lines.push(
			...renderOutputSection(
				outputWithoutWarning,
				continuePrefix,
				expanded,
				theme,
				3,
				12,
				missingCompleteWarning,
				maxWidth,
			),
		);
	}

	if (deferredToolLines.length > 0) {
		lines.push(...deferredToolLines);
	}

	// Artifact rows: paths shortened (home → `~`), tabs expanded, and width-bounded
	// like every other rendered line; the full paths live in the model-facing summary.
	// A nested-only run still carries its (empty) root patch path, so hide that
	// row when the runner reports no root changes — same as the model summary.
	if (result.patchPath && result.hasRootChanges !== false && !aborted && result.exitCode === 0) {
		lines.push(
			`${continuePrefix}${theme.fg("dim", truncateToWidth(`Patch: ${replaceTabs(shortenPath(result.patchPath))}`, TRUNCATE_LENGTHS.CONTENT))}`,
		);
	} else if (result.branchName && !aborted && result.exitCode === 0) {
		lines.push(
			`${continuePrefix}${theme.fg("dim", truncateToWidth(`Branch: ${replaceTabs(sanitizeText(result.branchName))}`, TRUNCATE_LENGTHS.CONTENT))}`,
		);
	}
	if (!aborted && result.exitCode === 0) {
		for (const nestedPath of result.nestedPatchPaths ?? []) {
			lines.push(
				`${continuePrefix}${theme.fg("dim", truncateToWidth(`Nested patch: ${replaceTabs(shortenPath(nestedPath))}`, TRUNCATE_LENGTHS.CONTENT))}`,
			);
		}
	}

	// Error message
	if (result.error && (!success || mergeFailed) && (!aborted || result.error !== result.abortReason)) {
		const message = clipCollapsed(flattenLine(sanitizeText(result.error)), 70, expanded);
		lines.push(
			...hangingRows(
				continuePrefix,
				// Not `formatErrorText`: it caps the text, and an expanded row must reveal all of it.
				theme.fg(mergeFailed ? "warning" : "error", message),
				maxWidth,
			),
		);
	}

	return lines;
}

/**
 * Order live progress entries so finished agents render first — sorted by
 * runtime ascending, matching {@link orderResultsForDisplay} — while
 * unfinished (pending/running) ones stay pinned at the bottom in dispatch
 * order. Because a finished agent's runtime is fixed, finalization renders
 * the same order and rows never reshuffle.
 */
function orderProgressForDisplay(progress: readonly AgentProgress[]): AgentProgress[] {
	const finished: AgentProgress[] = [];
	const unfinished: AgentProgress[] = [];
	for (const p of progress) {
		(p.status === "pending" || p.status === "running" ? unfinished : finished).push(p);
	}
	finished.sort((a, b) => a.durationMs - b.durationMs || a.index - b.index);
	return finished.concat(unfinished);
}

/**
 * Order finalized results by runtime ascending (tie-break: dispatch index) so
 * the finalized list matches the live-progress order produced by
 * {@link orderProgressForDisplay}.
 */
function orderResultsForDisplay(results: readonly SingleResult[]): SingleResult[] {
	return [...results].sort((a, b) => a.durationMs - b.durationMs || a.index - b.index);
}

/**
 * Truncation marker for progress rows folded away by the collapsed cap:
 * per-status counts, e.g. `… 21 more agents (18 pending · 3 done)`.
 */
function formatHiddenProgressMarker(hidden: readonly AgentProgress[], theme: Theme): string {
	const counts: Record<AgentProgress["status"], number> = {
		pending: 0,
		running: 0,
		completed: 0,
		failed: 0,
		aborted: 0,
	};
	for (const p of hidden) counts[p.status]++;
	const parts: string[] = [];
	if (counts.completed > 0) parts.push(theme.fg("dim", `${counts.completed} done`));
	if (counts.running > 0) parts.push(theme.fg("dim", `${counts.running} running`));
	if (counts.pending > 0) parts.push(theme.fg("dim", `${counts.pending} pending`));
	if (counts.failed > 0) parts.push(theme.fg("error", `${counts.failed} failed`));
	if (counts.aborted > 0) parts.push(theme.fg("error", `${counts.aborted} aborted`));
	const breakdown =
		parts.length > 0
			? `${theme.fg("dim", " (")}${parts.join(theme.fg("dim", theme.sep.dot))}${theme.fg("dim", ")")}`
			: "";
	return `${theme.fg("dim", formatMoreItems(hidden.length, "agent", theme))}${breakdown}`;
}

/**
 * Pick the agent rows that stay visible when a finalized batch is collapsed:
 * problem rows (aborted/failed/merge-failed) claim slots first so they are
 * never folded away, then fastest finishers fill the remainder. The pick is
 * filtered out of the display order, so visible rows keep the expanded layout.
 */
function selectCollapsedResults(ordered: readonly SingleResult[]): readonly SingleResult[] {
	if (ordered.length <= COLLAPSED_AGENT_LIMIT) return ordered;
	const picked = new Set<SingleResult>();
	for (const result of ordered) {
		if (picked.size >= COLLAPSED_AGENT_LIMIT) break;
		if (result.aborted || result.exitCode !== 0 || result.error) picked.add(result);
	}
	for (const result of ordered) {
		if (picked.size >= COLLAPSED_AGENT_LIMIT) break;
		picked.add(result);
	}
	return ordered.filter(result => picked.has(result));
}

/** Whether `line` opens the trailing notices of a task result: system notifications or the patch summary. */
function isResultNoticeLine(line: string): boolean {
	return (
		line.includes("<system-notification>") ||
		line.startsWith("Applied patches:") ||
		line.startsWith("No changes to apply.")
	);
}

/**
 * Render the tool result.
 */
export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails; isError?: boolean },
	options: TaskRenderOptions,
	theme: Theme,
	args?: TaskParams,
): Component {
	const fallbackText = result.content.find(c => c.type === "text")?.text ?? "";
	const details = result.details;
	const hasRows = Boolean(details && (details.results.length > 0 || (details.progress?.length ?? 0) > 0));

	// Nothing spawned: a message-only result is a flush card.
	if (!details || !hasRows) {
		const errored = result.isError === true;
		const text = fallbackText.trim();
		let icon: "success" | "warning" | "running" | "error" = text ? "success" : "warning";
		if (options.isPartial) icon = "running";
		if (errored) icon = "error";
		const status = taskStatusLine(icon, args, details);
		if (icon === "warning") status.meta = [formatCount("agent", 0)];
		const body = text
			? text.split("\n").map(line => (errored ? formatErrorText(line, theme) : theme.fg("dim", line)))
			: [];
		return plainToolCard(theme, () => ({ status, body, phase: icon }));
	}

	// Single pass over details.results derives the header status and the
	// footer counts/totals; the card rebuilds on every spinner frame.
	let abortedCount = 0;
	let failCount = 0;
	let mergeFailedCount = 0;
	let successCount = 0;
	let requestTotal = 0;
	for (const r of details.results) {
		requestTotal += r.requests ?? 0;
		if (r.aborted) abortedCount++;
		else if (r.exitCode !== 0) failCount++;
		else if (r.error) mergeFailedCount++;
		else successCount++;
	}
	const isError = abortedCount > 0 || failCount > 0;
	const mergeFailed = mergeFailedCount > 0;
	let icon: "success" | "warning" | "running" | "error" = isError ? "error" : mergeFailed ? "warning" : "success";
	if (options.isPartial) icon = "running";
	const status = taskStatusLine(icon, args, details);
	const assignmentSection = createAssignmentSectionRenderer(args, theme);
	const contextSection = createContextSectionRenderer(args, theme);

	// Fallback text is fixed for this snapshot; derive its trailing notice rows
	// once instead of re-splitting on every spinner frame.
	const fallbackExtraLines: string[] = [];
	if (fallbackText.trim()) {
		const summaryLines = fallbackText.split("\n");
		const markerIndex = summaryLines.findIndex(isResultNoticeLine);
		if (markerIndex >= 0) {
			for (let i = markerIndex; i < summaryLines.length; i++) {
				const line = summaryLines[i];
				if (line.trim()) fallbackExtraLines.push(theme.fg("dim", line));
			}
		}
	}

	return framedToolCard(theme, ({ width, contentWidth }) => {
		const { expanded, isPartial, spinnerFrame } = options;
		const frozen = options.renderContext?.frozen === true;
		const nowMs = options.renderContext?.nowMs ?? Date.now();
		const lines: string[] = [];
		const footer: string[] = [];
		const assignmentShown = assignmentSection !== undefined;
		const rowOptions: AgentRowOptions = {
			prefix: "",
			continuePrefix: "  ",
			expanded,
			theme,
			maxWidth: contentWidth,
			assignmentShown,
		};
		const renderProgressRows = (progress: AgentProgress): string[] =>
			renderAgentProgress(progress, { ...rowOptions, spinnerFrame, frozen, nowMs });

		if (details.results.length === 0 && details.progress) {
			const ordered = orderProgressForDisplay(details.progress);
			// Collapsed view keeps the live edge: finished rows sort to the top of
			// the display order, so folding from the top keeps running/pending
			// agents (and their current-tool lines) visible.
			const visible = expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
			for (const progress of visible) lines.push(...renderProgressRows(progress));
			if (visible.length < ordered.length) {
				const marker = formatHiddenProgressMarker(ordered.slice(0, ordered.length - visible.length), theme);
				footer.push(`${marker} ${formatExpandHint(theme)}`);
			}
		} else {
			/** Whether Ctrl+O shows more of `res` than its collapsed rows, which clip output and summaries. */
			const resultFolds = (res: SingleResult): boolean =>
				memoBySnapshot(
					agentResultFoldsMemo,
					res,
					[theme, contentWidth, isFeedModelBadgeEnabled(), assignmentShown],
					() => {
						const rows = (rowsExpanded: boolean) =>
							renderAgentResult(res, { ...rowOptions, expanded: rowsExpanded });
						return rows(false).join("\n") !== rows(true).join("\n");
					},
				);

			const ordered = orderResultsForDisplay(details.results);
			const visible = expanded ? ordered : selectCollapsedResults(ordered);
			for (const res of visible) {
				lines.push(
					...memoBySnapshot(agentResultMemo, res, [expanded, theme, contentWidth, isFeedModelBadgeEnabled()], () =>
						renderAgentResult(res, rowOptions),
					),
				);
			}

			// Mixed blocking+async call: async spawns never land in `results`
			// (their payloads deliver through jobs); keep their rows visible
			// beside the finalized inline results.
			if (details.progress) {
				const resultIds = new Set<string>();
				for (const res of details.results) resultIds.add(res.id);
				const supplemental = orderProgressForDisplay(
					details.progress.filter(progress => !resultIds.has(progress.id)),
				);
				for (const progress of supplemental) lines.push(...renderProgressRows(progress));
			}

			if (abortedCount > 0) footer.push(theme.fg("error", `${abortedCount} aborted`));
			if (successCount > 0) footer.push(theme.fg("success", `${successCount} succeeded`));
			if (mergeFailedCount > 0) footer.push(theme.fg("warning", `${mergeFailedCount} merge failed`));
			if (failCount > 0) footer.push(theme.fg("error", `${failCount} failed`));
			if (requestTotal > 0) footer.push(theme.fg("dim", `${formatNumber(requestTotal)} req`));
			footer.push(theme.fg("dim", formatDuration(details.totalDurationMs)));
			if (visible.length < ordered.length) {
				footer.push(formatMoreRow(ordered.length - visible.length, "agent", theme, { expanded }));
			} else if (!expanded && visible.some(resultFolds)) {
				footer.push(formatExpandHint(theme));
			}
		}

		for (const line of fallbackExtraLines) lines.push(line);
		const footerParts = footer.filter(part => part.length > 0);
		return {
			status,
			footerMeta: footerParts.length > 0 ? footerParts.join(theme.fg("dim", theme.sep.dot)) : undefined,
			sections: taskSections(width, [contextSection, assignmentSection], lines),
			phase: isPartial ? "partial" : icon,
		};
	});
}

/** Tests whether a persisted tool result carries a task snapshot. */
export function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"results" in (value as TaskToolDetails) &&
		Array.isArray((value as TaskToolDetails).results)
	);
}

/**
 * Subagent ids visible on a task tool card, for click-to-focus hit-testing.
 * Reads `progress[]` (in-flight) and `results[]` (settled) defensively — card
 * details arrive as `unknown` through the tool-result pipeline — and recurses
 * into the same nested snapshots the card renders (`extractedToolData.task`
 * details plus the in-flight snapshot), so a click on a nested worker row
 * resolves to that worker instead of an outer agent. Callers intersect with
 * the live registry, which decides focusability and recency.
 */
export function taskCardAgentIds(details: unknown): string[] {
	if (typeof details !== "object" || details === null) return [];
	const ids: string[] = [];
	const seen = new Set<unknown>();
	const pushId = (item: unknown): void => {
		if (typeof item !== "object" || item === null || !("id" in item)) return;
		const id: unknown = item.id;
		if (typeof id === "string" && id.length > 0 && !ids.includes(id)) ids.push(id);
	};
	const collectDetails = (value: unknown, depth: number): void => {
		if (typeof value !== "object" || value === null || depth > MAX_NESTED_TASK_RENDER_DEPTH) return;
		if (seen.has(value)) return;
		seen.add(value);
		const record = value as { results?: unknown; progress?: unknown };
		collectList(record.results, depth);
		collectList(record.progress, depth);
	};
	const collectList = (value: unknown, depth: number): void => {
		if (!Array.isArray(value)) return;
		for (const item of value) {
			pushId(item);
			if (typeof item !== "object" || item === null || seen.has(item)) continue;
			seen.add(item);
			const record = item as { extractedToolData?: unknown; inflightTaskDetails?: unknown };
			const nested = record.extractedToolData;
			if (typeof nested === "object" && nested !== null && "task" in nested) {
				const tasks = (nested as { task?: unknown }).task;
				if (Array.isArray(tasks)) for (const task of tasks) collectDetails(task, depth + 1);
			}
			collectDetails(record.inflightTaskDetails, depth + 1);
		}
	};
	collectList("progress" in details ? details.progress : undefined, 0);
	collectList("results" in details ? details.results : undefined, 0);
	return ids;
}

// Nested subagent snapshots sit one or more levels below the frame border, so
// they keep tree guides to convey depth (the parent prepends its own continue
// prefix). Only the top-level agent list drops guides (the frame is its box).
function nestedMarkers(isLast: boolean, theme: Theme): { prefix: string; continuePrefix: string } {
	return {
		prefix: isLast ? theme.fg("dim", theme.tree.last) : theme.fg("dim", theme.tree.branch),
		continuePrefix: isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `,
	};
}

/** Agent rows behind tree guides; `hidden` folded agents close the branch as a `… N more agents` row. */
function nestedAgentRows<T>(
	visible: readonly T[],
	hidden: number,
	theme: Theme,
	render: (item: T, markers: { prefix: string; continuePrefix: string }) => string[],
): string[] {
	const lines = visible.flatMap((item, index) =>
		render(item, nestedMarkers(hidden === 0 && index === visible.length - 1, theme)),
	);
	if (hidden > 0) {
		lines.push(`${nestedMarkers(true, theme).prefix} ${theme.fg("dim", formatMoreItems(hidden, "agent", theme))}`);
	}
	return lines;
}

/**
 * Render `TaskToolDetails` snapshots as a tree with bounded recursion and
 * cycle detection: settled `results[]`, else (with `includeProgress`, for the
 * live view of a still-running agent) the in-flight `progress[]`.
 */
function renderNestedTasks(
	detailsList: readonly TaskToolDetails[],
	context: AgentRowContext,
	includeProgress: boolean,
): string[] {
	const { expanded, theme } = context;
	const seen = context.seenNestedTasks ?? new WeakSet<object>();
	const depth = context.nestedDepth ?? 0;
	const child: AgentRowContext = { ...context, seenNestedTasks: seen, nestedDepth: depth + 1 };
	const lines: string[] = [];
	for (const details of detailsList) {
		if (seen.has(details)) {
			lines.push(renderNestedCycleLine(theme));
			continue;
		}
		if (depth >= MAX_NESTED_TASK_RENDER_DEPTH) {
			lines.push(renderNestedDepthLimitLine(theme));
			continue;
		}
		seen.add(details);
		if (details.results && details.results.length > 0) {
			const ordered = orderResultsForDisplay(details.results);
			const visible = expanded ? ordered : selectCollapsedResults(ordered);
			lines.push(
				...nestedAgentRows(visible, ordered.length - visible.length, theme, (result, markers) =>
					renderAgentResult(result, { ...child, ...markers }),
				),
			);
		} else if (includeProgress && details.progress && details.progress.length > 0) {
			const ordered = orderProgressForDisplay(details.progress);
			const visible = expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
			lines.push(
				...nestedAgentRows(visible, ordered.length - visible.length, theme, (progress, markers) =>
					renderAgentProgress(progress, { ...child, ...markers }),
				),
			);
		}
		seen.delete(details);
	}
	return lines;
}

/** Renders settled child-task snapshots with bounded recursion and cycle detection. */
export function renderNestedTaskResults(detailsList: TaskToolDetails[], expanded: boolean, theme: Theme): string[] {
	return renderNestedTasks(detailsList, { expanded, theme }, false);
}

// =============================================================================
// Native (TSP) description: one `agent` node per subagent (§7.6)
// =============================================================================

/** Theme token for a thinking level's model-chip dot. */
function thinkingToken(level: ConfiguredThinkingLevel | undefined): string | undefined {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
		case "max":
			return "thinkingXhigh";
		default:
			return undefined;
	}
}

/** The shared batch context as one quiet line above the agents. */
function describeContext(raw: unknown): NativeNode | undefined {
	const source = typeof raw === "string" ? sanitizeText(repairDoubleEncodedJsonString(raw)) : "";
	const line = source.replace(/\s+/g, " ").trim();
	return line ? text([span(line, "muted")], { wrap: "word", lines: 2, role: "omp.tool.context" }) : undefined;
}

/** The full assignment, markdown: an agent's first expanded child and its row's hover card. */
function describeAssignment(raw: string | undefined): NativeNode | undefined {
	const source = raw ? sanitizeText(repairDoubleEncodedJsonString(raw)).trim() : "";
	return source ? md(source, { role: "omp.task.assignment" }) : undefined;
}

/** Context-window stats: the fill fraction and its `19K / 200K` label. */
function contextStats(
	tokens: number | undefined,
	window: number | undefined,
): { context?: number; contextLabel?: string } {
	if (!tokens || tokens <= 0) return {};
	if (!window || window <= 0) return { contextLabel: formatNumber(tokens) };
	return {
		context: Math.min(1, tokens / window),
		contextLabel: `${formatNumber(tokens)} / ${formatNumber(window)}`,
	};
}

/** Agent badges: `background` for async jobs, `isolated` worktrees. */
function agentBadges(background: boolean, isolated: boolean | undefined): TspAgentProps["badges"] {
	const badges: { text: string; tone?: TspTone }[] = [];
	if (background) badges.push({ text: "background" });
	if (isolated) badges.push({ text: "isolated" });
	return badges.length > 0 ? badges : undefined;
}

interface AgentDescribeState {
	readonly seen: WeakSet<object>;
	readonly nowMs: number;
	readonly expanded: boolean;
	readonly background: boolean;
	/** The host draws the `json` kind. */
	readonly json: boolean;
}

/** Settled and in-flight child snapshots a subagent carries, as nested agent nodes. */
function describeNestedTasks(
	source: { extractedToolData?: Record<string, unknown[]>; inflightTaskDetails?: TaskToolDetails },
	state: AgentDescribeState,
	depth: number,
): NativeNode[] {
	const nested: TaskToolDetails[] = [];
	const settled = source.extractedToolData?.task;
	if (Array.isArray(settled)) for (const entry of settled) if (isTaskToolDetails(entry)) nested.push(entry);
	if (source.inflightTaskDetails) nested.push(source.inflightTaskDetails);
	const out: NativeNode[] = [];
	for (const details of nested) {
		if (state.seen.has(details)) {
			out.push(noteText("↻ nested task cycle", "dim"));
			continue;
		}
		if (depth >= MAX_NESTED_TASK_RENDER_DEPTH) {
			out.push(noteText("… nested task depth limit reached", "dim"));
			continue;
		}
		state.seen.add(details);
		out.push(...describeAgents(details, state, depth + 1));
		state.seen.delete(details);
	}
	return out;
}

/** Earliest start seen per running subagent (`nowMs - durationMs`), so a snapshot with a stale or zero `durationMs` can't restart its timer. */
const runStartMs = new Map<string, number>();

function runningAge(progress: { id: string; durationMs: number }, nowMs: number): number {
	const start = nowMs - Math.max(0, progress.durationMs);
	const known = runStartMs.get(progress.id);
	const anchor = known === undefined ? start : Math.min(known, start);
	runStartMs.set(progress.id, anchor);
	return Math.max(0, nowMs - anchor);
}

/** An `agent` node; its row's hover card shows the whole `assignment` the row only summarizes. */
function agentNode(
	p: TspAgentProps,
	assignment: NativeNode | undefined,
	children: readonly (NativeNode | undefined)[],
	key: string,
): NativeNode {
	const props: TspProps<"agent"> = assignment ? { ...p, hovercard: propNode(assignment) } : p;
	return node("agent", props, compact(children), key);
}

function describeProgressAgent(progress: AgentProgress, state: AgentDescribeState, depth: number): NativeNode {
	const { nowMs } = state;
	const running = progress.status === "running";
	const status: TspAgentProps["status"] =
		progress.status === "completed" ? "done" : progress.status === "failed" ? "failed" : progress.status;
	const tool =
		running && progress.currentTool
			? {
					name: plainText(progress.currentTool),
					intent:
						plainText(
							toolCallDetail(progress.currentToolIntent, progress.currentToolArgs, progress.currentToolArgsKey),
						) || undefined,
					age: progress.currentToolStartMs ? Math.max(0, nowMs - progress.currentToolStartMs) : undefined,
				}
			: null;
	const summary = taskSummary(progress.description || progress.assignment || progress.task);
	// The agent's own stage line (from its completion probe) rides beside the task while it runs.
	const stage = running && progress.stage ? plainText(progress.stage) : "";
	const assignment = describeAssignment(progress.assignment ?? progress.task);
	const retry =
		running && progress.retryState
			? {
					attempt: progress.retryState.attempt,
					max: progress.retryState.maxAttempts,
					age: Math.max(0, nowMs - progress.retryState.startedAtMs),
					delay: progress.retryState.delayMs,
					error: plainText(progress.retryState.errorMessage),
				}
			: null;
	const failure = !running ? progress.retryFailure : undefined;
	const retryGaveUp = failure
		? `auto-retry gave up after ${formatCount("attempt", failure.attempt)}: ${plainText(failure.errorMessage)}`
		: undefined;
	return agentNode(
		{
			name: formatTaskId(progress.id),
			agent: progress.agent || undefined,
			task: stage ? (summary ? [span(summary), span(` · ${stage}`, "muted")] : stage) : summary || undefined,
			status,
			model: progress.resolvedModelIdentity ?? progress.resolvedModel,
			thinking: thinkingToken(progress.resolvedThinkingLevel),
			tool,
			stats: {
				tools: progress.toolCount || undefined,
				requests: progress.requests || undefined,
				tokens: progress.tokens || undefined,
				...contextStats(progress.contextTokens, progress.contextWindow),
				done: running && progress.completionPercent !== undefined ? progress.completionPercent / 100 : undefined,
				cost: progress.cost > 0 ? progress.cost : undefined,
				...(running ? { age: runningAge(progress, nowMs) } : { took: progress.durationMs }),
			},
			retry,
			badges: agentBadges(state.background, undefined),
			depth: depth > 0 ? depth : undefined,
			collapsible: true,
			collapsed: !state.expanded,
		},
		assignment,
		[
			assignment,
			progress.resolvedModelRoute ? noteText(progress.resolvedModelRoute, "dim") : undefined,
			retryGaveUp ? text([span(retryGaveUp, "error")], { wrap: "word", role: "omp.tool.error" }) : undefined,
			...describeNestedTasks(progress, state, depth),
		],
		progress.id,
	);
}

function describeResultAgent(result: SingleResult, state: AgentDescribeState, depth: number): NativeNode {
	const { warning, rest } = extractMissingYieldWarning(result.output);
	const aborted = result.aborted ?? false;
	const mergeFailed = !aborted && result.exitCode === 0 && !!result.error;
	const success = !aborted && result.exitCode === 0 && !result.error;
	const status: TspAgentProps["status"] = aborted ? "aborted" : success || mergeFailed ? "done" : "failed";
	const structured = result.structuredOutput?.data;
	const output = sanitizeText(stripGeneratedOutputNotice(rest)).trim();
	const errorLine = (message: string, token = "error"): NativeNode =>
		text([span(plainText(message), token)], { wrap: "word", role: "omp.tool.error" });
	const badges: { text: string; tone?: TspTone }[] = [...(agentBadges(state.background, result.isolated) ?? [])];
	if (mergeFailed) badges.push({ text: "merge failed", tone: "warning" });
	else if (warning && success) badges.push({ text: "warning", tone: "warning" });
	if (result.truncated) badges.push({ text: "truncated", tone: "warning" });
	const cost = result.usage?.cost.total ?? 0;
	const assignment = describeAssignment(result.assignment ?? result.task);
	return agentNode(
		{
			name: formatTaskId(result.id),
			agent: result.agent || undefined,
			task: taskSummary(result.description || result.assignment || result.task) || undefined,
			status,
			model: result.resolvedModelIdentity ?? result.resolvedModel,
			thinking: thinkingToken(result.resolvedThinkingLevel),
			tool: null,
			stats: {
				requests: result.requests || undefined,
				tokens: result.tokens || undefined,
				...contextStats(result.contextTokens, result.contextWindow),
				cost: cost > 0 ? cost : undefined,
				took: result.durationMs,
			},
			retry: null,
			badges: badges.length > 0 ? badges : undefined,
			depth: depth > 0 ? depth : undefined,
			collapsible: true,
			collapsed: !state.expanded,
		},
		assignment,
		[
			assignment,
			result.resolvedModelRoute ? noteText(result.resolvedModelRoute, "dim") : undefined,
			aborted && result.abortReason ? errorLine(result.abortReason) : undefined,
			warning ? errorLine(warning, "warning") : undefined,
			result.error ? errorLine(result.error) : undefined,
			result.retryFailure ? errorLine(`auto-retry gave up: ${result.retryFailure.errorMessage}`) : undefined,
			// The structured result is the agent's answer: its containers open one level, as in the fallback tree.
			structured !== undefined
				? describeJsonValue(structured, { native: state.json, open: 1 })
				: output
					? md(output, { role: "omp.task.output" })
					: undefined,
			result.stderr.trim() && !success ? node("ansi", { text: result.stderr, preview: { lines: 6 } }) : undefined,
			kv([
				[
					"Patch",
					result.patchPath && result.hasRootChanges !== false && success
						? shortenPath(result.patchPath)
						: undefined,
				],
				["Branch", result.branchName && success ? plainText(result.branchName) : undefined],
			]),
			...describeNestedTasks(result, state, depth),
		],
		result.id,
	);
}

/** Agent nodes for one snapshot: settled results, then progress rows that have no result yet. */
function describeAgents(details: TaskToolDetails, state: AgentDescribeState, depth: number): NativeNode[] {
	const results = details.results ?? [];
	const agents = orderResultsForDisplay(results).map(res => describeResultAgent(res, state, depth));
	for (const progress of orderProgressForDisplay(details.progress ?? [])) {
		if (!results.some(res => res.id === progress.id)) agents.push(describeProgressAgent(progress, state, depth));
	}
	return agents;
}

/** Streaming call: the context line, then a pending agent per requested spawn. */
function describeTaskCall(args: TaskParams | undefined): NativeToolView {
	const agents: NativeNode[] = [];
	const pending = (name: string, agent: unknown, brief: unknown, isolated: unknown, key: string): NativeNode =>
		agentNode(
			{
				name,
				agent: typeof agent === "string" && agent.trim() ? agent.trim() : undefined,
				task: typeof brief === "string" ? taskSummary(brief) || undefined : undefined,
				status: "pending",
				badges: agentBadges(false, isolated === true),
			},
			describeAssignment(typeof brief === "string" ? brief : undefined),
			[],
			key,
		);
	const flatName = typeof args?.name === "string" ? args.name.trim() : "";
	const flatBrief = taskPreviewText(args?.task, args?.taskFile);
	if (flatName || taskFirstLine(flatBrief)) {
		agents.push(
			pending(
				flatName ? formatTaskId(flatName) : "agent",
				args?.agent,
				flatBrief,
				args?.isolated,
				flatName || "agent",
			),
		);
	}
	if (Array.isArray(args?.tasks)) {
		args.tasks.forEach((entry, index) => {
			const name = typeof entry?.name === "string" ? entry.name.trim() : "";
			agents.push(
				pending(
					name ? formatTaskId(name) : `#${index + 1}`,
					entry?.agent,
					taskPreviewText(entry?.task, entry?.taskFile),
					entry?.isolated,
					name || `#${index + 1}`,
				),
			);
		});
	}
	const target = taskSubject(args);
	return {
		tool: { title: "Task", target, targetKind: target ? "text" : undefined },
		body: compact([describeContext(args?.context), ...agents]),
	};
}

function describeTaskResult(
	result: ToolRenderResult<TaskToolDetails>,
	options: TaskRenderOptions,
	args: TaskParams | undefined,
): NativeToolView {
	const details = result.details;
	const context = describeContext(args?.context);
	const target = taskSubject(args, details);
	if (!details) {
		const fallback = resultText(result).trim();
		if (result.isError) {
			return {
				tool: { title: "Task", target, targetKind: "text" },
				tone: "error",
				body: compact([context, errorText(fallback || "Task failed")]),
			};
		}
		return {
			tool: { title: "Task", target, targetKind: target ? "text" : undefined },
			body: compact([context, fallback ? noteText(fallback, "dim") : undefined]),
		};
	}
	// Ages are sampled once per snapshot; the terminal advances them.
	const background = details.async !== undefined;
	const agents = describeAgents(
		details,
		{
			seen: new WeakSet<object>(),
			nowMs: options.renderContext?.nowMs ?? Date.now(),
			expanded: options.expanded,
			background,
			json: options.json === true,
		},
		0,
	);
	let failed = 0;
	let aborted = 0;
	let succeeded = 0;
	let requests = 0;
	for (const res of details.results ?? []) {
		requests += res.requests ?? 0;
		if (res.aborted) aborted++;
		else if (res.exitCode !== 0) failed++;
		else if (!res.error) succeeded++;
	}
	const summary: string[] = [];
	if ((details.results ?? []).length > 0) {
		if (succeeded) summary.push(`${succeeded} succeeded`);
		if (failed) summary.push(`${failed} failed`);
		if (aborted) summary.push(`${aborted} aborted`);
		if (requests) summary.push(`${formatNumber(requests)} req`);
		summary.push(formatDuration(details.totalDurationMs));
	}
	const fallback = resultText(result);
	const lines = fallback.split("\n");
	const notice = lines.findIndex(isResultNoticeLine);
	const trailer =
		notice >= 0
			? lines
					.slice(notice)
					.filter(line => line.trim())
					.join("\n")
			: "";
	return {
		tool: {
			title: "Task",
			target,
			targetKind: target ? "text" : undefined,
			meta: summary.length > 0 ? [summary.join(" · ")] : undefined,
			badges: background ? [{ text: "background" }] : undefined,
		},
		tone: aborted + failed > 0 ? "error" : undefined,
		preview: "none",
		body: compact([
			context,
			...agents,
			agents.length === 0 ? noteText(fallback.trim() || "No results", "dim") : undefined,
			trailer ? text([span(plainText(trailer), "muted")], { wrap: "word", role: "omp.tool.stats" }) : undefined,
		]),
	};
}

const taskCallMemo = new OwnerMemo<NativeToolView | undefined>();
const taskResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Renders task calls and their live or settled agent results. */
export const taskToolRenderer = {
	renderCall,
	renderResult,
	describeCall(args: TaskParams, options: RenderResultOptions): NativeToolView | undefined {
		return taskCallMemo.get(args, [options.argsComplete], () => describeTaskCall(args));
	},
	describeResult(
		result: ToolRenderResult<TaskToolDetails>,
		options: TaskRenderOptions,
		args?: TaskParams,
	): NativeToolView | undefined {
		return taskResultMemo.get(result, [options.renderContext?.nowMs, options.expanded, options.json], () =>
			describeTaskResult(result, options, args),
		);
	},
	mergeCallAndResult: true,
} satisfies ToolRenderer<TaskParams, TaskToolDetails>;

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";

/**
 * Enforcement policy for a structured subagent output schema.
 *
 * `permissive` preserves legacy retry-budget overrides; `strict` turns every
 * invalid final payload, including an exhausted retry override, into a failed
 * `schema_violation` result.
 */
export type StructuredSubagentSchemaMode = "permissive" | "strict";

/** Origin of the schema selected for a structured subagent invocation. */
export type StructuredSubagentSchemaSource = "caller" | "agent" | "session" | "none";

/** Final validation state of a structured subagent invocation. */
export type StructuredSubagentValidationStatus = "valid" | "invalid" | "unavailable";

/**
 * Parsed structured completion and its schema-validation metadata.
 *
 * `data` is present whenever a payload could be assembled or parsed, even when
 * strict validation rejects it. `error` explains unavailable or invalid
 * validation without requiring consumers to parse presentation text.
 */
export interface StructuredSubagentOutput {
	source: StructuredSubagentSchemaSource;
	mode: StructuredSubagentSchemaMode;
	status: StructuredSubagentValidationStatus;
	data?: unknown;
	error?: string;
}

/** Display cap for a normalized one-line label (roster line, registry `displayName`, prompt field). */
export const LABEL_MAX = 80;

/** Single task item. Fields are optional defensively: args stream in token by token. */
export interface TaskItem {
	/** Stable agent name; becomes the registry/IRC id. Default = generated AdjectiveNoun. */
	name?: string;
	/** Agent type to run this item (e.g. "scout"). Defaults to the spawn policy's default agent. */
	agent?: string;
	/** Historical source session selected by the bundled consult agent. */
	sourceSession?: string;
	/** Optional model selector override for the historical source session. */
	model?: string | string[];
	/** Inline instructions; exactly one of task or taskFile is required. */
	task?: string;
	taskFile?: string;
	/** How open-ended the work is; required by the schema and the child's sole `auto` thinking classification input. */
	solutionSpace?: string;
	/** Per-spawn thinking effort: lowest/middle/highest level the resolved model supports. Overrides the agent's default selector (e.g. `auto`). */
	effort?: "lo" | "med" | "hi";
	/** Caller-provided output schema; its presence overrides the selected agent's schema. */
	outputSchema?: unknown;
	/** Validation behavior for a caller-provided or inherited output schema. */
	schemaMode?: "permissive" | "strict";
	/** Eval-defined tool names exposed to this child. */
	tools?: string[];
	/** Run this spawn in an isolated worktree (batch form; flat form carries it top-level). */
	isolated?: boolean;
}

/**
 * Runtime params union over both wire shapes. The model sees exactly one shape
 * (`{ context, tasks[] }` when `task.batch` is on, `{ name?, agent?, task }`
 * otherwise); runtime stays permissive so internal callers and stale
 * transcripts using the flat form keep working under either setting.
 */
export interface TaskParams {
	/** Stable agent name (flat form). */
	name?: string;
	/** Agent type to spawn (flat form); omitted values resolve from the session spawn policy. */
	agent?: string;
	/** Historical source session selected by the bundled consult agent. */
	sourceSession?: string;
	/** Optional model selector override for the historical source session. */
	model?: string | string[];
	/** The work (flat form). */
	task?: string;
	/** Absolute path or local:// URL to a UTF-8 file (flat form), mutually exclusive with task. */
	taskFile?: string;
	/** How open-ended the work is (flat form); see {@link TaskItem.solutionSpace}. */
	solutionSpace?: string;
	/** Per-spawn thinking effort (flat form): lowest/middle/highest level the resolved model supports. */
	effort?: "lo" | "med" | "hi";
	/** Caller-provided output schema; its presence overrides the selected agent's schema. */
	outputSchema?: unknown;
	/** Validation behavior for a caller-provided or inherited output schema. */
	schemaMode?: "permissive" | "strict";
	/** Eval-defined tool names exposed to the flat-form child. */
	tools?: string[];
	/** Batch form (`task.batch`): one subagent per item. */
	tasks?: TaskItem[];
	/** Batch form: shared background prepended to every assignment; required by the batch schema. */
	context?: string;
	/** Run in an isolated worktree (flat form; per-item in batch form). */
	isolated?: boolean;
}

/**
 * One-line, length-capped label safe for a single roster line, a registry
 * `displayName`, or a system-prompt field. Collapses every run of whitespace
 * AND control/format characters — including U+0085 NEL, ESC/ANSI, and the
 * zero-width separators that `\s` misses — to a single space, then caps length.
 * So untrusted text (a generated task label, a peer activity gist) can neither
 * break the line, inject prompt structure, nor smuggle terminal escapes. Caps at
 * `max` characters (clamped to >= 1; default `LABEL_MAX`), appending an ellipsis when truncated.
 */
export function oneLineLabel(text: string, max = LABEL_MAX): string {
	const oneLine = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	const cap = Math.max(1, max);
	// Count/cut by code point, not UTF-16 code unit, so truncation can never
	// split an astral character into a lone surrogate.
	const chars = [...oneLine];
	return chars.length > cap ? `${chars.slice(0, cap - 1).join("")}…` : oneLine;
}

/** A code review finding reported by the reviewer agent */
export interface ReviewFinding {
	title: string;
	body: string;
	priority: number;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

/** Review summary submitted by the reviewer agent */
export interface ReviewSummary {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}

/** Structured review data extracted from reviewer agent */
export interface ReviewData {
	findings: ReviewFinding[];
	summary?: ReviewSummary;
}

/** Details extracted from a subagent `yield` tool call for final-result assembly and task rendering. */
export interface YieldItem {
	data?: unknown;
	status?: "success" | "aborted";
	error?: string;
	/** A string label is terminal; a non-empty array of labels is incremental. */
	type?: string | string[];
	/** Resolve this yield's payload from the latest durable assistant text instead of `data`. */
	useLastTurn?: boolean;
	/** True when an incremental workpool yield completed every item in its batch. */
	complete?: boolean;
	/**
	 * Set by the in-tool yield validator when it exhausted its retry budget and
	 * accepted schema-invalid data anyway. The executor preserves that override
	 * during post-mortem validation.
	 */
	schemaOverridden?: boolean;
}

/** Progress tracking for a single agent */
export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	assignment?: string;
	taskFile?: string;
	/** SHA-256 of the exact task file bytes before decoding and trimming. */
	taskFileSha256?: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	/** Argument key selected for the display preview, when known. */
	currentToolArgsKey?: string;
	/** Intent the model attached to the current call; undefined when that call carried none. */
	currentToolIntent?: string;
	currentToolStartMs?: number;
	recentTools: Array<{
		tool: string;
		args: string;
		argsKey?: string;
		intent?: string;
		isError?: boolean;
		endMs: number;
	}>;
	recentOutput: string[];
	toolCount: number;
	/** Count of assistant requests (assistant message_end events) across the run. Drives the soft request budget guard. */
	requests: number;
	/** Cumulative input + output + cacheWrite tokens across all turns. Excludes cacheRead (re-reads cached context every turn, making cumulative sum misleading). */
	tokens: number;
	/**
	 * Current per-turn context size: latest assistant message's `usage.totalTokens`.
	 * This is the number to compare against `contextWindow` — what compaction
	 * decides on, what the user typically reads as "how full is the context".
	 * Distinct from `tokens`, which is a lifetime billing-volume counter.
	 */
	contextTokens?: number;
	/** Model's context window in tokens, when known. Lets the UI render `<curr>/<window>` gauges. */
	contextWindow?: number;
	/** Cumulative billing cost in USD, accumulated incrementally from message_end events. */
	cost: number;
	durationMs: number;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	/** Resolved model display string in the form `<provider>/<id>`, optionally suffixed with `:<thinkingLevel>` when the level was set explicitly. Undefined when the model could not be resolved. */
	resolvedModel?: string;
	/** Provider/id including routing, with no added thinking suffix. */
	resolvedModelIdentity?: string;
	/** Explicit thinking metadata; never inferred from the model identity. */
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	/** True when {@link resolvedModel} is the target of an active retry fallback (not the originally configured model). Lets observer-only UIs (collab guests, Agent Hub rows with no live session) flag the fallback and keep the provider. */
	resolvedModelIsFallback?: boolean;
	/** Extension routing note (e.g. model-pools) explaining why {@link resolvedModel} was chosen. */
	resolvedModelRoute?: string;
	/** True when a live advisor was attached to this run's session, not merely enabled in settings. */
	advisor?: boolean;
	/** The agent's latest self-estimate of task completion (0–100), from the periodic `task.completionProbe` side request. */
	completionPercent?: number;
	/**
	 * The agent's current step in its own words (one line, ≤ 80 chars), from the
	 * same probe reply as {@link completionPercent}. Running rows prefer it over
	 * `lastIntent`; the job widget uses it as its stage line.
	 */
	stage?: string;
	/**
	 * What the agent says shows its progress live (one line, ≤ 200 chars), e.g.
	 * "BENCH lines in bg_2 pipe:1, tok_s higher is better, target 70% of roofline";
	 * from the probe reply. Feeds the job widget author's brief; never rendered.
	 */
	watch?: string;
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/**
	 * Auto-retry state when the subagent is sleeping between provider retries
	 * (e.g. 429 rate-limit with retry-after). Cleared when the retry resolves
	 * or fails. Surfacing this to the parent prevents the task tool from
	 * looking indefinitely "in progress" when a child is actually blocked on
	 * provider quota.
	 */
	retryState?: {
		attempt: number;
		maxAttempts: number;
		delayMs: number;
		errorMessage: string;
		startedAtMs: number;
	};
	/**
	 * Terminal retry failure surfaced once the subagent gave up retrying
	 * (e.g. retry-after exceeded the cap, or all attempts exhausted). Carries
	 * the final error so the parent UI can render "blocked: rate-limited"
	 * instead of waiting for a status that never arrives.
	 */
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
	/**
	 * Snapshot of the most recent `task` tool call's in-flight `TaskToolDetails`,
	 * captured from `tool_execution_update`. Lets the parent UI surface live
	 * nested-subagent progress while this agent is still inside its own `task`
	 * call. Cleared when the call ends — finalized data lives in
	 * `extractedToolData.task` after that.
	 */
	inflightTaskDetails?: TaskToolDetails;
}

/** Result from a single agent execution */
export interface SingleResult {
	index: number;
	id: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	assignment?: string;
	taskFile?: string;
	taskFileSha256?: string;
	description?: string;
	lastIntent?: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;
	/**
	 * Parsed structured completion and validation metadata, when this invocation
	 * selected an output schema or strict schema mode.
	 */
	structuredOutput?: StructuredSubagentOutput;
	durationMs: number;
	/** Cumulative input + output + cacheWrite tokens across all turns. Excludes cacheRead (re-reads cached context every turn, making cumulative sum misleading). */
	tokens: number;
	/** Count of assistant requests (assistant message_end events) across the run. */
	requests: number;
	/** Latest per-turn context size at task completion. See `AgentProgress.contextTokens`. */
	contextTokens?: number;
	/** Model's context window in tokens, when known. */
	contextWindow?: number;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	/** Resolved model display string in the form `<provider>/<id>`, optionally suffixed with `:<thinkingLevel>` when the level was set explicitly. Omitted from tool-result JSON when undefined to keep wire payloads small. */
	resolvedModel?: string;
	/** Retains the unambiguous identity from {@link AgentProgress.resolvedModelIdentity}. */
	resolvedModelIdentity?: string;
	/** Retains {@link AgentProgress.resolvedThinkingLevel} after settlement. */
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	/** True when {@link resolvedModel} is the target of an active retry fallback. Mirrors {@link AgentProgress.resolvedModelIsFallback} onto the settled result. */
	resolvedModelIsFallback?: boolean;
	/** Mirrors {@link AgentProgress.resolvedModelRoute} onto the settled result. */
	resolvedModelRoute?: string;
	/** Retains {@link AgentProgress.advisor} after the advised session is disposed. */
	advisor?: boolean;
	error?: string;
	aborted?: boolean;
	abortReason?: string;
	/** Aggregated usage from the subprocess, accumulated incrementally from message_end events. */
	usage?: Usage;
	/** Output path for the task result */
	outputPath?: string;
	/**
	 * Ran inside an isolation worktree. Such agents are parked without a
	 * reviver once the worktree is torn down, so they are never resumable or
	 * messageable after the run — summaries must not suggest otherwise.
	 */
	isolated?: boolean;
	/** Patch path for isolated worktree output */
	patchPath?: string;
	/**
	 * Whether `patchPath` holds a non-empty root-repo diff. `false` when the
	 * agent's changes all live in nested repos (see `nestedPatchPaths`), so
	 * summaries do not claim the root patch captured anything.
	 */
	hasRootChanges?: boolean;
	/** Branch name for isolated branch-mode output */
	branchName?: string;
	/**
	 * Baseline commit SHA the task branch was created from. Passed to
	 * `mergeTaskBranches` so cherry-pick uses the inclusive range
	 * `branchBaseSha..branchName` and preserves every agent commit's message.
	 */
	branchBaseSha?: string;
	/** Nested repo patches to apply after parent merge */
	nestedPatches?: NestedRepoPatch[];
	/**
	 * On-disk copies of `nestedPatches`, one file per nested repo, written
	 * before the isolation workspace is torn down. The workspace is the only
	 * other copy of that work, so these paths are the durable record.
	 */
	nestedPatchPaths?: string[];
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/**
	 * Terminal retry failure, when the subagent exited because the auto-retry
	 * loop gave up (retry-after exceeded the cap, or all attempts exhausted).
	 * Lets the parent task tool surface a "blocked: rate-limited" outcome
	 * instead of a generic failure.
	 */
	retryFailure?: {
		attempt: number;
		errorMessage: string;
	};
	/** Output metadata for agent:// URL integration */
	outputMeta?: { lineCount: number; charCount: number };
}

/** Tool details for TUI rendering */
export interface TaskToolDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
	totalDurationMs: number;
	/** Aggregated usage across all subagents. */
	usage?: Usage;
	outputPaths?: string[];
	progress?: AgentProgress[];
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "task";
	};
}

/** Patch and baseline metadata for an isolated nested repository. */
export interface NestedRepoPatch {
	relativePath: string;
	patch: string;
}

/** Severity level of a review finding. */
export type FindingPriority = "P0" | "P1" | "P2" | "P3";

/** Severity ordering, glyph, and color for a review finding. */
export interface FindingPriorityInfo {
	ord: 0 | 1 | 2 | 3;
	symbol: "status.error" | "status.warning" | "status.info";
	color: ThemeColor;
}

const PRIORITY_INFO: Record<FindingPriority, FindingPriorityInfo> = {
	P0: { ord: 0, symbol: "status.error", color: "error" },
	P1: { ord: 1, symbol: "status.warning", color: "warning" },
	P2: { ord: 2, symbol: "status.warning", color: "muted" },
	P3: { ord: 3, symbol: "status.info", color: "accent" },
};

/** Review severity levels in descending priority. */
export const PRIORITY_LABELS: FindingPriority[] = ["P0", "P1", "P2", "P3"];

/** Tests whether a value is a supported review severity. */
export function isFindingPriority(value: unknown): value is FindingPriority {
	return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

/** Returns display metadata for a review severity. */
export function getPriorityInfo(priority: FindingPriority): FindingPriorityInfo {
	return PRIORITY_INFO[priority] ?? { ord: 3, symbol: "status.info", color: "muted" };
}
/** Validated source location and content of a review finding. */
export interface FindingDetails {
	title: string;
	body: string;
	priority: FindingPriority;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

function normalizeFindingPriority(value: unknown): FindingPriority | undefined {
	if (isFindingPriority(value)) return value;
	if (value === 0) return "P0";
	if (value === 1) return "P1";
	if (value === 2) return "P2";
	if (value === 3) return "P3";
	return undefined;
}

/** Validates and normalizes a persisted review finding. */
export function parseFindingDetails(value: unknown): FindingDetails | undefined {
	if (!isRecord(value)) return undefined;

	const title = typeof value.title === "string" ? value.title : undefined;
	const body = typeof value.body === "string" ? value.body : undefined;
	const priority = normalizeFindingPriority(value.priority);
	const confidence =
		typeof value.confidence === "number" &&
		Number.isFinite(value.confidence) &&
		value.confidence >= 0 &&
		value.confidence <= 1
			? value.confidence
			: undefined;
	const filePath = typeof value.file_path === "string" && value.file_path.length > 0 ? value.file_path : undefined;
	const lineStart =
		typeof value.line_start === "number" && Number.isFinite(value.line_start) ? value.line_start : undefined;
	const lineEnd = typeof value.line_end === "number" && Number.isFinite(value.line_end) ? value.line_end : undefined;

	if (
		title === undefined ||
		body === undefined ||
		priority === undefined ||
		confidence === undefined ||
		filePath === undefined ||
		lineStart === undefined ||
		lineEnd === undefined
	) {
		return undefined;
	}

	return {
		title,
		body,
		priority,
		confidence,
		file_path: filePath,
		line_start: lineStart,
		line_end: lineEnd,
	};
}
/** SubmitReviewDetails - used for rendering review results from yield tool */
export interface SubmitReviewDetails {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}
