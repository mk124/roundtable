import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const tempDir = () => mkdtemp(join(tmpdir(), 'rt-lock-monitor-'));

test('owner-monitor stops its child when the owner lock changes', async () => {
  const dir = await tempDir();
  const lock = join(dir, 'server.lock.json');
  const ready = join(dir, 'ready');
  const stopped = join(dir, 'stopped');
  const childScript = join(dir, 'child.js');
  await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'live' }));
  await writeFile(childScript, `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
    process.on('SIGTERM', () => {
      fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped');
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `);

  const monitor = spawnMonitor(lock, 'live', [process.execPath, childScript]);
  try {
    await waitForFile(ready);
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'other' }));

    assert.equal(await waitForExit(monitor), 0);
    await waitForFile(stopped);
  } finally {
    if (monitor.exitCode === null && monitor.signalCode === null) monitor.kill('SIGKILL');
  }
});

test('owner-monitor exits without launching a child when the owner lock is invalid', async () => {
  const dir = await tempDir();
  const lock = join(dir, 'server.lock.json');
  const ready = join(dir, 'ready');
  const childScript = join(dir, 'child.js');
  await writeFile(lock, JSON.stringify({ pid: process.pid, token: 'other' }));
  await writeFile(childScript, `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');`);

  const monitor = spawnMonitor(lock, 'live', [process.execPath, childScript]);
  try {
    assert.equal(await waitForExit(monitor), 0);
    assert.equal(await fileExists(ready), false);
  } finally {
    if (monitor.exitCode === null && monitor.signalCode === null) monitor.kill('SIGKILL');
  }
});

function spawnMonitor(lockPath: string, token: string, command: string[]): ChildProcess {
  return spawn(process.execPath, [
    'src/agents/owner-monitor.ts',
    '--lock',
    lockPath,
    '--pid',
    String(process.pid),
    '--token',
    token,
    '--',
    ...command,
  ], { cwd: process.cwd(), stdio: 'ignore' });
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('process did not exit'));
    }, 4000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await fileExists(path)) return;
    await delay(100);
  }
  throw new Error(`file did not appear: ${path}`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
