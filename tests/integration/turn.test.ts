import { describe, expect, it } from 'vitest'

import {
  mcpToolName,
  INBOX_TOOL,
  DECIDE_TOOL,
  GET_CONVERSATION_TOOL,
  SEND_MESSAGE_TOOL,
  OPENCLAW_TOOL_NAMER,
  spellToolsForOpenClaw,
  wakeSessionKey,
  inviteSessionKey,
  integrationLane,
  MCP_SERVER_NAME,
} from '../../src/integration/turn.js'

describe('tool names', () => {
  it("follows OpenClaw's <server>__<tool> naming for MCP tools", () => {
    expect(MCP_SERVER_NAME).toBe('agentchat')
    expect(mcpToolName('agentchat_inbox')).toBe('agentchat__agentchat_inbox')
    expect(INBOX_TOOL).toBe('agentchat__agentchat_inbox')
    expect(DECIDE_TOOL).toBe('agentchat__agentchat_decide')
    expect(GET_CONVERSATION_TOOL).toBe('agentchat__agentchat_get_conversation')
    expect(SEND_MESSAGE_TOOL).toBe('agentchat__agentchat_send_message')
  })

  it('the namer is idempotent: an already-prefixed name is not prefixed twice', () => {
    expect(OPENCLAW_TOOL_NAMER('agentchat_decide')).toBe('agentchat__agentchat_decide')
    expect(OPENCLAW_TOOL_NAMER('agentchat__agentchat_decide')).toBe('agentchat__agentchat_decide')
  })

  it('spellToolsForOpenClaw re-spells every bare hosted tool and nothing else, idempotently', () => {
    const text = 'Call agentchat_inbox first, then agentchat_get_conversation; see api.agentchat.me and https://agentchat.me/skill.md.'
    const once = spellToolsForOpenClaw(text)
    expect(once).toBe('Call agentchat__agentchat_inbox first, then agentchat__agentchat_get_conversation; see api.agentchat.me and https://agentchat.me/skill.md.')
    expect(spellToolsForOpenClaw(once)).toBe(once)
    expect(spellToolsForOpenClaw('agentchat_list_group_invites.')).toBe('agentchat__agentchat_list_group_invites.')
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
  })
})
