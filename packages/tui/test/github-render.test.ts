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

	it("shows a single result's lone hidden field outright instead of offering Ctrl+O", async () => {
		const theme = (await getThemeByName("dark"))!;
		const text = ["Results: 1", "", "- #12 fix: retry on 529", "  URL: https://github.com/oh-my-pi/pi/pull/12"].join(
			"\n",
		);
		const collapsed = Bun.stripANSI(
			githubToolRenderer
				.renderResult({ content: [{ type: "text", text }] }, { expanded: false, isPartial: false }, theme, {
					op: "search_prs",
					query: "is:open",
				})
				.render(120)
				.join("\n"),
		);
		expect(collapsed).toContain("https://github.com/oh-my-pi/pi/pull/12");
		expect(collapsed).not.toContain(expandKeyHint());
	});
});

describe("github fallback output card", () => {
	it("shows one line past the collapsed cap instead of a `… 1 more line` row", async () => {
		const theme = (await getThemeByName("dark"))!;
		const rows = Array.from({ length: 9 }, (_, i) => `row ${i}`).join("\n");
		const render = (text: string) =>
			Bun.stripANSI(
				githubToolRenderer
					.renderResult({ content: [{ type: "text", text }] }, { expanded: false, isPartial: false }, theme, {
						op: "repo_view",
					})
					.render(120)
					.join("\n"),
			);
		const single = render(rows);
		expect(single).toContain("row 8");
		expect(single).not.toContain("more line");

		const capped = render(`${rows}\nrow 9`);
		expect(capped).not.toContain("row 8");
		expect(capped).toContain("2 more lines");
	});
});
