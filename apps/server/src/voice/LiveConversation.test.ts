import { expect, it } from "vite-plus/test";
import { liveConversation, speakableAppends } from "./LiveConversation.ts";

const spoken = (text: string) => JSON.stringify({ type: "input_transcript.added", item: { text } });
const utterance = (id: string, transcript: string) =>
  JSON.stringify({
    type: "turn.done",
    turn: { id, role: "user", transcript },
  });
const delegation = JSON.stringify({
  type: "delegation.created",
  item: {
    type: "delegation",
    target: "client",
    id: "d1",
    user_bidi_turn_id: "u1",
    content: [{ type: "input_text", text: "Is 40 < 50?" }],
  },
});

it("routes a handoff before turn.done using live words without steering the same utterance", () => {
  const call = liveConversation();
  call.receive(spoken("Is 40"));
  call.receive(spoken(" < 50?"));
  const handoff = call.receive(delegation);
  expect(handoff).toMatchObject({
    type: "delegation",
    prompt:
      "<realtime_delegation>\n  <input>Is 40 &lt; 50?</input>\n  <transcript_delta>user: Is 40 &lt; 50?</transcript_delta>\n</realtime_delegation>",
  });
  expect(call.receive(utterance("u1", "Is 40 < 50?"))).toMatchObject({
    type: "transcript",
    canSteer: false,
  });
  expect(call.generation()).toBe(2);
  expect(call.receive(utterance("u2", "Use kilometers instead"))).toMatchObject({
    type: "transcript",
    canSteer: true,
  });
});

it("accepts a delegation ID only once in a call, but does not carry it to another call", () => {
  const call = liveConversation();
  expect(call.receive(delegation).type).toBe("delegation");
  expect(call.receive(delegation)).toEqual({ type: "ignore" });
  expect(liveConversation().receive(delegation).type).toBe("delegation");
});

it("scopes UTF-8-safe chunks to the requesting delegation", () => {
  const prefix = "a".repeat(499);
  const appends = speakableAppends({
    delegationId: "d1",
    finalAnswer: `${prefix}\u{1F6E9}b`,
    generation: 1,
    currentGeneration: 1,
  });
  expect(appends.map((append) => JSON.parse(append))).toEqual([
    {
      type: "delegation.context.append",
      delegation_item_id: "d1",
      channel: "speakable",
      content: [{ type: "input_text", text: prefix }],
    },
    {
      type: "delegation.context.append",
      delegation_item_id: "d1",
      channel: "speakable",
      content: [{ type: "input_text", text: "\u{1F6E9}b" }],
    },
  ]);
});

it("does not send an answer above the speech budget", () => {
  const input = { delegationId: "d1", generation: 1, currentGeneration: 1 };
  expect(speakableAppends({ ...input, finalAnswer: "x".repeat(3_960) })).toHaveLength(8);
  expect(speakableAppends({ ...input, finalAnswer: "x".repeat(3_961) })).toEqual([]);
});

it("does not send an answer after the newer utterance starts, even before its handoff", () => {
  const call = liveConversation();
  const handoff = call.receive(delegation);
  if (handoff.type !== "delegation") throw new Error("Expected a live handoff");
  const input = {
    delegationId: handoff.id,
    finalAnswer: "Read this out",
    generation: handoff.generation,
  };
  expect(speakableAppends({ ...input, currentGeneration: call.generation() })).toHaveLength(1);
  call.receive(utterance("u1", "First question"));
  call.receive(spoken("Wait"));
  expect(speakableAppends({ ...input, currentGeneration: call.generation() })).toEqual([]);
});
