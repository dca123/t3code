import type {
  EnvironmentId,
  ThreadId,
  ThreadVoiceEndReason,
  ThreadVoicePhase,
} from "@t3tools/contracts";
import { create } from "zustand";

type CallTarget = { environmentId: EnvironmentId; threadId: ThreadId; title: string };
type BindCallMeter = (element: HTMLMeterElement | null) => void;

export type ActiveThreadVoiceCall = {
  target: CallTarget;
  phase: ThreadVoicePhase;
  startedAt: number;

  callId: string;
  handoffId: string | null;
  bindMicMeter: BindCallMeter;
  bindIncomingMeter: BindCallMeter;
  finish: (reason: ThreadVoiceEndReason) => void;
};

export const useThreadVoiceCallStore = create<{
  active: ActiveThreadVoiceCall | null;
  ended: { target: CallTarget; reason: ThreadVoiceEndReason } | null;
}>(() => ({ active: null, ended: null }));

export function useIsCallingThread(environmentId: EnvironmentId, threadId: ThreadId | null) {
  return useThreadVoiceCallStore(
    (state) =>
      state.active?.target.environmentId === environmentId &&
      state.active.target.threadId === threadId,
  );
}
