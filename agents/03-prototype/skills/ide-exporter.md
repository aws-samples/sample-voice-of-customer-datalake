# IDE Exporter — Skill (Prototype Orchestrator)

## Purpose

Export all project artifacts (PRD, PRFAQ, Research, Personas, Prototype) into a format that can be consumed directly by AI coding agents (Kiro, Claude Code, Codex, Cursor, etc.).

Goal: **Seamless handoff from Ideation → real prototyping with code.**

---

## Supported Export Targets

| IDE / Agent | Export format | What it needs |
|-------------|--------------|---------------|
| **Kiro** | `.kiro/` specs + requirements | PRD → Requirements, PRFAQ → Context, Personas → User Stories |
| **Claude Code** | `CLAUDE.md` + task description | Full context as Markdown + a clear task |
| **Codex / ChatGPT** | `AGENTS.md` or prompt file | Specification + constraints as a system prompt |
| **Cursor** | `.cursor/rules` + context files | PRD as rules, PRFAQ as context |
| **Generic** | `/specs/` folder with all docs | Universally usable by any agent |

---

## Export Structure per Target

### Kiro Export

```
[project]-kiro-export/
├── .kiro/
│   ├── product-requirements/
│   │   └── requirements.md       ← From PRD: User Stories + Acceptance Criteria
│   └── context/
│       ├── product-context.md    ← From PRFAQ: Value Prop, Customer Problem
│       ├── personas.md           ← All personas as context
│       └── research.md           ← Key findings from Research
├── prototype/
│   └── index.html                ← Existing click-dummy (if present)
└── README.md                     ← Setup instructions for Kiro
```

### Claude Code Export

```
[project]-claude-export/
├── CLAUDE.md                     ← System context (project overview, constraints)
├── docs/
│   ├── prd.md                    ← Full PRD
│   ├── prfaq.md                  ← Full PRFAQ
│   ├── personas.md               ← All personas
│   └── research.md               ← Research findings
├── prototype/
│   └── index.html                ← Click-dummy as reference
└── task.md                       ← Concrete task for Claude Code
```

### Codex / Generic Export

```
[project]-codex-export/
├── AGENTS.md                     ← Agent instructions + constraints
├── specs/
│   ├── product-requirements.md
│   ├── user-stories.md
│   ├── acceptance-criteria.md
│   └── technical-constraints.md
├── context/
│   ├── customer-problem.md
│   ├── personas.md
│   └── market-context.md
├── reference/
│   └── index.html                ← Click-dummy
└── README.md
```

---

## Prompt Template

### System Prompt
```
You are a Technical Specification Writer. You translate product documents
(PRD, PRFAQ, Personas, Research) into machine-readable specifications for
AI coding agents.

Rules:
- Every requirement must be testable/verifiable
- User stories in the format "As a [persona], I want [action], so that [benefit]"
- Acceptance criteria as a checklist (Given/When/Then or simple ✅ points)
- Name technical constraints clearly (stack, performance, security)
- Preserve prioritization (P0/P1/P2 from the PRD)
```

### User Prompt Template (Kiro)
```
Convert this PRD into Kiro-compatible requirements:

## PRD:
{prd_content}

## PRFAQ (for context):
{prfaq_content}

## PERSONAS:
{personas_content}

---

Create:
1. `requirements.md` — User Stories + Acceptance Criteria (Kiro format)
2. `product-context.md` — Problem, Solution, Target Users (for .kiro/context/)

Format for requirements:
```
## Feature: [Name]
### User Story
As a [persona], I want [action], so that [benefit].

### Acceptance Criteria
- [ ] [Criterion 1]
- [ ] [Criterion 2]

### Priority: P0 | P1 | P2
```
```

---

## Flow

1. **Choose target** — "Which IDE/agent to export for? (Kiro / Claude Code / Codex / Generic)"
2. **Load project** — PRD, PRFAQ, Personas, Research, Prototype from the project folder
3. **Convert** — transform the docs into the target format
4. **Export** — save as a zip-able folder

## Conversation

```
User: "Export project AnyCompany for Kiro"
→ Load all docs, convert, create the .kiro/ structure

User: "Create a Claude Code export"
→ Generate CLAUDE.md + task.md + docs/

User: "Generic export for the team"
→ Create a specs/ folder with all docs prepared

User: "Export only the requirements"
→ Extract User Stories + Acceptance Criteria from the PRD
```

## Output

- `knowledge-base/projects/[project]/prototype/[project]-[target]-export/` — complete export folder
- Opens the folder for an overview

## Important Rules

1. **Everything in one folder** — the user can drag the folder straight into the IDE
2. **Requirements must be testable** — no vague statements
3. **Preserve context** — the coding agent must understand WHY something is being built
4. **Personas as user context** — so the agent makes the right UX decisions
5. **Click-dummy as reference** — if present, include it as a visual anchor
6. **No code generation** — we export SPECIFICATIONS, not code. The IDE does that.
