/**
 * Maximum number of history messages sent to the streaming server.
 *
 * Must stay at or below the server-side cap defined in
 * `lambda/stream/src/schema.ts` (`history: z.array(…).max(50)`).
 * If the server cap is raised, update both files in the same PR.
 * We keep the *newest* entries so the model always sees the most
 * recent turns.
 *
 * Used by both the VOC chat page (`Chat.tsx`) and the project chat
 * tab (`ChatTab.tsx`) which share the same backend endpoint.
 */
export const MAX_HISTORY_ENTRIES = 50
