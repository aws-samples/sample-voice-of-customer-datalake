import { describe, it, expect } from 'vitest'
import {
  sentimentHexColor,
  sentimentCssVar,
  sentimentLabelFromScore,
} from './sentiment'

describe('sentimentHexColor (print/PDF)', () => {
  it('returns literal hex so it renders in the stylesheet-less print window', () => {
    expect(sentimentHexColor('positive')).toBe('#007038')
    expect(sentimentHexColor('negative')).toBe('#bd1c3a')
    expect(sentimentHexColor('neutral')).toBe('#5e5966')
    expect(sentimentHexColor('mixed')).toBe('#6b5900')
  })

  it('falls back to neutral for unknown or missing labels', () => {
    expect(sentimentHexColor('bogus')).toBe('#5e5966')
    expect(sentimentHexColor(undefined)).toBe('#5e5966')
  })
})

describe('sentimentCssVar (on-screen)', () => {
  it('maps each label to its theme token', () => {
    expect(sentimentCssVar('positive')).toBe('var(--sentiment-positive)')
    expect(sentimentCssVar('negative')).toBe('var(--sentiment-negative)')
    expect(sentimentCssVar('neutral')).toBe('var(--sentiment-neutral)')
    expect(sentimentCssVar('mixed')).toBe('var(--sentiment-mixed)')
  })

  it('falls back to neutral for unknown or missing labels', () => {
    expect(sentimentCssVar('bogus')).toBe('var(--sentiment-neutral)')
    expect(sentimentCssVar(undefined)).toBe('var(--sentiment-neutral)')
  })

  it('does not leak inherited object keys', () => {
    expect(sentimentCssVar('constructor')).toBe('var(--sentiment-neutral)')
    expect(sentimentHexColor('toString')).toBe('#5e5966')
  })
})

describe('sentimentLabelFromScore', () => {
  it('buckets scores', () => {
    expect(sentimentLabelFromScore(0.5)).toBe('positive')
    expect(sentimentLabelFromScore(0)).toBe('neutral')
    expect(sentimentLabelFromScore(-0.3)).toBe('neutral')
    expect(sentimentLabelFromScore(-0.31)).toBe('negative')
  })
})
