import { describe, expect, it } from "bun:test";
import { renderTreeList } from "@oh-my-pi/pi-tui/render/tree-list";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";

describe("renderTreeList overflow", () => {
	it("shows a lone hidden one-row item instead of `… 1 more`, and caps at two hidden", async () => {
		const theme = (await getThemeByName("dark"))!;
		const render = (count: number) =>
			renderTreeList(
				{
					items: Array.from({ length: count }, (_, i) => `item-${i}`),
					flush: true,
					maxCollapsed: 3,
					renderItem: item => item,
				},
				theme,
			).map(row => Bun.stripANSI(row));

		expect(render(4)).toEqual(["item-0", "item-1", "item-2", "item-3"]);
		expect(render(5)).toEqual(["item-0", "item-1", "item-2", `${theme.format.ellipsis} 2 more items`]);
	});
});
