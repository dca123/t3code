import * as Schema from "effect/Schema";
import { NonNegativeInt, ThreadId, type MessageId } from "./baseSchemas.ts";

export const ThreadVoiceEndInput = Schema.Struct({
  callId: Schema.String.check(Schema.isUUID()),
});
export const ThreadVoiceStartInput = Schema.Struct({
  ...ThreadVoiceEndInput.fields,
  threadId: ThreadId,
  sdp: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
});
export const ThreadVoiceStartResult = Schema.Struct({ sdp: Schema.String });

export const THREAD_VOICE_MAX_DURATION_MS = 300_000;

export function isThreadVoiceTranscript(messageId: MessageId): boolean {
  return messageId.startsWith("voice:") && messageId.indexOf(":", "voice:".length) !== -1;
}

const ThreadVoicePhase = Schema.Literals([
  "microphone",
  "gathering",
  "placing",
  "connecting",
  "connected",
  "reconnecting",
]);
export type ThreadVoicePhase = typeof ThreadVoicePhase.Type;

const ThreadVoiceEndReason = Schema.Literals([
  "hung-up",
  "left-thread",
  "expired",
  "microphone-blocked",
  "microphone-unavailable",
  "microphone-ended",
  "playback-blocked",
  "thread-unavailable",
  "sign-in",
  "busy",
  "disabled",
  "connection",
  "connection-lost",
  "remote-ended",
  "setup-timeout",
]);
export type ThreadVoiceEndReason = typeof ThreadVoiceEndReason.Type;

const ThreadVoiceObservation = Schema.Union([
  Schema.TaggedStruct("phase", { phase: ThreadVoicePhase }),
  Schema.TaggedStruct("end", { reason: ThreadVoiceEndReason }),
  Schema.TaggedStruct("peer", {
    connection: Schema.Literals([
      "new",
      "connecting",
      "connected",
      "disconnected",
      "failed",
      "closed",
    ]),
    ice: Schema.Literals([
      "new",
      "checking",
      "connected",
      "completed",
      "disconnected",
      "failed",
      "closed",
    ]),
    gathering: Schema.Literals(["new", "gathering", "complete"]),
    dataChannel: Schema.Literals(["connecting", "open", "closing", "closed"]),
  }),
  Schema.TaggedStruct("microphone", {
    state: Schema.Literals(["live", "ended"]),
    muted: Schema.Boolean,
    enabled: Schema.Boolean,
  }),
  Schema.TaggedStruct("playback", { state: Schema.Literals(["track", "playing", "blocked"]) }),
  Schema.TaggedStruct("inbound-audio", {
    bytesReceived: NonNegativeInt,
    totalAudioEnergy: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
    audioLevel: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  }),
]);
export type ThreadVoiceObservation = typeof ThreadVoiceObservation.Type;

export const ThreadVoiceReportInput = Schema.Struct({
  ...ThreadVoiceEndInput.fields,
  threadId: ThreadId,
  observation: ThreadVoiceObservation,
});

export class ThreadVoiceError extends Schema.TaggedError<ThreadVoiceError>()("ThreadVoiceError", {
  reason: Schema.Literals(["disabled", "thread-unavailable", "busy", "sign-in", "connection"]),
}) {}
