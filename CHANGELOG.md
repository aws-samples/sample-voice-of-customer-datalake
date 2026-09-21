# Changelog

All notable changes to the AIDLC: Discovery Workshop skill package.

## 1.3.1 — 2026-09-21

Fixes from the first live install on Quick Desktop.

### Added
- `## Overview` section in `SKILL.md` — Quick's skill validator requires it and rejected the save until its assistant injected one; the package now ships it.

### Fixed
- The Conductor also checks `scripts/config.default.md` for the configuration file, where Quick's skill-save tool places it on some install paths.

## 1.3.0 — 2026-09-21

Consistency release.

### Changed
- Trigger patterns now match every advertised phrase ('run workshop', 'aidlc', 'generate personas', 'generate prfaq', 'generate prd', 'create survey', …).
- The Conductor references all 15 reference prompts: added research hypotheses and market-research analysis (Step 2), Working Backwards documents and idea scoring/ROI (Step 3), and the results dashboard (Step 5).
- Phase 3 agent instructions document the IDE export step alongside the HTML prototype, matching `SKILL.md` and the workshop flow.
- Signal Analyzer ranks by Frequency + Severity + Reach (additive), matching the rest of the package; the Prioritize sub-agent's "Generate Ranking" step is now specified.
- README explains the `v2` branch's relation to the full VoC Data Lake platform and adds Security and License sections.

### Removed
- `manifest.json` and `plugin/manifest.json` — read by no tool, test, or Quick itself (skill registration uses the SKILL.md frontmatter; plugin import uses `plugin/plugin.json`). The root copy also shipped inside both packages with a stale build-process note and a conflicting version requirement. Tool requirements live in `SKILL.md` frontmatter and the INSTALL Requirements section.

### Fixed
- Workshop ZIP excludes `tests/`, bytecode, and `.gitkeep` placeholders like the plugin package already did (guarded by a regression test).
- Version metadata is consistent across `SKILL.md` and `plugin/plugin.json`; historical 1.0.0 entry dated and its skill count corrected to 15.

## 1.2.0 — 2026-08-27

Plugin packaging and Quick platform compliance.

### Added
- **Plugin build system** — `build-plugin.sh` + `plugin/` packaging sources. Running `./build-plugin.sh` creates both the native Import-folder layout at `dist/aidlc-discovery/` and the equivalent `dist/aidlc-discovery.qplugin` archive. Agent YAML experiments remain under `plugin/agents/` but are not packaged because Quick ignored that inferred schema.
- **Native Quick Desktop plugin installation** documented as an optional distribution path, separate from execution topology.
- `.gitignore` — ignores `dist/`, `.DS_Store`, editor swap files, user `config.md`.

### Changed
- The native Quick Desktop package is intentionally skill-only and installs the same complete Conductor as full single-skill installation; dedicated agents require a schema exported natively by Quick.
- **SKILL.md restructured for Quick compliance:**
  - Added YAML frontmatter (`name`, `display_name`, `icon`, `version`, `description`, `tools`, `patterns`).
  - Replaced `## Trigger Phrases` with machine-parseable `patterns:` regexes.
  - Replaced `## Tools Used` with `tools:` array in frontmatter.
  - Removed redundant `## Description` section (now in `description:` field).
  - Workflow rewritten from freeform `### Phase N` to canonical structured steps (`### Step N: Title` + Mode/Input/Output/Validate/On-failure markers).
  - Added Step 1 (Initialize Workshop) and Step 6 (Wrap-up) bookend steps.
  - Data Setup now instructs the conductor to read `config.default.md`/`config.md`.
- **`manifest.json` clarified** — root copy slimmed with `_comment` noting it's for build tooling only; authoritative copy moved to `plugin/manifest.json`. (Both removed in 1.3.0.)
- README updated with the native plugin build and import instructions and a "Quick Desktop plugin folder" row in the Installation and Distribution table.

## 1.1.0 — 2026-07-13

Two reconciliation rounds resolving 28 audit items across docs, agents, skills, and packaging.

### Fixed
- Knowledge Base Space name standardized: **`voc-data-lake`** (was 3 different values).
- Validation prioritization: consistently labeled **Frequency + Severity + Reach** (was "Impact × Severity × Reach" in some places).
- Time-to-Market scoring contradiction in the Prioritize sub-agent resolved (table kept as authoritative: 5 = fast = good).
- All 7 broken `prompts/…` reference paths repointed to real `agents/*/skills/` files.
- `manifest.json` `files[]` rebuilt against real on-disk layout (was pointing at 9 non-existent paths).
- Output paths standardized on `knowledge-base/projects/[project]/{signals,personas,ideation,prototype,validation}/` (was 3 conflicting schemes across ~26 files).
- VoC analyst per-item JSON schema aligned with the voc-datalake platform canon (`problem_root_cause_hypothesis`, `direct_customer_quote`, `persona`).
- VoC analyst report heading corrected to "Frequency + Severity + Reach" (was "×").
- German-language skill prompts (`html-prototype.md`, `ide-exporter.md`) translated to English.
- Folder names renamed to hyphenated US spelling (`01 signal-analyser` → `01-signal-analyzer`, etc.).
- SKILL.md / workshop-flow Phase 3 now match the implemented Prototyping agent (HTML prototype + IDE exporter lead; surveys optional; avatars optional).
- Ideation orchestrator fully wired: all 4 sub-agents listed, personas generated before PRFAQ/PRD.
- Working Backwards sub-agent confirmed as owner of `feature-description` + `prfaq-generation` skills.
- Sub-agent report persistence defined — storage sections added to all Phase-1 sub-agent AGENT.md files.
- Market Research Analysis prompt moved from VoC analyst's skill file to its own `sub-market-research-analyst/skills/market-research-analysis.md`.
- `INSTALL.md` output folder default corrected to `knowledge-base/projects/`.
- `architecture/workshop-flow.md` Phase-4 box corrected to "frequency + severity + reach".
- Legacy `knowledge-base/generated-reports/` directory removed.

### Changed
- Results dashboard switched from **Highcharts** (commercial license) to **Chart.js** (MIT).
- ROI analyzer currency **EUR → USD** (package is US-English throughout).
- Sample project fictionalized as **AnyCompany** (SaaS) — replaces an earlier real-customer example with AWS canonical fictitious names, matching the generic sample feedback dataset.
- `survey-builder.md` merged into `survey-generator.md` (now has two output modes: embeddable HTML form + copy-paste to MS/Google Forms).
- Persona-avatar generation documented as optional one-liner ("if `image_generation` available") — no dedicated skill.
- Manifest `author` anonymized to **"John Stiles"** (AWS canonical fictitious name).
- Dual identity clarified: README now documents Mode A (single-skill Conductor) and Mode B (multi-agent workshop) as supported modes with migration path.
- `manifest.json` `requires.tools` expanded to 7 tools (added `file_read`, `file_read_pdf`, `file_read_docx`).

### Added
- Storage sections for all Phase-1 sub-agent reports.
- Upstream provenance notes on 5 skills ported from the voc-datalake platform (with GitHub URLs).
- `knowledge-base/projects/anycompany-insights/signals/` — worked Phase-1 output (`signal-summary.md`, `hypotheses.md`) making the Phase 1→2 chain reproducible.
- **LICENSE** (MIT-0).
- **CHANGELOG.md** (this file).
- "Two Ways to Run This" section in README.

## 1.0.0 — 2026-06-30

Initial release. AIDLC: Discovery Workshop for Amazon Quick: 4 phase orchestrators (Signals, Ideation, Prototyping, Validation), 7 sub-agents, 15 skills, sample knowledge base.
