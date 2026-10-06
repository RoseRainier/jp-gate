import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig, mergeConfig, parseFlags, splitModel } from "../src/config.ts";

test("provider IDs and model IDs containing slashes resolve without ambiguity", () => {
  assert.deepEqual(splitModel("openrouter/qwen/qwen-3.8"), { provider: "openrouter", id: "qwen/qwen-3.8" });
  for (const input of ["foo", "/foo", "foo/", " foo/bar", "foo/bar baz"]) assert.throws(() => splitModel(input));
});

test("configuration validates types, limits, and typos", () => {
  for (const config of [null, [], { enable: true }, { enabled: "off" }, { gate: null }, { gate: { typo: 1 } }, { gate: { maxTokens: 0 } }, { gate: { timeoutMs: 2 ** 32 } }, { gate: { temperature: -1 } }, { gate: { model: "foo" } }, { failureMode: "ignore" }, { validationMode: "ignore" }, { validationMode: true }]) {
    assert.throws(() => mergeConfig(DEFAULT_CONFIG, config));
  }
  const result = mergeConfig(DEFAULT_CONFIG, { enabled: false, gate: { model: "p/m" } });
  assert.equal(result.gate.timeoutMs, 60000);
  assert.equal(DEFAULT_CONFIG.gate.model, undefined);
  assert.equal(result.enabled, false);
  assert.equal(result.validationMode, "strict");
  assert.equal(mergeConfig(result, { validationMode: "json" }).validationMode, "json");
});

test("CLI flags provide on/off overrides without boolean-default conflicts", () => {
  assert.deepEqual(parseFlags(() => undefined), {});
  const flags: Record<string, string> = { "jp-gate": "off", "jp-gate-model": "p/m", "jp-gate-config": "./custom.json", "jp-gate-validation": "json" };
  assert.deepEqual(parseFlags((key) => flags[key]), { enabled: false, model: "p/m", configPath: "./custom.json", validationMode: "json" });
  assert.throws(() => parseFlags(() => "false"));
  for (const invalid of [true, "off", ""]) {
    assert.throws(() => parseFlags((key) => key === "jp-gate-validation" ? invalid : undefined), /strict \/ json/);
  }
});

test("settings merge in global < project < explicit file < CLI order", async () => {
  const root = await mkdtemp(join(tmpdir(), "jp-gate-config-"));
  try {
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(agentDir);
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(agentDir, "jp-gate.json"), JSON.stringify({ enabled: false, gate: { model: "global/m", timeoutMs: 1500 }, validationMode: "json" }));
    assert.equal((await loadConfig(cwd, agentDir)).config.validationMode, "json");
    await writeFile(join(cwd, ".pi", "jp-gate.json"), JSON.stringify({ enabled: true, gate: { model: "project/m" }, validationMode: "strict" }));
    assert.equal((await loadConfig(cwd, agentDir)).config.validationMode, "strict");
    await writeFile(join(cwd, "extra.json"), JSON.stringify({ gate: { model: "extra/m", maxTokens: 2048 }, validationMode: "json" }));
    assert.equal((await loadConfig(cwd, agentDir, { configPath: "extra.json" })).config.validationMode, "json");
    const loaded = await loadConfig(cwd, agentDir, { configPath: "extra.json", model: "cli/m", enabled: false, validationMode: "strict" });
    assert.equal(loaded.config.enabled, false);
    assert.equal(loaded.config.gate.model, "cli/m");
    assert.equal(loaded.config.gate.timeoutMs, 1500);
    assert.equal(loaded.config.gate.maxTokens, 2048);
    assert.equal(loaded.config.validationMode, "strict");
    assert.equal(loaded.files.length, 3);
    await assert.rejects(loadConfig(cwd, agentDir, { configPath: "missing.json" }), /読み込めません/);
    await writeFile(join(cwd, ".pi", "jp-gate.json"), "{bad");
    await assert.rejects(loadConfig(cwd, agentDir), /設定ファイル/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
