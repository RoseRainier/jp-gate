import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, mergeConfig, parseFlags, splitModel, type GateConfig } from "./config.ts";
import { ProviderGate } from "./providers.ts";

export default function japaneseGateExtension(pi: ExtensionAPI): void {
  let config: GateConfig = mergeConfig(DEFAULT_CONFIG, {});
  let configError: string | undefined;
  let files: string[] = [];
  let providerGate: ProviderGate | undefined;
  let latestCtx: ExtensionContext | undefined;

  pi.registerFlag("jp-gate", { type: "string", description: "Japanese LLM gate: on | off" });
  pi.registerFlag("jp-gate-model", { type: "string", description: "Gate model in provider/model-id format" });
  pi.registerFlag("jp-gate-config", { type: "string", description: "Additional Japanese gate JSON configuration file" });

  const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
    if (latestCtx?.hasUI) latestCtx.ui.notify(message, level);
    else console.error(`[jp-gate] ${message}`);
  };
  const status = () => {
    if (latestCtx?.mode === "tui") {
      latestCtx.ui.setStatus("jp-gate", config.enabled ? `JP Gate: ON (${config.gate.model ?? "モデル未設定"})` : "JP Gate: OFF");
    }
  };
  const reload = async (ctx: ExtensionContext) => {
    try {
      const loaded = await loadConfig(ctx.cwd, getAgentDir(), parseFlags((name) => pi.getFlag(name)));
      config = loaded.config;
      files = loaded.files;
      configError = undefined;
    } catch (error) {
      configError = error instanceof Error ? error.message : String(error);
      // A broken config must not silently turn off the requested gate.
      config = mergeConfig(DEFAULT_CONFIG, {});
      // An explicit CLI off is still respected, even if a file is malformed.
      if (pi.getFlag("jp-gate") === "off") config.enabled = false;
      files = [];
      notify(configError, "error");
    }
    status();
  };

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    providerGate?.restore();
    await reload(ctx);
    providerGate = new ProviderGate({
      registry: ctx.modelRegistry,
      register: (provider) => pi.registerProvider(provider),
      unregister: (id) => pi.unregisterProvider(id),
      restoreConfig: (id, previous) => pi.registerProvider(id, previous),
      getConfig: () => config,
      getConfigError: () => configError,
      onFailure: (reason) => notify(`${reason}${config.failureMode === "passthrough" ? " 未補正の回答を出力します。" : " 未補正の回答は出力しません。"}`, "warning"),
      onUsage: (usage) => pi.appendEntry("jp-gate-usage", usage),
    });
    providerGate.install();
    status();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    latestCtx = ctx;
    providerGate?.install();
  });
  pi.on("model_select", (_event, ctx) => {
    latestCtx = ctx;
    providerGate?.install();
    status();
  });
  pi.on("session_shutdown", () => {
    providerGate?.restore();
    providerGate = undefined;
    if (latestCtx?.mode === "tui") latestCtx.ui.setStatus("jp-gate", undefined);
  });

  pi.registerCommand("jp-gate", {
    description: "日本語補正 LLM: on | off | status | reload | model provider/model-id",
    getArgumentCompletions: (prefix) => ["on", "off", "status", "reload", "model"]
      .filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      latestCtx = ctx;
      // Do not change provider registration while an existing response is streaming.
      await ctx.waitForIdle();
      const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (action === "model") {
          if (rest.length !== 1) throw new Error("/jp-gate model provider/model-id と指定してください。");
          splitModel(rest[0]);
          if (!ctx.modelRegistry.find(splitModel(rest[0]).provider, splitModel(rest[0]).id)) {
            throw new Error(`モデル '${rest[0]}' が Pi に登録されていません。`);
          }
          config = { ...config, gate: { ...config.gate, model: rest[0] } };
          notify(`Gate モデル: ${rest[0]}（このセッションのみ）`);
        } else {
          if (rest.length > 0) throw new Error("/jp-gate on | off | status | reload | model provider/model-id");
          if (action === "on" || action === "off") {
            if (action === "on" && configError) throw new Error(`${configError} /jp-gate reload で再読み込みしてください。`);
            config = { ...config, enabled: action === "on" };
            notify(`日本語 Gate: ${action.toUpperCase()}（このセッションのみ）`);
          } else if (action === "reload") {
            await reload(ctx);
            if (!configError) notify("日本語 Gate の設定を再読み込みしました。");
          } else if (action === "status") {
            notify([
              `日本語 Gate: ${config.enabled ? "ON" : "OFF"}`,
              `Gate モデル: ${config.gate.model ?? "未設定"}`,
              `失敗時: ${config.failureMode}; 制限: ${config.gate.timeoutMs}ms / ${config.gate.maxTokens} tokens`,
              `設定ファイル: ${files.length ? files.join(", ") : "なし（既定値／CLI）"}`,
              ...(configError ? [`設定エラー: ${configError}`] : []),
            ].join("\n"));
          } else throw new Error("/jp-gate on | off | status | reload | model provider/model-id");
        }
        providerGate?.install();
        status();
      } catch (error) { notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });
}
