import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { emptyMessage, emitMessage } from "../src/stream.ts";

export const testModel: Model<string> = {
  id: "draft", name: "Draft", provider: "fixture", api: "fixture-api", baseUrl: "http://localhost",
  reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function message(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return { ...emptyMessage(testModel), stopReason: "stop", content: [{ type: "text", text }], ...overrides };
}

export function streamOf(result: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  emitMessage(stream, result);
  return stream;
}
