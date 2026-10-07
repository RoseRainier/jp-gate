import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import { correctMessage, gateBypass, type GateClient } from "../src/gate.ts";
import { message, streamOf, testModel } from "./helpers.ts";

const config = mergeConfig(DEFAULT_CONFIG, { gate: { model: "fixture/editor", timeoutMs: 500 } });

test("the gate receives only plain prose and retains tools, reasoning, and main usage", async () => {
  const source = "Setup is 完了。请确认 설정。 `echo 你好`";
  const expected = "セットアップは完了したわ。設定を確認してね。 `echo 你好`";
  const tool = { type: "toolCall" as const, id: "call-1", name: "bash", arguments: { command: "echo 你好" } };
  const thinking = { type: "thinking" as const, thinking: "private thought", thinkingSignature: "signed" };
  const draft = message("", { stopReason: "toolUse", content: [thinking, { type: "text", text: source, textSignature: "original" }, tool] });
  let calls = 0;
  const client: GateClient = {
    find: () => testModel,
    streamSimple: (_model, context, options) => {
      calls++;
      assert.equal(gateBypass.getStore(), true);
      assert.equal(context.messages.length, 1);
      assert.equal(context.messages[0].content, source);
      assert.equal(context.tools, undefined);
      assert.ok(context.systemPrompt?.includes("English, Chinese and Korean"));
      assert.ok(context.systemPrompt?.includes("Keep meaning"));
      assert.ok(context.systemPrompt?.includes("Haruka"));
      assert.ok(!context.systemPrompt?.includes("JSON"));
      assert.equal(options?.temperature, 0);
      assert.equal(options?.reasoning, "low");
      return streamOf(message(expected));
    },
  };
  let usageCount = 0;
  const corrected = await correctMessage(draft, config, client, undefined, () => usageCount++);
  assert.equal(calls, 1);
  assert.equal(usageCount, 1);
  assert.deepEqual(corrected.content, [thinking, { type: "text", text: expected }, tool]);
  assert.equal(corrected.content[0], thinking);
  assert.equal(corrected.content[2], tool);
  assert.equal(corrected.stopReason, "toolUse");
  assert.equal(corrected.usage, draft.usage);
});

test("unchanged prose retains newlines and its provider signature", async () => {
  const source = "こんばんは。私はいつも通り元気よ。\r\n \t\r\nあなたこそ、今日どれくらい寝てないのかしら。\n";
  const draft = message("", { content: [{ type: "text", text: source, textSignature: "signed" }] });
  const client: GateClient = {
    find: () => testModel,
    streamSimple: (_model, context) => {
      assert.equal(context.messages[0].content, source);
      return streamOf(message(source));
    },
  };
  const corrected = await correctMessage(draft, config, client);
  assert.deepEqual(corrected, draft);
  assert.equal(corrected.content[0], draft.content[0]);
});

test("text slots are corrected individually while empty slots and intervening blocks stay in place", async () => {
  const thinking = { type: "thinking" as const, thinking: "private" };
  const tool = { type: "toolCall" as const, id: "call", name: "bash", arguments: { command: "echo hello" } };
  const draft = message("", { content: [
    { type: "text", text: "hello", textSignature: "old-1" }, thinking,
    { type: "text", text: " \n", textSignature: "blank" }, tool,
    { type: "text", text: "world", textSignature: "old-2" },
  ] });
  const inputs: string[] = [];
  const client: GateClient = {
    find: () => testModel,
    streamSimple: (_model, context) => {
      const input = context.messages[0].content as string;
      inputs.push(input);
      return streamOf(message(input === "hello" ? "こんにちは" : "世界"));
    },
  };
  let usages = 0;
  const corrected = await correctMessage(draft, config, client, undefined, () => usages++);
  assert.deepEqual(inputs, ["hello", "world"]);
  assert.equal(usages, 2);
  assert.deepEqual(corrected.content, [
    { type: "text", text: "こんにちは" }, thinking, draft.content[2], tool, { type: "text", text: "世界" },
  ]);
});

test("multiline code and quotes pass through without JSON serialization or escaping", async () => {
  const source = 'このexampleよ。\n```js\nconsole.log("hello\\nworld");\n```\n「Hello, 안녕」\n';
  const expected = source.replace("example", "例");
  const client: GateClient = {
    find: () => testModel,
    streamSimple: (_model, context) => {
      assert.equal(context.messages[0].content, source);
      return streamOf(message(expected));
    },
  };
  assert.deepEqual((await correctMessage(message(source), config, client)).content, [{ type: "text", text: expected }]);
});

test("a gate reply containing multiple text parts is consumed as plain text", async () => {
  const client: GateClient = {
    find: () => testModel,
    streamSimple: () => streamOf(message("", { content: [{ type: "text", text: "こんにちは。\n" }, { type: "text", text: "元気よ。" }] })),
  };
  assert.deepEqual((await correctMessage(message("Hello."), config, client)).content, [{ type: "text", text: "こんにちは。\n元気よ。" }]);
});

test("empty and tool-only messages do not call the LLM", async () => {
  const client: GateClient = { find: () => { throw new Error("not called"); }, streamSimple: () => { throw new Error("not called"); } };
  for (const draft of [message(" \n"), message("", { content: [{ type: "toolCall", id: "1", name: "test", arguments: {} }] })]) {
    assert.equal(await correctMessage(draft, config, client), draft);
  }
});

test("empty, truncated, errored, and tool-using gate replies are rejected", async () => {
  for (const reply of [
    message(""), message(" \n"), message("OK", { stopReason: "length" }),
    message("OK", { stopReason: "error", errorMessage: "secret" }),
    message("", { stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "test", arguments: {} }] }),
    message("OK", { content: [{ type: "text", text: "OK" }, { type: "toolCall", id: "1", name: "test", arguments: {} }] }),
  ]) {
    const client: GateClient = { find: () => testModel, streamSimple: () => streamOf(reply) };
    await assert.rejects(correctMessage(message("hello"), config, client));
  }
});

test("a later text failure does not mutate or partially return the draft", async () => {
  const draft = message("", { content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }] });
  let calls = 0;
  const client: GateClient = {
    find: () => testModel,
    streamSimple: () => streamOf(message(++calls === 1 ? "こんにちは" : "")),
  };
  await assert.rejects(correctMessage(draft, config, client), /空の文章/);
  assert.deepEqual(draft.content, [{ type: "text", text: "hello" }, { type: "text", text: "world" }]);
});

test("timeouts and cancellation terminate waiting even if a provider ignores AbortSignal", async () => {
  const client: GateClient = { find: () => testModel, streamSimple: () => ({ result: () => new Promise(() => {}) }) };
  await assert.rejects(correctMessage(message("hello"), mergeConfig(config, { gate: { timeoutMs: 15 } }), client), /以内に応答/);
  const controller = new AbortController();
  const promise = correctMessage(message("hello"), config, client, controller.signal);
  controller.abort(new Error("user cancelled"));
  await assert.rejects(promise, /user cancelled/);
});

test("an unregistered or missing gate model fails explicitly", async () => {
  const client: GateClient = { find: () => undefined, streamSimple: () => { throw new Error("not called"); } };
  await assert.rejects(correctMessage(message("hello"), config, client), /登録されていません/);
  await assert.rejects(correctMessage(message("hello"), DEFAULT_CONFIG, client), /未設定/);
});
