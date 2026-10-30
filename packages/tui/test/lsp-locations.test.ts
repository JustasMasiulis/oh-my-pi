import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "../src/theme";
import { lspToolRenderer } from "../src/tools/lsp";

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("dark"))!;
	setThemeInstance(theme);
});

describe("LSP definition locations", () => {
	it("counts in the header and shows each location over its source, keeping the marker for a hidden snippet", () => {
		const text = [
			"Found 3 definition(s):",
			"  src/a.ts:42:17",
			"    41: ",
			"    42: export function validate(token: string) {",
			"    43:   return token;",
			"  src/b.ts:7:3",
			"    6: // overload",
			"    7: function validate(): void;",
			"    8: ",
			"  src/c.d.ts:1:1",
			"    1: declare function validate(): void;",
			"    2: ",
		].join("\n");
		const rows = lspToolRenderer
			.renderResult({ content: [{ type: "text", text }] }, { expanded: false, isPartial: false }, theme, {
				action: "definition",
			})
			.render(100)
			.map(row => Bun.stripANSI(row).trimEnd());
		expect(rows[0]).toEndWith("3 definitions");
		expect(rows.slice(1, -1)).toEqual([
			"  src/a.ts:42:17",
			"   41│",
			"  *42│export function validate(token: string) {",
			"   43│  return token;",
			"  src/b.ts:7:3",
			"   6│// overload",
			"  *7│function validate(): void;",
			"   8│",
		]);
		// The hidden location spans its row and its source: the marker stays.
		expect(rows.at(-1)).toStartWith("  … 1 more definition");
	});
});
