/** Gallery fixtures for the search tools (grep, ast_grep, find). */
import type { GalleryFixture } from "./types";

export const searchFixtures: Record<string, GalleryFixture> = {
	grep: {
		label: "Grep",
		streamingArgs: {
			pattern: "useState",
		},
		args: {
			pattern: "useState",
			path: "packages/tui/src",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"# packages/tui/src/components/",
						"## SearchBox.tsx",
						'18:  const [query, setQuery] = useState("");',
						"19:  const [results, setResults] = useState<Match[]>([]);",
						"## StatusBar.tsx",
						"27:  const [expanded, setExpanded] = useState(false);",
						"",
						"# packages/tui/src/hooks/",
						"## useDebounced.ts",
						"9:  const [value, setValue] = useState(initial);",
						"10:  const [pending, setPending] = useState(false);",
					].join("\n"),
				},
			],
			details: {
				scopePath: "packages/tui/src",
				searchPath: "/Users/dev/Projects/pi/packages/tui/src",
				matchCount: 5,
				fileCount: 3,
				files: [
					"packages/tui/src/components/SearchBox.tsx",
					"packages/tui/src/components/StatusBar.tsx",
					"packages/tui/src/hooks/useDebounced.ts",
				],
				fileMatches: [
					{ path: "packages/tui/src/components/SearchBox.tsx", count: 2 },
					{ path: "packages/tui/src/components/StatusBar.tsx", count: 1 },
					{ path: "packages/tui/src/hooks/useDebounced.ts", count: 2 },
				],
				truncated: false,
				displayContent: [
					"# packages/tui/src/components/",
					"## SearchBox.tsx",
					'*18│  const [query, setQuery] = useState("");',
					"*19│  const [results, setResults] = useState<Match[]>([]);",
					"## StatusBar.tsx",
					"*27│  const [expanded, setExpanded] = useState(false);",
					"",
					"# packages/tui/src/hooks/",
					"## useDebounced.ts",
					" *9│  const [value, setValue] = useState(initial);",
					"*10│  const [pending, setPending] = useState(false);",
				].join("\n"),
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "Invalid regex pattern: unclosed group near index 8",
				},
			],
			isError: true,
			details: {
				error: "Invalid regex pattern: unclosed group near index 8",
			},
		},
	},

	grep_missing: {
		label: "Grep (skipped missing)",
		renderer: "grep",
		streamingArgs: {
			pattern: "useState",
		},
		args: {
			pattern: "useState",
			path: "packages/tui/src/hooks;packages/tui/legacy;docs/old-hooks.md",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"# packages/tui/src/hooks/",
						"## useDebounced.ts",
						"9:  const [value, setValue] = useState(initial);",
						"10:  const [pending, setPending] = useState(false);",
						"Skipped missing paths: packages/tui/legacy, docs/old-hooks.md",
					].join("\n"),
				},
			],
			details: {
				scopePath: "packages/tui/src/hooks",
				searchPath: "/Users/dev/Projects/pi/packages/tui/src/hooks",
				matchCount: 2,
				fileCount: 1,
				files: ["packages/tui/src/hooks/useDebounced.ts"],
				fileMatches: [{ path: "packages/tui/src/hooks/useDebounced.ts", count: 2 }],
				truncated: false,
				displayContent: [
					"# packages/tui/src/hooks/",
					"## useDebounced.ts",
					" *9│  const [value, setValue] = useState(initial);",
					"*10│  const [pending, setPending] = useState(false);",
				].join("\n"),
				missingPaths: ["packages/tui/legacy", "docs/old-hooks.md"],
			},
		},
		// Every target missing fails the call instead of skipping (`resolveToolSearchScope`).
		errorResult: {
			content: [
				{
					type: "text",
					text: "Path not found: packages/tui/src/hooks, packages/tui/legacy, docs/old-hooks.md",
				},
			],
			isError: true,
			details: {
				error: "Path not found: packages/tui/src/hooks, packages/tui/legacy, docs/old-hooks.md",
			},
		},
	},

	ast_grep: {
		label: "AST Grep",
		streamingArgs: {
			pat: "useState(",
		},
		args: {
			pat: "useState($A)",
			path: "packages/tui/src/components",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"# packages/tui/src/components/",
						"## SearchBox.tsx",
						'18:  const [query, setQuery] = useState("");',
						'  meta: $A=""',
						"## StatusBar.tsx",
						"27:  const [expanded, setExpanded] = useState(false);",
						"  meta: $A=false",
					].join("\n"),
				},
			],
			details: {
				matchCount: 2,
				fileCount: 2,
				filesSearched: 14,
				limitReached: false,
				scopePath: "packages/tui/src/components",
				searchPath: "/Users/dev/Projects/pi/packages/tui/src/components",
				files: ["packages/tui/src/components/SearchBox.tsx", "packages/tui/src/components/StatusBar.tsx"],
				fileMatches: [
					{ path: "packages/tui/src/components/SearchBox.tsx", count: 1 },
					{ path: "packages/tui/src/components/StatusBar.tsx", count: 1 },
				],
				displayContent: [
					"# packages/tui/src/components/",
					"## SearchBox.tsx",
					'*18│  const [query, setQuery] = useState("");',
					'  meta: $A=""',
					"## StatusBar.tsx",
					"*27│  const [expanded, setExpanded] = useState(false);",
					"  meta: $A=false",
				].join("\n"),
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "Pattern parse error: incomplete node `useState(`; expected a closing `)`",
				},
			],
			isError: true,
		},
	},

	find: {
		label: "Find",
		streamingArgs: {
			query: "retry backoff",
		},
		args: {
			query: "retry backoff on rate limits",
			grep_keywords: ["backoff", "retryAfter"],
			path: "packages/ai/src",
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						'2 hit(s) for "retry backoff on rate limits" in packages/ai/src (τ 0.50), strongest first',
						"",
						"packages/ai/src/retry.ts  0.94  212 lines judged",
						"  packages/ai/src/retry.ts:48-61  0.94  const delay = retryAfterMs ?? Math.min(maxDelay, base * 2 ** attempt);",
						"packages/ai/src/providers/anthropic.ts  0.62  480 lines judged, partial",
						"  packages/ai/src/providers/anthropic.ts:301  0.62  if (response.status === 429) return scheduleRetry(response);",
						"",
						"listed 214 · judged 214 · read 9 files (61.2 KB) · 7 requests · 18,402 tokens · $0.0091 · 3.4s wall / 2.9s api",
					].join("\n"),
				},
			],
			details: {
				query: "retry backoff on rate limits",
				keywords: ["retry", "backoff", "retryAfter", "rate limit"],
				threshold: 0.5,
				hits: [
					{
						rel: "packages/ai/src/retry.ts",
						nameScore: 0.88,
						contentScore: 0.94,
						linesSeen: 212,
						truncated: false,
						ranges: [
							{
								start: 48,
								end: 61,
								p: 0.94,
								snippet: "const delay = retryAfterMs ?? Math.min(maxDelay, base * 2 ** attempt);",
							},
							{
								start: 22,
								end: 30,
								p: 0.71,
								snippet: "export function parseRetryAfter(header: string | null): number | undefined {",
							},
						],
					},
					{
						rel: "packages/ai/src/providers/anthropic.ts",
						contentScore: 0.62,
						linesSeen: 480,
						truncated: true,
						ranges: [
							{
								start: 301,
								end: 301,
								p: 0.62,
								snippet: "if (response.status === 429) return scheduleRetry(response);",
							},
						],
					},
				],
				coverage: "complete",
				stats: {
					listed: 214,
					requests: 7,
					failed: 0,
					unanswered: 0,
					judged: 214,
					filesRead: 9,
					fileBytes: 62_700,
					inputTokens: 18_402,
					outputTokens: 640,
					cost: 0.0091,
					apiMs: 2_900,
					windowsJudged: 31,
					windowsPruned: 12,
					mapCards: 0,
					failures: [],
				},
				elapsedMs: 3_400,
				cwd: "/Users/dev/Projects/pi",
				scopePath: "packages/ai/src",
			},
		},
		errorResult: {
			content: [{ type: "text", text: "Path not found: packages/ai/srcs" }],
			isError: true,
		},
	},
};
