import { spawn, type ChildProcess } from 'node:child_process';
import { parseArgs as parseNodeArgs } from 'node:util';
import { pidAlive } from '../storage/lock.ts';
import { isRecord, readJsonSidecar } from '../storage/sidecar.ts';

const CHECK_MS = 1000;
const KILL_GRACE_MS = 5000;

interface ServerLock {
  pid: number;
  token: string;
}

interface Args {
  lockPath: string;
  pid: number;
  token: string;
  command: string[];
}

async function lockAlive(lockPath: string, pid: number, token: string): Promise<boolean> {
  const lock = await readJsonSidecar(lockPath, isServerLock);
  return lock?.pid === pid && lock.token === token && pidAlive(pid);
}

function isServerLock(value: unknown): value is ServerLock {
  return isRecord(value) && typeof value.pid === 'number' && typeof value.token === 'string';
}

function parseArgs(argv: string[]): Args {
  const sep = argv.indexOf('--');
  const command = sep === -1 ? [] : argv.slice(sep + 1);
  const { values } = parseNodeArgs({
    args: sep === -1 ? argv : argv.slice(0, sep),
    options: {
      lock: { type: 'string' },
      pid: { type: 'string' },
      token: { type: 'string' },
    },
    allowPositionals: true,
    strict: false,
  });
  const lockPath = stringArg(values.lock);
  const pid = Number(stringArg(values.pid));
  const token = stringArg(values.token);
  if (!lockPath || !Number.isInteger(pid) || pid <= 0 || !token || command.length === 0) {
    throw new Error('usage: owner-monitor --lock <path> --pid <pid> --token <token> -- <command...>');
  }
  return { lockPath, pid, token, command };
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stopChild(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
  }
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, KILL_GRACE_MS).unref();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!(await lockAlive(args.lockPath, args.pid, args.token))) process.exit(0);

  const child = spawn(args.command[0]!, args.command.slice(1), {
    detached: true,
    stdio: 'inherit',
  });
  let stopping = false;
  let checking = false;
  const interval = setInterval(() => {
    if (checking || stopping) return;
    checking = true;
    void lockAlive(args.lockPath, args.pid, args.token).then((alive) => {
      if (alive || stopping) return;
      stopping = true;
      stopChild(child);
    }).finally(() => {
      checking = false;
    });
  }, CHECK_MS);
  interval.unref();

  const stopAndExit = () => {
    stopping = true;
    stopChild(child);
  };
  process.on('SIGINT', stopAndExit);
  process.on('SIGTERM', stopAndExit);
  process.on('SIGHUP', stopAndExit);

  child.on('exit', (code, signal) => {
    clearInterval(interval);
    process.exit(signal ? signalExitCode(signal) : code ?? 0);
  });
  child.on('error', () => process.exit(127));
}

function signalExitCode(signal: NodeJS.Signals): number {
  const codes: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
  return codes[signal] ?? 128;
}

if (import.meta.main) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
