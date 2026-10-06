import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const scratch = mkdtempSync(join(tmpdir(), "jp-gate-e2e-"));
const expected = "セットアップは完了しました。設定を確認してください。 `npm run dev`";
const originalParagraphs = "こんばんは。私はいつも通り元気よ。\n\nあなたこそ、今日どれくらい寝てないのかしら。数字で答えてもらえると助かるわ。";
let count = 0;

function run(name, args = [], config, model = "draft") {
  const cwd = join(scratch, name);
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  if (config) {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi/jp-gate.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  const session = join(cwd, "session.jsonl");
  const result = spawnSync(process.execPath, [cli,
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "-e", join(root, "test/fixtures/provider.ts"), "-e", join(root, "extensions/jp-correct.ts"),
    "--provider", "jp-gate-fixture", "--model", model, "--no-tools", "--thinking", "off",
    "--session", session, "--mode", "json", "-p", ...args, "テスト回答を出してください。",
  ], { cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(result.error, undefined, `${name}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  const events = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const assistant = events.findLast((event) => event.type === "message_end" && event.message.role === "assistant")?.message;
  assert.ok(assistant, `${name}: no assistant event; ${result.stderr}`);
  count++;
  return { ...result, events, assistant, history: readFileSync(session, "utf8") };
}

try {
  const on = run("on", ["--jp-gate", "on", "--jp-gate-model", "jp-gate-fixture/editor"]);
  assert.equal(on.assistant.content[0].text, expected);
  assert.ok(!on.stdout.includes("Setup is"), "raw draft leaked through a JSON partial");
  assert.ok(!on.history.includes("Setup is"), "raw draft persisted in the session");
  assert.ok(on.history.includes("jp-gate-usage"));

  const split = run("unchanged-split", ["--jp-gate-model", "jp-gate-fixture/split-editor"], undefined, "paragraph-draft");
  assert.equal(split.assistant.stopReason, "stop");
  assert.deepEqual(split.assistant.content, [{ type: "text", text: originalParagraphs }]);
  const savedMessages = split.history.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(savedMessages.findLast((entry) => entry.message?.role === "assistant").message.content[0].text, originalParagraphs);
  assert.equal(savedMessages.filter((entry) => entry.customType === "jp-gate-usage").length, 1);
  assert.ok(!split.stderr.includes("文章の数"));

  const changedSplit = run("changed-split", ["--jp-gate-model", "jp-gate-fixture/changed-split-editor"], undefined, "paragraph-draft");
  assert.equal(changedSplit.assistant.stopReason, "error");
  assert.deepEqual(changedSplit.assistant.content, []);
  assert.ok(changedSplit.assistant.errorMessage.includes("入力: 1、出力: 2"));
  assert.ok(!changedSplit.stdout.includes("こんばんは。"));
  assert.ok(!changedSplit.history.includes("こんばんは。"));

  const off = run("off", ["--jp-gate", "off"]);
  assert.ok(off.assistant.content[0].text.includes("Setup is"));
  assert.ok(!off.history.includes("jp-gate-usage"));

  const fileOn = run("file-on", [], { enabled: true, gate: { model: "jp-gate-fixture/editor" } });
  assert.equal(fileOn.assistant.content[0].text, expected);

  const override = run("cli-overrides-file", ["--jp-gate", "off"], { enabled: true, gate: { model: "jp-gate-fixture/editor" } });
  assert.ok(override.assistant.content[0].text.includes("Setup is"));

  const blocked = run("failed-gate", ["--jp-gate-model", "jp-gate-fixture/bad-editor"]);
  assert.equal(blocked.assistant.stopReason, "error");
  assert.deepEqual(blocked.assistant.content, []);
  assert.ok(!blocked.stdout.includes("Setup is"));
  assert.ok(!blocked.history.includes("Setup is"));

  const missing = run("missing-gate");
  assert.equal(missing.assistant.stopReason, "error");
  assert.ok(missing.assistant.errorMessage.includes("未設定"));
  assert.ok(!missing.stdout.includes("Setup is"));

  const malformed = run("malformed-config", [], "{bad");
  assert.equal(malformed.assistant.stopReason, "error");
  assert.ok(!malformed.stdout.includes("Setup is"));

  const malformedOff = run("malformed-config-off", ["--jp-gate", "off"], "{bad");
  assert.ok(malformedOff.assistant.content[0].text.includes("Setup is"));

  const passthrough = run("passthrough", [], { gate: { model: "jp-gate-fixture/bad-editor" }, failureMode: "passthrough" });
  assert.ok(passthrough.assistant.content[0].text.includes("Setup is"));
  assert.ok(passthrough.stderr.includes("未補正"));

  console.log(`Pi CLI integration: ${count} cases passed (offline, no API calls).`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
