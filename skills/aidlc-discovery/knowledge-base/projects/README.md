# Projects — Artifact Structure

## Principle

**Everything belongs to a project.** Every document, persona, and prototype is stored within a project. A project represents one Discovery engagement or product challenge.

Generated artifacts go to `discovery/[project]/` in the user's **working folder**, never inside the installed skill. The `anycompany-insights/` folder here is a bundled sample of Phase 1 output.

## Folder Structure per Project

```
discovery/
├── data/                          ← Raw customer feedback (kept out of git)
└── [project-name]/
    ├── PROJECT.md                 ← Project metadata (Name, Customer, Date, Status)
    │
    ├── signals/                   ← Phase 1: Signals
    │   ├── signal-summary.md      ← Consolidated Signal Report
    │   ├── voc-analysis.md        ← VoC Analytics Report
    │   ├── market-research.md     ← Market Research Report
    │   ├── competitive-intel.md   ← Competitive Research Report
    │   ├── hypotheses.md          ← Research Hypotheses
    │   └── current-product-map.md ← What the product does today (codebase only)
    │
    ├── working-backwards/         ← Phase 2: Working Backwards
    │   ├── personas/              ← Synthetic Personas
    │   ├── working-backwards.md   ← WB Document (5 Questions)
    │   ├── feature-description.md ← Feature Description
    │   ├── prfaq.md               ← PR/FAQ
    │   └── prd.md                 ← Product Requirements Document
    │
    ├── prototype/                 ← Phase 3: Prototype
    │   ├── index.html             ← Click-Dummy Prototype
    │   └── codebase-prototype.md  ← Optional in-codebase prototype record
    │
    ├── validate/                  ← Phase 4: Validate
    │   ├── survey.html            ← Validation Survey
    │   └── prioritization.md      ← Prioritized problems and open hypotheses
    │
    └── handoff/                   ← Phase 5: Handoff
        └── discovery-brief.md     ← The input AI-DLC Inception reads
```

## Creating a Project

When starting a new engagement:

```markdown
# PROJECT.md

name: "AnyCompany Insights Platform"
customer: "AnyCompany"
date: "2026-06-21"
status: "active"
team: ["Martha Rivera", "Mateo Jackson"]
focus: "Onboarding, Adoption & Reporting Experience"
engagement_reference: ""   # intake record number; never an opportunity ID
```

## Conventions

1. **One folder per project** — Everything that belongs together is stored together
2. **Sub-folders by phase** — signals/, working-backwards/, prototype/, validate/, handoff/
3. **Personas belong to the project** — They are generated for a specific topic
4. **Documents reference each other** — PRD references PRFAQ, PRFAQ references WB-Doc
5. **Status in PROJECT.md** — active / completed / archived
6. **Raw data stays out of git** — only anonymized, derived artifacts are committed
