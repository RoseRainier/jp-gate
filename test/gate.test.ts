import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import { correctMessage, gateBypass, type GateClient } from "../src/gate.ts";
import { protectText, restoreText } from "../src/protected-text.ts";
import { message, streamOf, testModel } from "./helpers.ts";

const config = mergeConfig(DEFAULT_CONFIG, { gate: { model: "fixture/editor", timeoutMs: 500 } });

test("literal Markdown, inline code, URLs, and fenced code survive the LLM unchanged", () => {
  const original = "Setup is 完了。 `npm run dev` [ガイド](./guide_(ja).md) https://example.com/docs。\n````ts\nconst x = '你好';\n```\n````\n    echo 'hello'\n";
  const protectedText = protectText(original);
  assert.equal(protectedText.hasProse, true);
  assert.ok(!protectedText.masked.includes("const x"));
  assert.ok(!protectedText.masked.includes("npm run dev"));
  assert.ok(!protectedText.masked.includes("example.com"));
  assert.equal(restoreText(protectedText.masked.replace("Setup is 完了", "セットアップは完了しました"), protectedText), original.replace("Setup is 完了", "セットアップは完了しました"));
  assert.equal(protectText("```py\nprint('hello')\n```").hasProse, false);
  assert.equal(protectText("~~~sh\necho unclosed").hasProse, false);
});

test("missing, duplicated, and reordered protection markers are rejected", () => {
  const source = protectText("説明 `first()` と `second()`。");
  assert.throws(() => restoreText("説明です。", source), /マーカー/);
  assert.throws(() => restoreText(source.masked + source.parts[0].token, source), /マーカー/);
  assert.throws(() => restoreText(`${source.parts[1].token} ${source.parts[0].token}`, source), /マーカー/);
});

test("the dedicated LLM receives prose and masked literals, and retains tools and reasoning", async () => {
  let calls = 0;
  const tool = { type: "toolCall" as const, id: "call-1", name: "bash", arguments: { command: "echo 你好" } };
  const thinking = { type: "thinking" as const, thinking: "private thought", thinkingSignature: "signed" };
  const draft = message("", { stopReason: "toolUse", content: [thinking, { type: "text", text: "Setup is 完了。请确认 설정。 `echo 你好`", textSignature: "original" }, tool] });
  const client: GateClient = {
    find: () => ({ ...testModel, id: "editor" }),
    streamSimple: (_model, context, options) => {
      calls++;
      assert.equal(gateBypass.getStore(), true);
      assert.equal(context.messages.length, 1);
      assert.equal(context.tools, undefined);
      assert.ok(context.systemPrompt?.includes("日本語"));
      assert.equal(options?.temperature, 0);
      const input = JSON.parse(context.messages[0].content as string) as { texts: string[] };
      assert.ok(!input.texts[0].includes("echo 你好"));
      const marker = input.texts[0].match(/⟦JP_GATE_[^⟧]+⟧/)![0];
      return streamOf(message(JSON.stringify({ texts: [`セットアップは完了しました。設定を確認してください。 ${marker}`] })));
    },
  };
  let usageCount = 0;
  const corrected = await correctMessage(draft, config, client, undefined, () => usageCount++);
  assert.equal(calls, 1);
  assert.equal(usageCount, 1);
  assert.equal(corrected.content[0], thinking);
  assert.equal(corrected.content[2], tool);
  assert.deepEqual(corrected.content[1], { type: "text", text: "セットアップは完了しました。設定を確認してください。 `echo 你好`" });
  assert.equal(corrected.stopReason, "toolUse");
  assert.deepEqual(corrected.usage, draft.usage);
});

test("valid Japanese is still reviewed by the LLM rather than language rules", async () => {
  let called = false;
  const draft = message("作業は完了しました。");
  const client: GateClient = {
    find: () => testModel,
    streamSimple: () => { called = true; return streamOf(message('{"texts":["作業は完了しました。"]}')); },
  };
  assert.deepEqual(await correctMessage(draft, config, client), draft);
  assert.equal(called, true);
});

test("unchanged Japanese paragraphs returned as separate array entries retain the original newlines and signature", async () => {
  const paragraphs = [
    "こんばんは。私はいつも通り元気よ。",
    "あなたこそ、今日どれくらい寝てないのかしら。数字で答えてもらえると助かるわ。",
  ];
  const draft = message("", { content: [{ type: "text", text: paragraphs.join("\n\n"), textSignature: "original" }] });
  let calls = 0;
  let usageCount = 0;
  const client: GateClient = {
    find: () => testModel,
    streamSimple: (_model, context) => {
      calls++;
      assert.deepEqual(JSON.parse(context.messages[0].content as string), { texts: [paragraphs.join("\n\n")] });
      return streamOf(message(JSON.stringify({ texts: paragraphs })));
    },
  };
  const corrected = await correctMessage(draft, config, client, undefined, () => usageCount++);
  assert.deepEqual(corrected, draft);
  assert.equal(corrected.content[0], draft.content[0]);
  assert.equal(calls, 1);
  assert.equal(usageCount, 1);
});

test("split recovery preserves text slots, CRLF separators, protected literals, thinking, and tools", async () => {
  const thinking = { type: "thinking" as const, thinking: "private thought" };
  const tool = { type: "toolCall" as const, id: "call-1", name: "bash", arguments: { command: "echo hello" } };
  const draft = message("", {
    stopReason: "toolUse",
    content: [
      { type: "text", text: "" },
      { type: "text", text: "先頭 `first()`。\r\n \t\r\n次の段落 `second()`。\n最後。", textSignature: "signed" },
      thinking,
      { type: "text", text: "別の本文。\n\n終わり。" },
      tool,
    ],
  });
  const client: GateClient = {
    find: () => testModel,
    streamSimple: (_model, context) => {
      const input = JSON.parse(context.messages[0].content as string) as { texts: string[] };
      return streamOf(message(JSON.stringify({ texts: input.texts.flatMap((text) => text.split(/[ \t]*\r?\n[ \t\r\n]*/)) })));
    },
  };
  const corrected = await correctMessage(draft, config, client);
  assert.deepEqual(corrected, draft);
  corrected.content.forEach((part, index) => assert.equal(part, draft.content[index]));
});

test("split replies with changed, missing, reordered, duplicated, or extra content are rejected", async () => {
  const cases = [
    { source: "先頭。\n\n末尾。", texts: ["先頭。", "変更。"] },
    { source: "先頭。\n\n中間。\n\n末尾。", texts: ["先頭。", "末尾。"] },
    { source: "先頭。\n\n末尾。", texts: ["末尾。", "先頭。"] },
    { source: "先頭。\n\n末尾。", texts: ["先頭。", "末尾。", "末尾。"] },
    { source: "先頭。\n\n末尾。", texts: ["先頭。", "追加。", "末尾。"] },
    { source: "先頭。\n\n末尾。", texts: ["先頭。", "", "末尾。"] },
    { source: "先頭。\n\n末尾。", texts: ["先頭。", "末尾。", 1] },
    { source: "先頭。\n\n末尾。", texts: ["先頭。", "末尾。", "⟦JP_GATE_fake⟧"] },
    { source: "先頭。末尾。", texts: ["先頭。", "末尾。"] },
    { source: "hello world", texts: ["hello", "world"] },
    { source: "hello\n\nworld", texts: ["こんにちは", "世界"] },
  ];
  for (const { source, texts } of cases) {
    const client: GateClient = { find: () => testModel, streamSimple: () => streamOf(message(JSON.stringify({ texts }))) };
    await assert.rejects(correctMessage(message(source), config, client), /文章の数/);
  }
});

test("split replies cannot corrupt or move protected markers", async () => {
  for (const mutation of ["missing", "duplicated", "reordered", "unknown"]) {
    const client: GateClient = {
      find: () => testModel,
      streamSimple: (_model, context) => {
        const input = JSON.parse(context.messages[0].content as string) as { texts: string[] };
        const [first, second] = input.texts[0].match(/⟦JP_GATE_[^⟧]+⟧/g)!;
        let changed = input.texts[0];
        if (mutation === "missing") changed = changed.replace(first, "");
        if (mutation === "duplicated") changed = changed.replace(first, first + first);
        if (mutation === "reordered") changed = changed.replace(first, "TEMP").replace(second, first).replace("TEMP", second);
        if (mutation === "unknown") changed = changed.replace(first, "⟦JP_GATE_fake⟧");
        return streamOf(message(JSON.stringify({ texts: changed.split("\n\n") })));
      },
    };
    await assert.rejects(correctMessage(message("先頭 `first()`。\n\n末尾 `second()`。"), config, client), /文章の数/);
  }
});

test("code-only and tool-only messages require no editing and do not call the LLM", async () => {
  const client: GateClient = { find: () => { throw new Error("not called"); }, streamSimple: () => { throw new Error("not called"); } };
  const draft = message("```sh\necho hello\n```");
  assert.equal(await correctMessage(draft, config, client), draft);
  const toolOnly = message("", { content: [{ type: "toolCall", id: "1", name: "test", arguments: {} }] });
  assert.equal(await correctMessage(toolOnly, config, client), toolOnly);
});

test("malformed, empty, truncated, and structurally changed gate replies are rejected", async () => {
  for (const reply of [message("not JSON"), message('{"texts":[]}'), message('{"texts":[""]}'), message('{"texts":["OK"]}', { stopReason: "length" }), message('{"texts":["OK"]}', { stopReason: "error", errorMessage: "secret" }), message('{"texts":["OK","extra"]}')]) {
    const client: GateClient = { find: () => testModel, streamSimple: () => streamOf(reply) };
    await assert.rejects(correctMessage(message("hello"), config, client));
  }
});

test("one complete JSON fence is accepted and text blocks stay in their original slots", async () => {
  const draft = message("", { content: [{ type: "text", text: "hello" }, { type: "thinking", thinking: "thought" }, { type: "text", text: "world" }] });
  const client: GateClient = { find: () => testModel, streamSimple: () => streamOf(message('```json\n{"texts":["こんにちは","世界"]}\n```')) };
  const result = await correctMessage(draft, config, client);
  assert.deepEqual(result.content, [{ type: "text", text: "こんにちは" }, { type: "thinking", thinking: "thought" }, { type: "text", text: "世界" }]);
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
