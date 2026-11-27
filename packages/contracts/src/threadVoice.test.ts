import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ThreadVoiceReportInput } from "./threadVoice.ts";

describe("thread voice diagnostics", () => {
  it("drops payload text and accepts only enumerated observations", () => {
    const decode = Schema.decodeUnknownSync(ThreadVoiceReportInput);
    const call = { callId: "2006f497-3d23-41be-a785-8251703ec048", threadId: "thread" };
    expect(
      decode({
        ...call,
        observation: {
          _tag: "microphone",
          state: "live",
          muted: false,
          enabled: true,
          label: "Private mic name",
        },
        transcript: "Private transcript",
      }),
    ).toEqual({
      ...call,
      observation: { _tag: "microphone", state: "live", muted: false, enabled: true },
    });
    expect(() =>
      decode({ ...call, observation: { _tag: "end", reason: "Raw server error payload" } }),
    ).toThrow();
  });

  it("accepts only numeric inbound audio measurements in a trace observation", () => {
    const decode = Schema.decodeUnknownSync(ThreadVoiceReportInput);
    const call = { callId: "2006f497-3d23-41be-a785-8251703ec048", threadId: "thread" };
    const observation = {
      _tag: "inbound-audio",
      bytesReceived: 512,
      totalAudioEnergy: 0.01,
      audioLevel: 0.2,
    };
    expect(decode({ ...call, observation: { ...observation, sample: "Private audio" } })).toEqual({
      ...call,
      observation,
    });
    expect(() =>
      decode({ ...call, observation: { ...observation, totalAudioEnergy: Infinity } }),
    ).toThrow();
  });
});
