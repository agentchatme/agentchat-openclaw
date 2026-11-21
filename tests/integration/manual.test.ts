/**
 * The manual as a copy that keeps itself current, in OpenClaw's managed
 * skills dir (`src/integration/manual.ts`):
 *
 *   - a first install offline places the bundled copy; an upgrade from a
 *     stale copy brings it to the announced one (from the bundle when it is
 *     the announced one, else downloaded, checked, written atomically);
 *   - a file that is not this plugin's (another skill, ClawHub's, a
 *     symlink) is left alone and reported; an agentchat copy someone placed
 *     by hand is kept current;
 *   - the download cap follows OpenClaw's skill-file limit;
 *   - the bundled copy is the floor: never older on disk while the server
 *     has not confirmed the older announcement in this process;
 *   - one keeper per process, behind the ownership guard;
 *   - cleanup removes only the bytes this plugin wrote;
 *   - status / doctor lines from local reads: current, stale, bundled only,
 *     not ours, over the cap, shadowed by a higher tier.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { integration, type Texts } from 'agentchatme'

import {
  ManualKeeper,
  bundledManual,
  checkManual,
  compareManualVersions,
  findManualShadows,
  inspectManagedManual,
  keepManualCurrent,
  latestManualOutcome,
  managedManualPath,
  manualMaxBytes,
  manualRecordPath,
  openclawConfigDir,
  placeManual,
  readManualRecord,
  removeManagedManual,
  resetManualKeeperForTest,
  shadowLine,
  skillFileCap,
  supersededByBundle,
} from '../../src/integration/manual.js'
import { manualStep, formatPlacement } from '../../src/integration/placement.js'
import { BUNDLED_MANUAL_SHA256, BUNDLED_MANUAL_VERSION, MANUAL_URL, SERVED_TEXTS } from '../helpers/texts.js'

const API_BASE = 'https://api.agentchat.me'
const BUNDLED = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'agentchat', 'SKILL.md'))

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

/** The manual at another version: the bundled text with its version line changed. */
function manualAt(version: string): Buffer {
  return Buffer.from(BUNDLED.toString('utf8').replace(/^version: .*$/m, `version: ${version}`), 'utf8')
}

function textsAnnouncing(bytes: Buffer, version: string): Texts {
  return { ...SERVED_TEXTS, manual: { url: MANUAL_URL, version, sha256: sha(bytes) } as Texts['manual'] }
}

/** A fetch that serves `bytes` for the manual URL and records each call. */
function serving(bytes: Buffer) {
  const calls: string[] = []
  const fetch = vi.fn(async (url: string) => {
    calls.push(url)
    return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'text/markdown', 'content-length': String(bytes.byteLength) } })
  })
  return { fetch, calls }
}

const refusing = vi.fn(async (url: string): Promise<Response> => {
  throw new Error(`fetch failed (${url})`)
})

let configDir: string
let file: string
beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-manual-'))
  file = managedManualPath(configDir)
  refusing.mockClear()
})
afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true })
})

function writeManaged(bytes: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, bytes)
}

/** The record an earlier sync of this plugin would have left for `bytes`. */
function writeRecordFor(bytes: Buffer, version: string): void {
  fs.mkdirSync(path.dirname(manualRecordPath(configDir)), { recursive: true })
  fs.writeFileSync(manualRecordPath(configDir), JSON.stringify({ version: 1, file, written: { sha256: sha(bytes), manual: version, at: 'x' }, last: null }))
}

describe('where the manual goes', () => {
  it("OpenClaw's own CONFIG_DIR (the test setup's state dir), skills/agentchat/SKILL.md; the record next to the account dirs", () => {
    expect(openclawConfigDir()).toBe(path.resolve(process.env.OPENCLAW_STATE_DIR!))
    expect(managedManualPath()).toBe(path.join(openclawConfigDir(), 'skills', 'agentchat', 'SKILL.md'))
    expect(manualRecordPath()).toBe(path.join(openclawConfigDir(), 'agentchat', 'manual.json'))
  })

  it('finds the bundled copy from its own module: the manual this release ships', () => {
    const bundled = bundledManual()
    expect(bundled?.path).toBe(path.resolve(__dirname, '..', '..', 'skills', 'agentchat', 'SKILL.md'))
    expect(bundled?.version).toBe(BUNDLED_MANUAL_VERSION)
    expect(bundled?.sha256).toBe(BUNDLED_MANUAL_SHA256)
  })
})

describe('placeManual — one sync, for setup, re-enable and doctor --fix', () => {
  it('first install offline (no texts at all): the bundled copy is written, recorded, and the step says it is unchecked', async () => {
    const outcome = await placeManual({ texts: null, source: 'none', apiBase: API_BASE, configDir, fetch: refusing })
    expect(outcome.kind).toBe('synced')
    expect(fs.readFileSync(file)).toEqual(BUNDLED)
    expect(refusing).not.toHaveBeenCalled()
    const record = readManualRecord(configDir)
    expect(record?.written).toMatchObject({ sha256: BUNDLED_MANUAL_SHA256, manual: BUNDLED_MANUAL_VERSION })
    expect(inspectManagedManual(configDir).owner.kind).toBe('ours')
    const step = manualStep(outcome)
    expect(step.status).toBe('changed')
    expect(formatPlacement([step])[0]).toBe(`✓ manual: bundled copy ${BUNDLED_MANUAL_VERSION} → ${file} (no served version in hand to check it against)`)
  })

  it('first install with AgentChat reachable but the download failing: the bundled copy, and a warning naming both versions', async () => {
    const newer = manualAt('9.0.0')
    const outcome = await placeManual({ texts: textsAnnouncing(newer, '9.0.0'), source: 'server', apiBase: API_BASE, configDir, fetch: refusing })
    expect(fs.readFileSync(file)).toEqual(BUNDLED)
    const step = manualStep(outcome)
    expect(step.status).toBe('warned')
    expect(step.detail).toMatch(new RegExp(`^bundled copy ${BUNDLED_MANUAL_VERSION.replace(/\./g, '\\.')} → .*; served 9\\.0\\.0 could not be fetched: fetch failed`))
  })

  it('the skill dir is created readable by others (a Docker sandbox copy keeps its mode), the file 0644', async () => {
    await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir })
    if (process.platform === 'win32') return
    expect(fs.statSync(path.dirname(file)).mode & 0o055).toBe(0o055 & ~process.umask() & 0o055)
    expect(fs.statSync(file).mode & 0o777).toBe(0o644)
  })

  it('an upgrade from a stale copy of ours: the announced manual is the bundled one, so it is placed without a download', async () => {
    await placeManual({ texts: null, source: 'none', apiBase: API_BASE, configDir }) // ours, at the bundled version
    writeManaged(manualAt('2.4.0'))
    writeRecordFor(manualAt('2.4.0'), '2.4.0') // what an earlier sync would have recorded
    expect(inspectManagedManual(configDir).owner.kind).toBe('ours')
    const outcome = await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir, fetch: refusing })
    expect(refusing).not.toHaveBeenCalled()
    expect(fs.readFileSync(file)).toEqual(BUNDLED)
    expect(formatPlacement([manualStep(outcome)])[0]).toBe(`✓ manual: ${BUNDLED_MANUAL_VERSION} placed from the bundled copy (the served version) → ${file} (was 2.4.0)`)
    expect(readManualRecord(configDir)?.written?.sha256).toBe(BUNDLED_MANUAL_SHA256)
  })

  it('an upgrade to a manual newer than the bundle: downloaded from the announced address, checked, written, recorded', async () => {
    writeManaged(BUNDLED)
    const newer = manualAt('2.5.0')
    const { fetch, calls } = serving(newer)
    const outcome = await placeManual({ texts: textsAnnouncing(newer, '2.5.0'), source: 'server', apiBase: API_BASE, configDir, fetch })
    expect(calls).toEqual([MANUAL_URL])
    expect(fs.readFileSync(file)).toEqual(newer)
    expect(formatPlacement([manualStep(outcome)])[0]).toBe(`✓ manual: 2.5.0 downloaded from ${MANUAL_URL} → ${file} (was ${BUNDLED_MANUAL_VERSION})`)
    expect(readManualRecord(configDir)).toMatchObject({ file, written: { sha256: sha(newer), manual: '2.5.0' }, last: { state: 'updated', served: '2.5.0', error: null } })
  })

  it('bytes that are not the announced ones (sha256) are refused: the old file stays, the step is a warning with the reason', async () => {
    writeManaged(BUNDLED)
    const announced = manualAt('2.5.0')
    const { fetch } = serving(Buffer.concat([announced, Buffer.from('\ntampered\n')]))
    const outcome = await placeManual({ texts: textsAnnouncing(announced, '2.5.0'), source: 'server', apiBase: API_BASE, configDir, fetch })
    expect(fs.readFileSync(file)).toEqual(BUNDLED)
    const step = manualStep(outcome)
    expect(step.status).toBe('warned')
    expect(step.detail).toMatch(new RegExp(`^stale \\(have ${BUNDLED_MANUAL_VERSION.replace(/\./g, '\\.')}, served 2\\.5\\.0\\) — .*; kept as it is: the body's sha256 is [0-9a-f]{64}, the server announced ${sha(announced)}$`))
    expect(readManualRecord(configDir)?.last).toMatchObject({ state: 'kept', served: '2.5.0', error: expect.stringContaining("the body's sha256") })
  })

  it('current: nothing fetched, nothing written, the step is ok', async () => {
    await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir })
    const before = fs.statSync(file).mtimeMs
    const outcome = await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir, fetch: refusing })
    expect(manualStep(outcome)).toEqual({ name: 'manual', status: 'ok', detail: `current (${BUNDLED_MANUAL_VERSION}) — ${file}` })
    expect(fs.statSync(file).mtimeMs).toBe(before)
    expect(refusing).not.toHaveBeenCalled()
  })

  it('an agentchat copy someone placed by hand (not recorded, not ClawHub, not a symlink) is kept current too, and is ours from then on', async () => {
    writeManaged(manualAt('2.1.0'))
    expect(inspectManagedManual(configDir).owner.kind).toBe('agentchat')
    await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir })
    expect(fs.readFileSync(file)).toEqual(BUNDLED)
    expect(inspectManagedManual(configDir).owner.kind).toBe('ours')
  })

  it("the announced bytes at a path this plugin wrote, under another sha (a lost record, another process's write): recorded as ours again", async () => {
    await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir })
    const record = readManualRecord(configDir)!
    fs.writeFileSync(manualRecordPath(configDir), JSON.stringify({ ...record, written: { ...record.written, sha256: '0'.repeat(64) } }))
    expect(inspectManagedManual(configDir).owner.kind).toBe('agentchat')
    await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir })
    expect(inspectManagedManual(configDir).owner.kind).toBe('ours')
  })
})

describe('not ours: left alone, reported', () => {
  const notOurs = async (setup: () => void, reason: RegExp) => {
    setup()
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null
    const outcome = await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir, fetch: refusing })
    expect(outcome.kind).toBe('not-ours')
    if (before !== null) expect(fs.readFileSync(file)).toEqual(before)
    const step = manualStep(outcome)
    expect(step.status).toBe('warned')
    expect(step.detail).toMatch(reason)
    expect(step.detail).toMatch(/this plugin leaves it alone and does not keep it current — .*\. To use the served manual: remove it, then run openclaw doctor --fix$/)
    expect(readManualRecord(configDir)?.last).toMatchObject({ state: 'not-ours' })
    const { primary } = checkManual({ served: SERVED_TEXTS.manual, agentIds: [], configDir })
    expect(primary).toMatchObject({ state: 'not-ours', ok: true, notice: true })
    expect(primary.detail).toMatch(reason)
    return step
  }

  it('another skill in the agentchat folder (its front matter names something else): the agent reads the bundled copy', async () => {
    const step = await notOurs(() => writeManaged('---\nname: my-notes\ndescription: mine\n---\n\nmy notes\n'), /is the skill "my-notes", not agentchat/)
    expect(step.detail).toContain('the agent reads the copy bundled with the plugin, which does not update')
  })

  it('a file with no front matter', async () => {
    await notOurs(() => writeManaged('just text\n'), /has no front matter — not the agentchat skill/)
  })

  it('an agentchat skill installed from ClawHub (.clawhub/ beside it): `openclaw skills update` manages it, the agent reads it', async () => {
    const step = await notOurs(() => {
      writeManaged(manualAt('2.0.0'))
      fs.mkdirSync(path.join(path.dirname(file), '.clawhub'))
      fs.writeFileSync(path.join(path.dirname(file), '.clawhub', 'origin.json'), '{}')
    }, /was installed from ClawHub \(\.clawhub\/ beside it\), so `openclaw skills update` manages it/)
    expect(step.detail).toContain('the agent reads it instead of the served manual')
  })

  it("an agentchat skill listed in the managed dir's ClawHub lock file", async () => {
    await notOurs(() => {
      writeManaged(manualAt('2.0.0'))
      fs.mkdirSync(path.join(configDir, '.clawhub'), { recursive: true })
      fs.writeFileSync(path.join(configDir, '.clawhub', 'lock.json'), JSON.stringify({ version: 1, skills: { agentchat: { version: '1.0.0' } } }))
    }, /is listed in .*\.clawhub\/lock\.json \(installed from ClawHub\)/)
  })

  it('a symlinked skill folder or SKILL.md (a copy kept by hand)', async () => {
    if (process.platform === 'win32') return
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-manual-link-'))
    try {
      fs.writeFileSync(path.join(elsewhere, 'SKILL.md'), manualAt('2.0.0'))
      await notOurs(() => {
        fs.mkdirSync(path.join(configDir, 'skills'), { recursive: true })
        fs.symlinkSync(elsewhere, path.dirname(file))
      }, /skills\/agentchat is a symlink \(a copy kept by hand\)/)
      expect(fs.readFileSync(path.join(elsewhere, 'SKILL.md'))).toEqual(manualAt('2.0.0'))
      fs.unlinkSync(path.dirname(file))
      fs.mkdirSync(path.dirname(file))
      fs.symlinkSync(path.join(elsewhere, 'SKILL.md'), file)
      await notOurs(() => undefined, /SKILL\.md is a symlink \(a copy kept by hand\)/)
      expect(fs.readFileSync(path.join(elsewhere, 'SKILL.md'))).toEqual(manualAt('2.0.0'))
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  })
})

describe('the size OpenClaw loads', () => {
  it("skills.limits.maxSkillFileBytes, else OpenClaw's default 256 000; the download cap never past the kit's 512 KiB", () => {
    expect(skillFileCap(undefined)).toBe(256_000)
    expect(skillFileCap({ skills: { limits: { maxSkillFileBytes: 50_000 } } })).toBe(50_000)
    expect(skillFileCap({ skills: { limits: { maxSkillFileBytes: 'big' } } })).toBe(256_000)
    expect(manualMaxBytes(undefined)).toBe(256_000)
    expect(manualMaxBytes({ skills: { limits: { maxSkillFileBytes: 10_000_000 } } })).toBe(integration.MANUAL_MAX_BYTES)
  })

  it('a served manual over the configured limit is not downloaded (OpenClaw would skip it): the old file stays, the reason is the cap', async () => {
    writeManaged(BUNDLED)
    const newer = manualAt('2.5.0')
    const { fetch } = serving(newer)
    const cfg = { skills: { limits: { maxSkillFileBytes: 1_000 } } }
    const outcome = await placeManual({ texts: textsAnnouncing(newer, '2.5.0'), source: 'server', apiBase: API_BASE, configDir, fetch, cfg })
    expect(fs.readFileSync(file)).toEqual(BUNDLED)
    expect(manualStep(outcome).detail).toMatch(/over the 1000-byte cap/)
  })

  it('a managed file far past any manual is not read whole: its front matter decides, and an agentchat one is replaced by the served manual', async () => {
    const huge = Buffer.concat([manualAt('2.0.0'), Buffer.alloc(3 * 1024 * 1024, 0x61)])
    writeManaged(huge)
    const found = inspectManagedManual(configDir)
    expect(found).toMatchObject({ owner: { kind: 'agentchat' }, size: huge.byteLength, bytes: null, sha256: null, version: '2.0.0' })
    expect(checkManual({ served: SERVED_TEXTS.manual, agentIds: [], configDir }).primary.state).toBe('over-cap')
    await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir, fetch: refusing })
    expect(fs.readFileSync(file)).toEqual(BUNDLED)
  })

  it('status: a managed copy over the limit is skipped by OpenClaw — not ok, and says what to raise', () => {
    writeManaged(BUNDLED)
    const { primary } = checkManual({ cfg: { skills: { limits: { maxSkillFileBytes: 1_000 } } }, served: SERVED_TEXTS.manual, agentIds: [], configDir })
    expect(primary.state).toBe('over-cap')
    expect(primary.ok).toBe(false)
    expect(primary.detail).toBe(
      `${file} is ${BUNDLED.byteLength} bytes, over OpenClaw's skill-file limit (skills.limits.maxSkillFileBytes = 1000), so OpenClaw skips it — the agent has no manual — raise skills.limits.maxSkillFileBytes (the manual is ${BUNDLED.byteLength} bytes)`,
    )
  })
})

describe('the bundled copy is the floor', () => {
  it('versions compare as dotted numbers', () => {
    expect(compareManualVersions('2.4.2', '2.4.10')).toBe(-1)
    expect(compareManualVersions('2.5', '2.4.9')).toBe(1)
    expect(compareManualVersions('2.4.2', '2.4.2')).toBe(0)
    expect(compareManualVersions('2.4.2-rc1', '2.4.2')).toBeNull()
  })

  it('a cached announcement older than the bundle is superseded; the server word in this process never is (a rollback is followed)', () => {
    const older = { url: MANUAL_URL, version: '2.0.0' }
    expect(supersededByBundle(older, 'cache')).toBe(true)
    expect(supersededByBundle(older, 'none')).toBe(true)
    expect(supersededByBundle(older, 'server')).toBe(false)
    expect(supersededByBundle(SERVED_TEXTS.manual, 'cache')).toBe(false)
  })

  it('an upgrade while AgentChat is unreachable: an older copy of ours, a cached older announcement → the bundled copy, no download of the older one', async () => {
    const old = manualAt('2.0.0')
    writeManaged(old)
    writeRecordFor(old, '2.0.0')
    expect(inspectManagedManual(configDir).owner.kind).toBe('ours')
    const { fetch, calls } = serving(old)
    const outcome = await placeManual({ texts: textsAnnouncing(old, '2.0.0'), source: 'cache', apiBase: API_BASE, configDir, fetch })
    expect(calls).toEqual([])
    expect(fs.readFileSync(file)).toEqual(BUNDLED)
    expect(manualStep(outcome)).toEqual({
      name: 'manual',
      status: 'changed',
      detail: `bundled copy ${BUNDLED_MANUAL_VERSION} → ${file} (was 2.0.0; the cached announcement, 2.0.0, is older)`,
    })
    // status: the cached announcement is not held against the newer file
    const { primary } = checkManual({ served: { url: MANUAL_URL, version: '2.0.0' }, agentIds: [], configDir })
    expect(primary.state).toBe('unchecked')
    expect(primary.detail).toContain(`the cached announcement, 2.0.0, is older than the copy bundled with this plugin (${BUNDLED_MANUAL_VERSION}); AgentChat not reached since the update`)
  })

  it('the server announcing an older manual (a rollback) is followed: downloaded over the newer copy', async () => {
    writeManaged(BUNDLED)
    const old = manualAt('2.0.0')
    const { fetch, calls } = serving(old)
    await placeManual({ texts: textsAnnouncing(old, '2.0.0'), source: 'server', apiBase: API_BASE, configDir, fetch })
    expect(calls).toEqual([MANUAL_URL])
    expect(fs.readFileSync(file)).toEqual(old)
  })

  it('a newer copy on disk is never replaced by the bundle', async () => {
    writeManaged(manualAt('9.0.0'))
    await placeManual({ texts: null, source: 'none', apiBase: API_BASE, configDir })
    expect(fs.readFileSync(file)).toEqual(manualAt('9.0.0'))
  })
})

describe('ManualKeeper — the kit ManualSync for the gateway, behind the ownership guard', () => {
  function cacheWith(texts: Texts | null, dir = configDir) {
    let answer: { texts?: Texts; error?: Error } = texts ? { texts } : { error: new Error('unreachable') }
    const client = {
      baseUrl: API_BASE,
      texts: {
        get: async () => {
          if (answer.error) throw answer.error
          return answer.texts!
        },
      },
    }
    const cache = new integration.TextsCache({ client: client as never, runtime: 'openclaw', filePath: path.join(dir, 'texts.json') })
    return { cache, answer: (next: typeof answer) => (answer = next) }
  }
  const log = () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn() })

  afterEach(() => resetManualKeeperForTest())

  it('offline with nothing cached: the bundled copy through the kit (its fallback), logged at info', async () => {
    const { cache } = cacheWith(null)
    await cache.start()
    const lines = log()
    const keeper = new ManualKeeper({ cache, configDir, log: lines, fetch: refusing })
    await keeper.start()
    expect(fs.readFileSync(file)).toEqual(BUNDLED)
    expect(lines.info).toHaveBeenCalledWith(`[agentchat] manual: bundled copy ${BUNDLED_MANUAL_VERSION} → ${file} (no served version in hand to check it against)`)
    keeper.stop()
    cache.stop()
  })

  it('follows a texts change: a newer announcement is downloaded and recorded', async () => {
    const { cache, answer } = cacheWith(SERVED_TEXTS)
    await cache.start()
    const newer = manualAt('2.5.0')
    const { fetch, calls } = serving(newer)
    const lines = log()
    const keeper = new ManualKeeper({ cache, configDir, log: lines, fetch })
    await keeper.start()
    expect(fs.readFileSync(file)).toEqual(BUNDLED)
    answer({ texts: textsAnnouncing(newer, '2.5.0') })
    await cache.refresh()
    await vi.waitFor(() => expect(fs.readFileSync(file)).toEqual(newer))
    expect(calls).toEqual([MANUAL_URL])
    await vi.waitFor(() => expect(readManualRecord(configDir)?.written?.manual).toBe('2.5.0'))
    expect(lines.info).toHaveBeenCalledWith(`[agentchat] manual: 2.5.0 downloaded from ${MANUAL_URL} → ${file} (was ${BUNDLED_MANUAL_VERSION})`)
    keeper.stop()
    cache.stop()
  })

  it("someone else's file: the kit never gets the texts, one warning; once it is removed the next change places the manual", async () => {
    writeManaged('---\nname: mine\ndescription: x\n---\n')
    const { cache, answer } = cacheWith(SERVED_TEXTS)
    await cache.start()
    const lines = log()
    const keeper = new ManualKeeper({ cache, configDir, log: lines, fetch: refusing })
    await keeper.start()
    expect(fs.readFileSync(file, 'utf8')).toContain('name: mine')
    expect(lines.warn).toHaveBeenCalledTimes(1)
    expect(String(lines.warn.mock.calls[0]![0])).toMatch(/is the skill "mine", not agentchat; this plugin leaves it alone/)
    expect(keeper.latest).toMatchObject({ kind: 'not-ours' })
    fs.rmSync(path.dirname(file), { recursive: true })
    answer({ texts: { ...SERVED_TEXTS, version: '1b' } })
    await cache.refresh()
    await vi.waitFor(() => expect(fs.existsSync(file) && fs.readFileSync(file).equals(BUNDLED)).toBe(true))
    expect(lines.warn).toHaveBeenCalledTimes(1)
    keeper.stop()
    cache.stop()
  })

  it('one keeper per process: the first account keeps it, the next one running takes over when it stops; release is idempotent', async () => {
    const a = cacheWith(SERVED_TEXTS, configDir)
    const b = cacheWith(SERVED_TEXTS, configDir)
    await a.cache.start()
    await b.cache.start()
    const made: string[] = []
    const claimA = keepManualCurrent('a', () => (made.push('a'), new ManualKeeper({ cache: a.cache, configDir })))
    const claimB = keepManualCurrent('b', () => (made.push('b'), new ManualKeeper({ cache: b.cache, configDir })))
    expect(await claimB.started).toBeNull() // not the keeper
    expect(await claimA.started).toMatchObject({ kind: 'synced' })
    expect(made).toEqual(['a'])
    claimB.release()
    claimB.release()
    expect(made).toEqual(['a'])
    claimA.release()
    expect(made).toEqual(['a'])
    expect(latestManualOutcome()).toBeNull()
    const claimB2 = keepManualCurrent('b', () => (made.push('b'), new ManualKeeper({ cache: b.cache, configDir })))
    const claimA2 = keepManualCurrent('a', () => (made.push('a'), new ManualKeeper({ cache: a.cache, configDir })))
    expect(made).toEqual(['a', 'b'])
    expect(await claimA2.started).toBeNull() // b's keeper ran when a asked
    claimB2.release()
    expect(made).toEqual(['a', 'b', 'a']) // a, still running, takes over
    await vi.waitFor(() => expect(latestManualOutcome()).toMatchObject({ kind: 'synced' }))
    // an old claim of a restarted account never stops the new one
    const restarted = keepManualCurrent('a', () => (made.push('a2'), new ManualKeeper({ cache: a.cache, configDir })))
    claimA2.release()
    expect(await restarted.started).toMatchObject({ kind: 'synced' })
    expect(latestManualOutcome()).toMatchObject({ kind: 'synced' })
    restarted.release()
    expect(latestManualOutcome()).toBeNull()
    a.cache.stop()
    b.cache.stop()
  })
})

describe('cleanup — the last AgentChat account gone', () => {
  it('removes the copy this plugin wrote, its empty folder and the record', async () => {
    await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir })
    expect(removeManagedManual(configDir)).toEqual([`removed the AgentChat manual this plugin kept current (${file})`])
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(path.dirname(file))).toBe(false)
    expect(fs.existsSync(manualRecordPath(configDir))).toBe(false)
    expect(removeManagedManual(configDir)).toEqual([])
  })

  it('a copy changed since this plugin wrote it stays (and says so); the record goes', async () => {
    await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir })
    fs.appendFileSync(file, '\nmy own notes\n')
    expect(removeManagedManual(configDir)).toEqual([`left ${file} in place: it is not the copy this plugin wrote (changed since, or someone else's)`])
    expect(fs.readFileSync(file, 'utf8')).toContain('my own notes')
    expect(fs.existsSync(manualRecordPath(configDir))).toBe(false)
  })

  it("someone else's file, never recorded, stays without a word; anything else in the folder stays too", async () => {
    writeManaged('---\nname: mine\ndescription: x\n---\n')
    expect(removeManagedManual(configDir)).toEqual([])
    expect(fs.existsSync(file)).toBe(true)
    fs.rmSync(file)
    await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir })
    fs.writeFileSync(path.join(path.dirname(file), 'notes.txt'), 'keep me')
    removeManagedManual(configDir)
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.readFileSync(path.join(path.dirname(file), 'notes.txt'), 'utf8')).toBe('keep me')
  })
})

describe('status and doctor: local reads only', () => {
  it('current', async () => {
    await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir })
    expect(checkManual({ served: SERVED_TEXTS.manual, agentIds: [], configDir }).primary).toEqual({
      state: 'current',
      ok: true,
      notice: false,
      repair: false,
      detail: `current (${BUNDLED_MANUAL_VERSION}) — ${file}`,
    })
  })

  it('stale: the on-disk version, the announced one and the last sync error (from the record, for a doctor in another process)', async () => {
    writeManaged(BUNDLED)
    const newer = manualAt('2.5.0')
    await placeManual({ texts: textsAnnouncing(newer, '2.5.0'), source: 'server', apiBase: API_BASE, configDir, fetch: refusing })
    const { primary } = checkManual({ served: textsAnnouncing(newer, '2.5.0').manual, agentIds: [], configDir })
    expect(primary).toMatchObject({ state: 'stale', ok: true, notice: true, repair: true })
    expect(primary.detail).toBe(
      `stale (have ${BUNDLED_MANUAL_VERSION}, served 2.5.0; last sync: fetch failed (${MANUAL_URL})) — ${file}; the gateway tries again when the texts change — run openclaw doctor --fix to try now`,
    )
  })

  it('stale by sha256: the announced version with other bytes', () => {
    writeManaged(Buffer.concat([BUNDLED, Buffer.from('\nedited\n')]))
    const { primary } = checkManual({ served: SERVED_TEXTS.manual, agentIds: [], configDir })
    expect(primary.state).toBe('stale')
    expect(primary.detail).toMatch(/^stale \(have \S+ but not the served text: its sha256 differs\)/)
  })

  it('bundled only: the copy that updates is not placed (doctor --fix places it; a disabled account gets its re-enable route)', () => {
    const { primary } = checkManual({ served: SERVED_TEXTS.manual, agentIds: [], configDir })
    expect(primary).toMatchObject({ state: 'bundled-only', ok: true, notice: true, repair: true })
    expect(primary.detail).toBe(
      `only the copy bundled with the plugin (${BUNDLED_MANUAL_VERSION}, the served version) — the copy that keeps itself current (${file}) is not placed; the gateway places it when it starts — run openclaw doctor --fix to place it now`,
    )
    const disabled = checkManual({ served: null, agentIds: [], configDir, remedy: () => 'the account is disabled — re-enable it first' }).primary
    expect(disabled.detail).toMatch(/is not placed; the gateway places it when it starts — the account is disabled — re-enable it first$/)
  })

  it('unchecked: a copy with no announcement in hand', async () => {
    await placeManual({ texts: null, source: 'none', apiBase: API_BASE, configDir })
    const { primary } = checkManual({ served: null, agentIds: [], configDir })
    expect(primary).toMatchObject({ state: 'unchecked', ok: true, notice: true })
    expect(primary.detail).toBe(`unchecked (have ${BUNDLED_MANUAL_VERSION}; no served version in hand — AgentChat not reached yet) — ${file}`)
  })

  describe('shadowed by a higher tier', () => {
    let workspace: string
    let home: string
    beforeEach(() => {
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-manual-ws-'))
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-manual-home-'))
    })
    afterEach(() => {
      fs.rmSync(workspace, { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
    })
    const skill = (root: string, dir: string, body: string) => {
      fs.mkdirSync(path.join(root, dir), { recursive: true })
      fs.writeFileSync(path.join(root, dir, 'SKILL.md'), body)
      return path.join(root, dir, 'SKILL.md')
    }
    const cfg = () => ({ agents: { defaults: { workspace } } })

    it("agentchat skills in the workspace's skills and .agents/skills, and in ~/.agents/skills, by name — never deleted", () => {
      const inWorkspace = skill(path.join(workspace, 'skills'), 'agentchat', manualAt('2.0.0').toString())
      const inProject = skill(path.join(workspace, '.agents', 'skills'), 'agentchat-manual', '---\nname: agentchat\ndescription: old copy\n---\n')
      const inHome = skill(path.join(home, '.agents', 'skills'), 'agentchat', '---\ndescription: named by its folder\n---\n')
      skill(path.join(workspace, 'skills'), 'other', '---\nname: other\ndescription: x\n---\n')
      skill(path.join(workspace, 'skills'), 'agentchat-notes', '---\nname: agentchat\n---\n') // no description: OpenClaw does not load it
      const shadows = findManualShadows(cfg(), [undefined], home, configDir)
      expect(shadows.map((s) => [s.path, s.where])).toEqual([
        [inHome, 'personal ~/.agents/skills'],
        [inProject, 'workspace .agents/skills'],
        [inWorkspace, 'workspace skills'],
      ])
      expect(shadowLine(shadows[2]!)).toBe(
        `${inWorkspace} is an agentchat skill in the workspace skills folder, which OpenClaw loads ahead of the managed copy — the agent reads it, not the served manual; ` +
          `if it is an old copy of the AgentChat manual, remove it (rm -r ${path.dirname(inWorkspace)}); this plugin never deletes it`,
      )
      expect(checkManual({ cfg: cfg(), served: null, agentIds: [undefined], configDir, home }).shadows).toHaveLength(3)
      expect(fs.existsSync(inWorkspace) && fs.existsSync(inProject) && fs.existsSync(inHome)).toBe(true)
    })

    it('a workspace at the config dir loads the managed copy itself: not a shadow', async () => {
      await placeManual({ texts: SERVED_TEXTS, source: 'server', apiBase: API_BASE, configDir })
      expect(findManualShadows({ agents: { defaults: { workspace: configDir } } }, [undefined], home, configDir)).toEqual([])
    })
  })
})
