import { describe, expect, it } from 'vitest'

import {
  mcpToolName,
  OPENCLAW_TOOL_NAMER,
  wakeSessionKey,
  inviteSessionKey,
  integrationLane,
  MCP_SERVER_NAME,
} from '../../src/integration/turn.js'

describe('tool names', () => {
  it("follows OpenClaw's <server>__<tool> naming for MCP tools", () => {
    expect(MCP_SERVER_NAME).toBe('agentchat')
    expect(mcpToolName('agentchat_inbox')).toBe('agentchat__agentchat_inbox')
  })

  it('the namer is idempotent: an already-prefixed name is not prefixed twice', () => {
    expect(OPENCLAW_TOOL_NAMER('agentchat_decide')).toBe('agentchat__agentchat_decide')
    expect(OPENCLAW_TOOL_NAMER('agentchat__agentchat_decide')).toBe('agentchat__agentchat_decide')
  })

})

describe('session keys and lanes', () => {
  it('wakeSessionKey is a fresh plugin-owned subagent session per wake', () => {
    const k = wakeSessionKey('main', Date.UTC(2026, 10, 2, 12, 30, 15), 'abc123')
    expect(k).toBe('agent:main:subagent:agentchat-wake-20261102T123015Z-abc123')
  })

  it('inviteSessionKey is a fresh session per invite turn (a second turn must not see the first one’s history), and safe', () => {
    expect(inviteSessionKey('main', 'inv_1 2/3', Date.UTC(2026, 10, 2, 12, 30, 15), 'abc123')).toBe('agent:main:subagent:agentchat-invite-inv_1-2-3-20261102T123015Z-abc123')
    expect(inviteSessionKey('main', 'inv_1')).not.toBe(inviteSessionKey('main', 'inv_1'))
  })

  it('integrationLane is per account', () => {
    expect(integrationLane('default')).toBe('agentchat-integration:default')
    expect(integrationLane('a b')).toBe('agentchat-integration:a-b')
    // After a hand-off new turns go to the next lane (a hung run blocks its lane).
    expect(integrationLane('default', 0)).toBe('agentchat-integration:default')
    expect(integrationLane('default', 2)).toBe('agentchat-integration:default:2')
  })
})
