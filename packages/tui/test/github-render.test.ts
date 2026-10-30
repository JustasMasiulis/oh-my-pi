import { describe, expect, it } from "bun:test";
import { expandKeyHint } from "@oh-my-pi/pi-tui/render/render-utils";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { githubToolRenderer } from "@oh-my-pi/pi-tui/tools/github";

const SEARCH_TEXT = [
	"# GitHub pull requests search",
	"",
	"Query: is:open",
	"Results: 2",
	"",
	"- #12 fix: retry on 529",
	"  State: open",
	"  Author: dvir",
	"  Updated: 2026-10-30T11:02:10Z",
	"  URL: https://github.com/oh-my-pi/pi/pull/12",
	"",
	"- #11 docs: gallery fixtures",
	"  State: open",
	"  Author: leo",
	"  Updated: 2026-10-28T08:00:00Z",
	"  URL: https://github.com/oh-my-pi/pi/pull/11",
].join("\n");

describe("github search result card", () => {
	it("offers Ctrl+O while collapsed rows hide fields, even when every result fits", async () => {
		const theme = (await getThemeByName("dark"))!;
		const render = (expanded: boolean) =>
			Bun.stripANSI(
				githubToolRenderer
					.renderResult(
						{ content: [{ type: "text", text: SEARCH_TEXT }] },
						{ expanded, isPartial: false },
						theme,
						{ op: "search_prs", query: "is:open" },
					)
					.render(120)
					.join("\n"),
			);

		const collapsed = render(false);
		expect(collapsed).toContain("#12 fix: retry on 529");
		expect(collapsed).not.toContain("https://github.com/oh-my-pi/pi/pull/12");
		expect(collapsed).toContain(expandKeyHint());

		const expanded = render(true);
		expect(expanded).toContain("https://github.com/oh-my-pi/pi/pull/12");
		expect(expanded).not.toContain(expandKeyHint());
	});
});
