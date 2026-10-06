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

function run(name, args = [], config, model = "draft", prepare) {
  const cwd = join(scratch, name);
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
  if (config) {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi/jp-gate.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  prepare?.(cwd, agentDir);
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

  const flexibleConfig = { gate: { model: "jp-gate-fixture/changed-split-editor" }, validationMode: "json" };
  const flexibleExpected = "変更された文章。\n\n" + originalParagraphs.split("\n\n")[1];
  const flexible = run("json-split", [], flexibleConfig, "paragraph-draft");
  assert.equal(flexible.assistant.stopReason, "stop");
  assert.deepEqual(flexible.assistant.content, [{ type: "text", text: flexibleExpected }]);
  assert.ok(!flexible.stdout.includes("こんばんは。"));
  assert.ok(!flexible.history.includes("こんばんは。"));
  const flexibleSaved = flexible.history.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(flexibleSaved.findLast((entry) => entry.message?.role === "assistant").message.content[0].text, flexibleExpected);
  assert.equal(flexibleSaved.filter((entry) => entry.customType === "jp-gate-usage").length, 1);

  const flexibleFlag = run("json-split-flag", ["--jp-gate-validation", "json", "--jp-gate-model", "jp-gate-fixture/changed-split-editor"], undefined, "paragraph-draft");
  assert.deepEqual(flexibleFlag.assistant.content, flexible.assistant.content);
  const strictOverride = run("strict-overrides-json", ["--jp-gate-validation", "strict"], flexibleConfig, "paragraph-draft");
  assert.equal(strictOverride.assistant.stopReason, "error");
  assert.deepEqual(strictOverride.assistant.content, []);
  assert.ok(!strictOverride.history.includes("こんばんは。"));

  const jsonInvalid = run("json-invalid", ["--jp-gate-validation", "json", "--jp-gate-model", "jp-gate-fixture/bad-editor"]);
  assert.equal(jsonInvalid.assistant.stopReason, "error");
  assert.deepEqual(jsonInvalid.assistant.content, []);
  assert.ok(jsonInvalid.assistant.errorMessage.includes("有効な JSON"));
  assert.ok(!jsonInvalid.stdout.includes("Setup is"));
  assert.ok(!jsonInvalid.history.includes("Setup is"));

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

  const promptEditor = ["--jp-gate-model", "jp-gate-fixture/prompt-editor"];
  const created = run("prompt-created", ["--jp-gate-model", "jp-gate-fixture/editor"]);
  assert.equal(created.assistant.content[0].text, expected);
  const globalPrompt = join(scratch, "prompt-created", "agent", "jp-gate-prompt.md");
  assert.ok(readFileSync(globalPrompt, "utf8").includes("日本語"));
  writeFileSync(globalPrompt, "# 保持するカスタム指示\nJSON で回答。");
  const preserved = run("prompt-created", promptEditor);
  assert.equal(preserved.assistant.content[0].text, "# 保持するカスタム指示 `npm run dev`");
  assert.equal(readFileSync(globalPrompt, "utf8"), "# 保持するカスタム指示\nJSON で回答。");

  const projectPrompt = run("prompt-project", promptEditor, undefined, "draft", (cwd, agentDir) => {
    writeFileSync(join(agentDir, "jp-gate-prompt.md"), "# 全体の指示");
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "jp-gate-prompt.md"), "# プロジェクトの指示");
  });
  assert.equal(projectPrompt.assistant.content[0].text, "# プロジェクトの指示 `npm run dev`");

  const explicitPrompt = run("prompt-cli", [...promptEditor, "--jp-gate-prompt", "custom.md"], { gate: { promptFile: "config.md" } }, "draft", (cwd, agentDir) => {
    writeFileSync(join(agentDir, "jp-gate-prompt.md"), "# 全体の指示");
    writeFileSync(join(cwd, ".pi", "jp-gate-prompt.md"), "# プロジェクトの指示");
    writeFileSync(join(cwd, "config.md"), "# 設定で指定した指示");
    writeFileSync(join(cwd, "custom.md"), "# CLI で指定した指示");
  });
  assert.equal(explicitPrompt.assistant.content[0].text, "# CLI で指定した指示 `npm run dev`");

  const configPrompt = run("prompt-config", promptEditor, { gate: { promptFile: "custom.md" } }, "draft", (cwd) => {
    writeFileSync(join(cwd, "custom.md"), "# 設定で指定した指示");
  });
  assert.equal(configPrompt.assistant.content[0].text, "# 設定で指定した指示 `npm run dev`");

  const missingPrompt = run("prompt-missing", [...promptEditor, "--jp-gate-prompt", "missing.md"]);
  assert.equal(missingPrompt.assistant.stopReason, "error");
  assert.deepEqual(missingPrompt.assistant.content, []);
  assert.ok(missingPrompt.stderr.includes("プロンプトを読み込めません"));
  assert.ok(!missingPrompt.stdout.includes("Setup is"));
  assert.ok(!missingPrompt.history.includes("Setup is"));

  const emptyPrompt = run("prompt-empty", promptEditor, undefined, "draft", (_cwd, agentDir) => {
    writeFileSync(join(agentDir, "jp-gate-prompt.md"), " \n");
  });
  assert.equal(emptyPrompt.assistant.stopReason, "error");
  assert.deepEqual(emptyPrompt.assistant.content, []);
  assert.ok(emptyPrompt.stderr.includes("プロンプトが空"));
  assert.equal(readFileSync(join(scratch, "prompt-empty", "agent", "jp-gate-prompt.md"), "utf8"), " \n");

  const promptOff = run("prompt-missing-off", ["--jp-gate", "off", "--jp-gate-prompt", "missing.md"]);
  assert.ok(promptOff.assistant.content[0].text.includes("Setup is"));

  console.log(`Pi CLI integration: ${count} cases passed (offline, no API calls).`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
