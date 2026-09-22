# Installation Guide: AIDLC: Discovery Workshop

The repository root is the installable package for **Amazon Quick**, **Kiro**, and **Claude Code**. Pick your harness below; every path installs the same complete `aidlc-discovery` skill (Conductor, reference prompts, templates, sample data, and configuration template). Dedicated agents are optional additions, not prerequisites.

- Running a workshop now? Follow the section for your harness, then [Post-Install Setup](#post-install-setup).
- Preparing an event? Share the shorter [Workshop Setup handout](WORKSHOP-SETUP.md).
- Evaluating dedicated agents? Read [Optional: Dedicated Phase and Specialist Agents](#optional-dedicated-phase-and-specialist-agents).

## Get the Package

Either of these gives you a folder whose root contains `plugin.json` and `skills/`:

```bash
# Option A: clone the branch
git clone --branch v2 --single-branch https://github.com/aws-samples/sample-voice-of-customer-datalake.git aidlc-discovery

# Option B: download the branch as a ZIP and unzip it
# https://github.com/aws-samples/sample-voice-of-customer-datalake/archive/refs/heads/v2.zip
```

The unzipped folder is named `sample-voice-of-customer-datalake-v2/`. Both forms are ready to import as they are.

## Amazon Quick

**Requirements:** Amazon Quick Desktop 0.1000.3070 or later with the Plugins capability enabled. Built-in tools used: `file_rag_search`, `file_read`, `file_read_pdf`, `file_read_docx`, `run_python`, `file_write`, `open_in_session_tab`; optional `image_generation` for persona avatars.

1. Open **Agents & skills → Plugins** and choose **Import folder**.
2. Select the package folder (the clone or the unzipped ZIP). Quick expects `plugin.json`, `skills/`, `mcps.json`, and `tasks.json` directly under the selected folder, which is what the repository root provides.
3. Confirm that `List my skills` shows `aidlc-discovery`.

Importing the folder provisions the complete single-skill Conductor. It does not create Chat Agents; see [Optional: Dedicated Phase and Specialist Agents](#optional-dedicated-phase-and-specialist-agents).

Fallbacks, in order of preference:

- **Copy the skill folder** into your profile and restart Quick:

  ```bash
  cp -R skills/aidlc-discovery ~/.quickwork/profiles/<profile-id>/skills/aidlc-discovery
  ```

  Find the active profile ID under **Settings → About**. If the destination already exists, remove or rename it first so the copy does not nest.
- **Upload `SKILL.md` only** (Settings → Capabilities → Skills → Create skill → Upload skill file). This is a partial installation: the reference prompts, templates, and sample data are unavailable.

If you previously installed the skill under an older id (`quick-ai-plc` or `quick-aidlc-discovery`), remove that entry so the two do not both trigger.

## Kiro (IDE and CLI)

Kiro reads the same files on both surfaces. Choose one of:

- **As a power (recommended, one click):** Powers panel → **Add Custom Power** → **Import power from GitHub** and enter the repository URL, or **Import power from a folder** and select the package folder. The power exposes the skill and activates on the `plugin.json` keywords (`aidlc`, `discovery workshop`, `voc`, …). Powers are global (`~/.kiro/powers/`) and are usable from Kiro CLI v3 once installed from the IDE.
- **As a skill only:** Agent Steering & Skills panel → **+** → **Import a skill** → GitHub URL `https://github.com/aws-samples/sample-voice-of-customer-datalake/tree/v2/skills/aidlc-discovery`, or a local folder. Kiro's importer needs the skill subfolder, not the repository root. Equivalent manual step:

  ```bash
  cp -R skills/aidlc-discovery ~/.kiro/skills/aidlc-discovery   # every workspace
  cp -R skills/aidlc-discovery .kiro/skills/aidlc-discovery     # this workspace only
  ```

Verify with `/aidlc-discovery` in the slash-command list. Kiro triggers the skill from its `description`; the trigger phrases are listed there.

## Claude Code

```bash
# From the repository (the branch is its own single-plugin marketplace)
claude plugin marketplace add aws-samples/sample-voice-of-customer-datalake@v2
claude plugin install aidlc-discovery@voc-datalake

# Or load the package for one session without installing
claude --plugin-dir /path/to/package-folder
claude --plugin-url https://github.com/aws-samples/sample-voice-of-customer-datalake/archive/refs/heads/v2.zip
```

The skill is available as `/aidlc-discovery:aidlc-discovery` (and as `/aidlc-discovery` while no other command uses that name). The 11 dedicated agents load as `aidlc-discovery:<agent>` subagents; see below. Validate a local checkout with `claude plugin validate .`.

## Post-Install Setup

### 1. Configure data paths

Copy [`skills/aidlc-discovery/config.default.md`](skills/aidlc-discovery/config.default.md) to `config.md` **in your working folder** (the Kiro workspace, the Claude Code project, or the folder you grant to Quick) and set:

- `data_folder`—VoC feedback data such as JSON, CSV, or Excel files;
- `research_folder`—market research such as PDF or DOCX files; and
- `output_folder`—generated artifacts, defaulting to `knowledge-base/projects/`.

Do not edit the copy inside the installed skill: Kiro and Claude Code install skills into caches that are replaced on update. The Conductor can also ask for data interactively, so a configuration file is convenient rather than mandatory.

### 2. Grant data access

- **Quick:** Settings → My computer → Local folders; add the folders containing your feedback and research data. Optionally create a Space named `voc-data-lake` for indexed search (`Create a Space called "voc-data-lake" and upload my feedback files`).
- **Kiro / Claude Code:** open the folder that contains your data (or your project) as the workspace; the assistant reads it with its file tools.

### 3. Start the workshop

```text
Start a VoC workshop—analyze the data in my VoC data folder
```

The Conductor confirms scope and guides the conversation through Signals, Ideation, Prototyping, and Validation. See the [workshop flow reference](architecture/workshop-flow.md) for phase inputs, checkpoints, and outputs.

## Optional: Dedicated Phase and Specialist Agents

Create dedicated agents only when you need independent phase entry points, standalone specialists, separate knowledge scopes, or parallel delegation. All three harnesses use the same 11 `AGENT.md` instruction files under [`skills/aidlc-discovery/agents/`](skills/aidlc-discovery/agents/).

| Harness | Setup |
|---------|-------|
| **Kiro** | [`.kiro/agents/`](.kiro/agents/) ships 11 agent definitions. They load automatically when this repository is opened as a trusted workspace; to use them elsewhere, copy the folder's files into `~/.kiro/agents/` (global) or another workspace's `.kiro/agents/` together with the skill. Each agent's `prompt` is the matching `AGENT.md`; the Phase 1 and Phase 2 orchestrators list their specialists under `toolsSettings.subagent.availableAgents`. |
| **Claude Code** | [`.claude/agents/`](.claude/agents/) ships the same 11 agents. Installed as a plugin they appear as `aidlc-discovery:aidlc-signal-analyzer`, `aidlc-discovery:aidlc-ideation`, and so on; the orchestrators delegate to their specialists with the Agent tool. |
| **Amazon Quick** | Create Chat Agents by hand; see [Workshop Setup](WORKSHOP-SETUP.md#optional-dedicated-phase-and-specialist-agents). Quick's plugin import does not create agents. |

Read the [Phase 1 dedicated-agent architecture](architecture/phase1-signal-analyzer.md) before choosing the additional setup. Both topologies cover the same workshop lifecycle and target the same core phase outputs; dedicated specialists can add separate reports and hypotheses.

## Data Format

The skill accepts text-based feedback in JSON, CSV, Excel, PDF, DOCX, or plain text. JSON works well for structured feedback:

```json
[
  {
    "text": "The delivery was terrible; it took two weeks.",
    "source": "reviews",
    "rating": 2,
    "created_at": "2026-06-01",
    "url": "https://example.com/review/123"
  }
]
```

Sample data ships with the skill at [`skills/aidlc-discovery/knowledge-base/voc-data/example-feedback.json`](skills/aidlc-discovery/knowledge-base/voc-data/example-feedback.json).

## Verify the Installation

1. Confirm the skill is registered (`List my skills` in Quick; `/aidlc-discovery` in Kiro or Claude Code).
2. Say `Start a VoC workshop` and confirm the Conductor begins initialization.
3. Point it to the included sample data or an accessible data folder.
4. Generate a Signal Analysis Report and confirm that the output is saved under the configured project path in your working folder.

Agent creation is not required to pass this verification.

## Related Documentation

- [Project overview and package layout](README.md)
- [Workshop participant and facilitator setup](WORKSHOP-SETUP.md)
- [Workshop phase flow](architecture/workshop-flow.md)
- [Optional Phase 1 dedicated-agent architecture](architecture/phase1-signal-analyzer.md)
- [Canonical Conductor skill](skills/aidlc-discovery/SKILL.md)
