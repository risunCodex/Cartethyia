/** Redis scripts and key builders behind pool admission and cooldown accounting. */

export function proxyInflightKey(poolId: string): string {
  return `proxy:inflight:${poolId}`;
}

/**
 * One provider's share of one pool's inflight budget.
 *
 * Deliberately a *separate* key rather than a hash field on the pool counter:
 * the pool key is decremented and deleted by an existing script, and a shared
 * hash would make that script's `DEL` wipe every provider's count with it.
 * Separate keys keep the two lifetimes independent.
 */
export function proxyProviderInflightKey(poolId: string, providerId: string): string {
  return `proxy:inflight:${poolId}:${providerId.toLowerCase()}`;
}

export function proxyCooldownKey(poolId: string, providerId: string): string {
  return `proxy:cooldown:${poolId}:${providerId.toLowerCase()}`;
}

export function proxyCooldownProvidersKey(poolId: string): string {
  return `proxy:cooldown:providers:${poolId}`;
}

/** Compare-and-increment admission gate keyed by capacity + TTL. */
export const POOL_ADMIT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current >= tonumber(ARGV[1]) then return 0 end
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1
`;

/**
 * Admission for a provider that carries its own per-pool ceiling: the pool
 * counter and the provider counter are checked and raised together.
 *
 * Both `INCR`s must happen in this one script. Split across two calls, a
 * failure between them leaves the pool counter raised with no request to
 * release it, and the pool bleeds a slot per failed admission until the TTL
 * catches up.
 *
 * KEYS[1] pool counter, KEYS[2] provider counter.
 * ARGV[1] pool capacity, ARGV[2] provider capacity, ARGV[3] TTL seconds.
 * Returns 1 admitted, 0 pool full, 2 provider full — the caller reports which
 * ceiling was hit instead of guessing from a bare failure.
 */
export const POOL_PROVIDER_ADMIT_SCRIPT = `
local pool = tonumber(redis.call('GET', KEYS[1]) or '0')
if pool >= tonumber(ARGV[1]) then return 0 end
local provider = tonumber(redis.call('GET', KEYS[2]) or '0')
if provider >= tonumber(ARGV[2]) then return 2 end
local ttl = tonumber(ARGV[3])
redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ttl)
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ttl)
return 1
`;

/** Decrement a held inflight slot, or release the key when it reaches zero. */
export const POOL_RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 1 then redis.call('DEL', KEYS[1]); return 0 end
return redis.call('DECR', KEYS[1])
`;

/**
 * Release both halves of a provider-scoped admission.
 *
 * Each key is released independently: a counter that is already gone is not an
 * error, because the TTL may have expired it first. Never touches a key it did
 * not see.
 */
export const POOL_PROVIDER_RELEASE_SCRIPT = `
for index = 1, #KEYS do
  local current = tonumber(redis.call('GET', KEYS[index]) or '0')
  if current <= 1 then
    redis.call('DEL', KEYS[index])
  else
    redis.call('DECR', KEYS[index])
  end
end
return 1
`;

/** One cooldown marker plus its index entry, written atomically. */
export const COOLDOWN_FLAG_SCRIPT = `
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  redis.call('SADD', KEYS[2], ARGV[3])
  -- The index set must outlive every marker it lists, or it is evicted while
  -- a cooldown is still active and the pair becomes invisible to other
  -- processes. EXPIRE ... GT only ever extends, so a later short cooldown
  -- cannot shorten a longer one already indexed.
  local ttl = redis.call('TTL', KEYS[1])
  if ttl > 0 then
    local current = redis.call('TTL', KEYS[2])
    if current < 0 or ttl > current then redis.call('EXPIRE', KEYS[2], ttl) end
  end
  return 1
`;

/** Clears one cooldown marker and its index entry atomically. */
export const COOLDOWN_CLEAR_SCRIPT = `
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[1])
  return 1
`;
