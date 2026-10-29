/** Test probe: renders the router's current `?…` so a spec can assert deep links. */
import { useLocation } from 'react-router-dom'

export function SearchProbe() {
  return <output data-testid="search">{useLocation().search}</output>
}
