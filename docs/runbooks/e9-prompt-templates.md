# E9 Prompt Templates With Redacted Inputs

Use this runbook for the E9 prompt-template boundary that produces shadow-validation requests from redacted evidence only.

## Current Contract

- prompt templates accept only `redacted` artifacts
- prompt inputs are rejected if they still contain unsanitized secret material
- rendered prompts always target `shadowValidation`
- the default runtime uses the disabled optional provider unless an explicit provider service is supplied

## Primary Commands

```bash
bun run check:e9-prompt-templates
bun test tests/libs/foundation-core-prompt-template-runtime.test.ts
```

## Expected Outcomes

- redacted evidence renders into a deterministic prompt
- raw or unsanitized evidence is rejected before provider invocation
- default execution stays disabled without external model dependencies
- optional provider execution returns typed output that remains on the shadow-validation route

## Rollback Guidance

If the prompt-template boundary regresses:

1. Revert the unsafe prompt-input or provider-routing change.
2. Re-run the focused prompt-template check.
3. Do not roll back by:
   - allowing raw artifacts into prompt templates
   - allowing bearer tokens, passwords, credentialed URLs, or other unsanitized values into prompt bodies
   - routing prompt-model output straight to active promotion
