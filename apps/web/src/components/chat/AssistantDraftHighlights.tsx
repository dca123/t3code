import type { AssistantCitation, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import {
  resolveAssistantCitationRange,
  type AssistantMessageSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { draftCitationsForThread } from "./assistantDraftCitations";

const HIGHLIGHT_NAME = "t3-assistant-citation-draft";

export function AssistantDraftHighlights({
  viewport,
  threadRef,
  draftTarget,
  onEdit,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  draftTarget: ComposerThreadTarget;
  onEdit: (citation: AssistantCitation, anchor: AssistantMessageSourceAnchor) => void;
}) {
  // A primitive key keeps typing elsewhere in the draft from re-resolving every highlight.
  const citationKey = useComposerDraftStore((store) =>
    draftCitationsForThread(store.getComposerDraft(draftTarget)?.prompt ?? "", threadRef)
      .filter((citation) => citation.page === undefined)
      .map(serializeAssistantCitation)
      .join(" "),
  );
  const edit = useEffectEvent(onEdit);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers draft ranges in the browser highlight registry and repairs them when virtualized source DOM changes
  useEffect(() => {
    if (!viewport || !citationKey || typeof Highlight === "undefined" || !CSS.highlights) return;
    const citations = collectAssistantCitations(citationKey).map(({ citation }) => citation);
    const registry = CSS.highlights;
    const highlight = registry.get(HIGHLIGHT_NAME) ?? new Highlight();
    registry.set(HIGHLIGHT_NAME, highlight);
    let ranges: { citation: AssistantCitation; anchor: AssistantMessageSourceAnchor }[] = [];
    const clear = () => {
      for (const { anchor } of ranges) highlight.delete(anchor.range);
      ranges = [];
    };
    const resolve = () => {
      clear();
      for (const source of viewport.querySelectorAll<HTMLElement>(
        "[data-assistant-citation-source]",
      )) {
        for (const citation of citations) {
          if (
            source.dataset.assistantCitationSource !== citation.messageId ||
            source.dataset.assistantCitationThread !== citation.threadId ||
            source.dataset.assistantCitationEnvironment !== citation.environmentId
          )
            continue;
          const range = resolveAssistantCitationRange(source, citation);
          if (!range) continue;
          highlight.add(range);
          ranges.push({ citation, anchor: { source, range, viewport } });
        }
      }
    };
    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        const target =
          record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.closest("[data-assistant-citation-source]")) return true;
        return [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches("[data-assistant-citation-source]") ||
              node.querySelector("[data-assistant-citation-source]")),
        );
      });
      if (relevant) resolve();
    });
    let pointer: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      pointer = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    };
    const click = (event: MouseEvent) => {
      const start = pointer;
      pointer = null;
      if (
        !start ||
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 ||
        !window.getSelection()?.isCollapsed ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      if (event.target instanceof Element && event.target.closest("a, button, input, textarea"))
        return;
      const match = ranges.find(({ anchor }) =>
        Array.from(anchor.range.getClientRects()).some(
          (rect) =>
            event.clientX >= rect.left &&
            event.clientX <= rect.right &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom,
        ),
      );
      if (match) {
        event.preventDefault();
        edit(match.citation, match.anchor);
      }
    };
    observer.observe(viewport, { childList: true, characterData: true, subtree: true });
    viewport.addEventListener("pointerdown", down);
    viewport.addEventListener("click", click);
    resolve();
    return () => {
      observer.disconnect();
      viewport.removeEventListener("pointerdown", down);
      viewport.removeEventListener("click", click);
      clear();
      if (highlight.size === 0 && registry.get(HIGHLIGHT_NAME) === highlight)
        registry.delete(HIGHLIGHT_NAME);
    };
  }, [viewport, citationKey]);
  return null;
}
