/**
 * The router's current `?search` on screen (`data-testid="search"`), for specs that check what a
 * page writes to its URL.
 */
import { useLocation } from 'react-router-dom'

export default function LocationSearch() {
  return <output data-testid="search">{useLocation().search}</output>
}
