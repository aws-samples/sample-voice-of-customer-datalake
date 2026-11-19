import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FORM_TEMPLATES, templateById, templateForm } from './formTemplates'
import type { CopyLookup } from './formTemplates'
import { TEMPLATE_GROUPS } from './templates/templateKit'
import { blockingProblems, validateForm } from './model/validateForm'
import { formPaths, minutesToAnswer } from './model/paths'
import { FORM_LANGUAGES } from './model/formsV2'
import type { FormLanguage, QuestionType } from './model/formsV2'
import { isRecord } from '../../lib/typeGuards'
import logicOps from '../../../../schemas/form-logic-ops.json'

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

describe('the twelve templates', () => {
  it('are twelve, each in one of the five goals, Blank last', () => {
    expect(FORM_TEMPLATES).toHaveLength(12)
    expect(new Set(FORM_TEMPLATES.map((flow) => flow.group))).toStrictEqual(new Set(TEMPLATE_GROUPS))
    expect(FORM_TEMPLATES.at(-1)?.id).toBe('blank')
  })

  it.each(FORM_TEMPLATES.map((flow) => [flow.id]))('%s makes a form with no problem that blocks a save', (id) => {
    const flow = templateById(id)
    const form = flow === undefined ? null : templateForm(flow, 'en', lookupIn('en'))
    expect(form === null ? ['missing'] : blockingProblems(validateForm(form))).toStrictEqual([])
  })

  // (the server's ops per type, schemas/form-logic-ops.json: the NPS template's consent rule `equals false` was a 400
  // on "Use this template" before this check, which the builder's validator did not know then)
  it.each(FORM_TEMPLATES.map((flow) => [flow.id]))('%s writes only rules the server takes: its op for the type, no value on submitted / skipped', (id) => {
    const server: Readonly<Record<QuestionType, readonly string[]>> = logicOps.ops_by_type
    const flow = templateById(id)
    const form = flow === undefined ? null : templateForm(flow, 'en', lookupIn('en'))
    const refused = (form?.questions ?? []).flatMap((q) => (q.logic ?? [])
      .filter(({ when }) => !server[q.type].includes(when.op) || ((when.op === 'submitted' || when.op === 'skipped') && when.value !== undefined))
      .map(({ when }) => `${q.id} (${q.type}): ${when.op}`))
    expect(form === null ? ['missing'] : refused).toStrictEqual([])
    expect(form === null ? ['missing'] : validateForm(form).filter((problem) => problem.code === 'opInvalid')).toStrictEqual([])
  })

  it('ends the follow-up for those who do not accept being contacted: the consent\'s `skipped`', () => {
    const flow = templateById('nps')
    const form = flow === undefined ? null : templateForm(flow, 'en', lookupIn('en'))
    const consent = form?.questions.find((q) => q.type === 'consent')
    expect(consent?.logic).toStrictEqual([{ when: { op: 'skipped' }, then: { jump_to: 'end_thanks' } }])
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

  it.each(FORM_LANGUAGES.filter((language) => language !== 'en').map((language) => [language]))('has every template key in %s', (language) => {
    expect(templateKeys(language)).toStrictEqual(templateKeys('en'))
  })
})
