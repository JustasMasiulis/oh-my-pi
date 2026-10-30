/**
 * Gallery fixtures for transcript messages: every block the chat transcript
 * draws besides tool calls.
 *
 * Persisted messages replay through the production {@link ChatTranscriptBuilder},
 * so each sample takes the same dispatch a resumed session or the transcript
 * viewer does. Notices the live session presents directly (status lines,
 * warnings, rule rewinds, todo reminders) have no message to replay; their
 * samples build the same components the event controller presents.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@oh-my-pi/pi-ai";
import type { Component } from "@oh-my-pi/pi-tui";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import {
	type AdvisorMessageDetails,
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type BackgroundTanDispatchDetails,
	type BashExecutionMessage,
	COLLAB_PROMPT_MESSAGE_TYPE,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	LAUNCH_COMPLETION_MESSAGE_TYPE,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	type PythonExecutionMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "@oh-my-pi/pi-tui/chat/messages";
import { RecapNotice } from "@oh-my-pi/pi-tui/chat/recap-notice";
import { TodoReminderComponent } from "@oh-my-pi/pi-tui/chat/todo-reminder";
import type { SessionMessageEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { TtsrNotificationComponent } from "@oh-my-pi/pi-tui/chat/ttsr-notification";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { StatusNotice } from "@oh-my-pi/pi-tui/chrome/status-notice";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { TranscriptNotice } from "@oh-my-pi/pi-tui/chrome/transcript-notice";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { GALLERY_UI, type GalleryPreviewEntry } from "./types";

/**
 * One sample: persisted messages replayed through the transcript builder, or
 * the blocks the live session presents directly for events that leave no message.
 */
type MessageSample =
	| { label: string; messages: readonly AgentMessage[] }
	| { label: string; blocks: (expanded: boolean) => readonly Component[] };

interface MessageGallerySpec {
	id: string;
	label: string;
	samples: readonly MessageSample[];
}

/** Fixed wall-clock base, so usage rows print the same time on every run. */
const BASE_TIME = new Date(2026, 6, 28, 21, 4, 0).getTime();

function at(seconds: number): number {
	return BASE_TIME + seconds * 1000;
}

function usage(input: number, output: number, cacheRead: number, cost: number): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + output + cacheRead,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

const UNBILLED = usage(0, 0, 0, 0);

function user(text: string, seconds: number, options: Partial<UserMessage> = {}): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: at(seconds), ...options };
}

function assistant(
	content: AssistantMessage["content"],
	seconds: number,
	options: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-5",
		usage: UNBILLED,
		stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: at(seconds),
		...options,
	};
}

function toolResult(
	toolCallId: string,
	toolName: string,
	text: string,
	seconds: number,
	details?: unknown,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: at(seconds),
	};
}

function custom<T>(
	customType: string,
	content: string,
	details: T,
	timestamp: number,
	attribution: CustomMessage["attribution"] = "agent",
): CustomMessage<T> {
	return { role: "custom", customType, content, display: true, details, attribution, timestamp };
}

function bashRun(command: string, output: string, options: Partial<BashExecutionMessage> = {}): BashExecutionMessage {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: at(0),
		...options,
	};
}

function evalRun(code: string, output: string, exitCode: number): PythonExecutionMessage {
	return {
		role: "pythonExecution",
		code,
		output,
		exitCode,
		cancelled: false,
		truncated: false,
		timestamp: at(0),
	};
}

function daemon(name: string, exitCode: number, runSeconds: number): DaemonSnapshot {
	return {
		name,
		id: `daemon-${name}`,
		state: exitCode === 0 ? "exited" : "failed",
		pid: 51_234,
		createdAt: at(0),
		startedAt: at(0),
		exitedAt: at(runSeconds),
		exitCode,
		restartCount: 0,
		outputBytes: 18_432,
		persist: false,
		detached: false,
	};
}

const MARKDOWN_REPLY = [
	"## Why the test hangs",
	"",
	"`ProcessTerminal` waits for a resize event that Windows never sends when stdout is a pipe:",
	"",
	"1. `start()` subscribes to `SIGWINCH`.",
	"2. The first render waits for the initial size.",
	"3. Under a pipe the size never arrives, so the promise never settles.",
	"",
	"| Platform | Resize signal | Fallback |",
	"| --- | --- | --- |",
	"| macOS, Linux | `SIGWINCH` | not needed |",
	"| Windows | none | read `stdout.columns` |",
	"",
	"```ts",
	"const columns = process.stdout.columns ?? DEFAULT_COLUMNS;",
	"```",
	"",
	"The fix reads the size once at start-up instead of waiting for the first event.",
].join("\n");

const COMPACTION_SUMMARY = [
	"## Goal",
	"Make every tool renderer consistent under the ASCII symbol preset.",
	"",
	"## Progress",
	"- Shared status-line header and flush card layout landed.",
	"- Bash and Eval show `No output` in the bottom border.",
	"",
	"## Next steps",
	"- Regenerate the gallery and compare the ASCII and Unicode presets.",
].join("\n");

const SKILL_BODY = [
	"# Review a pull request",
	"",
	"1. Read the diff and the linked issue.",
	"2. Check behaviour, tests and changelog entries.",
	"3. Report findings by severity; never post without confirmation.",
].join("\n");

/** Every message kind in transcript order of appearance, with its notable variants. */
function messageSpecs(): readonly MessageGallerySpec[] {
	// IRC cards print their age against the wall clock: keep it a fixed distance back.
	const now = Date.now();

	return [
		{
			id: "user",
			label: "User prompt",
			samples: [
				{
					label: "prompt",
					messages: [
						user(
							"Rename `parseSel` to `parseSelector` across `packages/coding-agent` and update the tests.\n\nKeep the old export out: nothing outside the package imports it.",
							0,
						),
					],
				},
				{
					label: "live steer",
					messages: [user("Also keep the CHANGELOG entry to one line.", 0, { liveSteered: true })],
				},
				{
					// The live transcript draws an injected prompt as a dim bubble; the
					// transcript viewer collapses it instead, so build the live block.
					label: "agent-injected",
					blocks: () => [
						new UserMessageComponent("Continue with the remaining todos.", { synthetic: true, timestamp: at(0) }),
					],
				},
			],
		},
		{
			id: "assistant",
			label: "Assistant reply",
			samples: [
				{ label: "markdown", messages: [assistant([{ type: "text", text: MARKDOWN_REPLY }], 0)] },
				{
					label: "thinking",
					messages: [
						assistant(
							[
								{
									type: "thinking",
									thinking:
										"The hang only reproduces under `bun test`, which pipes stdout. A pipe has no window, so no resize event ever fires.",
								},
								{
									type: "text",
									text: "The terminal waits for a resize event a pipe never sends. I'll read the size directly on start-up.",
								},
							],
							0,
						),
					],
				},
				{
					label: "served by another model",
					messages: [
						assistant([{ type: "text", text: "Done: the rename is in and the tests pass." }], 0, {
							upstreamModel: "claude-haiku-4-5-20251001",
						}),
					],
				},
				{
					label: "recovered retry",
					messages: [
						assistant([{ type: "text", text: "Picking up where the stream stopped." }], 0, {
							stopReason: "error",
							errorMessage:
								"429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit",
							retryRecovery: {
								kind: "auto-retry",
								status: "recovered",
								attempt: 1,
								recoveredAt: new Date(at(12)).toISOString(),
								recovery: "wait",
								note: "Rate limited; retried after 12s",
							},
						}),
					],
				},
				{
					label: "error",
					messages: [
						assistant([{ type: "text", text: "Looking at the runner configuration next." }], 0, {
							stopReason: "error",
							errorMessage: "529 overloaded_error: Overloaded",
						}),
					],
				},
				{
					label: "aborted",
					messages: [
						assistant([{ type: "text", text: "Running the full suite now." }], 0, {
							stopReason: "aborted",
							errorMessage: "Request was aborted",
						}),
					],
				},
			],
		},
		{
			id: "turn",
			label: "Agent turn",
			samples: [
				{
					label: "prompt, tools and answer",
					messages: [
						user("Why does `bun test` hang on Windows?", 0),
						assistant(
							[
								{ type: "text", text: "Checking how the terminal learns its size." },
								{
									type: "toolCall",
									id: "turn-read-1",
									name: "read",
									arguments: { path: "packages/tui/src/terminal.ts:120-180" },
								},
								{
									type: "toolCall",
									id: "turn-read-2",
									name: "read",
									arguments: { path: "packages/tui/test/terminal-appearance.test.ts:1-60" },
								},
							],
							4,
							{ usage: usage(2_400, 180, 48_000, 0.0421), duration: 3_100, ttft: 900, completedAt: at(7) },
						),
						toolResult("turn-read-1", "read", "export class ProcessTerminal implements Terminal {", 8),
						toolResult("turn-read-2", "read", 'import { describe, expect, it } from "bun:test";', 8),
						assistant(
							[
								{
									type: "toolCall",
									id: "turn-bash",
									name: "bash",
									arguments: { command: "bun test test/terminal-appearance.test.ts --timeout 5000" },
								},
							],
							9,
							{ usage: usage(3_100, 64, 50_400, 0.0438), duration: 1_900, ttft: 700, completedAt: at(11) },
						),
						toolResult(
							"turn-bash",
							"bash",
							[
								"test/terminal-appearance.test.ts:",
								"(fail) ProcessTerminal > reports its size [5001.42ms]",
								"  ^ this test timed out after 5000ms.",
								"",
								" 0 pass",
								" 1 fail",
							].join("\n"),
							17,
							{ exitCode: 1, wallTimeMs: 5_620, timeoutSeconds: 300 },
						),
						assistant([{ type: "text", text: MARKDOWN_REPLY }], 18, {
							usage: usage(3_900, 410, 53_100, 0.0517),
							duration: 6_200,
							ttft: 1_100,
							completedAt: at(24),
						}),
					],
				},
			],
		},
		{
			id: "bash_execution",
			label: "User shell (!)",
			samples: [
				{
					label: "done",
					messages: [
						bashRun("git status --short", " M src/cli/gallery-cli.ts\n?? src/cli/gallery-fixtures/messages.ts"),
					],
				},
				{
					label: "failed",
					messages: [
						bashRun(
							"bun run check:types",
							"src/cli/gallery-cli.ts(318,22): error TS2304: Cannot find name 'getMessageGalleryEntries'.",
							{ exitCode: 2 },
						),
					],
				},
				{
					label: "cancelled",
					messages: [
						bashRun("bun test --watch", "watching 412 files...", { exitCode: undefined, cancelled: true }),
					],
				},
				{
					label: "excluded from context (!!)",
					messages: [bashRun("ls dist", "cli.js\ncli.js.map", { excludeFromContext: true })],
				},
			],
		},
		{
			id: "python_execution",
			label: "User eval ($)",
			samples: [
				{
					label: "done",
					messages: [evalRun("import json\nprint(len(json.load(open('package.json'))['dependencies']))", "37", 0)],
				},
				{
					label: "failed",
					messages: [
						evalRun(
							"ratio = hits / total",
							[
								"Traceback (most recent call last):",
								'  File "<cell 0>", line 1, in <module>',
								"ZeroDivisionError: division by zero",
							].join("\n"),
							1,
						),
					],
				},
			],
		},
		{
			id: "compaction",
			label: "Compaction",
			samples: [
				{
					label: "soft-compacted",
					messages: [
						{
							role: "compactionSummary",
							summary: COMPACTION_SUMMARY,
							method: "soft",
							tokensBefore: 186_000,
							tokensAfter: 24_000,
							timestamp: at(0),
						},
					],
				},
				{
					label: "with progress warning",
					messages: [
						{
							role: "compactionSummary",
							summary: COMPACTION_SUMMARY,
							method: "remote",
							tokensBefore: 212_000,
							tokensAfter: 171_000,
							warning: "Compaction freed too little context; the next turn may compact again.",
							timestamp: at(0),
						},
					],
				},
			],
		},
		{
			id: "branch_summary",
			label: "Branch summary",
			samples: [
				{
					label: "summarized branch",
					messages: [
						{
							role: "branchSummary",
							summary:
								"Tried reading the terminal size from `ioctl` on the side branch; abandoned because Bun exposes no binding for it.",
							fromId: "entry-41",
							timestamp: at(0),
						},
					],
				},
			],
		},
		{
			id: "handoff",
			label: "Handoff",
			samples: [
				{
					label: "handed off",
					messages: [
						custom("handoff", `<handoff-context>\n${COMPACTION_SUMMARY}\n</handoff-context>`, undefined, at(0)),
					],
				},
			],
		},
		{
			id: "file_mention",
			label: "File mentions (@path)",
			samples: [
				{
					label: "read and skipped files",
					messages: [
						{
							role: "fileMention",
							files: [
								{ path: "packages/tui/src/tools/bash.ts", content: "", lineCount: 766 },
								{
									path: "logs/omp.2026-07-28.log",
									content: "",
									skippedReason: "tooLarge",
									byteSize: 12_400_000,
								},
								{ path: "dist/omp", content: "", skippedReason: "binary", byteSize: 98_000_000 },
							],
							timestamp: at(0),
						} satisfies FileMentionMessage,
					],
				},
			],
		},
		{
			id: "irc",
			label: "IRC messages",
			samples: [
				{
					label: "incoming",
					messages: [
						custom(
							"irc:incoming",
							"session-store rename is merged; auth.ts is yours.",
							{ from: "AuthLoader", message: "session-store rename is merged; auth.ts is yours." },
							now - 120_000,
						),
					],
				},
				{
					label: "incoming reply",
					messages: [
						custom(
							"irc:incoming",
							"Yes: keep the old signature until the CLI migrates.",
							{
								from: "Reviewer",
								message: "Yes: keep the old signature until the CLI migrates.",
								replyTo: "msg-3",
							},
							now - 60_000,
						),
					],
				},
				{
					label: "auto-reply",
					messages: [
						custom(
							"irc:autoreply",
							"Busy with the parser refactor; I'll pick this up after it lands.",
							{
								from: "main",
								to: "AuthLoader",
								body: "Busy with the parser refactor; I'll pick this up after it lands.",
							},
							now - 300_000,
						),
					],
				},
				{
					label: "relay between agents",
					messages: [
						custom(
							"irc:relay",
							"Please review the parser.\nCheck the error boundary.",
							{
								from: "AuthLoader",
								to: "Reviewer",
								body: "Please review the parser.\nCheck the error boundary.",
							},
							now - 180_000,
						),
					],
				},
				{
					label: "work pool",
					messages: [
						custom(
							"irc:workpool",
							"Port `formatErrorText` callers in packages/tui/src/tools.",
							{
								pool: "renderers",
								from: "pool:renderers",
								to: "Worker2",
								body: "Port `formatErrorText` callers in packages/tui/src/tools.",
								mode: "dispatched",
							},
							now - 240_000,
						),
					],
				},
			],
		},
		{
			id: "async_result",
			label: "Background job completed",
			samples: [
				{
					label: "single job",
					messages: [
						custom(
							"async-result",
							"Background job bash-7 completed.",
							{ jobId: "bash-7", type: "bash", label: "bun test", durationMs: 48_200 },
							at(0),
						),
					],
				},
				{
					label: "batch with artifact error",
					messages: [
						custom(
							"async-result",
							"Background jobs completed.",
							{
								jobs: [
									{ jobId: "task-3", type: "task", label: "AuthLoader", durationMs: 312_000 },
									{
										jobId: "bash-9",
										type: "bash",
										label: "bun run bench",
										durationMs: 95_400,
										meta: { artifactError: "write" },
									},
								],
							},
							at(0),
						),
					],
				},
			],
		},
		{
			id: "launch_completion",
			label: "Supervised process exited",
			samples: [
				{
					label: "completed and failed",
					messages: [
						custom(
							LAUNCH_COMPLETION_MESSAGE_TYPE,
							"Supervised processes exited.",
							{ daemons: [daemon("web", 0, 3_600), daemon("worker", 1, 42)] },
							at(0),
						),
					],
				},
			],
		},
		{
			id: "advisor",
			label: "Advisor notes",
			samples: [
				{
					label: "mixed severities",
					messages: [
						custom<AdvisorMessageDetails>(
							"advisor",
							"Advisor notes",
							{
								notes: [
									{
										note: "The rename misses `parseSel` in docs/tools/read.md; the docs will reference a symbol that no longer exists.",
										severity: "blocker",
									},
									{
										note: "`formatErrorText` now keeps every line; long stack traces will flood collapsed cards.",
										severity: "concern",
										advisor: "ux",
									},
									{ note: "Two helpers named `jobRow` now exist in sibling modules.", severity: "nit" },
									{
										note: "The gallery fixture for late diagnostics still uses the old label wording.",
										severity: "nit",
										turnsAgo: 2,
									},
									{ note: "Consider a test for the hidden-note row.", severity: "concern" },
								],
							},
							at(0),
						),
					],
				},
			],
		},
		{
			id: "skill_prompt",
			label: "Skill prompt",
			samples: [
				{
					label: "leading skill",
					messages: [
						custom<SkillPromptDetails>(
							SKILL_PROMPT_MESSAGE_TYPE,
							SKILL_BODY,
							{
								name: "review-pr",
								path: ".omp/skills/review-pr/SKILL.md",
								prompt: "/skill:review-pr check the auth middleware changes",
								lineCount: 48,
							},
							at(0),
							"user",
						),
					],
				},
				{
					label: "skill inside the prompt",
					messages: [
						custom<SkillPromptDetails>(
							SKILL_PROMPT_MESSAGE_TYPE,
							SKILL_BODY,
							{
								name: "review-pr",
								path: ".omp/skills/review-pr/SKILL.md",
								prompt: "Before merging, run /skill:review-pr on the auth branch",
								lineCount: 48,
							},
							at(0),
							"user",
						),
					],
				},
			],
		},
		{
			id: "collab_prompt",
			label: "Collab guest prompt",
			samples: [
				{
					label: "guest prompt",
					messages: [
						custom(
							COLLAB_PROMPT_MESSAGE_TYPE,
							"Can you also cover the Windows path case?",
							{ from: "alice" },
							at(0),
							"user",
						),
					],
				},
			],
		},
		{
			id: "late_diagnostics",
			label: "Late LSP diagnostics",
			samples: [
				{
					label: "error and warning",
					messages: [
						custom(
							LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
							"Late diagnostics for packages/tui/src/tools/bash.ts",
							{
								files: [
									{
										path: "packages/tui/src/tools/bash.ts",
										summary: "1 error(s), 1 warning(s)",
										errored: true,
										messages: [
											"packages/tui/src/tools/bash.ts:488:39 [error] [ts] Cannot find name 'formatWallTimeSeconds'. (2304)",
											"packages/tui/src/tools/bash.ts:12:1 [warning] [ts] 'OutputMeta' is declared but never used. (6133)",
										],
									},
								],
							},
							at(0),
						),
					],
				},
			],
		},
		{
			id: "background_tan",
			label: "Tangent dispatched (/tan)",
			samples: [
				{
					label: "dispatched",
					messages: [
						custom<BackgroundTanDispatchDetails>(
							BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
							"Tangent dispatched.",
							{
								jobId: "tan-2",
								work: "Investigate why the gallery viewer drifts on wide glyphs in the Edit header",
								sessionFile: "tan-2.jsonl",
							},
							at(0),
						),
					],
				},
			],
		},
		{
			id: "custom",
			label: "Extension message",
			samples: [
				{
					label: "extension message",
					messages: [custom("deploy-status", "Deployed `web@4f2a1c` to **staging**.", undefined, at(0))],
				},
				{
					label: "legacy hook message",
					messages: [
						{
							role: "hookMessage",
							customType: "pre-commit",
							content: "Formatted 3 files before the commit.",
							display: true,
							timestamp: at(0),
						} satisfies HookMessage,
					],
				},
			],
		},
		{
			id: "notice",
			label: "Transcript notices",
			samples: [
				{
					label: "status",
					blocks: () => [new StatusNotice("Thinking blocks: hidden", { styleFn: text => theme.fg("dim", text) })],
				},
				{
					label: "warning",
					blocks: () => [TranscriptNotice.line("warning", "MCP server github failed to connect: ECONNREFUSED")],
				},
				{
					label: "error",
					blocks: () => [
						TranscriptNotice.line("error", "Session file is locked by another omp process (pid 8812)"),
					],
				},
				{
					label: "recap",
					blocks: () => [
						new RecapNotice("Renamed parseSel across the package; tests pass, the CHANGELOG entry is pending."),
					],
				},
				{
					label: "rule rewind",
					blocks: expanded => {
						const notice = new TtsrNotificationComponent([
							{
								name: "no-console-in-renderers",
								description:
									"Renderers must not call console.*; it corrupts the TUI.\nUse the logger from @oh-my-pi/pi-utils instead.\nShared code never writes to stdout directly.",
							},
						]);
						notice.setExpanded(expanded);
						return [notice];
					},
				},
				{
					label: "rules rewind",
					blocks: expanded => {
						const notice = new TtsrNotificationComponent([
							{
								name: "no-console-in-renderers",
								description:
									"Renderers must not call console.*; it corrupts the TUI.\nUse the logger from @oh-my-pi/pi-utils instead.",
							},
							{ name: "no-inline-imports", description: "Import at the top of the module." },
							{ name: "private-fields", description: "Use ES #private fields, not the private keyword." },
							{ name: "prompts-in-md", description: "Prompts live in .md files." },
							{ name: "no-sed-edits", description: "Edit with the edit tool, never sed." },
						]);
						notice.setExpanded(expanded);
						return [notice];
					},
				},
				{
					label: "todo reminder",
					blocks: () => [
						new TodoReminderComponent(
							[
								{ content: "Regenerate the ASCII gallery", status: "in_progress" },
								{ content: "Add the CHANGELOG entry", status: "pending" },
							],
							1,
							3,
						),
					],
				},
			],
		},
	];
}

function transcriptEntries(messages: readonly AgentMessage[]): SessionMessageEntryLike[] {
	return messages.map((message, index) => ({
		type: "message",
		id: `gallery-${index}`,
		parentId: index === 0 ? null : `gallery-${index - 1}`,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	}));
}

/** Render one sample as the transcript would: blocks in order, a blank row between them. */
function renderSample(sample: MessageSample, width: number, expanded: boolean): readonly string[] {
	if ("messages" in sample) {
		const builder = new ChatTranscriptBuilder({ ui: GALLERY_UI, cwd: getProjectDir(), requestRender() {} });
		try {
			builder.rebuild(transcriptEntries(sample.messages));
			builder.setExpanded(expanded);
			return builder.container.render(width);
		} finally {
			builder.dispose();
		}
	}

	const container = new TranscriptContainer();
	try {
		for (const block of sample.blocks(expanded)) container.addChild(block);
		return container.render(width);
	} finally {
		container.dispose();
	}
}

/** Transcript message kinds in gallery order. */
export function getMessageGalleryInventory(): readonly string[] {
	return messageSpecs().map(spec => spec.id);
}

/** Every transcript message kind, each sample rendered through the production transcript path. */
export function getMessageGalleryEntries(): readonly GalleryPreviewEntry[] {
	return messageSpecs().map(spec => ({
		id: spec.id,
		heading: `message${theme.sep.dot}${spec.id}${theme.sep.dot}${spec.label}`,
		variants: spec.samples.map(sample => ({
			label: sample.label,
			render: (width, expanded) => renderSample(sample, width, expanded),
		})),
	}));
}
