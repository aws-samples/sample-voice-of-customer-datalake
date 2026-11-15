/**
 * @fileoverview People's reactions on the host to an engineering run's pull request (7.10.00,
 * `lambda/engineering/learning/reactions.py`): the latest read, as the run monitor's overview carries it
 * (`reactions`, null for none), and an administrator's hand trigger of a new read
 * (`POST /agents/engineering/<run_id>/reactions`: 202 asked, 429 once an hour per run, 409 while the run is under way).
 * Read leniently: a bad entry costs itself, an unknown state is kept as text. Every body is plain text the server
 * redacted; the page shows it as text, never as HTML.
 *
 * @module api/engineeringReactionsApi
 */
import { z } from 'zod'
import { post } from './requestKit'
import { fetchApi } from './client'
import { eachOf } from './lenientFields'

const text = z.string().catch('')
const count = z.number().int().nonnegative().catch(0)

/** The run states in which its reactions may be read by hand (`lambda/engineering/runtime/runs.py` ENDED). */
export const ENDED_RUN_STATES: readonly string[] = ['done', 'failed', 'stopped']

const ItemSchema = z.object({
  /** `review`, `review_comment` or `comment`. */
  kind: z.string().min(1),
  /** A review's `approved`, `changes_requested` or `commented`; '' for a comment. */
  state: text,
  author: z.string().min(1),
  at: text,
  body: text,
})
export type ReactionItem = z.output<typeof ItemSchema>

const ReviewerSchema = z.object({ reviewer: z.string().min(1), state: text, at: text })

export const ReactionsSchema = z.object({
  pull_request: z.object({ host: text, number: z.number().int().positive(), url: text }),
  /** `open`, `closed` or `merged`. */
  state: text,
  merged_at: text,
  items: eachOf(ItemSchema),
  dropped: z.object({ outsiders: count, bots: count }).catch({ outsiders: 0, bots: 0 }),
  reverted: z.boolean().catch(false),
  revert_commit: text,
  /** People's commits to its files after the merge (no bot's, no agent's). */
  edits_after_merge: z.object({
    people_commits: count, files: z.array(z.string()).catch([]), paths_read: count, paths_total: count,
  }).catch({ people_commits: 0, files: [], paths_read: 0, paths_total: 0 }),
  more: z.boolean().catch(false),
  read_at: text,
  /** `schedule` or `human:<subject>` (`run_end` is still shown, should a row of it exist). */
  asked_by: text,
  counts: z.object({
    approved: count, changes_requested: count, commented: count, review_comments: count, comments: count,
  }).catch({ approved: 0, changes_requested: 0, commented: 0, review_comments: 0, comments: 0 }),
  reviewers: eachOf(ReviewerSchema),
}).nullable().catch(null)
export type RunReactions = NonNullable<z.output<typeof ReactionsSchema>>

/** Ask for a new read of an ended run's reactions (admin): the read is handed on, the overview shows it later. */
export async function askReactions(runId: string): Promise<void> {
  await fetchApi<unknown>(`/agents/engineering/${encodeURIComponent(runId)}/reactions`, post({}))
}
