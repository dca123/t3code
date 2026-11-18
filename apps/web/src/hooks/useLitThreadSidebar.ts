import type { CSSProperties } from "react";
import { useSyncExternalStore } from "react";

import { resolveThemeHalf, themePaletteVariables } from "../themePalette";
import { isShownThreadLit, subscribeThreadLightMode } from "../threadLightMode";
import { useTheme } from "./useTheme";

/** A lit thread lights the thread area only; the sidebar keeps the dark appearance it had. */
export function useLitThreadSidebar(): { className: string; style: CSSProperties } | null {
  const lit = useSyncExternalStore(subscribeThreadLightMode, isShownThreadLit, () => false);
  const { theme, themeHalves, savedResolvedTheme } = useTheme();
  if (!lit || savedResolvedTheme !== "dark") return null;
  return {
    className: "dark",
    style: themePaletteVariables(resolveThemeHalf(theme, themeHalves, "dark"), "dark"),
  };
}
