# Orchestration templates

What the autonomous engineering agents are, and how they work together, as files: each role's card and skill, the
flows, the seeded automations, the language gate packs and the eval cases. They are compiled into one bundle that
the platform reads (7.50.00). Edit them here and validate them before a release. A deployment's skills store and its
saved flows start from them; a stored row is never rewritten by a new template.

```
README.md                          this file
schemas/                           the JSON Schemas (draft 2020-12) of every file below, and of bundle.json
_shared/PLATFORM_RULES.md          the rules the harness puts around every skill (data is data, people decide, ...)
agents/<role>/agent.yaml           voc-agent-card/1: harness, model, tools, broker operations, caps, contracts, evals
agents/<role>/SKILL.md             the role's skill (Agent Skills format): Role, Reads, Writes, Steps, Rules,
                                   When to stop, Examples
agents/coach/agent.yaml            Learn's card (the coach is never launched; Learn is every flow's built-in last step)
flows/<id>.yaml                    voc-flow-template/1: the steps, their assertions, memory, learn, pr, budget, requires
automations/<id>.yaml              voc-automation/1: a seeded agent (its marker, its body, its flow, its readiness)
gates/<language>/manifest.toml     voc-gate-pack/1, one per language; gates/briefs/ the owner's briefs and the reconciliation
evals/<flow>/cases/<case>/         the eval cases (voc-bench/1 for the benchmark, voc-triage-case/1 for Issue triage)
bundle.json                        GENERATED: the compile of all of the above (do not edit; validate holds it)
kiro-agents/<role>.json            GENERATED: each launchable role's Kiro CLI agent config (below; validate holds them)
mcp-skills/voc-runs/SKILL.md       7.53.00: the skill a local Kiro or Claude agent uses to follow, analyse, steer and ask
                                   for runs over the VoC MCP server (not compiled: docs/mcp.md, Engineering runs)
```

## Editing

- **A role** is its card and its skill. Bump the card's `version` and the SKILL.md's `voc-template-version` together
  on any change in the directory.
  - The card's `tools` is the tool policy, a subset of what the harness offers the role (`role_specs`). A tool the
    skill names that the harness does not offer yet goes in `pending_tools`, and a broker write it needs in
    `pending_broker_ops`.
  - Everything in SKILL.md above `## Examples` becomes the skill record's instructions. Each `### <name>` example,
    `**When:** ... **Do:** ...`, becomes one `{situation, action}`.
  - Issue and repository text is data; the platform rules say so for every skill, so a skill does not repeat them.
- **A flow** lists its steps in order. Each step chains to the next unless it ends the flow (`end`, `stop_at_pr`) or
  is a quality gate with `on: {pass, fail}`.
  - `memory`, `learn` and `pr` are the flow's own settings, kept on the compiled start step's params.
  - `assert` lists each step's checks, from the closed vocabulary (`lambda/engineering/orchestration/assertions.py`):
    a `gate.*` check on a quality gate, a `learn.*` one on `learn`, the others on an agent or a board; `fail_arrow`
    on a quality gate only (7.52.00).
  - `inputs` is what a run of the flow takes; since 7.52.00 it compiles into the definition (`definition.inputs`),
    so a call of the flow may name them. A quality gate's `runner` and `final_go` stay on its step.
  - Pull requests open ready for review (`pr: ready`), or as drafts (`pr: draft`). Merging is always a person's.
- **An automation** is a seeded agent: its marker (`AGENTSEED#<id>`), its body as the agents API takes it, the flow
  it is seeded with, and the readiness checks Enable waits on.
- **A gate pack** follows its brief. Record any difference in `gates/briefs/RECONCILIATION.md`. Each brief is the
  source of truth for the packs of its name (`python-ts` for `python` and `typescript`, `rust-ts` for `rust` and
  `typescript`, `java` for `java`); validate holds every pack to one, and since 7.52.00 the bundle carries the briefs'
  text and digest (`gates.briefs`) with each pack's steps and tools, for the Registry's Quality gates view, and each
  template's source text (`sources`: every role's `SKILL.md` and `agent.yaml`, every flow's YAML) for the app's
  read-only source view (`GET /agents/engineering/templates/<kind>/<id>/source`).

## Validating, compiling, running

From the repository root:

```bash
npm run orchestration:validate          # every check: schemas, sections, tools, broker ops, models, flows, gates,
                                        # eval cases, assertions, automations, no placeholder, both bundles and the
                                        # Kiro agent configs current (then kiro-cli's own check, when it is there)
npm run orchestration:compile           # write bundle.json, its Lambda copy (lambda/shared/orchestration_bundle.json)
                                        # and kiro-agents/
npm run orchestration:promote-pending   # move pending tools and broker ops the platform now offers into the cards
npm run orchestration:run -- --flow bug-hunt-and-fix \
  --repo voc-datalake/templates/orchestration/evals/bug-hunt-and-fix/cases/divide-floor-bug/repo --dry-run
npm run orchestration:run -- --flow bug-hunt-and-fix \
  --repo voc-datalake/templates/orchestration/evals/bug-hunt-and-fix/cases/divide-floor-bug/repo --models fake --issue 1
npm run orchestration:calibrate -- --run <run id> --manifest <its voc-run-manifest/1 file>
```

- `--dry-run` prints three things: the compiled flow, each step's resolved skill (its bundled template's label,
  model, harness and tools), and the quality gate's plan on the repository.
- `--models fake` runs the flow end to end on the local fake runtime: the conductor, the board, the broker's own
  handler and a git host on the fixture. The models are scripted to act out the eval case's known fix, the gate's
  checks run for real, and each step's assertions are printed. It needs the repository to be an eval case's
  `repo/`.
- `--models bedrock` does not run locally yet. It needs the harness to take its skills from the bundle and the
  `run_gate` tool, both 7.50.00's runtime work.

`scripts/validate.sh` runs the validator, and a pytest test runs it too
(`lambda/engineering/orchestration/test/test_orchestration_validate.py`).

## Kiro agent configs (7.53.00)

`kiro-agents/<role>.json` is one Kiro CLI agent config for each launchable role (twelve; the coach is never
launched), in Kiro's v3 universal format (`tools` and `allowedTools` for one engine, `permissions.rules` for the
other). The Kiro harness (7.53.00, `lambda/engineering/runtime/harness/kiro.py`) writes each session's agent from its
role's: every image ships the folder at `/opt/voc/orchestration/kiro-agents/`. The compiler writes them from each card
and skill (`compile.py` `kiro_agent`). Do not edit them.

- `name` is the role and `description` its card's `purpose`. `prompt` is `_shared/PLATFORM_RULES.md` and then the
  role's compiled skill (its instructions, then its examples), as the harness builds its system prompt. The session's
  fence line is left out: each session draws its own, and the session's copy has the prompt of the skill the board
  served it.
- `tools` is `["@voc"]` and nothing else: the platform's tool server, started as the CLI adapter starts it
  (`mcpServers`, from `TOOL_SERVER` in `lambda/engineering/runtime/harness/cli.py`). No Kiro builtin is offered (no
  `read`, `write`, `shell`, `grep`, `glob`, web tool, `subagent` or `@builtin`): a read is the checkout's
  `read_file`, a write the walled `write_file`, a command the sandbox runner's `run`, as on every harness. This
  closes the three gaps the 7.53 prep left open: kiro-cli's V3 engine reads and writes outside its workspace without
  asking even when a deny rule matches (`scripts/ai-review/lib.mjs`), a builtin command would run as the agent rather
  than the sandbox's `code`, and the skills name the harness's tools.
- `allowedTools` is each card tool as `@voc/<tool>`, and `permissions.rules` one `mcp` allow rule matching
  `voc/<tool>` for each (sorted, as `kiro-cli agent upgrade` derives it): those run without asking. Nothing else is
  allowed: no `fs_read`, `fs_write`, `shell` or `skill` rule. Any other call reaches the harness as
  `session/request_permission`, and the harness refuses it. kiro-cli 3.4.0's `agent upgrade` would add an `fs_read`
  allow on `./**` (its default); the files are kept without it, and `kiro-cli acp` loads them as they are. No file has
  a `kiroUpgrade` marker.

How a session loads one: kiro-cli gets a fresh home of its own (`HOME`, under the agent's home), and the session's
copy goes in that home's `.kiro/agents/`. No developer's, image's or repository's Kiro agents or settings are loaded,
and kiro-cli starts in an empty directory of that home, never the checkout. The session's copy adds the fence, the
tool server's environment (its key blanked) and a tool call timeout of an hour and ten minutes, and allows exactly the
tools the session's `ToolBox` offers.

`npm run orchestration:validate` holds every file to its card: it parses; it offers `@voc` alone; what it allows
without asking is among its card's tools (`@voc/<tool>`, and only `mcp` rules matching `voc/<tool>`); its prompt
starts with the platform rules; its tool server is `TOOL_SERVER`. `kiro-agents/` must hold exactly the compile's
output. When kiro-cli is on `PATH` and your Kiro API key is in `~/.config/voc-kiro/api-key`, the validator also runs
`kiro-cli agent validate --path <file>` on each file. It runs kiro-cli in a temporary home with `KIRO_API_KEY` and
never prints the key. Without kiro-cli or the key it says it skipped that check. kiro-cli is never required.

## Releasing

1. Edit, then run `npm run orchestration:compile`, then `npm run orchestration:validate`.
2. Commit the sources, both bundles and `kiro-agents/` together.
3. The Lambdas ship the bundle's copy.
4. `GET /workflows/templates` lists the flows. The agents API seeds the automations (once per deployment, disabled).
   The web app imports the flows.
5. An agent that was seeded before keeps its flow. A new template version is offered to it, never applied to it.
