/**
 * @fileoverview The six default engineering flows (docs/autonomous-engineering.md "Default flows") as the workflow
 * library offers them ("Start from a template").
 *
 * One file holds them for the server and the web app: `lambda/shared/engineering_flow_templates.json`, which the
 * agents API lists (`GET /workflows/templates`, `shared/engineering_templates.py`) and a Python test validates with
 * the server's own rules; the app imports the same file, so the two cannot offer different flows. The library lists
 * them from the file (no wait); the copy a person opens is the server's (`GET /workflows/templates`, which answers 404
 * where the engineering module is not deployed and 403 to anyone but an administrator). A template is never stored:
 * choosing one opens the editor on an unsaved copy, and Save is the library's own `POST /workflows`.
 *
 * Each template's name and description are shown from the locale catalogues (`agents:templates.*`); the copy takes
 * them as its name and description.
 *
 * @module api/engineeringTemplates
 */
import { z } from 'zod'
import templatesFile from '../../../lambda/shared/engineering_flow_templates.json'
import { fetchApi } from './client'
import { lenientList } from './lenientFields'
import { normalizeDefinition, schemaGuard } from './workflowsApi'
import type { WorkflowDefinition } from './workflowsApi'

/** The catalogue keys of each template's name and description, by template id (the JSON's `template_id`). */
const TEMPLATE_TEXT = {
  'understand-repository': {
    nameKey: 'agents:templates.understandRepository.name',
    descriptionKey: 'agents:templates.understandRepository.description',
  },
  'issue-triage': { nameKey: 'agents:templates.issueTriage.name', descriptionKey: 'agents:templates.issueTriage.description' },
  'bug-hunt-and-fix': { nameKey: 'agents:templates.bugHunt.name', descriptionKey: 'agents:templates.bugHunt.description' },
  'feature': { nameKey: 'agents:templates.feature.name', descriptionKey: 'agents:templates.feature.description' },
  'pr-review': { nameKey: 'agents:templates.prReview.name', descriptionKey: 'agents:templates.prReview.description' },
  'self-improvement': {
    nameKey: 'agents:templates.selfImprovement.name',
    descriptionKey: 'agents:templates.selfImprovement.description',
  },
} as const

type TemplateId = keyof typeof TEMPLATE_TEXT

export interface EngineeringTemplate {
  readonly templateId: TemplateId
  readonly nameKey: string
  readonly descriptionKey: string
  readonly definition: WorkflowDefinition
}

const isTemplateId = (id: string): id is TemplateId => Object.hasOwn(TEMPLATE_TEXT, id)

function readTemplates(): EngineeringTemplate[] {
  return templatesFile.templates.flatMap((item) => {
    const definition = normalizeDefinition(item.definition)
    if (definition === null || !isTemplateId(item.template_id)) return []
    return [{ templateId: item.template_id, ...TEMPLATE_TEXT[item.template_id], definition }]
  })
}

/** The default engineering flows, in the file's order. */
export const ENGINEERING_TEMPLATES: readonly EngineeringTemplate[] = readTemplates()

/** One template by its id (a route parameter: untrusted), or undefined. */
export const findEngineeringTemplate = (templateId: string): EngineeringTemplate | undefined =>
  ENGINEERING_TEMPLATES.find((template) => template.templateId === templateId)

const ServedTemplateSchema = z.object({ template_id: z.string().min(1), definition: z.unknown() })

/** `GET /workflows/templates`: each template's definition as the server holds it, by template id (unreadable ones left out). */
export async function fetchServedTemplates(): Promise<ReadonlyMap<string, WorkflowDefinition>> {
  const raw = await fetchApi<unknown>('/workflows/templates')
  const items = lenientList(schemaGuard(ServedTemplateSchema)).parse(z.object({ items: z.unknown() }).catch({ items: [] }).parse(raw).items)
  return new Map(items.flatMap((item) => {
    const definition = normalizeDefinition(item.definition)
    return definition === null ? [] : [[item.template_id, definition] as const]
  }))
}

/** The react-query key of {@link fetchServedTemplates} (under the workflows' own, so their invalidations cover it). */
export const servedTemplatesKey = ['workflows', 'templates'] as const

/** The unsaved copy a template opens as: its definition, named and described in the person's language. */
export const templateCopy = (definition: WorkflowDefinition, name: string, description: string): WorkflowDefinition =>
  ({ ...definition, name, description })
