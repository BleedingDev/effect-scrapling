# E9 Optional LLM Provider

Use this runbook for the optional prompt-model provider boundary introduced in E9.

## Current Contract

- The provider is optional and disabled by default.
- The shared service boundary validates every request and response through Effect Schema.
- The provider is not required by the hot path of fetch, extract, compare, or promote flows.
- Prompt-model outputs are routed to `shadowValidation`, not directly to active promotion.

## Primary Commands

```bash
bun run check:e9-optional-llm-provider
bun test tests/libs/foundation-core-llm-provider-runtime.test.ts
```

## Expected Outcomes

- disabled mode returns a typed disabled envelope
- enabled mode returns a typed completed envelope
- malformed provider responses fail schema validation deterministically

## Rollback Guidance

If the provider abstraction regresses:

1. Revert the provider boundary, not the schema validation.
2. Re-run the focused E9 provider check.
3. Do not roll back by:
   - bypassing schema validation on provider output
   - making the provider mandatory for the non-LLM runtime path
   - sending prompt-model output directly to active promotion
