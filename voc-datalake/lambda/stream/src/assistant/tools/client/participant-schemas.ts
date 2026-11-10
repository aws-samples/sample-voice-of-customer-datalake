/**
 * Argument schemas of the `participants` pack writes (docs/participants.md):
 * `create_participant_list` (→ `POST /participants/lists`) and `add_participants`
 * (→ `POST /participants/lists/{list_id}/members` with `people`). Both are
 * card-only and open to every signed-in user, like the routes.
 *
 * Bounds are the routes' own:
 *   - `maxPeople` = `participants_intake.MAX_PEOPLE_PER_REQUEST` (one request, one card);
 *   - `name` / `company` / `title` = `participants_store.TEXT_LIMITS`, `tags` = `MAX_TAGS` × `MAX_TAG_CHARS`;
 *   - an email is what `ops_alerts.normalize_email` accepts (trimmed, lower-cased, ≤ 254,
 *     `isParticipantEmail`), so an address the route would reject never reaches a card;
 *   - a list is `participants_lists.MAX_LIST_NAME` / `MAX_LIST_DESCRIPTION` / `LIST_KINDS`.
 *
 * The same email twice in `people` is allowed: the card collapses the repeats (first
 * row wins) and says so, and the executor sends each address once.
 *
 * LOCKSTEP: `frontend/src/assistant/approvals/participantSchemas.ts` holds the same
 * limits and argument shape; `participantSchemas.lockstep.test.ts` reads this file
 * and the Python constants and fails when they drift.
 */
import { z } from 'zod';
import { optionalNonEmpty } from './text-schemas.js';

export const PARTICIPANT_LIMITS = {
  maxPeople: 200,
  maxEmailChars: 254,
  maxNameChars: 160,
  maxCompanyChars: 160,
  maxTitleChars: 160,
  maxTags: 20,
  maxTagChars: 40,
  maxListNameChars: 120,
  maxListDescriptionChars: 1000,
} as const;

export const PARTICIPANT_LIST_KINDS = ['employees', 'paid', 'beta', 'sales', 'customers', 'requesters', 'custom'] as const;

const LOCAL_PART = /^[a-z0-9._%+-]{1,64}$/;
const DOMAIN_LABEL = /^[a-z0-9-]{1,63}$/;

/**
 * `ops_alerts._EMAIL` (`[a-z0-9._%+\-]{1,64}@[a-z0-9\-]{1,63}(?:\.[a-z0-9\-]{1,63})+`, full
 * match) on the lower-cased address, written as splits rather than one nested-quantifier regex.
 */
export function isParticipantEmail(value: string): boolean {
  const parts = value.toLowerCase().split('@');
  if (parts.length !== 2) return false;
  const [local = '', domain = ''] = parts;
  const labels = domain.split('.');
  return LOCAL_PART.test(local) && labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
}
/** Participant list ids (`lst_` + 16 hex, `engagement_common.new_id`). */
export const LIST_ID_PATTERN = /^lst_[0-9a-f]{16}$/;

const L = PARTICIPANT_LIMITS;

const participantEmailSchema = z.string().trim().max(L.maxEmailChars)
  .refine(isParticipantEmail, 'must be a valid email address');

const personSchema = z.object({
  email: participantEmailSchema,
  name: optionalNonEmpty(L.maxNameChars),
  company: optionalNonEmpty(L.maxCompanyChars),
  title: optionalNonEmpty(L.maxTitleChars),
  tags: z.array(z.string().trim().min(1).max(L.maxTagChars)).max(L.maxTags).optional(),
}).strict();

export const addParticipantsArgsSchema = z.object({
  list_id: z.string().trim().regex(LIST_ID_PATTERN, 'must be a list_id from list_participant_lists'),
  people: z.array(personSchema).min(1).max(L.maxPeople),
}).strict();

export const createParticipantListArgsSchema = z.object({
  name: z.string().trim().min(1).max(L.maxListNameChars),
  kind: z.enum(PARTICIPANT_LIST_KINDS),
  description: optionalNonEmpty(L.maxListDescriptionChars),
}).strict();
