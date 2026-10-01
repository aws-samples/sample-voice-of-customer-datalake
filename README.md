# AIDLC: Discovery Workshop

> Run the discovery phase of the AI-Driven Development Lifecycle (AIDLC) — from customer signals to a Discovery brief that starts [AI-DLC](https://github.com/awslabs/aidlc-workflows) at Inception — with one skill that installs into Amazon Quick, Kiro, or Claude Code.

## About This Branch (v2)

This branch is **AIDLC: Discovery**, the lightweight, prompt-only edition of the [Voice of the Customer Data Lake](https://github.com/aws-samples/sample-voice-of-customer-datalake/tree/main) platform that lives on `main`. The platform automates this lifecycle as a serverless AWS deployment; this edition runs the same discovery methodology as a single skill inside an AI assistant. The two share the VoC data model and the analysis, persona, PR/FAQ, and PRD prompt lineage.

The repository root is the installable package for all three harnesses at once. No build step is needed:

| Harness | Package format at the repository root | How it is read |
|---------|----------------------------------------|----------------|
| **Amazon Quick** | `plugin.json` (v0.1 fields) + `skills/` + `mcps.json` + `tasks.json` | Plugins → Import folder |
| **Kiro** (IDE and CLI) | `plugin.json` ([Agent Plugins](https://agent-plugins.org/) fields) + `skills/` | Powers panel, or the skill folder alone |
| **Claude Code** | `.claude-plugin/plugin.json` + `skills/` + `agents/` | Plugin marketplace, `--plugin-dir`, or `--plugin-url` |

The Quick folder-import path is pending re-verification on this layout (see [INSTALL](INSTALL.md#amazon-quick)). The single `plugin.json` carries both the Agent Plugins fields and Quick's; the Agent Plugins specification requires clients to ignore fields they do not define. The skill itself follows the [Agent Skills](https://agentskills.io/) standard.

## Start Here

1. [Install the skill](INSTALL.md) in your harness.
2. Give the assistant access to your customer-feedback data (or use the included sample).
3. Start a conversation with: `Start a VoC workshop`.

For an event-ready participant handout, use [Workshop Setup](WORKSHOP-SETUP.md). To understand the lifecycle before installing it, see the [workshop flow reference](architecture/workshop-flow.md).

## What the Workshop Produces

| Phase | Activity | Typical output |
|-------|----------|----------------|
| **1. Signals** | Analyze VoC data and supporting research; map the current product when a codebase exists | Signal Analysis Report |
| **2. Working Backwards** | Generate personas, PR/FAQ, and PRD documents | Product documents |
| **3. Prototype** | Create a clickable HTML prototype | Testable prototype and a draft survey when useful |
| **4. Validate** | Challenge assumptions and prioritize problems | Prioritized problems with open hypotheses |
| **5. Handoff** | Package the outputs for AI-DLC | Discovery brief |

Discovery takes the place of AI-DLC's own Ideation phase. The team then starts AI-DLC 2.10.0 or later in the same repository with `/aidlc workshop` (facilitated) or `/aidlc classic` (on its own), pointing at `discovery/[project]/handoff/discovery-brief.md`. See [Handoff to AI-DLC](architecture/workshop-flow.md#handoff-to-ai-dlc).

Each phase can run independently, but the Conductor maintains context and links artifacts when you run the lifecycle end to end. The canonical behavior is defined in [`skills/aidlc-discovery/SKILL.md`](skills/aidlc-discovery/SKILL.md).

## Recommended Execution Model: One Skill

The **recommended default** is the `aidlc-discovery` skill. Its Workshop Conductor guides one conversation through all five phases and uses the included phase prompts as references. You do not need to create agents to run the full workshop.

```text
User
  |
  v
Workshop Conductor (`aidlc-discovery`)
  |-- Phase 1: Signals
  |-- Phase 2: Working Backwards
  |-- Phase 3: Prototype
  |-- Phase 4: Validate
  `-- Phase 5: Handoff  --> Discovery brief --> AI-DLC Inception
         |
         v
Shared data and project artifacts
```

It reads the included prompts under [`skills/aidlc-discovery/agents/`](skills/aidlc-discovery/agents/) as references and performs the work inline in one conversation. The steps name capabilities (search the corpus, read PDF/DOCX, run Python, write files, preview HTML); the skill maps each one to the tool the current harness provides.

## Optional Advanced Execution Model: Dedicated Agents

Add dedicated phase or specialist agents only when you need independent entry points for individual phases, standalone access to a specialist, different knowledge scopes or permissions per agent, or parallel delegation.

| Harness | Where the agents are | Delegation |
|---------|----------------------|------------|
| **Kiro** | [`.kiro/agents/`](.kiro/agents/) — 11 agents whose `prompt` points at the phase and specialist `AGENT.md` files | Native: the Phase 1 and Phase 2 orchestrators list their specialists as available sub-agents |
| **Claude Code** | [`agents/`](agents/) — the same 11 agents as plugin subagents (`aidlc-discovery:<name>`) | Native: orchestrators delegate with the Agent tool |
| **Amazon Quick** | Create Chat Agents by hand from the same `AGENT.md` files | Manual wiring; see [Workshop Setup](WORKSHOP-SETUP.md#optional-dedicated-phase-and-specialist-agents) |

The topologies cover the same workshop lifecycle and target the same core phase outputs. Dedicated agents change routing, isolation, and delegation; they can also produce separate specialist reports and Phase 1 research hypotheses. The [Phase 1 dedicated-agent architecture](architecture/phase1-signal-analyzer.md) explains the additional outputs and trade-offs.

## Data and Artifact Layout

The skill reads a data folder or, in Amazon Quick, an indexed Space. The default Space name is `voc-data-lake`:

```text
voc-data-lake/
|-- voc-data/          customer feedback
|-- market-research/   market reports
|-- competitive-intel/ competitor information
`-- projects/          generated workshop artifacts
```

Artifacts go to the configured `output_folder` (default `discovery/[project]/` with phase-specific subfolders) **in your working folder**, never inside the installed skill. Copy [`skills/aidlc-discovery/config.default.md`](skills/aidlc-discovery/config.default.md) to `config.md` in your working folder to preconfigure data, research, and output paths.

Supported inputs include JSON, CSV, Excel, PDF, DOCX, and plain text. Sample feedback ships with the skill at [`skills/aidlc-discovery/knowledge-base/voc-data/example-feedback.json`](skills/aidlc-discovery/knowledge-base/voc-data/example-feedback.json).

## Repository Guide

| Path | Purpose |
|------|---------|
| [`INSTALL.md`](INSTALL.md) | Installation and configuration for Amazon Quick, Kiro, and Claude Code |
| [`WORKSHOP-SETUP.md`](WORKSHOP-SETUP.md) | Short participant and facilitator handout |
| [`skills/aidlc-discovery/`](skills/aidlc-discovery/) | The skill: `SKILL.md`, reference prompts, sample data, configuration template |
| [`plugin.json`](plugin.json), [`mcps.json`](mcps.json), [`tasks.json`](tasks.json) | Package manifest for Kiro (Agent Plugins) and Amazon Quick (v0.1) |
| [`.claude-plugin/`](.claude-plugin/) | Claude Code plugin manifest and single-plugin marketplace |
| [`.kiro/agents/`](.kiro/agents/), [`agents/`](agents/) | Optional dedicated agents for Kiro and Claude Code |
| [`architecture/workshop-flow.md`](architecture/workshop-flow.md) | Topology-neutral lifecycle and phase transitions |
| [`architecture/phase1-signal-analyzer.md`](architecture/phase1-signal-analyzer.md) | Optional advanced Phase 1 agent topology |
| [`tests/`](tests/) | Contract tests (`python3 -m unittest discover tests`) and the live end-to-end runner in [`tests/e2e/`](tests/e2e/) |
| [`TESTING.md`](TESTING.md) | How to test locally and in GitHub Actions, and how to read the results |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |

## Verify the Setup

| Check | How |
|-------|-----|
| Skill registration | Quick: `List my skills` shows `aidlc-discovery`. Kiro and Claude Code: `/aidlc-discovery` appears in the slash-command list |
| Trigger | `Start a VoC workshop` enters workshop initialization |
| Data access | `Search my VoC data for delivery complaints` finds accessible data |
| Configuration | Confirm the paths in `config.md`, if you created it |
| Sample run | Use the included sample feedback and generate a Signal Analysis Report |

Agent creation is not part of the default success criteria.

## Implementation Status

- [x] Phase 1: Signals—VoC analysis, supporting research, metrics, and optional dedicated specialist workflows
- [x] Phase 2: Working Backwards—research, personas, prioritization, PR/FAQ, and PRD
- [x] Phase 3: Prototype—HTML prototype, optional in-codebase prototype, and optional draft survey
- [x] Phase 4: Validate—assumption review, problem prioritization, surveys, and results dashboard
- [x] Phase 5: Handoff—required-artifact check, Discovery brief, and AI-DLC start command

### Known limitation

The optional Design Thinking dedicated agent is a placeholder and is not implemented. It is not required by the single-skill Conductor or the four-phase workshop.

See the [changelog](CHANGELOG.md) for release history and resolved audit items.

## Security

See [CONTRIBUTING](https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/CONTRIBUTING.md#security-issue-notifications) on the `main` branch for security issue notifications.

## License

This project is licensed under the MIT-0 License. See [LICENSE](LICENSE).
