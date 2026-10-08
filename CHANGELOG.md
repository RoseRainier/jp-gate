# Changelog

## Unreleased

- Disable inherited correction by default in pi-subagent workers, avoiding an extra gate pass on internal results before the parent corrects its user-facing answer. Explicit `--jp-gate on` and `/jp-gate on` still enable worker correction.

- Restore editable external Markdown prompts, prompt path overrides, and reload support. Preserve the current bundled prompt and never overwrite existing external prompts on package updates.

- Start from the JSON-mode implementation in `9de5b20`, then extract only the response text for correction. Send and receive plain text at the gate, and return it to the original Pi response. Remove gate JSON validation, protection markers, literal validation, and additional editing requests.
- Shorten the supplied gate prompt to plain-text translation and correction in Haruka's voice. Allow minor wording changes while preserving content and intent, and request low reasoning for the correction call.

- Extract the gate prompt into `src/gate-prompt.ts` for independent editing while preserving its content and the `GATE_PROMPT` export from `src/gate.ts`.

## 0.1.0

- Dedicated LLM gate for natural Japanese corrections before Pi emits responses.
- CLI flags, slash commands, and global/project JSON configuration.
- Code/URL protection, cancellation, timeout, and explicit failure behavior.
- Pi provider authentication reuse and offline CLI integration tests.
