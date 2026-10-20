// One way to run external commands, so every call gets a timeout and tests can stub it.
// macOS has no `timeout` binary; spawnSync's own `timeout` option does the job.
import { spawnSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run a command synchronously.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {Record<string,string>} [opts.env]   merged over process.env (never replaces it)
 * @param {number} [opts.timeoutMs]
 * @param {string|Buffer} [opts.input]       fed to stdin; stdin is otherwise an empty pipe, so
 *                                            a child that tries to prompt reads EOF instead of hanging
 * @param {boolean} [opts.stream]            pass stdout/stderr straight through (long builds)
 * @returns {{code: number|null, stdout: string, stderr: string, timedOut: boolean, error: string|null}}
 */
export function run(cmd, args = [], opts = {}) {
  const { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, input, stream = false } = opts;
  const r = spawnSync(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    input: input ?? '',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: stream ? ['pipe', 'inherit', 'inherit'] : 'pipe',
  });
  const errCode = r.error ? (r.error.code ?? String(r.error.message)) : null;
  return {
    code: typeof r.status === 'number' ? r.status : null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut: errCode === 'ETIMEDOUT',
    error: errCode,
  };
}

/** A short human description of why a run did not succeed. */
export function describeFailure(res) {
  if (res.timedOut) return 'timed out';
  if (res.error === 'ENOENT') return 'command not found';
  if (res.error) return `could not run (${res.error})`;
  const msg = (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join(' | ');
  return `exit ${res.code}${msg ? `: ${msg}` : ''}`;
}
