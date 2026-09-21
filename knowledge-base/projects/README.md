# Projects — Knowledge Base Structure

## Principle

**Everything belongs to a project.** Every document, every persona, every prototype is stored within a project. A project represents a workshop run or a product challenge.

## Folder Structure per Project

```
knowledge-base/projects/
└── [project-name]/
    ├── PROJECT.md                 ← Project metadata (Name, Customer, Date, Status)
    │
    ├── signals/                   ← Phase 1: Signal Analyzer Output
    │   ├── signal-summary.md      ← Consolidated Signal Report
    │   ├── voc-analysis.md        ← VoC Analytics Report
    │   ├── market-research.md     ← Market Research Report
    │   ├── competitive-intel.md   ← Competitive Research Report
    │   └── hypotheses.md          ← Research Hypotheses
    │
    ├── personas/                  ← Synthetic Personas
    │   ├── marcus-the-time-pressed.md
    │   ├── sarah-the-data-driven.md
    │   └── ...
    │
    ├── ideation/                  ← Phase 2: Ideation Output
    │   ├── working-backwards.md   ← WB Document (5 Questions)
    │   ├── feature-description.md ← Feature Description
    │   ├── prfaq.md               ← PR/FAQ
    │   └── prd.md                 ← Product Requirements Document
    │
    ├── prototype/                 ← Phase 3: Prototyping Output
    │   └── index.html             ← Click-Dummy Prototype
    │
    └── validation/                ← Phase 4: Validation Output
        ├── survey.html            ← Validation Survey
        └── prioritization.md      ← Prioritized Backlog
```

## Creating a Project

When starting a new workshop/project:

```markdown
# PROJECT.md

name: "AnyCompany Insights Platform"
customer: "AnyCompany"
date: "2026-06-21"
status: "active"
team: ["Martha Rivera", "Mateo Jackson"]
focus: "Onboarding, Adoption & Reporting Experience"
```

## Conventions

1. **One folder per project** — Everything that belongs together is stored together
2. **Sub-folders by phase** — signals/, personas/, ideation/, prototype/, validation/
3. **Personas belong to the project** — They are generated for a specific topic
4. **Documents reference each other** — PRD references PRFAQ, PRFAQ references WB-Doc
5. **Status in PROJECT.md** — active / completed / archived
