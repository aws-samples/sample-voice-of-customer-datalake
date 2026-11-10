/**
 * @fileoverview Argument schemas of the memory write tools (`remember`,
 * `update_company_memory` in `core`; the curation tools in `memory`): the stream
 * Lambda's own schemas (`@stream/assistant/tools/client/memory-schemas`), built
 * over the SPA's id schema.
 *
 * @module assistant/approvals/memorySchemas
 */
import type { z } from 'zod'
import { buildMemoryArgSchemas } from '@stream/assistant/tools/client/memory-schemas'
import { idSchema } from './schemas'

const memoryArgs = buildMemoryArgSchemas(idSchema)

export const rememberArgs = memoryArgs.remember
export const updateCompanyMemoryArgs = memoryArgs.updateCompanyMemory
export const forgetMemoryArgs = memoryArgs.forgetMemory
export const confirmMemoryArgs = memoryArgs.confirmMemory
export const mergeMemoriesArgs = memoryArgs.mergeMemories
export const resolveMemoryConflictArgs = memoryArgs.resolveMemoryConflict

export type RememberArgs = z.infer<typeof rememberArgs>
export type UpdateCompanyMemoryArgs = z.infer<typeof updateCompanyMemoryArgs>
export type ForgetMemoryArgs = z.infer<typeof forgetMemoryArgs>
export type ConfirmMemoryArgs = z.infer<typeof confirmMemoryArgs>
export type MergeMemoriesArgs = z.infer<typeof mergeMemoriesArgs>
export type ResolveMemoryConflictArgs = z.infer<typeof resolveMemoryConflictArgs>
