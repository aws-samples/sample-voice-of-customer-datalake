/**
 * Prototype-safe nested setter for locale objects, used by fix-i18n.mjs.
 *
 * In its own module so a test can exercise it: importing fix-i18n.mjs runs its main loop
 * (Bedrock translation calls).
 *
 * Two protections, each load-bearing on its own:
 *
 * 1. Refusal: a key with a `__proto__`, `constructor` or `prototype` segment anywhere in its
 *    dotted path writes nothing at all — not even the containers before that segment. The
 *    check is repeated per segment inside the loop, right where the segment is used, because
 *    that is the shape a static scanner recognises as a sanitizer. With a plain root object a
 *    leading `__proto__` resolves through the accessor on Object.prototype, so this layer is
 *    what stops it even though every container below is null-prototypal.
 * 2. Structure: containers the setter creates have a null prototype, and only OWN properties
 *    are reused as containers, so no write reaches an inherited object. JSON.stringify
 *    serialises own enumerable properties only, so a saved file is byte-identical to one
 *    built from `{}` literals.
 */

/** Key segments the setter never writes (fix-i18n.mjs reports keys holding one). */
export const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/** Whether `obj[part]` is an own object the setter may descend into. */
function isOwnContainer(obj, part) {
  return Object.hasOwn(obj, part) && Boolean(obj[part]) && typeof obj[part] === 'object'
}

/** Set `val` at the dotted `key` inside `obj`; a key naming the prototype chain is ignored. */
export function setNested(obj, key, val) {
  const parts = key.split('.')
  if (parts.some((part) => UNSAFE_SEGMENTS.has(part))) return
  let cur = obj
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return
    if (i === parts.length - 1) {
      cur[part] = val
      return
    }
    if (!isOwnContainer(cur, part)) cur[part] = Object.create(null)
    cur = cur[part]
  }
}
