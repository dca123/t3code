import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { ThreadVoiceError } from "@t3tools/contracts";
import { expect, vi } from "vite-plus/test";
import * as GptLiveCall from "./GptLiveCall.ts";

const encodeError = Schema.encodeSync(ThreadVoiceError);
const authFile = (expiry: number) => {
  const accessToken = `header.${Buffer.from(JSON.stringify({ exp: expiry })).toString("base64url")}.fixture-secret`;
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: accessToken, account_id: "fixture-account" },
  });
};
const openWithAuth = (auth: string) =>
  GptLiveCall.open("v=0\r\n").pipe(
    Effect.provide(FileSystem.layerNoop({ readFileString: () => Effect.succeed(auth) })),
    Effect.provide(Path.layer),
    Effect.provide(SecureRandom.layerWebCrypto),
    Effect.flip,
  );

it.effect("asks for a new Codex sign-in before sending an expired credential", () =>
  Effect.gen(function* () {
    using request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 401 }));
    const error = yield* openWithAuth(authFile(-1));
    expect(encodeError(error)).toEqual({ _tag: "ThreadVoiceError", reason: "sign-in" });
    expect(request).not.toHaveBeenCalled();
  }),
);

it.effect("does not serialize a rejected upstream request or response containing credentials", () =>
  Effect.gen(function* () {
    const secret = authFile(2_000_000_000);
    using request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(secret, { status: 401 }));
    const error = yield* openWithAuth(secret);
    expect(request).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          authorization: expect.stringContaining("fixture-secret"),
        }),
      }),
    );
    expect(encodeError(error)).toEqual({ _tag: "ThreadVoiceError", reason: "sign-in" });
  }),
);
