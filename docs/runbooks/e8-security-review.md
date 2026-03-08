# E8 Security Review

## Purpose

Review the E8 unified SDK and control-plane slice for intake-policy regressions,
workflow-lineage tampering, and export-surface sanitization gaps before
promotion.

This review is currently enforced by:

- guardrail test: `tests/guardrails/e8-security-review.verify.test.ts`
- command: `bun run check:e8-security-review`

## Threat Checklist

| Threat | Status | Control |
| --- | --- | --- |
| Credential-bearing or private preview URLs reach the network layer | Mitigated | `runAccessPreviewOperation(...)` reuses the E0 request-policy boundary in `src/sdk/scraper.ts` and rejects unsafe URLs before fetch |
| Forged workflow checkpoints resume a different run lineage | Mitigated | `runWorkflowResumeOperation(...)` validates checkpoint ids, resume tokens, pending steps, and run identity against the compiled plan |
| Render-preview exports leak unsafe link targets | Mitigated | `runRenderPreviewOperation(...)` keeps only `http`/`https` links, strips credentials and fragments, and de-duplicates emitted targets |
| Artifact export leaks absolute operator filesystem paths | Mitigated | `runArtifactExportOperation(...)` rewrites absolute benchmark paths to repo-relative or basename-only transport values before emission |
| Type-safety or Effect-policy regressions weaken security controls | Mitigated | repository guardrails still require `lint:typesafety`, `check:governance`, and `check:effect-v4-policy` |

## Findings

### Current severity summary

- Open high-severity findings: none
- Open medium-severity findings: none inside the current E8 public transport
  surfaces validated by this review
- Residual risk: render-preview responses intentionally keep operator-visible
  `title` and `textPreview` content. Those fields are acceptable for the current
  interactive preview boundary, but any later prompt, log, or public-export
  consumer must add a redaction boundary instead of forwarding them blindly.

## Verification Evidence

- `tests/guardrails/e8-security-review.verify.test.ts` verifies that:
  - unsafe preview URLs fail before the public E8 control plane performs fetches
  - workflow resume rejects forged checkpoint lineage instead of accepting a
    tampered resume token
  - render preview emits only sanitized `http`/`https` link targets without
    credentials, fragments, or non-network schemes
  - artifact export rewrites absolute benchmark paths before they leave the E8
    public artifact envelope
- `tests/sdk/e8-preview-verify.test.ts` keeps the preview lane deterministic
  across SDK and CLI.
- `tests/sdk/e8-workflow-verify.test.ts` keeps workflow envelopes deterministic
  across SDK and CLI while validating lineage contracts.
- `tests/sdk/e8-benchmark-export.test.ts` keeps the benchmark/export artifacts
  deterministic on the public `effect-scrapling/e8` subpath.

## Commands

Run the focused security review:

```bash
bun run check:e8-security-review
```

Run the underlying guardrail directly:

```bash
bun test tests/guardrails/e8-security-review.verify.test.ts
```

## Operator Guidance

1. Treat changes to `src/sdk/scraper.ts`, `src/e8-control-plane.ts`, and
   `src/e8-benchmark-surface.ts` as security-sensitive because they define the
   public E8 transport boundary.
2. Re-run `bun test tests/guardrails/e8-security-review.verify.test.ts` after
   any preview, workflow, or export-surface change.
3. Re-run the focused E8 verification suites before promotion:

```bash
bun test tests/sdk/e8-preview-verify.test.ts
bun test tests/sdk/e8-workflow-verify.test.ts
bun test tests/sdk/e8-benchmark-export.test.ts
```

4. Replay repository gates before closure or merge:
   `bun run lint`, `bun run check`, `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:lint`,
   `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:typecheck`, and
   `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run nx:build`.

## Rollback Guidance

1. Revert the offending intake-policy, workflow-lineage, or export-sanitization
   change rather than weakening the boundary.
2. Re-run:

```bash
bun test tests/guardrails/e8-security-review.verify.test.ts
bun test tests/sdk/e8-preview-verify.test.ts
bun test tests/sdk/e8-workflow-verify.test.ts
bun test tests/sdk/e8-benchmark-export.test.ts
```

3. Do not roll back by:
   - allowing credential-bearing or private preview targets
   - bypassing workflow checkpoint lineage validation
   - emitting absolute filesystem paths in the public artifact envelope
   - reintroducing manual `_tag`, `instanceof`, unsafe casts, or non-Effect-v4 dependencies
