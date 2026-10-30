import type { BackgroundTanDispatchDetails, CustomMessage } from "./messages";
import { replaceTabs, truncateToWidth } from "../render/render-utils";
import { theme } from "../theme";
import type { TranscriptBlock } from "../chrome/transcript-container";
import { TranscriptStatusBlock } from "../chrome/transcript-status";
import { span } from "../native/describe";

const TAN_WORK_PREVIEW_LENGTH = 56;

function previewWork(work: string): string {
	return truncateToWidth(replaceTabs(work).trim().replace(/\s+/g, " "), TAN_WORK_PREVIEW_LENGTH);
}

/**
 * Single-line transcript pill for a `/tan` background-dispatch breadcrumb,
 * styled as a sibling of the "Background job completed" line. The full
 * system-notice content (the persisted `content`) is for the model only — the
 * user sees one compact line, not the raw `<system-notice>` block.
 */
export function createBackgroundTanDispatchBlock(message: CustomMessage<unknown>): TranscriptBlock {
	const details = (message as CustomMessage<Partial<BackgroundTanDispatchDetails>>).details;
	const jobId = details?.jobId ?? "unknown";
	const work = details?.work ? previewWork(details.work) : undefined;
	const spans = [span("Tangent dispatched"), span(" · ", "dim"), span(`task ${jobId}`, "dim")];
	if (work) spans.push(span(" · ", "dim"), span(work, "dim"));
	return new TranscriptStatusBlock([
		{
			parts: [
				{ text: theme.status.info, color: "accent" },
				{ text: "Tangent dispatched", color: "muted" },
				{ text: "[task]", color: "dim" },
				{ text: jobId, color: "accent" },
				work ? { text: `${theme.format.dash} ${work}`, color: "dim" } : undefined,
			],
			native: { tone: "info", icon: "output", message: spans },
		},
	]);
}
