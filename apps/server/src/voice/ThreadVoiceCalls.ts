import {
  CommandId,
  EventId,
  MessageId,
  THREAD_VOICE_MAX_DURATION_MS,
  ThreadVoiceError,
  TurnItemId,
  type ThreadId,
  type RunId,
  type ThreadVoiceReportInput,
  type ThreadVoiceStartInput,
  type ThreadVoiceStartResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as GptLiveCall from "./GptLiveCall.ts";
import { liveConversation, speakableAppends } from "./LiveConversation.ts";

type CallConnection = {
  readonly enabled: boolean;
  readonly start: (
    input: typeof ThreadVoiceStartInput.Type,
  ) => Effect.Effect<typeof ThreadVoiceStartResult.Type, ThreadVoiceError>;
  readonly end: (callId: string) => Effect.Effect<void>;
  readonly report: (input: typeof ThreadVoiceReportInput.Type) => Effect.Effect<void>;
};

export class ThreadVoiceCalls extends Context.Service<
  ThreadVoiceCalls,
  {
    readonly connection: Effect.Effect<CallConnection, never, Scope.Scope>;
  }
>()("t3/voice/ThreadVoiceCalls") {}

export const disabledConnection: CallConnection = {
  enabled: false,
  start: () => Effect.fail(new ThreadVoiceError({ reason: "disabled" })),
  end: () => Effect.void,
  report: () => Effect.void,
};
export const layerDisabled = Layer.succeed(ThreadVoiceCalls, {
  connection: Effect.succeed(disabledConnection),
});

type LiveEvent = ReturnType<ReturnType<typeof liveConversation>["receive"]>;
type Completion = { readonly type: "completion"; readonly epoch: number; readonly text: string };

const make = Effect.gen(function* () {
  const enabled = yield* Config.Boolean("T3CODE_EXPERIMENTAL_THREAD_VOICE").pipe(
    Config.withDefault(false),
    Effect.orElseSucceed(() => false),
  );
  if (!enabled) return ThreadVoiceCalls.of({ connection: Effect.succeed(disabledConnection) });
  const threads = yield* ThreadManagement.ThreadManagementService;
  const events = yield* EventSink.EventSinkV2;
  const random = yield* SecureRandom.SecureRandom;
  const fileContext = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | SecureRandom.SecureRandom
  >();
  const reservations = new Set<ThreadId>();

  const runCall = Effect.fn("ThreadVoiceCalls.run")(function* (
    input: typeof ThreadVoiceStartInput.Type,
    thread: NonNullable<Effect.Success<ReturnType<typeof threads.getThreadShell>>>,
    ready: Deferred.Deferred<typeof ThreadVoiceStartResult.Type, ThreadVoiceError>,
  ) {
    yield* Effect.annotateCurrentSpan({ callId: input.callId, threadId: input.threadId });
    const offer = yield* GptLiveCall.open(input.sdp).pipe(Effect.provideContext(fileContext));
    yield* Deferred.succeed(ready, { sdp: offer.sdp });
    yield* Effect.logDebug("Thread voice call created");
    const live = yield* offer.connect;
    yield* Effect.logDebug("Thread voice call connected");

    const conversation = liveConversation();
    const pending = yield* Queue.bounded<LiveEvent | Completion>(128);
    const scope = yield* Scope.Scope;
    let active: { runId: RunId; delegationId: string; generation: number; epoch: number } | null =
      null;
    const steeredUtterances = new Map<string, number>();
    let epoch = 0;
    const target = { projectId: thread.projectId, threadId: input.threadId };

    const record = Effect.fn("ThreadVoiceCalls.recordTranscript")(function* (
      event: Extract<LiveEvent, { type: "transcript" }>,
    ) {
      const now = yield* DateTime.now;
      const messageId = MessageId.make(`voice:${input.callId}:${event.id}`);
      const transcript = {
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        text: event.text,
        attachments: [],
        updatedAt: now,
      } as const;
      const provenance = { createdBy: "system", creationSource: "server" } as const;
      yield* events
        .write({
          events: [
            {
              type: "message.updated",
              id: EventId.make(yield* random.uuidV4()),
              threadId: input.threadId,

              occurredAt: now,
              payload: {
                ...transcript,
                ...provenance,
                id: messageId,
                role: event.role,
                streaming: false,
                createdAt: now,
              },
            },
            {
              type: "turn-item.updated",
              id: EventId.make(yield* random.uuidV4()),
              threadId: input.threadId,
              occurredAt: now,
              payload: {
                ...transcript,
                id: TurnItemId.make(messageId),
                messageId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                ...(event.role === "user"
                  ? { type: "user_message", inputIntent: "turn_start", ...provenance }
                  : { type: "assistant_message", streaming: false }),
              },
            },
          ],
        })
        .pipe(Effect.mapError(GptLiveCall.connectionFailure));
    });

    const reply = Effect.fn("ThreadVoiceCalls.finalAnswer")(function* (runId: RunId) {
      const { run } = yield* threads.waitForThread({ ...target, runId, timeoutMs: 300_000 });
      if (run?.status !== "completed") return "";
      const records = yield* threads.getThreadRecords(input.threadId, ["messages", "turnItems"], {
        messageRunIds: [runId],
        turnItemRunIds: [runId],
        turnItemTypes: ["assistant_message"],
      });
      const last = records.turnItems
        .filter(
          (item) =>
            item.type === "assistant_message" &&
            item.status === "completed" &&
            item.delivery !== "async" &&
            (item.phase === undefined || item.phase === "final_answer"),
        )
        .toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (last?.type !== "assistant_message") return "";
      const message = records.messages.find((message) => message.id === last.messageId);
      return message?.text ?? last.text;
    });

    const submit = Effect.fn("ThreadVoiceCalls.submit")(function* (
      text: string,
      delivery: { type: "turn" } | { type: "steer"; runId: RunId },
      delegationId: string,
      generation: number,
    ) {
      const id = yield* random.uuidV4();
      const sent = yield* threads
        .sendToThread({
          ...target,
          commandId: CommandId.make(`voice:${id}`),
          messageId: MessageId.make(`voice:${id}`),
          text,
          attachments: [],
          mode: delivery.type === "steer" ? "steer" : "queue",
          ...(delivery.type === "steer" ? { steerTargetRunId: delivery.runId } : {}),
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.catchTags({ ThreadManagementNoSteerableRunError: () => Effect.succeed(null) }),
          Effect.mapError(GptLiveCall.connectionFailure),
        );
      if (sent === null) return false;
      const runId = sent.run.id;
      const turnEpoch = ++epoch;
      active = { runId, delegationId, generation, epoch: turnEpoch };
      yield* Effect.logDebug("Thread voice input delivered", { delivery: sent.delivery });
      yield* reply(runId).pipe(
        Effect.orElseSucceed(() => ""),
        Effect.flatMap((text) =>
          Queue.offer(pending, { type: "completion", epoch: turnEpoch, text }),
        ),
        Effect.forkIn(scope),
      );
      return true;
    });

    const readFrames = Effect.gen(function* () {
      while (true) {
        const frames = yield* live.reader.pull.pipe(Effect.mapError(GptLiveCall.connectionFailure));
        for (const frame of frames) {
          const event = conversation.receive(frame);
          if (event.type !== "ignore") yield* Queue.offer(pending, event);
        }
      }
    });
    const handleEvents = Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(pending);
        switch (event.type) {
          case "closed":
            return;
          case "ignore":
            break;
          case "ack":
            yield* Effect.logDebug("Thread voice speakable append acknowledged");
            break;
          case "transcript": {
            if (event.text) yield* record(event);
            if (event.text && event.canSteer && active !== null) {
              const { runId, delegationId } = active;
              if (
                yield* submit(event.text, { type: "steer", runId }, delegationId, event.generation)
              ) {
                steeredUtterances.set(event.id, epoch);
              }
            }
            break;
          }
          case "delegation": {
            const steered =
              event.userTurn === null ? undefined : steeredUtterances.get(event.userTurn);
            if (steered !== undefined) {
              if (active !== null && active.epoch === steered) {
                active = { ...active, delegationId: event.id, generation: event.generation };
              }
              break;
            }
            yield* Effect.logDebug("Thread voice received a handoff");
            if (
              active !== null &&
              (yield* submit(
                event.prompt,
                { type: "steer", runId: active.runId },
                event.id,
                event.generation,
              ))
            )
              break;
            yield* submit(event.prompt, { type: "turn" }, event.id, event.generation);
            break;
          }
          case "completion": {
            if (active === null || active.epoch !== event.epoch) break;
            const { delegationId, generation } = active;
            active = null;
            const appends = speakableAppends({
              delegationId,
              generation,
              currentGeneration: conversation.generation(),
              finalAnswer: event.text,
            });
            for (const append of appends) {
              if (generation !== conversation.generation()) break;
              yield* live.writer.write(append).pipe(Effect.mapError(GptLiveCall.connectionFailure));
            }
            if (appends.length > 0)
              yield* Effect.logDebug("Thread voice appended a final answer", {
                chunks: appends.length,
              });
            break;
          }
        }
      }
    });
    yield* Effect.raceFirst(readFrames, handleEvents);
  });

  const connection = Effect.gen(function* () {
    const owner = yield* Scope.Scope;
    let current: { id: string; scope: Scope.Closeable } | null = null;
    const start: CallConnection["start"] = Effect.fn("ThreadVoiceCalls.start")(function* (input) {
      if (!enabled) return yield* new ThreadVoiceError({ reason: "disabled" });
      yield* Effect.annotateCurrentSpan({ callId: input.callId, threadId: input.threadId });
      const thread = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(GptLiveCall.connectionFailure));
      if (thread === null || thread.deletedAt !== null || thread.archivedAt !== null) {
        return yield* new ThreadVoiceError({ reason: "thread-unavailable" });
      }
      const ready = yield* Deferred.make<typeof ThreadVoiceStartResult.Type, ThreadVoiceError>();
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if (current !== null || reservations.has(input.threadId))
            return yield* new ThreadVoiceError({ reason: "busy" });
          const scope = yield* Scope.fork(owner);
          reservations.add(input.threadId);
          current = { id: input.callId, scope };
          const release = Effect.sync(() => {
            current = null;
            reservations.delete(input.threadId);
          });
          yield* runCall(input, thread, ready).pipe(
            Effect.scoped,
            Effect.timeoutOption(THREAD_VOICE_MAX_DURATION_MS),
            Effect.onExit((exit) => {
              let reason = "upstream-failed";
              if (Exit.isSuccess(exit))
                reason = Option.isNone(exit.value) ? "expired" : "upstream-ended";
              else if (Cause.hasInterruptsOnly(exit.cause)) reason = "cancelled";
              return Effect.withSpan(
                Deferred.complete(
                  ready,
                  Exit.isFailure(exit)
                    ? Effect.failCause(exit.cause)
                    : Effect.fail(GptLiveCall.connectionFailure()),
                ),
                "ThreadVoiceCalls.finished",
                { attributes: { callId: input.callId, threadId: input.threadId, reason } },
              );
            }),
            Effect.ensuring(release),
            Effect.interruptible,
            Effect.forkIn(scope, { startImmediately: true }),
          );
        }),
      );
      return yield* Deferred.await(ready);
    });
    const end = Effect.fn("ThreadVoiceCalls.end")(function* (callId: string) {
      yield* Effect.annotateCurrentSpan({ callId });
      if (current?.id === callId) yield* Scope.close(current.scope, Exit.void);
    });
    const report: CallConnection["report"] = Effect.fn("ThreadVoiceCalls.report")(function* ({
      callId,
      threadId,
      observation: { _tag, ...fields },
    }) {
      yield* Effect.annotateCurrentSpan({ callId, threadId, observation: _tag, ...fields });
    });
    return { enabled, start, end, report };
  });
  return ThreadVoiceCalls.of({ connection });
});

export const layer = Layer.effect(ThreadVoiceCalls, make);
