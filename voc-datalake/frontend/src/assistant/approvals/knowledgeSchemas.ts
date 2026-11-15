/**
 * @fileoverview The arguments of `propose_knowledge_refresh`, the stream's own schema
 * (`@stream/assistant/tools/knowledge-refresh-rules`), so the card accepts exactly what the server proposes.
 *
 * @module assistant/approvals/knowledgeSchemas
 */
import { knowledgeRefreshArgsSchema } from '@stream/assistant/tools/knowledge-refresh-rules'
import type { KnowledgeRefreshArgs } from '@stream/assistant/tools/knowledge-refresh-rules'

export const proposeKnowledgeRefreshArgs = knowledgeRefreshArgsSchema
export type ProposeKnowledgeRefreshArgs = KnowledgeRefreshArgs
