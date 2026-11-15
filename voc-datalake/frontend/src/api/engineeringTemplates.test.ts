/**
 * The default engineering flows as the app reads them (`lambda/shared/engineering_flow_templates.json`, the server's
 * own file): all six, each kept whole by the app's model, each valid under the editor's port of the server's rules
 * (the server's own test, `shared/test/test_engineering_templates.py`, validates them with the real validator), and
 * each with its copy in the catalogues.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import templatesFile from '../../../lambda/shared/engineering_flow_templates.json'
import en from '../../public/locales/en/agents.json'
import { validateLocally } from '../components/WorkflowEditor/graphRules'
import { ENGINEERING_TEMPLATES, findEngineeringTemplate, templateCopy } from './engineeringTemplates'

const Branch = z.record(z.string(), z.unknown())
const catalogue = (key: string): unknown =>
  key.replace(/^agents:/, '').split('.').reduce<unknown>((node, part) => Branch.safeParse(node).data?.[part], en)

describe('the default engineering flows', () => {
  it('offers all six, in the file order', () => {
    expect(ENGINEERING_TEMPLATES.map((t) => t.templateId)).toStrictEqual(templatesFile.templates.map((t) => t.template_id))
    expect(ENGINEERING_TEMPLATES).toHaveLength(6)
  })

  it.each(ENGINEERING_TEMPLATES.map((t) => [t.templateId, t] as const))('%s is valid in the editor, as the server has it', (_id, template) => {
    const raw = templatesFile.templates.find((t) => t.template_id === template.templateId)?.definition
    expect(template.definition).toStrictEqual(raw)
    expect(template.definition.schema).toBe('voc-workflow/2')
    expect(validateLocally(template.definition)).toStrictEqual([])
  })

  it.each(ENGINEERING_TEMPLATES.map((t) => [t.templateId, t] as const))('%s has its name and description in English', (_id, template) => {
    const raw = templatesFile.templates.find((t) => t.template_id === template.templateId)
    expect([catalogue(template.nameKey), catalogue(template.descriptionKey)]).toStrictEqual([raw?.name, raw?.description])
  })

  it('finds a template by id, and nothing for an unknown one', () => {
    expect(findEngineeringTemplate('pr-review')?.definition.name).toBe('PR review')
    expect(findEngineeringTemplate('merge-everything')).toBeUndefined()
    expect(findEngineeringTemplate('toString')).toBeUndefined()
  })

  it.each(ENGINEERING_TEMPLATES.slice(0, 1))('a copy takes the name and description it is given and leaves the template alone', (template) => {
    const copy = templateCopy(template.definition,'Comprender el repositorio', 'Una copia')
    expect([copy.name, copy.description, copy.nodes]).toStrictEqual(['Comprender el repositorio', 'Una copia', template.definition.nodes])
    expect(template.definition.name).toBe('Understand the repository')
  })
})
