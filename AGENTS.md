# Execution Workflow

1. Task selection starts with `bv --robot-triage`.
2. If triage output is empty or inconsistent, fallback to `CI=1 bd ready --json`.
3. Claim multiple beads in parallel only when they are not dependency-blocked.
4. Use one implementation subagent per bead and maximize parallel execution across independent beads.
5. Explicitly tell every subagent that other agents are working in parallel and that unrelated edits must be ignored.
6. For every fix, run exactly 2 independent blind review subagents before considering the bead done.
7. Enforce Effect best practices on every change; reject hacks, shortcuts, black magic, and type-safety bypasses.
8. Before bead closure, all required gates must pass: `ultracite`, `oxlint`, `oxfmt`, tests, build, and bead-specific checks.
9. Close a bead only after acceptance criteria are met, both blind reviews are clear, and all gates are green.
10. After integrating parallel fixes, rerun full repository gates, then commit and push.
11. Close completed or hanging subagents immediately to avoid zombie sessions.
