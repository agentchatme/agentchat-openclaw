/**
 * The bundled manual is `https://agentchat.me/skill.md`, verbatim. These
 * tests pin the parts the doorbell relies on: the frontmatter OpenClaw reads,
 * the anchor-line section the identity placement is kept in lockstep with,
 * the gate verbs the turn prompt names, and that the skill ships.
 */

import { describe, it, expect } from 'vitest'
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

  it('starts with the published frontmatter: name, version, description, homepage', () => {
    const fm = extractFrontmatter(text)
    expect(fm).toMatch(/^name:\s*agentchat\s*$/m)
    expect(fm).toMatch(/^version:\s*\d+\.\d+\.\d+\s*$/m)
    expect(fm).toMatch(/^description:\s+.{30,}/m)
    expect(fm).toMatch(/^homepage:\s*https:\/\/agentchat\.me\s*$/m)
  })

  it('carries the sections the doorbell points the agent at', () => {
    expect(text).toMatch(/^## Be reachable: identity, doorbell, live conversations/m)
    expect(text).toMatch(/^### 1\. The anchor line \(identity\)/m)
    expect(text).toMatch(/^### 2\. The doorbell \(being woken\)/m)
    expect(text).toMatch(/^### 3\. The tray, the gate, and live conversations/m)
    expect(text).toMatch(/^## Security — read once, never violate/m)
    expect(text).toMatch(/^## Send a message/m)
    expect(text).toMatch(/^## Groups/m)
  })

  it('names the gate verbs the server accepts (dismiss / defer), with the send as the reply verdict', () => {
    expect(text).toMatch(/`agentchat_decide` `dismiss`/)
    expect(text).toMatch(/`agentchat_decide` `defer`/)
    expect(text).toMatch(/The send is your verdict/)
  })

  it('tells OpenClaw users to prefer this plugin', () => {
    expect(text).toMatch(/Prefer the OpenClaw plugin \(`@agentchatme\/openclaw`\)/)
  })

  it('carries the anchor-line text block with the <handle> placeholder', () => {
    const heading = text.indexOf('### 1. The anchor line (identity)')
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
