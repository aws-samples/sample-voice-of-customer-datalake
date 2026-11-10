/**
 * Pre-turn reads that must never hold up or fail a run (company brief, category restriction):
 * the read's answer, or `fallback` when it throws or takes longer than `timeoutMs`. A failure
 * logs `label` and the error class only — never a message, which could carry user text.
 */
export async function failOpen<T>(read: () => Promise<T>, fallback: T, timeoutMs: number, label: string): Promise<T> {
  const timer: { id?: ReturnType<typeof setTimeout> } = {};
  const timeout = new Promise<T>((resolve) => {
    timer.id = setTimeout(() => resolve(fallback), timeoutMs);
  });
  try {
    return await Promise.race([read(), timeout]);
  } catch (err) {
    console.warn(`${label} (${err instanceof Error ? err.name : 'unknown'})`);
    return fallback;
  } finally {
    clearTimeout(timer.id);
  }
}
