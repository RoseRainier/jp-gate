import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage, Context, Model, ModelsSimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { GateConfig } from "./config.ts";
import { splitModel } from "./config.ts";
import { GATE_PROMPT } from "./gate-prompt.ts";
import { protectText, restoreText, restoreTexts } from "./protected-text.ts";

export { GATE_PROMPT } from "./gate-prompt.ts";

// Async-local bypass survives provider authentication/lazy streaming, including a same-provider gate.
export const gateBypass = new AsyncLocalStorage<boolean>();

export interface GateClient {
  find(provider: string, id: string): Model<string> | undefined;
  streamSimple(model: Model<string>, context: Context, options?: ModelsSimpleStreamOptions): { result(): Promise<AssistantMessage> };
}

export interface GateUsage {
  model: string;
  timestamp: number;
  usage: Usage;
  stopReason: AssistantMessage["stopReason"];
}

/** Accept split entries only if they reproduce every source exactly, apart from line-break separators. */
function isUnchangedSplit(output: string[], source: string[]): boolean {
  let index = 0;
  for (const original of source) {
    let offset = 0;
    for (;;) {
      const part = output[index++];
      if (part === undefined || (!part && original) || !original.startsWith(part, offset)) return false;
      offset += part.length;
      if (offset === original.length) break;
      const next = output[index];
      if (!next) return false;
      const nextOffset = original.indexOf(next, offset);
      if (nextOffset < 0 || !/^[ \t]*(?:\r?\n[ \t]*)+$/.test(original.slice(offset, nextOffset))) return false;
      offset = nextOffset;
    }
  }
  return index === output.length;
}

function parseReply(text: string, source: string[], mode: GateConfig["validationMode"]): { texts: string[]; rawJson?: boolean } {
  let value = text.trim();
  // Some providers still wrap a JSON answer; accept only one complete JSON fence.
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(value);
  if (fence) value = fence[1];
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error("Gate モデルの応答が有効な JSON ではありません。"); }
  if (mode === "json") {
    if (typeof parsed === "string") return { texts: [parsed] };
    const texts: unknown = Array.isArray(parsed) ? parsed :
      typeof parsed === "object" && parsed !== null ? (parsed as { texts?: unknown }).texts : undefined;
    if (typeof texts === "string") return { texts: [texts] };
    if (Array.isArray(texts) && texts.every((part) => typeof part === "string")) {
      if (texts.length > source.length && isUnchangedSplit(texts, source)) return { texts: source };
      return { texts };
    }
    // An unfamiliar JSON shape remains JSON; do not guess which fields contain prose.
    return { texts: [JSON.stringify(parsed)], rawJson: true };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Gate モデルの応答形式が不正です。");
  }
  const texts = (parsed as { texts?: unknown }).texts;
  if (!Array.isArray(texts) || !texts.every((part) => typeof part === "string")) {
    throw new Error("Gate モデルが文章の数・形式を変更しました。");
  }
  if (texts.length !== source.length) {
    // Never guess separators for translated/changed fragments or fall through to an unreviewed draft.
    if (texts.length > source.length && isUnchangedSplit(texts, source)) return { texts: source };
    throw new Error(`Gate モデルが文章の数を変更しました（入力: ${source.length}、出力: ${texts.length}）。`);
  }
  return { texts: texts as string[] };
}

/** Bound waiting even when a custom provider ignores AbortSignal. */
async function withDeadline<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("中断されました。"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([operation(), aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export async function correctMessage(
  message: AssistantMessage,
  config: GateConfig,
  client: GateClient,
  signal?: AbortSignal,
  onUsage?: (usage: GateUsage) => void,
): Promise<AssistantMessage> {
  signal?.throwIfAborted();
  const texts = message.content.filter((part) => part.type === "text");
  if (texts.length === 0) return message;
  const protectedTexts = texts.map((part) => protectText(part.text));
  if (!protectedTexts.some((part) => part.hasProse)) return message;
  if (!config.gate.model) throw new Error("Gate モデルが未設定です。--jp-gate-model provider/model-id または gate.model を指定してください。");
  const spec = splitModel(config.gate.model);
  const model = client.find(spec.provider, spec.id);
  if (!model) throw new Error(`Gate モデル '${config.gate.model}' が Pi に登録されていません。`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Gate モデルが ${config.gate.timeoutMs}ms 以内に応答しませんでした。`)), config.gate.timeoutMs);
  const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let reply: AssistantMessage;
  try {
    reply = await withDeadline(operationSignal, () => gateBypass.run(true, () => client.streamSimple(model, {
      systemPrompt: GATE_PROMPT,
      messages: [{ role: "user", content: JSON.stringify({ texts: protectedTexts.map((part) => part.masked) }), timestamp: Date.now() }],
    }, {
      signal: operationSignal,
      temperature: config.gate.temperature,
      maxTokens: model.maxTokens > 0 ? Math.min(config.gate.maxTokens, model.maxTokens) : config.gate.maxTokens,
      reasoning: undefined,
    }).result()));
  } finally { clearTimeout(timer); }
  onUsage?.({ model: config.gate.model, timestamp: Date.now(), usage: reply.usage, stopReason: reply.stopReason });
  operationSignal.throwIfAborted();
  if (reply.stopReason !== "stop" || reply.content.some((part) => part.type === "toolCall")) {
    // Do not expose provider payload/error strings (they can contain draft text or secrets).
    throw new Error(`Gate モデルが正常に校正を完了しませんでした (${reply.stopReason})。`);
  }
  const parsed = parseReply(reply.content.filter((part) => part.type === "text").map((part) => part.text).join(""), protectedTexts.map((part) => part.masked), config.validationMode);
  const output = parsed.texts;
  let restored: string[];
  if (config.validationMode === "json") {
    if (!output.some((text) => text.trim())) throw new Error("Gate モデルが空の文章を返しました。");
    // When retaining a JSON object, restored literals must stay escaped inside its strings.
    const sources = parsed.rawJson ? protectedTexts.map((source) => ({
      ...source, parts: source.parts.map((part) => ({ ...part, original: JSON.stringify(part.original).slice(1, -1) })),
    })) : protectedTexts;
    restored = restoreTexts(output, sources);
    if (restored.length !== texts.length) restored = [restored.join("\n\n")];
  } else restored = output.map((text, i) => {
    if (texts[i].text.trim() && !text.trim()) throw new Error("Gate モデルが空の文章を返しました。");
    return restoreText(text, protectedTexts[i]);
  });
  let index = 0;
  return {
    ...message,
    content: message.content.flatMap<AssistantMessage["content"][number]>((part) => {
      if (part.type !== "text") return [part];
      // A changed block count is emitted at the first text slot; keep every thinking/tool block.
      if (restored.length !== texts.length && index > 0) return [];
      const text = restored[index++];
      if (text === part.text) return [part];
      // A provider signature represents the original text; never attach it to rewritten text.
      const { textSignature: _signature, ...rest } = part;
      return [{ ...rest, text }];
    }),
  };
}
