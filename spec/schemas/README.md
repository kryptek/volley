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
| `capability.schema.json` | `capability` | section 4 |
| `control.schema.json` | `control` (reserved) | section 4 |

## Validating a payload

The authoritative validator is the Phase 4 script `bun run validate:schemas`, which loads every schema with `ajv` + `ajv-formats` properly wired in. For a one-off check with `ajv-cli`:

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
