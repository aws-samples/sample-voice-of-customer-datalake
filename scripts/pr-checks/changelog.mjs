/**
 * Which CHANGELOG.md release sections a pull request ADDS, and which Keep a Changelog groups they carry.
 *
 * Why it exists: the PR description check needs to know whether a PR is a fix (it then asks for a
 * `Proof:` line and a sibling sweep) and whether it is breaking (it then expects Upgrade notes). PR titles
 * here start with a version, so the title cannot say. Every PR to main adds exactly one release section
 * (.kiro/steering/changelog.md), and that section's groups are the author's own classification of the
 * change: a `### Fixed` group means the release fixes something.
 *
 * Limits: it compares two copies of the file by release version. A section whose heading was renumbered
 * reads as new; groups edited inside an already released section are not seen (that is a rule violation
 * of its own, caught nowhere here).
 */

const RELEASE_HEADING = /^## \[(\d+\.\d{2}\.\d{2})\]/

/** `Map<version, groups[]>` for every release section, e.g. `'5.48.05' => ['Fixed', 'Upgrade notes']`. */
export function releaseSections(changelog) {
  const releases = new Map()
  let current = null
  for (const line of String(changelog ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const release = RELEASE_HEADING.exec(line)
    if (release !== null) {
      current = []
      releases.set(release[1], current)
    } else if (line.startsWith('## ')) {
      current = null
    } else if (current !== null && line.startsWith('### ')) {
      current.push(line.slice(4).trim())
    }
  }
  return releases
}

/** Numeric comparison of two `X.YY.ZZ` versions (negative when `a` is older). */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

/**
 * The release sections in `head` that `base` does not have, newest first: `[{version, groups}]`.
 * Returns null when the head copy is unknown (the caller then cannot classify the PR).
 */
export function addedReleases(baseChangelog, headChangelog) {
  if (headChangelog === null || headChangelog === undefined) return null
  const base = releaseSections(baseChangelog ?? '')
  const added = []
  for (const [version, groups] of releaseSections(headChangelog)) {
    if (!base.has(version)) added.push({ version, groups })
  }
  return added.sort((x, y) => compareVersions(y.version, x.version))
}

/** True when any added release has the named group (case-insensitive), e.g. 'Fixed'. */
export function addsGroup(added, group) {
  const wanted = group.toLowerCase()
  return (added ?? []).some((release) => release.groups.some((name) => name.toLowerCase() === wanted))
}
