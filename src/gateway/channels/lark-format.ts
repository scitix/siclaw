/**
 * Markdown → Lark Post format converter
 *
 * Ported from openclaw's markdown IR system:
 *   - src/markdown/ir.ts (markdown → IR via markdown-it)
 *   - src/lark/format.ts (IR → Lark post elements)
 */

import MarkdownIt from "markdown-it";

// ─── Types ──────────────────────────────────────────────────

export type MarkdownTableMode = "off" | "bullets" | "code";

export type MarkdownStyle = "bold" | "italic" | "strikethrough" | "code" | "code_block";

export type MarkdownStyleSpan = {
  start: number;
  end: number;
  style: MarkdownStyle;
};

export type MarkdownLinkSpan = {
  start: number;
  end: number;
  href: string;
};

export type MarkdownIR = {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
};

type MarkdownToken = {
  type: string;
  content?: string;
  children?: MarkdownToken[];
  attrs?: [string, string][];
  attrGet?: (name: string) => string | null;
};

type ListState = { type: "bullet" | "ordered"; index: number };
type LinkState = { href: string; labelStart: number };
type RenderEnv = { listStack: ListState[] };

type OpenStyle = { style: MarkdownStyle; start: number };

type RenderTarget = {
  text: string;
  styles: MarkdownStyleSpan[];
  openStyles: OpenStyle[];
  links: MarkdownLinkSpan[];
  linkStack: LinkState[];
};

type TableCell = {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
};

type TableState = {
  headers: TableCell[];
  rows: TableCell[][];
  currentRow: TableCell[];
  currentCell: RenderTarget | null;
  inHeader: boolean;
};

type RenderState = RenderTarget & {
  env: RenderEnv;
  headingStyle: "none" | "bold";
  blockquotePrefix: string;
  tableMode: MarkdownTableMode;
  table: TableState | null;
};

export type MarkdownParseOptions = {
  linkify?: boolean;
  headingStyle?: "none" | "bold";
  blockquotePrefix?: string;
  tableMode?: MarkdownTableMode;
};

// ─── Lark Post types ────────────────────────────────────────

type LarkPostElement =
  | { tag: "text"; text: string; style?: string[] }
  | { tag: "a"; text: string; href: string; style?: string[] };

type LarkPostLine = LarkPostElement[];

type LarkPostContent = {
  zh_cn?: { title?: string; content: LarkPostLine[] };
};

type StyleState = {
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  code: boolean;
};

// ─── markdown-it setup ─────────────────────────────────────

function createMd(options: MarkdownParseOptions): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: options.linkify ?? true,
    breaks: false,
    typographer: false,
  });
  md.enable("strikethrough");
  if (options.tableMode && options.tableMode !== "off") {
    md.enable("table");
  } else {
    md.disable("table");
  }
  return md;
}

// ─── IR rendering helpers ───────────────────────────────────

function getAttr(token: MarkdownToken, name: string): string | null {
  if (token.attrGet) return token.attrGet(name);
  if (token.attrs) {
    for (const [key, value] of token.attrs) {
      if (key === name) return value;
    }
  }
  return null;
}

function initRenderTarget(): RenderTarget {
  return { text: "", styles: [], openStyles: [], links: [], linkStack: [] };
}

function resolveTarget(state: RenderState): RenderTarget {
  return state.table?.currentCell ?? state;
}

function appendText(state: RenderState, value: string) {
  if (!value) return;
  resolveTarget(state).text += value;
}

function openStyle(state: RenderState, style: MarkdownStyle) {
  const t = resolveTarget(state);
  t.openStyles.push({ style, start: t.text.length });
}

function closeStyle(state: RenderState, style: MarkdownStyle) {
  const t = resolveTarget(state);
  for (let i = t.openStyles.length - 1; i >= 0; i--) {
    if (t.openStyles[i]?.style === style) {
      const start = t.openStyles[i].start;
      t.openStyles.splice(i, 1);
      const end = t.text.length;
      if (end > start) t.styles.push({ start, end, style });
      return;
    }
  }
}

function appendParagraphSep(state: RenderState) {
  if (state.env.listStack.length > 0 || state.table) return;
  state.text += "\n\n";
}

function appendListPrefix(state: RenderState) {
  const stack = state.env.listStack;
  const top = stack[stack.length - 1];
  if (!top) return;
  top.index += 1;
  const indent = "  ".repeat(Math.max(0, stack.length - 1));
  const prefix = top.type === "ordered" ? `${top.index}. ` : "• ";
  state.text += `${indent}${prefix}`;
}

function renderInlineCode(state: RenderState, content: string) {
  if (!content) return;
  const t = resolveTarget(state);
  const start = t.text.length;
  t.text += content;
  t.styles.push({ start, end: start + content.length, style: "code" });
}

function renderCodeBlock(state: RenderState, content: string) {
  let code = content ?? "";
  if (!code.endsWith("\n")) code = `${code}\n`;
  const t = resolveTarget(state);
  const start = t.text.length;
  t.text += code;
  t.styles.push({ start, end: start + code.length, style: "code_block" });
  if (state.env.listStack.length === 0) t.text += "\n";
}

function handleLinkClose(state: RenderState) {
  const t = resolveTarget(state);
  const link = t.linkStack.pop();
  if (!link?.href) return;
  const href = link.href.trim();
  if (!href) return;
  const start = link.labelStart;
  const end = t.text.length;
  if (end >= start) t.links.push({ start, end, href });
}

// ─── Table rendering ────────────────────────────────────────

function initTableState(): TableState {
  return { headers: [], rows: [], currentRow: [], currentCell: null, inHeader: false };
}

function closeRemainingStyles(target: RenderTarget) {
  for (let i = target.openStyles.length - 1; i >= 0; i--) {
    const open = target.openStyles[i];
    const end = target.text.length;
    if (end > open.start) target.styles.push({ start: open.start, end, style: open.style });
  }
  target.openStyles = [];
}

function finishTableCell(cell: RenderTarget): TableCell {
  closeRemainingStyles(cell);
  return { text: cell.text, styles: cell.styles, links: cell.links };
}

function trimCell(cell: TableCell): TableCell {
  const text = cell.text;
  let start = 0;
  let end = text.length;
  while (start < end && /\s/.test(text[start] ?? "")) start++;
  while (end > start && /\s/.test(text[end - 1] ?? "")) end--;
  if (start === 0 && end === text.length) return cell;
  const trimmedText = text.slice(start, end);
  const len = trimmedText.length;
  const styles: MarkdownStyleSpan[] = [];
  for (const s of cell.styles) {
    const a = Math.max(0, s.start - start);
    const b = Math.min(len, s.end - start);
    if (b > a) styles.push({ start: a, end: b, style: s.style });
  }
  const links: MarkdownLinkSpan[] = [];
  for (const l of cell.links) {
    const a = Math.max(0, l.start - start);
    const b = Math.min(len, l.end - start);
    if (b > a) links.push({ start: a, end: b, href: l.href });
  }
  return { text: trimmedText, styles, links };
}

function appendCell(state: RenderState, cell: TableCell) {
  if (!cell.text) return;
  const start = state.text.length;
  state.text += cell.text;
  for (const s of cell.styles) state.styles.push({ start: start + s.start, end: start + s.end, style: s.style });
  for (const l of cell.links) state.links.push({ start: start + l.start, end: start + l.end, href: l.href });
}

function renderTableAsBullets(state: RenderState) {
  if (!state.table) return;
  const headers = state.table.headers.map(trimCell);
  const rows = state.table.rows.map((r) => r.map(trimCell));
  if (headers.length === 0 && rows.length === 0) return;

  const useLabel = headers.length > 1 && rows.length > 0;
  if (useLabel) {
    for (const row of rows) {
      if (row.length === 0) continue;
      const label = row[0];
      if (label?.text) {
        const ls = state.text.length;
        appendCell(state, label);
        const le = state.text.length;
        if (le > ls) state.styles.push({ start: ls, end: le, style: "bold" });
        state.text += "\n";
      }
      for (let i = 1; i < row.length; i++) {
        const val = row[i];
        if (!val?.text) continue;
        state.text += "• ";
        if (headers[i]?.text) { appendCell(state, headers[i]); state.text += ": "; }
        appendCell(state, val);
        state.text += "\n";
      }
      state.text += "\n";
    }
  } else {
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        const val = row[i];
        if (!val?.text) continue;
        state.text += "• ";
        if (headers[i]?.text) { appendCell(state, headers[i]); state.text += ": "; }
        appendCell(state, val);
        state.text += "\n";
      }
      state.text += "\n";
    }
  }
}

function renderTableAsCode(state: RenderState) {
  if (!state.table) return;
  const headers = state.table.headers.map(trimCell);
  const rows = state.table.rows.map((r) => r.map(trimCell));
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length));
  if (colCount === 0) return;

  const widths = Array.from({ length: colCount }, () => 0);
  const updateWidths = (cells: TableCell[]) => {
    for (let i = 0; i < colCount; i++) {
      const w = cells[i]?.text.length ?? 0;
      if (widths[i] < w) widths[i] = w;
    }
  };
  updateWidths(headers);
  for (const row of rows) updateWidths(row);

  const codeStart = state.text.length;
  const appendRow = (cells: TableCell[]) => {
    state.text += "|";
    for (let i = 0; i < colCount; i++) {
      state.text += " ";
      const cell = cells[i];
      if (cell) appendCell(state, cell);
      const pad = widths[i] - (cell?.text.length ?? 0);
      if (pad > 0) state.text += " ".repeat(pad);
      state.text += " |";
    }
    state.text += "\n";
  };
  const appendDiv = () => {
    state.text += "|";
    for (let i = 0; i < colCount; i++) state.text += ` ${"-".repeat(Math.max(3, widths[i]))} |`;
    state.text += "\n";
  };

  appendRow(headers);
  appendDiv();
  for (const row of rows) appendRow(row);
  const codeEnd = state.text.length;
  if (codeEnd > codeStart) state.styles.push({ start: codeStart, end: codeEnd, style: "code_block" });
  if (state.env.listStack.length === 0) state.text += "\n";
}

// ─── Token rendering ────────────────────────────────────────

function renderTokens(tokens: MarkdownToken[], state: RenderState): void {
  for (const token of tokens) {
    switch (token.type) {
      case "inline":
        if (token.children) renderTokens(token.children, state);
        break;
      case "text":
        appendText(state, token.content ?? "");
        break;
      case "em_open": openStyle(state, "italic"); break;
      case "em_close": closeStyle(state, "italic"); break;
      case "strong_open": openStyle(state, "bold"); break;
      case "strong_close": closeStyle(state, "bold"); break;
      case "s_open": openStyle(state, "strikethrough"); break;
      case "s_close": closeStyle(state, "strikethrough"); break;
      case "code_inline": renderInlineCode(state, token.content ?? ""); break;
      case "link_open": {
        const href = getAttr(token, "href") ?? "";
        const t = resolveTarget(state);
        t.linkStack.push({ href, labelStart: t.text.length });
        break;
      }
      case "link_close": handleLinkClose(state); break;
      case "image": appendText(state, token.content ?? ""); break;
      case "softbreak":
      case "hardbreak": appendText(state, "\n"); break;
      case "paragraph_close": appendParagraphSep(state); break;
      case "heading_open":
        if (state.headingStyle === "bold") openStyle(state, "bold");
        break;
      case "heading_close":
        if (state.headingStyle === "bold") closeStyle(state, "bold");
        appendParagraphSep(state);
        break;
      case "blockquote_open":
        if (state.blockquotePrefix) state.text += state.blockquotePrefix;
        break;
      case "blockquote_close": state.text += "\n"; break;
      case "bullet_list_open":
        state.env.listStack.push({ type: "bullet", index: 0 });
        break;
      case "bullet_list_close": state.env.listStack.pop(); break;
      case "ordered_list_open": {
        const start = Number(getAttr(token, "start") ?? "1");
        state.env.listStack.push({ type: "ordered", index: start - 1 });
        break;
      }
      case "ordered_list_close": state.env.listStack.pop(); break;
      case "list_item_open": appendListPrefix(state); break;
      case "list_item_close": state.text += "\n"; break;
      case "code_block":
      case "fence": renderCodeBlock(state, token.content ?? ""); break;
      case "html_block":
      case "html_inline": appendText(state, token.content ?? ""); break;
      case "table_open":
        if (state.tableMode !== "off") state.table = initTableState();
        break;
      case "table_close":
        if (state.table) {
          if (state.tableMode === "bullets") renderTableAsBullets(state);
          else if (state.tableMode === "code") renderTableAsCode(state);
        }
        state.table = null;
        break;
      case "thead_open": if (state.table) state.table.inHeader = true; break;
      case "thead_close": if (state.table) state.table.inHeader = false; break;
      case "tbody_open":
      case "tbody_close": break;
      case "tr_open": if (state.table) state.table.currentRow = []; break;
      case "tr_close":
        if (state.table) {
          if (state.table.inHeader) state.table.headers = state.table.currentRow;
          else state.table.rows.push(state.table.currentRow);
          state.table.currentRow = [];
        }
        break;
      case "th_open":
      case "td_open":
        if (state.table) state.table.currentCell = initRenderTarget();
        break;
      case "th_close":
      case "td_close":
        if (state.table?.currentCell) {
          state.table.currentRow.push(finishTableCell(state.table.currentCell));
          state.table.currentCell = null;
        }
        break;
      case "hr": state.text += "\n"; break;
      default:
        if (token.children) renderTokens(token.children, state);
        break;
    }
  }
}

// ─── IR construction ────────────────────────────────────────

function mergeStyleSpans(spans: MarkdownStyleSpan[]): MarkdownStyleSpan[] {
  const sorted = [...spans].sort((a, b) =>
    a.start !== b.start ? a.start - b.start : a.end !== b.end ? a.end - b.end : a.style.localeCompare(b.style),
  );
  const merged: MarkdownStyleSpan[] = [];
  for (const span of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.style === span.style && span.start <= prev.end) {
      prev.end = Math.max(prev.end, span.end);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

function clampStyles(spans: MarkdownStyleSpan[], max: number): MarkdownStyleSpan[] {
  const out: MarkdownStyleSpan[] = [];
  for (const s of spans) {
    const a = Math.max(0, Math.min(s.start, max));
    const b = Math.max(a, Math.min(s.end, max));
    if (b > a) out.push({ start: a, end: b, style: s.style });
  }
  return out;
}

function clampLinks(spans: MarkdownLinkSpan[], max: number): MarkdownLinkSpan[] {
  const out: MarkdownLinkSpan[] = [];
  for (const s of spans) {
    const a = Math.max(0, Math.min(s.start, max));
    const b = Math.max(a, Math.min(s.end, max));
    if (b > a) out.push({ start: a, end: b, href: s.href });
  }
  return out;
}

export function markdownToIR(markdown: string, options: MarkdownParseOptions = {}): MarkdownIR {
  const env: RenderEnv = { listStack: [] };
  const md = createMd(options);
  const tokens = md.parse(markdown ?? "", env as unknown as object);
  const tableMode = options.tableMode ?? "off";

  const state: RenderState = {
    text: "",
    styles: [],
    openStyles: [],
    links: [],
    linkStack: [],
    env,
    headingStyle: options.headingStyle ?? "none",
    blockquotePrefix: options.blockquotePrefix ?? "",
    tableMode,
    table: null,
  };

  renderTokens(tokens as MarkdownToken[], state);
  closeRemainingStyles(state);

  const trimmedText = state.text.trimEnd();
  const trimmedLength = trimmedText.length;
  let codeBlockEnd = 0;
  for (const s of state.styles) {
    if (s.style === "code_block" && s.end > codeBlockEnd) codeBlockEnd = s.end;
  }
  const finalLength = Math.max(trimmedLength, codeBlockEnd);
  const finalText = finalLength === state.text.length ? state.text : state.text.slice(0, finalLength);

  return {
    text: finalText,
    styles: mergeStyleSpans(clampStyles(state.styles, finalLength)),
    links: clampLinks(state.links, finalLength),
  };
}

// ─── IR → Lark Post ─────────────────────────────────────────

function buildStyleRanges(styles: MarkdownStyleSpan[], textLength: number): StyleState[] {
  const ranges: StyleState[] = Array(textLength)
    .fill(null)
    .map(() => ({ bold: false, italic: false, strikethrough: false, code: false }));

  for (const span of styles) {
    for (let i = span.start; i < span.end && i < textLength; i++) {
      switch (span.style) {
        case "bold": ranges[i].bold = true; break;
        case "italic": ranges[i].italic = true; break;
        case "strikethrough": ranges[i].strikethrough = true; break;
        case "code":
        case "code_block": ranges[i].code = true; break;
      }
    }
  }
  return ranges;
}

function buildLinkMap(links: MarkdownLinkSpan[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const link of links) {
    for (let i = link.start; i < link.end; i++) map.set(i, link.href);
  }
  return map;
}

function getStylesAt(ranges: StyleState[], pos: number): StyleState {
  return ranges[pos] ?? { bold: false, italic: false, strikethrough: false, code: false };
}

function stylesEqual(a: StyleState, b: StyleState): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strikethrough === b.strikethrough && a.code === b.code;
}

function createPostElement(text: string, styles: StyleState, link?: string): LarkPostElement {
  const styleArray: string[] = [];
  if (styles.bold) styleArray.push("bold");
  if (styles.italic) styleArray.push("italic");
  if (styles.strikethrough) styleArray.push("lineThrough");
  if (styles.code) styleArray.push("code");

  if (link) {
    return { tag: "a", text, href: link, ...(styleArray.length > 0 ? { style: styleArray } : {}) };
  }
  return { tag: "text", text, ...(styleArray.length > 0 ? { style: styleArray } : {}) };
}

function renderLarkPost(ir: MarkdownIR): LarkPostContent {
  const lines: LarkPostLine[] = [];
  const text = ir.text;
  if (!text) return { zh_cn: { content: [[{ tag: "text", text: "" }]] } };

  const styleRanges = buildStyleRanges(ir.styles, text.length);
  const linkMap = buildLinkMap(ir.links);

  const textLines = text.split("\n");
  let charIndex = 0;

  for (const line of textLines) {
    const elems: LarkPostElement[] = [];

    if (line.length === 0) {
      elems.push({ tag: "text", text: "" });
    } else {
      let segStart = charIndex;
      let curStyles = getStylesAt(styleRanges, segStart);
      let curLink = linkMap.get(segStart);

      for (let i = 0; i < line.length; i++) {
        const pos = charIndex + i;
        const newStyles = getStylesAt(styleRanges, pos);
        const newLink = linkMap.get(pos);

        if (!stylesEqual(curStyles, newStyles) || curLink !== newLink) {
          const segText = text.slice(segStart, pos);
          if (segText) elems.push(createPostElement(segText, curStyles, curLink));
          segStart = pos;
          curStyles = newStyles;
          curLink = newLink;
        }
      }

      const finalSeg = text.slice(segStart, charIndex + line.length);
      if (finalSeg) elems.push(createPostElement(finalSeg, curStyles, curLink));
    }

    lines.push(elems.length > 0 ? elems : [{ tag: "text", text: "" }]);
    charIndex += line.length + 1;
  }

  return { zh_cn: { content: lines } };
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Check if text contains Markdown formatting
 */
export function containsMarkdown(text: string): boolean {
  if (!text) return false;
  return [
    /\*\*[^*]+\*\*/,
    /\*[^*]+\*/,
    /~~[^~]+~~/,
    /`[^`]+`/,
    /```[\s\S]*?```/,
    /\[.+?\]\(.+?\)/,
    /^#{1,6}\s/m,
    /^[-*]\s/m,
    /^\d+\.\s/m,
  ].some((p) => p.test(text));
}

/**
 * Convert Markdown to Lark Post format JSON string
 */
export function markdownToLarkPost(
  text: string,
  options?: { tableMode?: MarkdownTableMode },
): string {
  const ir = markdownToIR(text, {
    linkify: true,
    headingStyle: "bold",
    blockquotePrefix: "｜ ",
    tableMode: options?.tableMode ?? "bullets",
  });
  const post = renderLarkPost(ir);
  return JSON.stringify(post);
}
