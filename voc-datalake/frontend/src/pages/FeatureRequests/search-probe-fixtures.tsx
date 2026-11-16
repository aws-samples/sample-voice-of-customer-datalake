/** Test probe: renders the router's current path and `?…` so a spec can assert where a link or a move lands. */
import { useLocation } from 'react-router-dom'

export function SearchProbe() {
  const { pathname, search } = useLocation()
  return <output data-testid="search">{`${pathname}${search}`}</output>
}
