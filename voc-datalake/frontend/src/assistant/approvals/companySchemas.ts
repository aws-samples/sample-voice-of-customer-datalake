/**
 * @fileoverview Argument schemas of the `company` pack write tools: the stream
 * Lambda's own schemas (`@stream/assistant/tools/client/company-schemas`), built
 * over the SPA's id schema. Logo, references and integration tokens are
 * deliberately not writable here.
 *
 * @module assistant/approvals/companySchemas
 */
import type { z } from 'zod'
import { buildCompanyArgSchemas } from '@stream/assistant/tools/client/company-schemas'
import { idSchema } from './schemas'

const companyArgs = buildCompanyArgSchemas(idSchema)

export const updateCompanyContextArgs = companyArgs.updateCompanyContext
export const updateMyContextArgs = companyArgs.updateMyContext
export const updateDesignSystemArgs = companyArgs.updateDesignSystem

export type UpdateCompanyContextArgs = z.infer<typeof updateCompanyContextArgs>
export type UpdateMyContextArgs = z.infer<typeof updateMyContextArgs>
export type UpdateDesignSystemArgs = z.infer<typeof updateDesignSystemArgs>
