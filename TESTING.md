# Testing AIDLC: Discovery

Discovery is tested in three tiers. Every tier decides pass or fail with deterministic checks on files. None of them judges the quality of generated prose: the transcripts and the generated workspace are kept so a person can review that.

| Tier | What it proves | Cost | Where it runs |
|------|----------------|------|---------------|
| **1. Contract** | The package loads in all three harnesses, the Handoff contract with AI-DLC is intact, and the end-to-end checks themselves work | Free, about 15 seconds | Every pull request and push to `v2`, and locally |
| **2. Live, automated** | A real harness runs the workshop unattended and writes a valid Discovery brief, Handoff refuses without a PRD, and AI-DLC accepts the brief and uses it in Requirements Analysis | Model usage, capped per session (default USD 25) | Locally, and in GitHub Actions on demand |
| **3. Manual** | The Amazon Quick folder import works, and a facilitator-style run reads well | A person's time | Locally |

Run all three tiers before a release. Run tier 1 on every change.

## Tier 1: Contract tests

```bash
python3 -m unittest discover tests
```

Needs only Python 3.10 or later. `tests/test_documentation_and_packages.py` covers the package shape, documentation links, and the Handoff contract (brief sections, the AI-DLC version and limits, the required artifacts, no opportunity IDs). `tests/test_e2e_checks.py` runs the tier 2 checks against synthetic workspaces, so a broken check fails here, for free. When `claude` or `kiro-cli` is on PATH, their plugin and agent validators run too.

## Tier 2: Live end-to-end run

### What it does

`tests/e2e/run_e2e.py` creates a scratch git repository, copies the bundled sample feedback into `discovery/data/`, writes a `config.md` with `unattended: true`, and runs three legs:

| Leg | What happens | Checks |
|-----|--------------|--------|
| `discovery` | The harness runs all five phases with the prompt in [`tests/e2e/prompts/discovery.md`](tests/e2e/prompts/discovery.md) | D01–D13 |
| `missing-prd` | On a copy of that workspace with the PRD and brief deleted, the harness runs only the Handoff | N01–N02 |
| `aidlc` | `aidlc config` sets up AI-DLC in the workspace, then `/aidlc classic` starts from the brief; the runner answers each gate with [`tests/e2e/prompts/aidlc-answer.md`](tests/e2e/prompts/aidlc-answer.md) until Requirements Analysis writes its output, up to `--aidlc-turns` | A00–A06 |

If the `discovery` leg fails, the other legs are skipped.

### Prerequisites

| Need | Check |
|------|-------|
| Python 3.10 or later and git | `python3 --version`, `git --version` |
| Claude Code, signed in or configured for Amazon Bedrock | `claude -p "say ok"` answers |
| *or* Kiro CLI 2.23 or later, signed in | `kiro-cli chat --no-interactive "say ok"` answers |
| AI-DLC **2.10.0 or later** (only for the `aidlc` leg) | `aidlc --version` |

Install AI-DLC with its checksum-verified installer:

```bash
curl -fsSL -o install.sh https://github.com/awslabs/aidlc-workflows/releases/download/v2.10.0/install.sh
sh install.sh --version 2.10.0 --quiet --yes
```

An older AI-DLC 1.x installer from npm also answers to `aidlc` (`aidlc --version` prints `0.x`, with only `init` and `check` commands). The 2.x installer refuses to install while it comes first on PATH: remove it with `npm uninstall -g` and its package name (find it with `npm ls -g`), or install 2.x to an explicit folder with `AIDLC_BIN_DIR`.

### Run it locally

```bash
# All legs in Claude Code (about 45-90 minutes)
python3 tests/e2e/run_e2e.py

# Only the workshop and the negative test
python3 tests/e2e/run_e2e.py --legs discovery,missing-prd

# Kiro CLI instead of Claude Code
python3 tests/e2e/run_e2e.py --harness kiro

# Re-run only the AI-DLC leg against a finished workspace
python3 tests/e2e/run_e2e.py --legs aidlc --workspace .e2e/<run>/workspace
```

Useful options: `--model`, `--budget-usd` (Claude Code cost cap per session), `--timeout-minutes` (per session), `--isolated` (Claude Code ignores your user settings and plugins, as in CI), and `--out`. Run `python3 tests/e2e/run_e2e.py --help` for all of them. Runs go to `.e2e/`, which git ignores.

Running the checks again without the harness is free:

```bash
python3 tests/e2e/checks.py discovery .e2e/<run>/workspace --project anycompany-e2e --reference E2E-0001
```

### Read the results

Each run folder contains:

| File | Contents |
|------|----------|
| `report.md` | Pass or fail per check, with details, the harness, the model, the AI-DLC version, the commit, the duration, and the cost |
| `report.json` | The same data, for tooling |
| `workspace/` | Everything the harness wrote, including `discovery/anycompany-e2e/` and, after the `aidlc` leg, the AI-DLC record under `aidlc/spaces/` |
| `<leg>.transcript.jsonl` (Claude Code) or `.txt` (Kiro) | The raw session output |

The checks:

| ID | Passes when |
|----|-------------|
| D01 | Every required artifact listed in the Handoff prompt exists, including at least two personas |
| D02–D04 | The brief exists, has the 12 sections in order, and is under 200,000 characters |
| D05 | The brief carries the configured engagement reference |
| D06–D07 | No opportunity ID or email address appears in any artifact (placeholders on reserved domains such as `example.com` are allowed) |
| D08 | Every persona named in the brief is in `aidlc/spaces/default/knowledge/aidlc-product-agent/discovery-personas.md` |
| D09 | `.gitignore` excludes `discovery/data/` |
| D10 | Handoff did not start AI-DLC: nothing under `aidlc/` except that team knowledge |
| D11 | The brief's artifact links resolve |
| D12 | The HTML prototype loads no external scripts |
| D13 | The session printed an `/aidlc workshop` or `/aidlc classic` command with the brief path |
| N01–N02 | Without the PRD, Handoff wrote no brief and named the PRD as missing |
| A00 | AI-DLC 2.10.0 or later is installed |
| A01–A02 | AI-DLC created an intent and recorded the brief as its document input |
| A03–A04 | The intent runs `classic` or `workshop` and AI-DLC did not run its own Ideation |
| A05–A06 | Requirements Analysis wrote output, and that output names a persona from the brief |

When a check fails, open its detail in `report.md`, then the transcript for that leg. A failure in D01–D13 points at the skill prompts; a failure in A01–A06 usually means AI-DLC changed its input contract, so compare against its release notes before changing the brief.

### Run it in GitHub Actions

[`.github/workflows/e2e.yml`](.github/workflows/e2e.yml) runs tier 1 on every pull request and push to `v2`. It runs tier 2 when:

- a pull request from this repository has the **`e2e`** label (add the label to start it; pushes to a labeled pull request run it again),
- a `v2*` tag is pushed, or
- someone dispatches it manually from the Actions tab, choosing the legs and the cost cap. Manual dispatch appears only once the workflow file is on the default branch.

Pull requests from forks never run tier 2, because they get no secrets.

The live job pins Claude Code and AI-DLC versions in the workflow's `env`, signs in to Amazon Bedrock through GitHub OIDC, and uploads the whole run folder as the `e2e-<run id>` artifact for 14 days. The report also appears in the job summary.

One-time setup by a repository administrator:

1. Create an IAM role that trusts this repository through GitHub's OIDC provider (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`, subject limited to `repo:aws-samples/sample-voice-of-customer-datalake:environment:e2e`), allowed `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the Claude models used.
2. In the repository settings, create an environment named `e2e` with the secret `AWS_E2E_ROLE_ARN` set to that role, and optionally the variables `AWS_REGION` (default `us-east-1`) and `E2E_MODEL`. Add required reviewers to the environment if every paid run should be approved.
3. Create the `e2e` label.

## Tier 3: Manual checks

### Amazon Quick import

Quick is a desktop app, so this check is manual. Use Amazon Quick Desktop 0.1000.3070 or later with Plugins enabled.

1. Check out the branch or tag under test, and note the commit (`git rev-parse --short HEAD`).
2. In Quick, open **Agents & skills → Plugins → Import folder** and select the repository root.
3. Ask `List my skills` and confirm `aidlc-discovery` appears.
4. Grant Quick a working folder, copy `skills/aidlc-discovery/knowledge-base/voc-data/example-feedback.json` into `discovery/data/` inside it, and say `Start a VoC workshop`.
5. Run through the five phases. At Handoff, confirm the brief is written under `discovery/<project>/handoff/` and that the Conductor explains that Quick does not run AI-DLC.
6. Optional: run the tier 2 checks on that folder with `python3 tests/e2e/checks.py discovery <folder> --project <project> --reference Self-serve`.

Post the result on the pull request or release with this template:

```markdown
**Quick import check**: pass | fail
- Commit:
- Quick Desktop version:
- Import: accepted | rejected (error message)
- `List my skills` shows aidlc-discovery: yes | no
- Workshop reached Handoff and wrote the brief: yes | no
- Notes:
```

If the import rejects the folder, try the fallbacks in [INSTALL](INSTALL.md#amazon-quick) and record which one worked.

### Facilitator review

Once per release, a practitioner reads the brief from a tier 2 run (the `e2e-<run id>` artifact) and the first AI-DLC questions, and answers: would a product engineering team recognize its problem in this brief, and are the AI-DLC questions about the right product? Record the answer with the Quick check.

## Release checklist

1. Tier 1 passes.
2. Tier 2 passes in GitHub Actions for the release commit, on the pinned AI-DLC version.
3. The Quick import check and the facilitator review are recorded.
4. If AI-DLC released a new version, run tier 2 with it locally; when it passes, raise `AIDLC_VERSION` in the workflow and the supported version in [`discovery-brief.md`](skills/aidlc-discovery/agents/05-handoff/skills/discovery-brief.md).
