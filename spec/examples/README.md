# Volley Example Payloads

This directory holds canonical example payloads for each Volley channel. They serve two purposes:

1. **Documentation** — readers see real envelope shapes alongside the spec.
2. **Test corpus** — CI runs `bun run validate:schemas` which checks that every file in `valid/` passes its channel schema and every file in `invalid/` fails its channel schema.

## Naming convention

- `valid/<channel>-<descriptor>.json` — a passing payload.
- `invalid/<channel>-<violation>.json` — a payload that violates exactly one rule. The filename describes the violation. Each file MUST violate exactly one rule; multi-violation files defeat the purpose.

## Channel coverage

| Channel | Valid examples | Invalid examples |
|---|---|---|
| `status` | `status-done.json`, `status-working.json` | `status-wrong-channel.json`, `status-invalid-type.json` |
| `progress` | `progress-tests-green.json` | — |
| `mailbox` | `mailbox-steering.json` | `mailbox-missing-text.json` |
| `_system/registry` | `registry-coordinator.json` | — |
| `result` | `result-pr-merged.json` | — |
| `capability` | `capability-claude-code.json` | — |
| envelope-level | (all valid files) | `envelope-missing-schema-version.json`, `envelope-bad-agent-id.json` |

## Extending

Adding a new violation? Create a new `invalid/<channel>-<violation>.json` and update the table above. The validation script auto-discovers files; no script changes needed.
