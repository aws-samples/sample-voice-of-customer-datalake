/** A spec read an index that the recorded calls, messages or blocks do not have. */
class MissingElementError extends Error {
  constructor(index: number, length: number) {
    super(`expected an element at index ${index}, but there are only ${length}`);
    this.name = 'MissingElementError';
  }
}

/**
 * Index access for specs under `noUncheckedIndexedAccess`: the element at `index`,
 * or a thrown MissingElementError — so a spec that expected a recorded call,
 * message or block fails loudly instead of reading through `undefined`.
 */
export function nth<T>(items: ArrayLike<T>, index: number): T {
  const item = items[index];
  if (item === undefined) throw new MissingElementError(index, items.length);
  return item;
}
