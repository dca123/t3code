import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  use,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { MessageSquareIcon } from "lucide-react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { Button } from "../ui/button";
import { BackgroundThreadContext } from "./backgroundThread";
import { selectionCommentCharacter } from "./assistantDraftCitations";

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (
    citation: AssistantCitation,
    sourceAnchor: AssistantCitationSourceAnchor,
    action: "comment" | "preset",
  ) => boolean;
}) {
  const [selection, setSelection] = useState<{
    citation: AssistantCitation;
    position: SelectionActionPoint;
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const backgroundThread = use(BackgroundThreadContext);
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = (action: "comment" | "preset", comment?: string) => {
    if (!selection || selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH)
      return false;
    const citation =
      comment === undefined ? selection.citation : { ...selection.citation, comment };
    if (!onCite(citation, selection.sourceAnchor, action)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  const onSelectionKey = useEffectEvent((event: KeyboardEvent) => {
    if (!selection || event.isComposing || event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
      return;
    }
    const target = event.target;
    const editable =
      target instanceof Element &&
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      ) !== null;
    const character = selectionCommentCharacter(event, editable);
    if (character !== null && cite("comment", character)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to document selectionchange and keydown to track text selections in the viewport
  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = (pointer: SelectionActionPoint | null, extending: boolean) => {
      const nativeSelection = window.getSelection();
      const captured = captureAssistantTextSelection(viewport, nativeSelection);
      const messageId = captured?.source.dataset.assistantCitationSource;
      if (!captured || !messageId) {
        clear();
        return;
      }
      const rect = captured.range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (!isSelectionRectVisible(rect, [viewportRect])) {
        clear();
        return;
      }
      // A selection can cross blocks with different clipping ancestors.
      const common = captured.range.commonAncestorContainer;
      const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
      let node = common.nodeType === Node.TEXT_NODE ? common : walker.nextNode();
      let visible = false;
      for (; node && !visible; node = walker.nextNode()) {
        if (!captured.range.intersectsNode(node)) continue;
        if (node.parentElement && getComputedStyle(node.parentElement).userSelect === "none")
          continue;
        const fragment = document.createRange();
        fragment.selectNodeContents(node);
        if (node === captured.range.startContainer) {
          fragment.setStart(node, captured.range.startOffset);
        }
        if (node === captured.range.endContainer) {
          fragment.setEnd(node, captured.range.endOffset);
        }
        if (!fragment.toString().trim()) continue;
        const lines = Array.from(fragment.getClientRects());
        if (!lines.some((line) => isSelectionRectVisible(line, [viewportRect]))) continue;
        const clips: Pick<DOMRect, "left" | "right" | "top" | "bottom">[] = [viewportRect];
        for (
          let element = node.parentElement;
          element && element !== viewport;
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          const clipX = style.overflowX !== "visible";
          const clipY = style.overflowY !== "visible";
          if (!clipX && !clipY) continue;
          const bounds = element.getBoundingClientRect();
          const left = bounds.left + element.clientLeft;
          const top = bounds.top + element.clientTop;
          clips.push({
            left: clipX ? left : -Infinity,
            right: clipX ? left + element.clientWidth : Infinity,
            top: clipY ? top : -Infinity,
            bottom: clipY ? top + element.clientHeight : Infinity,
          });
        }
        visible = lines.some((line) => isSelectionRectVisible(line, clips));
      }
      if (!visible) {
        clear();
        return;
      }
      const rects = captured.range.getClientRects();
      const pointerLine =
        pointer === null
          ? undefined
          : Array.from(rects).find(
              (line) =>
                pointer.x >= line.left - 8 &&
                pointer.x <= line.right + 8 &&
                pointer.y >= line.top - 8 &&
                pointer.y <= line.bottom + 8,
            );
      // Below the clicked line, so the third click of a triple click still lands on text.
      const anchor = pointer && pointerLine ? { x: pointer.x, y: pointerLine.bottom + 4 } : null;
      const position = resolveSelectionActionPosition({
        bounds: viewportRect,
        selectionRect: rects.item(rects.length - 1) ?? rect,
        pointer: anchor,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      setSelection((current) => ({
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        // A triple click grows the shown selection; the actions stay where the user aimed.
        position: extending && current ? current.position : position,
      }));
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      restoreAfterScroll: true,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      onSelectionKey(event);
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node)
      ) {
        return;
      }
      const button = toolbar.querySelector<HTMLButtonElement>("button:not(:disabled)");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      button.focus({ preventScroll: true });
    };
    // Tab belongs to the foreground chat; a background timeline only follows its selection.
    if (!backgroundThread) document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [backgroundThread, threadRef, viewport]);

  if (!selection) return null;
  return (
    <AssistantSelectionActions
      toolbarRef={toolbarRef}
      position={selection.position}
      tooLong={selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH}
      onCite={cite}
      onDismiss={dismiss}
      portal={document.body}
    />
  );
}

export function AssistantSelectionActions({
  toolbarRef,
  position,
  tooLong,
  onCite,
  onDismiss,
  portal,
}: {
  toolbarRef: RefObject<HTMLDivElement | null>;
  position: SelectionActionPoint;
  tooLong: boolean;
  onCite: (action: "comment" | "preset", comment?: string) => boolean;
  onDismiss: () => void;
  portal: HTMLElement;
}) {
  const backgroundThread = use(BackgroundThreadContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clamps the toolbar inside the window before paint
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const rect = toolbar.getBoundingClientRect();
    const left = Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(position.y, window.innerHeight - rect.height - 8));
    const bounds = portal === document.body ? null : portal.getBoundingClientRect();
    toolbar.style.left = `${left - (bounds === null ? 0 : bounds.left + portal.clientLeft)}px`;
    toolbar.style.top = `${top - (bounds === null ? 0 : bounds.top + portal.clientTop)}px`;
  }, [portal, position, toolbarRef]);
  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Annotate selection"
      data-assistant-selection-toolbar={backgroundThread ? undefined : "true"}
      className="fixed z-50 flex max-w-[calc(100vw-1rem)] gap-1 rounded-md border border-border bg-popover p-1 shadow-md"

      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onDismiss();
        }
      }}
    >
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label={tooLong ? undefined : "Comment"}
        disabled={tooLong}
        onClick={() => onCite("comment")}
      >
        {tooLong ? "Shorten selection" : <MessageSquareIcon aria-hidden="true" />}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label="Looks good"
        disabled={tooLong}
        onClick={() => onCite("preset", "Looks good")}
      >
        {"\uD83D\uDC4D"}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-label="Can you explain this?"
        disabled={tooLong}
        onClick={() => onCite("preset", "Can you explain this?")}
      >
        {"\u2753"}
      </Button>
    </div>,
    portal,
  );
}
