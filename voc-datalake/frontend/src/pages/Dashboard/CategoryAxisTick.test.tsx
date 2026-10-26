/**
 * @fileoverview The category axis no longer clips ("oftware firmware"): a label that
 * does not fit is cut with an ellipsis and keeps the full name as its `<title>`.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CategoryAxisTick } from './CategoryAxisTick'
import { charsThatFit, truncateLabel } from './axisLabel'

function renderTick(value: unknown, axisWidth = 124) {
  const { container } = render(
    <svg><CategoryAxisTick x={124} y={10} payload={{ value }} axisWidth={axisWidth} /></svg>,
  )
  const text = container.querySelector('text')
  return { shown: text?.lastChild?.textContent, title: container.querySelector('title')?.textContent }
}

describe('truncateLabel / charsThatFit', () => {
  it.each([
    ['Customer support', 16, 'Customer support'],
    ['Software firmware', 16, 'Software firmwa…'],
    ['Billing and payments', 10, 'Billing a…'],
  ])('%s in %i characters → %s', (label, max, expected) => {
    expect(truncateLabel(label, max)).toBe(expected)
  })

  it('fits 16 characters in the Dashboard axis and never fewer than 4', () => {
    expect([charsThatFit(124), charsThatFit(0)]).toStrictEqual([16, 4])
  })
})

describe('CategoryAxisTick', () => {
  it('cuts a label that does not fit and keeps the full one as its tooltip', () => {
    expect(renderTick('Software firmware')).toStrictEqual({ shown: 'Software firmwa…', title: 'Software firmware' })
  })

  it('the control: a label that fits is shown whole', () => {
    expect(renderTick('Delivery')).toStrictEqual({ shown: 'Delivery', title: 'Delivery' })
  })

  it('renders a non-string value as text', () => {
    expect(renderTick(42).shown).toBe('42')
  })
})
