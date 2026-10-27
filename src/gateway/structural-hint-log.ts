import { logWarn } from "../logger.js";
import { createStructuralHintReporter } from "./http-utils.js";

/**
 * ONE per-process reporter shared by the /v1/responses and /v1/chat/completions
 * handlers, so the 10 s rate limit is per process, not per endpoint.
 */
export const reportStructuralHint = createStructuralHintReporter((message) => logWarn(message));
