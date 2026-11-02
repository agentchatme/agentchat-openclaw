/**
 * The OpenClaw layout resolver mirrors OpenClaw 2026.10.9:
 *   state dir  = $OPENCLAW_STATE_DIR | ~/.openclaw-<profile> | ~/.openclaw
 *   workspace  = agents.entries.<id>.workspace | agents.defaults.workspace
 *              | $OPENCLAW_WORKSPACE_DIR | <state dir>/workspace
 *   default agent = the one marked default | the sole entry | "main" without a roster
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  resolveOpenClawStateDir,
  resolveOpenClawDefaultWorkspaceDir,
  resolveOpenClawWorkspaceDir,
  resolveOpenClawDefaultAgentId,
  resolveBoundAgentId,
  listOpenClawAgentEntries,
  expandUserPath,
} from '../src/openclaw-layout.js'

const ENV = ['OPENCLAW_STATE_DIR', 'OPENCLAW_WORKSPACE_DIR', 'OPENCLAW_PROFILE'] as const

describe('openclaw-layout', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of ENV) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('state dir: OPENCLAW_STATE_DIR wins (with ~ expansion), then the profile dir, then ~/.openclaw', () => {
    expect(resolveOpenClawStateDir()).toBe(path.join(os.homedir(), '.openclaw'))
    process.env.OPENCLAW_PROFILE = 'staging'
    expect(resolveOpenClawStateDir()).toBe(path.join(os.homedir(), '.openclaw-staging'))
    process.env.OPENCLAW_PROFILE = 'Default'
    expect(resolveOpenClawStateDir()).toBe(path.join(os.homedir(), '.openclaw'))
    process.env.OPENCLAW_STATE_DIR = '~/custom-state'
    expect(resolveOpenClawStateDir()).toBe(path.join(os.homedir(), 'custom-state'))
    process.env.OPENCLAW_STATE_DIR = '/srv/openclaw'
    expect(resolveOpenClawStateDir()).toBe(path.resolve('/srv/openclaw'))
  })

  it('default workspace: OPENCLAW_WORKSPACE_DIR, else <state dir>/workspace — never a bare ~/.openclaw/workspace when a state dir is set', () => {
    process.env.OPENCLAW_STATE_DIR = '/srv/openclaw'
    expect(resolveOpenClawDefaultWorkspaceDir()).toBe(path.join(path.resolve('/srv/openclaw'), 'workspace'))
    expect(resolveOpenClawWorkspaceDir(undefined)).toBe(path.join(path.resolve('/srv/openclaw'), 'workspace'))
    process.env.OPENCLAW_WORKSPACE_DIR = '/srv/ws'
    expect(resolveOpenClawWorkspaceDir({})).toBe(path.resolve('/srv/ws'))
  })

  it('workspace precedence: per-agent entry, then agents.defaults.workspace, then the environment', () => {
    process.env.OPENCLAW_WORKSPACE_DIR = '/env/ws'
    const cfg = { agents: { defaults: { workspace: '~/default-ws' }, entries: { main: { default: true }, ops: { workspace: '/ops/ws' } } } }
    expect(resolveOpenClawWorkspaceDir(cfg, 'ops')).toBe(path.resolve('/ops/ws'))
    expect(resolveOpenClawWorkspaceDir(cfg, 'main')).toBe(path.join(os.homedir(), 'default-ws'))
    expect(resolveOpenClawWorkspaceDir(cfg)).toBe(path.join(os.homedir(), 'default-ws')) // default agent = main
    expect(resolveOpenClawWorkspaceDir({ agents: { entries: { solo: {} } } }, 'solo')).toBe(path.resolve('/env/ws'))
  })

  it('roster: entries record or list array, ids normalised', () => {
    expect(listOpenClawAgentEntries({ agents: { entries: { Main: { default: true }, ops: { workspace: '/o' } } } })).toEqual([
      { id: 'main', default: true },
      { id: 'ops', workspace: '/o' },
    ])
    expect(listOpenClawAgentEntries({ agents: { list: [{ id: 'a' }, { id: 'b', default: true }, 'junk'] } })).toEqual([{ id: 'a' }, { id: 'b', default: true }])
    expect(listOpenClawAgentEntries({})).toEqual([])
  })

  it('default agent: marked default > sole entry > "main" without a roster; undefined when ambiguous or ownership is explicit', () => {
    expect(resolveOpenClawDefaultAgentId(undefined)).toBe('main')
    expect(resolveOpenClawDefaultAgentId({ agents: { defaults: {} } })).toBe('main')
    expect(resolveOpenClawDefaultAgentId({ agents: { entries: { ops: {} } } })).toBe('ops')
    expect(resolveOpenClawDefaultAgentId({ agents: { entries: { a: {}, b: { default: true } } } })).toBe('b')
    expect(resolveOpenClawDefaultAgentId({ agents: { entries: { a: {}, b: {} } } })).toBeUndefined()
    expect(resolveOpenClawDefaultAgentId({ agents: { ownership: 'explicit', entries: { a: {}, b: { default: true } } } })).toBeUndefined()
    expect(resolveOpenClawDefaultAgentId({ agents: { entries: {} } })).toBeUndefined()
  })

  it('bindings: exact account, then default-account (omitted accountId), then wildcard; peer bindings ignored', () => {
    const cfg = {
      bindings: [
        { agentId: 'peer-only', match: { channel: 'agentchat', peer: { kind: 'direct', id: 'x' } } },
        { agentId: 'everyone', match: { channel: 'agentchat', accountId: '*' } },
        { agentId: 'ops', match: { channel: 'agentchat', accountId: 'work' } },
        { agentId: 'dflt', match: { channel: 'agentchat' } },
        { agentId: 'other', match: { channel: 'telegram', accountId: 'work' } },
      ],
    }
    expect(resolveBoundAgentId(cfg, 'agentchat', 'work')).toBe('ops')
    expect(resolveBoundAgentId(cfg, 'agentchat', 'default')).toBe('dflt')
    expect(resolveBoundAgentId(cfg, 'agentchat', 'third')).toBe('everyone')
    expect(resolveBoundAgentId({}, 'agentchat', 'default')).toBeUndefined()
  })

  it('expandUserPath', () => {
    expect(expandUserPath('~')).toBe(os.homedir())
    expect(expandUserPath('~/x')).toBe(path.join(os.homedir(), 'x'))
    expect(expandUserPath('rel')).toBe(path.resolve('rel'))
  })
})
