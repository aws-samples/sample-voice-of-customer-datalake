/**
 * The persona's system prompt for a spoken interview (docs/voice-personas.md → Grounding), and its one tool.
 *
 * - Who it is: the persona's profile, read through the same field helpers as every persona surface
 *   (context/persona-fields.ts), as data (neutralised: page-context.ts), never as instructions.
 * - How it speaks: AWS's voice baseline for Nova Sonic (short answers, one or two sentences, three to five at most),
 *   the voice's grammatical gender (French, Portuguese, Spanish and Italian agree with it: S-15 findings, section 2),
 *   and the language the person speaks, the UI's language when it cannot tell.
 * - What it knows: its evidence pack, the focus groups' `<evidence>` block (assistant/runtime/focus-group-prompts.ts),
 *   in the system prompt so a grounded answer needs no tool round (S-15 findings, risk 5); in speech a citation is
 *   never read aloud, so the persona calls the async `cite` tool instead of writing `[fb:<id>]`.
 * - What it is: a synthetic persona, never a customer, and it says so when asked (TENETS.md tenet 1).
 */
import { evidenceSection } from '../assistant/runtime/focus-group-prompts.js';
import { neutralise } from '../assistant/runtime/page-context.js';
import { bulletList, personaFrustrations, personaGoals, personaNeeds, personaVoice } from '../context/persona-fields.js';
import { MAX_CITED_IDS } from './protocol.js';
import type { SessionInput } from './session-input.js';

/** The one tool: the persona names the reviews it drew on; the relay keeps the ids of its pack only. */
export const CITE_TOOL = 'cite';

/** The languages Nova Sonic speaks of our UI's, by code (protocol.ts VOICE_LANGUAGES). */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: 'English', de: 'German', es: 'Spanish', fr: 'French', pt: 'Portuguese',
};

function identity(input: SessionInput): string[] {
  const { persona } = input;
  const lines = [
    `You are "${neutralise(persona.name)}", a customer persona of the product team's project `
      + `"${neutralise(input.projectName)}". A member of that team is interviewing you out loud, live.`,
  ];
  if (persona.tagline !== undefined && persona.tagline !== '') lines.push(`Your tagline: "${neutralise(persona.tagline)}"`);
  const voice = personaVoice(persona);
  if (voice !== '') lines.push(`How you talk: "${neutralise(voice)}"`);
  const sections: Array<[string, string[]]> = [
    ['Your goals', personaGoals(persona)], ['Your frustrations', personaFrustrations(persona)],
    ['What you need', personaNeeds(persona)],
  ];
  for (const [title, items] of sections) {
    if (items.length > 0) lines.push(`${title}:\n${bulletList(items.map(neutralise))}`);
  }
  return lines;
}

function speaking(input: SessionInput): string[] {
  const fallback = LANGUAGE_NAMES[input.language] ?? 'English';
  return [
    'You are a synthetic persona: an AI built from real customer feedback, not a real customer. If you are asked, '
      + 'say so plainly. Never claim to be a person or to have done anything outside this conversation.',
    'Speak in the first person, as yourself, naturally and honestly. Keep each answer to one or two sentences, three '
      + 'to five at most, and leave room for the next question. Never read out ids, brackets, lists or markup.',
    `Your voice is ${input.voiceGender}: use the grammatical gender that matches it in every language that marks it.`,
    'Always reply in the language the person speaks (you speak English, German, Spanish, French, Italian, Portuguese '
      + `and Hindi). If you cannot tell which one it is, use ${fallback}.`,
  ];
}

function grounding(input: SessionInput): string[] {
  const parts = [evidenceSection(input.evidence)];
  if (input.evidence.length > 0) {
    parts.push(`This is a spoken conversation, so never say a citation or an id aloud. Instead, whenever you draw on `
      + `reviews, call the ${CITE_TOOL} tool with their ids (at most ${MAX_CITED_IDS}) and keep talking: it runs in the `
      + 'background. Never mention the tool.');
  }
  return parts;
}

/** The persona's whole system prompt for this session. */
export function systemPrompt(input: SessionInput): string {
  return [...identity(input), ...speaking(input), ...grounding(input)].join('\n\n');
}

/** The `cite` tool as Nova Sonic's `promptStart` names it (its input schema is a JSON string, as the probe sent). */
export function citeToolSpec(): Record<string, unknown> {
  return {
    toolSpec: {
      name: CITE_TOOL,
      description: 'Record the ids of the reviews from your evidence that your current answer draws on. Silent: '
        + 'never mention it.',
      inputSchema: {
        json: JSON.stringify({
          type: 'object',
          properties: {
            feedback_ids: { type: 'array', items: { type: 'string' }, maxItems: MAX_CITED_IDS },
          },
          required: ['feedback_ids'],
        }),
      },
    },
  };
}

/** The cross-modal turn that asks the persona to say goodbye when the session's time or budget is up. */
export const GOODBYE_TURN = "[The session's time is up. In one short sentence in the person's language, say goodbye.]";
