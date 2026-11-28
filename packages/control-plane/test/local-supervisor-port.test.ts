/**
 * The local supervisor is handed a probed loopback port and binds it a moment later. When another
 * process takes the port in between, the driver must notice the failed bind and retry on a fresh
 * port instead of timing out (or talking to the squatter).
 */
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ControlPlaneDb } from '../src/db.js';
import { getFreeLoopbackPort, WorkspaceHostDriver } from '../src/drivers/workspace-host-driver.js';

const FAKE_SUPERVISOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-supervisor.mjs');
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('local supervisor port allocation', () => {
  it('retries on a fresh port when the probed one is taken before the supervisor binds it', async () => {
    // A squatter holds the first port handed out (the close-then-reuse race, made deterministic)
    const squatter = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => new Promise<void>((r) => squatter.close(() => r())));
    const takenPort = (squatter.address() as net.AddressInfo).port;
    const handedOut: number[] = [];
    const allocatePort = async () => {
      const port = handedOut.length === 0 ? takenPort : await getFreeLoopbackPort();
      handedOut.push(port);
      return port;
    };

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'halley-sup-port-'));
    const cfg = { ...loadConfig(), dataDir: tmp, workspaceHostUrl: '' };
    const db = new ControlPlaneDb(path.join(tmp, 'cp.sqlite'), cfg);
    const driver = new WorkspaceHostDriver(cfg, db, {} as never, { allocatePort, supervisorEntry: FAKE_SUPERVISOR });
    cleanups.push(async () => {
      await driver.close?.();
      db.close();
      await fs.rm(tmp, { recursive: true, force: true });
    });

    const url = await driver.getHostUrl();
    expect(handedOut).toHaveLength(2);
    expect(handedOut[1]).not.toBe(takenPort);
    expect(url).toBe(`http://127.0.0.1:${handedOut[1]}`);
    const health = (await (await fetch(`${url}/health`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);
  });
});
