# Workshop Setup—AIDLC: Discovery

One Workshop Conductor runs Signals, Ideation, Prototyping, and Validation in a single conversation. Participants install the `aidlc-discovery` skill in the AI assistant they already use—Amazon Quick, Kiro, or Claude Code—and do not need to create phase or specialist agents.

For all installation methods and configuration details, see the [installation guide](INSTALL.md).

## Recommended: Single-Skill Setup

Allow a few minutes for installation and a first test.

### Step 1: Obtain the package

Download the branch ZIP supplied by the facilitator (or from `https://github.com/aws-samples/sample-voice-of-customer-datalake/archive/refs/heads/v2.zip`) and unzip it. The folder contains the whole package: `plugin.json`, the `skills/aidlc-discovery/` skill with all reference prompts, templates, sample data, and this documentation.

### Step 2: Install in your assistant

| Assistant | Do this |
|-----------|---------|
| **Amazon Quick** | Agents & skills → Plugins → **Import folder** → select the unzipped folder |
| **Kiro** | Powers panel → Add Custom Power → **Import power from a folder** → select the unzipped folder. Or copy `skills/aidlc-discovery/` into `~/.kiro/skills/` |
| **Claude Code** | `claude --plugin-dir /path/to/unzipped-folder` for the session, or `claude plugin marketplace add aws-samples/sample-voice-of-customer-datalake@v2` then `claude plugin install aidlc-discovery@voc-datalake` |

If none of these is available in Quick, copy the skill folder manually:

```bash
cp -R skills/aidlc-discovery ~/.quickwork/profiles/<profile-id>/skills/aidlc-discovery
```

Find the active profile ID under **Settings → About**, then restart Quick. Uploading only `SKILL.md` is a last-resort fallback: it registers the Conductor but omits the reference prompts and templates that provide the full workshop detail.

### Step 3: Grant data access

- **Quick:** Settings → My computer → Local folders; add the folder containing your VoC data, or use the included sample data. Optionally create a Space named `voc-data-lake` for indexed search.
- **Kiro / Claude Code:** open the folder containing your data as the workspace.

### Step 4: Start the workshop

In any conversation, enter:

```text
Start a VoC workshop
```

The Conductor confirms the scope and guides the group through all four phases. The phases, checkpoints, and artifacts are summarized in the [workshop flow reference](architecture/workshop-flow.md). Generated artifacts land in `knowledge-base/projects/[project]/` inside your working folder.

## Sample Data

Use the included sample for a test run:
[`skills/aidlc-discovery/knowledge-base/voc-data/example-feedback.json`](skills/aidlc-discovery/knowledge-base/voc-data/example-feedback.json)

You can also bring feedback in JSON, CSV, Excel, PDF, DOCX, or plain-text format.

## Optional: Dedicated Conductor Entry (Amazon Quick)

Participants who want a permanent sidebar entry can create one Chat Agent that carries the same skill:

```text
Create an agent called "AIDLC: Discovery Workshop" with the aidlc-discovery skill
```

This does not change the execution model: one Conductor still runs the complete lifecycle. In Kiro and Claude Code the skill is already reachable as `/aidlc-discovery`.

## Optional: Dedicated Phase and Specialist Agents

This advanced topology is not required for the workshop. Add it only when you need independent phase entry points, standalone analysts, separate knowledge scopes, or parallel delegation.

**Kiro and Claude Code** ship the agents ready-made: [`.kiro/agents/`](.kiro/agents/) and [`.claude/agents/`](.claude/agents/) each define the four phase orchestrators and seven specialists, pointing at the instruction files below, with delegation wired for the Phase 1 and Phase 2 orchestrators. See the [installation guide](INSTALL.md#optional-dedicated-phase-and-specialist-agents).

**Amazon Quick** requires creating the agents by hand. Prerequisite: install the full package first.

### Level 1: Four dedicated phase agents

For each one, ask Quick to create an agent and use the linked file as its instructions.

| Agent | Instructions |
|-------|--------------|
| Signal Analyzer | [`agents/01-signal-analyzer/AGENT.md`](skills/aidlc-discovery/agents/01-signal-analyzer/AGENT.md) |
| Ideation Agent | [`agents/02-ideation/AGENT.md`](skills/aidlc-discovery/agents/02-ideation/AGENT.md) |
| Prototyping Agent | [`agents/03-prototype/AGENT.md`](skills/aidlc-discovery/agents/03-prototype/AGENT.md) |
| Validation Agent | [`agents/04-validation/AGENT.md`](skills/aidlc-discovery/agents/04-validation/AGENT.md) |

Creating only these four agents does **not** enable parallel specialist delegation.

### Level 2: Add specialist agents and platform wiring

Create only the specialists required by your use case, assign their data access, obtain their identifiers in your Quick environment, and connect them to the relevant phase orchestrator using the current platform controls.

| Specialist | Instructions | Status |
|------------|--------------|--------|
| VoC Analytics | [`sub-voc-analyst/AGENT.md`](skills/aidlc-discovery/agents/01-signal-analyzer/sub-voc-analyst/AGENT.md) | Implemented |
| Market Research Analyst | [`sub-market-research-analyst/AGENT.md`](skills/aidlc-discovery/agents/01-signal-analyzer/sub-market-research-analyst/AGENT.md) | Implemented |
| Competitive Research Analyst | [`sub-competitive-research-analyst/AGENT.md`](skills/aidlc-discovery/agents/01-signal-analyzer/sub-competitive-research-analyst/AGENT.md) | Implemented |
| Persona Manager | [`sub-persona-manager/AGENT.md`](skills/aidlc-discovery/agents/02-ideation/sub-persona-manager/AGENT.md) | Implemented |
| Working Backwards | [`sub-working-backwards/AGENT.md`](skills/aidlc-discovery/agents/02-ideation/sub-working-backwards/AGENT.md) | Implemented |
| Prioritize | [`sub-prioritize/AGENT.md`](skills/aidlc-discovery/agents/02-ideation/sub-prioritize/AGENT.md) | Implemented |
| Design Thinking | [`sub-design-thinking/AGENT.md`](skills/aidlc-discovery/agents/02-ideation/sub-design-thinking/AGENT.md) | Placeholder—do not rely on it |

Parallel Phase 1 analysis requires the three Phase 1 specialists plus orchestration wiring. The [Phase 1 dedicated-agent architecture](architecture/phase1-signal-analyzer.md) provides the conceptual task flow and pseudocode.

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
- [Canonical Workshop Conductor skill](skills/aidlc-discovery/SKILL.md)
