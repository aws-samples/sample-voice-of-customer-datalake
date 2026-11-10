/**
 * The slice of Vite's `import.meta.glob` the plan fixtures use in specs
 * (`assistant/plan/plan-fixtures.ts`; vitest resolves it at transform time).
 * Ambient and stream-only: the SPA's spec program imports that fixture file too
 * and gets the same name from `vite/client`, so this must not be imported.
 */
interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true; import: 'default'; query?: string }): Record<string, T>;
}
