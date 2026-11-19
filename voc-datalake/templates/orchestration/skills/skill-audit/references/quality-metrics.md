# Skill Quality Metrics

Research-backed scoring methodology adapted from hqhq1025/skill-optimizer and supporting papers. For the people who
read the coach's proposals and maintain the skills library: a role's skill on the platform is its instructions and
worked examples, and a library skill reaches an agent through the description listed in its prompt and
`read_skill`.

## 6 Quality Dimensions

### 1. Trigger Rate
How often a library skill is read when it should be.
- **Measurement**: Count tasks where the skill's domain was relevant vs. tasks whose transcript shows a `read_skill`
  of it
- **Target**: > 50% of relevant tasks
- **Improvement**: Sharpen the description with the situations, file types and actions it is for

### 2. People's Acceptance
Whether people accept what an agent following the skill produced.
- **Signals**: Reviewers and maintainers accept the change, don't revert it, don't comment "no, not that"
- **Target**: > 90% acceptance on MUST findings
- **Improvement**: Reduce false positives, improve severity calibration

### 3. Workflow Completion
Whether the skill runs to completion or gets abandoned mid-process.
- **Signals**: All steps executed, self-check passed, finish written
- **Target**: > 85% completion rate
- **Improvement**: Reduce step count, handle edge cases, add early-exit paths

### 4. Static Quality (12 checks)
Structural quality measured by the skill-audit skill's static checks.
- **Target**: no MUST check failed, 3 of 5 SHOULD checks or more
- **Improvement**: Fix MUST issues immediately, SHOULD issues in next sprint

### 5. Undertrigger Rate
How often a skill SHOULD have been read but wasn't.
- **Measurement**: Scan the role's transcripts for the domain's keywords without a `read_skill` of it
- **Target**: < 15% miss rate
- **Improvement**: Add the missing situations to the description, or a step in the role's instructions that names
  the skill

### 6. Token Economics
Context budget efficiency.
- **Measurement**: Tokens consumed per skill read vs. value delivered; the description lines every session of a role
  carries
- **Target**: < 1,500 tokens for a SKILL.md body; a role's listing well under 2,000
- **Improvement**: Extract detail to references, shorten descriptions

## Research Foundation

| Paper | Key Finding | Application |
|---|---|---|
| Memento-Skills: Let Agents Design Agents (arXiv:2603.18743) | A skill router over a growing skill library needs retrieval/routing quality, not just more instructions, or unrouted skills compound risk | Sharpen trigger descriptions |
| MCP Tool Descriptions Are Smelly (arXiv:2602.14878) | 97.1% of analyzed tool descriptions have at least one smell (56% don't state their purpose); augmenting descriptions raises task success by a median of 5.85 points | Write precise one-line descriptions that state purpose and the situations it is for |
| Lost in the Middle (Liu et al., TACL 2024, arXiv:2307.03172) | LLM attention is U-shaped, middle content is used worse than content at the start or end | Put critical rules at the start and end of a skill |
| Does Prompt Formatting Have Any Impact on LLM Performance? (He et al., 2024, arXiv:2411.10541) | GPT-3.5-turbo performance varies by up to 40% across prompt templates on the same task; larger models are more robust | Use tables and checklists, not prose |
| IFEval (Zhou et al., 2023, arXiv:2311.07911) | LLMs struggle to satisfy every constraint in a multi-constraint instruction | One constraint per rule, not compound sentences |

See `references/sources.md` for verification dates and the primary-source check on each figure.

## Description Writing Formula

```
[Action verb] [specific domain] for [file types/contexts].
Covers [2-3 key capabilities].
Use when [specific trigger condition] or [alternative trigger].
```

Good example:
> "Review a change for security, quality, architecture and AI slop, and for whether it built what was asked."

Bad example:
> "Helps with code quality and best practices."

## Scoring Rubric

| Score | Range | Meaning |
|---|---|---|
| A | 11-12 checks pass, < 1,200 tokens | Production-ready |
| B | 9-10 checks pass, < 1,800 tokens | Functional, minor improvements needed |
| C | 7-8 checks pass, < 2,500 tokens | Needs attention |
| D | < 7 checks pass, any MUST failed, or > 2,500 tokens | Rewrite recommended |
