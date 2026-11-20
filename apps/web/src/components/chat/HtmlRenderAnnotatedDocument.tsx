import { type AssistantCitation, type MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import {
  HTML_RENDER_ANNOTATIONS_QUERY,
  htmlRenderAnnotationState,
  htmlRenderSelectionState,
  type HtmlRenderAnnotationEvent,
  type HtmlRenderAnnotationRect,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { useEffect, useEffectEvent, useRef, useState, type ComponentProps } from "react";
import { useComposerDraftStore, type ComposerThreadTarget } from "~/composerDraftStore";
import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import {
  isSelectionRectVisible,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { AssistantSelectionActions } from "./AssistantSelectionToolbar";
import { draftCitationsForThread } from "./assistantDraftCitations";

export type CiteAssistantText = (
  citation: AssistantCitation,
  anchor: AssistantCitationSourceAnchor,
  action: "comment" | "preset",
) => boolean;

export type HtmlRenderCitationSource = {
  threadRef: ScopedThreadRef;
  draftTarget: ComposerThreadTarget;
  messageId: MessageId;
  onCite: CiteAssistantText;
  reveal: { key: string; citation: AssistantCitation } | null;
};

type PageAnchor = Extract<AssistantCitationSourceAnchor, { source: HTMLIFrameElement }>;
type PageSelection = {
  gesture: number;
  citation: AssistantCitation;
  anchor: PageAnchor;
  position: SelectionActionPoint;
};

function frameRect(frame: HTMLIFrameElement, [x, y, width, height]: HtmlRenderAnnotationRect) {
  const bounds = frame.getBoundingClientRect();
  const scaleX = bounds.width / Math.max(1, frame.clientWidth);
  const scaleY = bounds.height / Math.max(1, frame.clientHeight);
  return new DOMRect(bounds.x + x * scaleX, bounds.y + y * scaleY, width * scaleX, height * scaleY);
}

export function HtmlRenderAnnotatedDocument({
  htmlRender,
  source,
  ...props
}: Omit<ComponentProps<typeof HtmlRenderDocument>, "annotations"> & {
  htmlRender: HtmlRenderReference;
  source: HtmlRenderCitationSource;
}) {
  const { threadRef, draftTarget, messageId, reveal, onCite } = source;
  const { attachmentId, title } = htmlRender;
  const draftKey = useComposerDraftStore((store) =>
    draftCitationsForThread(store.getComposerDraft(draftTarget)?.prompt ?? "", threadRef)
      .filter(
        (citation) =>
          citation.messageId === messageId && citation.page?.attachmentId === attachmentId,
      )
      .map(serializeAssistantCitation)
      .join(" "),
  );
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const posted = useRef<{
    citations: AssistantCitation[];
    revision: number;
    revealKey: string | null;
  }>({ citations: [], revision: 0, revealKey: null });
  const liveSelection = useRef<PageSelection | null>(null);
  const [selection, setSelection] = useState<PageSelection | null>(null);
  const select = (next: PageSelection | null) => {
    liveSelection.current = next;
    setSelection(next);
  };
  const dismiss = () => {
    select(null);
    frameRef.current?.contentWindow?.postMessage(htmlRenderSelectionState(null), "*");
  };
  const cite = (action: "comment" | "preset", comment?: string) => {
    const current = liveSelection.current;
    if (!current) return false;
    const citation = comment === undefined ? current.citation : { ...current.citation, comment };
    if (!onCite(citation, current.anchor, action)) return false;
    dismiss();
    return true;
  };
  const postHighlights = (frame: HTMLIFrameElement) => {
    const citations = collectAssistantCitations(draftKey).map(({ citation }) => citation);
    const revision = posted.current.revision + 1;
    const revealKey = reveal?.key ?? null;
    const target = revealKey === posted.current.revealKey ? null : (reveal?.citation ?? null);
    posted.current = { citations, revision, revealKey };
    frame.contentWindow?.postMessage(htmlRenderAnnotationState(citations, revision, target), "*");
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- syncs saved draft ranges to the sandbox after composer edits
  useEffect(() => {
    const frame = frameRef.current;
    if (frame) postHighlights(frame);
  }, [postHighlights]);
  const clearOutside = useEffectEvent((event: Event) => {
    if (!liveSelection.current || toolbarRef.current?.contains(event.target as Node)) return;
    if (
      event.type === "scroll" &&
      event.target instanceof Node &&
      !event.target.contains(frameRef.current)
    )
      return;
    dismiss();
  });
  const hasSelection = selection !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dismisses floating selection actions on parent gestures and scrolling
  useEffect(() => {
    if (!hasSelection) return;
    const clear = (event: Event) => clearOutside(event);
    for (const event of ["pointerdown", "scroll", "resize"])
      window.addEventListener(event, clear, true);
    return () => {
      for (const event of ["pointerdown", "scroll", "resize"])
        window.removeEventListener(event, clear, true);
    };
  }, [hasSelection]);

  const onEvent = (frame: HTMLIFrameElement, event: HtmlRenderAnnotationEvent) => {
    if (event.kind === "dismiss") {
      select(null);
      return;
    }
    if (event.kind === "key") {
      if (liveSelection.current?.gesture !== event.gesture) return;
      if (event.key === "Escape") dismiss();
      else if (event.key === "Tab")
        toolbarRef.current?.querySelector("button")?.focus({ preventScroll: true });
      else cite("comment", event.key);
      return;
    }
    const portal = frame.closest<HTMLElement>('[data-slot="dialog-popup"]');
    const viewport =
      portal?.querySelector<HTMLElement>("[data-html-render-scroll]") ??
      frame.closest<HTMLElement>("[data-assistant-citation-viewport]");
    const bounds = frame.getBoundingClientRect();
    const rect = frameRect(frame, event.rect);
    const viewportRect = viewport?.getBoundingClientRect() ?? bounds;
    if (
      !isSelectionRectVisible(rect, [
        bounds,
        viewportRect,
        { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
      ])
    )
      return;
    const anchor = {
      source: frame,
      portal,
      getBoundingClientRect: () => frameRect(frame, event.rect),
    };
    if (event.kind === "highlight") {
      const citation =
        event.revision === posted.current.revision && posted.current.citations[event.index];
      if (citation) onCite(citation, anchor, "comment");
      return;
    }
    const current = liveSelection.current;
    const position =
      event.extending && current
        ? current.position
        : resolveSelectionActionPosition({
            bounds: viewportRect,
            selectionRect: rect,
            pointer: null,
            viewport: { width: innerWidth, height: innerHeight },
          });
    select({
      gesture: event.gesture,
      anchor,
      position,
      citation: {
        version: 1,
        ...threadRef,
        messageId,
        page: { attachmentId, title },
        ...event.selector,
      },
    });
    frame.contentWindow?.postMessage(htmlRenderSelectionState(event.gesture), "*");
  };

  const src = new URL(props.src, window.location.href);
  src.searchParams.set(HTML_RENDER_ANNOTATIONS_QUERY, "1");
  return (
    <>
      <HtmlRenderDocument
        {...props}
        src={src.href}
        annotations={{
          onEvent,
          onLoad: (frame) => {
            frameRef.current = frame;
            posted.current.revealKey = null;
            select(null);
            postHighlights(frame);
          },
        }}
      />
      {selection ? (
        <AssistantSelectionActions
          toolbarRef={toolbarRef}
          position={selection.position}
          tooLong={false}
          onCite={cite}
          onDismiss={dismiss}
          portal={selection.anchor.portal ?? document.body}
        />
      ) : null}
    </>
  );
}
