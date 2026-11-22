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

import { writeAgentsAnchor, removeAgentsAnchor, resolveWorkspaceDir, inspectAgentsAnchor, readAgentsAnchor } from '../../src/binding/agents-anchor.js'
import { integration } from 'agentchatme'

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
    it('uses agents.defaults.workspace when set', async () => {
      expect(resolveWorkspaceDir(cfgFor('/some/explicit/path'))).toBe(path.resolve('/some/explicit/path'))
    })

    it('falls back to <state dir>/workspace when config is undefined (OPENCLAW_STATE_DIR is set by the test setup)', async () => {
      expect(resolveWorkspaceDir(undefined)).toBe(path.join(path.resolve(process.env.OPENCLAW_STATE_DIR!), 'workspace'))
    })

    it('falls back to the state-dir default when workspace is empty/whitespace', async () => {
      expect(resolveWorkspaceDir(cfgFor('   '))).toBe(path.join(path.resolve(process.env.OPENCLAW_STATE_DIR!), 'workspace'))
    })

    it('honors OPENCLAW_PROFILE (~/.openclaw-<profile>/workspace) when no state dir is set', async () => {
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

    it('explicit cfg override beats the environment', async () => {
      const original = process.env['OPENCLAW_PROFILE']
      try {
        process.env['OPENCLAW_PROFILE'] = 'staging'
        expect(resolveWorkspaceDir(cfgFor('/explicit/override'))).toBe(path.resolve('/explicit/override'))
      } finally {
        if (original === undefined) delete process.env['OPENCLAW_PROFILE']
        else process.env['OPENCLAW_PROFILE'] = original
      }
    })

    it('uses the per-agent workspace for the agent the account wakes', async () => {
      const cfg = {
        agents: { defaults: { workspace: '/default/ws' }, entries: { main: {}, ops: { workspace: '/ops/ws' } } },
      }
      expect(resolveWorkspaceDir(cfg as never, 'ops')).toBe(path.resolve('/ops/ws'))
      expect(resolveWorkspaceDir(cfg as never, 'main')).toBe(path.resolve('/default/ws'))
    })
  })

  describe('writeAgentsAnchor', () => {
    it('creates the workspace dir when it does not exist (first-run install) and writes the text it was given, fenced with the kit handle line', async () => {
      const workspace = path.join(tmpDir, 'workspace-fresh')
      expect(fs.existsSync(workspace)).toBe(false)
      await writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      const file = path.join(workspace, 'AGENTS.md')
      expect(fs.existsSync(file)).toBe(true)
      const content = fs.readFileSync(file, 'utf-8')
      expect(content).toBe(`<!-- agentchat:start -->\n<!-- agentchat:handle alice -->\n${IDENTITY_LINE}\n<!-- agentchat:end -->\n`)
      expect(readAgentsAnchor({ cfg: cfgFor(workspace) })).toEqual({ present: true, text: IDENTITY_LINE, path: file })
    })

    it('refuses a text that does not name the handle (nothing written), an empty handle or an empty text', async () => {
      const workspace = path.join(tmpDir, 'workspace')
      await expect(writeAgentsAnchor({ cfg: cfgFor(workspace), handle: '', text: IDENTITY_LINE })).rejects.toThrow(/handle is empty/u)
      await expect(writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: '   ' })).rejects.toThrow(/identity line is empty/u)
      await expect(writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'carol', text: IDENTITY_LINE })).rejects.toThrow(/no served identity text names @carol/u)
      expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(false)
    })

    it('preserves pre-existing AGENTS.md content (does not clobber)', async () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      const userContent = '# My agent\n\nUser-written instructions here.\nDo not lose this.\n'
      fs.writeFileSync(file, userContent, 'utf-8')

      await writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })

      const content = fs.readFileSync(file, 'utf-8')
      expect(content).toContain('# My agent')
      expect(content).toContain('User-written instructions here.')
      expect(content).toContain('Do not lose this.')
      expect(content).toContain('<!-- agentchat:start -->')
      expect(content).toContain('@alice')
    })

    it('is idempotent — re-running with the same text does not duplicate', async () => {
      const workspace = path.join(tmpDir, 'workspace')
      for (let i = 0; i < 3; i++) await writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      const content = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')
      expect(content.split('<!-- agentchat:start -->').length).toBe(2)
      expect(content.split('<!-- agentchat:end -->').length).toBe(2)
    })

    it('upserts on handle or text change — replaces the old block, a single block remains', async () => {
      const workspace = path.join(tmpDir, 'workspace')
      await writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      await writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'bob', text: identityLineFor('bob') })
      const content = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')
      expect(content).toContain('@bob')
      expect(content).not.toContain('@alice')
      expect(content.split('<!-- agentchat:start -->').length).toBe(2)
    })

    it('does not accumulate blank lines on repeated runs (no drift)', async () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      fs.writeFileSync(file, '# Header\n\nBody\n', 'utf-8')
      const lengths: number[] = []
      for (let i = 0; i < 5; i++) {
        await writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
        lengths.push(fs.readFileSync(file, 'utf-8').length)
      }
      for (const len of lengths.slice(1)) expect(len).toBe(lengths[0])
    })
  })

  describe('inspectAgentsAnchor (status, doctor: strict, local reads)', () => {
    it('with the served text: the kit decision; without it: whose block it is, by its handle line', async () => {
      const workspace = path.join(tmpDir, 'workspace')
      await writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      expect(inspectAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', identityLine: IDENTITY_LINE }).outcome).toBe('unchanged')
      expect(inspectAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', identityLine: `${IDENTITY_LINE}\nnewer` }).outcome).toBe('updated')
      expect(inspectAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' }).outcome).toBe('unverified')
      expect(inspectAgentsAnchor({ cfg: cfgFor(workspace), handle: '@alice', identityLine: null }).outcome).toBe('unverified')
      expect(inspectAgentsAnchor({ cfg: cfgFor(workspace), handle: 'bob' })).toMatchObject({ outcome: 'other_agent', claimed: 'alice' })
      expect(inspectAgentsAnchor({ cfg: cfgFor(workspace), handle: 'bob', identityLine: identityLineFor('bob') })).toMatchObject({ outcome: 'other_agent', claimed: 'alice' })
      expect(inspectAgentsAnchor({ cfg: cfgFor(path.join(tmpDir, 'nowhere')), handle: 'alice' }).outcome).toBe('absent')
    })
  })

  describe('removeAgentsAnchor', () => {
    it('strips the anchor block, leaves user content intact', async () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      fs.writeFileSync(file, '# Header\n\nUser body.\n', 'utf-8')
      await writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      expect((await removeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })).outcome).toBe('removed')
      const after = fs.readFileSync(file, 'utf-8')
      expect(after).toContain('# Header')
      expect(after).toContain('User body.')
      expect(after).not.toContain('agentchat:start')
      expect(after).not.toContain('@alice')
    })

    it('is a no-op when the anchor was never written, or AGENTS.md does not exist', async () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Header\n', 'utf-8')
      expect((await removeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })).outcome).toBe('absent')
      expect(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')).toBe('# Header\n')
      const empty = path.join(tmpDir, 'workspace-empty')
      fs.mkdirSync(empty, { recursive: true })
      expect((await removeAgentsAnchor({ cfg: cfgFor(empty), handle: 'alice' })).outcome).toBe('absent')
      expect(fs.existsSync(path.join(empty, 'AGENTS.md'))).toBe(false)
    })

    it('handles a workspace where the file holds ONLY our anchor (clean delete)', async () => {
      const workspace = path.join(tmpDir, 'workspace')
      await writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      expect((await removeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })).outcome).toBe('removed')
      const after = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')
      expect(after).not.toContain('agentchat:start')
      expect(after).not.toContain('@alice')
    })
  })

  describe('legacy marker migration', () => {
    it('strips a legacy `agentchat-skill:` block when writing the unified block', async () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      const legacyBlock = ['# User content', '', '<!-- agentchat-skill:start -->', '## On AgentChat (legacy block)', 'You are **@alice**...', '<!-- agentchat-skill:end -->', '', '## Other user content'].join('\n')
      fs.writeFileSync(file, legacyBlock + '\n', 'utf-8')
      await writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice', text: IDENTITY_LINE })
      const content = fs.readFileSync(file, 'utf-8')
      expect(content).not.toContain('<!-- agentchat-skill:start -->')
      expect(content).not.toContain('legacy block')
      expect(content).toContain('<!-- agentchat:start -->')
      expect(content).toContain(IDENTITY_LINE)
      expect(content).toContain('# User content')
      expect(content).toContain('## Other user content')
    })

    it("removeAgentsAnchor removes this agent's legacy block (a line AgentChat served, in the old fences); a legacy block beside a current one is several blocks, left", async () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      const earlier = integration.anchor.EARLIER_IDENTITY_LINES[1]!.split('<handle>').join('alice')
      fs.writeFileSync(file, ['# Header', '', '<!-- agentchat-skill:start -->', earlier, '<!-- agentchat-skill:end -->', '', '## Tail', ''].join('\n'), 'utf-8')
      expect((await removeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })).outcome).toBe('removed')
      const content = fs.readFileSync(file, 'utf-8')
      expect(content).not.toContain('agentchat-skill:start')
      expect(content).toContain('# Header')
      expect(content).toContain('## Tail')

      const mixed = ['# Header', '', '<!-- agentchat-skill:start -->', 'Legacy block.', '<!-- agentchat-skill:end -->', '', '<!-- agentchat:start -->', 'Unified block.', '<!-- agentchat:end -->', '', '## Tail'].join('\n') + '\n'
      fs.writeFileSync(file, mixed, 'utf-8')
      expect((await removeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })).outcome).toBe('several_blocks')
      expect(fs.readFileSync(file, 'utf-8')).toBe(mixed)
    })
  })
})
