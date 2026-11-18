import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { listenOptions, startListening } from '../src/lib/listen.js';
import { createFakeStore } from './fakeStore.js';

describe('listenOptions', () => {
  it('defaults to loopback and port 4100', () => {
    expect(listenOptions({})).toEqual({ host: '127.0.0.1', port: 4100 });
  });

  it('takes the port from PORT and the host from LISTEN_HOST', () => {
    expect(listenOptions({ PORT: '4321' })).toEqual({ host: '127.0.0.1', port: 4321 });
    expect(listenOptions({ LISTEN_HOST: '::1', PORT: '0' })).toEqual({ host: '::1', port: 0 });
    expect(listenOptions({ LISTEN_HOST: ' 192.0.2.10 ' }).host).toBe('192.0.2.10');
  });

  it('falls back to loopback when LISTEN_HOST is blank, and ignores HOST', () => {
    expect(listenOptions({ LISTEN_HOST: '' }).host).toBe('127.0.0.1');
    expect(listenOptions({ LISTEN_HOST: '   ' }).host).toBe('127.0.0.1');
    expect(listenOptions({ HOST: 'some-machine-name' }).host).toBe('127.0.0.1');
  });
});

describe('the server', () => {
  // Starts the real app the way src/index.ts does, on an ephemeral port, and
  // returns the address startListening reports and the one the socket has.
  async function boundAddress(env: NodeJS.ProcessEnv): Promise<AddressInfo> {
    const app = createApp(createFakeStore({ seed: true }), { log: false });
    let server!: ReturnType<typeof startListening>;
    const reported = await new Promise<AddressInfo>((resolve, reject) => {
      server = startListening(app, env, resolve);
      server.once('error', reject);
    });
    try {
      expect(server.address()).toEqual(reported);
      return reported;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('is started by src/index.ts through startListening only', () => {
    const src = readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
    expect(src).toMatch(/startListening\(createApp\(/);
    expect(src).not.toMatch(/\.listen\(/);
  });

  it('binds to IPv4 loopback by default, not to every interface', async () => {
    const addr = await boundAddress({ PORT: '0' });
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.family).toBe('IPv4');
    expect(addr.port).toBeGreaterThan(0);
  });

  // Linux routes all of 127.0.0.0/8 to loopback, so a second loopback address
  // shows the configured host is the one bound without leaving the machine.
  it.skipIf(process.platform !== 'linux')('binds to the configured host', async () => {
    const addr = await boundAddress({ PORT: '0', LISTEN_HOST: '127.0.0.2' });
    expect(addr.address).toBe('127.0.0.2');
  });
});
