import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const GATE_PROMPT = readFileSync(new URL("../prompts/jp-gate.md", import.meta.url), "utf8");
export const PROMPT_FILENAME = "jp-gate-prompt.md";

export interface GatePrompt {
  path: string;
  text: string;
}

async function readPrompt(path: string, optional = false): Promise<GatePrompt | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Gate プロンプトを読み込めません: ${path}`, { cause: error });
  }
  if (!text.trim()) throw new Error(`Gate プロンプトが空です: ${path}`);
  return { path, text };
}

/** Keep editable prompts outside the package; create the global default only once. */
export async function loadPrompt(cwd: string, agentDir: string, explicitPath?: string): Promise<GatePrompt> {
  if (explicitPath) return (await readPrompt(isAbsolute(explicitPath) ? explicitPath : resolve(cwd, explicitPath)))!;
  const project = await readPrompt(join(cwd, ".pi", PROMPT_FILENAME), true);
  if (project) return project;
  const path = join(agentDir, PROMPT_FILENAME);
  const global = await readPrompt(path, true);
  if (global) return global;
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(path, GATE_PROMPT, { flag: "wx" });
  } catch (error) {
    // Another session may have created it. Never truncate or replace an existing prompt.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(`Gate プロンプトを作成できません: ${path}`, { cause: error });
    }
  }
  return (await readPrompt(path))!;
}
