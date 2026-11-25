import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskDestination,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect(
  "preserves launch options and removes the unused model from bound tasks and deliveries",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 110 });
      const workspaceStrategy = { type: "worktree", baseRef: "main" } as const;
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "test",
        options: [{ id: "reasoningEffort", value: "low" }],
      };
      for (const [id, threadId, mode] of [
        ["bound", "thread", "fresh_session"],
        ["deferred", null, "continue"],
        ["independent", null, "new_thread"],
      ] as const) {
        yield* sql`
        INSERT INTO scheduled_tasks (
          task_id, title, prompt, enabled, schedule_json, project_id, thread_id, thread_mode,
          workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
          created_by, creation_source, created_at, updated_at, last_run_status, run_count
        ) VALUES (${id}, 'Review', 'Review CI', 1, '{}', 'project', ${threadId}, ${mode},
          ${JSON.stringify(workspaceStrategy)}, ${JSON.stringify(modelSelection)}, 'auto', 'default',
          'user', 'web', '2026-01-01', '2026-01-01', 'never', 0)
      `;
      }
      yield* sql`
      INSERT INTO scheduled_task_webhook_pending
        (delivery_id, task_id, coalesce_key, due_at, task_json, request_json, delivery_ids_json)
      VALUES ('delivery', 'bound', 'key', 0, '{"projectId":"project","threadId":"thread"}', '{}', '[]')
    `;
      yield* runMigrations({ toMigrationInclusive: 111 });
      const rows = yield* sql<{ task_id: string; destination_json: string }>`
      SELECT task_id, destination_json FROM scheduled_tasks ORDER BY task_id
    `;
      const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ScheduledTaskDestination));
      const launch = {
        type: "new_thread" as const,
        projectId: ProjectId.make("project"),
        workspaceStrategy,
        modelSelection,
      };
      assert.deepEqual(
        yield* Effect.forEach(rows, (row) =>
          decode(row.destination_json).pipe(
            Effect.map((destination) => [row.task_id, destination] as const),
          ),
        ),
        [
          [
            "bound",
            {
              type: "existing_thread",
              threadId: ThreadId.make("thread"),
              session: "fresh_session",
            },
          ],
          ["deferred", { ...launch, afterLaunch: "continue" as const }],
          ["independent", launch],
        ],
      );
      const pending = yield* sql<{ destination_json: string }>`
      SELECT task_json -> '$.destination' AS destination_json FROM scheduled_task_webhook_pending
    `;
      assert.deepEqual(yield* Effect.forEach(pending, (row) => decode(row.destination_json)), [
        { type: "existing_thread", threadId: ThreadId.make("thread"), session: "continue" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
