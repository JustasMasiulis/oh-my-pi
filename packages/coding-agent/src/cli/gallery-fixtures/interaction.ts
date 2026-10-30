/** Gallery fixtures for the todo / ask / resolve interaction tools. */
import type { GalleryFixture } from "./types";

export const interactionFixtures: Record<string, GalleryFixture> = {
	// The resolution devices: one `reason` decides the latest staged proposal,
	// which the details name by its staging tool's label.
	resolve: {
		streamingArgs: { action: "apply", reason: "The rename touches only" },
		args: { action: "apply", reason: "The rename touches only tokens.ts and matches the request." },
		result: {
			content: [{ type: "text", text: "Applied the staged proposal." }],
			details: {
				action: "apply",
				reason: "The rename touches only tokens.ts and matches the request.",
				sourceToolName: "ast_edit",
				label: "AST Edit: 2 replacements in 1 file",
			},
		},
		errorResult: {
			content: [{ type: "text", text: "Error: the staged proposal no longer applies cleanly" }],
			isError: true,
			details: {
				action: "apply",
				reason: "The rename touches only tokens.ts and matches the request.",
				sourceToolName: "ast_edit",
				label: "AST Edit: 2 replacements in 1 file",
			},
		},
	},
	reject: {
		streamingArgs: { action: "discard", reason: "The patch would also" },
		args: { action: "discard", reason: "The patch would also delete the migration script." },
		result: {
			content: [{ type: "text", text: "Discarded the staged proposal." }],
			details: {
				action: "discard",
				reason: "The patch would also delete the migration script.",
				sourceToolName: "ast_edit",
				label: "AST Edit: 5 replacements in 3 files",
			},
		},
		errorResult: {
			content: [{ type: "text", text: "Error: no staged proposal is pending" }],
			isError: true,
			details: { action: "discard", reason: "The patch would also delete the migration script." },
		},
	},
	todo: {
		label: "Todo",
		streamingArgs: {
			op: "init",
			list: [{ phase: "Foundation", items: ["Scaffold crate"] }],
		},
		args: {
			op: "init",
			list: [
				{ phase: "Foundation", items: ["Scaffold crate", "Wire workspace"] },
				{ phase: "Auth", items: ["Port credential store", "Wire OAuth providers"] },
			],
		},
		result: {
			content: [{ type: "text", text: "Initialized 4 tasks across 2 phases" }],
			details: {
				storage: "session",
				phases: [
					{
						name: "Foundation",
						tasks: [
							{ content: "Scaffold crate", status: "completed" },
							{ content: "Wire workspace", status: "in_progress" },
						],
					},
					{
						name: "Auth",
						tasks: [
							{ content: "Port credential store", status: "pending" },
							{ content: "Wire OAuth providers", status: "pending" },
						],
					},
				],
				completedTasks: [{ phase: "Foundation", content: "Scaffold crate" }],
			},
		},
		errorResult: {
			content: [{ type: "text", text: "Unknown phase 'Auth' — initialize the list first" }],
			isError: true,
		},
	},
};
