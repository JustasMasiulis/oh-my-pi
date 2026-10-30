import { beforeAll, describe, expect, it } from "bun:test";
import { createShellOutputStyler, inferShellOutputHints } from "../src/render/shell-output";
import { formatStyledPath } from "../src/render/render-utils";
import { getThemeByName, setThemeInstance, type Theme } from "../src/theme";

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("dark"))!;
	setThemeInstance(theme);
});

/** Every row of `output` as `command` would style it, all rows visible. */
function styleOutput(command: string, output: readonly string[]): string[] {
	const styler = createShellOutputStyler(
		inferShellOutputHints(command),
		output,
		{ start: 0, end: output.length },
		"toolOutput",
		theme,
	);
	return output.map((line, index) => styler(line, index));
}

const plain = (line: string) => theme.fg("toolOutput", line);

describe("shell output styling", () => {
	it("highlights a printed file's rows as source but leaves a program's output plain", () => {
		const rows = ["const value = 1;", "export default value;"];
		expect(styleOutput("cd app && sed -n '1,2p' src/a.ts 2>&1 | head -5", rows)).not.toEqual(rows.map(plain));
		// Naming a source file does not make the program that runs it print source, and a
		// reader later in the pipeline (`| tail`) or one that prints nothing (`sed -i`) reads no file.
		for (const command of [
			"node src/a.js",
			"bun test test/a.test.ts 2>&1 | tail -20",
			"sed -i 's/a/b/' src/a.ts && bun test",
		]) {
			expect(styleOutput(command, rows)).toEqual(rows.map(plain));
		}
	});

	it("keeps rows a file printer did not print plain: its errors, beside another command's output, a search's file list", () => {
		const error = "cat: src/b.ts: No such file or directory";
		const printed = styleOutput("cat src/a.ts src/b.ts", ["export const a = 1;", error]);
		expect(printed[0]).not.toBe(plain("export const a = 1;"));
		// The error row gets the styling of any row no file was read for: inline paths only.
		expect(printed[1]).toBe(styleOutput("echo", [error])[0]);
		// `wc` writes rows of its own, so the printed file's rows can no longer be told from them.
		const counted = styleOutput("wc -l src/a.ts; cat src/a.ts", ["1 src/a.ts", "export const a = 1;"]);
		expect(counted).toEqual(styleOutput("echo", ["1 src/a.ts", "export const a = 1;"]));
		// `rg -l` lists files: the rows after a listed path are not that file's source.
		expect(styleOutput("rg -l value src", ["src/a.ts", "export const a = 1;"])[1]).toBe(plain("export const a = 1;"));
	});

	it("keeps `---` and `+++` rows inside a hunk as removed and added lines, not file headers", () => {
		const diff = [
			"--- a/q.sql",
			"+++ b/q.sql",
			"@@ -1,2 +1,2 @@",
			"--- old comment",
			"+++ new comment",
			" select 1;",
		];
		const styled = styleOutput("git diff", diff);
		expect(styled[3]).toBe(theme.fg("toolDiffRemoved", diff[3]!));
		expect(styled[4]).toBe(theme.fg("toolDiffAdded", diff[4]!));
	});

	it("resolves a search context row whose path contains `-digits-`", () => {
		const path = "app-2-x/src/a.ts";
		const styled = styleOutput("rg -n -C1 value app-2-x", [`${path}-1-const a = 0;`, `${path}:2:const value = 1;`]);
		expect(styled[0]!.startsWith(formatStyledPath(path, theme))).toBe(true);
	});
});
