/**
 * Front-matter split and joined back byte for byte (§6.5 "SKILL.md front-matter"): every template SKILL.md comes back
 * exactly as stored, its body never starts with `---` (the canvas would read it as a rule and a setext heading), and
 * a text without front-matter (or with an unclosed fence) is all body.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { flatProperties, frontMatterYaml, joinFrontMatter, splitFrontMatter } from './frontMatter'

const AGENTS = join(import.meta.dirname, '../../../../../templates/orchestration/agents')
const SKILLS = readdirSync(AGENTS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(AGENTS, entry.name, 'SKILL.md')))
  .map((entry) => [entry.name, readFileSync(join(AGENTS, entry.name, 'SKILL.md'), 'utf8')] as const)

describe('splitFrontMatter and joinFrontMatter', () => {
  it('reads every template SKILL.md (the walk itself works)', () => {
    expect(SKILLS.length).toBeGreaterThanOrEqual(10)
  })

  it.each(SKILLS)('give %s back byte for byte, with a front-matter and a body that does not start with ---', (_role, text) => {
    const { frontMatter, body } = splitFrontMatter(text)

    expect(joinFrontMatter(frontMatter, body)).toBe(text)
    expect(frontMatter?.startsWith('---\n')).toBe(true)
    expect(body.startsWith('---')).toBe(false)
  })

  it.each([
    ['no front-matter', '# Title\n\nText.'],
    ['an unclosed fence', '---\nname: x\n\n# Title'],
    ['a rule that is not on the first line', 'Intro\n\n---\n\nMore'],
    ['a fence with no line break after it', '---'],
    ['the empty text', ''],
  ])('leave %s all body', (_case, text) => {
    expect(splitFrontMatter(text)).toStrictEqual({ frontMatter: null, body: text })
  })

  it('keeps CRLF line ends and the blank lines after the fence in the front-matter', () => {
    const text = '---\r\nname: x\r\n---\r\n\r\n# Title\r\n'

    expect(splitFrontMatter(text)).toStrictEqual({ frontMatter: '---\r\nname: x\r\n---\r\n\r\n', body: '# Title\r\n' })
  })
})

describe('the Properties of a front-matter', () => {
  it('lists a flat map as pairs, a one-line flow map kept as written', () => {
    const yaml = frontMatterYaml('---\nname: fixer\ndescription: Fixes one bug.\nmetadata: {voc-role: fixer}\n---\n')

    expect(flatProperties(yaml)).toStrictEqual([['name', 'fixer'], ['description', 'Fixes one bug.'], ['metadata', '{voc-role: fixer}']])
  })

  it.each([
    ['a nested map', 'name: x\nmetadata:\n  role: fixer'],
    ['a list', 'tools:\n- read\n- write'],
    ['a block scalar', 'description: |\n  Two\n  lines'],
    ['a comment', '# owned by the template\nname: x'],
  ])('shows %s as stored instead', (_case, yaml) => {
    expect(flatProperties(yaml)).toBeNull()
  })
})
