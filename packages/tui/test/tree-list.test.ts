import { describe, expect, it } from "bun:test";
import { renderTreeList } from "@oh-my-pi/pi-tui/render/tree-list";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";

describe("renderTreeList overflow", () => {
	it("shows a lone hidden one-row item that fits instead of `… 1 more`, and caps at two hidden", async () => {
		const theme = (await getThemeByName("dark"))!;
		const render = (items: string[], width = 80) =>
			renderTreeList(
				{
					items,
					flush: true,
					maxCollapsed: 3,
					width,
					renderItem: item => item,
				},
				theme,
			).map(row => Bun.stripANSI(row));
		const items = (count: number) => Array.from({ length: count }, (_, i) => `item-${i}`);

		expect(render(items(4))).toEqual(["item-0", "item-1", "item-2", "item-3"]);
		expect(render(items(5))).toEqual(["item-0", "item-1", "item-2", `${theme.format.ellipsis} 2 more items`]);
		// A lone hidden row that would not fit the width keeps its marker.
		expect(render([...items(3), "x".repeat(81)])).toEqual([
			"item-0",
			"item-1",
			"item-2",
			`${theme.format.ellipsis} 1 more item`,
		]);
	});
});
