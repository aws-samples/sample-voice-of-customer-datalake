/**
 * @fileoverview The `/chat` route, where the assistant is the page itself (the
 * floating launcher hides there).
 *
 * @module assistant/page/chatRoute
 */
const CHAT_PAGE_PATH = '/chat'

export function isChatRoute(pathname: string): boolean {
  return pathname === CHAT_PAGE_PATH || pathname.startsWith(`${CHAT_PAGE_PATH}/`)
}
