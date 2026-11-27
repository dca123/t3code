/// <reference lib="dom" />
import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "Thread light mode keeps the sidebar and its menus dark",
  WEB,
  async ({ t3, screen, browser }) => {
    const project = await t3.project("Demo");
    const thread = await t3.thread({ project, title: "Lit thread", messages: [] });
    await t3.open(thread);
    await browser.evaluate(() => {
      localStorage.setItem("t3code:theme-appearance-mode", "dark");
      return null;
    });
    await t3.open(thread);

    const lamp = screen.getByRole("switch", "Light mode");
    await lamp.waitFor();
    const schemes = () =>
      browser.evaluate(() => {
        const theme = (selector: string) => {
          const surface = document.querySelector(selector);
          if (!surface) throw new Error(`Missing surface: ${selector}`);
          return getComputedStyle(surface).colorScheme;
        };
        return { sidebar: theme("[data-sidebar=sidebar]"), thread: theme("main") };
      });
    expect(await schemes()).toEqual({ sidebar: "dark", thread: "dark" });

    await lamp.tap();
    expect(await schemes()).toEqual({ sidebar: "dark", thread: "light" });
    await screen.getByRole("button", "Thread actions for Lit thread").tap();
    await screen.getByRole("menu").waitFor();
    const menuScheme = () =>
      browser.evaluate(() => {
        const menu = document.querySelector('[role="menu"]');
        if (!menu) throw new Error("No open menu");
        return getComputedStyle(menu).colorScheme;
      });
    expect(await menuScheme()).toBe("light");
    await screen.getByRole("menu").press("Escape");
    await browser.evaluate(() => {
      const trigger = document.querySelector('[aria-label="Threads"] [aria-label^="Lit thread,"]');
      if (!trigger) throw new Error("No thread row in the sidebar");
      const box = trigger.getBoundingClientRect();
      trigger.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: box.x + 5, clientY: box.y + 5 }),
      );
      return null;
    });
    await screen.getByRole("menu").waitFor();
    expect(await menuScheme()).toBe("dark");
  },
);
