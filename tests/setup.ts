/**
 * Vitest setup — runs before every test file.
 *
 * The integration places the API key in OpenClaw's state-dir `.env`
 * (`$OPENCLAW_STATE_DIR/.env`, `~/.openclaw/.env` by default) and keeps its
 * texts cache under `<state dir>/agentchat/`. Tests that
 * exercise placement must never touch the developer's or CI runner's real
 * OpenClaw state, so the state dir is redirected to a fresh temp directory
 * for the whole run. Individual tests may override it again.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { beforeEach } from 'vitest'

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-openclaw-test-state-'))
process.env.OPENCLAW_STATE_DIR = stateDir
// The wake switch and gate env knobs must not leak in from a developer shell.
delete process.env.AGENTCHAT_WAKE
delete process.env.AGENTCHAT_DOORBELL
delete process.env.AGENTCHAT_REPLY_GATE_ENABLED
delete process.env.AGENTCHAT_REPLY_GATE_FAIL_OPEN
delete process.env.AGENTCHAT_REPLY_GATE_TIMEOUT_MS
delete process.env.OPENCLAW_PROFILE

// The managed manual lives under OpenClaw's own CONFIG_DIR, computed when
// `openclaw/plugin-sdk/setup-tools` is first imported — so only now, after
// the state dir is redirected (a static import would be hoisted above it).
// No test may write the real `~/.openclaw/skills`, nor download the manual.
const manual = await import('../src/integration/manual.js')
if (path.resolve(manual.openclawConfigDir()) !== path.resolve(stateDir)) {
  throw new Error(`tests/setup.ts: OpenClaw's CONFIG_DIR is ${manual.openclawConfigDir()}, not the test state dir ${stateDir}`)
}
manual.setManualFetchForTest(async (url) => {
  throw new Error(`tests stub the manual download (${url}): pass a fetch to placeManual / ManualKeeper`)
})
// Every test starts without a managed manual, its record, or a running keeper.
beforeEach(() => {
  manual.resetManualKeeperForTest()
  fs.rmSync(path.join(manual.openclawConfigDir(), 'skills'), { recursive: true, force: true })
  fs.rmSync(manual.manualRecordPath(), { force: true })
})

process.on('exit', () => {
  try {
    fs.rmSync(stateDir, { recursive: true, force: true })
  } catch {
    // best effort
  }
})
