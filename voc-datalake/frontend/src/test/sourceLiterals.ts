/**
 * @fileoverview Read constants out of another package's TypeScript source as
 * TEXT, for lockstep specs (the stream Lambda is a separate package, and its
 * un-exported constants must count too).
 */
import { at } from './defined'

/** The quoted strings of `[export ]const NAME = [ ... ] as const` in `source`. */
export function constStringList(source: string, name: string): string[] {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\] as const`).exec(source)
  if (match === null) throw new Error(`${name} array literal not found`)
  return [...at(match, 1).matchAll(/'([^']+)'/g)].map((m) => at(m, 1))
}

/** `[export ]const NAME = { key: 123, ... } as const` in `source` → record. */
export function constNumberRecord(source: string, name: string): Record<string, number> {
  const match = new RegExp(`const ${name} = \\{([^}]*)\\} as const`).exec(source)
  if (match === null) throw new Error(`${name} object literal not found`)
  return Object.fromEntries([...at(match, 1).matchAll(/\b(\w+):\s*([\d_]+)/g)]
    .map((m): [string, number] => [at(m, 1), Number(at(m, 2).replaceAll('_', ''))]))
}
