import * as NodeWS from "@effect/platform-node/NodeWS";
import { ThreadVoiceError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as NodeOS from "node:os";

const CREATE_URL =
  "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const SIDEBAND_ORIGIN = "wss://api.openai.com/v1/live/";
const instructions =
  "Keep greetings and small talk brief. For questions that require research, reasoning, or calculations, " +
  "delegate the question to the thread's agent before answering. When the agent replies, relay its answer faithfully, including any caveats.";

const decodeAuth = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      auth_mode: Schema.Literal("chatgpt"),
      tokens: Schema.Struct({
        access_token: Schema.String.check(Schema.isMinLength(1)),
        account_id: Schema.String.check(Schema.isMinLength(1)),
      }),
    }),
  ),
);
const decodeExpiry = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ exp: Schema.Number })),
);

const signIn = () => new ThreadVoiceError({ reason: "sign-in" });
export const connectionFailure = () => new ThreadVoiceError({ reason: "connection" });

const readAuth = Effect.fn("GptLiveCall.readAuth")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const auth = yield* fs
    .readFileString(path.join(NodeOS.homedir(), ".codex", "auth.json"))
    .pipe(Effect.flatMap(decodeAuth), Effect.mapError(signIn));
  const encoded = auth.tokens.access_token.split(".")[1];
  if (encoded === undefined) return yield* signIn();
  const expiry = yield* Effect.try({
    try: () => decodeExpiry(Buffer.from(encoded, "base64url").toString("utf8")).exp,
    catch: signIn,
  });
  if (expiry * 1_000 <= (yield* Clock.currentTimeMillis)) return yield* signIn();
  return auth.tokens;
});

const sidebandConstructor = Layer.effect(
  Socket.WebSocketConstructor,
  Effect.gen(function* () {
    const make = yield* Socket.WebSocketConstructor;
    return (url, options) => {
      const socket = make(url, options);
      // During cancellation Effect can remove its listeners before ws emits its close error.
      socket.addEventListener("error", () => undefined);
      return socket;
    };
  }),
).pipe(Layer.provide(NodeWS.layerWebSocketConstructor));

// @effect-diagnostics-next-line globalFetch:off - Keep Codex credentials outside the instrumented HTTP client.
const fetchCall = (init: RequestInit) => fetch(CREATE_URL, init);

async function createCall(sdp: string, headers: Record<string, string>, signal: AbortSignal) {
  const response = await fetchCall({
    method: "POST",
    headers: { ...headers, "content-type": "application/json", accept: "*/*" },
    redirect: "error",
    signal,
    body: JSON.stringify({
      sdp,
      session: {
        instructions,
        audio: { output: { voice: "cove" } },
        delegation: { type: "client" },
        model: "gpt-live-1-codex",
      },
    }),
  });
  if (response.status !== 201) {
    await response.body?.cancel();
    return { type: "rejected", status: response.status } as const;
  }
  return {
    type: "created",
    callId: response.headers.get("location")?.split("?")[0]?.split("/").at(-1),
    answer: await response.text(),
  } as const;
}

export const open = Effect.fn("GptLiveCall.open")(function* (sdp: string) {
  const tokens = yield* readAuth();
  const random = yield* SecureRandom.SecureRandom;
  const sessionId = yield* random.uuidV4();
  const headers = {
    authorization: `Bearer ${tokens.access_token}`,
    "chatgpt-account-id": tokens.account_id,
    "openai-alpha": "quicksilver=v2",
    version: "0.166.0",
    "x-session-id": sessionId,
    "session-id": sessionId,
    "thread-id": sessionId,
    originator: "t3_code",
    "user-agent": "t3_code/0.166.0",
  };
  const result = yield* Effect.tryPromise({
    try: (signal) => createCall(sdp, headers, signal),
    catch: connectionFailure,
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(connectionFailure()),
    }),
  );
  if (result.type === "rejected") {
    return yield* result.status === 401 ? signIn() : connectionFailure();
  }
  const { callId, answer } = result;
  if (
    callId === undefined ||
    !/^(?:rtc_[A-Za-z0-9_-]{1,200}|[0-9a-f-]{36})$/i.test(callId) ||
    !/^v=0\r?\n/.test(answer) ||
    answer.includes(tokens.access_token) ||
    answer.includes(tokens.account_id)
  ) {
    return yield* connectionFailure();
  }
  const socket = yield* Socket.makeWebSocket(SIDEBAND_ORIGIN + callId, {
    headers,
    openTimeout: "25 seconds",
    highWaterMark: 256 * 1024,
  }).pipe(Effect.provide(sidebandConstructor));
  const connect = Effect.gen(function* () {
    const reader = yield* socket.reader.pipe(Effect.mapError(connectionFailure));
    const writer = yield* socket.writer;
    yield* Effect.addFinalizer(() =>
      writer
        .write('{"type":"session.close"}')
        .pipe(Effect.timeoutOption("2 seconds"), Effect.ignoreCause),
    );
    return { reader, writer };
  });
  return { sdp: answer, connect };
});
