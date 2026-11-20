import {
  ASSISTANT_CITATION_CONTEXT_LENGTH,
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  NonNegativeInt,
  type AssistantCitation,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const EVENT = "t3/notifications/page-annotation";
const STATE = "t3/notifications/page-annotation-state";
const MAX_COORDINATE = 1_000_000;
const Position = Schema.Finite.check(
  Schema.isBetween({ minimum: -MAX_COORDINATE, maximum: MAX_COORDINATE }),
);
const Extent = Schema.Finite.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(MAX_COORDINATE),
);
const Rect = Schema.Tuple([Position, Position, Extent, Extent]);
const Offset = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Selector = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_MAX_TEXT_LENGTH)),
  start: Offset,
  end: Offset,
  prefix: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
  suffix: Schema.String.check(Schema.isMaxLength(ASSISTANT_CITATION_CONTEXT_LENGTH)),
}).check(
  Schema.makeFilter(({ text, start, end }) => end - start === text.length && text.trim() !== ""),
);
const Notification = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("selection"),
    selector: Selector,
    rect: Rect,
    extending: Schema.Boolean,
    gesture: Offset,
  }),
  Schema.Struct({ kind: Schema.Literal("dismiss") }),
  Schema.Struct({ kind: Schema.Literal("highlight"), index: Offset, revision: Offset, rect: Rect }),
  Schema.Struct({
    kind: Schema.Literal("key"),
    gesture: Offset,
    key: Schema.String.check(Schema.isMaxLength(6)),
  }).check(
    Schema.makeFilter(
      ({ key }) => key === "Escape" || key === "Tab" || /^[^\p{Cc}\p{Cs}]$/u.test(key),
    ),
  ),
]);
const decodeNotification = Schema.decodeUnknownOption(Notification);

export type HtmlRenderAnnotationEvent = typeof Notification.Type;
export type HtmlRenderAnnotationRect = typeof Rect.Type;

export function readHtmlRenderAnnotationEvent(
  data: unknown,
): HtmlRenderAnnotationEvent | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0" || method !== EVENT) return undefined;
  return Option.getOrUndefined(decodeNotification(params));
}

const selectorOf = ({ text, start, end, prefix, suffix }: AssistantCitation) => ({
  text,
  start,
  end,
  prefix,
  suffix,
});
export function htmlRenderAnnotationState(
  citations: readonly AssistantCitation[],
  revision: number,
  reveal: AssistantCitation | null,
) {
  return {
    jsonrpc: "2.0",
    method: STATE,
    params: {
      kind: "highlights",
      selectors: citations.map(selectorOf),
      revision,
      reveal: reveal && selectorOf(reveal),
    },
  } as const;
}

export function htmlRenderSelectionState(gesture: number | null) {
  return { jsonrpc: "2.0", method: STATE, params: { kind: "selection", gesture } } as const;
}

export const HTML_RENDER_ANNOTATIONS_QUERY = "t3-page-annotations";
export const HTML_RENDER_MAX_PAGE_BYTES = 25 * 1024 * 1024;

export const HTML_RENDER_ANNOTATIONS_SCRIPT = String.raw`
(function () {
  if (parent === window) return;
  const highlightName = "t3-page-citation";
  const revealName = "t3-page-citation-reveal";
  const excluded = "button,input,textarea,select,[contenteditable],[hidden],[aria-hidden=true],script,style,template,noscript,svg";
  const blocks = "address,article,aside,blockquote,dd,div,dl,dt,figcaption,figure,footer,h1,h2,h3,h4,h5,h6,header,li,main,nav,ol,p,pre,section,table,td,th,tr,ul,br";
  const post = (params) => parent.postMessage({ jsonrpc: "2.0", method: ${JSON.stringify(EVENT)}, params }, "*");
  const rectArray = (rect) => [rect.left, rect.top, rect.width, rect.height];
  let selectors = [], ranges = [], reveal = null, revision = 0;
  let enabled = false, held = false, gesture = 0, active = null, acknowledged = null, extending = false;
  let scheduled = 0, redraw = 0, revealTimer = 0, down = null, focusingToolbar = false;

  function readText() {
    const parts = [], nodes = [];
    let length = 0, newline = false;
    if (!document.body) return { text: "", nodes };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        if (node.matches(excluded) || getComputedStyle(node).display === "none") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(), previous = null; node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches(blocks)) newline = true;
        continue;
      }
      if (!node.length) continue;
      const block = node.parentElement.closest(blocks);
      if ((newline || block !== previous) && length) { parts.push("\n"); length++; }
      newline = false;
      previous = block;
      nodes.push({ node, start: length, end: length + node.length });
      parts.push(node.data);
      length += node.length;
    }
    return { text: parts.join(""), nodes };
  }

  function findRange({ text, nodes }, selector) {
    const quote = selector.text;
    let match = -1, only = -1, count = 0;
    for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
      only = at;
      count++;
      if (text.slice(Math.max(0, at - selector.prefix.length), at) !== selector.prefix ||
          text.slice(at + quote.length, at + quote.length + selector.suffix.length) !== selector.suffix) continue;
      if (match !== -1) return null;
      match = at;
    }
    if (match === -1 && count === 1) match = only;
    if (match === -1) return null;
    const end = match + quote.length;
    const first = nodes.find((entry) => entry.start <= match && entry.end > match);
    const last = nodes.find((entry) => entry.start < end && entry.end >= end);
    if (!first || !last) return null;
    const range = new Range();
    range.setStart(first.node, match - first.start);
    range.setEnd(last.node, end - last.start);
    return range;
  }

  function paint() {
    redraw = 0;
    if (!CSS.highlights || typeof Highlight !== "function") return;
    const index = selectors.length || reveal ? readText() : null;
    ranges = index ? selectors.flatMap((selector, indexInDraft) => {
      const range = findRange(index, selector);
      return range ? [{ range, indexInDraft }] : [];
    }) : [];
    CSS.highlights.set(highlightName, new Highlight(...ranges.map(({ range }) => range)));
    if (reveal && index) {
      const range = findRange(index, reveal);
      if (range) CSS.highlights.set(revealName, new Highlight(range));
      reveal = null;
      clearTimeout(revealTimer);
      revealTimer = setTimeout(() => CSS.highlights.delete(revealName), 1800);
    }
  }

  const observer = new MutationObserver(() => {
    if (!redraw) redraw = requestAnimationFrame(paint);
  });
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== parent || data?.jsonrpc !== "2.0" || data.method !== ${JSON.stringify(STATE)}) return;
    const state = data.params;
    if (state.kind === "selection") {
      if (state.gesture === null) { active = acknowledged = null; getSelection()?.removeAllRanges(); }
      else if (active === state.gesture) acknowledged = state.gesture;
      return;
    }
    if (state.kind !== "highlights") return;
    enabled = true;
    ranges = [];
    selectors = state.selectors;
    revision = state.revision;
    reveal = state.reveal;
    observer.disconnect();
    if (selectors.length && document.body) observer.observe(document.body, {
      childList: true, characterData: true, attributes: true, subtree: true,
      attributeFilter: ["hidden", "aria-hidden"],
    });
    if (!redraw) redraw = requestAnimationFrame(paint);
  });

  function dismiss() {
    cancelAnimationFrame(scheduled);
    scheduled = 0;
    if (active !== null) post({ kind: "dismiss" });
    active = acknowledged = null;
  }

  function capture(pointer) {
    scheduled = 0;
    const selection = getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) { dismiss(); return; }
    const selected = selection.getRangeAt(0);
    const index = readText();
    let start = -1, end = -1, first, last;
    for (const entry of index.nodes) {
      const { node } = entry;
      if (!selected.intersectsNode(node)) continue;
      const from = node === selected.startContainer ? selected.startOffset : 0;
      const to = node === selected.endContainer ? selected.endOffset : node.length;
      if (to <= from || getComputedStyle(node.parentElement).userSelect === "none") continue;
      if (start === -1) { start = entry.start + from; first = node; }
      end = entry.start + to;
      last = node;
    }
    if (!first || !last || end - start > ${ASSISTANT_CITATION_MAX_TEXT_LENGTH}) { dismiss(); return; }
    const text = index.text.slice(start, end);
    if (!text.trim()) { dismiss(); return; }
    const range = new Range();
    range.setStart(first, first === selected.startContainer ? selected.startOffset : 0);
    range.setEnd(last, last === selected.endContainer ? selected.endOffset : last.length);
    const lines = Array.from(range.getClientRects()).filter((line) => line.width && line.height && line.bottom > 0 && line.top < innerHeight);
    const line = pointer && lines.find(({ left, right, top, bottom }) =>
      pointer.x >= left - 8 && pointer.x <= right + 8 && pointer.y >= top - 8 && pointer.y <= bottom + 8);
    const rect = line || lines.at(-1);
    if (!rect) { dismiss(); return; }
    const context = ${ASSISTANT_CITATION_CONTEXT_LENGTH};
    const prefix = index.text.slice(Math.max(0, start - context), start).replace(/^[\uDC00-\uDFFF]/, "");
    const suffix = index.text.slice(end, end + context).replace(/[\uD800-\uDBFF]$/, "");
    active = gesture;
    post({ kind: "selection", selector: { text, start, end, prefix, suffix }, rect: rectArray(rect), extending, gesture });
  }

  function editable(event) {
    const target = event.composedPath()[0];
    return target instanceof Element && (target.isContentEditable || !!target.closest("input,textarea,select"));
  }

  document.addEventListener("mousedown", (event) => {
    if (!enabled || !event.isTrusted || event.button !== 0) return;
    cancelAnimationFrame(scheduled);
    scheduled = 0;
    gesture++;
    extending = event.detail > 1;
    held = !editable(event);
    down = held ? { x: event.clientX, y: event.clientY } : null;
    if (!extending || !held) dismiss();
  }, true);
  window.addEventListener("mouseup", (event) => {
    if (!event.isTrusted || event.button !== 0 || !held) return;
    held = false;
    const pointer = { x: event.clientX, y: event.clientY };
    scheduled = requestAnimationFrame(() => capture(pointer));
  });
  document.addEventListener("selectionchange", (event) => {
    if (enabled && event.isTrusted && !held && scheduled === 0 && active !== null) {
      scheduled = requestAnimationFrame(() => capture(null));
    }
  });
  window.addEventListener("click", (event) => {
    const origin = down;
    down = null;
    if (!event.isTrusted || event.button !== 0 || event.detail > 1 || !origin || !getSelection()?.isCollapsed ||
        Math.hypot(origin.x - event.clientX, origin.y - event.clientY) > 4 || event.defaultPrevented ||
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
        event.target instanceof Element && event.target.closest("a,button,input,textarea")) return;
    for (const { indexInDraft, range } of ranges) {
      const rect = Array.from(range.getClientRects()).find((line) =>
        event.clientX >= line.left && event.clientX <= line.right && event.clientY >= line.top && event.clientY <= line.bottom);
      if (!rect) continue;
      post({ kind: "highlight", index: indexInDraft, revision, rect: rectArray(rect) });
      break;
    }
  });
  window.addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.defaultPrevented || active === null || acknowledged !== active ||
        event.isComposing || event.metaKey || event.ctrlKey || event.altKey || editable(event)) return;
    if (event.key !== "Escape" && event.key !== "Tab" && !/^[^\p{Cc}\p{Cs}]$/u.test(event.key)) return;
    if (event.key === "Tab" && event.shiftKey) return;
    event.preventDefault();
    focusingToolbar = event.key === "Tab";
    post({ kind: "key", key: event.key, gesture: active });
  });
  window.addEventListener("scroll", () => { if (!held) dismiss(); }, true);
  window.addEventListener("resize", dismiss);
  window.addEventListener("blur", () => {
    held = false;
    if (!focusingToolbar) dismiss();
    focusingToolbar = false;
  });
})();
`;
