/**
 * Shell output styling inferred from the output's shape and from the paths its
 * command names. Nothing is run and pipelines are not followed: paths are found
 * by shape (a known extension, a glob star, an anchored or multi-segment
 * path), and file contents by where rows sit:
 *
 * - Unified diffs (`diff --git`, `---`/`+++`, `@@` hunks): path rows styled,
 *   context rows highlighted in their file's language, added/removed rows tinted.
 * - Located rows (`path:12:`, `path:12:5`, `path(12,5)`, ` --> path:12:5`): the
 *   path and location styled; in a search the rest is that file's source.
 * - Path rows (a row that is a path, `==> path <==`): styled; in a search or
 *   print, the rows under them are that file's source.
 * - Numbered rows (`12:`, `12-`, `  12\t`, `12 |`) under a known file: source.
 * - Other rows, when every command that writes output prints whole files of
 *   one language (`cat a.ts`, `sed -n 1,9p a.ts`): that source.
 *
 * Every other row keeps the plain tint, with any paths in it styled.
 */
import { lexShellCommand, type ShellToken } from "@oh-my-pi/pi-utils";
import { getLanguageFromPath } from "../lang-from-path";
import { highlightCode, isHighlightLanguage, type Theme, type ThemeColor } from "../theme/theme";
import { replaceTabs } from "../utils";
import type { OutputRowRange } from "./output-pane";
import { formatStyledPath } from "./render-utils";

/** What a shell command tells about its output. */
export interface ShellOutputHints {
	/** The one language of every file and glob its file readers name; undefined for none or several. */
	lang: string | undefined;
	/** A pipeline starts with a command that prints or searches files: its located and numbered rows are source. */
	readsFiles: boolean;
	/**
	 * Every pipeline that writes output prints or searches files, and one prints
	 * them whole (`cat a.ts`, `sed -n 1,9p a.ts`): rows without a location are source too.
	 */
	printsFiles: boolean;
	/** The file readers' names, whose `name: …` rows are errors, not source (`sed: can't read x`). */
	readers: readonly string[];
}

/** Commands that print files to the output. */
const FILE_PRINTERS: Record<string, true> = {
	bat: true,
	batcat: true,
	cat: true,
	head: true,
	less: true,
	more: true,
	nl: true,
	sed: true,
	tac: true,
	tail: true,
};

/** Commands that search files, printing matching rows. */
const FILE_SEARCHERS: Record<string, true> = {
	ack: true,
	ag: true,
	egrep: true,
	fgrep: true,
	grep: true,
	rg: true,
};

/**
 * Search options whose value is the next word. Glob options name files, so
 * their value counts as one; the rest are counts and names.
 */
const SEARCH_VALUE_OPTIONS: Record<string, "glob" | "value"> = {
	"-g": "glob",
	"--glob": "glob",
	"--iglob": "glob",
	"--include": "glob",
	"--exclude": "glob",
	"-t": "value",
	"--type": "value",
	"-T": "value",
	"--type-not": "value",
	"-A": "value",
	"-B": "value",
	"-C": "value",
	"-m": "value",
	"--max-count": "value",
	"-M": "value",
	"--max-columns": "value",
	"-j": "value",
	"--threads": "value",
	"--sort": "value",
	"--sortr": "value",
};

/** Search options that give the pattern, so the first operand is a path: `-e PAT`, `-f FILE`. */
const SEARCH_PATTERN_OPTIONS: Record<string, true> = {
	"-e": true,
	"--regexp": true,
	"-f": true,
	"--file": true,
};

/** Commands that print nothing: beside another command's printed source they add no rows to mistake for it. */
const SILENT_COMMANDS: Record<string, true> = {
	cd: true,
	cp: true,
	export: true,
	mkdir: true,
	mv: true,
	rm: true,
	set: true,
	touch: true,
	true: true,
};

/** Words that run the command after them: `env FOO=1 cat a.ts`, `time rg foo`. */
const COMMAND_WRAPPERS: Record<string, true> = {
	command: true,
	env: true,
	exec: true,
	nohup: true,
	time: true,
};

/** `rev:path` (`HEAD~1:src/a.ts`, `:a.ts`): a file at a git revision. A drive (`C:\`) or URL colon is no revision. */
const REVISION_PATH_RE = /^[\w.~^@{}/-]*:(?![\\/])(.+)$/;

/** `>`, `2>`, `>>file`, `2>&1`, `<file`: a redirection, its file descriptor, operator and attached target. */
const REDIRECTION_RE = /^(\d*)(>>?|<)(.*)$/;

type ShellWord = Extract<ShellToken, { kind: "word" }>;

/**
 * The simple commands that start a pipeline. A later stage (`… | tail`,
 * `… | grep fail`) reads its predecessor's output, not files, so it says
 * nothing about what the output is.
 */
function pipelineHeads(command: string): ShellWord[][] {
	const heads: ShellWord[][] = [];
	let words: ShellWord[] = [];
	let afterPipe = false;
	const endCommand = (nextAfterPipe: boolean) => {
		if (words.length > 0 && !afterPipe) heads.push(words);
		words = [];
		afterPipe = nextAfterPipe;
	};
	let duplicatingFd = false;
	for (const token of lexShellCommand(command)) {
		if (token.kind === "word") {
			const previous = words.at(-1);
			if (duplicatingFd && previous) {
				// `2>&1` lexes as `2>`, `&`, `1`: rejoin it into one redirection.
				words[words.length - 1] = { ...previous, raw: `${previous.raw}&${token.raw}` };
			} else {
				words.push(token);
			}
			duplicatingFd = false;
			continue;
		}
		if (token.raw === "&" && /^\d*>$/.test(words.at(-1)?.raw ?? "")) {
			duplicatingFd = true;
			continue;
		}
		const operator = token.raw.replace(/[ \t]/g, "");
		if (operator !== "") endCommand(/^\|&?$/.test(operator));
	}
	endCommand(false);
	return heads;
}

/** What a pipeline's first command puts in the output. */
type HeadOutput =
	/** Files it prints whole (`prints`) or searches. */
	| { kind: "reader"; name: string; prints: boolean; files: string[] }
	/** Nothing: a {@link SILENT_COMMANDS} command, output redirected away, `sed -i`. */
	| { kind: "silent" }
	/** Anything else: a program's own output. */
	| { kind: "other" };

/**
 * Classify a pipeline head. A reader's files are its operands, glob option
 * values (`-g '*.ts'`, `--glob=*.ts`), git `rev:path` words and `<` inputs;
 * a searcher's first operand is its pattern.
 */
function headOutput(words: readonly ShellWord[]): HeadOutput {
	let start = 0;
	while (
		start < words.length &&
		(/^[A-Za-z_]\w*=/.test(words[start]!.value) || COMMAND_WRAPPERS[words[start]!.value] === true)
	) {
		start++;
	}
	if (start === words.length) return { kind: "silent" };
	const program = words[start]!.value;
	const name = program.slice(Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\")) + 1).replace(/\.exe$/i, "");
	if (SILENT_COMMANDS[name] === true) return { kind: "silent" };
	const isGit = name === "git";
	// git's subcommand: its first word that is no option.
	const subcommandIndex = isGit ? words.findIndex((word, index) => index > start && !word.value.startsWith("-")) : -1;
	const isSearcher =
		FILE_SEARCHERS[name] === true || (subcommandIndex >= 0 && words[subcommandIndex]!.value === "grep");
	if (!isSearcher && !isGit && FILE_PRINTERS[name] !== true) return { kind: "other" };

	const files: string[] = [];
	let patternPending = isSearcher;
	for (let index = Math.max(start, subcommandIndex) + 1; index < words.length; index++) {
		const word = words[index]!;
		const redirection = REDIRECTION_RE.exec(word.raw);
		if (redirection) {
			const [, fd, operator, attached] = redirection;
			const target = attached || words[++index]?.value;
			// Output sent to a file is not printed.
			if (operator !== "<" && (fd === "" || fd === "1")) return { kind: "silent" };
			if (operator === "<" && target) files.push(target);
			continue;
		}
		const value = word.value;
		if (name === "sed" && /^(?:-i|--in-place)/.test(value)) return { kind: "silent" };
		const revisionPath = isGit ? REVISION_PATH_RE.exec(value)?.[1] : undefined;
		if (revisionPath !== undefined) {
			files.push(revisionPath);
			continue;
		}
		if (isGit && !isSearcher) continue;
		if (!value.startsWith("-")) {
			if (patternPending) patternPending = false;
			else files.push(value);
			continue;
		}
		if (isSearcher && SEARCH_PATTERN_OPTIONS[value] === true) {
			patternPending = false;
			index++;
			continue;
		}
		const searchValue = isSearcher ? SEARCH_VALUE_OPTIONS[value] : undefined;
		if (searchValue) {
			const optionValue = words[++index]?.value;
			if (searchValue === "glob" && optionValue) files.push(optionValue);
			continue;
		}
		const equals = value.indexOf("=");
		if (equals < 0) continue;
		if (isSearcher && SEARCH_PATTERN_OPTIONS[value.slice(0, equals)] === true) patternPending = false;
		else files.push(value.slice(equals + 1));
	}
	// A searcher with no path searches the working tree; a printer without a file reads stdin.
	if (isSearcher) return { kind: "reader", name, prints: false, files };
	return files.length > 0 ? { kind: "reader", name, prints: true, files } : { kind: "other" };
}

/**
 * Infer the output hints of `command` from its words alone: only commands that
 * start a pipeline count, and only the files its readers read name the language.
 */
export function inferShellOutputHints(command: string): ShellOutputHints {
	const langs = new Set<string>();
	const readers: string[] = [];
	let printsWhole = false;
	let othersPrint = false;
	for (const words of pipelineHeads(command)) {
		const head = headOutput(words);
		if (head.kind === "other") othersPrint = true;
		if (head.kind !== "reader") continue;
		readers.push(head.name);
		if (head.prints) printsWhole = true;
		for (const file of head.files) {
			const lang = pathLanguage(file);
			if (lang) langs.add(lang);
		}
	}
	const [lang] = langs;
	return {
		lang: langs.size === 1 ? lang : undefined,
		readsFiles: readers.length > 0,
		printsFiles: printsWhole && !othersPrint,
		readers,
	};
}

const EXTENSION_RE = /\.[A-Za-z][\w+-]*$/;

/** The language of a file or glob named by its extension (`a.ts`, `*.rs`); undefined for anything else. */
function pathLanguage(path: string): string | undefined {
	return EXTENSION_RE.test(path) ? getLanguageFromPath(path) : undefined;
}

// =============================================================================
// Path shapes
// =============================================================================

/** `./x`, `../x`, `~/x`, `C:\x`, or an absolute path of two or more segments (`/usr/bin`). */
const ANCHORED_PATH_RE = /^(?:\.{1,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|\/[^/\s]+\/)/;

/**
 * A path-shaped token: a file with a highlightable extension (`a.ts`), a glob
 * (`*.ts`, `src/**`), an anchored path, two or more slashes (`src/a/b`), or a
 * trailing-slash directory (`src/`). `and/or`, `1/2` and `this.state` are not.
 */
function isPathToken(token: string): boolean {
	if (token.length < 2 || token.includes("://") || !/[A-Za-z]/.test(token)) return false;
	if (EXTENSION_RE.test(token) && isHighlightLanguage(getLanguageFromPath(token))) return true;
	if (token.includes("*")) return /[\\/.]/.test(token);
	if (ANCHORED_PATH_RE.test(token)) return true;
	if ((token.match(/[\\/]/g)?.length ?? 0) >= 2) return true;
	return token.endsWith("/") && !token.startsWith("/");
}

/** Runs of path characters, with an optional drive, then an optional `:12:5` or `(12,5)` location. */
const INLINE_PATH_RE = /((?:[A-Za-z]:[\\/])?[\w.\-\\/@~*]+)((?::\d+){1,2}|\(\d+,\d+\))?/g;

// =============================================================================
// Row classification
// =============================================================================

/** A row's source text in a file's language; rows with equal `run` and consecutive `line` tokenize together. */
interface SourceCell {
	text: string;
	lang: string | undefined;
	/** Tint for a language the highlighter does not color. */
	fallback: ThemeColor;
	run: string;
	line?: number;
}

type OutputRow =
	| { kind: "plain" }
	| { kind: "path"; lead: string; path: string; tail: string }
	| { kind: "located"; lead: string; path: string; location: string; separator: string; rest: string; source: boolean }
	| { kind: "gutter"; gutter: string; rest: string; lang: string | undefined; line?: number }
	| { kind: "source"; lang: string }
	| { kind: "diffMeta" }
	| { kind: "diffPath"; marker: string; path: string; suffix: string }
	| { kind: "hunk"; range: string; rest: string }
	| { kind: "added" }
	| { kind: "removed" }
	| { kind: "context"; lang: string | undefined };

const DIFF_GIT_RE = /^diff --git a\/.+ b\/(.+)$/;
const DIFF_META_RE =
	/^(?:index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files )/;
const HUNK_RE = /^(@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@)(.*)$/;
/** `--- a/x` / `+++ b/x`, the path cut before a tab-separated timestamp. */
const DIFF_PATH_RE = /^(--- |\+\+\+ )([^\t]+)(.*)$/;
/** `==> path <==`: a `head`/`tail` file banner. */
const FILE_BANNER_RE = /^(==> )(.+)( <==)$/;
/** `path:12`, `path:12:5`, `path(12,5)`, optionally after ` --> ` (rustc). */
const LOCATED_ROW_RE = /^(\s*(?:--> ?)?)((?:[A-Za-z]:[\\/])?[^\s:()]+)(:\d+(?::\d+)?|\(\d+,\d+\))(.*)$/;
/** `path:text`, a search row without line numbers. */
const UNNUMBERED_ROW_RE = /^((?:[A-Za-z]:[\\/])?[^\s:]+):(?!\d)(.*)$/;
/** A message after a location, not source: `error: …`, ` - warning TS…`. */
const MESSAGE_RE = /^\s*(?:-\s*)?(?:error|warning|warn|note|info|hint|help|fatal|panic|failed|failure)\b/i;
/** `12:5  error …` (eslint): a bare line:column location before a message. */
const BARE_LOCATION_RE = /^(\s*\d+:\d+)(\s.*)$/;
/** `12 |` / `12│`: a compiler snippet gutter. */
const PIPE_GUTTER_RE = /^(\s*(\d+)\s*[|│] ?)(.*)$/;
/** `   |`: a compiler snippet rule row. */
const BARE_GUTTER_RE = /^(\s+[|│])(.*)$/;
/** `12:` (grep -n), `12-` (context), `  12\t` (cat -n, nl). */
const NUMBER_GUTTER_RE = /^(\s*(\d+)(?:[:-]|\t))(.*)$/;
/** `1142   code`: tsc's snippet gutter, a line number and two or more spaces. */
const SPACED_GUTTER_RE = /^((\d+) {2,})(.*)$/;

/** Paths of `path:12:` rows, to resolve rg's `path-12-text` context rows. */
function collectLocatedPaths(lines: readonly string[]): Set<string> {
	const paths = new Set<string>();
	for (const line of lines) {
		const match = /^((?:[A-Za-z]:[\\/])?[^\s:()]+):\d+:/.exec(line);
		if (match && isPathToken(match[1])) paths.add(match[1]);
	}
	return paths;
}

/** `path-12-text` with a known `path`: rg's context row. */
function parseContextRow(line: string, paths: ReadonlySet<string>): OutputRow | undefined {
	for (const match of line.matchAll(/-(\d+)-/g)) {
		const path = line.slice(0, match.index);
		if (!paths.has(path)) continue;
		return {
			kind: "located",
			lead: "",
			path,
			location: `-${match[1]}`,
			separator: "-",
			rest: line.slice(match.index + match[0].length),
			source: true,
		};
	}
	return undefined;
}

/**
 * Classify every output row. Classification walks all rows (a diff's hunk
 * counts and the current file carry from row to row); styling then touches
 * only the rows that can show.
 */
function classifyRows(lines: readonly string[], hints: ShellOutputHints): OutputRow[] {
	const rows: OutputRow[] = [];
	const contextPaths = hints.readsFiles ? collectLocatedPaths(lines) : new Set<string>();
	// The language of numbered rows (`12:`, `  12\t`) of a printed or searched file.
	let gutterLang = hints.readsFiles ? hints.lang : undefined;
	// The language of rows a printer writes whole, with no location of their own.
	let fileLang = hints.printsFiles ? hints.lang : undefined;
	const readerError = hints.readers.length > 0 ? new RegExp(`^(?:${hints.readers.join("|")}): `) : undefined;
	// The language of the last located row, for the compiler snippet under it.
	let snippetLang: string | undefined;
	let diffLang: string | undefined;
	let oldLeft = 0;
	let newLeft = 0;
	const pushGutter = (gutter: string, rest: string, lang?: string, lineNumber?: string) =>
		rows.push({
			kind: "gutter",
			gutter,
			rest,
			lang,
			line: lineNumber === undefined ? undefined : Number(lineNumber),
		});

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;

		if (oldLeft > 0 || newLeft > 0) {
			const marker = line[0];
			if (marker === "+") {
				newLeft--;
				rows.push({ kind: "added" });
				continue;
			}
			if (marker === "-") {
				oldLeft--;
				rows.push({ kind: "removed" });
				continue;
			}
			if (marker === " " || line === "") {
				oldLeft--;
				newLeft--;
				rows.push({ kind: "context", lang: diffLang });
				continue;
			}
			if (marker === "\\") {
				rows.push({ kind: "diffMeta" });
				continue;
			}
			// A row outside the counts ends the hunk.
			oldLeft = 0;
			newLeft = 0;
		}

		const hunk = HUNK_RE.exec(line);
		if (hunk) {
			oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
			newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
			rows.push({ kind: "hunk", range: hunk[1]!, rest: hunk[4]! });
			continue;
		}
		const gitHeader = DIFF_GIT_RE.exec(line);
		if (gitHeader) {
			diffLang = pathLanguage(gitHeader[1]!);
			rows.push({ kind: "diffMeta" });
			continue;
		}
		if (DIFF_META_RE.test(line)) {
			rows.push({ kind: "diffMeta" });
			continue;
		}
		const nextLine = lines[index + 1];
		if (line.startsWith("--- ") && nextLine?.startsWith("+++ ")) {
			const oldPath = DIFF_PATH_RE.exec(line)!;
			const newPath = DIFF_PATH_RE.exec(nextLine)!;
			diffLang = pathLanguage(newPath[2]!) ?? pathLanguage(oldPath[2]!);
			rows.push({ kind: "diffPath", marker: oldPath[1]!, path: oldPath[2]!, suffix: oldPath[3]! });
			rows.push({ kind: "diffPath", marker: newPath[1]!, path: newPath[2]!, suffix: newPath[3]! });
			index++;
			continue;
		}

		const banner = FILE_BANNER_RE.exec(line);
		if (banner) {
			const bannerLang = pathLanguage(banner[2]!);
			if (hints.readsFiles) gutterLang = bannerLang;
			if (hints.printsFiles) fileLang = bannerLang;
			rows.push({ kind: "path", lead: banner[1]!, path: banner[2]!, tail: banner[3]! });
			continue;
		}
		const trimmed = line.trim();
		if (trimmed.length > 0 && !/\s/.test(trimmed) && isPathToken(trimmed)) {
			// A file header (rg --heading, grouped search output): the numbered rows under it are its source.
			if (hints.readsFiles) gutterLang = pathLanguage(trimmed) ?? gutterLang;
			const lead = line.slice(0, line.indexOf(trimmed));
			rows.push({ kind: "path", lead, path: trimmed, tail: line.slice(lead.length + trimmed.length) });
			continue;
		}

		const located = LOCATED_ROW_RE.exec(line);
		if (located && isPathToken(located[2]!)) {
			const path = located[2]!;
			snippetLang = pathLanguage(path);
			const rest = located[4]!;
			const separator = rest.startsWith(":") ? ":" : "";
			const text = rest.slice(separator.length);
			// rustc's ` --> path` and tsc's `path(12,5)` lead messages; a search row leads source.
			const isMessage =
				located[1]!.includes("-->") || located[3]!.startsWith("(") || text.length === 0 || MESSAGE_RE.test(text);
			rows.push({
				kind: "located",
				lead: located[1]!,
				path,
				location: located[3]!,
				separator,
				rest: text,
				source: hints.readsFiles && !isMessage,
			});
			continue;
		}
		const contextRow = hints.readsFiles ? parseContextRow(line, contextPaths) : undefined;
		if (contextRow) {
			rows.push(contextRow);
			continue;
		}
		const unnumbered = hints.readsFiles ? UNNUMBERED_ROW_RE.exec(line) : null;
		if (unnumbered && isPathToken(unnumbered[1]!) && pathLanguage(unnumbered[1]!)) {
			rows.push({
				kind: "located",
				lead: "",
				path: unnumbered[1]!,
				location: "",
				separator: ":",
				rest: unnumbered[2]!,
				source: true,
			});
			continue;
		}

		const bareLocation = BARE_LOCATION_RE.exec(line);
		if (bareLocation) {
			pushGutter(bareLocation[1]!, bareLocation[2]!);
			continue;
		}
		const pipeGutter = PIPE_GUTTER_RE.exec(line);
		if (pipeGutter) {
			pushGutter(pipeGutter[1]!, pipeGutter[3]!, snippetLang ?? gutterLang, pipeGutter[2]);
			continue;
		}
		const bareGutter = BARE_GUTTER_RE.exec(line);
		if (bareGutter) {
			pushGutter(bareGutter[1]!, bareGutter[2]!);
			continue;
		}
		// tsc's snippet: `1142   code` under its located row.
		const spacedGutter = snippetLang ? SPACED_GUTTER_RE.exec(line) : null;
		if (spacedGutter) {
			pushGutter(spacedGutter[1]!, spacedGutter[3]!, snippetLang, spacedGutter[2]);
			continue;
		}
		const numberGutter = gutterLang ? NUMBER_GUTTER_RE.exec(line) : null;
		if (numberGutter) {
			pushGutter(numberGutter[1]!, numberGutter[3]!, gutterLang, numberGutter[2]);
			continue;
		}

		// Prose ends a compiler snippet; blank and underline rows inside one do not.
		if (/\w/.test(line) && !/^\s*[~^]/.test(line)) snippetLang = undefined;
		// A reader's error (`sed: can't read x`) is no printed source.
		const readerFailed = readerError?.test(line) === true;
		rows.push(fileLang !== undefined && !readerFailed ? { kind: "source", lang: fileLang } : { kind: "plain" });
	}
	return rows;
}

/** The source text a row carries, if any. */
function sourceCell(row: OutputRow, line: string, plain: ThemeColor): SourceCell | undefined {
	switch (row.kind) {
		case "located": {
			if (!row.source) return undefined;
			const lineNumber = /\d+/.exec(row.location)?.[0];
			return {
				text: row.rest,
				lang: pathLanguage(row.path),
				fallback: plain,
				run: row.path,
				line: lineNumber === undefined ? undefined : Number(lineNumber),
			};
		}
		case "gutter":
			return row.lang
				? { text: row.rest, lang: row.lang, fallback: plain, run: "gutter", line: row.line }
				: undefined;
		case "source":
			return { text: line, lang: row.lang, fallback: plain, run: "source" };
		case "context":
			return { text: line.slice(1), lang: row.lang, fallback: "toolDiffContext", run: "context" };
		default:
			return undefined;
	}
}

/** Whether `cell` continues the source of `previous`, so the two tokenize as one text. */
function continuesRun(previous: SourceCell | undefined, cell: SourceCell): boolean {
	if (!previous || previous.lang !== cell.lang || previous.run !== cell.run) return false;
	return previous.line === undefined || cell.line === undefined || previous.line + 1 === cell.line;
}

/** Highlight each run of continuing cells as one text; cells in a language the highlighter lacks take their fallback tint. */
function highlightCells(cells: readonly (SourceCell | undefined)[], theme: Theme): (string | undefined)[] {
	const highlighted: (string | undefined)[] = Array.from({ length: cells.length }, () => undefined);
	let start = 0;
	while (start < cells.length) {
		const first = cells[start];
		if (!first) {
			start++;
			continue;
		}
		let end = start + 1;
		while (end < cells.length && cells[end] && continuesRun(cells[end - 1], cells[end]!)) end++;
		const texts = cells.slice(start, end).map(cell => replaceTabs(cell!.text));
		const colored = isHighlightLanguage(first.lang) ? highlightCode(texts.join("\n"), first.lang, theme) : undefined;
		texts.forEach((text, offset) => {
			highlighted[start + offset] = colored?.[offset] ?? theme.fg(first.fallback, text);
		});
		start = end;
	}
	return highlighted;
}

// =============================================================================
// Row styling
// =============================================================================

/** Plain text in `color` with every path-shaped token styled as a path and its location muted. */
function styleInlinePaths(text: string, color: ThemeColor, theme: Theme): string {
	let out = "";
	let last = 0;
	for (const match of text.matchAll(INLINE_PATH_RE)) {
		// A sentence's closing dot is not part of the path.
		const path = match[1]!.replace(/\.+$/, "");
		// In running text a lone `word/` is rarely a directory (`origin/<branch>`); a row of its own may be.
		if (!isPathToken(path) || /^[^\\/]+[\\/]$/.test(path)) continue;
		const location = path === match[1] ? (match[2] ?? "") : "";
		out += paint(color, text.slice(last, match.index), theme);
		out += formatStyledPath(path, theme) + paint("muted", location, theme);
		last = match.index + path.length + location.length;
	}
	return out + paint(color, text.slice(last), theme);
}

/** `text` in `color`, or nothing for empty text, so absent row parts add no escape codes. */
function paint(color: ThemeColor, text: string, theme: Theme): string {
	return text ? theme.fg(color, replaceTabs(text)) : "";
}

function styleRow(row: OutputRow, line: string, source: string | undefined, plain: ThemeColor, theme: Theme): string {
	switch (row.kind) {
		case "plain":
			return styleInlinePaths(line, plain, theme);
		case "path":
			return `${paint("dim", row.lead, theme)}${formatStyledPath(row.path, theme)}${paint("dim", row.tail, theme)}`;
		case "located": {
			const lead = paint("dim", row.lead, theme);
			const location = paint("muted", `${row.location}${row.separator}`, theme);
			return `${lead}${formatStyledPath(row.path, theme)}${location}${source ?? styleInlinePaths(row.rest, plain, theme)}`;
		}
		case "gutter":
			return `${paint("muted", row.gutter, theme)}${source ?? styleInlinePaths(row.rest, plain, theme)}`;
		case "source":
			return source ?? paint(plain, line, theme);
		case "diffMeta":
			return paint("dim", line, theme);
		case "diffPath":
			return `${paint("dim", row.marker, theme)}${formatStyledPath(row.path, theme)}${paint("dim", row.suffix, theme)}`;
		case "hunk":
			return `${paint("accent", row.range, theme)}${paint("muted", row.rest, theme)}`;
		case "added":
			return paint("toolDiffAdded", line, theme);
		case "removed":
			return paint("toolDiffRemoved", line, theme);
		case "context":
			return `${paint("toolDiffContext", line.slice(0, 1), theme)}${source ?? paint("toolDiffContext", line.slice(1), theme)}`;
	}
}

/**
 * The row styler for a shell command's output. Rows are classified from the
 * whole output, but only `visible` rows are styled and highlighted; rows
 * outside it are measured, never drawn, and take the plain tint. Output that
 * colors itself (any ANSI styling) keeps the plain tint everywhere.
 */
export function createShellOutputStyler(
	hints: ShellOutputHints,
	lines: readonly string[],
	visible: OutputRowRange,
	plain: ThemeColor,
	theme: Theme,
): (line: string, index: number) => string {
	const tint = (line: string) => theme.fg(plain, replaceTabs(line));
	if (lines.some(line => line.includes("\x1b["))) return tint;

	const rows = classifyRows(lines, hints);
	const shown = lines.slice(visible.start, visible.end);
	const cells = shown.map((line, offset) => sourceCell(rows[visible.start + offset]!, line, plain));
	const sources = highlightCells(cells, theme);
	const styled = shown.map((line, offset) =>
		styleRow(rows[visible.start + offset]!, line, sources[offset], plain, theme),
	);
	return (line, index) => styled[index - visible.start] ?? tint(line);
}
