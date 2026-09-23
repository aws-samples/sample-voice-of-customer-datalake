# Workshop Flow Reference

This lifecycle is independent of execution topology. The [recommended single-skill Conductor](../README.md#recommended-execution-model-one-skill) runs all four phases in one conversation; [dedicated phase and specialist agents](../WORKSHOP-SETUP.md#optional-dedicated-phase-and-specialist-agents) are an optional routing model for advanced needs.

## Standard Workshop Sequence

```text
+--------------------------------------------------------------------+
| Phase 1: SIGNALS (1-2 hours)                                       |
|                                                                    |
| - Load and analyze VoC data                                        |
| - Analyze supporting research documents                            |
| - Generate a metrics view                                          |
| - Identify top themes and pain points                              |
|                                                                    |
| Deliverable: Signal Analysis Report                                |
+--------------------------------------------------------------------+
| Phase 2: IDEATION (2-3 hours)                                      |
|                                                                    |
| - Generate synthetic personas                                      |
| - Research top problems                                            |
| - Draft a PR/FAQ using Working Backwards                           |
| - Craft a PRD                                                      |
|                                                                    |
| Deliverables: Research + Personas + PR/FAQ + PRD                   |
+--------------------------------------------------------------------+
| Phase 3: PROTOTYPING (about 1 hour)                                |
|                                                                    |
| - Build a clickable, self-contained HTML prototype                 |
| - Export artifacts for AI coding IDEs                              |
| - Draft a validation survey when useful                           |
|                                                                    |
| Deliverables: HTML prototype + IDE export + optional draft survey  |
+--------------------------------------------------------------------+
| Phase 4: VALIDATION (ongoing)                                      |
|                                                                    |
| - Finalize and distribute surveys                                  |
| - Analyze responses                                                |
| - Prioritize problems by frequency, severity, and reach            |
| - Validate or invalidate hypotheses                                |
|                                                                    |
| Deliverables: Prioritized backlog + validated hypotheses           |
+--------------------------------------------------------------------+
```

The durations are facilitation estimates, not installation times. Each phase can also run independently. A survey can be drafted while prototyping and then finalized, distributed, and analyzed during validation.

## Phase Transitions

### Signals to Ideation

- **Requires:** at least one data source analyzed.
- **Checkpoint:** "Here are the top signals and supporting evidence. Are we ready to ideate?"

### Ideation to Prototyping

- **Requires:** at least personas or a product concept; prototypes work best when a PRD is available.
- **Checkpoint:** "We have the audience and concept defined. Are we ready to prototype?"

### Prototyping to Validation

- **Requires:** at least a prototype, testable hypothesis, or draft survey.
- **Checkpoint:** "The test artifact is ready. Do we want to review it before collecting feedback?"

## Facilitation Principles

- Confirm scope, audience, time period, focus area, and data sources before analysis.
- Let participants skip or revisit phases when the necessary inputs exist.
- Ask before generating long documents.
- Cite source data and direct customer quotes in recommendations.
- Separate observed evidence from hypotheses and assumptions.
- Target `knowledge-base/projects/[project]/` for saved artifacts.
- Summarize outputs and ask for confirmation at every phase transition.
- Offer stakeholder-friendly exports when requested.

## Standard Artifact Targets

```text
knowledge-base/projects/[project]/
|-- signals/
|-- personas/
|-- ideation/
|-- prototype/
`-- validation/
```

Both topologies can use these target paths, allowing a team to add advanced agents later without reorganizing existing workshop artifacts.

## Related Documentation

- [Project overview](../README.md)
- [Install the recommended single-skill package](../INSTALL.md)
- [Workshop participant setup](../WORKSHOP-SETUP.md)
- [Optional Phase 1 dedicated-agent architecture](phase1-signal-analyzer.md)
- [Canonical Workshop Conductor workflow](../skills/aidlc-discovery/SKILL.md#workflow)
