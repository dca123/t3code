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

it("updates one spoken line before and after a handoff arrives", () => {
  const call = liveConversation();
  const first = call.receive(spoken("Is 40"));
  expect(first).toMatchObject({
    type: "transcript",
    role: "user",
    text: "Is 40",
    complete: false,
  });
  expect(call.receive(spoken(" < 50?"))).toEqual({ ...first, text: "Is 40 < 50?" });
  const handoff = call.receive(delegation);
  expect(handoff).toMatchObject({
    type: "delegation",
    request: "Is 40 < 50?",
    prompt:
      "<realtime_delegation>\n  <input>Is 40 &lt; 50?</input>\n  <transcript_delta>user: Is 40 &lt; 50?</transcript_delta>\n</realtime_delegation>",
  });
  expect(call.receive(utterance("u1", "Is 40 < 50?"))).toEqual({
    ...first,
    text: "Is 40 < 50?",
    complete: true,
  });
  expect(call.receive(utterance("u1", "Is 40 < 50?"))).toEqual({ type: "ignore" });
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

it("points to the thread instead of sending an answer above the speech budget", () => {
  const input = { delegationId: "d1", generation: 1, currentGeneration: 1 };
  expect(speakableAppends({ ...input, finalAnswer: "x".repeat(3_960) })).toHaveLength(8);
  expect(
    speakableAppends({ ...input, finalAnswer: "x".repeat(3_961) }).map(
      (append) => JSON.parse(append).content,
    ),
  ).toEqual([
    [{ type: "input_text", text: "That answer is long, so I've left it in the thread." }],
  ]);
});

it("drops the answer after a newer handoff, but not after ordinary speech", () => {
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
  call.receive(spoken("What was that?"));
  expect(speakableAppends({ ...input, currentGeneration: call.generation() })).toHaveLength(1);
  call.receive(delegation.replace('"d1"', '"d2"'));
  expect(speakableAppends({ ...input, currentGeneration: call.generation() })).toEqual([]);
});
