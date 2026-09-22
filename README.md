# AIDLC: Discovery Workshop for Amazon Quick

> Run the discovery phase of the AI-Driven Development Lifecycle (AIDLC) — from customer signals to validated product concepts — with one Amazon Quick skill.

## About This Branch (v2)

This branch is **AIDLC: Discovery**, the lightweight, prompt-only edition of the [Voice of the Customer Data Lake](https://github.com/aws-samples/sample-voice-of-customer-datalake/tree/main) platform that lives on `main`. The platform automates this lifecycle as a serverless AWS deployment; this edition runs the same discovery methodology as a single skill inside Amazon Quick, with support for other AI harnesses planned. The two share the VoC data model and the analysis, persona, PR/FAQ, and PRD prompt lineage.

The **recommended default** is the `quick-aidlc-discovery` skill package. Its Workshop Conductor guides one conversation through all four phases and uses the included phase prompts as references. You do not need to create a collection of agents to run the full workshop.

## Start Here

1. [Install the full single-skill package](INSTALL.md#recommended-install-the-full-single-skill-package).
2. Give Amazon Quick access to your customer-feedback data.
3. Start a conversation with: `Start a VoC workshop`.

For an event-ready participant handout, use [Workshop Setup](WORKSHOP-SETUP.md). To understand the lifecycle before installing it, see the [workshop flow reference](architecture/workshop-flow.md).

## What the Workshop Produces

| Phase | Activity | Typical output |
|-------|----------|----------------|
| **1. Signals** | Analyze VoC data and supporting research | Signal Analysis Report |
| **2. Ideation** | Generate research, personas, PR/FAQ, and PRD documents | Product documents |
| **3. Prototyping** | Create a clickable HTML prototype and IDE export | Testable artifacts and a draft survey when useful |
| **4. Validation** | Run surveys, assess hypotheses, and prioritize problems | Validated backlog |

Each phase can run independently, but the Conductor maintains context and links artifacts when you run the lifecycle end to end. The canonical behavior is defined in [`SKILL.md`](SKILL.md).

## Recommended Execution Model: One Skill

The single-skill Conductor is the complete workshop, not a reduced or introductory edition:

```text
User
  |
  v
Workshop Conductor (`quick-aidlc-discovery`)
  |-- Phase 1: Signals
  |-- Phase 2: Ideation
  |-- Phase 3: Prototyping
  `-- Phase 4: Validation
         |
         v
Shared data and project artifacts
```

It reads the included prompts under [`agents/`](agents/) as references and performs the work inline in one conversation. This is the best starting point for workshops, solo use, cross-organization sharing, and most teams because it has the least setup while preserving the full four-phase lifecycle.

You may optionally create one dedicated **AIDLC: Discovery Workshop** Chat Agent with the `quick-aidlc-discovery` skill to get a permanent sidebar entry. That remains the single-skill topology; it does not require phase or specialist agents. See [Optional: add a dedicated Conductor Chat Agent](INSTALL.md#optional-add-a-dedicated-conductor-chat-agent).

## Optional Advanced Execution Model: Dedicated Agents

Add dedicated phase or specialist agents only when you need one of these capabilities:

- independent entry points for individual phases;
- standalone access to a specialist analyst;
- different knowledge scopes or permissions per agent;
- independently testable agent instructions; or
- parallel delegation after the specialist agents are created and wired.

| Topology | What is installed | Recommendation |
|----------|-------------------|----------------|
| **Single-skill Conductor** | One complete `quick-aidlc-discovery` package; optionally attached to one Chat Agent | **Default. Start here.** |
| **Dedicated phase agents** | Four phase agents in addition to the skill | Optional for independent phase entry points |
| **Full specialist topology** | Four phase agents plus the available Phase 1 and Phase 2 specialists | Optional for scoped or parallel delegation |

The topologies cover the same workshop lifecycle and target the same core phase outputs. Dedicated agents change routing, isolation, and delegation; they can also produce separate specialist reports and Phase 1 research hypotheses. Parallel Phase 1 analysis requires the three specialist agents and their orchestration wiring—creating only the four phase agents does not enable it.

Follow [Optional: Dedicated Phase and Specialist Agents](WORKSHOP-SETUP.md#optional-dedicated-phase-and-specialist-agents) for setup. The [Phase 1 dedicated-agent architecture](architecture/phase1-signal-analyzer.md) explains the additional outputs, trade-offs, and conceptual orchestration flow.

## Installation and Distribution

Execution topology and distribution are separate choices. A native Quick Desktop plugin is a way to distribute the package; it is not another way to run the workshop.

| Method | Installs | Best for |
|--------|----------|----------|
| **Repository URL import** | Full single-skill package | Fast setup from an accessible repository |
| **Workshop ZIP** | Full single-skill package and sample data | Events, external participants, and offline sharing |
| **Folder copy** | Full single-skill package | Manual or air-gapped setup |
| **`SKILL.md` upload** | Conductor definition only; nested references are unavailable | Fallback when full-package installation is impossible |
| **Quick Desktop plugin folder** | Full single-skill package | One-step native Quick Desktop installation |

See the [installation guide](INSTALL.md) for exact steps and the [workshop handout](WORKSHOP-SETUP.md) for participant instructions.

### Native Quick Desktop Plugin

Build both forms of the native v0.1 plugin package:

```bash
./build-plugin.sh
# dist/aidlc-discovery/         <- import this folder
# dist/aidlc-discovery.qplugin  <- equivalent portable archive
```

In **Agents & skills → Plugins**, choose **Import folder** and select `dist/aidlc-discovery/`. Do not select the repository root: Quick expects `plugin.json`, `skills/`, `mcps.json`, and `tasks.json` directly under the selected folder.

The generated folder and archive contain the same complete single-skill package. They do not create dedicated agents: current Quick Desktop builds ignore the inferred YAML agent descriptors, so those definitions remain source material until they can be replaced with a schema exported natively by Quick. Folder import is verified while `.qplugin` file preview hangs in the backend, so the folder is the recommended installation artifact.

## Data and Artifact Layout

The skill can read local folders or an indexed QuickSuite Space. The default Space name is `voc-data-lake`:

```text
voc-data-lake/
|-- voc-data/          customer feedback
|-- market-research/   market reports
|-- competitive-intel/ competitor information
`-- projects/          generated workshop artifacts
```

The standard artifact target is `knowledge-base/projects/[project]/` with phase-specific subfolders. Copy [`config.default.md`](config.default.md) to `config.md` to preconfigure local data, research, and output paths.

Supported inputs include JSON, CSV, Excel, PDF, DOCX, and plain text. Sample feedback is available at [`knowledge-base/voc-data/example-feedback.json`](knowledge-base/voc-data/example-feedback.json).

## Repository Guide

| Path | Purpose |
|------|---------|
| [`INSTALL.md`](INSTALL.md) | Canonical installation and configuration guide |
| [`WORKSHOP-SETUP.md`](WORKSHOP-SETUP.md) | Short participant and facilitator handout |
| [`SKILL.md`](SKILL.md) | Complete single-skill Conductor definition |
| [`architecture/workshop-flow.md`](architecture/workshop-flow.md) | Topology-neutral lifecycle and phase transitions |
| [`architecture/phase1-signal-analyzer.md`](architecture/phase1-signal-analyzer.md) | Optional advanced Phase 1 agent topology |
| [`agents/`](agents/) | Phase and specialist agent definitions and reference prompts |
| [`knowledge-base/`](knowledge-base/) | Sample inputs and project artifact structure |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |

The repository root also contains `build-workshop-zip.sh` for participant distribution and `build-plugin.sh` for native Quick Desktop folder/archive packaging.

## Verify the Recommended Setup

After installing the full single-skill package:

| Check | How |
|-------|-----|
| Skill registration | `List my skills` should show `quick-aidlc-discovery` |
| Trigger | `Start a VoC workshop` should enter workshop initialization |
| Data access | `Search my VoC data for delivery complaints` should find accessible data |
| Configuration | Confirm the paths in `config.md`, if you created it |
| Sample run | Use the included sample feedback and generate a Signal Analysis Report |

If you also configured dedicated agents, verify their knowledge access and delegation separately. Agent creation is not part of the default success criteria.

## Implementation Status

- [x] Phase 1: Signals—VoC analysis, supporting research, metrics, and optional dedicated specialist workflows
- [x] Phase 2: Ideation—research, personas, Working Backwards, prioritization, PR/FAQ, and PRD
- [x] Phase 3: Prototyping—HTML prototype, IDE export, and optional draft survey
- [x] Phase 4: Validation—surveys, results dashboard, and problem prioritization

### Known limitation

The optional Design Thinking dedicated agent is a placeholder and is not implemented. It is not required by the single-skill Conductor or the four-phase workshop.

See the [changelog](CHANGELOG.md) for release history and resolved audit items.

## Security

See [CONTRIBUTING](https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/CONTRIBUTING.md#security-issue-notifications) on the `main` branch for security issue notifications.

## License

This project is licensed under the MIT-0 License. See [LICENSE](LICENSE).
