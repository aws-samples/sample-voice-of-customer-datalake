/**
 * `participants` pack read (docs/participants.md): `list_participant_lists`, a
 * synchronous invoke of the engagement API (`voc-engagement-api`,
 * `GET /participants/lists`) as the caller — every signed-in user may read
 * the lists. Only the list fields reach the model (id, name, kind,
 * description, member count): never a member, an email or who created it.
 *
 * Not a plan read: voc-plan-step holds no ENGAGEMENT_FUNCTION (plan-step/think.ts
 * excludes it), and the pack's writes are card-only.
 */
import { z } from 'zod';
import type { AssistantRunContext, ServerToolDefinition } from '../../types.js';
import type { ToolDeps } from '../deps.js';
import { jsonResult, pick } from '../format.js';
import { parseToolInput, toolSpec } from '../spec.js';
import { PARTICIPANT_LIST_KINDS } from '../client/participant-schemas.js';
import { recordsAt } from './feedback-shape.js';
import { serverTool } from './common.js';

/** The list keys the model may read. */
const LIST_FIELDS = ['list_id', 'name', 'kind', 'description', 'member_count'] as const;
/** The route lists at most `participants_lists.MAX_LISTS` (1000); the result budget holds them lean. */
const LISTS_RESULT_BUDGET = 60_000;
const MAX_LIST_STRING = 300;

const noInput = z.object({}).strict();

/** `GET /participants/lists` as the caller: the list rows (lenient: non-records are dropped). */
export async function readParticipantLists(deps: Pick<ToolDeps, 'invoke'>, ctx: AssistantRunContext): Promise<Record<string, unknown>[]> {
  const body = await deps.invoke({
    fn: 'engagement',
    method: 'GET',
    path: '/participants/lists',
    resource: '/participants/{proxy+}',
    pathParameters: { proxy: 'lists' },
  }, ctx.claims);
  return recordsAt(body, 'lists');
}

export function createParticipantServerTools(deps: ToolDeps): ServerToolDefinition[] {
  return [serverTool('list_participant_lists', 'participants', toolSpec(
    'list_participant_lists',
    `Every participant list (list_id, name, kind ${PARTICIPANT_LIST_KINDS.join('|')}, `
      + 'description, member_count). Read it before add_participants — use the list_id it gives, never guess one — '
      + 'and before create_participant_list, so you do not create a list that already exists.',
    {},
  ), async (input, ctx) => {
    parseToolInput(noInput, input);
    const lists = (await readParticipantLists(deps, ctx)).map((row) => pick(row, LIST_FIELDS, MAX_LIST_STRING));
    return { content: jsonResult({ count: lists.length, lists }, LISTS_RESULT_BUDGET) };
  })];
}
