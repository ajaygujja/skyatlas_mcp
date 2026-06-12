/**
 * Structured logger writing to stderr only.
 *
 * stdout is the MCP JSON-RPC channel — anything printed there corrupts the
 * protocol (TECHNICAL_DESIGN.md §9.4, Working Rule 7). `console.log` is
 * forbidden project-wide; every layer logs through this module.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const minLevel: LogLevel = (process.env['FLUTTER_INTEL_LOG'] as LogLevel | undefined) ?? 'info';

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
