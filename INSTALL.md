# Installation Guide: AIDLC: Discovery Workshop

The **recommended setup** installs the complete `quick-aidlc-discovery` skill package. One Workshop Conductor then runs all four phases in a single conversation. Dedicated phase agents and native plugin packaging are optional additions, not prerequisites.

- Running a workshop now? Start with [Recommended: Install the Full Single-Skill Package](#recommended-install-the-full-single-skill-package).
- Preparing an event? Share the shorter [Workshop Setup handout](WORKSHOP-SETUP.md).
- Evaluating dedicated agents? Read [Optional: Dedicated Phase and Specialist Agents](WORKSHOP-SETUP.md#optional-dedicated-phase-and-specialist-agents).

## Recommended: Install the Full Single-Skill Package

Install the entire `quick-aidlc-discovery/` directory so the Conductor can use its nested reference prompts, templates, sample data, and configuration.

### Option 1: Import from a repository URL

In **Settings → Capabilities → Skills → Create → Import URL**, paste the repository URL when prompted. You can also ask in an Amazon Quick chat:

```text
Install quick-aidlc-discovery from this repository URL: <repository-url>
```

Confirm that Quick registers the `quick-aidlc-discovery` skill and includes the package contents, not only `SKILL.md`.

### Option 2: Install the workshop ZIP

For events or offline sharing, build or obtain `aidlc-discovery.zip`:

```bash
./build-workshop-zip.sh
```

Unzip it, then install the included `quick-aidlc-discovery/` directory. Participant instructions are at [`quick-aidlc-discovery/WORKSHOP-SETUP.md`](WORKSHOP-SETUP.md) inside the archive so all documentation links keep working.

### Option 3: Copy the package folder

From the parent directory of a cloned repository:

```bash
cp -R QuickAIPLC ~/.quickwork/profiles/<profile-id>/skills/quick-aidlc-discovery
```

From the root of an unpacked workshop ZIP:

```bash
cp -R quick-aidlc-discovery ~/.quickwork/profiles/<profile-id>/skills/quick-aidlc-discovery
```

Find the active profile ID under **Settings → About**, then restart Quick after copying. If the destination already exists, remove or rename the previous installation first so the copy does not create a nested directory.

### Fallback: upload `SKILL.md` only

Use **Settings → Capabilities → Skills → Create skill → Upload skill file** only when full-package installation is impossible.

This registers the Conductor, but it is a **partial installation**: nested reference prompts, templates, sample data, and packaged documentation are unavailable. It should not be presented as equivalent to installing the full skill package.

## Post-Install Setup

### 1. Configure data paths

Copy [`config.default.md`](config.default.md) to `config.md` and set:

- `data_folder`—VoC feedback data such as JSON, CSV, or Excel files;
- `research_folder`—market research such as PDF or DOCX files; and
- `output_folder`—generated artifacts, defaulting to `knowledge-base/projects/`.

The Conductor can also ask for data interactively, so a configuration file is convenient rather than mandatory.

### 2. Grant folder access

Under **Settings → My computer → Local folders**, add the folders containing your feedback and research data.

### 3. Optionally create a QuickSuite Space

For indexed semantic search, create a Space named `voc-data-lake` and upload the relevant data:

```text
Create a Space called "voc-data-lake" and upload my feedback files
```

You can also create it under **Content → Spaces → Create**.

### 4. Start the workshop

```text
Start a VoC workshop—analyze the data in my VoC data folder
```

The Conductor confirms scope and guides the conversation through Signals, Ideation, Prototyping, and Validation. See the [workshop flow reference](architecture/workshop-flow.md) for phase inputs, checkpoints, and outputs.

## Optional: Add a Dedicated Conductor Chat Agent

If you want a permanent sidebar entry, attach the installed skill to one Chat Agent:

```text
Create an agent called "AIDLC: Discovery Workshop" with the quick-aidlc-discovery skill
```

This is still the recommended single-skill topology. The Chat Agent is only a dedicated entry point; it does not require phase agents or specialist delegation.

## Optional: Add Dedicated Phase or Specialist Agents

Create dedicated agents only when you need independent phase entry points, standalone specialists, separate knowledge scopes, independent testing, or parallel delegation.

The [advanced setup guide](WORKSHOP-SETUP.md#optional-dedicated-phase-and-specialist-agents) distinguishes:

1. four dedicated phase agents, which provide independent entry points; and
2. the full specialist topology, which adds the relevant Phase 1 and Phase 2 agents and platform-specific orchestration wiring.

Read the [Phase 1 dedicated-agent architecture](architecture/phase1-signal-analyzer.md) before choosing the additional setup. Both topologies cover the same workshop lifecycle and target the same core phase outputs; dedicated specialists can add separate reports and hypotheses.

## Optional: Install as a Native Quick Desktop Plugin

The repository root is packaging source, not an importable plugin folder. Build the native Quick Desktop layout first:

```bash
./build-plugin.sh
# dist/aidlc-discovery/         <- import this folder
# dist/aidlc-discovery.qplugin  <- equivalent portable archive
```

Then open **Agents & skills → Plugins**, choose **Import folder**, and select `dist/aidlc-discovery/`. The selected folder must contain `plugin.json`, `skills/`, `mcps.json`, and `tasks.json` at its root.

The plugin provisions the complete single-skill Conductor. It does not create dedicated agents: current Quick Desktop builds ignore the inferred YAML agent descriptors, so those definitions remain source material until they can be replaced with a schema exported natively by Quick. Folder import is verified while importing the equivalent `.qplugin` file hangs during preview, so use the generated folder.

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

Sample data is available at [`knowledge-base/voc-data/example-feedback.json`](knowledge-base/voc-data/example-feedback.json).

## Requirements

- Amazon Quick Desktop 0.1000.3070 or later, with the Plugins capability enabled
- Built-in tools: `file_rag_search`, `file_read`, `file_read_pdf`, `file_read_docx`, `run_python`, `file_write`, `open_in_session_tab`
- Optional: `image_generation` for persona avatars

## Verify the Installation

1. Ask `List my skills` and confirm `quick-aidlc-discovery` is present.
2. Say `Start a VoC workshop` and confirm the Conductor begins initialization.
3. Point it to the included sample data or an accessible data folder.
4. Generate a Signal Analysis Report and confirm that the output is saved under the configured project path.

Agent creation is not required to pass this verification.

## Related Documentation

- [Project overview and execution-model comparison](README.md)
- [Workshop participant and facilitator setup](WORKSHOP-SETUP.md)
- [Workshop phase flow](architecture/workshop-flow.md)
- [Optional Phase 1 dedicated-agent architecture](architecture/phase1-signal-analyzer.md)
- [Canonical Conductor skill](SKILL.md)
