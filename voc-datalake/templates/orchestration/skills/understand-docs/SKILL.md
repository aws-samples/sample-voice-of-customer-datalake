---
name: understand-docs
description: "Writes a repository's understanding docs (Markdown, Mermaid, L100 to L400) from a provenance-tagged model only: C4, deployment, sequence, ER, state and pipeline diagrams, arc42 prose, MADR ADRs; uncited content is dropped. Read it when drafting a knowledge pack's docs."
source: "ai-skill-factory 2.0.0 (Amit Deol), skills/understand-docs"
license: MIT
adapted: "The model is the mapper's notes and the plan the understand-plan skill's Step 5; the output is the understander's draft in the form its task names, not files in a review folder. The per-file sub-agents are dropped (one agent writes the set in waves), open questions go in the finish instead of to a user, and the Mermaid check is the cookbook's static checklist (no mermaid-cli in the sandbox). Slash references name library skills; description and emphasis reworded for Claude 5.5 skill discovery"
---

Write the understanding docs your task asks for, from the model and the plan only.

This is the GENERATE half of a two-skill pair. The `understand-plan` skill extracts the model (on the platform, the
mapper's notes: each claim with its citations) and plans the doc set; this skill writes the docs from them. It
renders diagrams only from the model, never freehand. On the platform the understander writes the draft, in the
output its task names; a person approves it, and the platform publishes approved docs.

## Step 0: Load the plan and the model

- Read the notes and the knowledge pack your task carries: they are the model. The plan is your own, from the
  `understand-plan` skill's Step 5.
- If there is no model (no notes), `finish` saying so. Do not re-survey the repository here; the model is the
  contract.
- If the plan has open questions, write with the gaps marked `UNVERIFIED:` and name the questions in your finish
  for a person; never hold the task for an answer.
- If the repository has a VOICE.md (prose tone, banned words), read it with `read_file`.

## Step 1: Confirm the generation contract

From the plan, build the work list: which docs to write (00-overview to 08-glossary, ADRs, dynamic flows), each
with its level (L100-L400), its diagram types, and the model elements (notes) feeding each diagram. Read
`references/diagram-cookbook.md` (Mermaid syntax per type) and `references/doc-templates.md` (the arc42 structure of
each doc, and MADR).

## Step 2: Write the docs, in waves

Group by level so the ramp is coherent, and write one wave at a time (save your progress with `save_checkpoint`
between waves):

| Wave | Docs | Level | Primary diagrams |
|---|---|---|---|
| A | 00-overview | L100 | `C4Context` |
| B | 01-containers, 04-solution-strategy | L200 | `C4Container`, `mindmap` |
| C | 02-components, 09-dynamic/* | L300 | `C4Component`, `sequenceDiagram`, `flowchart LR`, `stateDiagram-v2` |
| D | 03-deployment, 05-crosscutting | L400 | `C4Deployment`, nested `flowchart TB`, `erDiagram`, `classDiagram` |
| E | 06-adrs/*, 07-risks, 08-glossary, INDEX | mixed | none / tables |

For each doc, take only the slice of the model it needs. Then:
- Render diagrams from model elements only. Every node maps to a cited claim; every edge to a cited relation.
- Write arc42 prose that describes the diagram and adds the "why", never restating structure.
- Apply the anti-duplication ownership table of the `understand-plan` skill's doc-plan reference: put each fact in
  its home doc and link to it elsewhere.
- Cite provenance inline where useful (`src/api.ts:42`, a logical ID) so claims are traceable.

## Step 3: Diagram accuracy rules

Apply `references/diagram-cookbook.md`. Hard rules:
- Quote labels with `(`, `)`, `:`, `#`: `A["S3 (us-east-1)"]`.
- `classDef` colors must be hex, never named colors.
- State direction explicitly (`TB`/`LR`). Subgraph ids differ from node ids.
- Split when over limits: ~25 nodes (flowchart), ~8 participants (sequence), ~8 elements (C4). For C4, set
  `UpdateLayoutConfig` since C4 has no auto-layout.
- Use C4 types for C4 levels (Context/Container/Component/Deployment). Use `sequenceDiagram` for runtime,
  `flowchart`+subgraph for pipelines and VPC nesting, `erDiagram` for data, `stateDiagram-v2` for lifecycles.

## Step 4: Verification pass (anti-hallucination gate)

Go over every doc you wrote:
1. **Provenance check**: extract every Mermaid node id and every factual claim. Each must trace to a note's claim
   and its citations. Anything that does not is removed or marked `UNVERIFIED:` and listed in your finish. Do not
   silently keep unverifiable content.
2. **Mermaid check**: every fenced ```mermaid block parses by the cookbook's checklist (balanced subgraphs, quoted
   special characters, hex classDef, a valid diagram header). There is no mermaid-cli in the sandbox: check
   statically.
3. **Anti-duplication**: no fact restated across docs; cross-doc references are relative links; diagrams not
   re-described in prose.
4. **Link integrity**: every relative link resolves to a doc in the set.
5. **Prose quality**: apply VOICE.md or the repository's writing rules (active voice, sentence cap, banned words),
   and the `technical-writing` skill.

Fix every MUST issue before you finish.

## Step 5: INDEX and finish

- Write the INDEX: a table of every doc (its level, audience, the diagrams it contains, its last-verified date, and
  the extraction tier's caveat from the plan).
- Your finish: the docs written, the diagram count by type, the verification result (verified against
  `UNVERIFIED:` count), the open questions for a person. A reader starts at 00-overview and climbs from L100 to L400.

## Anti-hallucination (non-negotiable)

- A diagram may contain only what the model contains. No invented services, edges, or resources.
- If the model is Tier 2 or 3 (a synthesized template or the source read only), say so in the INDEX and each
  deployment doc: "declared in code / synthesized, deployment not verified against live state".
- Prefer omission over invention. A smaller accurate diagram beats a fuller guessed one.
- Never hard-code the cookbook's example skeletons as if they were the project. They are syntax templates; fill
  them with real model elements.

## Reference files

- `references/diagram-cookbook.md`: copy-ready Mermaid skeletons per type, styling, accuracy checklist,
  cross-renderer rules
- `references/doc-templates.md`: each doc's arc42 prose structure, the MADR ADR template, the INDEX format
