import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import type { GateConfig } from "./config.ts";

export function emptyMessage(model: Model<string>): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], timestamp: Date.now(), stopReason: "pending",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

/** Generate a normal Pi stream from the corrected message, never from raw partial snapshots. */
export function emitMessage(stream: AssistantMessageEventStream, message: AssistantMessage): void {
  const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
  stream.push({ type: "start", partial });
  for (const [contentIndex, part] of message.content.entries()) {
    if (part.type === "text") {
      const text = { ...part, text: "" };
      partial.content.push(text);
      stream.push({ type: "text_start", contentIndex, partial });
      text.text = part.text;
      stream.push({ type: "text_delta", contentIndex, delta: part.text, partial });
      stream.push({ type: "text_end", contentIndex, content: part.text, partial });
    } else if (part.type === "thinking") {
      const thinking = { ...part, thinking: "" };
      partial.content.push(thinking);
      stream.push({ type: "thinking_start", contentIndex, partial });
      thinking.thinking = part.thinking;
      stream.push({ type: "thinking_delta", contentIndex, delta: part.thinking, partial });
      stream.push({ type: "thinking_end", contentIndex, content: part.thinking, partial });
    } else {
      partial.content.push(part);
      stream.push({ type: "toolcall_start", contentIndex, partial });
      stream.push({ type: "toolcall_end", contentIndex, toolCall: part, partial });
    }
  }
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else if (message.stopReason === "pending") {
    throw new Error("モデルのストリームが完了しませんでした。");
  } else {
    stream.push({ type: "done", reason: message.stopReason, message });
  }
  stream.end();
}

export function gatedStream(options: {
  model: Model<string>;
  source: () => AssistantMessageEventStream;
  correct: (message: AssistantMessage) => Promise<AssistantMessage>;
  config: GateConfig;
  signal?: AbortSignal;
  onFailure?: (message: string) => void;
}): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    let draft = emptyMessage(options.model);
    try {
      options.signal?.throwIfAborted();
      const source = options.source();
      // Consume/discard deltas so provider queues do not retain a second copy of the response.
      let terminal = false;
      for await (const event of source) {
        if (event.type === "done") { draft = event.message; terminal = true; }
        else if (event.type === "error") { draft = event.error; terminal = true; }
      }
      if (!terminal) throw new Error("メインモデルのストリームに終了イベントがありません。");
      options.signal?.throwIfAborted();
      if (draft.stopReason === "error" || draft.stopReason === "aborted") {
        // A failed provider can include uncorrected partial content: discard it too.
        emitMessage(output, { ...draft, content: [] });
        return;
      }
      let corrected: AssistantMessage;
      try {
        corrected = await options.correct(draft);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        options.onFailure?.(reason);
        if (options.config.failureMode !== "passthrough") throw error;
        corrected = draft;
      }
      options.signal?.throwIfAborted();
      emitMessage(output, corrected);
    } catch (error) {
      const aborted = options.signal?.aborted;
      const failed: AssistantMessage = {
        ...draft, content: [], stopReason: aborted ? "aborted" : "error",
        errorMessage: aborted ? "日本語補正を中断しました。" : `日本語 Gate: ${error instanceof Error ? error.message : String(error)}`,
      };
      emitMessage(output, failed);
    }
  })();
  return output;
}
