/**
 * @fileoverview A connection change's failure under its control, in the connections' words (`useConnectionError`: the
 * server's reason for a 400 or a 409, else the status's sentence), announced (`role="alert"`); nothing while it has not
 * failed. The Issues switch and the fork owner's switch.
 *
 * @module pages/Agents/ConnectionChangeError
 */
import { useConnectionError } from './connectionText'

export function ConnectionChangeError({ change }: Readonly<{ change: { isError: boolean; error: unknown } }>) {
  const errorText = useConnectionError()
  return change.isError ? <p role="alert" className="text-[12px] text-danger">{errorText(change.error)}</p> : null
}
