/**
 * @fileoverview Leaving the SPA for a URL the API vouched for: Cognito's sign-in after an approval,
 * or the assistant's validated redirect after a denial (MCP OAuth consent, docs/mcp.md). Its own
 * module so tests can observe the navigation without replacing `window.location`.
 *
 * @module pages/OAuthConsent/leaveApp
 */
export function leaveTo(url: string): void {
  window.location.assign(url)
}
