import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Deterministic stand-in for an LLM API. No credentials or outbound requests.
export default function fixture(pi: ExtensionAPI): void {
  pi.registerProvider("jp-gate-fixture", {
    api: "jp-gate-fixture-api",
    apiKey: "fixture-key",
    baseUrl: "http://unused.invalid",
    models: ["draft", "editor", "bad-editor"].map((id) => ({
      id, name: id, reasoning: false, input: ["text"],
      contextWindow: 32768, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple: (model, context, options) => {
      if (options?.apiKey !== "fixture-key") throw new Error("fixture authentication lost");
      let text = "Setup is 完了。请确认 설정。 `npm run dev`";
      if (model.id === "editor") {
        const last = context.messages.at(-1);
        if (!last || last.role !== "user" || typeof last.content !== "string") throw new Error("missing gate input");
        const input = JSON.parse(last.content) as { texts: string[] };
        const markers = input.texts[0].match(/⟦JP_GATE_[^⟧]+⟧/g) ?? [];
        text = JSON.stringify({ texts: [`セットアップは完了しました。設定を確認してください。 ${markers.join(" ")}`] });
      } else if (model.id === "bad-editor") text = "invalid JSON";
      const result = response(model, text);
      const stream = createAssistantMessageEventStream();
      const partial = { ...result, stopReason: "pending" as const };
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
      stream.push({ type: "done", reason: "stop", message: result });
      stream.end();
      return stream;
    },
  });
}

function response(model: Model<string>, text: string): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
