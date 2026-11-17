import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  type AssistantCitation,
  type ServerProviderSkill,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { createContext, use, useEffect, useId, useRef, useState, type RefObject } from "react";
import { detectComposerTrigger } from "~/composer-logic";
import { searchProviderSkills } from "~/providerSkillSearch";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import {
  ComposerCommandMenu,
  composerSuggestionOptionId,
  type ComposerCommandItem,
} from "./ComposerCommandMenu";

import { TextFieldSpeechControls, useTextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { textDirection } from "~/textDirection";

import { ComposerContextActionsContext } from "../composerContextActions";
import { Button } from "../ui/button";

export const AssistantCitationSkillsContext = createContext<{
  skills: ReadonlyArray<ServerProviderSkill>;
  provider: ProviderDriverKind;
} | null>(null);

export function AssistantCitationCommentEditor({
  citation,
  inputRef,
  onSubmit,
  onSubmitAndSend,
  onCancel,
  onDelete,
  onDraftChange,
  onVoiceSetupOpenChange,
}: {
  citation: AssistantCitation;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onSubmit: (comment: string) => boolean;
  onSubmitAndSend?: (comment: string) => boolean;
  onCancel: () => void;
  onDelete?: () => void;
  onDraftChange?: (comment: string) => void;
  onVoiceSetupOpenChange?: (open: boolean) => void;
}) {
  const [comment, setComment] = useState(citation.comment ?? "");
  const catalog = use(AssistantCitationSkillsContext);
  const resolvedTheme = useRenderedAppearance();
  const listId = useId();
  const [cursor, setCursor] = useState(comment.length);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const trigger = detectComposerTrigger(comment, cursor);
  const skillTrigger =
    trigger?.kind === "skill" &&
    comment[trigger.rangeStart] === "$" &&
    dismissedAt !== `${comment}:${cursor}`
      ? trigger
      : null;
  const items: ComposerCommandItem[] =
    catalog && skillTrigger
      ? searchProviderSkills(catalog.skills, skillTrigger.query).map((skill) => ({
          id: `skill:${catalog.provider}:${skill.name}`,
          type: "skill",
          provider: catalog.provider,
          skill,
          label: formatProviderSkillDisplayName(skill),
          description: skill.shortDescription ?? skill.description ?? "Run provider skill",
        }))
      : [];
  const activeId = items.find((item) => item.id === highlightedId)?.id ?? items[0]?.id ?? null;
  const localInputRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = inputRef ?? localInputRef;
  const { environmentId, projectId } = use(ComposerContextActionsContext);
  const updateComment = (text: string) => {
    setComment(text);
    onDraftChange?.(text);
  };
  const selectSkill = (item: ComposerCommandItem) => {
    if (item.type !== "skill" || !skillTrigger || speech.freezesEditor) return;
    const inserted = `$${item.skill.name} `;
    const nextCursor = skillTrigger.rangeStart + inserted.length;
    updateComment(
      `${comment.slice(0, skillTrigger.rangeStart)}${inserted}${comment.slice(cursor)}`,
    );
    setCursor(nextCursor);
    setHighlightedId(null);
    const input = textareaRef.current;
    if (input) {
      input.focus({ preventScroll: true });
      input.value = `${comment.slice(0, skillTrigger.rangeStart)}${inserted}${comment.slice(cursor)}`;
      input.setSelectionRange(nextCursor, nextCursor);
    }
  };
  const speech = useTextFieldSpeech({
    environmentId: environmentId ?? citation.environmentId,
    projectId,
    ownerKey: JSON.stringify([
      "citation",
      environmentId,
      citation.threadId,
      citation.messageId,
      citation.start,
      citation.end,
    ]),
    text: comment,
    textareaRef,
    onTextChange: updateComment,
  });
  const setupOpen = speech.setup.open;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the citation popover open while the voice setup dialog owns focus
  useEffect(() => {
    onVoiceSetupOpenChange?.(setupOpen);
    return () => onVoiceSetupOpenChange?.(false);
  }, [onVoiceSetupOpenChange, setupOpen]);
  const commentTooLong = comment.length > ASSISTANT_CITATION_MAX_COMMENT_LENGTH;
  const submit = () => {
    speech.submitAfterDictation((text) => {
      if (text.length <= ASSISTANT_CITATION_MAX_COMMENT_LENGTH) onSubmit(text);
    });
  };
  const submitAndSend = () => {
    speech.submitAfterDictation((text) => {
      if (text.length <= ASSISTANT_CITATION_MAX_COMMENT_LENGTH) (onSubmitAndSend ?? onSubmit)(text);
    });
  };

  return (
    <div
      data-citation-comment-editor="true"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          if (speech.state.phase !== "idle") speech.cancel();
          else onCancel();
        }
      }}
    >
      <textarea
        ref={textareaRef}
        readOnly={speech.freezesEditor}
        aria-label="Comment on selected text"
        aria-autocomplete="list"
        aria-controls={skillTrigger ? listId : undefined}
        aria-activedescendant={
          skillTrigger && activeId ? composerSuggestionOptionId(listId, activeId) : undefined
        }
        aria-description="Enter to save the citation comment; Command/Ctrl+Enter to save and send; Shift+Enter for a new line."
        aria-invalid={commentTooLong || undefined}
        placeholder="Add an optional comment..."
        rows={2}
        dir={textDirection(comment)}
        className="field-sizing-content block max-h-40 min-h-16 w-full resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
        value={comment}
        onChange={(event) => {
          updateComment(event.currentTarget.value);
          setCursor(event.currentTarget.selectionStart);
        }}
        onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
        onKeyDown={(event) => {
          if (!event.nativeEvent.isComposing && event.keyCode !== 229 && skillTrigger) {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setDismissedAt(`${comment}:${cursor}`);
              return;
            }
            if (items.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              const index = items.findIndex((item) => item.id === activeId);
              setHighlightedId(
                items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]
                  ?.id ?? null,
              );
              return;
            }
            if (
              (event.key === "Enter" || event.key === "Tab") &&
              !event.shiftKey &&
              !event.metaKey &&
              !event.ctrlKey
            ) {
              const active = items.find((item) => item.id === activeId);
              if (active) {
                event.preventDefault();
                selectSkill(active);
                return;
              }
            }
          }
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            if (event.metaKey || event.ctrlKey) {
              submitAndSend();
            } else {
              submit();
            }
          }
        }}
      />
      {skillTrigger && !speech.freezesEditor ? (
        <div onPointerDown={(event) => event.preventDefault()}>
          <ComposerCommandMenu
            listId={listId}
            items={items}
            resolvedTheme={resolvedTheme}
            isLoading={false}
            triggerKind="skill"
            emptyStateText="No matching skills."
            activeItemId={activeId}
            onHighlightedItemChange={setHighlightedId}
            onSelect={selectSkill}
          />
        </div>
      ) : null}
      {commentTooLong ? (
        <p role="status" className="pt-1 text-xs text-destructive">
          Comments can contain up to {ASSISTANT_CITATION_MAX_COMMENT_LENGTH.toLocaleString()}{" "}
          characters.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {onDelete ? (
          <Button variant="destructive" size="xs" onClick={onDelete}>
            Delete
          </Button>
        ) : null}
        <TextFieldSpeechControls speech={speech} />
        <Button
          variant="outline"
          size="xs"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={speech.preparing || (commentTooLong && !speech.blocksSubmission)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={submit}
        >
          {commentTooLong ? "Shorten comment" : "Save"}
        </Button>
      </div>
    </div>
  );
}
