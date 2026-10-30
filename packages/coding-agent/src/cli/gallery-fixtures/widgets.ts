/**
 * Gallery fixtures for the live window around the composer while an agent
 * runs: the working row, the pinned HUDs (subagents, todos, progress), queued
 * messages, running `!`/`$` commands, side panels, and the dialogs that take
 * the composer's place.
 *
 * Every sample renders the production component; HUDs that live inside
 * `InteractiveMode` render through the functions it paints with.
 */
import { Container, type Component, Loader, Spacer, Text } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { EvalExecutionComponent } from "@oh-my-pi/pi-tui/chat/eval-execution";
import { appKey } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import { renderSegmentTrack } from "@oh-my-pi/pi-tui/chrome/segment-track";
import { ApprovalDialogComponent } from "@oh-my-pi/pi-tui/overlays/approval-dialog";
import { AskDialogComponent, type ExtensionAskDialogQuestion } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { BtwPanelComponent } from "@oh-my-pi/pi-tui/overlays/btw-panel";
import { ErrorBannerComponent } from "@oh-my-pi/pi-tui/overlays/error-banner";
import { HookEditorComponent } from "@oh-my-pi/pi-tui/overlays/hook-editor";
import { HookInputComponent } from "@oh-my-pi/pi-tui/overlays/hook-input";
import { HookSelectorComponent } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import { OmfgPanelComponent } from "@oh-my-pi/pi-tui/overlays/omfg-panel";
import { renderPauseScreen } from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { PlanReviewOverlay } from "@oh-my-pi/pi-tui/overlays/plan-review-overlay";
import type { ObservableSession } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { QueuedMessagesBand } from "@oh-my-pi/pi-tui/prompt/queued-messages";
import { getSymbolTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { ExtensionApprovalPrompt } from "../../extensibility/extensions/types";
import { renderSubagentHudLines, SubagentHudComponent } from "../../modes/interactive-mode";
import { DownloadActivityHud, JudgmentBatchProgressHud } from "../../modes/progress-hud";
import { renderTodoHud } from "../../modes/todo-hud";
import { createWorkingLoader, formatAsyncWaitLabel, formatWorkingRowTrailer } from "../../modes/working-row";
import type { ToolSession } from "../../tools";
import { requestApproval } from "../../tools/approval";
import { BashTool } from "../../tools/bash";
import { GALLERY_UI, type GalleryPreviewEntry, type GalleryPreviewVariant } from "./types";

interface WidgetGallerySpec {
	id: string;
	label: string;
	samples: readonly GalleryPreviewVariant[];
}

/** Default bindings, so key hints read as they do for a user who never rebound them. */
const KEYS = KeybindingsManager.inMemory();

/** Downloads appear only after running this long; the sample waits past it (`DOWNLOAD_REVEAL_MS`). */
const DOWNLOAD_REVEAL_WAIT_MS = 160;

function noop(): void {}

function interruptLabel(): string {
	return appKey(KEYS, "app.interrupt");
}

/** Render blocks stacked as the window stacks its containers, then release their timers. */
function renderBlocks(blocks: readonly Component[], width: number): readonly string[] {
	const container = new Container();
	for (const block of blocks) container.addChild(block);
	try {
		return container.render(width);
	} finally {
		container.dispose();
	}
}

// ─── Working row ────────────────────────────────────────────────────────────

function workingRow(message: string | undefined, trailer: string | undefined): Component {
	const loader = createWorkingLoader(GALLERY_UI, {
		interruptLabel: interruptLabel(),
		accent: () => undefined,
		trailer: () => trailer,
	});
	if (message) loader.setMessage(message);
	return loader;
}

/** A maintenance row (auto-retry, auto-compaction): a tinted spinner and the muted label. */
function maintenanceRow(spinnerColor: "accent" | "warning", label: string): Component {
	return new Loader(
		GALLERY_UI,
		spinner => theme.fg(spinnerColor, spinner),
		text => theme.fg("muted", text),
		label,
		getSymbolTheme().spinnerFrames,
	);
}

// ─── Subagent HUD ───────────────────────────────────────────────────────────

function progress(id: string, overrides: Partial<AgentProgress>): AgentProgress {
	return {
		id,
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function subagent(id: string, overrides: Partial<ObservableSession>): ObservableSession {
	return {
		id,
		kind: "subagent",
		label: id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

function subagentHud(
	sessions: ObservableSession[],
	width: number,
	expanded: boolean,
	livePreview: boolean,
): readonly string[] {
	const hubKey = appKey(KEYS, "app.agents.hub") || undefined;
	const lines = renderSubagentHudLines(sessions, width, expanded, livePreview, hubKey);
	const order = sessions.map(session => session.id);
	return renderBlocks([new SubagentHudComponent(lines, order)], width);
}

function runningSubagents(): ObservableSession[] {
	const now = Date.now();
	return [
		subagent("AsciiAudit", {
			agent: "explore",
			description: "Audit tool renderers for glyphs that ignore the ASCII preset",
			progress: progress("AsciiAudit", {
				agent: "explore",
				currentTool: "grep",
				currentToolIntent: "Finding literal ellipsis characters in renderers",
				currentToolStartMs: now - 12_000,
				toolCount: 7,
			}),
		}),
		subagent("ApprovalFooter", {
			progress: progress("ApprovalFooter", {
				assignment: "Rewrite the approval dialog footer so the key legend fits 60 columns",
				recentTools: [
					{
						tool: "edit",
						args: "packages/tui/src/overlays/approval-dialog.ts",
						argsKey: "path",
						intent: "Shortening the footer legend",
						endMs: now - 2_000,
					},
				],
				toolCount: 3,
			}),
		}),
	];
}

function manySubagents(): ObservableSession[] {
	const tasks: [id: string, description: string][] = [
		["Renderers", "Sweep tool renderers for frame drift"],
		["Messages", "Replay every transcript message kind"],
		["Widgets", "Cover the live window around the composer"],
		["Docs", "Update the gallery row in the CLI reference"],
		["Changelog", "Add the Unreleased entries"],
	];
	return tasks.map(([id, description]) => subagent(id, { description, progress: progress(id, {}) }));
}

// ─── Todo HUD ───────────────────────────────────────────────────────────────

const SINGLE_STAGE_PLAN: TodoPhase[] = [
	{
		name: "Gallery coverage",
		tasks: [
			{ content: "Inventory the live window", status: "completed" },
			{ content: "Extract the todo HUD renderer", status: "in_progress" },
			{ content: "Add the widget surface", status: "pending" },
			{ content: "Regenerate the ASCII gallery", status: "pending" },
		],
	},
];

const MULTI_STAGE_PLAN: TodoPhase[] = [
	{
		name: "Investigate",
		tasks: [
			{ content: "Map the composer runtime children", status: "completed" },
			{ content: "List the dialogs that replace the composer", status: "completed" },
		],
	},
	{
		name: "Implement",
		tasks: [
			{ content: "Extract the working-row loader", status: "completed" },
			{ content: "Cover the live window around the composer", status: "pending" },
			{
				content: "Render the subagent HUD",
				status: "in_progress",
				notes: ["Uses renderSubagentHudLines", "Overflow needs five agents"],
			},
			{ content: "Snapshot the deferred command preview", status: "abandoned" },
			{ content: "Pin the error banner", status: "blocked", blocker: "Waiting on the banner redesign" },
			{ content: "Wire the --widget flag", status: "pending" },
			{ content: "Update the CLI reference", status: "pending" },
			{ content: "Add the CHANGELOG entry", status: "pending" },
		],
	},
	{ name: "Verify", tasks: [{ content: "Run the gallery tests", status: "pending" }] },
	{ name: "Review", tasks: [{ content: "Read the ASCII output", status: "pending" }] },
	{ name: "Polish", tasks: [{ content: "Fix the glyphs it surfaces", status: "pending" }] },
	{ name: "Ship", tasks: [{ content: "Hand off", status: "pending" }] },
	{ name: "Follow up", tasks: [{ content: "Watch for drift", status: "pending" }] },
];

function todoHud(
	phases: TodoPhase[],
	width: number,
	expanded: boolean,
	activeDescriptions: string[],
): readonly string[] {
	const hud = renderTodoHud(phases, { expanded, activeDescriptions });
	return hud ? renderBlocks([new Text(hud.text, 1, 0)], width) : [];
}

// ─── Dialogs ────────────────────────────────────────────────────────────────

/** The prompt `requestApproval` hands the dialog for a bash call, captured instead of answered. */
async function bashApprovalPrompt(command: string): Promise<ExtensionApprovalPrompt> {
	let captured: ExtensionApprovalPrompt | undefined;
	await requestApproval(
		{
			select: async () => undefined,
			approve: async prompt => {
				captured = prompt;
				return "deny";
			},
		},
		new BashTool({} as ToolSession),
		{ command },
		{ sessionSubject: "bash" },
	);
	if (!captured) throw new Error("requestApproval did not prompt");
	return captured;
}

async function approvalDialog(
	command: string,
	width: number,
	expanded: boolean,
	withGrants: boolean,
): Promise<readonly string[]> {
	const prompt = await bashApprovalPrompt(command);
	const dialog = new ApprovalDialogComponent(
		prompt.compact,
		{ onApprove: noop, onDeny: noop },
		{
			fullPrompt: prompt.full,
			...(prompt.session ? { session: { label: prompt.session, onApprove: noop } } : {}),
			...(withGrants
				? {
						grants: [
							{ label: "Approve Directory: dist", alwaysLabel: "Always Approve Directory: dist" },
							{ label: "Approve", alwaysLabel: "Always Approve" },
						],
						onGrant: noop,
					}
				: {}),
		},
	);
	if (expanded) dialog.toggleDetails();
	try {
		return dialog.render(width);
	} finally {
		dialog.dispose();
	}
}

const ASK_QUESTIONS: ExtensionAskDialogQuestion[] = [
	{
		id: "surface",
		header: "Surface",
		question: "Where should the widget samples live?",
		options: [
			{ label: "A new widget surface", description: "Its own --widget filter, after messages" },
			{ label: "Inside the message surface", description: "Mixed with transcript blocks" },
		],
		recommended: 0,
	},
	{
		id: "states",
		header: "States",
		question: "Which states should each HUD show?",
		multi: true,
		options: [{ label: "Collapsed" }, { label: "Expanded" }, { label: "Overflowing" }],
	},
];

function askDialog(width: number): readonly string[] {
	const dialog = new AskDialogComponent(
		ASK_QUESTIONS,
		{ onSubmit: noop, onCancel: noop, onPrompt: async () => undefined },
		{ tui: GALLERY_UI },
	);
	try {
		return dialog.render(width);
	} finally {
		dialog.dispose();
	}
}

const PLAN = `# Widget gallery

## Goal
Render every live-window widget through its production component.

## Steps
1. Extract the todo HUD and working-row loader from \`InteractiveMode\`.
2. Add \`gallery-fixtures/widgets.ts\` with one entry per widget.
3. Wire \`--widget\` and \`--surface widget\`.

## Verification
- \`bun test test/gallery-cli.test.ts\`
- \`omp gallery --surface widget --plain\` in ASCII and Unicode`;

const PLAN_OPTIONS = [
	"Approve and execute",
	"Approve and compact context",
	"Approve and keep context",
	"Refine plan",
	"Save and quit",
];

// ─── Registry ───────────────────────────────────────────────────────────────

function widgetSpecs(): readonly WidgetGallerySpec[] {
	const interrupt = interruptLabel();
	return [
		{
			id: "working",
			label: "Working row",
			samples: [
				{
					label: "working",
					render: width => renderBlocks([workingRow(undefined, formatWorkingRowTrailer(48.3, undefined))], width),
				},
				{
					label: "waiting on background jobs · band title",
					render: width =>
						renderBlocks(
							[
								workingRow(
									formatAsyncWaitLabel(["bash-3", "task-1", "bash-4", "eval-2"]),
									formatWorkingRowTrailer(31.9, "gallery widgets"),
								),
							],
							width,
						),
				},
				{
					label: "auto-retry",
					render: width =>
						renderBlocks(
							[
								maintenanceRow(
									"warning",
									`Retrying (2/3) in ${formatDuration(4_000)}… (${interrupt} to cancel)`,
								),
							],
							width,
						),
				},
				{
					label: "auto-compaction",
					render: width =>
						renderBlocks(
							[maintenanceRow("accent", `Auto context-full maintenance… (${interrupt} to cancel)`)],
							width,
						),
				},
			],
		},
		{
			id: "subagents",
			label: "Subagent HUD",
			samples: [
				{ label: "running", render: (width, expanded) => subagentHud(runningSubagents(), width, expanded, false) },
				{
					label: "live preview",
					render: (width, expanded) => subagentHud(runningSubagents(), width, expanded, true),
				},
				{ label: "overflow", render: (width, expanded) => subagentHud(manySubagents(), width, expanded, false) },
			],
		},
		{
			id: "todo",
			label: "Todo HUD",
			samples: [
				{ label: "single stage", render: (width, expanded) => todoHud(SINGLE_STAGE_PLAN, width, expanded, []) },
				{
					label: "stages · notes · blocked · subagent match",
					render: (width, expanded) =>
						todoHud(MULTI_STAGE_PLAN, width, expanded, ["Cover the live window around the composer"]),
				},
			],
		},
		{
			id: "queue",
			label: "Queued messages",
			samples: [
				{
					label: "steering and after yield",
					render: width =>
						renderBlocks(
							[
								new QueuedMessagesBand(
									[
										{ label: "Steering", messages: ["Skip the deferred command preview for now"] },
										{
											label: "After yield",
											messages: ["Then regenerate the ASCII gallery", "And post the diff summary"],
										},
									],
									KEYS.getKeys("app.message.dequeue")[0] ?? "alt+up",
									noop,
								),
							],
							width,
						),
				},
			],
		},
		{
			id: "shell",
			label: "Running ! and $ commands",
			samples: [
				{
					label: "! bash",
					render: width => {
						const run = new BashExecutionComponent("bun test test/gallery-cli.test.ts", GALLERY_UI);
						run.appendOutput("bun test v1.3.4\n\ntest/gallery-cli.test.ts:\n(pass) gallery surfaces > order\n");
						return renderBlocks([run], width);
					},
				},
				{
					label: "!! bash · excluded from context",
					render: width => {
						const run = new BashExecutionComponent("git status --short", GALLERY_UI, true);
						run.appendOutput(" M packages/coding-agent/src/cli/gallery-cli.ts\n");
						return renderBlocks([run], width);
					},
				},
				{
					label: "$ python",
					render: width => {
						const run = new EvalExecutionComponent("sum(range(10))", GALLERY_UI);
						run.appendOutput("45\n");
						return renderBlocks([run], width);
					},
				},
			],
		},
		{
			id: "error_banner",
			label: "Pinned error",
			samples: [
				{
					label: "provider error",
					render: width =>
						renderBlocks(
							[
								new ErrorBannerComponent(
									"Rate limited by the provider (429). Retries exhausted after 3 attempts.\nRequest id: req_01J8Z4K2N6",
									noop,
								),
							],
							width,
						),
				},
			],
		},
		{
			id: "model_cycle",
			label: "Model role cycle",
			samples: [
				{
					label: "second role active",
					render: width =>
						renderBlocks(
							[
								new Spacer(1),
								new Text(
									renderSegmentTrack(
										[{ label: "default" }, { label: "smol" }, { label: "slow" }, { label: "plan" }],
										1,
									),
									1,
									0,
								),
							],
							width,
						),
				},
			],
		},
		{
			id: "progress",
			label: "Progress HUD",
			samples: [
				{
					label: "judge batches",
					render: width => {
						const hud = new JudgmentBatchProgressHud();
						hud.update({
							id: "j1",
							intent: "Grading renderer consistency",
							done: 14,
							total: 40,
							failed: 0,
							cost: 0.0213,
							running: true,
						});
						hud.update({
							id: "j2",
							intent: "Classifying glyph regressions",
							done: 9,
							total: 12,
							failed: 2,
							cost: 0,
							running: true,
						});
						return renderBlocks([hud], width);
					},
				},
				{
					label: "downloads",
					render: async width => {
						const hud = new DownloadActivityHud(noop);
						hud.update({
							id: 1,
							label: "SmolLM2-135M",
							detail: "model.safetensors",
							loaded: 96_468_992,
							total: 269_060_552,
							state: "running",
						});
						hud.update({ id: 2, label: "yt-dlp", state: "running" });
						await Bun.sleep(DOWNLOAD_REVEAL_WAIT_MS);
						hud.update({ id: 2, label: "yt-dlp", state: "failed", error: "HTTP 503 from github.com" });
						return renderBlocks([hud], width);
					},
				},
			],
		},
		{
			id: "btw",
			label: "/btw side question",
			samples: [
				{
					label: "streaming",
					render: width => {
						const panel = new BtwPanelComponent({
							question: "why does the HUD use superscripts?",
							tui: GALLERY_UI,
						});
						panel.appendText("The note count rides after the task as a superscript so the row");
						try {
							return panel.render(width);
						} finally {
							panel.close();
						}
					},
				},
				{
					label: "answered",
					render: width => {
						const panel = new BtwPanelComponent({
							question: "why does the HUD use superscripts?",
							tui: GALLERY_UI,
						});
						panel.setAnswer(
							"The note count rides after the task as a superscript so the row keeps its width.\n\nIt ignores the ASCII preset today.",
						);
						panel.markComplete();
						try {
							return panel.render(width);
						} finally {
							panel.close();
						}
					},
				},
			],
		},
		{
			id: "omfg",
			label: "/omfg rule draft",
			samples: [
				{
					label: "drafting",
					render: width => {
						const panel = new OmfgPanelComponent({
							complaint: "stop using console.log in renderers",
							tui: GALLERY_UI,
						});
						panel.appendDraft("---\nname: no-console-in-renderers\ncondition: console\\.(log|warn|error)\n---\n");
						try {
							return panel.render(width);
						} finally {
							panel.close();
						}
					},
				},
			],
		},
		{
			id: "approval",
			label: "Tool approval",
			samples: [
				{
					label: "bash · session option",
					render: (width, expanded) => approvalDialog("rm -rf dist && bun run build", width, expanded, false),
				},
				{
					label: "bash · grants",
					render: (width, expanded) =>
						approvalDialog(
							"bun run build --outdir dist\nbun run --cwd packages/coding-agent check:types\nbunx oxlint packages",
							width,
							expanded,
							true,
						),
				},
			],
		},
		{
			id: "ask",
			label: "Ask dialog",
			samples: [{ label: "two questions", render: width => askDialog(width) }],
		},
		{
			id: "hook_select",
			label: "Extension select",
			samples: [
				{
					label: "options",
					render: width => {
						const selector = new HookSelectorComponent(
							"Pick a gallery surface",
							[
								{ label: "tool", description: "Tool cards in every lifecycle state" },
								{ label: "message", description: "Transcript blocks" },
								{ label: "widget", description: "The live window around the composer" },
							],
							noop,
							noop,
						);
						return selector.render(width);
					},
				},
			],
		},
		{
			id: "hook_input",
			label: "Extension input",
			samples: [
				{
					label: "empty",
					render: width =>
						new HookInputComponent("Session name", "e.g. gallery widgets", noop, noop).render(width),
				},
			],
		},
		{
			id: "hook_editor",
			label: "Extension editor",
			samples: [
				{
					label: "prefilled",
					render: width => {
						const editor = new HookEditorComponent(
							GALLERY_UI,
							"Commit message",
							"feat(gallery): cover the live window\n\nAdds the widget surface.",
							noop,
							noop,
						);
						return editor.render(width);
					},
				},
			],
		},
		{
			id: "plan_review",
			label: "Plan review",
			samples: [
				{
					label: "plan mode · next step",
					render: width =>
						new PlanReviewOverlay(
							PLAN,
							{ promptTitle: "Plan mode - next step", options: PLAN_OPTIONS },
							{ onPick: noop, onCancel: noop },
						).render(width),
				},
			],
		},
		{
			id: "pause",
			label: "Pause screen",
			samples: [
				{
					label: "settling work",
					render: width =>
						renderPauseScreen(width, 14, 83_000, "gallery widgets", { unsettledTurns: 1, unfinishedJobs: 2 }),
				},
			],
		},
	];
}

/** Live-window widgets in gallery order. */
export function getWidgetGalleryInventory(): readonly string[] {
	return widgetSpecs().map(spec => spec.id);
}

/** Every live-window widget, each sample rendered through its production component. */
export function getWidgetGalleryEntries(): readonly GalleryPreviewEntry[] {
	return widgetSpecs().map(spec => ({
		id: spec.id,
		heading: `widget${theme.sep.dot}${spec.id}${theme.sep.dot}${spec.label}`,
		variants: spec.samples,
	}));
}
