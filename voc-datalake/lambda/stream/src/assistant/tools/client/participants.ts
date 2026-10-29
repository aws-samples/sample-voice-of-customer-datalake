/**
 * `participants` pack writes (docs/participants.md), open to every signed-in
 * user like the routes, card-only (`CARD_ONLY_WRITE_TOOLS`) and not on
 * `/mcp/global`:
 *   - `create_participant_list` {name, kind, description?} → `POST /participants/lists`;
 *   - `add_participants` {list_id, people: [...]} (≤ 200 rows, e.g. a pasted or
 *     attached list) → `POST /participants/lists/{list_id}/members` with `people`.
 *
 * Bulk entry goes through this card, never a bulk importer (owner rule): the
 * card lists every row; repeats of one address collapse on the card.
 *
 * Prechecks read `GET /participants/lists` as the caller: `add_participants`
 * refuses an unknown list_id, `create_participant_list` a name already used
 * (case-insensitive) — both before any card.
 */
import type { AssistantRunContext, ClientToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import type { JsonSchemaProperties } from '../spec.js';
import { readParticipantLists } from '../server/participants.js';
import { defineClientTool, q, stringProperty } from './define.js';
import {
  PARTICIPANT_LIMITS as L,
  PARTICIPANT_LIST_KINDS,
  addParticipantsArgsSchema,
  createParticipantListArgsSchema,
} from './participant-schemas.js';

/** Lists named in a refusal at most (the model reads list_participant_lists for the rest). */
const MAX_NAMED_LISTS = 20;

interface KnownList { list_id: string; name: string }

async function knownLists(deps: ToolDeps, ctx: AssistantRunContext): Promise<KnownList[]> {
  return (await readParticipantLists(deps, ctx)).flatMap((row) => (
    typeof row.list_id === 'string' && typeof row.name === 'string' ? [{ list_id: row.list_id, name: row.name }] : []
  ));
}

function namedLists(lists: readonly KnownList[]): string {
  if (lists.length === 0) return 'There are no participant lists yet: propose create_participant_list first.';
  const shown = lists.slice(0, MAX_NAMED_LISTS).map((list) => `${q(list.name)} (${list.list_id})`).join(', ');
  return `The lists are: ${shown}${lists.length > MAX_NAMED_LISTS ? ', …' : ''}.`;
}

async function unknownList(deps: ToolDeps, ctx: AssistantRunContext, listId: string): Promise<string | undefined> {
  const lists = await knownLists(deps, ctx);
  return lists.some((list) => list.list_id === listId) ? undefined : `unknown list_id "${listId}". ${namedLists(lists)}`;
}

async function takenName(deps: ToolDeps, ctx: AssistantRunContext, name: string): Promise<string | undefined> {
  const wanted = name.trim().toLowerCase();
  const taken = (await knownLists(deps, ctx)).find((list) => list.name.trim().toLowerCase() === wanted);
  return taken === undefined ? undefined
    : `a list named ${q(taken.name)} already exists (list_id ${taken.list_id}). Add people to it with add_participants instead.`;
}

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

/** The card's line with the list's stored NAME (the approver knows lists by name, not id). */
async function describeAddition(deps: ToolDeps, ctx: AssistantRunContext, listId: string, rows: number): Promise<string> {
  const list = (await knownLists(deps, ctx)).find((entry) => entry.list_id === listId);
  const target = list === undefined ? `participant list ${listId}` : `the participant list ${q(list.name)}`;
  return `Add ${plural(rows, 'person row')} to ${target}.`;
}

const PERSON_PROPERTIES: JsonSchemaProperties = {
  email: stringProperty('The person\u2019s email address exactly as given (required).', L.maxEmailChars),
  name: stringProperty('Full name, when given.', L.maxNameChars),
  company: stringProperty('Company, when given.', L.maxCompanyChars),
  title: stringProperty('Job title, when given.', L.maxTitleChars),
  tags: { type: 'array', items: { type: 'string', maxLength: L.maxTagChars }, maxItems: L.maxTags, description: 'Short labels, when the user gives them.' },
};

export function createParticipantClientTools(deps: ToolDeps): ClientToolDefinition[] {
  return [
    defineClientTool({
      name: 'create_participant_list',
      pack: 'participants',
      description: 'Create a participant list (people the team emails for feedback). kind is one of '
        + `${PARTICIPANT_LIST_KINDS.join(', ')} (custom when none fits). Read list_participant_lists first: never `
        + 'create a list that already exists. Its result returns the new list_id for add_participants.',
      properties: {
        name: stringProperty('List name, e.g. "Beta customers".', L.maxListNameChars),
        kind: { type: 'string', enum: [...PARTICIPANT_LIST_KINDS], description: 'What kind of people the list holds.' },
        description: stringProperty('Optional one-line description.', L.maxListDescriptionChars),
      },
      required: ['name', 'kind'],
      schema: createParticipantListArgsSchema,
      precheck: (args, ctx) => takenName(deps, ctx, args.name),
      summarize: (args) => `Create the participant list ${q(args.name)} (${args.kind}).`,
    }),
    defineClientTool({
      name: 'add_participants',
      pack: 'participants',
      description: `Add people to a participant list by email: up to ${String(L.maxPeople)} rows per call (split `
        + 'larger sets into several calls), e.g. from a list the user pasted or attached. Copy every address and field '
        + 'exactly as given, never invent one, and leave a field out when it is not given. list_id comes from '
        + 'list_participant_lists (or create_participant_list\u2019s result). People already on the list stay; a known '
        + 'address is reused, never duplicated.',
      properties: {
        list_id: stringProperty('The list\u2019s list_id from list_participant_lists.'),
        people: {
          type: 'array', minItems: 1, maxItems: L.maxPeople,
          items: { type: 'object', properties: PERSON_PROPERTIES, required: ['email'], additionalProperties: false },
        },
      },
      required: ['list_id', 'people'],
      schema: addParticipantsArgsSchema,
      precheck: (args, ctx) => unknownList(deps, ctx, args.list_id),
      summarize: (args) => `Add ${plural(args.people.length, 'person row')} to participant list ${args.list_id}.`,
      describe: (args, ctx) => describeAddition(deps, ctx, args.list_id, args.people.length),
    }),
  ];
}
