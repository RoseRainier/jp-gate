import { randomUUID } from "node:crypto";

interface Span { start: number; end: number }
export interface ProtectedText {
  masked: string;
  parts: Array<{ token: string; original: string }>;
  hasProse: boolean;
}

/** Protect literal syntax only; language detection and rewriting belong to the gate LLM. */
export function protectText(text: string): ProtectedText {
  const spans: Span[] = [];
  const overlaps = (start: number, end: number) => spans.some((span) => start < span.end && end > span.start);
  // Markdown fences, including longer delimiters and an unfinished final fence.
  const fences = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/gm;
  for (let match = fences.exec(text); match; match = fences.exec(text)) {
    if (overlaps(match.index, fences.lastIndex)) continue;
    const delimiter = match[1];
    const close = new RegExp(`^ {0,3}${delimiter[0]}{${delimiter.length},}[ \\t]*(?:\\r?\\n|$)`, "gm");
    close.lastIndex = fences.lastIndex;
    const end = close.exec(text);
    spans.push({ start: match.index, end: end ? close.lastIndex : text.length });
    fences.lastIndex = end ? close.lastIndex : text.length;
  }
  const patterns = [
    /(`+)[\s\S]*?\1(?!`)/g,
    /^(?:(?: {4}|\t)[^\r\n]*(?:\r?\n|$))+/gm,
    /\]\((?:[^()\r\n]|\([^()\r\n]*\))*\)/g,
    /^ {0,3}\[[^\]\r\n]+\]:[^\r\n]*/gm,
    /<(?:https?:\/\/|mailto:)[^>\r\n]+>/g,
    /https?:\/\/[^\s<>()[\]「」『』、。]+/g,
    /<\/?[A-Za-z][^>\r\n]*>/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!overlaps(start, end)) spans.push({ start, end });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const nonce = randomUUID().replaceAll("-", "");
  const parts: ProtectedText["parts"] = [];
  let offset = 0;
  let masked = "";
  let prose = "";
  for (const span of spans) {
    const before = text.slice(offset, span.start);
    masked += before;
    prose += before;
    const token = `⟦JP_GATE_${nonce}_${parts.length}⟧`;
    parts.push({ token, original: text.slice(span.start, span.end) });
    masked += token;
    offset = span.end;
  }
  masked += text.slice(offset);
  prose += text.slice(offset);
  return { masked, parts, hasProse: prose.trim().length > 0 };
}

/** Reject corrupted/missing/duplicated/reordered placeholders before emitting any draft. */
export function restoreText(output: string, source: ProtectedText): string {
  let previous = -1;
  for (const { token } of source.parts) {
    const index = output.indexOf(token);
    if (index < 0 || index <= previous || output.indexOf(token, index + token.length) >= 0) {
      throw new Error("Gate モデルがコード・URL の保護用マーカーを変更しました。");
    }
    previous = index;
  }
  let restored = output;
  for (const { token, original } of source.parts) restored = restored.replace(token, () => original);
  if (/⟦JP_GATE_[^⟧]*⟧/.test(restored) && !source.parts.some((part) => part.original.includes("⟦JP_GATE_"))) {
    throw new Error("Gate モデルが未知の保護用マーカーを生成しました。");
  }
  return restored;
}
