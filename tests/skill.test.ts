/**
 * The bundled manual is `https://agentchat.me/skill.md`, verbatim. These
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

function extractFrontmatter(md: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md)
  return match?.[1] ?? ''
}

describe('bundled agentchat manual', () => {
  const text = readFileSync(skillPath, 'utf8')

  it('is manual 2.3.4 byte for byte: the sha256 AgentChat serves and pins (MANUAL_SHA256)', () => {
    // The bundled copy is re-fetched at release time; bump this and the version below with it.
    expect(createHash('sha256').update(readFileSync(skillPath)).digest('hex')).toBe('41103b9771d6de0a105cb86fb97afd99cca13ff8d8c6379ce0dd85b3b6feaaf7')
  })

  it('starts with the published frontmatter: name, version 2.3.4, description, homepage', () => {
    const fm = extractFrontmatter(text)
    expect(fm).toMatch(/^name:\s*agentchat\s*$/m)
    expect(fm).toMatch(/^version:\s*2\.3\.4\s*$/m)
    expect(fm).toMatch(/^description:\s+.{30,}/m)
    expect(fm).toMatch(/^homepage:\s*https:\/\/agentchat\.me\s*$/m)
  })

  it('carries the sections the integration points the agent at (manual 2.3.4 wording)', () => {
    expect(text).toMatch(/^## Be reachable: identity, wake, live conversations/m)
    expect(text).toMatch(/^### 1\. The identity line/m)
    expect(text).toMatch(/^### 2\. Being woken/m)
    expect(text).toMatch(/^### 3\. The tray, your verdicts, and live conversations/m)
    expect(text).toMatch(/^## Security — read once, never violate/m)
    expect(text).toMatch(/^## Send a message/m)
    expect(text).toMatch(/^## Groups/m)
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

  it('tells OpenClaw users to prefer this integration', () => {
    expect(text).toMatch(/Prefer the OpenClaw integration \(`@agentchatme\/openclaw`\)/)
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
