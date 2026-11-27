import { assert, it } from "@effect/vitest";
import { MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("reuses an item's position without attempting another allocation insert", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const input = {
      threadId: ThreadId.make("thread:position-reuse"),
      turnItemId: TurnItemId.make("item:streaming"),
      runId: null,
    };
    const first = yield* positions.allocate(input);
    assert.equal(first, 1);

    // BEFORE INSERT runs even when ON CONFLICT would discard the allocation.
    yield* sql`
      CREATE TEMP TRIGGER reject_redundant_position_insert
      BEFORE INSERT ON orchestration_v2_turn_item_positions
      WHEN EXISTS (
        SELECT 1 FROM orchestration_v2_turn_item_positions
        WHERE thread_id = NEW.thread_id AND turn_item_id = NEW.turn_item_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Existing item positions must be reused');
      END
    `;

    const next = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("item:next"),
    });
    assert.equal(next, first + 1);
    assert.equal(yield* positions.allocate(input), first);
    assert.equal(
      yield* positions.allocate({
        ...input,
        runId: RunId.make("run:moved"),
        runOrdinal: 2,
      }),
      2_000_001,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("places a run-start item ahead of the run's items, then appends once taken", () =>
  Effect.gen(function* () {
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:run-start");
    const allocate = (id: string, placement?: "run_start") =>
      positions.allocate({
        threadId,
        turnItemId: TurnItemId.make(id),
        runId: RunId.make("run:2"),
        runOrdinal: 2,
        ...(placement === undefined ? {} : { placement }),
      });
    const message = yield* allocate("item:message");
    const recovery = yield* allocate("item:recovery", "run_start");
    assert.isBelow(recovery, message);
    assert.isAbove(recovery, 1_999_999);
    assert.equal(yield* allocate("item:retry-recovery", "run_start"), message + 1);
    assert.equal(yield* allocate("item:reply"), message + 2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "appends spoken lines and failed handoffs after the visible turn without giving them a run",
  () =>
    Effect.gen(function* () {
      const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
      const threadId = ThreadId.make("thread:voice-transcript");
      const runId = RunId.make("run:previous");
      const priorReply = yield* positions.allocate({
        threadId,
        turnItemId: TurnItemId.make("item:previous-reply"),
        runId,
        runOrdinal: 2,
      });
      const now = yield* DateTime.now;
      const record = (messageId: MessageId) => {
        return positions.normalize({
          id: TurnItemId.make(messageId),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: now,
          updatedAt: now,
          completedAt: now,
          type: "assistant_message",
          text: "Hello",
          messageId,
          streaming: false,
        });
      };
      const firstId = MessageId.make("voice:2006f497-3d23-41be-a785-8251703ec048:greeting");
      const first = yield* record(firstId);
      const failed = yield* record(
        MessageId.make("voice-handoff-failed:2006f497-3d23-41be-a785-8251703ec048:handoff"),
      );
      assert.isAbove(first.ordinal, priorReply);
      assert.isAbove(failed.ordinal, first.ordinal);
      assert.isNull(failed.runId);
      assert.equal((yield* record(firstId)).ordinal, first.ordinal);
    }).pipe(Effect.provide(layerTest)),
);
