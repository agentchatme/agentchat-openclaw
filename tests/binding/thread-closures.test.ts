import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  getThreadClosures,
  resetThreadClosuresForTest,
  ThreadClosures,
} from '../../src/binding/thread-closures.js'

describe('thread closures', () => {
  afterEach(() => {
    resetThreadClosuresForTest()
    delete process.env.OPENCLAW_PROFILE
  })

  it('persists closed threads and reloads them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-openclaw-'))
    const filePath = path.join(dir, 'closed.json')
    const closures = new ThreadClosures(filePath)
    const record = closures.close('conv_123', 'done')
    expect(closures.isClosed('conv_123')).toBe(true)

    const reloaded = new ThreadClosures(filePath)
    expect(reloaded.isClosed('conv_123')).toBe(true)
    expect(reloaded.list()).toEqual([record])
  })

  it('reopens a closed thread', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-openclaw-'))
    const filePath = path.join(dir, 'closed.json')
    const closures = new ThreadClosures(filePath)
    closures.close('conv_123')
    expect(closures.reopen('conv_123')).toBe(true)
    expect(closures.isClosed('conv_123')).toBe(false)
  })

  it('uses an account-scoped singleton', () => {
    process.env.OPENCLAW_PROFILE = 'thread-close-test'
    const a = getThreadClosures(undefined, 'default')
    const b = getThreadClosures(undefined, 'default')
    expect(a).toBe(b)
  })
})
