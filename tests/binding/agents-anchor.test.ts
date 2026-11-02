/**
 * agents-anchor: production-readiness coverage.
 *
 * These tests exercise the real filesystem path against a per-test
 * temp directory. We don't stub `fs` — the whole point is to verify
 * the anchor lands on disk the way OpenClaw's bootstrap loader will
 * read it back.
 *
 * Each test is fully self-contained: temp workspace dir is built
 * fresh, anchor is written, the file is read back with native fs,
 * and assertions run against the actual bytes on disk. No mocks
 * between us and reality.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  writeAgentsAnchor,
  removeAgentsAnchor,
  resolveWorkspaceDir,
  hasAgentsAnchorFor,
  renderAnchorText,
  ANCHOR_TEMPLATE,
} from '../../src/binding/agents-anchor.js'

const SKILL_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'skills', 'agentchat', 'SKILL.md')

/** The fenced text block right after the manual's "### 1. The anchor line (identity)" heading. */
function anchorBlockFromManual(): string {
  const manual = fs.readFileSync(SKILL_PATH, 'utf8')
  const heading = manual.indexOf('### 1. The anchor line (identity)')
  expect(heading).toBeGreaterThan(0)
  const fenceOpen = manual.indexOf('```text\n', heading)
  const fenceClose = manual.indexOf('\n```', fenceOpen + 8)
  return manual.slice(fenceOpen + '```text\n'.length, fenceClose)
}

// Build a synthetic OpenClawConfig that points at our temp workspace.
// Real-world callers pass the live cfg from the wizard or
// afterAccountConfigWritten hook; the anchor module only consumes
// `agents.defaults.workspace`, so this minimal shape is sufficient.
function cfgFor(workspaceDir: string): { agents: { defaults: { workspace: string } } } {
  return { agents: { defaults: { workspace: workspaceDir } } }
}

describe('agents-anchor', () => {
  let tmpDir: string

  beforeEach(() => {
    // mkdtempSync is racy-safe and unique per call. We point cfg at
    // the parent so the anchor module creates `workspace/` itself —
    // proves the mkdirSync path works for a fresh OpenClaw install.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-anchor-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('resolveWorkspaceDir', () => {
    it('uses agents.defaults.workspace when set', () => {
      const cfg = cfgFor('/some/explicit/path')
      expect(resolveWorkspaceDir(cfg)).toBe(path.resolve('/some/explicit/path'))
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
    it('creates the workspace dir when it does not exist (first-run install)', () => {
      const workspace = path.join(tmpDir, 'workspace-fresh')
      expect(fs.existsSync(workspace)).toBe(false)

      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })

      const file = path.join(workspace, 'AGENTS.md')
      expect(fs.existsSync(file)).toBe(true)
      const content = fs.readFileSync(file, 'utf-8')
      expect(content).toContain('<!-- agentchat:start -->')
      expect(content).toContain('<!-- agentchat:end -->')
      expect(content).toContain('@alice')
      expect(content).toContain('I am @alice on AgentChat (api.agentchat.me).')
    })

    it('substitutes the handle and leaks no placeholder (defensive check)', () => {
      const workspace = path.join(tmpDir, 'workspace')
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: '@supplier-bot' })

      const content = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')
      expect(content).toContain('I am @supplier-bot on AgentChat')
      expect(content).not.toContain('<handle>')
      expect(content).not.toContain('@@')
    })

    it('writes the manual\'s anchor text verbatim — lockstep with skills/agentchat/SKILL.md', () => {
      // The identity line is the main line's text, placed by this plugin. If
      // the published manual changes its anchor, this test fails until the
      // template here is updated to match.
      expect(ANCHOR_TEMPLATE).toBe(anchorBlockFromManual())
      expect(renderAnchorText('alice')).toBe(anchorBlockFromManual().split('<handle>').join('alice'))
      const workspace = path.join(tmpDir, 'workspace')
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })
      const content = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')
      expect(content).toContain(renderAnchorText('alice'))
      expect(hasAgentsAnchorFor({ cfg: cfgFor(workspace), handle: 'alice' }).present).toBe(true)
      expect(hasAgentsAnchorFor({ cfg: cfgFor(workspace), handle: 'bob' }).present).toBe(false)
    })

    it('preserves pre-existing AGENTS.md content (does not clobber)', () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      const userContent = '# My agent\n\nUser-written instructions here.\nDo not lose this.\n'
      fs.writeFileSync(file, userContent, 'utf-8')

      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })

      const content = fs.readFileSync(file, 'utf-8')
      expect(content).toContain('# My agent')
      expect(content).toContain('User-written instructions here.')
      expect(content).toContain('Do not lose this.')
      expect(content).toContain('<!-- agentchat:start -->')
      expect(content).toContain('@alice')
    })

    it('is idempotent — re-running with the same handle does not duplicate', () => {
      const workspace = path.join(tmpDir, 'workspace')
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })

      const content = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')
      // Exactly one start marker and one end marker, no matter how
      // many times we ran.
      expect(content.split('<!-- agentchat:start -->').length).toBe(2)
      expect(content.split('<!-- agentchat:end -->').length).toBe(2)
    })

    it('upserts on handle change — replaces old block, single block remains', () => {
      const workspace = path.join(tmpDir, 'workspace')
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'bob' })

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
        writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })
        lengths.push(fs.readFileSync(file, 'utf-8').length)
      }

      // After the first write, every subsequent write should produce
      // the same byte length — proves we're not adding blank lines.
      const first = lengths[0]
      for (const len of lengths.slice(1)) {
        expect(len).toBe(first)
      }
    })

    it('throws on empty handle (substitution would be broken)', () => {
      const workspace = path.join(tmpDir, 'workspace')
      expect(() => writeAgentsAnchor({ cfg: cfgFor(workspace), handle: '' })).toThrow(/handle is empty/u)
      expect(() => writeAgentsAnchor({ cfg: cfgFor(workspace), handle: '   ' })).toThrow(/handle is empty/u)
    })
  })

  describe('removeAgentsAnchor', () => {
    it('strips the anchor block, leaves user content intact', () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      fs.writeFileSync(file, '# Header\n\nUser body.\n', 'utf-8')

      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })
      const beforeRemove = fs.readFileSync(file, 'utf-8')
      expect(beforeRemove).toContain('@alice')

      const result = removeAgentsAnchor({ cfg: cfgFor(workspace) })
      expect(result.removed).toBe(true)

      const after = fs.readFileSync(file, 'utf-8')
      expect(after).toContain('# Header')
      expect(after).toContain('User body.')
      expect(after).not.toContain('agentchat:start')
      expect(after).not.toContain('@alice')
    })

    it('is a no-op when the anchor was never written', () => {
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      fs.writeFileSync(file, '# Header\n', 'utf-8')

      const result = removeAgentsAnchor({ cfg: cfgFor(workspace) })
      expect(result.removed).toBe(false)
      expect(fs.readFileSync(file, 'utf-8')).toBe('# Header\n')
    })

    it('is a no-op when AGENTS.md does not exist', () => {
      const workspace = path.join(tmpDir, 'workspace-empty')
      fs.mkdirSync(workspace, { recursive: true })

      const result = removeAgentsAnchor({ cfg: cfgFor(workspace) })
      expect(result.removed).toBe(false)
      expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(false)
    })

    it('handles a workspace where the file holds ONLY our anchor (clean delete)', () => {
      const workspace = path.join(tmpDir, 'workspace')
      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })

      const result = removeAgentsAnchor({ cfg: cfgFor(workspace) })
      expect(result.removed).toBe(true)

      const after = fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf-8')
      // Empty or whitespace-only is acceptable — no leftover block fragments.
      expect(after).not.toContain('agentchat:start')
      expect(after).not.toContain('@alice')
    })
  })

  describe('legacy marker migration (Path A → unified)', () => {
    it('strips a legacy `agentchat-skill:` block when writing the new unified block', () => {
      // Workspace previously anchored via Path A's old marker. After
      // the unification (the published OpenClaw recipe updated to use the
      // new `agentchat:` marker), users who hit the plugin first will
      // have the plugin migrate them silently — no duplicate blocks.
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      const legacyBlock = [
        '# User content',
        '',
        '<!-- agentchat-skill:start -->',
        '## On AgentChat (legacy Path A block)',
        'You are **@alice**...',
        '<!-- agentchat-skill:end -->',
        '',
        '## Other user content',
      ].join('\n')
      fs.writeFileSync(file, legacyBlock + '\n', 'utf-8')

      writeAgentsAnchor({ cfg: cfgFor(workspace), handle: 'alice' })

      const content = fs.readFileSync(file, 'utf-8')
      // Legacy block is gone…
      expect(content).not.toContain('<!-- agentchat-skill:start -->')
      expect(content).not.toContain('<!-- agentchat-skill:end -->')
      expect(content).not.toContain('legacy Path A block')
      // …new unified block is in place…
      expect(content).toContain('<!-- agentchat:start -->')
      expect(content).toContain('<!-- agentchat:end -->')
      expect(content).toContain('I am @alice on AgentChat (api.agentchat.me).')
      // …and surrounding user content is preserved.
      expect(content).toContain('# User content')
      expect(content).toContain('## Other user content')
    })

    it('removeAgentsAnchor strips both legacy and unified blocks', () => {
      // A user who removes the channel after a path switch should get
      // a fully clean AGENTS.md — both old and new variants gone.
      const workspace = path.join(tmpDir, 'workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const file = path.join(workspace, 'AGENTS.md')
      const mixed = [
        '# Header',
        '',
        '<!-- agentchat-skill:start -->',
        'Legacy block.',
        '<!-- agentchat-skill:end -->',
        '',
        '<!-- agentchat:start -->',
        'Unified block.',
        '<!-- agentchat:end -->',
        '',
        '## Tail',
      ].join('\n')
      fs.writeFileSync(file, mixed + '\n', 'utf-8')

      const result = removeAgentsAnchor({ cfg: cfgFor(workspace) })
      expect(result.removed).toBe(true)

      const content = fs.readFileSync(file, 'utf-8')
      expect(content).not.toContain('agentchat-skill:start')
      expect(content).not.toContain('agentchat:start')
      expect(content).not.toContain('Legacy block')
      expect(content).not.toContain('Unified block')
      expect(content).toContain('# Header')
      expect(content).toContain('## Tail')
    })
  })
})
