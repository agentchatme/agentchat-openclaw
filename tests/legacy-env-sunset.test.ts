/**
 * The old setting names this integration still reads, and the date they go.
 *
 * AgentChat's contract v1 lists them under "Old integration settings"
 * (https://agentchat.me/contract/v1/#deprecations), removal 2027-02-01:
 *   - `AGENTCHAT_DOORBELL=v3|off`, replaced by `AGENTCHAT_WAKE=on|off`;
 *   - `AGENTCHAT_REPLY_GATE_FAIL_OPEN`, replaced by nothing (the gate fails
 *     closed and the server re-wakes); already ignored, with a warning.
 *
 * Until that date the readers must stay (the contract promises them). From
 * that date this file fails while `src/` or the user-facing docs still name
 * either variable: delete the readers in `src/credentials/read-env.ts`,
 * their callers, the docs lines and the tests that set them, in the release
 * that drops them. The date is UTC midnight, as the contract's dates are.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Sunset {
  readonly name: string
  readonly removal: string
}

const SUNSETS: readonly Sunset[] = [
  { name: 'AGENTCHAT_DOORBELL', removal: '2027-02-01' },
  { name: 'AGENTCHAT_REPLY_GATE_FAIL_OPEN', removal: '2027-02-01' },
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Where the current behaviour lives. CHANGELOG.md is history and keeps the names. */
const DOCS = ['README.md', 'RUNBOOK.md', 'SECURITY.md']

function removalAt(sunset: Sunset): number {
  const at = Date.parse(`${sunset.removal}T00:00:00Z`)
  if (Number.isNaN(at)) throw new Error(`bad removal date for ${sunset.name}: ${sunset.removal}`)
  return at
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

function readSources(): Map<string, string> {
  const files = [...filesUnder(join(root, 'src')), ...DOCS.map((doc) => join(root, doc))]
  return new Map(files.map((file) => [relative(root, file), readFileSync(file, 'utf8')]))
}

function filesNaming(name: string, sources: ReadonlyMap<string, string>): string[] {
  return [...sources].filter(([, text]) => text.includes(name)).map(([file]) => file)
}

/** The old names still present on or after their removal date, with where. */
function overdue(now: number, sunsets: readonly Sunset[], sources: ReadonlyMap<string, string>): string[] {
  return sunsets
    .filter((sunset) => now >= removalAt(sunset))
    .map((sunset) => ({ sunset, files: filesNaming(sunset.name, sources) }))
    .filter(({ files }) => files.length > 0)
    .map(({ sunset, files }) => `${sunset.name} (removal ${sunset.removal}) is still in ${files.join(', ')}`)
}

describe('old setting names and their removal date', () => {
  const sources = readSources()

  it('the guard: nothing is due the day before, a name still present is due from the date on, a removed one is not', () => {
    const one: Sunset[] = [{ name: 'OLD_NAME', removal: '2027-02-01' }]
    const present = new Map([['src/x.ts', "const OLD = 'OLD_NAME'"]])
    const gone = new Map([['src/x.ts', "const NEW = 'NEW_NAME'"]])
    expect(overdue(Date.parse('2027-01-31T23:59:59.999Z'), one, present)).toEqual([])
    expect(overdue(Date.parse('2027-02-01T00:00:00.000Z'), one, present)).toEqual(['OLD_NAME (removal 2027-02-01) is still in src/x.ts'])
    expect(overdue(Date.parse('2027-02-01T00:00:00.000Z'), one, gone)).toEqual([])
  })

  it('until its date each old name is still read, and the dated check would catch it on the day', () => {
    // Also guards the scan itself: a wrong root would make the dated check pass on nothing.
    for (const sunset of SUNSETS) {
      if (Date.now() >= removalAt(sunset)) continue
      expect(filesNaming(sunset.name, sources), `${sunset.name} is read until ${sunset.removal}`).toContain(join('src', 'credentials', 'read-env.ts'))
      expect(overdue(removalAt(sunset), [sunset], sources)).toHaveLength(1)
    }
  })

  it('no old name is still read on or after its removal date (contract v1: 2027-02-01)', () => {
    const due = overdue(Date.now(), SUNSETS, sources)
    expect(due, `remove the old setting names: ${due.join('; ')}`).toEqual([])
  })
})
