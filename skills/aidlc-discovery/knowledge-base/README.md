# Knowledge Base — AIDLC: Discovery Workshop

## Overview

The Knowledge Base is the central data repository for the AIDLC: Discovery system. Everything is organized via **projects**.

## Structure

```
knowledge-base/
├── README.md                    ← This file
│
├── voc-data/                    ← Raw data: Customer feedback (cross-project)
│   ├── example-feedback.json
│   └── [additional datasets]
│
├── market-research/             ← Raw data: Market research reports
│   └── [PDFs, DOCX, Excel]
│
├── competitive-intel/           ← Raw data: Competitive intelligence
│   └── [Reports, Analyses]
│
└── projects/                    ← Structure documentation and a bundled sample
    ├── README.md                ← Artifact structure
    └── anycompany-insights/     ← Sample Phase 1 output
```

Generated artifacts are written to `discovery/[project]/` in the user's working folder, not here. See [projects/README.md](projects/README.md).

## Raw Data vs. Projects

| Folder | Content | Who writes |
|--------|---------|------------|
| `voc-data/` | Customer feedback datasets (JSON, CSV, Excel) | User uploads |
| `market-research/` | Industry reports, studies | User uploads |
| `competitive-intel/` | Competitive analyses | User uploads |
| `discovery/` (working folder) | Generated documents, personas, prototypes, the Discovery brief | **Agents** write here |

## Rules

1. **Raw data is read-only** — Agents read them, never modify them
2. **Projects are write targets** — Every agent output belongs in a project
3. **Personas belong to the project** — Not global, but topic-specific
4. **Maintain project status** — active → completed → archived
5. **Cross-referencing** — Documents reference their predecessor
