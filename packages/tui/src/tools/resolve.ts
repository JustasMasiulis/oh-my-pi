import type { ToolRenderer } from "./renderer";

import type { Component } from "../index";

import type { NativeToolView, RenderResultOptions } from "./renderer";

import type { TspSpan } from "@oh-my-pi/pi-wire";
import { span, text } from "../native/describe";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { noteText, toolHead } from "./native-view";

import type { Theme } from "../theme/theme";

import { Ellipsis, truncateToWidth } from "../render";
import type { StatusLineOptions } from "../render/status-line";
import { plainToolCard } from "../render/tool-card";

import { formatErrorText, replaceTabs } from "../render/render-utils";

/** Device name for applying a staged action. */
export const RESOLVE_DEVICE_NAME = "resolve";

/** Device name for discarding a staged action. */
export const REJECT_DEVICE_NAME = "reject";

/** Device name for submitting a plan. */
export const PROPOSE_DEVICE_NAME = "propose";

/** Plain-text staged-action device names. */
export type ResolutionDeviceName = typeof RESOLVE_DEVICE_NAME | typeof REJECT_DEVICE_NAME | typeof PROPOSE_DEVICE_NAME;

/** Resolution applied to a staged action. */
export type ResolveAction = "apply" | "discard";

/** Details payload carried on a resolve/reject dispatch result (`XdevDispatch.inner`). */
export interface ResolveDetails {
	action: ResolveAction;
	reason: string;
	sourceToolName?: string;
	label?: string;
	sourceResultDetails?: unknown;
}

/** Invoker input for queued pending-preview handlers. */
export interface ResolveInvocation {
	action: ResolveAction;
	reason: string;
}

/** Streaming-safe call preview for a resolution-device write: `Resolve: apply|reject` or `Propose: <text>`. */
export function renderResolutionDeviceCall(device: ResolutionDeviceName, content: unknown, uiTheme: Theme): Component {
	if (device === PROPOSE_DEVICE_NAME) return renderDeviceCallPreview("Propose", content, uiTheme, Ellipsis.Omit);
	return resolveRenderer.renderCall(
		{
			action: device === REJECT_DEVICE_NAME ? "discard" : "apply",
			reason: typeof content === "string" ? content : "",
		},
		{ expanded: false, isPartial: true },
		uiTheme,
	);
}

/** Native form of {@link renderResolutionDeviceCall}. */
export function describeResolutionDeviceCall(device: ResolutionDeviceName, content: unknown): NativeToolView {
	if (device === PROPOSE_DEVICE_NAME) return describeDeviceCallPreview("Propose", content);
	return resolveRenderer.describeCall({
		action: device === REJECT_DEVICE_NAME ? "discard" : "apply",
		reason: typeof content === "string" ? content : "",
	});
}

/** Native form of {@link renderDeviceCallPreview}: title head plus the first content line of a pending device write. */
export function describeDeviceCallPreview(title: string, content: unknown): NativeToolView {
	const body = typeof content === "string" ? (plainText(content).trim().split("\n")[0] ?? "") : "";
	return { head: toolHead(title, body || undefined) };
}

/**
 * Header subject: `apply`, or `reject` for a discard. Call args name the
 * discard `reject` (the device name) or `discard` (the details action).
 */
function resolveSubject(action: string | undefined): "apply" | "reject" | undefined {
	if (!action) return undefined;
	return action === "apply" ? "apply" : "reject";
}

/** The staged proposal's label (`source: summary`), its source dim. */
function proposalLabelRow(uiTheme: Theme, label: string): string {
	const separatorIndex = label.indexOf(": ");
	if (separatorIndex <= 0) return uiTheme.fg("toolOutput", label);
	const source = label.slice(0, separatorIndex).trim();
	const summary = label.slice(separatorIndex + 2).trim();
	return `${uiTheme.fg("dim", `${source}:`)} ${uiTheme.fg("toolOutput", summary)}`;
}

const resolveResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Render the first content line of a pending device write. */
export function renderDeviceCallPreview(
	title: string,
	content: unknown,
	uiTheme: Theme,
	ellipsis?: Ellipsis,
): Component {
	const body = typeof content === "string" ? replaceTabs(content.trim().split("\n")[0] ?? "") : "";
	return plainToolCard(uiTheme, () => ({
		status: {
			icon: "pending",
			title,
			description: body ? truncateToWidth(body, 72, ellipsis) : undefined,
		},
	}));
}

/** Render staged-action acceptance or rejection. */
export const resolveRenderer = {
	renderCall(args: Partial<ResolveInvocation>, options: RenderResultOptions, uiTheme: Theme): Component {
		const subject = resolveSubject(args.action);
		const status: StatusLineOptions = {
			icon: options.executionStarted ? "running" : "pending",
			spinnerFrame: options.spinnerFrame,
			title: "Resolve",
			description: subject,
			badge: subject
				? {
						label: `proposed ${uiTheme.format.arrowRight} ${subject === "apply" ? "resolved" : "rejected"}`,
						color: subject === "apply" ? "success" : "warning",
					}
				: undefined,
		};
		const reason = args.reason?.trim();
		return plainToolCard(uiTheme, () => ({
			status,
			phase: "pending",
			body: reason ? [uiTheme.italic(uiTheme.fg("muted", replaceTabs(reason)))] : undefined,
		}));
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: ResolveDetails; isError?: boolean },
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: Partial<ResolveInvocation>,
	): Component {
		const details = result.details;
		const subject = resolveSubject(details?.action ?? args?.action) ?? "apply";
		const label = details?.label ? replaceTabs(details.label) : undefined;
		const reason = (details?.reason ?? args?.reason)?.trim();

		if (result.isError) {
			const message = result.content.find(content => content.type === "text")?.text;
			return plainToolCard(uiTheme, () => ({
				status: { icon: "error", title: "Resolve", description: subject },
				phase: "error",
				body: [
					...(label ? [proposalLabelRow(uiTheme, label)] : []),
					formatErrorText(message || "Resolve failed", uiTheme),
				],
			}));
		}

		const status: StatusLineOptions = {
			icon: "success",
			title: "Resolve",
			description: subject,
			badge: subject === "apply" ? { label: "resolved", color: "success" } : { label: "rejected", color: "warning" },
		};
		return plainToolCard(uiTheme, () => ({
			status,
			phase: "success",
			body: [
				...(label ? [proposalLabelRow(uiTheme, label)] : []),
				...(reason ? [uiTheme.italic(uiTheme.fg("muted", replaceTabs(reason)))] : []),
			],
		}));
	},

	describeCall(args: Partial<ResolveInvocation>): NativeToolView {
		const subject = resolveSubject(args.action);
		const head: TspSpan[] = toolHead("Resolve", subject);
		if (subject) {
			head.push(
				span(" "),
				span(
					subject === "apply" ? "proposed → resolved" : "proposed → rejected",
					subject === "apply" ? "success" : "warning",
				),
			);
		}
		const reason = args.reason?.trim();
		return { head, inline: true, body: reason ? [noteText(reason, "muted", 1)] : undefined };
	},

	describeResult(result: {
		content: Array<{ type: string; text?: string }>;
		details?: ResolveDetails;
		isError?: boolean;
	}): NativeToolView | undefined {
		return resolveResultMemo.get(result, [], () => {
			const details = result.details;
			const subject = resolveSubject(details?.action) ?? "apply";
			const head: TspSpan[] = toolHead("Resolve", subject);
			if (!result.isError) {
				head.push(
					span(" "),
					span(subject === "apply" ? "resolved" : "rejected", subject === "apply" ? "success" : "warning"),
				);
			}
			const label = details?.label ? plainText(details.label) : undefined;
			const reason = details?.reason?.trim();
			const message = result.content.find(content => content.type === "text")?.text;
			return {
				head,
				tone: result.isError ? "error" : "success",
				inline: true,
				body: [
					...(label ? [text([span(label)], { wrap: "word" })] : []),
					...(result.isError
						? [noteText(message || "Resolve failed", "error")]
						: reason
							? [text([span(plainText(reason), "muted")], { wrap: "word" })]
							: []),
				],
			};
		});
	},

	inline: true,
	mergeCallAndResult: true,
} satisfies ToolRenderer<Partial<ResolveInvocation>, ResolveDetails>;

/** Whether an xd:// device name is one of the plain-text resolution devices. */
export function isResolutionDeviceName(name: string): name is ResolutionDeviceName {
	return name === RESOLVE_DEVICE_NAME || name === REJECT_DEVICE_NAME || name === PROPOSE_DEVICE_NAME;
}
