import { describe, expect, it } from 'vitest'
import { callOriginal, capturedMethod, getOriginal, inheritedDescriptor, ownDescriptor, restoreProperty } from './originals'

class Greeter {
  readonly name: string
  constructor(name: string) {
    this.name = name
  }
  greet(greeting: string): string {
    return `${greeting}, ${this.name}`
  }
  get shout(): string {
    return this.name.toUpperCase()
  }
}

describe('captured originals', () => {
  it('calls a captured method and getter with the given this', () => {
    const method = ownDescriptor(Greeter.prototype, 'greet')
    const getter = ownDescriptor(Greeter.prototype, 'shout')
    expect(callOriginal(method, new Greeter('Ada'), 'Hello')).toBe('Hello, Ada')
    expect(getOriginal(getter, new Greeter('Ada'))).toBe('ADA')
  })

  it('finds an inherited property on the nearest prototype that has it', () => {
    expect(callOriginal(inheritedDescriptor(new Greeter('Ada'), 'greet'), new Greeter('Bo'), 'Hi')).toBe('Hi, Bo')
    expect(() => inheritedDescriptor({}, 'missing')).toThrow('no property missing to capture')
  })

  it('captures a method as it reads now, callable later with any this', () => {
    const greet = capturedMethod(Greeter.prototype, 'greet')
    expect(greet(new Greeter('Cy'), 'Hey')).toBe('Hey, Cy')
    expect(() => capturedMethod(Greeter.prototype, 'name')).toThrow('name is not a method to capture')
  })

  it('refuses a property the target does not own', () => {
    expect(() => ownDescriptor({}, 'missing')).toThrow('no own property missing to capture')
  })

  it('refuses to call a getter as a method', () => {
    const getter = ownDescriptor(Greeter.prototype, 'shout')
    expect(() => callOriginal(getter, new Greeter('Ada'))).toThrow('the captured property has no value function')
  })

  it('restores a replaced property, and removes one that was absent', () => {
    const target: Record<string, unknown> = { kept: 1 }
    const kept = ownDescriptor(target, 'kept')
    target.kept = 2
    target.added = 3
    restoreProperty(target, 'kept', kept)
    restoreProperty(target, 'added', undefined)
    expect(target).toStrictEqual({ kept: 1 })
  })
})
