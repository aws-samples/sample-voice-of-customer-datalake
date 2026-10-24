/**
 * @fileoverview REST executors for the memory write tools (`/memory/*`,
 * `memory_handler.py`). The memory Lambda applies the rules — a company add or
 * edit by someone who is neither an admin nor a memory reviewer is stored as
 * `proposed`; forget / merge / resolve of company memories need an admin or
 * reviewer; personal memories are the owner's — so the summaries report the
 * status the API answered rather than assuming the write went live.
 *
 * @module assistant/approvals/memoryExecutors
 */
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { fetchApi } from '../../api/client'
import { invalidateKeys, keysFor } from './invalidation'
import { isRecord } from './previews/format'
import type { WriteToolExecutionContext } from '../types'
import type {
  ConfirmMemoryArgs, ForgetMemoryArgs, MergeMemoriesArgs, RememberArgs, ResolveMemoryConflictArgs, UpdateCompanyMemoryArgs,
} from './memorySchemas'

const post = (body?: unknown): RequestInit => ({ method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const item = (id: string, action = '') => `/memory/${encodeURIComponent(id)}${action}`

/** `{memory: {memory_id, status}}` or the bare item → what the summary names. */
function answered(raw: unknown): { id?: string; status?: string } {
  const body = isRecord(raw) && isRecord(raw.memory) ? raw.memory : raw
  if (!isRecord(body)) return {}
  return {
    ...(typeof body.memory_id === 'string' ? { id: body.memory_id } : {}),
    ...(typeof body.status === 'string' ? { status: body.status } : {}),
  }
}

function settle(ctx: WriteToolExecutionContext): void {
  void invalidateKeys(ctx.queryClient, keysFor.memory())
}

const statusNote = (status: string | undefined) =>
  (status === 'proposed' ? ' It was filed as a PROPOSAL for an admin or memory reviewer to approve.' : '')

export async function remember(args: RememberArgs, ctx: WriteToolExecutionContext) {
  const res = answered(await fetchApi<unknown>('/memory', post(args)))
  settle(ctx)
  const id = res.id === undefined ? '' : ` (${res.id})`
  return { summary: `Remembered (${args.scope})${id}.${statusNote(res.status)}`, data: res }
}

/**
 * In place for an admin / memory reviewer (`PUT /memory/{id}`). Anyone else is
 * refused that route (403), so the new statement is filed instead as a company
 * `POST /memory` — which the memory Lambda stores as `proposed` for review.
 */
export async function updateCompanyMemory(args: UpdateCompanyMemoryArgs, ctx: WriteToolExecutionContext) {
  try {
    const res = answered(await fetchApi<unknown>(item(args.memory_id), {
      method: 'PUT', body: JSON.stringify({ statement: args.statement }),
    }))
    settle(ctx)
    return { summary: `Updated company memory ${args.memory_id} for everyone.${statusNote(res.status)}`, data: res }
  } catch (error) {
    if (apiErrorStatus(error) !== 403) throw error
    return proposeCompanyMemory(args, ctx)
  }
}

/** The non-curator path of {@link updateCompanyMemory}: a company add the Lambda files as `proposed`. */
async function proposeCompanyMemory(args: UpdateCompanyMemoryArgs, ctx: WriteToolExecutionContext) {
  const res = answered(await fetchApi<unknown>('/memory', post({ scope: 'company', statement: args.statement, kind: args.kind })))
  settle(ctx)
  const id = res.id === undefined ? '' : ` (${res.id})`
  return {
    summary: `You cannot change company memory ${args.memory_id} directly, so the new statement was filed${id} for an admin or memory reviewer.${statusNote(res.status)}`,
    data: { ...res, replaces: args.memory_id },
  }
}

export async function forgetMemory(args: ForgetMemoryArgs, ctx: WriteToolExecutionContext) {
  await fetchApi<unknown>(item(args.memory_id, '/forget'), post())
  settle(ctx)
  return { summary: `Forgot memory ${args.memory_id} (archived and tombstoned; an admin can restore it).` }
}

export async function confirmMemory(args: ConfirmMemoryArgs, ctx: WriteToolExecutionContext) {
  await fetchApi<unknown>(item(args.memory_id, '/confirm'), post())
  settle(ctx)
  return { summary: `Added your +1 to memory ${args.memory_id}.` }
}

export async function mergeMemories(args: MergeMemoriesArgs, ctx: WriteToolExecutionContext) {
  const res = answered(await fetchApi<unknown>('/memory/merge', post({ ids: args.memory_ids, statement: args.statement })))
  settle(ctx)
  const into = res.id === undefined ? '' : ` into ${res.id}`
  return { summary: `Merged ${args.memory_ids.length} memories${into}; the originals are archived.`, data: res }
}

export async function resolveMemoryConflict(args: ResolveMemoryConflictArgs, ctx: WriteToolExecutionContext) {
  await fetchApi<unknown>(`/memory/review/${encodeURIComponent(args.memory_id)}/resolve`, post({
    action: args.action,
    ...(args.winner_id === undefined ? {} : { winner_id: args.winner_id }),
    ...(args.statement === undefined ? {} : { statement: args.statement }),
  }))
  settle(ctx)
  return { summary: `Resolved review item ${args.memory_id}: ${args.action.replaceAll('_', ' ')}.` }
}
