/**
 * @fileoverview A saved repository connection shown in Agents → Connections' list at once, until the list is read again
 * (which this asks for): the connection dialog's (ConnectionDialog.tsx) and (7.60.00) the token dialog's
 * (TokenConnectionDialog.tsx).
 *
 * @module pages/Agents/savedConnection
 */
import { engineeringConnectionsKeys } from '../../api/engineeringConnectionsApi'
import type { QueryClient } from '@tanstack/react-query'
import type { ConnectionList, EngineeringConnection } from '../../api/engineeringConnectionsApi'

/** The list with the saved connection in it (replaced in place, or added at the end). */
function withSaved(list: ConnectionList | undefined, saved: EngineeringConnection): ConnectionList | undefined {
  if (list === undefined) return list
  const index = list.connections.findIndex((c) => c.connection_id === saved.connection_id)
  return { ...list, connections: index === -1 ? [...list.connections, saved] : list.connections.map((c, i) => (i === index ? saved : c)) }
}

/** `saved` in the list at once, and the list read again. */
export function keepSaved(queryClient: QueryClient, saved: EngineeringConnection): void {
  queryClient.setQueryData<ConnectionList>(engineeringConnectionsKeys.list(), (list) => withSaved(list, saved))
  void queryClient.invalidateQueries({ queryKey: engineeringConnectionsKeys.list() })
}
