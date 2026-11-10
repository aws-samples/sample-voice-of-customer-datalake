/** An error's name for a log line (never its message: it may quote data). */
export function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}
