# Kiro IDE Steering Rules

You're working in 2026. If you need today's date, run: `date`

## Core Principles

Simplicity First: Make every change as simple as possible. Impact minimal code.
No Laziness: Find root causes. No temporary fixes. Senior developer standards.
Minimal Impact: Changes should only touch what's necessary. Avoid introducing bugs.

## File Operations

- Always use the fsWrite tool to create or modify files
- NEVER use shell commands (echo, cat, heredocs, redirection) to write files
- If you need to execute code, create a file first and then run it

## Type Safety

- Use Zod schemas for runtime validation, following patterns in this workspace
- Use `satisfies` instead of `as` for type assertions
- No `any` types — strict TypeScript everywhere

## Code Quality

- When code gets complex, extract helper functions or sub-components
- Choose the long-term approach over shortcuts
- Follow best practices even when it takes more time upfront
- Minimal impact — changes should only touch what's necessary

## Deployment

**NEVER deploy without explicit user confirmation.**
Ask: "Ready to deploy to [environment]?" and wait for approval.

## Workflow

### Planning
- Enter plan mode for any non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan — don't keep pushing
- Write detailed specs upfront to reduce ambiguity

### Subagents
- Use subagents to keep the main context window clean
- Offload research, exploration, and parallel analysis
- One task per subagent for focused execution

### Verification
- Never mark a task complete without proving it works
- Run tests, check diagnostics, demonstrate correctness
- Ask yourself: "Would a staff engineer approve this?"

### Bug Fixing
- When given a bug report: just fix it — don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

### Elegance
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes – don't over-engineer
- Challenge your own work before presenting it