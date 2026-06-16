/**
 * Structured logger writing to stderr only.
 *
 * stdout is the MCP JSON-RPC channel — anything printed there corrupts the
 * protocol (TECHNICAL_DESIGN.md §9.4, Working Rule 7). `console.log` is
 * forbidden project-wide; every layer logs through this module.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Threshold from `SKYATLAS_LOG` (debug|info|warn|error), default `info`.
 * An unset or unrecognized value falls back to `info` rather than silently
 * disabling the level filter — a bogus `minLevel` would make every comparison
 * NaN and leak debug noise. Resolved once at module load.
 */
function resolveMinLevel(): LogLevel {
  const raw = process.env['SKYATLAS_LOG']?.toLowerCase();
  return raw && raw in LEVEL_ORDER ? (raw as LogLevel) : 'info';
}

const minLevel: LogLevel = resolveMinLevel();

export function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...data,
  };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>): void => {
    log('debug', msg, data);
  },
  info: (msg: string, data?: Record<string, unknown>): void => {
    log('info', msg, data);
  },
  warn: (msg: string, data?: Record<string, unknown>): void => {
    log('warn', msg, data);
  },
  error: (msg: string, data?: Record<string, unknown>): void => {
    log('error', msg, data);
  },
};
