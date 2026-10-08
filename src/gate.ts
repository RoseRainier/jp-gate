import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage, Context, Model, ModelsSimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { GateConfig } from "./config.ts";
import { splitModel } from "./config.ts";
import { GATE_PROMPT, loadPrompt } from "./prompt.ts";

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
  if (!texts.some((part) => part.text.trim())) return message;
  if (!config.gate.model) throw new Error("Gate モデルが未設定です。--jp-gate-model provider/model-id または gate.model を指定してください。");
  const spec = splitModel(config.gate.model);
  const model = client.find(spec.provider, spec.id);
  if (!model) throw new Error(`Gate モデル '${config.gate.model}' が Pi に登録されていません。`);
  const systemPrompt = config.prompt?.text ?? (config.gate.promptFile
    ? (await loadPrompt(process.cwd(), "", config.gate.promptFile)).text : GATE_PROMPT);
  signal?.throwIfAborted();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Gate モデルが ${config.gate.timeoutMs}ms 以内に応答しませんでした。`)), config.gate.timeoutMs);
  const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const output: string[] = [];
  try {
    for (const part of texts) {
      if (!part.text.trim()) { output.push(part.text); continue; }
      const reply = await withDeadline(operationSignal, () => gateBypass.run(true, () => client.streamSimple(model, {
        systemPrompt,
        messages: [{ role: "user", content: part.text, timestamp: Date.now() }],
      }, {
        signal: operationSignal,
        ...(config.gate.temperature !== undefined ? { temperature: config.gate.temperature } : {}),
        maxTokens: model.maxTokens > 0 ? Math.min(config.gate.maxTokens, model.maxTokens) : config.gate.maxTokens,
        reasoning: "low",
      }).result()));
      onUsage?.({ model: config.gate.model, timestamp: Date.now(), usage: reply.usage, stopReason: reply.stopReason });
      operationSignal.throwIfAborted();
      if (reply.stopReason !== "stop" || reply.content.some((item) => item.type === "toolCall")) {
        // Do not expose provider payload/error strings (they can contain draft text or secrets).
        throw new Error(`Gate モデルが正常に校正を完了しませんでした (${reply.stopReason})。`);
      }
      const text = reply.content.filter((item) => item.type === "text").map((item) => item.text).join("");
      if (!text.trim()) throw new Error("Gate モデルが空の文章を返しました。");
      output.push(text);
    }
  } finally { clearTimeout(timer); }
  operationSignal.throwIfAborted();
  let index = 0;
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type !== "text") return part;
      const text = output[index++];
      if (text === part.text) return part;
      // A provider signature represents the original text; never attach it to rewritten text.
      const { textSignature: _signature, ...rest } = part;
      return { ...rest, text };
    }),
  };
}
