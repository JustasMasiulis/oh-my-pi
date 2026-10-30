/** Gallery fixtures for the ask, github, generic-fallback, and vibe tools. */
import type { VibeScreenSnapshot, VibeToolDetails } from "@oh-my-pi/pi-tui/tools/vibe";
import type { GalleryFixture } from "./types";

const VIBE_NOW = Date.now();

const VIBE_AUTH_RUNNING: VibeScreenSnapshot = {
	id: "auth-fix",
	cli: "good",
	state: "running",
	model: "anthropic/claude-sonnet-4-5",
	turns: 1,
	queued: 0,
	turnStartedAt: VIBE_NOW - 74_000,
	turnMessage: "Fix the token refresh race in packages/server/src/auth/tokens.ts.",
	currentTool: "edit",
	lastIntent: "Holding the store lock across refresh",
	trace: ["read packages/server/src/auth/tokens.ts", "grep refreshToken in packages/server/src"],
	outputTail: ["The race is between the read in refresh() and the write in persist()."],
	lastActivityAt: VIBE_NOW - 2_000,
};

const VIBE_DOCS_IDLE: VibeScreenSnapshot = {
	id: "docs-pass",
	cli: "fast",
	state: "idle",
	model: "openai/gpt-5-mini",
	turns: 2,
	queued: 0,
	trace: [],
	outputTail: [],
	lastActivity: "Updated docs/auth.md with the new refresh flow.",
	lastActivityAt: VIBE_NOW - 40_000,
};

export const miscFixtures: Record<string, GalleryFixture> = {
	ask: {
		label: "Ask",
		streamingArgs: {
			questions: [
				{
					id: "db",
					question: "Which database should the new service use?",
					options: [{ label: "Postgres" }],
				},
			],
		},
		args: {
			questions: [
				{
					id: "db",
					question: "Which database should the new service use?",
					options: [
						{ label: "Postgres", description: "Relational, strong consistency, JSONB support" },
						{ label: "SQLite", description: "Embedded, zero-ops, great for single-node" },
						{ label: "MongoDB", description: "Document store, flexible schema" },
					],
					recommended: 0,
				},
				{
					id: "features",
					question: "Which auth flows should ship in v1?",
					options: [
						{ label: "Email + password" },
						{ label: "OAuth (Google, GitHub)" },
						{ label: "Magic links" },
						{ label: "SAML SSO", description: "Enterprise; can be deferred" },
					],
					multi: true,
				},
			],
		},
		result: {
			content: [
				{
					type: "text",
					text: "db: Postgres\nfeatures: Email + password, OAuth (Google, GitHub)",
				},
			],
			details: {
				results: [
					{
						id: "db",
						question: "Which database should the new service use?",
						options: ["Postgres", "SQLite", "MongoDB"],
						multi: false,
						selectedOptions: ["Postgres"],
					},
					{
						id: "features",
						question: "Which auth flows should ship in v1?",
						options: ["Email + password", "OAuth (Google, GitHub)", "Magic links", "SAML SSO"],
						multi: true,
						selectedOptions: ["Email + password", "OAuth (Google, GitHub)"],
					},
				],
			},
		},
		errorResult: {
			content: [{ type: "text", text: "Prompt cancelled by user before any answer was given" }],
			isError: true,
		},
	},

	github: {
		label: "GitHub",
		streamingArgs: {
			op: "search_prs",
			query: "is:open author:@me",
		},
		args: {
			op: "search_prs",
			query: "is:open review-requested:@me sort:updated",
			repo: "oh-my-pi/pi",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"# GitHub pull requests search",
						"",
						"Query: is:open review-requested:@me sort:updated",
						"Repository: oh-my-pi/pi",
						"Results: 4",
						"",
						"- #1842 feat(tui): virtualized scrollback for tool output",
						"  Repo: oh-my-pi/pi",
						"  State: open",
						"  Author: openyou",
						"  Labels: tui, perf",
						"  Created: 2026-10-27T09:12:44Z",
						"  Updated: 2026-10-30T11:02:10Z",
						"  URL: https://github.com/oh-my-pi/pi/pull/1842",
						"",
						"- #1839 fix(agent): retry stream on transient 529",
						"  Repo: oh-my-pi/pi",
						"  State: open",
						"  Author: dvir",
						"  Created: 2026-10-29T16:40:03Z",
						"  Updated: 2026-10-30T08:15:51Z",
						"  URL: https://github.com/oh-my-pi/pi/pull/1839",
						"",
						"- #1830 refactor(edit): unify hashline + ast_edit previews",
						"  Repo: oh-my-pi/pi",
						"  State: open",
						"  Author: mira",
						"  Labels: refactor",
						"  Created: 2026-10-24T13:05:27Z",
						"  Updated: 2026-10-29T19:48:36Z",
						"  URL: https://github.com/oh-my-pi/pi/pull/1830",
						"",
						"- #1817 docs: document gallery fixtures contract",
						"  Repo: oh-my-pi/pi",
						"  State: open",
						"  Author: leo",
						"  Labels: docs",
						"  Created: 2026-10-21T10:30:00Z",
						"  Updated: 2026-10-28T14:22:09Z",
						"  URL: https://github.com/oh-my-pi/pi/pull/1817",
					].join("\n"),
				},
			],
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "gh: Could not resolve to a Repository with the name 'oh-my-pi/pi'. (HTTP 404)",
				},
			],
			isError: true,
		},
	},

	// Built-in tool with no dedicated renderer — exercises the generic fallback
	// (`#renderDefaultCard`) path so its flush card is QA'd.
	report_tool_issue: {
		label: "Report Tool Issue",
		streamingArgs: { tool: "lsp" },
		args: {
			tool: "lsp",
			report: "Rename returned no edit for an exported symbol that has 12 references",
		},
		result: { content: [{ type: "text", text: "Noted, thanks!" }] },
		errorResult: {
			content: [{ type: "text", text: "Could not record the report: issue tracker unreachable" }],
			isError: true,
		},
	},

	// Stand-in for a custom/extension tool that ships no renderer — same generic
	// fallback path most MCP/extension tools take.
	custom: {
		label: "Custom Tool",
		streamingArgs: { query: "weather" },
		args: { query: "weather in Tokyo", units: "metric" },
		result: { content: [{ type: "text", text: "Tokyo: 22°C, partly cloudy, humidity 64%." }] },
		errorResult: {
			content: [{ type: "text", text: "Upstream provider returned 503 Service Unavailable" }],
			isError: true,
		},
	},

	vibe_spawn: {
		label: "Vibe spawn",
		streamingArgs: { cli: "good", name: "auth-fix", prompt: "Fix the token refresh race in" },
		args: {
			cli: "good",
			name: "auth-fix",
			prompt:
				"Fix the token refresh race in packages/server/src/auth/tokens.ts.\nHold the store lock across the read and the write, then add a regression test.",
		},
		result: {
			content: [{ type: "text", text: "Spawned good session `auth-fix` (turn job `vibe_7a1`)." }],
			details: {
				op: "spawn",
				screens: [VIBE_AUTH_RUNNING],
				spawned: { id: "auth-fix", cli: "good", jobId: "vibe_7a1" },
			} satisfies VibeToolDetails,
		},
		errorResult: {
			isError: true,
			content: [
				{ type: "text", text: "A session named auth-fix already exists; pick another name or vibe_kill it." },
			],
		},
	},

	vibe_send: {
		label: "Vibe send",
		streamingArgs: { session: "auth-fix", message: "Also cover the expired" },
		args: { session: "auth-fix", message: "Also cover the expired-refresh-token path in the test." },
		result: {
			content: [{ type: "text", text: "Steered into auth-fix's running turn." }],
			details: {
				op: "send",
				screens: [VIBE_AUTH_RUNNING],
				send: { id: "auth-fix", mode: "steered" },
			} satisfies VibeToolDetails,
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Unknown session auth-fx. Live sessions: auth-fix, docs-pass." }],
		},
	},

	vibe_wait: {
		label: "Vibe wait",
		streamingArgs: {},
		args: { sessions: ["auth-fix", "docs-pass"] },
		result: {
			content: [{ type: "text", text: "1 turn settled; auth-fix still running." }],
			details: {
				op: "wait",
				screens: [VIBE_AUTH_RUNNING, VIBE_DOCS_IDLE],
				wait: {
					settled: [{ id: "docs-pass", jobId: "vibe_7a2", status: "completed" }],
					stillRunning: ["auth-fix"],
					timedOut: false,
				},
			} satisfies VibeToolDetails,
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "No running vibe sessions to wait on." }],
		},
	},

	vibe_kill: {
		label: "Vibe kill",
		streamingArgs: { session: "docs-pass" },
		args: { session: "docs-pass" },
		result: {
			content: [{ type: "text", text: "Killed docs-pass; its in-flight turn was cancelled." }],
			details: {
				op: "kill",
				screens: [VIBE_AUTH_RUNNING],
				killed: { id: "docs-pass", cancelledTurn: true },
			} satisfies VibeToolDetails,
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Unknown session docs-pas. Live sessions: auth-fix, docs-pass." }],
		},
	},

	vibe_list: {
		label: "Vibe list",
		streamingArgs: {},
		args: {},
		result: {
			content: [{ type: "text", text: "2 sessions." }],
			details: {
				op: "list",
				screens: [VIBE_AUTH_RUNNING, VIBE_DOCS_IDLE],
				hiddenKilled: ["scratch"],
			} satisfies VibeToolDetails,
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Vibe mode is off; enable it with /vibe first." }],
		},
	},
};
