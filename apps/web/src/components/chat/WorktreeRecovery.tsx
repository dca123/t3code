import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { msg, useGT } from "gt-react";
import { FolderXIcon } from "lucide-react";
import { createContext, use, useState } from "react";
import { m } from "../../i18n/messages";
import { useServerConfigs } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export const WorktreeRecoveryContext = createContext<{
  readonly path: string;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly recreate: () => Promise<void>;
} | null>(null);

export function useWorktreeRecovery(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  path: string | null;
  blocked: boolean;
  refresh: () => void;
}) {
  const gt = useGT();
  const run = useAtomCommand(orchestrationEnvironment.recreateWorktree);
  const permitted = useAtomValue(
    orchestrationEnvironment.recreateWorktree.permissionAtom(input.environmentId),
  );
  const supported =
    useServerConfigs().get(input.environmentId)?.environment.capabilities.threadWorktreeRecovery ===
    true;
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const { threadId, path } = input;
  if (path === null || threadId === null || !supported) return null;
  const pending = pendingPath === path;
  const disabled = !permitted || input.blocked || pending;
  return {
    path,
    pending,
    disabled,
    recreate: async () => {
      if (disabled) return;
      setPendingPath(path);
      const result = await run({ environmentId: input.environmentId, input: { threadId } });
      setPendingPath(null);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: gt("Could not recreate worktree"),
          description: error instanceof Error ? error.message : gt("Try again."),
        });
        return;
      }
      input.refresh();
      const { branch, branchRecovery, setupWarning } = result.value;
      toastManager.add({
        type: setupWarning === null ? "success" : "warning",
        title:
          setupWarning === null
            ? gt("Worktree recreated")
            : gt("Worktree recreated, but setup could not start"),
        description: [
          branchRecovery === "in_use"
            ? gt(
                "The old branch is checked out elsewhere. Created {branch} from the default branch.",
                { branch },
              )
            : branchRecovery === "missing" || branchRecovery === "detached"
              ? gt("Created {branch} from the default branch.", { branch })
              : gt("Checked out {branch}.", { branch }),
          setupWarning,
          gt("Send your message again to continue."),
        ]
          .filter(Boolean)
          .join(" "),
      });
    },
  };
}

export function RecreateWorktreeButton({ path }: { readonly path: string }) {
  const gt = useGT();
  const recovery = use(WorktreeRecoveryContext);
  if (recovery?.path !== path) return null;
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={recovery.disabled}
      onClick={() => void recovery.recreate()}
    >
      {recovery.pending ? gt("Recreating worktree...") : gt("Recreate worktree")}
    </Button>
  );
}

export function missingWorktreeBanner(path: string): ComposerBannerStackItem {
  return {
    id: "missing-worktree",
    variant: "warning",
    icon: <FolderXIcon aria-hidden />,
    title: m(msg("Worktree folder is missing")),
    description: path,
    actions: <RecreateWorktreeButton path={path} />,
  };
}
