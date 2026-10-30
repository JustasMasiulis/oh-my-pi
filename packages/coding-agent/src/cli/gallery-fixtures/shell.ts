/** Gallery fixtures for shell and supervised-service tools. */
import { NO_OUTPUT_NOTICE } from "@oh-my-pi/pi-tui/tools/output-meta";
import type { GalleryFixture } from "./types";

const GALLERY_DEPS = {
	"@ai-sdk/anthropic": "^1.2.0",
	"@oh-my-pi/pi-ai": "workspace:*",
	"@oh-my-pi/pi-tui": "workspace:*",
};
const GALLERY_DEPS_TEXT =
	"{'@ai-sdk/anthropic': '^1.2.0', '@oh-my-pi/pi-ai': 'workspace:*', '@oh-my-pi/pi-tui': 'workspace:*'}";

/** A JS eval cell; a template literal so the cell's own `${…}` stays literal text. */
const COUNT_SOURCES_JS = `const files = await glob("src/**/*.ts");
print(\`\${files.length} files\`);`;

const LARGEST_FILE_PY = [
	"import glob, os",
	'files = glob.glob("src/**/*.ts", recursive=True)',
	"biggest = max(files, key=os.path.getsize)",
	"print(biggest, os.path.getsize(biggest))",
].join("\n");

export const shellFixtures: Record<string, GalleryFixture> = {
	bash: {
		label: "Bash",
		streamingArgs: {
			command: "git status --short && git log --on",
		},
		args: {
			command: "git status --short && git log --oneline -5",
			cwd: "packages/coding-agent",
			timeout: 30,
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						" M src/cli/gallery-cli.ts",
						" M src/tools/bash.ts",
						"?? src/cli/gallery-fixtures/shell.ts",
						"a1b2c3d Wire gallery command into CLI dispatch",
						"9f8e7d6 Add ToolExecutionComponent lifecycle states",
						"4c5b6a7 Extract createShellRenderer from bashToolRenderer",
						"2d3e4f5 Strip LLM-facing notices before TUI render",
						"7a8b9c0 Cap preview lines in pending command block",
					].join("\n"),
				},
			],
			details: {
				exitCode: 0,
				wallTimeMs: 184,
				timeoutSeconds: 30,
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: [
						"src/tools/bash.ts:1142:34 - error TS2339: Property 'requestedTimeoutSeconds' does not exist on type 'BashToolDetails'.",
						"",
						"1142   const requestedTimeoutSeconds = details?.requestedTimeoutSeconds;",
						"                                            ~~~~~~~~~~~~~~~~~~~~~~~~",
						"Found 1 error in src/tools/bash.ts:1142",
					].join("\n"),
				},
			],
			isError: true,
			details: {
				exitCode: 2,
				wallTimeMs: 5120,
				timeoutSeconds: 30,
			},
		},
	},

	bash_silent: {
		label: "Bash without output",
		renderer: "bash",
		streamingArgs: { command: "mkdir -p dist/gall" },
		args: { command: "mkdir -p dist/gallery && test -f dist/cli.js", timeout: 30 },
		result: {
			content: [{ type: "text", text: NO_OUTPUT_NOTICE }],
			details: { exitCode: 0, wallTimeMs: 12, timeoutSeconds: 30 },
		},
		errorResult: {
			content: [{ type: "text", text: `${NO_OUTPUT_NOTICE}\n\nCommand exited with code 1` }],
			isError: true,
			details: { exitCode: 1, wallTimeMs: 9, timeoutSeconds: 30 },
		},
	},

	bash_diff: {
		label: "Bash (git diff)",
		renderer: "bash",
		streamingArgs: { command: "git diff src/server/au" },
		args: { command: "git diff src/server/auth.ts", timeout: 30 },
		result: {
			content: [
				{
					type: "text",
					text: [
						"diff --git a/src/server/auth.ts b/src/server/auth.ts",
						"index 3f2a1c4..9b8e7d2 100644",
						"--- a/src/server/auth.ts",
						"+++ b/src/server/auth.ts",
						"@@ -41,5 +41,7 @@ export function validateToken(token: string): Claims {",
						"   const claims = verifyJwt(token);",
						"   /* expiry is checked",
						"      against the server clock */",
						'-  if (claims.exp < Date.now()) throw new HttpError(401, "expired");',
						"+  if (claims.exp * 1000 < Date.now()) {",
						'+    throw new HttpError(401, "expired");',
						"+  }",
						"   return claims;",
					].join("\n"),
				},
			],
			details: { exitCode: 0, wallTimeMs: 42, timeoutSeconds: 30 },
		},
		errorResult: {
			content: [{ type: "text", text: "fatal: ambiguous argument 'src/server/auth.ts': unknown revision" }],
			isError: true,
			details: { exitCode: 128, wallTimeMs: 9, timeoutSeconds: 30 },
		},
	},

	bash_search: {
		label: "Bash (rg)",
		renderer: "bash",
		streamingArgs: { command: "rg -n useState packa" },
		args: { command: "rg -n -C1 useState packages/tui/src", timeout: 30 },
		result: {
			content: [
				{
					type: "text",
					text: [
						"packages/tui/src/components/search-box.tsx-17-export function SearchBox() {",
						'packages/tui/src/components/search-box.tsx:18:  const [query, setQuery] = useState("");',
						"packages/tui/src/components/search-box.tsx-19-  return <input value={query} />;",
						"--",
						"packages/tui/src/hooks/use-debounced.ts:9:  const [value, setValue] = useState(initial);",
					].join("\n"),
				},
			],
			details: { exitCode: 0, wallTimeMs: 31, timeoutSeconds: 30 },
		},
		errorResult: {
			content: [{ type: "text", text: "rg: packages/tui/srcx: The system cannot find the file specified." }],
			isError: true,
			details: { exitCode: 2, wallTimeMs: 6, timeoutSeconds: 30 },
		},
	},

	bash_service: {
		label: "Bash service",
		renderer: "bash",
		streamingArgs: { command: "bun run dev", name: "web" },
		args: {
			command: "bun run dev",
			name: "web",
			ready: { log: "Local:.*http", port: 5173, timeout: 30 },
		},
		result: {
			content: [{ type: "text", text: "web: ready pid=51234 ready\nLocal: http://localhost:5173" }],
			details: {
				service: { name: "web", state: "ready", ready: true, timedOut: false, pid: 51234 },
			},
		},
		errorResult: {
			content: [{ type: "text", text: "web: failed — process exited before readiness" }],
			isError: true,
			details: { service: { name: "web", state: "failed", ready: false, timedOut: false } },
		},
	},

	eval: {
		label: "Eval",
		streamingArgs: {
			language: "py",
			code: 'import json\nfrom pathlib import Path\n\ndata = json.loads(Path("package.js',
			title: "load config",
		},
		args: {
			language: "py",
			title: "load config",
			code: [
				"import json",
				"from pathlib import Path",
				"",
				'data = json.loads(Path("package.json").read_text())',
				'deps = data.get("dependencies", {})',
				'print(f"{data[\\"name\\"]} v{data[\\"version\\"]}")',
				'print(f"{len(deps)} dependencies")',
				"print({k: deps[k] for k in sorted(deps)[:3]})",
			].join("\n"),
		},
		result: {
			content: [
				{
					type: "text",
					text: ["@oh-my-pi/coding-agent v0.42.0", "37 dependencies", GALLERY_DEPS_TEXT].join("\n"),
				},
			],
			details: {
				language: "python",
				languages: ["python"],
				cells: [
					{
						index: 0,
						title: "load config",
						language: "python",
						code: [
							"import json",
							"from pathlib import Path",
							"",
							'data = json.loads(Path("package.json").read_text())',
							'deps = data.get("dependencies", {})',
							'print(f"{data[\\"name\\"]} v{data[\\"version\\"]}")',
							'print(f"{len(deps)} dependencies")',
							"print({k: deps[k] for k in sorted(deps)[:3]})",
						].join("\n"),
						output: ["@oh-my-pi/coding-agent v0.42.0", "37 dependencies", GALLERY_DEPS_TEXT].join("\n"),
						views: [{ text: GALLERY_DEPS_TEXT, view: { kind: "json", value: GALLERY_DEPS } }],
						status: "complete",
						durationMs: 64,
						exitCode: 0,
					},
				],
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: [
						"Traceback (most recent call last):",
						'  File "<cell 0>", line 4, in <module>',
						'    data = json.loads(Path("package.json").read_text())',
						"          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
						"json.decoder.JSONDecodeError: Expecting ',' delimiter: line 12 column 3 (char 318)",
					].join("\n"),
				},
			],
			isError: true,
			details: {
				language: "python",
				languages: ["python"],
				isError: true,
				cells: [
					{
						index: 0,
						title: "load config",
						language: "python",
						code: [
							"import json",
							"from pathlib import Path",
							"",
							'data = json.loads(Path("package.json").read_text())',
							'deps = data.get("dependencies", {})',
							'print(f"{data[\\"name\\"]} v{data[\\"version\\"]}")',
						].join("\n"),
						output: [
							"Traceback (most recent call last):",
							'  File "<cell 0>", line 4, in <module>',
							'    data = json.loads(Path("package.json").read_text())',
							"json.decoder.JSONDecodeError: Expecting ',' delimiter: line 12 column 3 (char 318)",
						].join("\n"),
						status: "error",
						durationMs: 41,
						exitCode: 1,
					},
				],
			},
		},
	},

	eval_cells: {
		label: "Eval (multi-cell)",
		renderer: "eval",
		streamingArgs: {
			cells: [{ language: "js", title: "count sources", code: 'const files = await glob("src/**/*.ts");' }],
		},
		args: {
			cells: [
				{
					language: "js",
					title: "count sources",
					code: COUNT_SOURCES_JS,
				},
				{
					language: "py",
					title: "largest file",
					code: LARGEST_FILE_PY,
				},
			],
		},
		result: {
			content: [{ type: "text", text: "412 files\nsrc/session/agent-session.ts 498112" }],
			details: {
				language: "js",
				languages: ["js", "python"],
				cells: [
					{
						index: 0,
						title: "count sources",
						language: "js",
						code: COUNT_SOURCES_JS,
						output: "412 files",
						status: "complete",
						durationMs: 212,
						exitCode: 0,
					},
					{
						index: 1,
						title: "largest file",
						language: "python",
						code: LARGEST_FILE_PY,
						output: "src/session/agent-session.ts 498112",
						status: "complete",
						durationMs: 18,
						exitCode: 0,
					},
				],
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: "412 files\nFileNotFoundError: [Errno 2] No such file or directory: 'src/generated/schema.ts'",
				},
			],
			isError: true,
			details: {
				language: "js",
				languages: ["js", "python"],
				isError: true,
				cells: [
					{
						index: 0,
						title: "count sources",
						language: "js",
						code: COUNT_SOURCES_JS,
						output: "412 files",
						status: "complete",
						durationMs: 212,
						exitCode: 0,
					},
					{
						index: 1,
						title: "largest file",
						language: "python",
						code: LARGEST_FILE_PY,
						output: [
							"Traceback (most recent call last):",
							'  File "<cell 1>", line 3, in <module>',
							"FileNotFoundError: [Errno 2] No such file or directory: 'src/generated/schema.ts'",
						].join("\n"),
						status: "error",
						durationMs: 9,
						exitCode: 1,
					},
				],
			},
		},
	},
};
