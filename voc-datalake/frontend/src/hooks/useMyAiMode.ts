/**
 * @fileoverview The signed-in person's way of working with AI (`GET /users/me/ai-mode`).
 *
 * While it loads, or when the read fails, it answers the default (AI-driven): the
 * editor then offers the AI buttons, and the Projects API, which enforces the mode
 * (`lambda/shared/ai_writing.py`), refuses a write the mode does not allow with a
 * message saying why. The SPA never relaxes the server's answer.
 *
 * @module hooks/useMyAiMode
 */
import { useQuery } from '@tanstack/react-query'
import { aiModeApi, DEFAULT_AI_MODE } from '../api/aiModeApi'
import type { AiMode } from '../api/aiModeApi'
import { myAiModeKey } from '../api/queryKeys'

/** An admin's change shows up within a minute (and on every reload). */
const STALE_MS = 60_000

export function useMyAiMode(): AiMode {
  const { data } = useQuery({ queryKey: myAiModeKey(), queryFn: aiModeApi.mine, staleTime: STALE_MS })
  return data ?? DEFAULT_AI_MODE
}
