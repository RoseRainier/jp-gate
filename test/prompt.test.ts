import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { correctMessage, type GateClient } from "../src/gate.ts";
import { GATE_PROMPT, loadPrompt, PROMPT_FILENAME } from "../src/prompt.ts";
import { message, streamOf, testModel } from "./helpers.ts";

test("first use creates an editable Markdown prompt outside the package without overwriting edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "jp-gate-prompt-"));
  try {
    const agentDir = join(root, "agent");
    const prompt = await loadPrompt(root, agentDir);
    assert.equal(prompt.path, join(agentDir, PROMPT_FILENAME));
    assert.equal(prompt.text, GATE_PROMPT);
    const custom = "# 日本語補正\n\n`code` と \\n を含むカスタム指示。\n";
    await writeFile(prompt.path, custom);
    assert.deepEqual(await loadPrompt(root, agentDir), { path: prompt.path, text: custom });
    assert.equal(await readFile(prompt.path, "utf8"), custom);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("project and explicit Markdown prompts override the global prompt without creating or modifying it", async () => {
  const root = await mkdtemp(join(tmpdir(), "jp-gate-prompt-order-"));
  try {
    const agentDir = join(root, "agent");
    await mkdir(join(root, ".pi"));
    const project = join(root, ".pi", PROMPT_FILENAME);
    await writeFile(project, "プロジェクト用指示。");
    assert.deepEqual(await loadPrompt(root, agentDir), { path: project, text: "プロジェクト用指示。" });
    await assert.rejects(readFile(join(agentDir, PROMPT_FILENAME)), { code: "ENOENT" });
    const explicit = join(root, "custom.md");
    await writeFile(explicit, "明示した指示。");
    for (const path of ["custom.md", explicit]) {
      assert.deepEqual(await loadPrompt(root, agentDir, path), { path: explicit, text: "明示した指示。" });
    }
    await mkdir(agentDir);
    await writeFile(join(agentDir, PROMPT_FILENAME), "全体の指示。");
    assert.equal((await loadPrompt(root, agentDir)).text, "プロジェクト用指示。");
    assert.equal(await readFile(join(agentDir, PROMPT_FILENAME), "utf8"), "全体の指示。");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing explicit files, directories, and empty custom prompts fail without falling back or overwriting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "jp-gate-prompt-errors-"));
  try {
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await mkdir(join(root, ".pi"));
    await assert.rejects(loadPrompt(root, agentDir, "missing.md"), /読み込めません/);
    await assert.rejects(loadPrompt(root, agentDir, ".pi"), /読み込めません/);
    const global = join(agentDir, PROMPT_FILENAME);
    await writeFile(global, " \n\t");
    await assert.rejects(loadPrompt(root, agentDir), /空/);
    assert.equal(await readFile(global, "utf8"), " \n\t");
    await writeFile(global, "全体の指示。");
    const project = join(root, ".pi", PROMPT_FILENAME);
    await writeFile(project, "");
    await assert.rejects(loadPrompt(root, agentDir), /空/);
    assert.equal(await readFile(project, "utf8"), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("updating the package and its bundled default retains the user's external Markdown prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "jp-gate-prompt-update-"));
  try {
    const loader = await readFile(new URL("../src/prompt.ts", import.meta.url), "utf8");
    const agentDir = join(root, "agent");
    for (const version of ["old", "new"]) {
      const packageDir = join(root, version);
      await mkdir(join(packageDir, "src"), { recursive: true });
      await mkdir(join(packageDir, "prompts"));
      await writeFile(join(packageDir, "src", "prompt.ts"), loader);
      await writeFile(join(packageDir, "prompts", "jp-gate.md"), `${version} の既定プロンプト。`);
    }
    const oldPackage = await import(pathToFileURL(join(root, "old", "src", "prompt.ts")).href);
    const newPackage = await import(pathToFileURL(join(root, "new", "src", "prompt.ts")).href);
    assert.equal((await oldPackage.loadPrompt(root, agentDir)).text, "old の既定プロンプト。");
    const path = join(agentDir, PROMPT_FILENAME);
    await writeFile(path, "更新後も保持するカスタム指示。");
    assert.equal(newPackage.GATE_PROMPT, "new の既定プロンプト。");
    assert.deepEqual(await newPackage.loadPrompt(root, agentDir), { path, text: "更新後も保持するカスタム指示。" });
    assert.equal(await readFile(path, "utf8"), "更新後も保持するカスタム指示。");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("JSON configuration and CLI prompt overrides reach the gate as exact Markdown snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "jp-gate-prompt-config-"));
  try {
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, "config.md"), "設定用指示。");
    const custom = '# CLI の日本語指示\n\nJSON の "texts" と `コード` を保持。\\n\n';
    await writeFile(join(root, "cli.md"), custom);
    await writeFile(join(root, ".pi", "jp-gate.json"), JSON.stringify({ gate: { model: "fixture/editor", promptFile: "config.md" } }));
    assert.equal((await loadConfig(root, agentDir)).config.prompt?.text, "設定用指示。");
    const { config } = await loadConfig(root, agentDir, { promptFile: "cli.md" });
    const received: string[] = [];
    const client: GateClient = {
      find: () => testModel,
      streamSimple: (_model, context) => {
        received.push(context.systemPrompt!);
        return streamOf(message("こんにちは。"));
      },
    };
    await correctMessage(message("hello"), config, client);
    await writeFile(join(root, "cli.md"), "再読み込み後の指示。");
    await correctMessage(message("hello"), config, client);
    const reloaded = await loadConfig(root, agentDir, { promptFile: "cli.md" });
    await correctMessage(message("hello"), reloaded.config, client);
    assert.deepEqual(received, [custom, custom, "再読み込み後の指示。"]);
    await assert.rejects(loadConfig(root, agentDir, { promptFile: "missing.md" }), /読み込めません/);
    assert.equal((await loadConfig(root, agentDir, { enabled: false, promptFile: "missing.md" })).config.enabled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
