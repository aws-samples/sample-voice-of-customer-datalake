# Workshop Setup—AIDLC: Discovery

Use the full `quick-aidlc-discovery` skill package for workshops. One Workshop Conductor runs Signals, Ideation, Prototyping, and Validation in a single conversation; participants do not need to create phase or specialist agents.

For all installation methods and configuration details, see the [installation guide](INSTALL.md).

## Recommended: Single-Skill Setup

Allow a few minutes for installation and a first test.

### Step 1: Obtain the full package

Use one of these methods:

- import the repository URL under **Settings → Capabilities → Skills → Create → Import URL**; or
- download and unzip `aidlc-discovery.zip` supplied by the facilitator.

The workshop ZIP contains a `quick-aidlc-discovery/` directory with the Conductor, all nested reference prompts, templates, documentation, and sample data. This handout is included as `quick-aidlc-discovery/WORKSHOP-SETUP.md` so its links resolve inside the archive.

### Step 2: Install `quick-aidlc-discovery/`

Ask Quick to install the skill from the unzipped package directory:

```text
Install the skill from /absolute/path/to/quick-aidlc-discovery
```

If folder installation is unavailable, copy the directory manually from the unpacked archive root:

```bash
cp -R quick-aidlc-discovery ~/.quickwork/profiles/<profile-id>/skills/quick-aidlc-discovery
```

Find the active profile ID under **Settings → About**, then restart Quick after copying. If the destination already exists, remove or rename the previous installation first so the copy does not create a nested directory.

Uploading only `quick-aidlc-discovery/SKILL.md` is a last-resort fallback. It registers the Conductor but omits the reference prompts and templates that provide the full workshop detail.

### Step 3: Grant data access

1. Open **Settings → My computer → Local folders**.
2. Add the folder containing your VoC data, or use the included sample data.
3. Optionally create a QuickSuite Space named `voc-data-lake` for indexed search.

### Step 4: Start the workshop

In any Quick conversation, enter:

```text
Start a VoC workshop
```

The Conductor confirms the scope and guides the group through all four phases. The phases, checkpoints, and artifacts are summarized in the [workshop flow reference](architecture/workshop-flow.md).

## Sample Data

Use the included sample for a test run:

[`knowledge-base/voc-data/example-feedback.json`](knowledge-base/voc-data/example-feedback.json)

You can also bring feedback in JSON, CSV, Excel, PDF, DOCX, or plain-text format.

## Optional: Dedicated Conductor Entry

Participants who want a permanent sidebar entry can create one Chat Agent that carries the same skill:

```text
Create an agent called "AIDLC: Discovery Workshop" with the quick-aidlc-discovery skill
```

This does not change the execution model: one Conductor still runs the complete lifecycle.

## Optional: Dedicated Phase and Specialist Agents

This advanced topology is not required for the workshop. Add it only when you need independent phase entry points, standalone analysts, separate knowledge scopes, independently testable instructions, or parallel delegation.

**Prerequisite:** install the full `quick-aidlc-discovery` package first.

### Level 1: Four dedicated phase agents

Create these agents for independent phase entry points. For each one, ask Quick to create an agent and use the linked file as its instructions.

| Agent | Instructions |
|-------|--------------|
| Signal Analyzer | [`agents/01-signal-analyzer/AGENT.md`](agents/01-signal-analyzer/AGENT.md) |
| Ideation Agent | [`agents/02-ideation/AGENT.md`](agents/02-ideation/AGENT.md) |
| Prototyping Agent | [`agents/03-prototype/AGENT.md`](agents/03-prototype/AGENT.md) |
| Validation Agent | [`agents/04-validation/AGENT.md`](agents/04-validation/AGENT.md) |

Creating only these four agents does **not** enable parallel specialist delegation.

### Level 2: Add specialist agents and platform wiring

The repository supplies the specialist instructions, but portable agent identifiers and orchestration connections cannot be preconfigured in Markdown. Create only the specialists required by your use case, assign their data access, obtain their identifiers in your Quick environment, and connect them to the relevant phase orchestrator using the current platform controls.

| Specialist | Instructions | Status |
|------------|--------------|--------|
| VoC Analytics | [`agents/01-signal-analyzer/sub-voc-analyst/AGENT.md`](agents/01-signal-analyzer/sub-voc-analyst/AGENT.md) | Implemented |
| Market Research Analyst | [`agents/01-signal-analyzer/sub-market-research-analyst/AGENT.md`](agents/01-signal-analyzer/sub-market-research-analyst/AGENT.md) | Implemented |
| Competitive Research Analyst | [`agents/01-signal-analyzer/sub-competitive-research-analyst/AGENT.md`](agents/01-signal-analyzer/sub-competitive-research-analyst/AGENT.md) | Implemented |
| Persona Manager | [`agents/02-ideation/sub-persona-manager/AGENT.md`](agents/02-ideation/sub-persona-manager/AGENT.md) | Implemented |
| Working Backwards | [`agents/02-ideation/sub-working-backwards/AGENT.md`](agents/02-ideation/sub-working-backwards/AGENT.md) | Implemented |
| Prioritize | [`agents/02-ideation/sub-prioritize/AGENT.md`](agents/02-ideation/sub-prioritize/AGENT.md) | Implemented |
| Design Thinking | [`agents/02-ideation/sub-design-thinking/AGENT.md`](agents/02-ideation/sub-design-thinking/AGENT.md) | Placeholder—do not rely on it |

Parallel Phase 1 analysis requires the three Phase 1 specialists plus tested orchestration wiring. The [Phase 1 dedicated-agent architecture](architecture/phase1-signal-analyzer.md) provides the conceptual task flow and pseudocode; it is not a substitute for environment-specific agent configuration.

### Test the advanced topology

Switch to the Signal Analyzer agent and enter:

```text
Analyze the VoC data in my data folder
```

Verify direct data access first. If specialist delegation is configured, also verify that each task returns to the orchestrator and contributes to the consolidated report.

## Topology Comparison

| Choice | Lifecycle coverage | Use when |
|--------|--------------------|----------|
| **Single-skill Conductor** | All four phases in one conversation | **Recommended for workshops and most users** |
| **Four phase agents** | Same core phase outcomes with separate entry points | You need to invoke or test phases independently |
| **Full specialist topology** | Same lifecycle plus separate specialist reports and delegated tasks | You have a concrete isolation or orchestration requirement |

Dedicated agents change routing and operational setup, not the four-phase lifecycle. Start with the single skill and add only the agents that solve a demonstrated need.

## Related Documentation

- [Project overview](README.md)
- [Full installation and configuration guide](INSTALL.md)
- [Workshop phase flow](architecture/workshop-flow.md)
- [Optional Phase 1 dedicated-agent architecture](architecture/phase1-signal-analyzer.md)
- [Canonical Workshop Conductor skill](SKILL.md)
