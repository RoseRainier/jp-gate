import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Deterministic stand-in for an LLM API. No credentials or outbound requests.
export default function fixture(pi: ExtensionAPI): void {
  pi.registerProvider("jp-gate-fixture", {
    api: "jp-gate-fixture-api",
    apiKey: "fixture-key",
    baseUrl: "http://unused.invalid",
    models: ["draft", "editor", "prompt-editor", "bad-editor", "paragraph-draft", "identity-editor", "paragraph-editor"].map((id) => ({
      id, name: id, reasoning: false, input: ["text"],
      contextWindow: 32768, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple: (model, context, options) => {
      if (options?.apiKey !== "fixture-key") throw new Error("fixture authentication lost");
      let text = "Setup is 完了。请确认 설정。 `npm run dev`";
      if (model.id === "paragraph-draft") {
        text = "こんばんは。私はいつも通り元気よ。\n\nあなたこそ、今日どれくらい寝てないのかしら。数字で答えてもらえると助かるわ。";
      }
      if (model.id === "editor") {
        const last = context.messages.at(-1);
        if (!last || last.role !== "user" || typeof last.content !== "string") throw new Error("missing gate input");
        if (last.content !== "Setup is 完了。请确认 설정。 `npm run dev`") throw new Error("gate input changed");
        text = "セットアップは完了したわ。設定を確認してね。 `npm run dev`";
      } else if (model.id === "identity-editor" || model.id === "paragraph-editor") {
        const last = context.messages.at(-1);
        if (!last || last.role !== "user" || typeof last.content !== "string") throw new Error("missing gate input");
        text = model.id === "identity-editor" ? last.content : last.content.replace("元気よ。", "元気だわ。");
      } else if (model.id === "prompt-editor") {
        const system = context.messages.find((part) => part.role === "system");
        const prompt = system && typeof system.content === "string" ? system.content : "";
        text = `${prompt.split("\n")[0]} ` + "`npm run dev`";
      } else if (model.id === "bad-editor") text = "";
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
