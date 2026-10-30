/**
 * Spec helpers for a property a spec replaces (a DOM prototype method, a getter, a window function) and
 * must restore exactly, or still reach the real implementation of with an explicit `this`.
 *
 * Holding the property's DESCRIPTOR rather than the bare method keeps the value from being detached from
 * its object (the `unbound-method` lint rule), restores accessors and absent properties correctly, and
 * makes the later `this` explicit at the call.
 */

/** `target`'s own descriptor for `name`, read now; throws when `target` has no such own property. */
export function ownDescriptor(target: object, name: PropertyKey): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(target, name)
  if (descriptor === undefined) throw new TypeError(`no own property ${String(name)} to capture`)
  return descriptor
}

function findDescriptor(target: object | null, name: PropertyKey): PropertyDescriptor | undefined {
  if (target === null) return undefined
  return Object.getOwnPropertyDescriptor(target, name) ?? findDescriptor(Reflect.getPrototypeOf(target), name)
}

/**
 * The descriptor `instance` reads `name` through (its own, or the nearest prototype's), read now. For an
 * object of another realm (an iframe's document), whose prototypes are not this window's.
 */
export function inheritedDescriptor(instance: object, name: PropertyKey): PropertyDescriptor {
  const descriptor = findDescriptor(instance, name)
  if (descriptor === undefined) throw new TypeError(`no property ${String(name)} to capture`)
  return descriptor
}

/** Call the descriptor's `key` function (`value` for a method, `get` for a getter) with `thisArg`. */
function applyPart(descriptor: PropertyDescriptor, key: 'value' | 'get', thisArg: unknown, args: readonly unknown[]): unknown {
  const part: unknown = Reflect.get(descriptor, key)
  if (typeof part !== 'function') throw new TypeError(`the captured property has no ${key} function`)
  return Reflect.apply(part, thisArg, args)
}

/** Call the captured method with an explicit `this`. */
export function callOriginal(descriptor: PropertyDescriptor, thisArg: unknown, ...args: readonly unknown[]): unknown {
  return applyPart(descriptor, 'value', thisArg, args)
}

/**
 * `target[name]` as it reads NOW (through any accessor a library installed), to call later with an
 * explicit `this` after a spec has replaced it.
 */
export function capturedMethod(target: object, name: PropertyKey): (thisArg: unknown, ...args: readonly unknown[]) => unknown {
  const method: unknown = Reflect.get(target, name)
  if (typeof method !== 'function') throw new TypeError(`${String(name)} is not a method to capture`)
  return (thisArg, ...args) => {
    const result: unknown = Reflect.apply(method, thisArg, args)
    return result
  }
}

/** Read through the captured getter with an explicit `this`. */
export function getOriginal(descriptor: PropertyDescriptor, thisArg: unknown): unknown {
  return applyPart(descriptor, 'get', thisArg, [])
}

/** Put `name` back as `descriptor` describes it, or remove it when there was none. */
export function restoreProperty(target: object, name: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, name)
  else Object.defineProperty(target, name, descriptor)
}
