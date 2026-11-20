import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FORM_TEMPLATES, templateById, templateForm } from './formTemplates'
import type { CopyLookup } from './formTemplates'
import { TEMPLATE_GROUPS } from './templates/templateKit'
import { blockingProblems, validateForm } from './model/validateForm'
import { formPaths, minutesToAnswer } from './model/paths'
import { FORM_LANGUAGES } from './model/formsV2'
import type { FormLanguage } from './model/formsV2'
import { isRecord } from '../../lib/typeGuards'

const LOCALES = join(__dirname, '..', '..', '..', 'public', 'locales')

function catalogue(language: FormLanguage): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(LOCALES, language, 'feedbackForms.json'), 'utf8'))
  return isRecord(parsed) ? parsed : {}
}

/** A lookup into one locale's catalogue file (the real copy the picker resolves). */
function lookupIn(language: FormLanguage): CopyLookup {
  const root = catalogue(language)
  return (key) => {
    const value = key.split('.').reduce<unknown>((node, part) => (isRecord(node) ? node[part] : undefined), root)
    return typeof value === 'string' ? value : undefined
  }
}

/** Every leaf key under `templates` in one locale, sorted. */
function templateKeys(language: FormLanguage): string[] {
  const walk = (node: unknown, path: string): string[] => (isRecord(node)
    ? Object.entries(node).flatMap(([key, value]) => walk(value, `${path}.${key}`))
    : [path])
  return walk(catalogue(language)['templates'], 'templates').sort((a, b) => a.localeCompare(b))
}

describe('the thirteen templates', () => {
  it('are thirteen, each in one of the six goals, Blank last', () => {
    expect(FORM_TEMPLATES).toHaveLength(13)
    expect(new Set(FORM_TEMPLATES.map((flow) => flow.group))).toStrictEqual(new Set(TEMPLATE_GROUPS))
    expect(FORM_TEMPLATES.at(-1)?.id).toBe('blank')
  })

  it.each(FORM_TEMPLATES.map((flow) => [flow.id]))('%s makes a form with no problem that blocks a save', (id) => {
    const flow = templateById(id)
    const form = flow === undefined ? null : templateForm(flow, 'en', lookupIn('en'))
    expect(form === null ? ['missing'] : blockingProblems(validateForm(form))).toStrictEqual([])
  })

  it.each(FORM_TEMPLATES.map((flow) => [flow.id]))('every path of %s reaches an ending, and every question is on one', (id) => {
    const flow = templateById(id)
    const form = flow === undefined ? null : templateForm(flow, 'en', lookupIn('en'))
    const paths = form === null ? null : formPaths(form)
    expect(paths === null ? [] : [...paths.questionWays.values()].filter((ways) => ways === 0)).toStrictEqual([])
    expect(paths?.total ?? 0).toBeGreaterThan(0)
  })

  it('writes every text in the language it is created in, and option codes as English slugs', () => {
    const flow = templateById('old_ui')
    const form = flow === undefined ? null : templateForm(flow, 'en', lookupIn('en'))
    const why = form?.questions[0]
    expect(why?.headline).toStrictEqual({ en: 'What made you switch back to the old interface?' })
    expect(why?.type === 'multi_select' ? why.options.map((option) => option.code) : []).toContain('missing_function')
    expect(form?.hidden_fields).toStrictEqual([
      { id: 'user_id', label: 'User' }, { id: 'app_version', label: 'App version' }, { id: 'screen', label: 'Screen where they switched' },
    ])
  })

  it('reads the NPS flow as the spec writes it: detractors and promoters each get their own follow-up', () => {
    const flow = templateById('nps')
    const form = flow === undefined ? null : templateForm(flow, 'en', lookupIn('en'))
    expect(form?.questions[0]?.logic?.map((rule) => [rule.when.op, rule.when.value, rule.then.jump_to])).toStrictEqual([
      ['lte', 6, 'q_detractor_reason'], ['gte', 9, 'q_promoter_value'],
    ])
    expect(form === null ? 0 : formPaths(form).endingWays.get('end_contact')).toBe(3)
    expect(form === null ? 0 : minutesToAnswer(form)).toBe(1)
  })

  it('names the template a form is made from, but for Blank (7.63.00: Compare matches the forms of one template)', () => {
    const made = FORM_TEMPLATES.map((flow) => [flow.id, templateForm(flow, 'en', lookupIn('en')).template])
    expect(made.filter(([id]) => id !== 'blank').every(([id, ref]) => typeof ref === 'object' && ref.id === id && ref.version === 1)).toBe(true)
    expect(made.find(([id]) => id === 'blank')?.[1]).toBeUndefined()
  })

  it.each(FORM_LANGUAGES.filter((language) => language !== 'en').map((language) => [language]))('has every template key in %s', (language) => {
    expect(templateKeys(language)).toStrictEqual(templateKeys('en'))
  })
})

describe('the Events template (7.63.00)', () => {
  const flow = templateById('workshop')
  const form = flow === undefined ? null : templateForm(flow, 'en', lookupIn('en'))

  it('keeps the stable ids forms are compared by, and its hidden fields', () => {
    expect(form?.questions.map((question) => question.id)).toStrictEqual([
      'q_role', 'q_familiarity', 'q_value', 'q_phases', 'q_tooling', 'q_tooling_why', 'q_content', 'q_content_why', 'q_presenter',
      'q_presenter_why', 'q_nps', 'q_nps_reason', 'q_apply', 'q_barriers', 'q_takeaway', 'q_improve',
    ])
    expect(form?.hidden_fields.map((field) => field.id)).toStrictEqual(['customer', 'event', 'event_date', 'presenter'])
    expect(form?.template).toStrictEqual({ id: 'workshop', version: 1 })
    expect(form?.welcome.title).toStrictEqual({ en: 'Thanks for joining {{event|the workshop}}' })
  })

  it("rates each part on a matrix scored 1 to 4, and asks why after a low tooling, content or presenter score", () => {
    const phases = form?.questions.find((question) => question.id === 'q_phases')
    expect(phases?.type === 'matrix' ? phases.columns.map((column) => [column.code, column.score]) : []).toStrictEqual([
      ['needs_improvement', 1], ['satisfactory', 2], ['very_effective', 3], ['exceptional', 4],
    ])
    const rules = (id: string) => form?.questions.find((question) => question.id === id)?.logic?.map((rule) => [rule.when.op, rule.when.value, rule.then.jump_to])
    expect([rules('q_tooling'), rules('q_content'), rules('q_presenter')]).toStrictEqual([
      [['gt', 2, 'q_content']], [['gt', 2, 'q_presenter']], [['gt', 2, 'q_nps']],
    ])
    expect(form?.questions.find((question) => question.id === 'q_nps_reason')?.headline).toStrictEqual({ en: "What's the main reason for your score of {{q_nps}}?" })
    const role = form?.questions[0]
    expect(role?.type === 'single_select' ? [role.options.length, role.other.enabled] : []).toStrictEqual([7, true])
  })
})

