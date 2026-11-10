/**
 * @fileoverview "What it produced" lists each document once (5.34.00 live: every PR/FAQ twice —
 * the writer's artifact and the review's), with its latest event, in first-seen order.
 */
import { describe, expect, it } from 'vitest'
import { producedArtifacts } from './producedArtifacts'
import type { RunEvent } from '../../api/agentsApi'

const artifact = (seq: number, summary: string, documentId?: string): RunEvent => ({
  seq, at: '', kind: 'artifact', summary, ...(documentId === undefined ? {} : { ref: { project_id: 'p1', document_id: documentId } }),
})
const verdict: RunEvent = { seq: 3, at: '', kind: 'verdict', summary: 'Ana: 4/5' }

describe('producedArtifacts', () => {
  it('one entry per document, the latest event, first-seen order', () => {
    const events = [
      artifact(1, 'PR/FAQ ready', 'v1'), artifact(2, 'PR/FAQ ready (review)', 'v1'),
      verdict,
      artifact(4, 'PR/FAQ ready', 'v2'), artifact(5, 'PR/FAQ ready (review)', 'v2'),
    ]
    expect(producedArtifacts(events).map((e) => e.seq)).toStrictEqual([2, 5])
  })

  it('an artifact without a document is kept on its own', () => {
    expect(producedArtifacts([artifact(1, 'A'), artifact(2, 'B')]).map((e) => e.seq)).toStrictEqual([1, 2])
  })
})
