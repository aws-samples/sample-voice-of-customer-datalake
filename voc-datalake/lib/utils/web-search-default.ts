/**
 * Web-search deployment default (issue #205): VocWebSearchStack deploys
 * UNLESS explicitly opted out. CLI context arrives as strings, so both the
 * boolean and its string form must opt out.
 */
export function shouldDeployWebSearch(contextValue: unknown): boolean {
  return !(contextValue === false || contextValue === 'false');
}
