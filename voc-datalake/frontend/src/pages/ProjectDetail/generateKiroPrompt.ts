/**
 * Generates the Kiro autoseed prompt text for clipboard copy.
 * Single source of truth — used by both AutoseedCard and AutoseedContent.
 */
export function generateKiroPrompt(curlUrl: string): string {
  return `Seed my workspace with project context from VoC Data Lake.

Fetch the project data by running this curl command:

\`\`\`bash
curl -s "${curlUrl}" -H "Authorization: Bearer <YOUR_API_TOKEN>" -o /tmp/voc-autoseed.json
\`\`\`

Then read the JSON response. It contains a top-level \`project\` object (name/description metadata) and a \`files\` array where each entry has a \`path\` and \`content\`. Write each file to my workspace at the specified path.

If two entries resolve to the same \`path\` (for example, a PRD and a PR/FAQ that share a slug), do not overwrite — preserve both by appending a short disambiguating suffix to the later one (e.g. \`-prd.md\` / \`-prfaq.md\`). Never silently drop a file.

The files include:
- \`.kiro/steering/project-*.md\` — A steering file with project context, persona references, and implementation guidance
- \`.kiro/personas/*.md\` — One markdown file per user persona
- \`.kiro/docs/*.md\` — PRDs, PR/FAQs, and research documents

After writing the files, make sure the steering file (\`.kiro/steering/project-*.md\`) references each persona and document with a \`#[[file:...]]\` line so Kiro automatically pulls their contents into context — for example \`#[[file:.kiro/personas/stefan-hoffmann.md]]\` or \`#[[file:.kiro/docs/real-time-delivery-tracking.md]]\`. If those references aren't already present in the steering file, add one line per persona and document. (Steering files are always included, but listing a document by name alone does not load it; only a \`#[[file:...]]\` reference pulls in the referenced file's contents.)

Replace \`<YOUR_API_TOKEN>\` with your API token from the MCP Access tab.`
}
