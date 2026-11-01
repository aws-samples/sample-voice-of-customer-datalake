# Mentions in the project assistant: @persona, @all and #document

On a project page, the AI assistant's composer lets you ask the project's personas directly and point
them at documents:

> @all please review #Proactive Delivery Updates (v1)

Each persona you mention answers as its own card (name and avatar), grounded on the tagged
documents and its own profile. Then the assistant adds a short synthesis.

## Using it

- Type `@` to pick a persona, or `@all` for every persona of the project. Type `#` to pick a document.
  Titles carry their version (`(v2)`), and the newest come first. PR/FAQs, PRDs, research reports and custom
  documents can be tagged. Prototypes are not offered, because their HTML is not text a persona can read.
- The list is keyboard-driven: ArrowDown / ArrowUp move, Enter or Tab picks, and Escape closes the list
  (only the list; the panel stays open). Screen readers hear the active option
  (`aria-activedescendant` on the textbox) and the number of suggestions. On a phone, the `@` and `#`
  buttons under the text open the same lists.
- Picks show as chips under the text. Removing a chip, or deleting the token from the text, drops that
  mention.
- Limits per message: **6 personas** and **3 documents**. `@all` asks the first 6 personas in project
  order. When the project has more, the composer names the 6 it asks, and the assistant tells you
  which were left out.
- Mentions only exist on a project page. Other pages have no list, and the stream refuses mentions
  sent from them.

## What happens

1. The mentions travel **structured**, as ids picked from the project. They are never parsed from the
   message text: `forwardedProps.mentions = { personas?: [ids] | 'all', documents?: [{ document_id, version? }] }`
   in the AG-UI `RunAgentInput`. The schema is `mentionsSchema` in `lambda/stream/src/assistant/contract.ts`,
   mirrored in the SPA and pinned by `contract.lockstep.test.ts`. A request over the limits is a 400.
2. **Persona round** (`lambda/stream/src/assistant/runtime/persona-round.ts`): before the model's own
   turn, the stream Lambda reads the project (`POST /projects/{id}/chat-context`, with the caller's
   project access) and asks each mentioned persona. Each persona is one `consult_personas` call on one
   assistant message, with a tool call id starting with `mention_` and one result each, so the cards appear
   one by one as personas finish. These are the same persona cards the `consult_personas` tool shows.
   - Every persona reads the tagged documents' text (30,000 characters shared between them, like
     `get_documents`) and its own profile, and sees the project's other document titles.
   - Personas answer **independently**, 3 at a time. They do not see each other's answers: that keeps
     reviews unanchored, and 6 personas take two rounds of model calls instead of six.
   - Personas only review and comment. They have no tools and cannot write anything. They use the same
     model as the assistant (the `chat` surface of the model picker).
   - A persona or document deleted since the list was loaded is reported, never fatal. If the project
     cannot be read, there are no persona answers and the assistant says so; the run goes on.
   - Stop works during the round: no further personas are asked, and each remaining call gets a "stopped"
     result.
3. The answers reach the model as a `<mentions>` data block in your message (labelled as data, never
   instructions). The model is asked for a short synthesis (agreements, disagreements, next step), not
   a repeat of the cards. Tagged documents with no persona mentioned are listed for the model to read
   with `get_documents`.

The `consult_personas` tool also takes `document_ids` (up to 3), so the model can ground a
roundtable on documents itself.

## Ways of working

Persona replies are review only, so they are allowed in every way of working
([ways-of-working.md](ways-of-working.md)). A Human-driven person's assistant turn after the round
stays coach-only.

## Saved conversations

The round is part of the conversation the stream Lambda saves while it runs. Each card's speaker
(persona id, name, avatar) is stored in its own result, so the cards come back after a reload.
Saved tool results are cut to 4,000 characters. A persona result is shortened inside its JSON instead, so it
stays valid and the cards survive a reload. Its answers are cut evenly within 32,000 characters (6,000 in the one-turn retry after a 413), and avatar URLs
go first when space is short. The SPA (`sessions/personaResult.ts`) and the stream Lambda
(`session/persona-result.ts`) store it identically, pinned by `personaResult.lockstep.test.ts`.

**Regenerate** on a mention answer asks the same personas again. They are read back from the round's
saved `mention_` calls, so an `@all` comes back as the personas it asked.

## Local development

The dev mock (`npm run dev`) answers a message with mentions on a project page with a scripted persona
round (one card per persona, `@all` = the first 6), followed by the usual mock answer.
