import { createContext, useContext } from "react";

export const ThreadAppearanceContext = createContext<{ portal: HTMLElement | null } | null>(null);

export function useThreadPortalContainer() {
  return useContext(ThreadAppearanceContext)?.portal ?? undefined;
}
