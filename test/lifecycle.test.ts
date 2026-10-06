import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import japaneseGate from "../src/index.ts";
import fixture from "./fixtures/provider.ts";
import { testModel } from "./helpers.ts";

test("slash commands, settings reload, provider restoration, and extension reload work in a real Pi session", async () => {
  const root = await mkdtemp(join(tmpdir(), "jp-gate-lifecycle-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await mkdir(join(root, ".pi"));
  const configPath = join(root, ".pi/jp-gate.json");
  await writeFile(configPath, JSON.stringify({ gate: { model: "jp-gate-fixture/editor" } }));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json") });
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, extensionFactories: [fixture, japaneseGate], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    session = (await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(root), model: { ...testModel, provider: "jp-gate-fixture", api: "jp-gate-fixture-api" }, thinkingLevel: "off", noTools: "all" })).session;
    const errors: string[] = [];
    await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error.error) });
    assert.deepEqual(errors, []);
    const expected = "セットアップは完了しました。設定を確認してください。 `npm run dev`";
    await session.prompt("テスト");
    assert.equal(session.getLastAssistantText(), expected);
    const usageBefore = session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "jp-gate-usage").length;
    assert.equal(usageBefore, 1);

    await session.prompt("/jp-gate off");
    await session.prompt("テスト");
    assert.ok(session.getLastAssistantText()?.includes("Setup is"));
    const usageOff = session.sessionManager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "jp-gate-usage").length;
    assert.equal(usageOff, usageBefore);

    await session.prompt("/jp-gate on");
    await session.prompt("/jp-gate model jp-gate-fixture/editor");
    await session.prompt("テスト");
    assert.equal(session.getLastAssistantText(), expected);

    const promptPath = join(agentDir, "jp-gate-prompt.md");
    await writeFile(configPath, JSON.stringify({ gate: { model: "jp-gate-fixture/prompt-editor" } }));
    await writeFile(promptPath, "# 初回のカスタム指示\n本文の校正。");
    await session.prompt("/jp-gate reload");
    await session.prompt("テスト");
    assert.equal(session.getLastAssistantText(), "# 初回のカスタム指示 `npm run dev`");
    await writeFile(promptPath, "# 編集後のカスタム指示\n本文の校正。");
    await session.prompt("テスト");
    assert.equal(session.getLastAssistantText(), "# 初回のカスタム指示 `npm run dev`");
    await session.prompt("/jp-gate reload");
    await session.prompt("テスト");
    assert.equal(session.getLastAssistantText(), "# 編集後のカスタム指示 `npm run dev`");
    await session.prompt("/jp-gate off");
    await writeFile(promptPath, "# ON 後のカスタム指示\n本文の校正。");
    await session.prompt("/jp-gate on");
    await session.prompt("テスト");
    assert.equal(session.getLastAssistantText(), "# ON 後のカスタム指示 `npm run dev`");
    await session.reload();
    await session.prompt("テスト");
    assert.equal(session.getLastAssistantText(), "# ON 後のカスタム指示 `npm run dev`");
    await writeFile(configPath, JSON.stringify({ gate: { model: "jp-gate-fixture/editor" } }));
    await session.prompt("/jp-gate reload");

    await session.setModel(runtime.getModel("jp-gate-fixture", "paragraph-draft")!);
    await session.prompt("/jp-gate model jp-gate-fixture/changed-split-editor");
    await session.prompt("/jp-gate validation json");
    await session.prompt("テスト");
    assert.equal(session.getLastAssistantText(), "変更された文章。\n\nあなたこそ、今日どれくらい寝てないのかしら。数字で答えてもらえると助かるわ。");
    await session.prompt("/jp-gate validation strict");
    await session.prompt("テスト");
    assert.ok(!session.getLastAssistantText());
    await session.setModel(runtime.getModel("jp-gate-fixture", "draft")!);
    await session.prompt("/jp-gate model jp-gate-fixture/editor");

    await writeFile(configPath, JSON.stringify({ enabled: false, gate: { model: "jp-gate-fixture/editor" } }));
    await session.prompt("/jp-gate reload");
    await session.prompt("テスト");
    assert.ok(session.getLastAssistantText()?.includes("Setup is"));

    await writeFile(configPath, JSON.stringify({ enabled: true, gate: { model: "jp-gate-fixture/editor" } }));
    await session.reload();
    await session.prompt("テスト");
    assert.equal(session.getLastAssistantText(), expected);
    assert.deepEqual(errors, []);

    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(runtime.getRegisteredNativeProvider("jp-gate-fixture"), undefined);
    assert.ok(runtime.getRegisteredProviderConfig("jp-gate-fixture")?.streamSimple);
    assert.equal(runtime.getRegisteredProviderIds().length, 1);
  } finally {
    session?.dispose();
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
