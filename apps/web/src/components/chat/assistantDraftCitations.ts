import type { AssistantCitation, ScopedThreadRef } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";

export function mergeDraftCitation(prompt: string, citation: AssistantCitation) {
  const existing = collectAssistantCitations(prompt).find(
    ({ citation: saved }) =>
      saved.environmentId === citation.environmentId &&
      saved.threadId === citation.threadId &&
      saved.messageId === citation.messageId &&
      saved.page?.attachmentId === citation.page?.attachmentId &&
      saved.start === citation.start &&
      saved.end === citation.end,
  );
  if (!existing) return null;
  const next = citation.comment === undefined ? existing.citation : citation;
  return { start: existing.start, end: existing.end, text: serializeAssistantCitation(next) };
}

export function draftCitationsForThread(prompt: string, thread: ScopedThreadRef) {
  return collectAssistantCitations(prompt)
    .map(({ citation }) => citation)
    .filter(
      (citation) =>
        citation.environmentId === thread.environmentId && citation.threadId === thread.threadId,
    );
}

export function selectionCommentCharacter(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "defaultPrevented"
  >,
  editable: boolean,
): string | null {
  if (
    editable ||
    event.defaultPrevented ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return null;
  return Array.from(event.key).length === 1 ? event.key : null;
}
