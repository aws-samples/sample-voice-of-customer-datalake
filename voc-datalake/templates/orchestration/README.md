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
                                        # eval cases, assertions, automations, no placeholder, both bundles current
npm run orchestration:compile           # write bundle.json and its Lambda copy (lambda/shared/orchestration_bundle.json)
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

## Releasing

1. Edit, then run `npm run orchestration:compile`, then `npm run orchestration:validate`.
2. Commit the sources and both bundles together.
3. The Lambdas ship the bundle's copy.
4. `GET /workflows/templates` lists the flows. The agents API seeds the automations (once per deployment, disabled).
   The web app imports the flows.
5. An agent that was seeded before keeps its flow. A new template version is offered to it, never applied to it.
