/**
 * @fileoverview Journals read a page at a time by sequence number (`?after=<seq>` → `{items, next_after}`): an agent
 * run's events (agentsApi.ts) and an engineering run's conversation (engineeringRunsApi.ts). Where the next page
 * starts, and how a page joins what is already known.
 *
 * @module api/seqPages
 */
import { isRecord } from '../lib/typeGuards'

interface Sequenced {
  seq: number
}

/** Where the next page starts: the server's `next_after`, else the page's last seq, else where this one started. */
export function nextAfterOf(raw: unknown, items: readonly Sequenced[], after: number): number {
  if (isRecord(raw) && typeof raw.next_after === 'number') return raw.next_after
  return items.at(-1)?.seq ?? after
}

/** Merge a page into the known entries: each kept once by its seq (the page's copy wins), in seq order. */
export function mergeBySeq<T extends Sequenced>(known: readonly T[], page: readonly T[]): T[] {
  const bySeq = new Map(known.map((entry) => [entry.seq, entry]))
  for (const entry of page) bySeq.set(entry.seq, entry)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
