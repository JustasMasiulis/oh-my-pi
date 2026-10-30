import { FramedMessageComponent } from "../chrome/message-frame";
import type { MessageRenderer } from "./extension-types";
import { type CustomMessage, LIVE_DELEGATION_MESSAGE_TYPE } from "./messages";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends FramedMessageComponent<CustomMessage<unknown>> {
	constructor(message: CustomMessage<unknown>, customRenderer?: MessageRenderer) {
		const isLiveDelegation = message.customType === LIVE_DELEGATION_MESSAGE_TYPE;
		// The transcript dispatch routes both `custom` and legacy `hookMessage` roles here.
		const isHook = String(message.role) === "hookMessage";
		super({
			message,
			role: isHook ? "omp.hook" : isLiveDelegation ? "omp.custom.delegation" : "omp.custom",
			hideHeader: isLiveDelegation,
			borderColor: isLiveDelegation ? "borderAccent" : undefined,
			customRenderer,
		});
	}
}
