# Retrospective Categories Reference

For the people who read the coach's proposals and the Learn step's lessons: what each kind of finding from a run
is, and where it goes on the platform. The coach writes only the first kind.

## Category: skill_improvement (the coach's)

**Definition**: A role's skill needs a clearer rule, a missing step, a sharper worked example, or a correction of a
rule that misled the agent.

**Indicators**:
- The agent missed a step its task needed, or did one its rules forbid
- A person corrected the agent's work in a comment
- The agent repeated a failing approach before it worked (or never did)
- The skill's wording conflicts with how the repositories it runs on work

**Severity Guidelines**:
- HIGH: The agent failed its task or broke a rule (a red change submitted, a test weakened)
- MEDIUM: The agent succeeded, but slowly or after a correction
- LOW: A polish (usually not worth a new version)

**Action Required**:
1. Cite the section (or step number) of the role's instructions that changes
2. Explain what is missing: a step, a rule, an example, or a clearer word
3. Describe how the run showed the gap (the evidence)
4. Propose the specific change: 1-3 rules or one worked example

Where it goes: the coach's proposal (a new version of the role's skill), which the benchmark gate measures and an
administrator accepts or rejects.

## Category: lesson (the Learn step's)

**Definition**: Something the role should remember about this repository (a convention, a command that works, a
trap), not a change to how the role works everywhere.

Where it goes: a lesson draft an administrator approves; approved lessons reach the role's next tasks as data.

## Category: library gap (a person's)

**Definition**: A kind of task the role meets repeatedly that no skill of the library covers.

**Confidence Guidelines**:
- High: 3+ concrete tasks needed it, with a clear scope
- Review: 2 tasks, or a library skill exists that may cover it with a change
- Uncertain: a single task, or unclear whether it is a skill or a flow change

Where it goes: a note for the people who maintain the skills library (in the run's report), never a proposal.

## Category: platform or flow change (a person's)

**Definition**: A tool the role lacks, a cap or budget that is too tight, a gate that misjudged, a step a flow
should have. The coach never writes about these: a person sets each where it lives.

Where it goes: the run's report, for a person.

## Conflict Resolution Matrix

If two categories apply, choose based on where the fix lives:

| Scenario | Choose | Reason |
|---|---|---|
| The skill misses a step AND the repository has a trap | skill_improvement and a lesson | The step is general; the trap is the repository's |
| The agent lacked a tool AND its skill was unclear | skill_improvement for the wording only | The tool is a person's |
| A new skill is needed AND it overlaps an existing one | library gap, naming the overlap | People decide |

## Promotion Rules (Duplicate Detection)

A rule the current skill already holds is not a new rule: when an agent broke it anyway, sharpen it, move it
earlier, or add a worked example of the exact situation. A lesson that recurs across runs of one repository is a
candidate for the repository's knowledge pack.

## Confidence Tier Examples

### High Confidence
- "Write the failing test before the fix" (the fixer skipped it, and the gate's red-phase check failed)
- "Run the package's whole suite before submit_work" (two runs submitted a change one file's tests passed)

### Review Confidence
- "Read the issue's linked pull request first" (one run, where it would have saved the investigation)

### Uncertain Confidence
- "Prefer the repository's Makefile targets" (inferred from one repository, not observed failing)

## Quality Checklist

Before a finding goes into a proposal or a lesson:
- [ ] Generalised (no person, customer or repository names)
- [ ] Includes "because [reason]" for every constraint
- [ ] Severity matches the evidence (not inflated)
- [ ] Confidence is honest
- [ ] Actionable without the run's context
- [ ] Not already in the role's skill (checked the current instructions)
- [ ] For a skill improvement: the exact section cited
