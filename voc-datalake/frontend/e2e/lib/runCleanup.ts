/**
 * Ledger-driven deletes shared by the shared teardown (tests/cleanup.spec.ts) and
 * the tracks that run alone with `--no-deps` and clean up after themselves
 * (s2-agents s2-99, s3 step 12). Each returns its proof; the caller asserts.
 *
 * QA 3.00.00 S3: s3 picked its conversations from the ledger by NAME (`e.name
 * .startsWith(PROJECT)`), but the stream tap records them as `assistant stream
 * <id>`, so none matched and every one was left behind. Selection is by kind and
 * run here (`runLedger`), never by a label.
 */
import { apiCall } from './api'
import type { Role } from './env'
import { runLedger, type Created } from './ledger'

export interface ConversationProof {
  readonly id: string
  readonly owner: Role
  readonly deleteStatus: number
  /** The GET after the delete: 404 means gone. */
  readonly getStatus: number
}

/** This run's conversations (every one, however it was recorded). */
export const runConversations = (ledger: readonly Created[] = runLedger()): Created[] =>
  ledger.filter((e) => e.kind === 'conversation')

/**
 * Deletes each conversation as its owner (it lives in that user's `USER#` partition:
 * as anyone else the GET answers 404 whether or not it still exists), then GETs it.
 */
export async function deleteConversations(entries: readonly Created[]): Promise<ConversationProof[]> {
  const proof: ConversationProof[] = []
  for (const conv of entries) {
    const owner: Role = conv.role ?? 'admin'
    const path = `/chat/conversations/${encodeURIComponent(conv.id)}`
    const deleted = await apiCall(owner, 'DELETE', path)
    const check = await apiCall(owner, 'GET', path)
    proof.push({ id: conv.id, owner, deleteStatus: deleted.status, getStatus: check.status })
  }
  return proof
}

export interface ProjectProof {
  readonly id: string
  readonly name: string
  readonly deleteStatus: number
  readonly getStatus: number
}

/** Deletes each ledger project as the admin (DELETE is idempotent), then GETs it: 404 means gone. */
export async function deleteProjects(entries: readonly Created[]): Promise<ProjectProof[]> {
  const proof: ProjectProof[] = []
  for (const project of entries) {
    const path = `/projects/${encodeURIComponent(project.id)}`
    const deleted = await apiCall('admin', 'DELETE', path)
    const check = await apiCall('admin', 'GET', path)
    proof.push({ id: project.id, name: project.name, deleteStatus: deleted.status, getStatus: check.status })
  }
  return proof
}
