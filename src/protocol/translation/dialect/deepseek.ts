/**
 * DeepSeek wire dialect: DSML in-band tool calls.
 *
 * The engine (`DsmlStreamParser`) lives in `src/protocol/dsml.ts` and is shared
 * with the CodeBuddy/Qoder families. This module owns the DeepSeek dialect
 * facade used by the in-band scanner factory.
 */
import { DsmlStreamParser } from "../../dsml";

export { DsmlStreamParser };
