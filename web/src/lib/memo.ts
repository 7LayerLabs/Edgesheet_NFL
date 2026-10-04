/**
 * Tiny in-process TTL memo for data that is too large for the Next fetch cache
 * (which skips responses over 2MB) or that is computed rather than fetched.
 * Lives as long as the server process; on serverless it lives per instance.
 */
const store = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>();

/**
 * `ttlSeconds` may be a function of the resolved value, for data whose
 * freshness depends on what it contains (a slate with a live game needs a
 * shorter life than a quiet-day slate). While the promise is pending the
 * entry is held for 60s so concurrent callers share the in-flight build.
 */
export function memo<T>(key: string, ttlSeconds: number | ((value: T) => number), fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.at < hit.ttl * 1000) return hit.value as Promise<T>;
  const value = fn().catch((err) => {
    store.delete(key);
    throw err;
  });
  const entry = { at: now, ttl: typeof ttlSeconds === "number" ? ttlSeconds : 60, value };
  store.set(key, entry);
  if (typeof ttlSeconds === "function") {
    const pick = ttlSeconds;
    value.then((v) => {
      if (store.get(key) === entry) entry.ttl = pick(v);
    }).catch(() => {});
  }
  return value;
}

export function memoSync<T>(key: string, ttlSeconds: number, fn: () => T): T {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.at < hit.ttl * 1000) return hit.value as unknown as T;
  const value = fn();
  store.set(key, { at: now, ttl: ttlSeconds, value: value as unknown as Promise<unknown> });
  return value;
}
