/**
 * Pool env resolution must stay strict without touching a live database.
 *
 * `poolMaxFromEnv` and `poolIdleFloorFromEnv` gate how many Postgres
 * connections a process may hold and how many idle ones it keeps warm; a
 * malformed value must fail fast at boot rather than silently under-sizing or
 * over-sizing the pool.
 */
import { afterEach, expect, test } from "bun:test";
import { poolIdleFloorFromEnv, poolMaxFromEnv } from "../../src/persistence/db-pg";

const REAL_MAX = process.env.DATABASE_POOL_MAX;
const REAL_FLOOR = process.env.DATABASE_POOL_IDLE_FLOOR;

afterEach(() => {
  if (REAL_MAX === undefined) delete process.env.DATABASE_POOL_MAX;
  else process.env.DATABASE_POOL_MAX = REAL_MAX;
  if (REAL_FLOOR === undefined) delete process.env.DATABASE_POOL_IDLE_FLOOR;
  else process.env.DATABASE_POOL_IDLE_FLOOR = REAL_FLOOR;
});

test("poolMaxFromEnv falls back to the default bound", () => {
  delete process.env.DATABASE_POOL_MAX;
  expect(poolMaxFromEnv()).toBe(16);
});

test("poolMaxFromEnv rejects non-positive integers", () => {
  process.env.DATABASE_POOL_MAX = "0";
  expect(() => poolMaxFromEnv()).toThrow();
  process.env.DATABASE_POOL_MAX = "abc";
  expect(() => poolMaxFromEnv()).toThrow();
  process.env.DATABASE_POOL_MAX = "8.5";
  expect(() => poolMaxFromEnv()).toThrow();
});

test("poolIdleFloorFromEnv defaults to 2 and accepts 0", () => {
  delete process.env.DATABASE_POOL_IDLE_FLOOR;
  expect(poolIdleFloorFromEnv()).toBe(2);
  process.env.DATABASE_POOL_IDLE_FLOOR = "0";
  expect(poolIdleFloorFromEnv()).toBe(0);
});

test("poolIdleFloorFromEnv rejects negatives and junk", () => {
  process.env.DATABASE_POOL_IDLE_FLOOR = "-1";
  expect(() => poolIdleFloorFromEnv()).toThrow();
  process.env.DATABASE_POOL_IDLE_FLOOR = "many";
  expect(() => poolIdleFloorFromEnv()).toThrow();
});
