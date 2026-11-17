import { collectAssistantCitations } from "./assistantCitations.ts";
import { SKILL_MENTION_PATTERN } from "./composerInlineTokens.ts";

// Pi embeds this function in its generated extension, so it must not depend on imports.
export function projectedCitationComments(text: string): string[] {
  const comments: string[] = [];
  for (const envelope of text.matchAll(
    /<assistant_citations>\n[^\n]*\n([\s\S]*?)\n<\/assistant_citations>/g,
  )) {
    try {
      const records: unknown = JSON.parse(envelope[1] ?? "");
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (typeof record !== "object" || record === null || !("citation" in record)) continue;
        const citation: unknown = record.citation;
        if (
          typeof citation === "object" &&
          citation !== null &&
          "comment" in citation &&
          typeof citation.comment === "string"
        ) {
          comments.push(citation.comment);
        }
      }
    } catch {
      continue;
    }
  }
  return comments;
}

export function citationCommentSkillNames(text: string): string[] {
  const comments = [
    ...projectedCitationComments(text),
    ...collectAssistantCitations(text).flatMap(({ citation }) => citation.comment ?? []),
  ];
  return [
    ...new Set(
      comments.flatMap((comment) =>
        [...comment.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => match[2] ?? []),
      ),
    ),
  ];
}

export function providerSkillNames(text: string): string[] {
  const body = text.replace(/<assistant_citations>[\s\S]*?<\/assistant_citations>/g, "");
  return [
    ...new Set([
      ...[...body.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => match[2] ?? []),
      ...citationCommentSkillNames(text),
    ]),
  ];
}
