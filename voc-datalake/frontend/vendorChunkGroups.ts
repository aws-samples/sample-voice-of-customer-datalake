/** True when a module id lives in `pkg`'s folder under some node_modules (either path separator). */
function isInPackage(moduleId: string, pkg: string): boolean {
  return moduleId.replaceAll('\\', '/').includes(`/node_modules/${pkg}/`)
}

/** The fields of a Rolldown `codeSplitting.groups` entry vite.config.ts sets. */
export interface VendorChunkGroup {
  readonly name: string
  readonly test: (moduleId: string) => boolean
  readonly priority: number
  readonly tags?: ['$initial']
}

/**
 * Two Rolldown code-splitting groups per vendorChunks.json entry, both named after it. The first takes the
 * package modules the app shell loads (`$initial`) and is claimed first, so a package shared by two vendors
 * lands in the one the shell needs; the second takes the rest. A lazily imported entry of a shell package
 * (`react-dom/server`, used only by the print exports) then gets a lazy chunk of its own instead of riding
 * in `vendor-react` on every first load. Within a tier, the earlier entry wins, so React (listed first)
 * never rides in a later vendor's chunk. Each group also captures its packages' dependencies.
 */
export function vendorChunkGroups(chunks: Readonly<Record<string, readonly string[]>>): VendorChunkGroup[] {
  const entries = Object.entries(chunks)
  const groupsFor = (tier: 'initial' | 'lazy'): VendorChunkGroup[] => entries.map(([name, packages]) => ({
    name,
    test: (moduleId: string) => packages.some((pkg) => isInPackage(moduleId, pkg)),
    priority: tier === 'initial' ? 1 : 0,
    ...(tier === 'initial' ? { tags: ['$initial'] } : {}),
  }))
  return [...groupsFor('initial'), ...groupsFor('lazy')]
}
