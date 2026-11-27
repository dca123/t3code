import * as Schema from "effect/Schema";

const Role = Schema.Literals(["user", "assistant"]);
const Frame = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["input_transcript.added", "output_transcript.added"]),
    item: Schema.Struct({ text: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.done"),
    turn: Schema.Struct({ id: Schema.String, role: Role, transcript: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("delegation.created"),
    item: Schema.Struct({
      id: Schema.String,
      type: Schema.Literal("delegation"),
      target: Schema.Literal("client"),
      user_bidi_turn_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
      content: Schema.Array(
        Schema.Struct({
          type: Schema.String,
          text: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("delegation.context.appended"),
    delegation_item_id: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literals(["session.closed", "error"]) }),
]);
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Frame));
const decoder = new TextDecoder();
type Role = typeof Role.Type;

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function liveConversation() {
  const delegations = new Set<string>();
  const delegatedUtterances = new Set<string>();
  const saved = new Set<string>();
  const transcript: Array<{ role: Role; text: string }> = [];
  let userSpeaking = false;
  let generation = 0;

  return {
    generation: () => generation,
    receive(raw: string | Uint8Array) {
      const decoded = decode(typeof raw === "string" ? raw : decoder.decode(raw));
      if (decoded._tag === "None") return { type: "ignore" } as const;
      const frame = decoded.value;
      switch (frame.type) {
        case "input_transcript.added":
        case "output_transcript.added": {
          const role = frame.type === "input_transcript.added" ? "user" : "assistant";
          const text = frame.item.text;
          if (!text) return { type: "ignore" } as const;
          if (role === "user" && !userSpeaking && text.trim()) {
            userSpeaking = true;
            generation += 1;
          }
          const previous = transcript.at(-1);
          if (previous?.role === role) previous.text += text;
          else transcript.push({ role, text });
          return { type: "ignore" } as const;
        }
        case "turn.done": {
          const { id, role } = frame.turn;
          if (saved.has(id)) return { type: "ignore" } as const;
          saved.add(id);
          const text = frame.turn.transcript.trim();
          if (role === "user") {
            if (!userSpeaking && text && !delegatedUtterances.has(id)) generation += 1;
            userSpeaking = false;
          }
          return {
            type: "transcript",
            id,
            role,
            text,
            generation,
            canSteer: role === "user" && !delegatedUtterances.has(id),
          } as const;
        }
        case "delegation.created": {
          const { id, content, user_bidi_turn_id: userTurn } = frame.item;
          if (delegations.has(id)) return { type: "ignore" } as const;
          delegations.add(id);
          if (userTurn != null) delegatedUtterances.add(userTurn);
          const delta = transcript
            .splice(0)
            .map(({ role, text }) => `${role}: ${text.trim()}`)
            .join("\n");
          const request =
            content
              .flatMap((part) =>
                part.type === "input_text" && part.text !== undefined ? [part.text] : [],
              )
              .join(" ")
              .trim() || delta;
          if (!request) return { type: "ignore" } as const;
          generation += 1;
          return {
            type: "delegation",
            id,
            generation,
            userTurn: userTurn ?? null,
            prompt: `<realtime_delegation>\n  <input>${escapeXml(request)}</input>\n  <transcript_delta>${escapeXml(delta)}</transcript_delta>\n</realtime_delegation>`,
          } as const;
        }
        case "delegation.context.appended":
          return { type: "ack", id: frame.delegation_item_id } as const;
        case "session.closed":
        case "error":
          return { type: "closed" } as const;
      }
    },
  };
}

export function speakableAppends(input: {
  readonly delegationId: string;
  readonly finalAnswer: string;
  readonly generation: number;
  readonly currentGeneration: number;
}) {
  const text = input.finalAnswer.trim();
  const bytes = Buffer.from(text);
  if (
    input.generation !== input.currentGeneration ||
    bytes.length === 0 ||
    Math.ceil(bytes.length / 4) > 990
  ) {
    return [];
  }
  const chunks = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + 500, bytes.length);
    while (end < bytes.length && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1;
    chunks.push(
      JSON.stringify({
        type: "delegation.context.append",
        delegation_item_id: input.delegationId,
        channel: "speakable",
        content: [{ type: "input_text", text: bytes.toString("utf8", start, end) }],
      }),
    );
    start = end;
  }
  return chunks;
}
