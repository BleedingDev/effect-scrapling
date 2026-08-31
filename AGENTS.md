# Execution Workflow

1. Task selection starts with `bv --robot-triage`.
2. If triage output is empty or inconsistent, fallback to `CI=1 br ready --json`.
3. Claim multiple beads in parallel only when they are not dependency-blocked.
4. Use one implementation subagent per bead and maximize parallel execution across independent beads.
5. Explicitly tell every subagent that other agents are working in parallel and that unrelated edits must be ignored.
6. For every fix, run exactly 2 independent blind review subagents before considering the bead done.
7. Enforce Effect best practices on every change; reject hacks, shortcuts, black magic, and type-safety bypasses.
8. Before bead closure, all required gates must pass: `ultracite`, `oxlint`, `oxfmt`, tests, build, and bead-specific checks.
9. Close a bead only after acceptance criteria are met, both blind reviews are clear, and all gates are green.
10. After integrating parallel fixes, rerun full repository gates, then commit and push.
11. Close completed or hanging subagents immediately to avoid zombie sessions.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

**Note:** `br` is non-invasive and never executes git commands. After `br sync --flush-only`, you must manually run `git add .beads/ && git commit`.

This project uses **br (beads_rust)** for issue tracking.

### Quick Reference

```bash
br ready                # Find available work
br show <id>            # View issue details
br update <id> --claim  # Claim work
br close <id>           # Complete work
```

### Rules

- Use `br` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   br sync --flush-only
   git add .beads/
   git commit -m "sync beads"
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
