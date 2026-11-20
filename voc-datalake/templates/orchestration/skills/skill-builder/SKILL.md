---
name: skill-builder
description: "Shows how to write a role's skill so the next agent follows it: the Role, Reads, Writes, Steps, Rules, When to stop shape, worked examples, lean imperative steps, a reason for every rule, weak wording to avoid. Read it when the coach writes a new skill version."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/skill-builder"
license: MIT
adapted: "Rewritten for the coach's one model call: it writes a role's instructions and worked examples (the platform's skill record), not a SKILL.md file with front matter, a references folder or an install step. The create, improve and analyse modes became one way of writing a version; the token-budget and trigger checks became the size and wording rules. The source-format reference is dropped; the architecture principles stay for the Library's readers. Under 4,000 characters; description reworded for Claude 5.5 skill discovery"
---

You write the whole new instructions and the whole list of worked examples of one role's skill. This is what a
version that agents follow looks like.

## The shape of the instructions

Keep the current version's sections, in this order, each a `## ` heading:

1. **Role**: who the agent is in the run and what its task names, in two or three sentences.
2. **Reads**: what it reads, each with the tool that reads it, and which of it is data.
3. **Writes**: each output, with the tool that writes it, and what makes it complete.
4. **Steps**: numbered, imperative, one action each ("Run the whole package's tests with `run`").
5. **Rules**: what it never does and what it always does, each with its reason.
6. **When to stop**: each situation in which it finishes without completing, and what its finish says.

Change only the sections the lesson needs. Keep every rule that still holds, word for word.

## Worked examples

Each example is a situation and an action: **When:** the situation as an agent meets it (generalised: no person,
repository or customer name); **Do:** the action, step by step, naming its tools. An example teaches more than a
rule: when an agent broke a rule its instructions already state, add the example of exactly that situation rather
than restating the rule. Keep the examples that still apply; three to six is a good number.

## Rules for each instruction

- **Imperative and concrete.** "Write the failing test first", not "It is generally advisable to consider testing".
- **A reason for each constraint.** "..., because a test written after the fix cannot prove it."
- **Name only the role's own tools,** in backticks, exactly as the current version names them. Never add a tool,
  never ask for one: the tool policy is a person's.
- **One rule once.** If two sections say the same thing, keep it in the one it belongs to.
- **Order is priority.** What the agent must never do comes before style.
- **Short.** Every sentence must change what the agent does. Under 25 words a sentence.

## Words that make an instruction weak

Cut them: "consider", "try to", "where possible", "ideally", "it's worth noting", "simply", "just", "ensure"
(write "check" or "make sure ... by ..."), "robust", "comprehensive", "various", "in order to". No em dashes, no
emoji, no marketing words.

## Never in a skill

The tools or tool policy, the model, budgets, caps or limits, the AI dial, permissions or credentials, the rule that
people merge, the safety and prompt-injection instructions, the gate's bar. A version that touches one is refused.
The platform's rules come with every skill already: never restate or soften them.

## Before you answer

- [ ] The sections are the current version's, in order
- [ ] The change is the lesson and nothing else
- [ ] Every new rule has its reason; every example is generalised
- [ ] Only the role's own tools are named
- [ ] Nothing from "Never in a skill"
