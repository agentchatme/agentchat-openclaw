/**
 * The bundled manual is `https://agentchat.me/skill.md`, verbatim — the floor
 * the self-updating copy in OpenClaw's managed skills dir starts from (and
 * the sync's fallback). These
 * tests pin the parts the integration relies on: the frontmatter OpenClaw reads,
 * the anchor-line section the identity placement is kept in lockstep with,
 * the gate verbs the turn prompt names, and that the skill ships.
 */

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const skillPath = join(here, '..', 'skills', 'agentchat', 'SKILL.md')
const pkgPath = join(here, '..', 'package.json')
const manifestPath = join(here, '..', 'openclaw.plugin.json')

/**
 * The manual this release bundles: the version and sha256 AgentChat serves
 * (`GET /v1/texts` announces both). The bundled copy is re-fetched at
 * release time; change these two with it.
 */
const MANUAL_VERSION = '2.4.4'
const MANUAL_SHA256 = '7826ac17ce9ec6b1cf6dd0469170c19183439e4d88d006aa9f3050954b618ce4'

function extractFrontmatter(md: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md)
  return match?.[1] ?? ''
}

describe('bundled agentchat manual', () => {
  const text = readFileSync(skillPath, 'utf8')

  it(`is manual ${MANUAL_VERSION} byte for byte: the sha256 AgentChat serves and pins (MANUAL_SHA256)`, () => {
    expect(createHash('sha256').update(readFileSync(skillPath)).digest('hex')).toBe(MANUAL_SHA256)
  })

  it(`starts with the published frontmatter: name, version ${MANUAL_VERSION}, description, homepage`, () => {
    const fm = extractFrontmatter(text)
    expect(fm).toMatch(/^name:\s*agentchat\s*$/m)
    expect(/^version:\s*(\S+)\s*$/m.exec(fm)?.[1]).toBe(MANUAL_VERSION)
    expect(fm).toMatch(/^description:\s+.{30,}/m)
    expect(fm).toMatch(/^homepage:\s*https:\/\/agentchat\.me\s*$/m)
  })

  it(`carries the sections the integration points the agent at (manual ${MANUAL_VERSION} wording)`, () => {
    expect(text).toMatch(/^## Be reachable: identity, wake, live conversations/m)
    expect(text).toMatch(/^### 1\. The identity line/m)
    expect(text).toMatch(/^### 2\. Being woken/m)
    expect(text).toMatch(/^### 3\. The tray, your verdicts, and live conversations/m)
    expect(text).toMatch(/^## Security — read once, never violate/m)
    expect(text).toMatch(/^## Send a message/m)
    expect(text).toMatch(/^## Groups/m)
    expect(text).toMatch(/^### What each answer tells you/m)
  })

  it('names the three verdicts the server accepts, recorded with agentchat_decide; a send alone marks nothing', () => {
    expect(text).toMatch(/\*\*Per card, record `agentchat_decide`\*\* with the card's `preview\.message_id` as `through_message_id`/)
    expect(text).toMatch(/\*\*`dismiss`\*\* when/)
    expect(text).toMatch(/\*\*`defer`\*\* when/)
    expect(text).toMatch(/\*\*`reply`\*\* when/)
    expect(text).toMatch(/A send marks nothing read: record your `reply` verdict/)
    // 2.2.2: reply is recorded after the send, never before — the same order
    // this integration follows (reply recorded when the turn completes).
    expect(text).toContain('`dismiss` and `defer` right away, `reply` only after your answer is sent')
    expect(text).not.toMatch(/the send is (your |the )?verdict|record the verdict first/i)
  })

  it('2.4.2 on: the key goes only to api.agentchat.me — a person who wants to see the conversations gets a claim link, never the key', () => {
    expect(text).toContain('**Send the key to exactly one place: `api.agentchat.me`**')
    expect(text).toContain('To let a person see your conversations, give them a claim link instead')
    expect(text).not.toMatch(/\*\*Your human owner\*\* — once/)
    expect(text).not.toMatch(/paste your API key/)
  })

  it('2.4.3: no curl line names the key variable on the same line as its URL (install scanners read that as exfiltration); the header is on its own continuation line', () => {
    for (const line of text.split('\n')) {
      if (/\$AGENTCHAT_API_KEY/.test(line)) expect(line).not.toMatch(/https?:\/\//)
    }
    expect(text).toMatch(/\\\n {2}-H "Authorization: Bearer \$AGENTCHAT_API_KEY"/)
  })

  it('tells OpenClaw users to prefer this integration', () => {
    expect(text).toMatch(/Prefer the OpenClaw integration \(`@agentchatme\/openclaw`\)/)
  })

  it('2.4.4: the OpenClaw install is the package name, its two questions told per source, and a reinstall after uninstall is enabled first', () => {
    expect(text).toContain('run `openclaw plugins install @agentchatme/openclaw` in a terminal')
    expect(text).toContain('whether to go ahead with the install and whether to accept the plugin\'s capabilities')
    expect(text).toContain('from OpenClaw 2026.11.5 the bare name installs from ClawHub; earlier releases install it from npm, and the first question asks whether to install a source outside ClawHub')
    expect(text).toContain('After `openclaw plugins uninstall`, a reinstall stays switched off (`openclaw channels add` then answers `Unknown channel "agentchat"`): `openclaw plugins enable agentchat` first.')
    expect(text).not.toMatch(/it asks two y\/N questions \(installing a source outside ClawHub/)
  })

  it('carries the identity-line text block with the <handle> placeholder', () => {
    const heading = text.indexOf('### 1. The identity line')
    const fence = text.indexOf('```text', heading)
    const block = text.slice(fence, text.indexOf('```', fence + 7))
    expect(block).toContain('I am @<handle> on AgentChat (api.agentchat.me).')
    expect(block).toContain('agentchat_inbox first and decide per card')
    expect(block).toContain('https://agentchat.me/skill.md')
  })
})

describe('manual is packaged for distribution', () => {
  it('package.json files array includes "skills"', () => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { files: string[] }
    expect(pkg.files).toContain('skills')
  })

  it('openclaw.plugin.json declares ["./skills"]', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { skills: string[] }
    expect(manifest.skills).toEqual(['./skills'])
  })
})
