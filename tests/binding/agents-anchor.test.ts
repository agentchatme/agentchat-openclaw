/**
 * agents-anchor: production-readiness coverage.
 *
 * These tests exercise the real filesystem path against a per-test temp
 * directory. We don't stub `fs` — the whole point is to verify the anchor
 * lands on disk the way OpenClaw's bootstrap loader will read it back. The
 * text itself is whatever the caller hands in (the served identity line);
 * this module only places it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { writeAgentsAnchor, removeAgentsAnchor, resolveWorkspaceDir, hasAgentsAnchorFor, readAgentsAnchor } from '../../src/binding/agents-anchor.js'
import { IDENTITY_LINE, identityLineFor } from '../helpers/texts.js'

function cfgFor(workspaceDir: string): { agents: { defaults: { workspace: string } } } {
  return { agents: { defaults: { workspace: workspaceDir } } }
}

describe('agents-anchor', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-anchor-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('resolveWorkspaceDir', () => {
    it('uses agents.defaults.workspace when set', () => {
      expect(resolveWorkspaceDir(cfgFor('/some/explicit/path'))).toBe(path.resolve('/some/explicit/path'))
    })

    it('falls back to <state dir>/workspace when config is undefined (OPENCLAW_STATE_DIR is set by the test setup)', () => {
      expect(resolveWorkspaceDir(undefined)).toBe(path.join(path.resolve(process.env.OPENCLAW_STATE_DIR!), 'workspace'))
    })

    it('falls back to the state-dir default when workspace is empty/whitespace', () => {
      expect(resolveWorkspaceDir(cfgFor('   '))).toBe(path.join(path.resolve(process.env.OPENCLAW_STATE_DIR!), 'workspace'))
    })

    it('honors OPENCLAW_PROFILE (~/.openclaw-<profile>/workspace) when no state dir is set', () => {
      const stateDir = process.env['OPENCLAW_STATE_DIR']
      const original = process.env['OPENCLAW_PROFILE']
      try {
        delete process.env['OPENCLAW_STATE_DIR']
        process.env['OPENCLAW_PROFILE'] = 'staging'
        expect(resolveWorkspaceDir(undefined)).toBe(path.join(os.homedir(), '.openclaw-staging', 'workspace'))
        process.env['OPENCLAW_PROFILE'] = 'default'
        expect(resolveWorkspaceDir(undefined)).toBe(path.join(os.homedir(), '.openclaw', 'workspace'))
      } finally {
        if (original === undefined) delete process.env['OPENCLAW_PROFILE']
        else process.env['OPENCLAW_PROFILE'] = original
        if (stateDir !== undefined) process.env['OPENCLAW_STATE_DIR'] = stateDir
      }
    })

    it('explicit cfg override beats the environment', () => {
      const original = process.env['OPENCLAW_PROFILE']
      try {
        process.env['OPENCLAW_PROFILE'] = 'staging'
        expect(resolveWorkspaceDir(cfgFor('/explicit/override'))).toBe(path.resolve('/explicit/override'))
      } finally {
        if (original === undefined) delete process.env['OPENCLAW_PROFILE']
        else process.env['OPENCLAW_PROFILE'] = original
      }
    })

    it('uses the per-agent workspace for the agent the account wakes', () => {
      const cfg = {
        agents: { defaults: { workspace: '/default/ws' }, entries: { main: {}, ops: { workspace: '/ops/ws' } } },
      }
      expect(resolveWorkspaceDir(cfg as never, 'ops')).toBe(path.resolve('/ops/ws'))
      expect(resolveWorkspaceDir(cfg as never, 'main')).toBe(path.resolve('/default/ws'))
    })
  })

  describe('writeAgentsAnchor', () => {
    it('creates the workspace dir when it does not exist (first-run install) and writes the text it was given, fenced', () => {
      const workspace = path.join(tmpDir, 'workspace-fresh')
      expect(fs.existsSync(workspace)).toBe(false)
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      const file = path.join(workspace, 'AGENTS.md')
      expect(fs.existsSync(file)).toBe(true)
      const content = fs.readFileSync(file, 'utf-8')
      expect(content).toBe(`<!-- agentchat:start -->\n${IDENTITY_LINE}\n<!-- agentchat:end -->\n`)
      expect(readAgentsAnchor({ cfg: cfgFor(workspace) })).toEqual({ present: true, text: IDENTITY_LINE, path: file })
    })

    it('verifies the handle landed (the served text names it) and refuses an empty handle or text', () => {
      const workspace = path.join(tmpDir, 'workspace')
      expect(() => writeAgentsAnchor({ cfg: cfgFor(workspace), handle: '', text: IDENTITY_LINE })).toThrow(/handle is empty/u)
      expect(() => writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: '   ' })).toThrow(/identity line is empty/u)
      expect(() => writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'carol', text: IDENTITY_LINE })).toThrow(/@carol did not land/u)
    })

    it('preserves pre-existing AGENTS.md content (does not clobber)', () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      const userContent = '# My agent\n\nUser-written instructions here.\nDo not lose this.\n'
      fs.writeFileSync(file, userContent, 'utf-8')

      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })

      const content = fs.readFileSync(file, 'utf-8')
      expect(content).toContain('# My agent')
      expect(content).toContain('User-written instructions here.')
      expect(content).toContain('Do not lose this.')
      expect(content).toContain('<!-- agentchat:start -->')
      expect(content).toContain('@alice')
    })

    it('is idempotent — re-running with the same text does not duplicate', () => {
      const workspace = path.join(tmpDir, 'workspace')
      for (let i = 0; i < 3; i++) writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      const content = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')
      expect(content.split('<!-- agentchat:start -->').length).toBe(2)
      expect(content.split('<!-- agentchat:end -->').length).toBe(2)
    })

    it('upserts on handle or text change — replaces the old block, a single block remains', () => {
      const workspace = path.join(tmpDir, 'workspace')
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'bob', text: identityLineFor('bob') })
      const content = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')
      expect(content).toContain('@bob')
      expect(content).not.toContain('@alice')
      expect(content.split('<!-- agentchat:start -->').length).toBe(2)
    })

    it('does not accumulate blank lines on repeated runs (no drift)', () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      fs.writeFileSync(file, '# Header\n\nBody\n', 'utf-8')
      const lengths: number[] = []
      for (let i = 0; i < 5; i++) {
        writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
        lengths.push(fs.readFileSync(file, 'utf-8').length)
      }
      for (const len of lengths.slice(1)) expect(len).toBe(lengths[0])
    })
  })

  describe('hasAgentsAnchorFor', () => {
    it('with the served text: exact match; without it: any of our blocks naming the handle', () => {
      const workspace = path.join(tmpDir, 'workspace')
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      expect(hasAgentsAnchorFor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE }).present).toBe(true)
      expect(hasAgentsAnchorFor({ cfg: cfgFor(workspace), handle: 'alice', text: `${IDENTITY_LINE}\nnewer` }).present).toBe(false)
      expect(hasAgentsAnchorFor({ cfg: cfgFor(workspace), handle: 'alice' }).present).toBe(true)
      expect(hasAgentsAnchorFor({ cfg: cfgFor(workspace), handle: '@alice', text: null }).present).toBe(true)
      expect(hasAgentsAnchorFor({ cfg: cfgFor(workspace), handle: 'bob' }).present).toBe(false)
      expect(hasAgentsAnchorFor({ cfg: cfgFor(path.join(tmpDir, 'nowhere')), handle: 'alice' }).present).toBe(false)
    })
  })

  describe('removeAgentsAnchor', () => {
    it('strips the anchor block, leaves user content intact', () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      fs.writeFileSync(file, '# Header\n\nUser body.\n', 'utf-8')
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      expect(removeAgentsAnchor({ cfg: cfgFor(workspace) }).removed).toBe(true)
      const after = fs.readFileSync(file, 'utf-8')
      expect(after).toContain('# Header')
      expect(after).toContain('User body.')
      expect(after).not.toContain('agentchat:start')
      expect(after).not.toContain('@alice')
    })

    it('is a no-op when the anchor was never written, or AGENTS.md does not exist', () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Header\n', 'utf-8')
      expect(removeAgentsAnchor({ cfg: cfgFor(workspace) }).removed).toBe(false)
      expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')).toBe('# Header\n')
      const empty = path.join(tmpDir, 'workspace-empty')
      fs.mkdirSync(empty, { recursive: true })
      expect(removeAgentsAnchor({ cfg: cfgFor(empty) }).removed).toBe(false)
      expect(fs.existsSync(path.join(empty, 'AGENTS.md'))).toBe(false)
    })

    it('handles a workspace where the file holds ONLY our anchor (clean delete)', () => {
      const workspace = path.join(tmpDir, 'workspace')
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      expect(removeAgentsAnchor({ cfg: cfgFor(workspace) }).removed).toBe(true)
      const after = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')
      expect(after).not.toContain('agentchat:start')
      expect(after).not.toContain('@alice')
    })
  })

  describe('legacy marker migration', () => {
    it('strips a legacy `agentchat-skill:` block when writing the unified block', () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      const legacyBlock = ['# User content', '', '<!-- agentchat-skill:start -->', '## On AgentChat (legacy block)', 'You are **@alice**...', '<!-- agentchat-skill:end -->', '', '## Other user content'].join('\n')
      fs.writeFileSync(file, legacyBlock + '\n', 'utf-8')
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      const content = fs.readFileSync(file, 'utf-8')
      expect(content).not.toContain('<!-- agentchat-skill:start -->')
      expect(content).not.toContain('legacy block')
      expect(content).toContain('<!-- agentchat:start -->')
      expect(content).toContain(IDENTITY_LINE)
      expect(content).toContain('# User content')
      expect(content).toContain('## Other user content')
    })

    it('removeAgentsAnchor strips both legacy and unified blocks', () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      const mixed = ['# Header', '', '<!-- agentchat-skill:start -->', 'Legacy block.', '<!-- agentchat-skill:end -->', '', '<!-- agentchat:start -->', 'Unified block.', '<!-- agentchat:end -->', '', '## Tail'].join('\n')
      fs.writeFileSync(file, mixed + '\n', 'utf-8')
      expect(removeAgentsAnchor({ cfg: cfgFor(workspace) }).removed).toBe(true)
      const content = fs.readFileSync(file, 'utf-8')
      expect(content).not.toContain('agentchat-skill:start')
      expect(content).not.toContain('agentchat:start')
      expect(content).toContain('# Header')
      expect(content).toContain('## Tail')
    })
  })
})
