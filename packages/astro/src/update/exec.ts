import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface ExecResult {
  code: number;
  output: string;
}

export interface ExecOptions {
  cwd: string;
  env?: Record<string, string>;
  /**
   * Stops the command, and everything it started, after this long and fails
   * it with {@link TIMED_OUT}. Unset: no limit.
   */
  timeoutMs?: number;
  /** Called every `heartbeatMs` while the command runs, with its output so far. */
  onWait?: (elapsedMs: number, output: string) => void;
  heartbeatMs?: number;
}

/** Runs a command and collects its combined output; never rejects. */
export type Exec = (command: string[], options: ExecOptions) => Promise<ExecResult>;

/** The exit code of a command stopped by its `timeoutMs`, as coreutils' `timeout` uses. */
export const TIMED_OUT = 124;

export const HEARTBEAT_MS = 60_000;

/** Commands still running, stopped with their whole tree if the updater is interrupted. */
const running = new Set<ChildProcess>();
let interruptsHandled = false;

export const exec: Exec = (command, { cwd, env, timeoutMs, onWait, heartbeatMs = HEARTBEAT_MS }) =>
  new Promise((resolve) => {
    handleInterrupts();
    const [bin, ...args] = command;
    // Nothing answers a prompt during an update, so stdin is closed rather than an open pipe.
    // Off Windows the command leads its own process group, so its whole tree can be stopped.
    const options = { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    // npm is a .cmd shim on Windows, which only a shell can start
    const child =
      process.platform === 'win32'
        ? spawn(command.map(quote).join(' '), { ...options, shell: true })
        : spawn(bin, args, { ...options, detached: true });
    running.add(child);
    const started = Date.now();
    let output = '';
    let timedOut = false;
    const heartbeat = onWait ? setInterval(() => onWait(Date.now() - started, output), heartbeatMs) : undefined;
    const limit =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stopTree(child);
          }, timeoutMs);
    const finish = (result: ExecResult) => {
      running.delete(child);
      clearInterval(heartbeat);
      clearTimeout(limit);
      resolve(result);
    };
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => {
      if (!timedOut) return finish({ code: code ?? 1, output });
      const minutes = Math.round((timeoutMs ?? 0) / 60_000);
      const after = minutes >= 1 ? `${minutes} min` : `${timeoutMs} ms`;
      finish({ code: TIMED_OUT, output: `${output}\n✖ \`${command.join(' ')}\` was still running after ${after}, so it was stopped with everything it started.` });
    });
    child.on('error', (error) => finish({ code: 1, output: String(error) }));
  });

/**
 * Stops a command and every process under it. On Windows the child is the
 * shell, so killing it alone would leave npm, a preview server and browsers
 * running.
 */
function stopTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** An interrupted updater stops what it started instead of leaving it running. */
function handleInterrupts(): void {
  if (interruptsHandled) return;
  interruptsHandled = true;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.once(signal, () => {
      for (const child of running) stopTree(child);
      process.exit(code);
    });
  }
}

function quote(arg: string): string {
  return /^[\w@./:=^~+-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/** The last lines of a command's output, with anything key-like masked. */
export function tail(output: string, lines = 20): string {
  return output
    .replace(/alk_[A-Za-z0-9]{6,}/g, 'alk_…')
    .trim()
    .split('\n')
    .slice(-lines)
    .join('\n');
}
