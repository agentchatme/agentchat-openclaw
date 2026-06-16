import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { OpenClawConfig } from './openclaw-types.js'

import { resolveWorkspaceDir } from './agents-anchor.js'

export interface ClosedThreadRecord {
  readonly conversationId: string
  readonly closedAt: string
  readonly reason: string | null
}

const instances = new Map<string, ThreadClosures>()

function fallbackWorkspaceDir(): string {
  const profile = process.env.OPENCLAW_PROFILE?.trim()
  if (profile && profile.toLowerCase() !== 'default') {
    return path.join(os.homedir(), '.openclaw', `workspace-${profile}`)
  }
  return path.join(os.homedir(), '.openclaw', 'workspace')
}

function resolveStatePath(cfg: OpenClawConfig | undefined, accountId: string): string {
  const workspaceDir =
    typeof cfg === 'object' && cfg !== null ? resolveWorkspaceDir(cfg) : fallbackWorkspaceDir()
  return path.join(workspaceDir, `.agentchat-closed-threads-${accountId}.json`)
}

export class ThreadClosures {
  private readonly filePath: string
  private closed = new Map<string, ClosedThreadRecord>()

  constructor(filePath: string) {
    this.filePath = filePath
    this.load()
  }

  isClosed(conversationId: string): boolean {
    return this.closed.has(conversationId)
  }

  close(conversationId: string, reason?: string | null): ClosedThreadRecord {
    const record: ClosedThreadRecord = {
      conversationId,
      closedAt: new Date().toISOString(),
      reason: reason?.trim() ? reason.trim() : null,
    }
    this.closed.set(conversationId, record)
    this.save()
    return record
  }

  reopen(conversationId: string): boolean {
    const existed = this.closed.delete(conversationId)
    if (existed) this.save()
    return existed
  }

  list(): ClosedThreadRecord[] {
    return [...this.closed.values()].sort((a, b) => b.closedAt.localeCompare(a.closedAt))
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown
      if (!Array.isArray(raw)) return
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue
        const conversationId = (entry as { conversationId?: unknown }).conversationId
        const closedAt = (entry as { closedAt?: unknown }).closedAt
        const reason = (entry as { reason?: unknown }).reason
        if (typeof conversationId !== 'string' || typeof closedAt !== 'string') continue
        this.closed.set(conversationId, {
          conversationId,
          closedAt,
          reason: typeof reason === 'string' ? reason : null,
        })
      }
    } catch {
      this.closed = new Map()
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const payload = JSON.stringify(this.list(), null, 2)
    const tempPath = `${this.filePath}.tmp`
    fs.writeFileSync(tempPath, payload, 'utf8')
    fs.renameSync(tempPath, this.filePath)
  }
}

export function getThreadClosures(
  cfg: OpenClawConfig | undefined,
  accountId: string,
): ThreadClosures {
  const filePath = resolveStatePath(cfg, accountId)
  const existing = instances.get(filePath)
  if (existing) return existing
  const created = new ThreadClosures(filePath)
  instances.set(filePath, created)
  return created
}

export function resetThreadClosuresForTest(): void {
  instances.clear()
}
