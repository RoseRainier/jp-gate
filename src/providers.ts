import type { AssistantMessageEventStream, Model, Provider } from "@earendil-works/pi-ai";
import type { ModelRegistry, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { GateConfig } from "./config.ts";
import { correctMessage, gateBypass, type GateUsage } from "./gate.ts";
import { gatedStream } from "./stream.ts";

interface Registration {
  wrapper: Provider;
  native?: Provider;
  config?: ProviderConfig;
}

interface ProviderGateOptions {
  registry: ModelRegistry;
  register: (provider: Provider) => void;
  unregister: (id: string) => void;
  restoreConfig: (id: string, config: ProviderConfig) => void;
  getConfig: () => GateConfig;
  getConfigError: () => string | undefined;
  onFailure: (reason: string) => void;
  onUsage: (usage: GateUsage) => void;
}

/** Use the public native-provider API; restore the previous registration on shutdown/reload. */
export class ProviderGate {
  private readonly registrations = new Map<string, Registration>();
  private readonly options: ProviderGateOptions;

  constructor(options: ProviderGateOptions) { this.options = options; }

  install(): void {
    const { registry } = this.options;
    const ids = new Set(registry.getAll().map((model) => model.provider));
    for (const id of ids) {
      const existing = this.registrations.get(id);
      if (existing && registry.getRegisteredNativeProvider(id) === existing.wrapper) continue;
      const original = registry.getProvider(id);
      if (!original) continue;
      const native = registry.getRegisteredNativeProvider(id);
      const config = registry.getRegisteredProviderConfig(id);
      const intercept = (model: Model<string>, options: { signal?: AbortSignal } | undefined, source: () => AssistantMessageEventStream) => {
        const snapshot = this.options.getConfig();
        if (!snapshot.enabled || gateBypass.getStore()) return source();
        return gatedStream({
          model, config: snapshot, signal: options?.signal,
          source,
          correct: (message) => {
            const error = this.options.getConfigError();
            if (error) throw new Error(error);
            return correctMessage(message, snapshot, registry, options?.signal, this.options.onUsage);
          },
          onFailure: this.options.onFailure,
        });
      };
      const interceptSimple: Provider["streamSimple"] = (model, context, options) =>
        intercept(model, options, () => original.streamSimple(model, context, options));
      const interceptStream: Provider["stream"] = (model, context, options) =>
        intercept(model, options, () => original.stream(model, context, options));
      const interceptDeferred: Provider["fetchDeferred"] = original.fetchDeferred && ((model, handle, options) =>
        intercept(model, options, () => original.fetchDeferred!(model, handle, options)));
      // Preserve prototype methods, auth, discovery, and image/classifier behavior as well.
      const wrapper = new Proxy(original, {
        get(target, key) {
          if (key === "streamSimple") return interceptSimple;
          if (key === "stream") return interceptStream;
          if (key === "fetchDeferred") return interceptDeferred;
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      this.options.register(wrapper);
      this.registrations.set(id, { wrapper, native, config });
    }
  }

  restore(): void {
    for (const [id, previous] of this.registrations) {
      // Another extension may have deliberately replaced this provider in the meantime.
      if (this.options.registry.getRegisteredNativeProvider(id) !== previous.wrapper) continue;
      this.options.unregister(id);
      if (previous.native) this.options.register(previous.native);
      else if (previous.config) this.options.restoreConfig(id, previous.config);
    }
    this.registrations.clear();
  }
}
