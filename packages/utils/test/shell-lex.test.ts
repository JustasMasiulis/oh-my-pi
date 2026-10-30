import { describe, expect, it } from "bun:test";
import { lexShellCommand } from "@oh-my-pi/pi-utils";

describe("lexShellCommand", () => {
	it("splits words from separators, keeping verbatim spelling beside the quote-removed value", () => {
		const command = `git -C "my repo" log && echo 'a b' 2>&1`;
		const tokens = lexShellCommand(command);
		// Rewriters reassemble commands from `raw`, so the pieces must reproduce the input exactly.
		expect(tokens.map(token => token.raw).join("")).toBe(command);
		expect(tokens.filter(token => token.kind === "word").map(token => token.value)).toEqual([
			"git",
			"-C",
			"my repo",
			"log",
			"echo",
			"a b",
			"2>",
			"1",
		]);
	});
});
