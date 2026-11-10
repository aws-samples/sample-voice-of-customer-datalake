/**
 * Narrowing helpers for specs under `noUncheckedIndexedAccess`.
 *
 * An indexed read (`rows[0]`, `record[key]`) is `T | undefined`. In a spec the
 * element is expected to exist, so rather than a non-null assertion these
 * throw a message naming what was missing — the test fails loudly and at the
 * read, never later with a confusing `Cannot read properties of undefined`.
 */

/** `value`, or throw `"<label> is undefined"` when it is `undefined`. */
export function defined<T>(value: T | undefined, label = 'value'): T {
  if (value === undefined) {
    throw new Error(`${label} is undefined`)
  }
  return value
}

/**
 * `list[index]`, or throw when the index is out of range. Negative indexes
 * count from the end, like `Array.prototype.at`.
 */
export function at<T>(list: ArrayLike<T>, index: number, label = 'list'): T {
  const resolved = index < 0 ? list.length + index : index
  if (resolved < 0 || resolved >= list.length) {
    throw new Error(`${label}[${index}] is out of range (length ${list.length})`)
  }
  return defined(list[resolved], `${label}[${index}]`)
}
