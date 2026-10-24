import { describe, expect, it } from 'vitest'
import { at, defined } from './defined'

describe('defined', () => {
  it('returns a present value unchanged, including falsy ones', () => {
    expect(defined(0)).toBe(0)
    expect(defined('')).toBe('')
    expect(defined(null)).toBeNull()
  })

  it('throws a message naming the missing value', () => {
    expect(() => defined(undefined, 'token')).toThrow('token is undefined')
    expect(() => defined(undefined)).toThrow('value is undefined')
  })
})

describe('at', () => {
  const list = ['a', 'b', 'c']

  it('reads by index, negative indexes counting from the end', () => {
    expect(at(list, 0)).toBe('a')
    expect(at(list, 2)).toBe('c')
    expect(at(list, -1)).toBe('c')
    expect(at(list, -3)).toBe('a')
  })

  it('throws on an out-of-range index with the label and length', () => {
    expect(() => at(list, 3, 'rows')).toThrow('rows[3] is out of range (length 3)')
    expect(() => at(list, -4)).toThrow('list[-4] is out of range (length 3)')
    expect(() => at([], 0)).toThrow('list[0] is out of range (length 0)')
  })

  it('throws on a hole inside the range', () => {
    const sparse: (string | undefined)[] = ['a', undefined]
    expect(() => at(sparse, 1, 'sparse')).toThrow('sparse[1] is undefined')
  })

  it('accepts array-likes such as a NodeList', () => {
    const container = document.createElement('div')
    container.innerHTML = '<p>one</p><p>two</p>'
    expect(at(container.querySelectorAll('p'), 1).textContent).toBe('two')
  })
})
