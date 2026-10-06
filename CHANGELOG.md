# Changelog

## Unreleased

- Add `validationMode: "json"`, `--jp-gate-validation json`, and `/jp-gate validation json` to accept JSON-valid corrections with changed text counts or JSON shapes while retaining code/URL protection and completion checks. Keep strict validation as the default.
- Extract the gate prompt into `src/gate-prompt.ts` for independent editing while preserving its content and the `GATE_PROMPT` export from `src/gate.ts`.
- Restore original line breaks and text blocks when the gate returns unchanged paragraphs as separate array entries; continue rejecting changed or incomplete split replies.
- Clarify the gate prompt to keep paragraphs within their original JSON string, and include input/output counts in count mismatch errors.

## 0.1.0

- Dedicated LLM gate for natural Japanese corrections before Pi emits responses.
- CLI flags, slash commands, and global/project JSON configuration.
- Code/URL protection, cancellation, timeout, and explicit failure behavior.
- Pi provider authentication reuse and offline CLI integration tests.
