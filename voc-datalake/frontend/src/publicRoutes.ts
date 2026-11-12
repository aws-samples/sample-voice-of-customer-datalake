/**
 * @fileoverview The app's public pages: the top-level routes of routes.tsx outside `ProtectedRoute`.
 *
 * A route's path there carries its params (`/vote/:sessionId`, `/board/*`), so this list names each one's first
 * segment instead; `routes.publicBallot.test.tsx` holds it to the route table, so a new public page is an edit here
 * too. services/crossTabSignOut.ts reads it: another tab's sign-out reloads a public page where it is, not to `/login`.
 *
 * So a public page uses the app's session only while the stored session says signed in (a shared review reads it
 * then, Review.tsx), and never refreshes it (`refreshSession`, or `fetchApi`'s refresh on a 401) on its own: after
 * another tab's sign-out its reload opens signed out, and Amplify's tokens may still be in storage for a moment (the
 * sign-out clears them asynchronously), so a refresh there could sign the last person back in.
 *
 * @module publicRoutes
 */

/** The first segment of every route outside the protected tree. */
export const PUBLIC_ROUTE_ROOTS: readonly string[] = ['/login', '/vote', '/board', '/review', '/unsubscribe']

/** Whether a path as the router sees it (workspace/workspacePath.ts's `appPathname`) is a public page. */
export function isPublicPath(appPath: string): boolean {
  return PUBLIC_ROUTE_ROOTS.some((root) => appPath === root || appPath.startsWith(`${root}/`))
}
