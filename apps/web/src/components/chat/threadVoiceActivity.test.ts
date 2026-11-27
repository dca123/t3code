import { describe, expect, it } from "vite-plus/test";
import { emptyVoiceActivity, receiveVoiceActivity } from "./threadVoiceActivity";

describe("thread voice activity", () => {
  it("retains each speaker's transcript and times the matching GPT-Live handoff", () => {
    let activity = emptyVoiceActivity;
    for (const [now, frame] of [
      [0, { type: "input_transcript.added", item: { text: "Ask the " } }],
      [50, { type: "input_transcript.added", item: { text: "thread" } }],
      [100, { type: "delegation.created", item: { id: "first" } }],
      [500, { type: "delegation.created", item: { id: "second" } }],
      [900, { type: "delegation.context.appended", delegation_item_id: "second" }],
      [950, { type: "delegation.context.appended", delegation_item_id: "second" }],
      [1000, { type: "output_transcript.added", item: { text: "99." } }],
      [1100, { type: "turn.done", turn: { role: "assistant", transcript: "99.79 inches" } }],
    ] as const) {
      const received = receiveVoiceActivity(JSON.stringify(frame), now);
      if (received.type === "activity") activity = received.update(activity);
    }
    expect(activity).toEqual({
      transcript: {
        user: { text: "Ask the thread", complete: false },
        assistant: { text: "99.79 inches", complete: true },
      },
      handoffs: [
        { id: "first", started: 100, answered: null },
        { id: "second", started: 500, answered: 900 },
      ],
    });
  });
});
