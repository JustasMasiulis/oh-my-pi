/**
 * The todo HUD above the editor: the active stage of the plan as a tree whose
 * spine fills with overall progress, plus its native descriptions (a HUD
 * checklist, or the same stage window as a tree).
 */
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { formatMoreItems, replaceTabs } from "@oh-my-pi/pi-tui/render/render-utils";
import { renderTreeList } from "@oh-my-pi/pi-tui/render/tree-list";
import { theme } from "@oh-my-pi/pi-tui/theme";
import {
	formatPhaseDisplayName,
	isClosedTodo,
	selectCollapsedTodos,
	type TodoItem,
	type TodoPhase,
	todoMatchesAnyDescription,
} from "@oh-my-pi/pi-tui/tools/todo";
import type { TspChecklistItem, TspChecklistPhase, TspSpan, TspTreeNode } from "@oh-my-pi/pi-wire";
import chalk from "@oh-my-pi/pi-utils/chalk";

/** Stages shown after the active one; a trailing summary row covers the rest. */
const SUBSEQUENT_STAGE_CAP = 4;
/** Open tasks previewed for the active stage. */
const ACTIVE_TASK_CAP = 5;
/** Cells in the closing elbow tail of the progress path. */
const TAIL_LENGTH = 6;

const SUPERSCRIPT_DIGITS: Record<string, string> = {
	"0": "\u2070",
	"1": "\u00b9",
	"2": "\u00b2",
	"3": "\u00b3",
	"4": "\u2074",
	"5": "\u2075",
	"6": "\u2076",
	"7": "\u2077",
	"8": "\u2078",
	"9": "\u2079",
};

export interface TodoHudOptions {
	/** Every stage and task, instead of the active stage's bounded window. */
	readonly expanded: boolean;
	/** Descriptions of running subagents; a pending todo matching one lights up. */
	readonly activeDescriptions: readonly string[];
}

export interface TodoHud {
	/** ANSI rows: a leading blank, the `TODO` heading, the stage tree and its progress tail. */
	readonly text: string;
	/** The whole plan as a HUD checklist, and the same stage window as a tree for terminals without `checklist`. */
	readonly native: { readonly checklist: NativeNode; readonly fallback: NativeNode };
}

function formatNoteMarker(count: number): string {
	if (count <= 0) return "";
	const digits = String(count)
		.split("")
		.map(digit => SUPERSCRIPT_DIGITS[digit] ?? digit)
		.join("");
	return theme.fg("dim", chalk.italic(` \u207a${digits}`));
}

/** One todo row: a status-tinted checkbox and the content, plus a superscript note count. */
export function formatTodoHudLine(todo: TodoItem, matched: boolean): string {
	const checkbox = theme.checkbox;
	const marker = formatNoteMarker(todo.notes?.length ?? 0);
	switch (todo.status) {
		case "completed":
			return theme.fg("success", `${checkbox.checked} ${chalk.strikethrough(todo.content)}`) + marker;
		case "in_progress":
			return theme.fg("accent", `${checkbox.unchecked} ${todo.content}`) + marker;
		case "abandoned":
			return theme.fg("error", `${checkbox.unchecked} ${chalk.strikethrough(todo.content)}`) + marker;
		case "blocked":
			return theme.fg("warning", `${checkbox.unchecked} ${todo.content} (blocked)`) + marker;
		default:
			if (matched) return theme.fg("accent", `${checkbox.unchecked} ${todo.content}`) + marker;
			return theme.fg("dim", `${checkbox.unchecked} ${todo.content}`) + marker;
	}
}

/** The first stage with open work, else the last non-empty one. */
function activePhase(phases: readonly TodoPhase[]): TodoPhase | undefined {
	return (
		phases.find(phase => phase.tasks.some(task => task.status === "pending" || task.status === "in_progress")) ??
		phases.at(-1)
	);
}

/** The HUD for `phases`, or undefined when no stage has a task. */
export function renderTodoHud(allPhases: readonly TodoPhase[], options: TodoHudOptions): TodoHud | undefined {
	const phases = allPhases.filter(phase => phase.tasks.length > 0);
	if (phases.length === 0) return undefined;
	const { expanded, activeDescriptions } = options;
	const multiPhase = phases.length > 1;
	const activeIdx = phases.indexOf(activePhase(phases) ?? phases[0]);

	// A pending todo "lights up" (accent) when an in-flight subagent is doing
	// its work, matched by normalized content overlap.
	const isMatched = (todo: TodoItem): boolean =>
		activeDescriptions.length > 0 && todoMatchesAnyDescription(todo.content, activeDescriptions);

	// Task subtree for a phase. Collapsed runs the shared walking-viewport
	// policy (completed/abandoned omitted, active work pulled to the head,
	// then following pending tasks) so the HUD and the transient tool result
	// can never disagree about the current work (#5873). Expanded lists all.
	const renderTasks = (phase: TodoPhase): string[] => {
		if (expanded) {
			return renderTreeList(
				{ items: phase.tasks, expanded: true, renderItem: todo => formatTodoHudLine(todo, isMatched(todo)) },
				theme,
			);
		}
		const selection = selectCollapsedTodos(phase.tasks, isMatched, ACTIVE_TASK_CAP);
		return renderTreeList(
			{
				items: selection.items,
				itemType: "task",
				trailingSummary: selection.summary,
				renderItem: todo => formatTodoHudLine(todo, isMatched(todo)),
			},
			theme,
		);
	};

	// One phase node. The active stage is highlighted with normal-brightness task
	// progress; other stages render their whole row (name + progress) in the
	// brighter muted gray. Overall progress lives in the tree spine (below).
	const renderPhase = (phase: TodoPhase, oneBased: number, isActive: boolean): string | string[] => {
		const label = multiPhase ? formatPhaseDisplayName(phase.name, oneBased) : phase.name;
		// Closed, not just completed: the collapsed task window hides abandoned
		// tasks too, so counting only completions leaves the phase reading stuck.
		const done = phase.tasks.filter(isClosedTodo).length;
		const progress = ` · ${done}/${phase.tasks.length}`;
		if (!isActive) {
			const header = theme.fg("muted", label) + theme.fg("dim", progress);
			return expanded ? [header, ...renderTasks(phase)] : header;
		}
		const header = theme.bold(theme.fg("accent", label)) + theme.fg("dim", progress);
		return [header, ...renderTasks(phase)];
	};

	// Collapsed: active stage + a bounded number of following stages, with a
	// "… n more stages" row for anything past the cap. Expanded: every stage
	// from the top. Roman numerals stay tied to the real phase index.
	const baseIdx = expanded ? 0 : activeIdx;
	const phaseSlice = expanded ? phases.slice(baseIdx) : phases.slice(baseIdx, baseIdx + 1 + SUBSEQUENT_STAGE_CAP);
	const hiddenStages = phases.length - baseIdx - phaseSlice.length;

	// Flatten the stage tree into content rows plus a per-row top-level spine
	// glyph (`├─` for stage rows, `│` for continuations). The spine never
	// closes downward — a short elbow tail (`└────`) ends the block instead,
	// so spine + bend + tail form one continuous progress path.
	const spineGlyphs: string[] = [];
	const contentLines: string[] = [];
	const pushBlock = (block: string | string[]): void => {
		const rows = Array.isArray(block) ? block : [block];
		if (rows.length === 0) return;
		spineGlyphs.push(`${theme.tree.branch} `);
		contentLines.push(replaceTabs(rows[0]!));
		for (let i = 1; i < rows.length; i++) {
			spineGlyphs.push(`${theme.tree.vertical}  `);
			contentLines.push(replaceTabs(rows[i]!));
		}
	};
	for (let i = 0; i < phaseSlice.length; i++) {
		pushBlock(renderPhase(phaseSlice[i], baseIdx + i + 1, baseIdx + i === activeIdx));
	}
	if (hiddenStages > 0) {
		pushBlock(theme.fg("dim", formatMoreItems(hiddenStages, "stage", theme)));
	}

	// Closing tail: hook + a few horizontals. Every tail cell is 1 column in
	// both glyph sets, so string slicing below splits it by visible cells.
	const tail =
		theme.tree.hook + theme.tree.horizontal.repeat(Math.max(0, TAIL_LENGTH - visibleWidth(theme.tree.hook)));

	// Overall progress (summed across every stage) fills the path in reading
	// order: down the spine, around the bend, out along the tail.
	// Clamp so partial progress lights at least one cell; a closed plan fills
	// the entire path until the configured auto-clear removes the HUD.
	const totalTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
	const closedTasks = phases.reduce((sum, phase) => sum + phase.tasks.filter(isClosedTodo).length, 0);
	const pathLen = contentLines.length + TAIL_LENGTH;
	let filled = Math.round((closedTasks / totalTasks) * pathLen);
	if (closedTasks > 0) filled = Math.max(filled, 1);
	if (closedTasks < totalTasks) filled = Math.min(filled, pathLen - 1);

	const lines = ["", theme.bold(theme.fg("accent", "TODO"))];
	for (let i = 0; i < contentLines.length; i++) {
		lines.push(` ${theme.fg(i < filled ? "accent" : "dim", spineGlyphs[i]!)}${contentLines[i]}`);
	}
	const tailFilled = Math.max(0, Math.min(filled - contentLines.length, tail.length));
	lines.push(` ${theme.fg("accent", tail.slice(0, tailFilled))}${theme.fg("dim", tail.slice(tailFilled))}`);

	// Native: the same stage window as a tree, overall progress as a bar.
	const describeTask = (todo: TodoItem, id: string): TspTreeNode => {
		const done = todo.status === "completed";
		const token =
			todo.status === "completed"
				? "success del"
				: todo.status === "abandoned"
					? "error del"
					: todo.status === "blocked"
						? "warning"
						: todo.status === "in_progress" || isMatched(todo)
							? "accent"
							: "dim";
		const label: TspSpan[] = [span(todo.status === "blocked" ? `${todo.content} (blocked)` : todo.content, token)];
		const notes = todo.notes?.length ?? 0;
		if (notes > 0) label.push(span(` +${notes}`, "dim em"));
		return { id, label, icon: done ? "check" : "circle" };
	};
	const describeTasks = (phase: TodoPhase, phaseIndex: number): TspTreeNode[] => {
		const index = (todo: TodoItem): string => `${phaseIndex}.${phase.tasks.indexOf(todo)}`;
		if (expanded) return phase.tasks.map(todo => describeTask(todo, index(todo)));
		const selection = selectCollapsedTodos(phase.tasks, isMatched, ACTIVE_TASK_CAP);
		const nodes = selection.items.map(todo => describeTask(todo, index(todo)));
		if (selection.summary) nodes.push({ id: `${phaseIndex}.more`, label: [span(selection.summary, "dim")] });
		return nodes;
	};
	const phaseNodes: TspTreeNode[] = phaseSlice.map((phase, offset) => {
		const phaseIndex = baseIdx + offset;
		const isActive = phaseIndex === activeIdx;
		const name = multiPhase ? formatPhaseDisplayName(phase.name, phaseIndex + 1) : phase.name;
		const done = phase.tasks.filter(isClosedTodo).length;
		const open = isActive || expanded;
		return {
			id: `${phaseIndex}`,
			label: [span(name, isActive ? "accent strong" : "muted"), span(` · ${done}/${phase.tasks.length}`, "dim")],
			open,
			children: open ? describeTasks(phase, phaseIndex) : undefined,
		};
	});
	if (hiddenStages > 0) {
		phaseNodes.push({ id: "more", label: [span(formatMoreItems(hiddenStages, "stage", theme), "dim")] });
	}
	const fallback = node(
		"col",
		{ role: "omp.hud.todo" },
		[
			row(
				[
					text([span("TODO", "accent strong")]),
					node("progress", { value: closedTasks / totalTasks, label: `${closedTasks}/${totalTasks}` }),
				],
				{ gap: "sm", align: "center" },
			),
			node("tree", { nodes: phaseNodes }),
		],
		"todo",
	);

	// A `checklist` HUD is a pill with the whole plan as its popover.
	const checklistPhases: TspChecklistPhase[] = phases.map((phase, phaseIndex) => ({
		id: `${phaseIndex}`,
		title: multiPhase ? formatPhaseDisplayName(phase.name, phaseIndex + 1) : phase.name,
		collapsed: phase.tasks.every(isClosedTodo) || undefined,
		items: phase.tasks.map((todo, taskIndex): TspChecklistItem => {
			const note = todo.blocker ?? todo.notes?.at(-1);
			return {
				id: `${phaseIndex}.${taskIndex}`,
				text: todo.content,
				status:
					todo.status === "completed"
						? "done"
						: todo.status === "abandoned"
							? "dropped"
							: todo.status === "blocked"
								? "blocked"
								: todo.status === "in_progress" || isMatched(todo)
									? "active"
									: "pending",
				note,
			};
		}),
	}));
	const checklist = node(
		"checklist",
		{ phases: checklistPhases, mode: "hud", role: "omp.hud.todo" },
		undefined,
		"todo",
	);

	return { text: lines.join("\n"), native: { checklist, fallback } };
}
