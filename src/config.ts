import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface GateConfig {
  enabled: boolean;
  gate: {
    model?: string;
    timeoutMs: number;
    maxTokens: number;
    temperature: number;
  };
  failureMode: "block" | "passthrough";
  validationMode: "strict" | "json";
}

export interface FlagOverrides {
  enabled?: boolean;
  model?: string;
  configPath?: string;
  validationMode?: GateConfig["validationMode"];
}

export const DEFAULT_CONFIG: GateConfig = {
  enabled: true,
  gate: { timeoutMs: 60_000, maxTokens: 8192, temperature: 0 },
  failureMode: "block",
  validationMode: "strict",
};

export function splitModel(value: string): { provider: string; id: string } {
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1 || value.trim() !== value || /\s/.test(value)) {
    throw new Error("Gate モデルは provider/model-id 形式で指定してください。");
  }
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} は JSON オブジェクトで指定してください。`);
  }
  return value as Record<string, unknown>;
}

function checkKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label}: 未対応の設定項目 '${key}' です。`);
  }
}

export function mergeConfig(base: GateConfig, input: unknown): GateConfig {
  const source = object(input, "jp-gate");
  checkKeys(source, ["enabled", "gate", "failureMode", "validationMode"], "jp-gate");
  const next: GateConfig = { ...base, gate: { ...base.gate } };
  if ("enabled" in source) {
    if (typeof source.enabled !== "boolean") throw new Error("enabled は true / false で指定してください。");
    next.enabled = source.enabled;
  }
  if ("failureMode" in source) {
    if (source.failureMode !== "block" && source.failureMode !== "passthrough") {
      throw new Error("failureMode は block / passthrough で指定してください。");
    }
    next.failureMode = source.failureMode;
  }
  if ("validationMode" in source) {
    if (source.validationMode !== "strict" && source.validationMode !== "json") {
      throw new Error("validationMode は strict / json で指定してください。");
    }
    next.validationMode = source.validationMode;
  }
  if ("gate" in source) {
    const gate = object(source.gate, "gate");
    checkKeys(gate, ["model", "timeoutMs", "maxTokens", "temperature"], "gate");
    if ("model" in gate) {
      if (typeof gate.model !== "string") throw new Error("gate.model は文字列で指定してください。");
      splitModel(gate.model);
      next.gate.model = gate.model;
    }
    for (const key of ["timeoutMs", "maxTokens"] as const) {
      if (key in gate) {
        const value = gate[key];
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
          throw new Error(`gate.${key} は正の整数で指定してください。`);
        }
        next.gate[key] = value;
      }
    }
    if ("temperature" in gate) {
      const value = gate.temperature;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) {
        throw new Error("gate.temperature は 0〜2 の数値で指定してください。");
      }
      next.gate.temperature = value;
    }
  }
  return next;
}

export function parseFlags(getFlag: (name: string) => boolean | string | undefined): FlagOverrides {
  const result: FlagOverrides = {};
  const enabled = getFlag("jp-gate");
  if (enabled !== undefined) {
    if (enabled !== "on" && enabled !== "off") throw new Error("--jp-gate は on / off を指定してください。");
    result.enabled = enabled === "on";
  }
  const model = getFlag("jp-gate-model");
  if (model !== undefined) {
    if (typeof model !== "string") throw new Error("--jp-gate-model は文字列で指定してください。");
    splitModel(model);
    result.model = model;
  }
  const configPath = getFlag("jp-gate-config");
  if (configPath !== undefined) {
    if (typeof configPath !== "string" || !configPath.trim()) throw new Error("--jp-gate-config にファイルパスを指定してください。");
    result.configPath = configPath;
  }
  const validationMode = getFlag("jp-gate-validation");
  if (validationMode !== undefined) {
    if (validationMode !== "strict" && validationMode !== "json") {
      throw new Error("--jp-gate-validation は strict / json を指定してください。");
    }
    result.validationMode = validationMode;
  }
  return result;
}

export async function loadConfig(cwd: string, agentDir: string, flags: FlagOverrides = {}): Promise<{ config: GateConfig; files: string[] }> {
  let config = mergeConfig(DEFAULT_CONFIG, {});
  const files: string[] = [];
  const paths = [join(agentDir, "jp-gate.json"), join(cwd, ".pi", "jp-gate.json")];
  const explicitPath = flags.configPath && (isAbsolute(flags.configPath) ? flags.configPath : resolve(cwd, flags.configPath));
  if (explicitPath) paths.push(explicitPath);
  for (const path of [...new Set(paths)]) {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && path !== explicitPath) continue;
      throw new Error(`設定ファイルを読み込めません: ${path}`, { cause: error });
    }
    try {
      config = mergeConfig(config, JSON.parse(contents));
      files.push(path);
    } catch (error) {
      throw new Error(`設定ファイル ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  if (flags.enabled !== undefined) config.enabled = flags.enabled;
  if (flags.model !== undefined) config.gate.model = flags.model;
  if (flags.validationMode !== undefined) config.validationMode = flags.validationMode;
  return { config, files };
}
