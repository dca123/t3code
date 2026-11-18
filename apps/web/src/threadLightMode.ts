import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import type { ThemePreferenceMode } from "./themePalette";

export const THREAD_LIGHT_MODE_STORAGE_KEY = "t3code:thread-light-mode";

let lit: ReadonlySet<string> | null = null;
let shownThreadKey: string | null = null;
let listeners: Array<() => void> = [];

function readLit(): ReadonlySet<string> {
  if (lit !== null) return lit;
  lit = new Set();
  if (typeof window === "undefined") return lit;
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(THREAD_LIGHT_MODE_STORAGE_KEY) ?? "[]",
    );
    if (Array.isArray(value)) {
      lit = new Set(value.filter((key): key is string => typeof key === "string"));
    }
  } catch {}
  return lit;
}

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeThreadLightMode(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((current) => current !== listener);
  };
}

export function isThreadLightModeOn(threadRef: ScopedThreadRef): boolean {
  return readLit().has(scopedThreadKey(threadRef));
}

export function useThreadLightMode(threadRef: ScopedThreadRef | null): boolean {
  return useSyncExternalStore(
    subscribeThreadLightMode,
    () => threadRef !== null && isThreadLightModeOn(threadRef),
    () => false,
  );
}

/** Saved on this device only; returns false when storage refuses the write. */
export function setThreadLightMode(threadRef: ScopedThreadRef, on: boolean): boolean {
  const key = scopedThreadKey(threadRef);
  const next = new Set(readLit());
  if (on) next.add(key);
  else next.delete(key);
  try {
    if (next.size === 0) window.localStorage.removeItem(THREAD_LIGHT_MODE_STORAGE_KEY);
    else window.localStorage.setItem(THREAD_LIGHT_MODE_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    return false;
  }
  lit = next;
  emit();
  return true;
}

/** Only the routed thread can light the window; pages without one keep the chosen mode. */
export function setShownThread(threadRef: ScopedThreadRef | null): void {
  const key = threadRef === null ? null : scopedThreadKey(threadRef);
  if (key === shownThreadKey) return;
  const wasLit = shownThreadKey !== null && readLit().has(shownThreadKey);
  shownThreadKey = key;
  if (wasLit !== isShownThreadLit()) emit();
}

function isShownThreadLit(): boolean {
  return shownThreadKey !== null && readLit().has(shownThreadKey);
}

/** Another window changed which threads are lit. */
export function invalidateThreadLightMode(): void {
  lit = null;
  emit();
}

/**
 * A lit thread asks for light mode. The theme still decides whether it has light colors,
 * so a dark-only theme stays dark and a light mode choice is unchanged.
 */
export function resolveShownAppearanceMode(mode: ThemePreferenceMode): ThemePreferenceMode {
  return isShownThreadLit() ? "light" : mode;
}
