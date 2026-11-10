/**
 * @fileoverview "Is this the user's landing on the app?" — the moment a
 * per-user start page applies (Home redirects to the dashboard when the user
 * chose that), as opposed to a click on the sidebar's Home link, which must
 * still show Home.
 *
 * A landing is either the first entry of this tab's history (a fresh load or a
 * typed URL: React Router gives it the key `default`) or the redirect after
 * sign-in, which marks itself with `LANDING_STATE`.
 *
 * @module utils/landing
 */
import type { Location } from 'react-router-dom'

/** Router state the sign-in redirect carries so Home can tell it from a nav click. */
export const LANDING_STATE = { landing: true } as const

function carriesLandingMark(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'landing' in state && state.landing === true
}

export function isLanding(location: Pick<Location, 'key' | 'state'>): boolean {
  return location.key === 'default' || carriesLandingMark(location.state)
}
