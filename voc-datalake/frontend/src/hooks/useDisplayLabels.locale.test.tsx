/**
 * Built-in sources read in the reader's language (5.34.00: "Feedback form" and
 * "Email inbox" stayed English in Spanish); an admin's own label still wins.
 */
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import esCommon from '../../public/locales/es/common.json'
import { useLocale } from '../test/i18n-locale'

const profiles = vi.hoisted(() => ({ data: [
  { id: 'email_intake', label: 'Email inbox' },
  { id: 'manual_import', label: 'Equipo de ventas' },
] }))
vi.mock('./useCategories', () => ({ useCategoriesConfig: () => ({ data: { categories: [] } }) }))
vi.mock('./useDimensions', () => ({ useSourceProfiles: () => profiles }))

import { useDisplayLabels } from './useDisplayLabels'

describe('useDisplayLabels source names in Spanish', () => {
  useLocale('es', { common: esCommon })

  it('translates a built-in source, including one whose profile carries the English default label', () => {
    const { result } = renderHook(() => useDisplayLabels())
    expect([result.current.source('feedback_form'), result.current.source('email_intake')])
      .toStrictEqual(['Formulario de opinión', 'Bandeja de correo'])
  })

  it('keeps the label an admin gave a built-in source, and humanises any other id', () => {
    const { result } = renderHook(() => useDisplayLabels())
    expect([result.current.source('manual_import'), result.current.source('acme_crm')]).toStrictEqual(['Equipo de ventas', 'Acme crm'])
  })
})
