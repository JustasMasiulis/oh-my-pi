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

import { formatErrorText, replaceTabs, sanitizeDisplayLines } from "../render/render-utils";

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

/** Resolve call args a resolve/reject device write stands for: the device picks the action, its content the reason. */
function resolutionDeviceArgs(device: ResolutionDeviceName, content: unknown): Partial<ResolveInvocation> {
	return {
		action: device === REJECT_DEVICE_NAME ? "discard" : "apply",
		reason: typeof content === "string" ? content : "",
	};
}

/** Streaming-safe call preview for a resolution-device write: `Resolve: apply|reject` or `Propose: <text>`. */
export function renderResolutionDeviceCall(device: ResolutionDeviceName, content: unknown, uiTheme: Theme): Component {
	if (device === PROPOSE_DEVICE_NAME) return renderDeviceCallPreview("Propose", content, uiTheme, Ellipsis.Omit);
	const args = resolutionDeviceArgs(device, content);
	return resolveRenderer.renderCall(args, { expanded: false, isPartial: true }, uiTheme);
}

/** Native form of {@link renderResolutionDeviceCall}. */
export function describeResolutionDeviceCall(device: ResolutionDeviceName, content: unknown): NativeToolView {
	if (device === PROPOSE_DEVICE_NAME) return describeDeviceCallPreview("Propose", content);
	return resolveRenderer.describeCall(resolutionDeviceArgs(device, content));
}

/** Native form of {@link renderDeviceCallPreview}: title head plus the first content line of a pending device write. */
export function describeDeviceCallPreview(title: string, content: unknown): NativeToolView {
	const body = typeof content === "string" ? (plainText(content).trim().split("\n")[0] ?? "") : "";
	return { head: toolHead(title, body || undefined) };
}

/** Header subject: `apply`, or `reject` for a discard (the reject device's name for it). */
function resolveSubject(action: string | undefined): "apply" | "reject" | undefined {
	if (!action) return undefined;
	return action === "apply" ? "apply" : "reject";
}

/** The state a resolution moves the proposal to, with its badge color. */
function resolveOutcome(subject: "apply" | "reject"): { label: "resolved" | "rejected"; color: "success" | "warning" } {
	return subject === "apply" ? { label: "resolved", color: "success" } : { label: "rejected", color: "warning" };
}

/** The staged proposal's label (`source: summary`), its source dim. */
function proposalLabelRow(uiTheme: Theme, label: string): string {
	const separatorIndex = label.indexOf(": ");
	if (separatorIndex <= 0) return uiTheme.fg("toolOutput", label);
	const source = label.slice(0, separatorIndex).trim();
	const summary = label.slice(separatorIndex + 2).trim();
	return `${uiTheme.fg("dim", `${source}:`)} ${uiTheme.fg("toolOutput", summary)}`;
}

/** The resolution reason: one italic muted row per line. */
function reasonRows(uiTheme: Theme, reason: string | undefined): string[] {
	return reason ? sanitizeDisplayLines(reason).map(line => uiTheme.italic(uiTheme.fg("muted", line))) : [];
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
		const outcome = subject ? resolveOutcome(subject) : undefined;
		const status: StatusLineOptions = {
			icon: options.executionStarted ? "running" : "pending",
			spinnerFrame: options.spinnerFrame,
			title: "Resolve",
			description: subject,
			badge: outcome
				? { label: `proposed ${uiTheme.format.arrowRight} ${outcome.label}`, color: outcome.color }
				: undefined,
		};
		const rows = reasonRows(uiTheme, args.reason?.trim());
		return plainToolCard(uiTheme, () => ({
			status,
			phase: "pending",
			body: rows.length > 0 ? rows : undefined,
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
			badge: resolveOutcome(subject),
		};
		return plainToolCard(uiTheme, () => ({
			status,
			phase: "success",
			body: [...(label ? [proposalLabelRow(uiTheme, label)] : []), ...reasonRows(uiTheme, reason)],
		}));
	},

	describeCall(args: Partial<ResolveInvocation>): NativeToolView {
		const subject = resolveSubject(args.action);
		const head: TspSpan[] = toolHead("Resolve", subject);
		if (subject) {
			const outcome = resolveOutcome(subject);
			head.push(span(" "), span(`proposed → ${outcome.label}`, outcome.color));
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
				const outcome = resolveOutcome(subject);
				head.push(span(" "), span(outcome.label, outcome.color));
			}
			const label = details?.label ? plainText(details.label) : undefined;
			const reason = details?.reason?.trim();
			const message = result.content.find(content => content.type === "text")?.text;
			const body = label ? [text([span(label)], { wrap: "word" })] : [];
			if (result.isError) body.push(noteText(message || "Resolve failed", "error"));
			else if (reason) body.push(text([span(plainText(reason), "muted")], { wrap: "word" }));
			return { head, tone: result.isError ? "error" : "success", inline: true, body };
		});
	},

	inline: true,
	mergeCallAndResult: true,
} satisfies ToolRenderer<Partial<ResolveInvocation>, ResolveDetails>;

/** Whether an xd:// device name is one of the plain-text resolution devices. */
export function isResolutionDeviceName(name: string): name is ResolutionDeviceName {
	return name === RESOLVE_DEVICE_NAME || name === REJECT_DEVICE_NAME || name === PROPOSE_DEVICE_NAME;
}
