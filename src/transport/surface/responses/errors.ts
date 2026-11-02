import { GatewayError } from "../../../protocol/gateway-error";

/** Typed failures for the OpenAI Responses surface. */

/** Stable typed failure for malformed canonical sequence numbers. */
export class ResponsesSequenceError extends GatewayError {
  constructor(message: string) {
    super("invalid_sequence", 500, message);
    this.name = "ResponsesSequenceError";
  }
}

/** Stable typed failure for invalid lifecycle transitions. */
export class ResponsesLifecycleError extends GatewayError {
  constructor(message: string) {
    super("invalid_lifecycle", 500, message);
    this.name = "ResponsesLifecycleError";
  }
}
