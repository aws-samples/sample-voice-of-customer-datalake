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
  - `assert` lists each step's checks, from the closed vocabulary (`lambda/engineering/orchestration/assertions.py`).
  - Pull requests open ready for review (`pr: ready`), or as drafts (`pr: draft`). Merging is always a person's.
- **An automation** is a seeded agent: its marker (`AGENTSEED#<id>`), its body as the agents API takes it, the flow
  it is seeded with, and the readiness checks Enable waits on.
- **A gate pack** follows its brief. Record any difference in `gates/briefs/RECONCILIATION.md`.

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

## Kiro agent configs (7.53.00 prep)

`kiro-agents/<role>.json` is one Kiro CLI agent config for each launchable role (twelve; the coach is never
launched), in Kiro's v3 universal format: kiro-cli 3.3.0 has two agent engines, one reads `tools` and
`allowedTools`, the other `permissions.rules`, and both halves are here. They are templates: nothing loads them
yet. The Kiro harness, kiro-cli over ACP, comes in 7.53. The compiler writes them from each card and skill
(`compile.py` `kiro_agent`). Do not edit them.

- `name` is the role and `description` its card's `purpose`. `prompt` is `_shared/PLATFORM_RULES.md` and then the
  role's compiled skill (its instructions, then its examples), as the harness builds its system prompt. The session's
  fence line is left out: each session draws its own.
- `tools` are the card's tools, as Kiro's builtins: `read_file` is `read`, `list_files` is `grep` and `glob`,
  `write_file` is `write`, and `run` and `install_dependencies` are `shell`. Every other tool on the card is the
  platform's, `@voc`: the harness's tool server, started as the CLI adapter starts it (`mcpServers`, from
  `TOOL_SERVER` in `lambda/engineering/runtime/harness/cli.py`). There is no `subagent`, no web tool and no
  `@builtin`.
- Some tools run without asking: the read builtins (`allowedTools`, and an `fs_read` allow rule), each platform tool
  on the card (`@voc/<tool>`, and an `mcp` allow rule on `voc/<tool>`), and skills. The rules are exactly what
  `kiro-cli agent upgrade` derives from `allowedTools`, so kiro-cli takes each file as already universal and leaves
  it unchanged. No file has a `kiroUpgrade` marker.
- **A write or a command always asks.** No config allows `fs_write` or `shell`, and none puts `write` or `shell` in
  `allowedTools`. Each such call reaches the orchestrator as `session/request_permission`, and the orchestrator
  answers it. A write or a command is where text from the repository or an issue could become an action, so the
  model never approves its own.

How 7.53 will load one: kiro-cli gets a fresh home of its own (`HOME`), as the CLI adapter's `claude` does, and the
role's config goes in that home's `.kiro/agents/`. No developer's or repository's Kiro agents or settings are loaded.
Checked with kiro-cli 3.3.0: in such a home, `kiro-cli agent list` lists the twelve and Kiro's built-in agents, and
nothing else. The session's fence line and the tool server's environment belong to the session, so the copy in the
session's home adds them.

`npm run orchestration:validate` holds every file to its card: it parses; its tools are among its card's; it has no
`subagent`; it allows no write and no command; its prompt starts with the platform rules; its tool server is
`TOOL_SERVER`. `kiro-agents/` must hold exactly the compile's output. When kiro-cli is on `PATH` and your Kiro API
key is in `~/.config/voc-kiro/api-key`, the validator also runs `kiro-cli agent validate --path <file>` on each file.
It runs kiro-cli in a temporary home with `KIRO_API_KEY` and never prints the key. Without kiro-cli or the key it
says it skipped that check. kiro-cli is never required.

## Releasing

1. Edit, then run `npm run orchestration:compile`, then `npm run orchestration:validate`.
2. Commit the sources, both bundles and `kiro-agents/` together.
3. The Lambdas ship the bundle's copy.
4. `GET /workflows/templates` lists the flows. The agents API seeds the automations (once per deployment, disabled).
   The web app imports the flows.
5. An agent that was seeded before keeps its flow. A new template version is offered to it, never applied to it.
