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

/** A folder inside a package (`@tiptap/react/dist/menus`), not the package itself (`@tiptap/react`, `react`). */
const isFolderOfPackage = (entry: string): boolean => entry.split('/').length > (entry.startsWith('@') ? 2 : 1)

/**
 * Two Rolldown code-splitting groups per vendorChunks.json entry, both named after it. The first takes the
 * package modules the app shell loads (`$initial`) and is claimed first, so a package shared by two vendors
 * lands in the one the shell needs; the second takes the rest. A lazily imported entry of a shell package
 * (`react-dom/server`, used only by the print exports) then gets a lazy chunk of its own instead of riding
 * in `vendor-react` on every first load. Within a tier, the earlier entry wins, so React (listed first)
 * never rides in a later vendor's chunk. Each group also captures its packages' dependencies.
 *
 * An entry may name a folder inside a package another entry lists (`@tiptap/react/dist/menus` beside
 * `@tiptap/react`): that folder belongs to its own entry only, so a part of a package that loads later (the
 * editor's menus) gets out of the chunk the rest of the package loads in.
 */
export function vendorChunkGroups(chunks: Readonly<Record<string, readonly string[]>>): VendorChunkGroup[] {
  const entries = Object.entries(chunks)
  const folders = entries.flatMap(([name, packages]) => packages.filter(isFolderOfPackage).map((folder) => ({ name, folder })))
  const claimedElsewhere = (name: string, moduleId: string) =>
    folders.some((entry) => entry.name !== name && isInPackage(moduleId, entry.folder))
  const groupsFor = (tier: 'initial' | 'lazy'): VendorChunkGroup[] => entries.map(([name, packages]) => ({
    name,
    test: (moduleId: string) => packages.some((pkg) => isInPackage(moduleId, pkg)) && !claimedElsewhere(name, moduleId),
    priority: tier === 'initial' ? 1 : 0,
    ...(tier === 'initial' ? { tags: ['$initial'] } : {}),
  }))
  return [...groupsFor('initial'), ...groupsFor('lazy')]
}
