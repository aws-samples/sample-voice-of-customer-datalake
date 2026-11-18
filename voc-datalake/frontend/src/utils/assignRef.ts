/**
 * @fileoverview Hands a value to a React ref of either kind (a callback or an object), so one element or handle can
 * be given to its own ref and to a caller's (the Tooltip's trigger, the document review view's editor handle).
 *
 * @module utils/assignRef
 */
import type { Ref } from 'react'

export function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref !== null && ref !== undefined) ref.current = value
}
