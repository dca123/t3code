import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE scheduled_task_webhook_pending SET task_json = json_remove(json_set(
      task_json, '$.destination', CASE
        WHEN json_extract(task_json, '$.threadId') IS NOT NULL
             AND coalesce(json_extract(task_json, '$.threadMode'), 'continue') != 'new_thread' THEN
          json_object('type', 'existing_thread',
            'threadId', json_extract(task_json, '$.threadId'),
            'session', coalesce(json_extract(task_json, '$.threadMode'), 'continue'))
        ELSE json_patch(json_object(
          'type', 'new_thread', 'projectId', json_extract(task_json, '$.projectId'),
          'workspaceStrategy', json_extract(task_json, '$.workspaceStrategy'),
          'modelSelection', json_extract(task_json, '$.modelSelection')
        ), CASE json_extract(task_json, '$.threadMode')
             WHEN 'continue' THEN '{"afterLaunch":"continue"}'
             WHEN 'fresh_session' THEN '{"afterLaunch":"fresh_session"}'
             ELSE '{}' END)
      END
    ), '$.threadId', '$.threadMode', '$.workspaceStrategy', '$.modelSelection')
    WHERE json_valid(task_json)
  `;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN destination_json TEXT NOT NULL DEFAULT '{}'`;
  yield* sql`
    UPDATE scheduled_tasks SET destination_json = CASE
      WHEN thread_id IS NOT NULL AND thread_mode != 'new_thread' THEN
        json_object('type', 'existing_thread', 'threadId', thread_id, 'session', thread_mode)
      ELSE
        json_patch(json_object(
          'type', 'new_thread',
          'projectId', project_id,
          'workspaceStrategy', json(workspace_strategy_json),
          'modelSelection', json(model_selection_json)
        ), CASE WHEN thread_mode = 'new_thread' THEN '{}' ELSE json_object('afterLaunch', thread_mode) END)
    END
  `;
  yield* sql`ALTER TABLE scheduled_tasks DROP COLUMN thread_id`;
  yield* sql`ALTER TABLE scheduled_tasks DROP COLUMN thread_mode`;
  yield* sql`ALTER TABLE scheduled_tasks DROP COLUMN workspace_strategy_json`;
  yield* sql`ALTER TABLE scheduled_tasks DROP COLUMN model_selection_json`;
  yield* sql`
    ALTER TABLE scheduled_tasks ADD COLUMN thread_id TEXT
    GENERATED ALWAYS AS (CASE WHEN json_valid(destination_json) THEN json_extract(destination_json, '$.threadId') END) VIRTUAL
  `;
});
