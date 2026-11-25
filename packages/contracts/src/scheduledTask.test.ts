import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskDestination,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";
import {
  OrchestratorMcpSaveScheduledTaskInput,
  OrchestratorMcpWakeOnWebhookInput,
} from "./orchestratorMcp.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);
const isDestination = Schema.is(ScheduledTaskDestination);
const decodeClock = Schema.decodeUnknownSync(OrchestratorMcpSaveScheduledTaskInput);
const decodeWebhook = Schema.decodeUnknownSync(OrchestratorMcpWakeOnWebhookInput);

it("refuses model overrides on a bound destination", () => {
  const destination = { type: "existing_thread", threadId: "thread", session: "continue" };
  const model = { instanceId: "codex", model: "gpt-6-luna" };
  expect(isDestination(destination)).toBe(true);
  expect(isDestination({ ...destination, modelSelection: model })).toBe(false);
  expect(() =>
    decodeClock({ destination: { ...destination, target: { model: model.model } } }),
  ).toThrow();
});

it("accepts webhook settings only through the webhook tool", () => {
  expect(() => decodeClock({ prompt: "Review CI", schedule: { type: "webhook" } })).toThrow();
  expect(decodeWebhook({ prompt: "Review CI", webhook: { fireOnce: true } })).toMatchObject({
    webhook: { fireOnce: true },
  });
});

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("accepts a five-field cron expression with an IANA time zone", () => {
    const schedule = { type: "cron", expression: "0 10 19 * *", timeZone: "Asia/Colombo" };
    expect(decodeUpsertSchedule(schedule)).toEqual(schedule);
    expect(decodeSchedule(schedule)).toEqual(schedule);
    for (const invalid of [
      { expression: "0 10 32 * *", timeZone: "Asia/Colombo" },
      { expression: "0 0 10 19 * *", timeZone: "Asia/Colombo" },
      { expression: "0 10 19 *", timeZone: "Asia/Colombo" },
      { expression: "0 10 19 * *", timeZone: "Mars/Base" },
      { expression: "0 10 19 * *", timeZone: "+05:30" },
      { expression: "0 10 19 * *", timeZone: "IST" },
    ]) {
      expect(() => decodeUpsertSchedule({ type: "cron", ...invalid })).toThrow();
    }
  });

  it("accepts a one-time run only with an offset", () => {
    for (const runAt of ["2026-11-03T09:00Z", "2026-11-03T09:00:00.000-08:00"]) {
      expect(decodeUpsertSchedule({ type: "once", runAt })).toEqual({ type: "once", runAt });
    }
    for (const runAt of [
      "2026-11-03T09:00",
      "2026-13-03T09:00Z",
      "2026-02-30T09:00Z",
      "9999-12-31T23:30-01:00",
      "0000-01-01T00:00+00:01",
      "tomorrow",
    ]) {
      expect(() => decodeUpsertSchedule({ type: "once", runAt })).toThrow();
    }
  });
});

it.each(["literal", " ", "\t\n", "{{body.bad", "{{unknown.field}}"])(
  "rejects invalid dedupe template %s",
  (replayKey) => {
    expect(() => decodeUpsertSchedule({ type: "webhook", dedupe: { replayKey } })).toThrow();
    expect(() =>
      decodeUpsertSchedule({ type: "webhook", dedupe: { coalesceKey: replayKey } }),
    ).toThrow();
  },
);
describe("webhook filters", () => {
  const accepts = (filters: unknown) => {
    try {
      decodeUpsertSchedule({ type: "webhook", filters });
      return true;
    } catch {
      return false;
    }
  };

  it("rejects empty or unknown paths, unknown ops, and values that do not fit the op", () => {
    expect(accepts([{ path: "", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "  ", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "request", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "header.x-github-event", op: "exists" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: "opened" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "in", value: [] }])).toBe(false);
    for (const value of ["", " opened", "opened ", "a,b"]) {
      expect(accepts([{ path: "body.action", op: "in", value: [value] }])).toBe(false);
    }
    expect(accepts([{ path: "body.label.name", op: "in", value: ["needs review"] }])).toBe(true);
    expect(accepts([{ path: "body.action", op: "equals" }])).toBe(false);
    expect(accepts([{ path: "body.action", op: "matches", value: "^opened$" }])).toBe(false);
  });
});
