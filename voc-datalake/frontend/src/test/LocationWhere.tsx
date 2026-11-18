/**
 * The router's current path and `?search` on screen (`data-testid="where"`), for specs that check where a page
 * sends a person (LocationSearch shows the search alone).
 */
import { useLocation } from 'react-router-dom'

export default function LocationWhere() {
  const location = useLocation()
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>
}
