import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ops/lib/frontend-artifact.sh against a real build of the 98.css page and
// against copies broken one way each. Needs the frontend built locally
// (`npm run build` in ~/projects/personal-habit-tracker); skipped otherwise.
// Nothing here deploys or connects anywhere.

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'ops/lib/frontend-artifact.sh');
const BUILD = path.join(process.env.HOME ?? '', 'projects/personal-habit-tracker/dist');
const built =
  existsSync(path.join(BUILD, 'index.html')) && existsSync(path.join(BUILD, 'vendor/98css'));

function verify(dir: string): { code: number; stderr: string } {
  const r = spawnSync(
    'bash',
    ['-c', 'set -euo pipefail; source "$1"; verify_frontend_artifact "$2"', '_', LIB, dir],
    {
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
  return { code: r.status ?? -1, stderr: r.stderr };
}

describe.skipIf(!built)('verify_frontend_artifact', () => {
  let dist: string;
  let tmp: string;
  const html = () => readFileSync(path.join(dist, 'index.html'), 'utf8');
  const setHtml = (s: string) => writeFileSync(path.join(dist, 'index.html'), s);
  const entry = () =>
    readdirSync(path.join(dist, 'assets')).find((f) => /^index-.*\.js$/.test(f)) as string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pht-artifact-'));
    dist = path.join(tmp, 'dist');
    cpSync(BUILD, dist, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('passes the real build', () => {
    expect(verify(dist)).toEqual({ code: 0, stderr: '' });
  });

  const broken: [string, () => void, RegExp][] = [
    [
      'no CSP meta',
      () => setHtml(html().replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')),
      /no Content-Security-Policy/,
    ],
    [
      'CSP without connect-src',
      () => setHtml(html().replace("connect-src 'self'", 'connect-src *')),
      /missing: connect-src 'self'/,
    ],
    [
      'CSP with unsafe-inline',
      () => setHtml(html().replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")),
      /unsafe-\* source/,
    ],
    [
      'CSP after a stylesheet',
      () => {
        const h = html();
        const meta = /<meta http-equiv="Content-Security-Policy"[^>]*>\n?/.exec(h)![0];
        setHtml(h.replace(meta, '').replace('</head>', `${meta}</head>`));
      },
      /must come before every/,
    ],
    [
      'an inline script',
      () => setHtml(html().replace('</body>', '<script>alert(1)</script></body>')),
      /inline <script>/,
    ],
    [
      'an inline style',
      () => setHtml(html().replace('<body>', '<body style="color:red">')),
      /inline styles/,
    ],
    [
      'two entry bundles',
      () =>
        setHtml(
          html().replace(
            '</head>',
            '<script type="module" src="/assets/index-AAAA.js"></script></head>',
          ),
        ),
      /exactly one/,
    ],
    [
      'entry bundle missing on disk',
      () => rmSync(path.join(dist, 'assets', entry())),
      /not in the build/,
    ],
    [
      'a source map',
      () => writeFileSync(path.join(dist, 'assets', 'index.js.map'), '{}'),
      /source maps/,
    ],
    ['an .env file', () => writeFileSync(path.join(dist, '.env'), 'X=1'), /\.env file/],
    ['a backend file', () => writeFileSync(path.join(dist, 'index.js'), ''), /BACKEND build/],
    [
      '98.css licence missing',
      () => rmSync(path.join(dist, 'vendor/98css/LICENSE')),
      /98css\/LICENSE is missing/,
    ],
    [
      'the DSEG font without its licence',
      () => rmSync(path.join(dist, 'vendor/dseg/DSEG-LICENSE.txt')),
      /no DSEG-LICENSE\.txt/,
    ],
    [
      '98.css not linked',
      () => setHtml(html().replace('/vendor/98css/98.css', '/98.css')),
      /does not link/,
    ],
    [
      'an absolute API URL in the bundle',
      () =>
        writeFileSync(path.join(dist, 'assets', entry()), 'const b="https://pht.example.com/api";'),
      /absolute API URL/,
    ],
    [
      'a localhost API URL in the bundle',
      () => writeFileSync(path.join(dist, 'assets', entry()), 'const b="http://localhost:4100/api";'),
      /absolute API URL/,
    ],
    [
      'CSP without manifest-src',
      () => setHtml(html().replace(" manifest-src 'self';", '')),
      /missing: manifest-src 'self'/,
    ],
    ['no manifest', () => rmSync(path.join(dist, 'manifest.webmanifest')), /manifest.webmanifest is missing/],
    [
      'a manifest that is not standalone',
      () => {
        const f = path.join(dist, 'manifest.webmanifest');
        writeFileSync(f, readFileSync(f, 'utf8').replace('"standalone"', '"browser"'));
      },
      /lacks "display":"standalone"/,
    ],
    [
      'the manifest not linked',
      () => setHtml(html().replace('rel="manifest"', 'rel="x-manifest"')),
      /does not link the manifest/,
    ],
    [
      'no apple-touch-icon link',
      () => setHtml(html().replace('rel="apple-touch-icon"', 'rel="icon"')),
      /apple-touch-icon link/,
    ],
    [
      'no apple-mobile-web-app-capable',
      () => setHtml(html().replace('name="apple-mobile-web-app-capable"', 'name="x"')),
      /apple-mobile-web-app-capable/,
    ],
    ['an icon missing', () => rmSync(path.join(dist, 'icons/icon-512.png')), /icon-512.png is missing/],
    [
      'an icon that is not a PNG',
      () => writeFileSync(path.join(dist, 'icons/icon-192.png'), 'GIF89a'),
      /icon-192.png is not a PNG/,
    ],
    [
      'an icon of the wrong size',
      () =>
        cpSync(path.join(dist, 'icons/icon-192.png'), path.join(dist, 'icons/apple-touch-icon.png')),
      /apple-touch-icon.png is 192px wide, expected 180/,
    ],
    ['a service worker', () => writeFileSync(path.join(dist, 'sw.js'), ''), /service worker/],
    [
      'a service-worker.js',
      () => writeFileSync(path.join(dist, 'service-worker.js'), ''),
      /service worker/,
    ],
    [
      'the legacy React bundle',
      () => writeFileSync(path.join(dist, 'assets', entry()), 'var x="react-dom";'),
      /react-dom/,
    ],
  ];

  it.each(broken)('refuses %s', (_name, breakIt, why) => {
    breakIt();
    const r = verify(dist);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(why);
  });

  it('does not mistake a hashed bundle name containing "sw" for a service worker', () => {
    writeFileSync(path.join(dist, 'assets', 'chunk-Swk3aSWb.js'), '');
    expect(verify(dist)).toEqual({ code: 0, stderr: '' });
  });

  it('refuses a directory that is not a build', () => {
    expect(verify(path.join(tmp, 'nope')).code).toBe(1);
    rmSync(path.join(dist, 'index.html'));
    expect(verify(dist).code).toBe(1);
  });
});

describe('ops/pht-deploy-frontend.sh', () => {
  const text = readFileSync(path.join(REPO, 'ops/pht-deploy-frontend.sh'), 'utf8');
  it('verifies the artifact after building and before uploading', () => {
    const build = text.indexOf('npm run build');
    const verifyAt = text.indexOf('verify_frontend_artifact "$SRC" || die');
    const upload = text.indexOf('rsync -az');
    expect(build).toBeGreaterThan(0);
    expect(verifyAt).toBeGreaterThan(build);
    expect(upload).toBeGreaterThan(verifyAt);
  });
  it('no longer forces an API base: the page has none to set', () => {
    expect(text).not.toMatch(/VITE_API_BASE_URL/);
    expect(text).toMatch(/^npm run build$/m);
  });
});
