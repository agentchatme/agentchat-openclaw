import type { Logger } from '../../src/log.js'

export const silentLogger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child: () => silentLogger }

export interface LogLine {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  msg: string | undefined
  obj: Record<string, unknown>
}

/** A logger that keeps every line (children share the list). */
export function capturingLogger(): Logger & { lines: LogLine[]; at: (level: LogLine['level']) => LogLine[] } {
  const lines: LogLine[] = []
  const log = (level: LogLine['level']) => (obj: object, msg?: string) => {
    lines.push({ level, msg, obj: obj as Record<string, unknown> })
  }
  const logger = {
    lines,
    at: (level: LogLine['level']) => lines.filter((l) => l.level === level),
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: () => logger,
  }
  return logger as Logger & { lines: LogLine[]; at: (level: LogLine['level']) => LogLine[] }
}
