# Phase 1: Signal Analysis—Optional Dedicated-Agent Architecture

> This page documents an advanced dedicated-agent implementation of Phase 1. The [recommended single-skill Conductor](../README.md#recommended-execution-model-one-skill) performs the complete core signal-analysis phase inline and requires much less setup.

Use dedicated agents only when you need standalone analysts, separate knowledge scopes, independent agent testing, separate specialist reports, or parallel delegation. For normal workshops and most individual use, [install the skill](../INSTALL.md) and let the Conductor run Phase 1 in the main conversation.

## Execution Choices

### Recommended: inline through the Conductor

```text
User
  |
  v
Workshop Conductor
  |-- analyze VoC data
  |-- analyze supporting research
  |-- generate metrics
  `-- produce the Signal Analysis Report
```

The Conductor uses the included reference prompts and produces the core Phase 1 report without creating or wiring additional agents.

### Optional: dedicated Signal Analyzer and specialists

```text
                              +----------------------+
                              |   Signal Analyzer    |
                              |    orchestrator      |
                              +----------+-----------+
                                         |
                  +----------------------+----------------------+
                  |                      |                      |
                  v                      v                      v
        +------------------+   +--------------------+   +--------------------+
        |  VoC Analytics   |   |  Market Research   |   | Competitive        |
        |      Agent       |   |      Analyst       |   | Research Analyst   |
        +--------+---------+   +---------+----------+   +----------+---------+
                 |                       |                         |
                 +-----------------------+-------------------------+
                                         |
                                         v
                              +----------------------+
                              | Consolidated Signal  |
                              | Report + Hypotheses  |
                              +----------------------+
```

This topology adds separate specialist reports and explicit Phase 1 research hypotheses. It enables parallel analysis only after all three specialists exist, have access to the correct data, and are wired to the Signal Analyzer.

## Agent Definitions

| Agent | Role | Knowledge access | Instructions |
|-------|------|------------------|--------------|
| Signal Analyzer | Coordinates Phase 1, consolidates reports, generates hypotheses | Reads and writes the `voc-data-lake` knowledge base | [`agents/01-signal-analyzer/AGENT.md`](../skills/aidlc-discovery/agents/01-signal-analyzer/AGENT.md) |
| VoC Analytics | Analyzes feedback, sentiment, themes, urgency, and quotes | VoC data, normally read-only | [`sub-voc-analyst/AGENT.md`](../skills/aidlc-discovery/agents/01-signal-analyzer/sub-voc-analyst/AGENT.md) |
| Market Research Analyst | Extracts trends and product recommendations from research | `market-research/` | [`sub-market-research-analyst/AGENT.md`](../skills/aidlc-discovery/agents/01-signal-analyzer/sub-market-research-analyst/AGENT.md) |
| Competitive Research Analyst | Identifies competitive gaps, threats, and options | `competitive-intel/` | [`sub-competitive-research-analyst/AGENT.md`](../skills/aidlc-discovery/agents/01-signal-analyzer/sub-competitive-research-analyst/AGENT.md) |

### Signal Analyzer responsibilities

1. Confirm workshop context, time period, audience, and focus area.
2. Start only the specialist tasks needed for the available data.
3. Wait for and validate each specialist report.
4. Cross-reference VoC, market, and competitive evidence.
5. Create the consolidated Signal Analysis Report.
6. Generate five to ten testable research hypotheses.
7. Save artifacts under the project `signals/` path.

### Specialist outputs

**VoC Analytics** provides:

- data basis and filters;
- sentiment and category distributions;
- prioritized pain points;
- urgency and trend analysis;
- direct customer quotes; and
- evidence-backed recommendations.

**Market Research** provides:

- market trends and behavior shifts;
- opportunity areas;
- product recommendations;
- timing, market size, and confidence; and
- citations to the analyzed research.

**Competitive Research** provides:

- competitor landscape and gaps;
- threats and time pressure;
- catch-up and differentiation opportunities;
- build, buy, or partner options; and
- evidence for each recommendation.

## Orchestration Flow

```text
User -> Signal Analyzer: "Start signal analysis for [project]"
                           |
                           |-- VoC Analytics task
                           |   Analyze feedback for the agreed period and focus.
                           |
                           |-- Market Research task
                           |   Analyze relevant reports and derive recommendations.
                           |
                           `-- Competitive Research task
                               Analyze competitive evidence and derive options.

Specialist reports -> Signal Analyzer
                           |
                           |-- validate inputs and evidence
                           |-- cross-reference findings
                           |-- prioritize recommendations
                           |-- generate hypotheses
                           `-- persist the consolidated artifacts
```

The orchestrator should omit a specialist task when the corresponding data source is unavailable rather than asking that agent to speculate.

## Knowledge Base Structure

```text
voc-data-lake/            (a Quick Space, or a data folder in Kiro / Claude Code)
|-- voc-data/
|   |-- feedback-2026-q1.json
|   `-- support-tickets/
|-- market-research/
|   `-- [customer-or-market]/
|-- competitive-intel/
|   `-- [industry]/
`-- projects/
    `-- [project]/
        `-- signals/
            |-- signal-summary.md
            |-- voc-analysis.md
            |-- market-research.md
            |-- competitive-intel.md
            `-- hypotheses.md
```

Grant each specialist only the data access it needs. The Signal Analyzer needs read access to the specialist outputs and write access to the project artifact path.

## Conceptual Technical Orchestration

The following pseudocode illustrates the intended delegation after specialist agent identifiers, permissions, and platform connections are configured. Identifiers are environment-specific; this is not a portable wiring script.

```python
start_task(
    objective=(
        "Analyze VoC data for [project]. Period: [period]. "
        "Focus: [topic]. Create a VoC Analysis Report."
    ),
    chat_agent_id="arn:...voc-analytics-agent",
    tools="all",
)

start_task(
    objective=(
        "Analyze the relevant market research for [project]. "
        "Derive evidence-backed product recommendations."
    ),
    chat_agent_id="arn:...market-research-analyst",
    tools="all",
)

start_task(
    objective=(
        "Analyze competitive information for [industry]. "
        "Create evidence-backed product recommendations."
    ),
    chat_agent_id="arn:...competitive-research-analyst",
    tools="all",
)
```

Run tasks in parallel only when the platform, agent wiring, data permissions, and facilitation plan have been tested. Otherwise, sequential execution is easier to diagnose and produces the same target report structure.

## When Dedicated Agents Are Worth the Setup

| Requirement | Stay with one skill | Add dedicated agents |
|-------------|---------------------|----------------------|
| Complete four-phase workshop | Yes | Not required |
| Core Signal Analysis Report | Yes | Yes |
| Separate specialist reports and Phase 1 hypotheses | Not explicit in the default Phase 1 workflow | Yes |
| One continuous conversation | Preferred | Adds routing overhead |
| Independent analyst entry points | Limited | Yes |
| Separate knowledge permissions | Limited | Yes |
| Parallel Phase 1 tasks | No | Yes, with all specialists wired |
| Independent agent-level testing | Not applicable | Yes |
| Fast participant onboarding | Preferred | More setup |

Default to the single skill. Add a dedicated agent only when a requirement in the right-hand column is real and tested.

## Verification

For the advanced topology:

1. Test each specialist directly against its permitted data.
2. Confirm each report includes its data basis and evidence.
3. Test the Signal Analyzer with one specialist before enabling all three.
4. Verify task results return to the orchestrator.
5. Confirm the consolidated report cross-references the specialist findings.
6. Confirm outputs are written to `knowledge-base/projects/[project]/signals/`.

## Related Documentation

- [Project overview and topology comparison](../README.md)
- [Installation guide](../INSTALL.md)
- [Workshop setup, including advanced agents](../WORKSHOP-SETUP.md#optional-dedicated-phase-and-specialist-agents)
- [Topology-neutral workshop flow](workshop-flow.md)
- [Canonical single-skill Conductor](../skills/aidlc-discovery/SKILL.md)
