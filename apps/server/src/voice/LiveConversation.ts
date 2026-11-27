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
  const saved = new Set<string>();
  const lines = new Map<Role, { id: string; text: string }>();
  const transcript: Array<{ role: Role; text: string }> = [];
  let lineNumber = 0;
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
          const line = lines.get(role) ?? { id: `line-${++lineNumber}`, text: "" };
          line.text += text;
          lines.set(role, line);
          const previous = transcript.at(-1);
          if (previous?.role === role) previous.text += text;
          else transcript.push({ role, text });
          return { type: "transcript", role, ...line, complete: false } as const;
        }
        case "turn.done": {
          const { id, role } = frame.turn;
          if (saved.has(id)) return { type: "ignore" } as const;
          saved.add(id);
          const line = lines.get(role);
          lines.delete(role);
          const text = frame.turn.transcript.trim() || line?.text.trim() || "";
          if (!line && text) transcript.push({ role, text });
          return {
            type: "transcript",
            id: line?.id ?? id,
            role,
            text,
            complete: true,
          } as const;
        }
        case "delegation.created": {
          const { id, content } = frame.item;
          if (delegations.has(id)) return { type: "ignore" } as const;
          delegations.add(id);

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
            request,
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
  readonly delegationId: string | null;
  readonly finalAnswer: string;
  readonly generation: number;
  readonly currentGeneration: number;
}) {
  const text = input.finalAnswer.trim();
  if (input.generation !== input.currentGeneration || !text) return [];
  const bytes = Buffer.from(
    Buffer.byteLength(text) > 3_960 ? "That answer is long, so I've left it in the thread." : text,
  );
  const chunks = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + 500, bytes.length);
    while (end < bytes.length && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1;
    chunks.push(
      JSON.stringify({
        ...(input.delegationId === null
          ? { type: "session.context.append" }
          : { type: "delegation.context.append", delegation_item_id: input.delegationId }),
        channel: "speakable",
        content: [{ type: "input_text", text: bytes.toString("utf8", start, end) }],
      }),
    );
    start = end;
  }
  return chunks;
}
