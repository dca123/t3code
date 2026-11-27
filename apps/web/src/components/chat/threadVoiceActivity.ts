import * as Schema from "effect/Schema";

const VoiceRole = Schema.Literals(["user", "assistant"]);
const VoiceFrame = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["input_transcript.added", "output_transcript.added"]),
    item: Schema.Struct({ text: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.done"),
    turn: Schema.Struct({ role: VoiceRole, transcript: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("delegation.created"),
    item: Schema.Struct({ id: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("delegation.context.appended"),
    delegation_item_id: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literals(["session.closed", "error"]) }),
]);
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(VoiceFrame));

type Utterance = { readonly text: string; readonly complete: boolean };
type Handoff = { readonly id: string; readonly started: number; readonly answered: number | null };
export type VoiceActivity = {
  readonly transcript: Readonly<Record<typeof VoiceRole.Type, Utterance>>;
  readonly handoffs: readonly Handoff[];
};

export const emptyVoiceActivity: VoiceActivity = {
  transcript: { user: { text: "", complete: true }, assistant: { text: "", complete: true } },
  handoffs: [],
};

export function receiveVoiceActivity(raw: string, now: number) {
  const parsed = decode(raw);
  if (parsed._tag === "None") return { type: "ignore" } as const;
  const frame = parsed.value;
  if (frame.type === "session.closed") return { type: "ended", reason: "remote-ended" } as const;
  if (frame.type === "error") return { type: "ended", reason: "connection-lost" } as const;
  return {
    type: "activity",
    update(activity: VoiceActivity): VoiceActivity {
      switch (frame.type) {
        case "input_transcript.added":
        case "output_transcript.added": {
          const role = frame.type === "input_transcript.added" ? "user" : "assistant";
          const previous = activity.transcript[role];
          const text = ((previous.complete ? "" : previous.text) + frame.item.text).slice(-2_000);
          return {
            ...activity,
            transcript: { ...activity.transcript, [role]: { text, complete: false } },
          };
        }
        case "turn.done": {
          const { role, transcript } = frame.turn;
          return {
            ...activity,
            transcript: {
              ...activity.transcript,
              [role]: { text: transcript.slice(-2_000), complete: true },
            },
          };
        }
        case "delegation.created": {
          const id = frame.item.id;
          if (activity.handoffs.some((handoff) => handoff.id === id)) return activity;
          return {
            ...activity,
            handoffs: [...activity.handoffs.slice(-19), { id, started: now, answered: null }],
          };
        }
        case "delegation.context.appended": {
          return {
            ...activity,
            handoffs: activity.handoffs.map((handoff) =>
              handoff.id === frame.delegation_item_id && handoff.answered === null
                ? { ...handoff, answered: now }
                : handoff,
            ),
          };
        }
      }
      return activity;
    },
  } as const;
}
