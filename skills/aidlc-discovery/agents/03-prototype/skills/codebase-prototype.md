# Codebase Prototype — Skill (Prototype Orchestrator)

## Purpose

Build a disposable prototype from the product's real code, so the team sees the
PRD's P0 features inside the product it already ships. The HTML prototype stays
the required Prototype artifact; this one is optional evidence.

## When to Use

- The working folder is the product's own repository (Kiro or Claude Code).
- The PRD exists and its P0 features touch user-facing screens or flows.
- The team asks for it. Never start it by default.

Skip it for greenfield products, for Amazon Quick (no repository), and when the
team cannot run the product locally.

## Rules

1. **Throwaway branch.** Create `discovery/prototype` from the current branch.
   Never commit to the main branch and never open a pull request from it.
2. **Never merged.** State in the record and in the Discovery brief that the
   branch is disposable. AI-DLC Construction starts from the main branch.
3. **Smallest change that shows the idea.** Reuse existing components, stub
   data and backends, and skip tests, migrations, and infrastructure.
4. **No secrets or production data.** Use the anonymized data the HTML
   prototype uses.
5. **Ask before running anything** that installs dependencies or starts
   servers.

## Flow

1. Read the PRD (P0 features) and the current-product map, if present.
2. Propose which screens to change and how. Wait for confirmation.
3. Create the branch, make the changes, and show the team how to run it.
4. Write the record.

## Output

`discovery/[project]/prototype/codebase-prototype.md` containing:

- Branch name and the commit it started from
- Screens or flows changed, mapped to PRD features
- How to run it
- What is stubbed or faked
- The line: "Disposable prototype. Do not merge. AI-DLC Construction starts from the main branch."
