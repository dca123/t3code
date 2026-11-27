import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const ThreadVoiceEndInput = Schema.Struct({
  callId: Schema.String.check(Schema.isUUID()),
});
export const ThreadVoiceStartInput = Schema.Struct({
  ...ThreadVoiceEndInput.fields,
  threadId: ThreadId,
  sdp: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
});
export const ThreadVoiceStartResult = Schema.Struct({ sdp: Schema.String });

export class ThreadVoiceError extends Schema.TaggedError<ThreadVoiceError>()("ThreadVoiceError", {
  reason: Schema.Literals(["disabled", "thread-unavailable", "busy", "sign-in", "connection"]),
}) {}
