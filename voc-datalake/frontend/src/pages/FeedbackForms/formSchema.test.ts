/**
 * Regression tests for issue #171: /feedback-forms crashed with
 * "Cannot read properties of undefined (reading 'primary_color')" when the
 * wire delivered sparse form records (persisted before theme/custom_fields
 * existed). normalizeFeedbackForm makes the FeedbackForm contract true at
 * the query boundary via a lenient Zod schema.
 */
import { describe, it, expect } from 'vitest'
import { normalizeFeedbackForm } from './formSchema'
import type { SparseFeedbackForm } from './formSchema'
import { defaultFormConfig } from './formTemplates'
import type { FeedbackForm } from '../../api/client'

const sparseForm: SparseFeedbackForm = { form_id: 'form_3', name: 'Support Feedback', enabled: false }

describe('normalizeFeedbackForm (issue #171)', () => {
  it('fills every missing field on a sparse legacy record with defaults', () => {
    const form = normalizeFeedbackForm(sparseForm)

    expect(form.theme).toEqual(defaultFormConfig.theme)
    expect(form.custom_fields).toEqual([])
    expect(form.title).toBe(defaultFormConfig.title)
    expect(form.rating_type).toBe(defaultFormConfig.rating_type)
    expect(form.rating_max).toBe(defaultFormConfig.rating_max)
    expect(form.collect_email).toBe(defaultFormConfig.collect_email)
    expect(form.category).toBe('')
    expect(form.created_at).toBe('')
    expect(form.updated_at).toBe('')
  })

  it('passes identity fields through untouched', () => {
    const form = normalizeFeedbackForm(sparseForm)

    expect(form.form_id).toBe('form_3')
    expect(form.name).toBe('Support Feedback')
    expect(form.enabled).toBe(false)
  })

  it('treats explicit nulls like missing fields (DynamoDB emits both)', () => {
    const form = normalizeFeedbackForm({
      ...sparseForm,
      title: null,
      theme: null,
      custom_fields: null,
      created_at: null,
    })

    expect(form.title).toBe(defaultFormConfig.title)
    expect(form.theme).toEqual(defaultFormConfig.theme)
    expect(form.custom_fields).toEqual([])
    expect(form.created_at).toBe('')
  })

  it('deep-merges a partial theme instead of replacing it wholesale', () => {
    const form = normalizeFeedbackForm({ ...sparseForm, theme: { primary_color: '#123456' } })

    expect(form.theme.primary_color).toBe('#123456')
    expect(form.theme.background_color).toBe(defaultFormConfig.theme.background_color)
    expect(form.theme.text_color).toBe(defaultFormConfig.theme.text_color)
    expect(form.theme.border_radius).toBe(defaultFormConfig.theme.border_radius)
  })

  it('coerces DynamoDB numeric-string round-trips and rejects junk', () => {
    expect(normalizeFeedbackForm({ ...sparseForm, rating_max: '10' }).rating_max).toBe(10)
    expect(normalizeFeedbackForm({ ...sparseForm, rating_max: 'lots' }).rating_max).toBe(defaultFormConfig.rating_max)
    expect(normalizeFeedbackForm({ ...sparseForm, rating_type: 'invalid-kind' }).rating_type).toBe(defaultFormConfig.rating_type)
  })

  it('keeps a complete record unchanged', () => {
    const complete: FeedbackForm = {
      ...defaultFormConfig,
      form_id: 'form_9',
      name: 'Complete Form',
      enabled: true,
      category: 'delivery',
      subcategory: 'late',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
      theme: { primary_color: '#111111', background_color: '#222222', text_color: '#333333', border_radius: '4px' },
      custom_fields: [{ id: 'f1', label: 'Order ID', type: 'text', required: true }],
    }

    expect(normalizeFeedbackForm(complete)).toEqual(complete)
  })

  it('never shares object references between normalized forms or with inputs', () => {
    const a = normalizeFeedbackForm(sparseForm)
    const b = normalizeFeedbackForm({ ...sparseForm, form_id: 'form_4' })

    expect(a.theme).not.toBe(b.theme)
    expect(a.custom_fields).not.toBe(b.custom_fields)

    // Mutating one form's theme must not leak into the shared defaults.
    a.theme.primary_color = '#000000'
    expect(defaultFormConfig.theme.primary_color).not.toBe('#000000')
    expect(b.theme.primary_color).toBe(defaultFormConfig.theme.primary_color)

    // Zod re-parses arrays, so inputs are not shared by reference either.
    const inputFields = [{ id: 'f1', label: 'Order ID', type: 'text', required: true }]
    const c = normalizeFeedbackForm({ ...sparseForm, custom_fields: inputFields })
    expect(c.custom_fields).not.toBe(inputFields)
    expect(c.custom_fields).toEqual(inputFields)
  })
})
