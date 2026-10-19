# Volley JSON Schemas

Machine-readable mirror of `SPEC.md`. Each schema follows JSON Schema 2020-12.

| Schema | Channel | Spec section |
|---|---|---|
| `envelope.schema.json` | (base) | section 3 |
| `status.schema.json` | `status` | section 5 |
| `progress.schema.json` | `progress` | section 4 |
| `mailbox.schema.json` | `mailbox` | section 4 |
| `registry.schema.json` | `_system/registry/<id>` | section 6 |
| `result.schema.json` | `result` | section 4 |
| `review-result.schema.json` | `result` (pipeline roles: `review`, `fixup`) | section 4.6.8 |
| `capability.schema.json` | `capability` | section 4 |
| `control.schema.json` | `control` (reserved) | section 4 |
| `screen.schema.json` | `screen` (supervisor-published) | section 4.6.6 |
| `usage.schema.json` | `usage` (the agent's harness) | section 4.6.12 |
| `claude-account.schema.json` | `_system/claude-accounts/<acct>` | section 4.6.12 |
| `wave-state.schema.json` | `_waves/<wave>/state` | section 4.6.1 |
| `decision.schema.json` | `_waves/<wave>/decisions/<id>` | section 4.6.2 |
| `wave-event.schema.json` | `_waves/<wave>/events` | section 4.6.3 |
| `config.schema.json` | `_waves/_config` (tunables in `$defs/tunables`) | section 4.6.4 |
| `config-set-request.schema.json` | supervisor `mailbox` (`op: config_set`) | section 4.6.4 |
| `lease-pool.schema.json` | `_system/leases/<pool>` | section 4.6.5 |
| `lease-request.schema.json` | `_system/leases/<pool>/requests` | section 4.6.5 |
| `admission.schema.json` | `_system/admission` | section 4.6.7 |
| `auth-request.schema.json` | `_system/auth/ops/<username>`, `volley-auth/redeem/<token_id>` | section 4.6.10 |
| `account.schema.json` | `accounts.json` account registry file (not an envelope) | section 4.6.10 |
| `agent-identity.schema.json` | `.volley/agent.json` file (not an envelope) | section 6.5 |
| `wave-file.schema.json` | a wave file submitted with `volleyd run` (YAML; not an envelope) | section 4.6 |

## Validating a payload

The authoritative validator is `bun run validate:schemas`, which loads every schema with `ajv` + `ajv-formats` properly wired in. For a one-off check with `ajv-cli`:

```bash
bunx ajv-cli validate \
  -s spec/schemas/status.schema.json \
  -r "spec/schemas/envelope.schema.json" \
  -d path/to/payload.json \
  --spec=draft2020 \
  --strict=false
```

`ajv-cli` bundles its own `ajv` without `ajv-formats`, so it emits `unknown format "date-time" ignored` warnings — these are harmless; validation still runs. For authoritative validation with formats enforced, use `bun run validate:schemas`.

CI runs `bun run validate:schemas` which exercises every example in `../examples/valid/` against the appropriate schema and verifies every example in `../examples/invalid/` fails validation. See `../../scripts/validate-schemas.ts`.
