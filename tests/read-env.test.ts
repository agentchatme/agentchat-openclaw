import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  LEGACY_REPLY_GATE_FAIL_OPEN_ENV,
  LEGACY_WAKE_MODE_ENV,
  WAKE_MODE_ENV,
  readLegacyReplyGateFailOpenFromEnv,
  readReplyGateEnabledFromEnv,
  readReplyGateTimeoutMsFromEnv,
  readWakeModeFromEnv,
} from '../src/credentials/read-env.js'

const KEYS = [WAKE_MODE_ENV, LEGACY_WAKE_MODE_ENV, LEGACY_REPLY_GATE_FAIL_OPEN_ENV, 'AGENTCHAT_REPLY_GATE_ENABLED', 'AGENTCHAT_REPLY_GATE_TIMEOUT_MS']
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('the wake switch — new spelling, old spelling', () => {
  it('defaults to on', () => {
    expect(readWakeModeFromEnv()).toEqual({ mode: 'on', variable: 'AGENTCHAT_WAKE' })
  })

  it('AGENTCHAT_WAKE=off switches off; any other value is on', () => {
    process.env.AGENTCHAT_WAKE = 'off'
    expect(readWakeModeFromEnv()).toEqual({ mode: 'off', variable: 'AGENTCHAT_WAKE' })
    process.env.AGENTCHAT_WAKE = 'OFF '
    expect(readWakeModeFromEnv().mode).toBe('off')
    process.env.AGENTCHAT_WAKE = 'on'
    expect(readWakeModeFromEnv().mode).toBe('on')
  })

  it('the old AGENTCHAT_DOORBELL still works when the new variable is unset: off is off, v3 is on', () => {
    process.env.AGENTCHAT_DOORBELL = 'off'
    expect(readWakeModeFromEnv()).toEqual({ mode: 'off', variable: 'AGENTCHAT_DOORBELL' })
    process.env.AGENTCHAT_DOORBELL = 'v3'
    expect(readWakeModeFromEnv()).toEqual({ mode: 'on', variable: 'AGENTCHAT_DOORBELL' })
  })

  it('the new variable wins when both are set', () => {
    process.env.AGENTCHAT_DOORBELL = 'off'
    process.env.AGENTCHAT_WAKE = 'on'
    expect(readWakeModeFromEnv()).toEqual({ mode: 'on', variable: 'AGENTCHAT_WAKE' })
    process.env.AGENTCHAT_DOORBELL = 'v3'
    process.env.AGENTCHAT_WAKE = 'off'
    expect(readWakeModeFromEnv().mode).toBe('off')
  })
})

describe('the gate knobs', () => {
  it('AGENTCHAT_REPLY_GATE_ENABLED=0 turns the gate off', () => {
    expect(readReplyGateEnabledFromEnv()).toBe(true)
    process.env.AGENTCHAT_REPLY_GATE_ENABLED = '0'
    expect(readReplyGateEnabledFromEnv()).toBe(false)
  })

  it('AGENTCHAT_REPLY_GATE_FAIL_OPEN is only read to warn that it is ignored', () => {
    expect(readLegacyReplyGateFailOpenFromEnv()).toBe(false)
    process.env.AGENTCHAT_REPLY_GATE_FAIL_OPEN = '1'
    expect(readLegacyReplyGateFailOpenFromEnv()).toBe(true)
  })

  it('AGENTCHAT_REPLY_GATE_TIMEOUT_MS must be a positive number', () => {
    expect(readReplyGateTimeoutMsFromEnv()).toBeUndefined()
    process.env.AGENTCHAT_REPLY_GATE_TIMEOUT_MS = '5000'
    expect(readReplyGateTimeoutMsFromEnv()).toBe(5000)
    process.env.AGENTCHAT_REPLY_GATE_TIMEOUT_MS = 'soon'
    expect(readReplyGateTimeoutMsFromEnv()).toBeUndefined()
  })
})
