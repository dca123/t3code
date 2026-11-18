import type { ScopedThreadRef } from "@t3tools/contracts";
import { LampDeskIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { setThreadLightMode, useThreadLightMode } from "../../threadLightMode";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

export function ThreadLightModeRow({ threadRef }: { threadRef: ScopedThreadRef }) {
  const on = useThreadLightMode(threadRef);
  return (
    // The label forwards row clicks to the switch, which owns focus and the checked state.
    <ThreadDetailsControl size="sm" variant="ghost" part="row" render={<label />}>
      <LampDeskIcon className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, on && "text-foreground")} />
      <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
        Light mode
      </span>
      <span className="flex shrink-0">
        <Switch
          size="sm"
          checked={on}
          onCheckedChange={(next) => {
            if (!setThreadLightMode(threadRef, next)) {
              toastManager.add({ type: "error", title: "Could not save light mode" });
            }
          }}
        />
      </span>
    </ThreadDetailsControl>
  );
}
