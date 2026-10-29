# Persona generation: add or replace

`POST /projects/{id}/personas/generate` starts a background job (the persona-generator Lambda) that writes
personas from the feedback in scope. Since #353 a run either **adds** personas next to the project's current
ones or **replaces** them. Both modes stay explicit, because guessing wrong would destroy personas someone
reviewed.

## The request field

| `keep_existing_personas` | Mode | What happens to the current personas |
|---|---|---|
| absent / `false` (API default, unchanged) | replace | Deleted, with their avatar objects, just before the new set is saved, so a re-run never piles up duplicates (`_clear_existing_personas`). |
| `true` | add | Kept untouched, including any edits and avatars. The new personas are saved beside them. |

Any other value is a 400 (`keep_existing_personas must be true or false, got str`). `persona_count` on the
project is recounted from its rows after every save, so it is right in both modes.

## Who sends what

- **Project page wizard** (Generate Personas). A project that already has personas gets a choice on the
  final step: **Add to existing personas** (selected by default) or **Replace existing personas**. A project
  with no personas sees no choice. If Replace is chosen, the confirmation becomes a danger dialog that counts
  the personas it deletes ("Delete and generate").
- **AI assistant** (`generate_personas` tool). The tool takes an optional `keep_existing_personas`, which
  defaults to adding. The model is told to send `false` only when the user explicitly asked to replace. The
  approval card states the mode: "Adds to the N personas the project has" or, in danger colours, "Deletes
  the project's N existing personas". An approved plan step builds the same request (`write-requests-project.ts`).
- **Autonomous agents** always add (`lambda/agents/nodes/generate_personas.py`), see
  [autonomous agents](autonomous-agents.md).
- **API and scripts**: unchanged. Without the field a run replaces.

## How additive runs avoid repeating the kept personas

The model gets two blocks of quoted data (any DATA-block tag defanged), on the plan step and on every
per-persona call:

1. **Names already used** (every mode, #240). The newest 30 names, each cut to 60 characters, which the
   model must not reuse.
2. **Personas this project keeps** (add mode only, `lambda/shared/persona_overlap.py`). A short
   projection of each kept persona: name, tagline, occupation, primary goal and the first two pain points,
   each field cut to 100 characters (names 60). It comes with an instruction to write clearly distinct
   archetypes: a different role, primary goal and main pain point.

**Prompt growth is bounded.** At most the newest 20 kept personas are projected, and the JSON list is held
under 1,500 characters by dropping the oldest first. Extending a project many times cannot grow the prompt
without limit.

**Overlap check after generation.** The instruction is only advice, so one rule is enforced in code. A new
persona whose name matches a kept persona, or an earlier new one, is **dropped** before its avatar is made.
The match ignores case and runs of whitespace. The persona is not renamed, because a suffixed "Ada Moreno 2"
would still read as the same person in `@all` roundtables. The check compares against **every** kept name,
not just the projected 20. The job's result reports the count as `metadata.duplicate_names_dropped`, 0 in
replace mode. If the kept personas cannot be read, the run still adds and never deletes; it just has
nothing to compare against.

## Avatars and the roundtable

Adding personas never touches the kept personas' rows or avatars. Avatars are made only for the new
personas that survive the name check. `@all` in the project assistant asks the first 6 personas in project
order ([assistant mentions](assistant-mentions.md)), so a larger set does not make a round more expensive.
Because names never repeat, no persona answers twice.
