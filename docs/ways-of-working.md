# Ways of working with AI

Each person has a **way of working with AI** for PR/FAQs and PRDs. An administrator sets it per
user in **Administration → Privacy & access → Users** ("Ways of working with AI"). Every other
document type (research, custom, prototypes, decisions) behaves the same in every mode.

| Mode | What the AI does for a PR/FAQ or PRD |
|---|---|
| **Human-driven** | Answers questions, explains the Working Backwards method and reviews. It never writes the document for the person. |
| **AI-assisted** | Also drafts, suggests and rewrites with the person, in the editor and in the chat. |
| **AI-driven** (default) | Also lets autonomous agents and approved assistant plans write documents for the person. |

The modes are cumulative: each one adds to the one before it. **AI-driven is the default for
everyone, admins included**, so nothing changes on upgrade until an administrator moves someone.
There is no deploy flag.

Inside Human-driven, the administrator can unlock **PR/FAQ with AI** and/or **PRD with AI** for a
person once they have learned. An unlocked type behaves as AI-assisted for that person (editor and
chat). Agents and plans still may not write it, because that needs AI-driven. The unlocks are
kept when the mode changes, so moving someone to AI-assisted and back does not lose them. Nothing
unlocks automatically.

## Writing by hand

Anyone, in every mode, can start a PR/FAQ or PRD from a blank template: in the project's document
wizard, a Human-driven person sees **Start writing** instead of **Generate**. The document is
filed as the next version of its series, exactly like a generated one, with `origin: human` and
the creator's `created_by_sub`. Editing, versions, compare and export work the same.

`POST /projects/{id}/documents` accepts `document_type: 'prfaq' | 'prd'` with `{title, content?,
create_id?}`. Without `content`, the server's blank template is used (English headings).
`create_id` is the client's idempotency key for one click.

## What a Human-driven person sees

- **Document wizard**: a "Human-driven: you write, AI coaches" notice, no "Draft with AI"
  buttons for the brief or the five customer questions, and **Start writing** (only a title is
  required).
- **Document view** (PR/FAQ or PRD they may edit): the same notice with **Coach me** and
  **Review my draft**. Both open the assistant on a new conversation with a coaching or review
  prompt. Nothing is sent until the person presses send.
- **Assistant**: the system prompt tells it to coach. It answers questions (also ones outside the
  document), explains the method, asks a reviewer's questions and reviews the draft with quotes
  and feedback evidence. It never drafts, rewrites or produces paste-ready PR/FAQ or PRD text. If
  asked to write, it declines in one sentence and coaches instead. `generate_document` is not
  offered when neither type is unlocked. `merge_documents` into a locked type and `update_document`
  on a locked PR/FAQ or PRD are refused before any approval card. Asking personas
  (`consult_personas`) stays available, and so do `@persona` / `@all` mentions on a project page:
  the personas only review and comment, so they answer in every way of working, and the
  assistant's own short reply after them still follows this person's way of working
  ([assistant-mentions.md](assistant-mentions.md)).

For anyone who is not AI-driven, the assistant also does not propose a plan with a step that
generates or merges into a PR/FAQ or PRD.

## Enforcement (server side)

The UI only follows the mode. The Projects API enforces it in `lambda/shared/ai_writing.py`
(`require_ai_writing`), and it fails closed. A refusal is a **403** with a coaching message.

| Call kind | Who | Allowed when |
|---|---|---|
| interactive | the person in the SPA, and assistant cards they approve (the SPA runs them with their own token) | AI-assisted, AI-driven, or Human-driven with the type unlocked |
| autonomous | an agent (`agent:` principal), an approved plan step (`voc:principal = plan:…`), an MCP token (`mcp:`) | AI-driven only, for the person it acts as **and** for the project's owner when that is someone else |

Gated routes (PR/FAQ / PRD only):

- `POST /projects/{id}/document` (generate; agent nodes `write_prfaq`, `write_prd` and
  `revise_document` go through it);
- `POST /projects/{id}/decisions/{doc}/pursue` (seeds a PR/FAQ);
- `POST /projects/{id}/documents/merge` with `output_type` `prfaq` / `prd`;
- `POST /projects/{id}/prfaq-autofill` and `POST /projects/{id}/documents/suggest-brief`;
- `PUT /projects/{id}/documents/{doc}` and `.../versions/{v}/restore`, for autonomous callers only:
  a person's own edit is their text and stays allowed in every mode. This covers MCP
  `update_document` and plan `update_document` steps;
- `POST /projects/{id}/documents` with `document_type` `prfaq` / `prd` for autonomous callers
  (a person writing by hand is always allowed).

A refused agent step fails with a plain sentence in the run log. A refused MCP call is audited as
`denied`.

The read fails closed: an unreadable mode row refuses the write (Projects API) or locks AI writing
for the run (assistant). There is no mode row = AI-driven.

## Storage and routes

- Row: aggregates table `USERFLAGS#{sub}` / `ai_mode` `{mode, ai_writing_prfaq, ai_writing_prd,
  updated_at, updated_by}` (`lambda/shared/ai_mode.py`). It sits next to the user flags row
  (`USERFLAGS#{sub}` / `config`, `shared/user_flags.py`), so neither writer overwrites the other.
- `PUT /users/{username}/flags` (admin) also accepts `ai_mode` (`human_driven | ai_assisted |
  ai_driven`), `ai_writing_prfaq` and `ai_writing_prd`; the answer carries `ai_mode`.
- `GET /users` rows carry `ai_mode` `{mode, ai_writing_prfaq, ai_writing_prd}`.
- `GET /users/me/ai-mode` (any signed-in user, `no-store`): the caller's own mode, which the SPA
  uses to shape the editor.
- The assistant (`voc-chat-stream`) reads the caller's row once per run with its existing
  aggregates read access. No IAM changed.

## Limits

- Nobody can stop a person from pasting text written by an AI outside this platform. The mode
  shapes what this platform's AI does; it is a learning aid, not a proof of authorship.
- An `update_document` card the person approves in the chat is checked by the assistant before
  the card is shown. The API cannot tell it from the person typing, because the SPA runs it with
  their own token.
- The blank templates are in English. The person's own text can be in any language.
