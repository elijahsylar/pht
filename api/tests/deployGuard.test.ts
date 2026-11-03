import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ops/lib/branch-guard.sh, exercised against throwaway git repos with a local
// bare "origin". Nothing here runs a deploy script or touches the network.

const REPO = path.resolve(__dirname, '..');
const GUARD = path.join(REPO, 'ops/lib/branch-guard.sh');
// Every deploy script must refuse before it builds, uploads or connects.
const DEPLOY_SCRIPTS = ['ops/pht-deploy-backend.sh', 'ops/pht-deploy-frontend.sh'];

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function guard(dir: string): { code: number; stderr: string } {
  const r = spawnSync(
    'bash',
    ['-c', 'source "$1"; require_deployable_main "$2"', '_', GUARD, dir],
    { env: GIT_ENV, encoding: 'utf8', timeout: 20_000 },
  );
  return { code: r.status ?? -1, stderr: r.stderr };
}

describe('require_deployable_main', () => {
  let tmp: string;
  let work: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pht-guard-'));
    const origin = path.join(tmp, 'origin.git');
    work = path.join(tmp, 'work');
    git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
    git(tmp, 'clone', '--quiet', origin, work);
    git(work, 'checkout', '--quiet', '-B', 'main');
    writeFileSync(path.join(work, 'a.txt'), 'one\n');
    git(work, 'add', 'a.txt');
    git(work, 'commit', '--quiet', '-m', 'one');
    git(work, 'push', '--quiet', '-u', 'origin', 'main');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('passes on main, clean, equal to origin/main', () => {
    expect(guard(work)).toEqual({ code: 0, stderr: '' });
  });

  it('refuses on another branch, even one identical to main', () => {
    git(work, 'checkout', '--quiet', '-b', 'rebuild');
    const r = guard(work);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/on branch 'rebuild' — deploys only run from main/);
  });

  it('refuses a detached HEAD', () => {
    git(work, 'checkout', '--quiet', '--detach');
    expect(guard(work)).toMatchObject({ code: 1, stderr: expect.stringMatching(/detached HEAD/) });
  });

  it('refuses a modified tracked file', () => {
    writeFileSync(path.join(work, 'a.txt'), 'edited\n');
    expect(guard(work)).toMatchObject({ code: 1, stderr: expect.stringMatching(/uncommitted/) });
  });

  it('refuses a staged change', () => {
    writeFileSync(path.join(work, 'b.txt'), 'new\n');
    git(work, 'add', 'b.txt');
    expect(guard(work).code).toBe(1);
  });

  it('refuses an untracked file', () => {
    writeFileSync(path.join(work, 'stray.txt'), 'x\n');
    expect(guard(work)).toMatchObject({ code: 1, stderr: expect.stringMatching(/stray\.txt/) });
  });

  it('ignores a gitignored file', () => {
    writeFileSync(path.join(work, '.gitignore'), '.env\n');
    git(work, 'add', '.gitignore');
    git(work, 'commit', '--quiet', '-m', 'ignore');
    git(work, 'push', '--quiet');
    writeFileSync(path.join(work, '.env'), 'X=1\n');
    expect(guard(work).code).toBe(0);
  });

  it('refuses a local commit not yet pushed', () => {
    writeFileSync(path.join(work, 'a.txt'), 'two\n');
    git(work, 'commit', '--quiet', '-am', 'two');
    expect(guard(work)).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/is not origin\/main/),
    });
  });

  it('refuses when origin/main has moved on since the last fetch', () => {
    const other = path.join(tmp, 'other');
    git(tmp, 'clone', '--quiet', path.join(tmp, 'origin.git'), other);
    writeFileSync(path.join(other, 'a.txt'), 'theirs\n');
    git(other, 'commit', '--quiet', '-am', 'theirs');
    git(other, 'push', '--quiet');
    // `work` has not fetched: only the guard's own fetch can notice.
    expect(guard(work)).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/is not origin\/main/),
    });
  });

  it('refuses when origin cannot be reached', () => {
    git(work, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git'));
    expect(guard(work)).toMatchObject({ code: 1, stderr: expect.stringMatching(/fetch .* failed/) });
  });

  it('refuses this repo when it is not on main', () => {
    // The real working tree. Only the branch check runs before it refuses, so
    // nothing is fetched. CI checks pull requests out on a detached HEAD.
    let branch: string | null;
    try {
      branch = git(REPO, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    } catch (e) {
      // symbolic-ref exits 1 for a detached HEAD and 128 outside a git
      // checkout (a downloaded archive); anything else is a real error.
      const status = (e as { status?: number }).status;
      if (status === 128) return; // not a checkout: nothing to prove
      if (status !== 1) throw e;
      branch = null;
    }
    if (branch === 'main') return; // nothing to prove from main
    const r = guard(REPO);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(branch === null ? 'detached HEAD' : `on branch '${branch}'`);
  });
});

describe.each(DEPLOY_SCRIPTS)('%s', (script) => {
  const lines = readFileSync(path.join(REPO, script), 'utf8').split('\n');
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l) && !l.trim().startsWith('#'));

  it('runs the guard before it builds, uploads or connects anywhere', () => {
    const guardLine = at(/require_deployable_main "\$PROJECT_DIR" \|\| die/);
    expect(guardLine).toBeGreaterThan(0);
    // The first line that does real work: a build, a copy, or any ssh call.
    const firstWork = Math.min(
      ...[/npm run build/, /\brsync\b/, /"\$\{SSH\[@\]\}"/, /^\s*ssh /, /\bcurl\b/]
        .map(at)
        .filter((i) => i >= 0),
    );
    expect(guardLine).toBeLessThan(firstWork);
    // And only after the cd and the repo assertion, so it checks the right repo.
    expect(guardLine).toBeGreaterThan(at(/^cd "\$PROJECT_DIR"/));
  });

  it('has no way to skip the guard', () => {
    const text = lines.join('\n');
    expect(text).not.toMatch(/--force|SKIP_GUARD|NO_GUARD|--no-guard/);
  });
});
