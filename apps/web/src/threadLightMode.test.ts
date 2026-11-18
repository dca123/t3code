import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const lit = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("lit"));
const other = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("other"));

// The module caches what it read, so each test loads it fresh against its own storage.
async function setup(stored: Record<string, string> = {}) {
  vi.resetModules();
  const items = new Map(Object.entries(stored));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    },
  });
  const module = await import("./threadLightMode");
  return { ...module, items, [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

describe("thread light mode", () => {
  it("asks for light only while a lit thread is shown, and keeps the mode elsewhere", async () => {
    using lamp = await setup();
    lamp.setThreadLightMode(lit, true);

    lamp.setShownThread(lit);
    expect(lamp.resolveShownAppearanceMode("dark")).toBe("light");
    expect(lamp.resolveShownAppearanceMode("system")).toBe("light");

    lamp.setShownThread(other);
    expect(lamp.resolveShownAppearanceMode("dark")).toBe("dark");

    lamp.setShownThread(null);
    expect(lamp.resolveShownAppearanceMode("system")).toBe("system");
  });

  it("remembers lit threads across reloads and forgets them when turned off", async () => {
    let stored: Record<string, string>;
    {
      using lamp = await setup();
      lamp.setThreadLightMode(lit, true);
      stored = Object.fromEntries(lamp.items);
    }
    {
      using lamp = await setup(stored);
      expect(lamp.isThreadLightModeOn(lit)).toBe(true);
      expect(lamp.isThreadLightModeOn(other)).toBe(false);
      lamp.setThreadLightMode(lit, false);
      expect(lamp.items.has(lamp.THREAD_LIGHT_MODE_STORAGE_KEY)).toBe(false);
    }
  });

  it("notifies listeners only when the shown thread's lamp state changes", async () => {
    using lamp = await setup();
    lamp.setThreadLightMode(lit, true);
    const listener = vi.fn();
    lamp.subscribeThreadLightMode(listener);

    lamp.setShownThread(other);
    expect(listener).not.toHaveBeenCalled();
    lamp.setShownThread(lit);
    expect(listener).toHaveBeenCalledTimes(1);
    lamp.setShownThread(other);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
