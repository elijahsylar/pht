// Attempt limits for the two login steps (routes/auth.ts). In memory, per
// process: pm2 runs one instance, and a restart forgets the counts. The
// intended second layer is a per-IP limit_req on /api/auth/ in nginx, which a
// restart does not touch.
//
// Each step keeps two counters: one per client IP and one per account. An
// attempt is counted BEFORE the credential is checked, so a burst of parallel
// requests cannot all reach bcrypt before the first failure is recorded; a
// success then clears both counters for that step. Once `freeFailures` are
// used up the key is locked, and every further failure doubles the lock, up
// to `maxLockMs`. A locked key is refused without checking anything.
//
// The password step's account lock is skipped for an IP that completed both
// steps in the last 30 days (a "known" IP), so someone who only knows the user
// name cannot lock the owner out from an address the owner recently logged in
// from; that IP still has its own counter. The security step's account lock
// applies to everyone. Known IPs live
// in memory too: after a restart the owner is like any other client until the
// next full login. IPv6 clients are keyed by their /64, since one host
// usually controls a whole /64.

export interface LimitPolicy {
  freeFailures: number; // failures allowed before the first lock
  baseLockMs: number; // length of the first lock
  maxLockMs: number; // the doubling stops here
  forgetAfterMs: number; // a key with no failure for this long starts over
}

// Per IP: five tries, then 1, 2, 4 … minutes, at most an hour.
export const IP_POLICY: LimitPolicy = {
  freeFailures: 5,
  baseLockMs: 60_000,
  maxLockMs: 60 * 60_000,
  forgetAfterMs: 24 * 60 * 60_000,
};

// Per account, password step: anyone who knows the user name can drive this
// counter, so its cap is low. Known IPs are exempt from it (see above).
export const ACCOUNT_POLICY: LimitPolicy = {
  freeFailures: 10,
  baseLockMs: 60_000,
  maxLockMs: 15 * 60_000,
  forgetAfterMs: 24 * 60 * 60_000,
};

// Per account, security step: only someone who already has the password can
// drive it, so it backs off to a full day.
export const SECURITY_ACCOUNT_POLICY: LimitPolicy = {
  freeFailures: 10,
  baseLockMs: 60_000,
  maxLockMs: 24 * 60 * 60_000,
  forgetAfterMs: 7 * 24 * 60 * 60_000,
};

// How long a full login makes its IP "known", and how many are kept.
export const KNOWN_IP_MS = 30 * 24 * 60 * 60_000;
export const MAX_KNOWN_IPS = 100;

// IP entries are bounded so a spread-out attack cannot grow memory without
// limit; when full, the oldest entry goes. Account keys are few and never
// evicted.
export const MAX_IP_ENTRIES = 10_000;

interface Entry {
  failures: number;
  lastFailure: number;
  lockedUntil: number;
}

class Counter {
  private entries = new Map<string, Entry>();

  constructor(
    private policy: LimitPolicy,
    private maxEntries: number,
  ) {}

  // Milliseconds left on the lock, or 0.
  lockedFor(key: string, now: number): number {
    const e = this.live(key, now);
    return e && e.lockedUntil > now ? e.lockedUntil - now : 0;
  }

  // Count one attempt as a failure; success() undoes it.
  record(key: string, now: number): void {
    let e = this.live(key, now);
    if (!e) {
      if (this.entries.size >= this.maxEntries) this.evictOne(now);
      e = { failures: 0, lastFailure: now, lockedUntil: 0 };
    }
    // Re-insert so Map order tracks the most recent failure (oldest first).
    this.entries.delete(key);
    e.failures += 1;
    e.lastFailure = now;
    const over = e.failures - this.policy.freeFailures;
    if (over >= 0) {
      const lock = Math.min(this.policy.baseLockMs * 2 ** over, this.policy.maxLockMs);
      e.lockedUntil = now + lock;
    }
    this.entries.set(key, e);
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private live(key: string, now: number): Entry | undefined {
    const e = this.entries.get(key);
    if (e && now - e.lastFailure > this.policy.forgetAfterMs && e.lockedUntil <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  private evictOne(now: number): void {
    // Prefer an entry that is not locked; otherwise the oldest.
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= now) {
        this.entries.delete(k);
        return;
      }
    }
    const oldest = this.entries.keys().next();
    if (!oldest.done) this.entries.delete(oldest.value);
  }
}

export type Step = 'login' | 'security';

// The key for a client address: IPv4 (and IPv4-mapped IPv6) as is, other IPv6
// by its first four groups (the /64).
export function clientKey(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

export interface AttemptLimiter {
  // Refuse (with the wait in ms) or count the attempt and allow it.
  begin(step: Step, ip: string, account: string | null, now?: number): { allowed: true } | { allowed: false; retryAfterMs: number };
  // The credential was right: forget this step's failures for both keys. A
  // success on the security step also makes the IP known.
  success(step: Step, ip: string, account: string | null, now?: number): void;
  ipEntries(): number;
}

export function createAttemptLimiter(
  opts: { ip?: LimitPolicy; account?: LimitPolicy; securityAccount?: LimitPolicy; maxIpEntries?: number } = {},
): AttemptLimiter {
  const byIp = new Counter(opts.ip ?? IP_POLICY, opts.maxIpEntries ?? MAX_IP_ENTRIES);
  const byAccount: Record<Step, Counter> = {
    login: new Counter(opts.account ?? ACCOUNT_POLICY, Number.MAX_SAFE_INTEGER),
    security: new Counter(opts.securityAccount ?? SECURITY_ACCOUNT_POLICY, Number.MAX_SAFE_INTEGER),
  };
  const known = new Map<string, number>(); // client key -> known until
  const ipKey = (step: Step, ip: string) => `${step}:${clientKey(ip)}`;
  const isKnown = (ip: string, now: number) => (known.get(clientKey(ip)) ?? 0) > now;

  return {
    begin(step, ip, account, now = Date.now()) {
      // Known IPs skip only the password step's account lock: the security
      // step's counter is driven only by someone with the password.
      const exempt = account === null || (step === 'login' && isKnown(ip, now));
      const accountWait = exempt ? 0 : byAccount[step].lockedFor(account, now);
      const wait = Math.max(byIp.lockedFor(ipKey(step, ip), now), accountWait);
      if (wait > 0) return { allowed: false, retryAfterMs: wait };
      byIp.record(ipKey(step, ip), now);
      if (account !== null) byAccount[step].record(account, now);
      return { allowed: true };
    },
    success(step, ip, account, now = Date.now()) {
      byIp.clear(ipKey(step, ip));
      if (account !== null) byAccount[step].clear(account);
      if (step === 'security') {
        const k = clientKey(ip);
        known.delete(k);
        for (const [key, until] of known) if (until <= now) known.delete(key);
        if (known.size >= MAX_KNOWN_IPS) known.delete(known.keys().next().value as string);
        known.set(k, now + KNOWN_IP_MS);
      }
    },
    ipEntries: () => byIp.size,
  };
}

// The refusal the login page shows as-is (it displays any non-401 error text).
export function tooManyAttempts(retryAfterMs: number): { seconds: number; body: { error: string } } {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const minutes = Math.ceil(seconds / 60);
  const wait = seconds < 60 ? `${seconds} seconds` : minutes === 1 ? '1 minute' : `${minutes} minutes`;
  return { seconds, body: { error: `Too many attempts. Try again in ${wait}.` } };
}
