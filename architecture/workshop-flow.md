# Workshop Flow Reference

This lifecycle is independent of execution topology. The [recommended single-skill Conductor](../README.md#recommended-execution-model-one-skill) runs all five phases in one conversation; [dedicated phase and specialist agents](../WORKSHOP-SETUP.md#optional-dedicated-phase-and-specialist-agents) are an optional routing model for advanced needs.

## Standard Workshop Sequence

Discovery takes the place of AI-DLC's own Ideation phase. It runs in the
product engineering team's own repository and ends with a Discovery brief that
starts the AI-DLC workflow at Inception.

```text
+--------------------------------------------------------------------+
| Pre-work (the day before, about 1 hour)                            |
|                                                                    |
| - Load the team's own customer feedback into discovery/data/       |
| - Map the current product from its codebase, when one exists       |
+--------------------------------------------------------------------+
| Phase 1: SIGNALS (1-2 hours)                                       |
|                                                                    |
| - Load and analyze VoC data                                        |
| - Analyze supporting research documents                            |
| - Generate a metrics view and research hypotheses                  |
| - Identify top themes and pain points                              |
|                                                                    |
| Deliverables: Signal Analysis Report (+ current-product map)       |
+--------------------------------------------------------------------+
| Phase 2: WORKING BACKWARDS (2-3 hours)                             |
|                                                                    |
| - Generate synthetic personas                                      |
| - Research top problems and score ideas                            |
| - Draft a PR/FAQ, then craft a PRD                                 |
|                                                                    |
| Deliverables: Personas + PR/FAQ + PRD                              |
+--------------------------------------------------------------------+
| Phase 3: PROTOTYPE (about 1 hour)                                  |
|                                                                    |
| - Build a clickable, self-contained HTML prototype                 |
| - Optionally, a disposable in-codebase prototype on a branch       |
| - Draft a validation survey when useful                            |
|                                                                    |
| Deliverables: HTML prototype (+ optional draft survey)             |
+--------------------------------------------------------------------+
| Phase 4: VALIDATE (about 1 hour on the day)                        |
|                                                                    |
| - Challenge assumptions against the evidence                       |
| - Prioritize problems by frequency, severity, and reach            |
| - Keep unconfirmed hypotheses open; never wait for surveys         |
|                                                                    |
| Deliverables: Prioritized problems + open hypotheses               |
+--------------------------------------------------------------------+
| Phase 5: HANDOFF (about 30 minutes)                                |
|                                                                    |
| - Check that every required artifact exists                        |
| - Write the Discovery brief and AI-DLC team knowledge              |
| - Print the AI-DLC start command                                   |
|                                                                    |
| Deliverable: discovery/[project]/handoff/discovery-brief.md        |
+--------------------------------------------------------------------+
```

The durations are facilitation estimates, not installation times. Each phase
can also run independently. Surveys drafted during Prototype can be
distributed after the engagement; their results never block the Handoff.

## Phase Transitions

### Signals to Working Backwards

- **Requires:** at least one data source analyzed.
- **Checkpoint:** "Here are the top signals and supporting evidence. Are we ready to work backwards from the customer?"

### Working Backwards to Prototype

- **Requires:** at least personas or a product concept; prototypes work best when a PRD is available.
- **Checkpoint:** "We have the audience and concept defined. Are we ready to prototype?"

### Prototype to Validate

- **Requires:** at least a prototype, testable hypothesis, or draft survey.
- **Checkpoint:** "The test artifact is ready. Shall we challenge it against the evidence?"

### Validate to Handoff

- **Requires:** every required artifact: Signal Analysis Report, at least two personas, PR/FAQ, PRD, HTML prototype, and prioritized problems with open hypotheses (plus the current-product map when a codebase exists).
- **Checkpoint:** "Everything AI-DLC needs is ready. Shall I write the Discovery brief?"

## Handoff to AI-DLC

The Discovery brief is the only input the next motion needs. The team starts
[AI-DLC](https://github.com/awslabs/aidlc-workflows) 2.10.0 or later in the
same repository, in a profile that skips AI-DLC's Ideation phase:

| Next motion | AI-DLC profile |
|-------------|----------------|
| Facilitated AI-DLC workshop | `/aidlc workshop` |
| Team continues on its own | `/aidlc classic` |

AI-DLC Requirements Analysis reads the brief as its primary input, and the
personas Handoff writes to `aidlc/knowledge/aidlc-product-agent/` load into
AI-DLC's product agent automatically.

## Facilitation Principles

- Confirm scope, audience, time period, focus area, and data sources before analysis.
- Let participants skip or revisit phases when the necessary inputs exist.
- Ask before generating long documents.
- Cite source data and direct customer quotes in recommendations.
- Separate observed evidence from hypotheses and assumptions.
- Target `discovery/[project]/` for saved artifacts.
- Summarize outputs and ask for confirmation at every phase transition.
- Offer stakeholder-friendly exports when requested.

## Standard Artifact Targets

```text
discovery/
|-- data/                (raw feedback, kept out of git)
`-- [project]/
    |-- signals/
    |-- working-backwards/
    |-- prototype/
    |-- validate/
    `-- handoff/
```

Both topologies can use these target paths, allowing a team to add advanced agents later without reorganizing existing workshop artifacts.

## Related Documentation

- [Project overview](../README.md)
- [Install the recommended single-skill package](../INSTALL.md)
- [Workshop participant setup](../WORKSHOP-SETUP.md)
- [Optional Phase 1 dedicated-agent architecture](phase1-signal-analyzer.md)
- [Canonical Workshop Conductor workflow](../skills/aidlc-discovery/SKILL.md#workflow)
