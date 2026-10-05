import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import { gatedStream } from "../src/stream.ts";
import { message, streamOf, testModel } from "./helpers.ts";

test("no raw text delta or partial snapshot escapes while the gate is pending", async () => {
  const source = createAssistantMessageEventStream();
  const raw = message("RAW-MULTILINGUAL-DRAFT");
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const gated = gatedStream({ model: testModel, source: () => source, config: DEFAULT_CONFIG, correct: async () => { await wait; return message("校正済みです。"); } });
  const iterator = gated[Symbol.asyncIterator]();
  let emitted = false;
  const first = iterator.next().then((value) => { emitted = true; return value; });
  source.push({ type: "text_delta", contentIndex: 0, delta: raw.content[0].type === "text" ? raw.content[0].text : "", partial: raw });
  source.push({ type: "done", reason: "stop", message: raw });
  source.end();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(emitted, false);
  release();
  const events = [(await first).value];
  for (;;) { const next = await iterator.next(); if (next.done) break; events.push(next.value); }
  assert.ok(!JSON.stringify(events).includes("RAW-MULTILINGUAL-DRAFT"));
  assert.ok(JSON.stringify(events).includes("校正済みです。"));
  assert.equal((await gated.result()).stopReason, "stop");
});

test("fail-closed emits no draft or executable tool calls", async () => {
  const draft = message("RAW", { stopReason: "toolUse", content: [{ type: "text", text: "RAW" }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "exit 1" } }] });
  const gated = gatedStream({ model: testModel, source: () => streamOf(draft), config: DEFAULT_CONFIG, correct: async () => { throw new Error("gate failed"); } });
  const events = [];
  for await (const event of gated) events.push(event);
  assert.ok(!JSON.stringify(events).includes("RAW"));
  assert.ok(!JSON.stringify(events).includes("exit 1"));
  assert.deepEqual((await gated.result()).content, []);
  assert.equal((await gated.result()).stopReason, "error");
});

test("explicit passthrough emits the original only after a gate failure", async () => {
  let notified = false;
  const draft = message("RAW");
  const gated = gatedStream({ model: testModel, source: () => streamOf(draft), config: mergeConfig(DEFAULT_CONFIG, { failureMode: "passthrough" }), correct: async () => { throw new Error("gate failed"); }, onFailure: () => { notified = true; } });
  assert.deepEqual(await gated.result(), draft);
  assert.equal(notified, true);
});

test("cancellation never falls through even with passthrough configured", async () => {
  const controller = new AbortController();
  const gated = gatedStream({ model: testModel, source: () => streamOf(message("RAW")), signal: controller.signal, config: mergeConfig(DEFAULT_CONFIG, { failureMode: "passthrough" }), correct: async () => { controller.abort(); throw new Error("cancelled"); } });
  const result = await gated.result();
  assert.equal(result.stopReason, "aborted");
  assert.deepEqual(result.content, []);
});

test("broken provider streams terminate with an error instead of hanging", async () => {
  const source = createAssistantMessageEventStream();
  source.end();
  const gated = gatedStream({ model: testModel, source: () => source, config: DEFAULT_CONFIG, correct: async (draft) => draft });
  assert.equal((await gated.result()).stopReason, "error");
});

test("failed main model responses discard uncorrected partial content", async () => {
  const raw = message("RAW", { stopReason: "error", errorMessage: "upstream failed" });
  const gated = gatedStream({ model: testModel, source: () => streamOf(raw), config: DEFAULT_CONFIG, correct: async () => { throw new Error("must not run"); } });
  const result = await gated.result();
  assert.deepEqual(result.content, []);
  assert.equal(result.errorMessage, "upstream failed");
});
