import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiTokenMatches } from '../src/lib/apiToken.js';
import {
  DEV_ANSWER,
  DEV_API_TOKEN,
  DEV_PASSWORD,
  DEV_USERNAME,
} from '../dev/credentials.js';

// `npm run dev:fake`, as a real process. It must refuse NODE_ENV=production
// before it binds anything, and otherwise serve the seeded fake API.

const REPO = path.resolve(__dirname, '..');
const TSX = path.join(REPO, 'node_modules/.bin/tsx');
const SERVER = path.join(REPO, 'dev/fakeServer.ts');

describe('dev:fake', () => {
  it('refuses to start with NODE_ENV=production', () => {
    const r = spawnSync(TSX, [SERVER], {
      cwd: REPO,
      env: { ...process.env, NODE_ENV: 'production', PORT: '0' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refusing to start: NODE_ENV=production/);
    expect(r.stdout).not.toMatch(/PHT API/);
  });

  it('is never part of the build', async () => {
    const tsconfig = (await import('../tsconfig.json')).default as { include: string[] };
    expect(tsconfig.include).toEqual(['src/**/*.ts']);
  });

  it('uses a dev token in the real token format', () => {
    expect(DEV_API_TOKEN).toMatch(/^pht_[A-Za-z0-9_-]{43,}$/);
    expect(apiTokenMatches(DEV_API_TOKEN, null)).toBe(false);
  });

  it('serves the seeded API with the printed credentials', async () => {
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    const child = spawn(TSX, [SERVER], {
      cwd: REPO,
      env: { ...process.env, NODE_ENV: 'development', PORT: String(port) },
    });
    let out = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no startup line: ${out}`)), 20_000);
        child.stdout.on('data', (d) => {
          out += d;
          if (out.includes('api token')) {
            clearTimeout(t);
            resolve();
          }
        });
        child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
      });
      expect(out).toContain(DEV_PASSWORD);
      expect(out).toContain(DEV_API_TOKEN);

      const base = `http://127.0.0.1:${port}/api`;
      const json = { 'Content-Type': 'application/json' };
      const login = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ username: DEV_USERNAME, password: DEV_PASSWORD }),
      });
      const { partialToken } = (await login.json()) as { partialToken: string };
      const verify = await fetch(`${base}/auth/verify-security`, {
        method: 'POST',
        headers: { ...json, Authorization: `Bearer ${partialToken}` },
        body: JSON.stringify({ answer: DEV_ANSWER }),
      });
      expect(verify.status).toBe(200);

      const today = await fetch(`${base}/today`, {
        headers: { Authorization: `Bearer ${DEV_API_TOKEN}` },
      });
      const body = (await today.json()) as {
        total: number;
        doneCount: number;
        habits: { slug: string; streak: number; best: number }[];
      };
      expect(body.total).toBe(6);
      expect(body.doneCount).toBe(0);
      const by = Object.fromEntries(body.habits.map((h) => [h.slug, h]));
      // stretch is one check short of the 7-day milestone, for the UI check's balloon.
      expect(by.stretch).toMatchObject({ streak: 6, best: 7 });
      expect(by.read).toMatchObject({ streak: 1, best: 10 });
      expect(by.water).toMatchObject({ streak: 0, best: 2 });
      expect(by.journal).toMatchObject({ streak: 14, best: 14 });
      expect(by.plan).toMatchObject({ streak: 0, best: 1 });
      expect(by.tidy).toMatchObject({ streak: 28, best: 28 });

      const auth = { headers: { Authorization: `Bearer ${DEV_API_TOKEN}` } };
      // A full 30-day History: checks on days 30+ back (read starts xxxx…).
      const hist = (await (await fetch(`${base}/history?days=35`, auth)).json()) as {
        habits: { done: boolean[] }[];
      };
      expect(hist.habits.every((h) => h.done.length === 35)).toBe(true);
      expect(hist.habits[1].done.slice(0, 3)).toEqual([true, true, true]);
      const notes = (await (await fetch(`${base}/notes`, auth)).json()) as unknown[];
      expect(notes).toHaveLength(8);
      // The fixed forecast, through the real service, uses every kind.
      const wx = (await (await fetch(`${base}/weather`, auth)).json()) as { days: { kind: string }[] };
      expect(new Set(wx.days.map((d) => d.kind))).toEqual(new Set(['sun', 'part', 'cloud', 'rain', 'storm', 'fog']));
    } finally {
      child.kill();
    }
  }, 30_000);
});
