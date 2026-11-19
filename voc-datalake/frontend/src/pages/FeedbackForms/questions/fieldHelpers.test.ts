import { describe, expect, it } from 'vitest'
import type { FormProblem } from '../model/validateForm'
import { fieldProblems, numberOrUndefined } from './fieldHelpers'

const problem = (field: string, optionIndex?: number): FormProblem => ({
  severity: 'error', code: 'optionEmpty', at: { kind: 'question', id: 'q_reason', field, optionIndex }, params: {},
})

describe('fieldProblems', () => {
  it("keeps a field's problems, of every option when none is named", () => {
    const problems = [problem('option', 0), problem('code', 0), problem('option', 1)]
    expect(fieldProblems(problems, 'option')).toStrictEqual([problem('option', 0), problem('option', 1)])
  })

  it("keeps only the named option's problems", () => {
    const problems = [problem('option', 0), problem('option', 1)]
    expect(fieldProblems(problems, 'option', 1)).toStrictEqual([problem('option', 1)])
  })
})

describe('numberOrUndefined', () => {
  it('reads a blank input as no value', () => {
    expect(numberOrUndefined('  ')).toBeUndefined()
  })

  it('reads digits as an integer, dropping a fraction', () => {
    expect(numberOrUndefined('12.7')).toBe(12)
  })

  it('drops what is not a number', () => {
    expect(numberOrUndefined('abc')).toBeUndefined()
  })
})
