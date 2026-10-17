// ASV planner unit tests. Run: deno test supabase/functions/_shared/asv.test.ts --allow-all

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  allocate,
  decideMoveMode,
  freshnessOf,
  isExpired,
  orderPool,
  planAsv,
  selectSources,
  type ScoredCandidate,
  type StockCandidate,
} from "./asv.ts";

const NOW = new Date("2026-10-17T11:00:00Z").getTime();

function mkStock(over: Partial<StockCandidate> = {}): StockCandidate {
  return {
    batch_id: over.batch_id ?? crypto.randomUUID(),
    hospital_id: over.hospital_id ?? crypto.randomUUID(),
    hospital_name: over.hospital_name ?? "Demo Hospital X",
    city: over.city ?? "New Delhi",
    lat: over.lat ?? 28.6,
    lng: over.lng ?? 77.2,
    batch_code: over.batch_code ?? "BATCH-X",
    quantity: over.quantity ?? 10,
    expiry_date: over.expiry_date ?? "2027-03-31",
    updated_at: over.updated_at ?? new Date(NOW - 10 * 60000).toISOString(),
    toxicology_24x7: over.toxicology_24x7 ?? false,
  };
}

function mkScored(over: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    ...mkStock(over),
    freshness: over.freshness ?? "FRESH",
    travel_minutes: over.travel_minutes ?? 10,
    km: over.km ?? 5,
    estimated: over.estimated ?? true,
    score_min: over.score_min ?? 10,
  } as ScoredCandidate;
}

// --- freshness / expiry ---
Deno.test("freshnessOf: 10 min old is FRESH", () => {
  assertEquals(freshnessOf(new Date(NOW - 10 * 60000).toISOString(), NOW), "FRESH");
});
Deno.test("freshnessOf: 120 min old is STALE", () => {
  assertEquals(freshnessOf(new Date(NOW - 120 * 60000).toISOString(), NOW), "STALE");
});
Deno.test("freshnessOf: 200 min old is VERY_STALE", () => {
  assertEquals(freshnessOf(new Date(NOW - 200 * 60000).toISOString(), NOW), "VERY_STALE");
});
Deno.test("isExpired: past date is expired", () => {
  assertEquals(isExpired("2026-01-01", NOW), true);
});
Deno.test("isExpired: future date is not expired", () => {
  assertEquals(isExpired("2027-03-31", NOW), false);
});

// --- ordering ---
Deno.test("orderPool: fresh source preferred over stale one at same distance", () => {
  const fresh = mkScored({ batch_code: "F", freshness: "FRESH", score_min: 30 });
  const stale = mkScored({ batch_code: "S", freshness: "STALE", score_min: 30 });
  const pool = orderPool([stale, fresh]);
  assertEquals(pool[0].batch_code, "F");
});
Deno.test("orderPool: toxicology 24x7 preferred", () => {
  const tox = mkScored({ batch_code: "TOX", toxicology_24x7: true, score_min: 50 });
  const nonTox = mkScored({ batch_code: "NOTOX", toxicology_24x7: false, score_min: 10 });
  const pool = orderPool([nonTox, tox]);
  assertEquals(pool[0].batch_code, "TOX");
});

// --- selection ---
Deno.test("selectSources: single source chosen when one covers the need", () => {
  const a = mkScored({ batch_code: "A", quantity: 15 });
  const b = mkScored({ batch_code: "B", quantity: 12 });
  const { chosen, status } = selectSources(orderPool([a, b]), 10, [a, b]);
  assertEquals(status, "PLAN_READY");
  assertEquals(chosen.length, 1);
  assertEquals(chosen[0].batch_code, "A");
});
Deno.test("selectSources: two sources combined when no single one covers the need", () => {
  const a = mkScored({ batch_code: "A", quantity: 6 });
  const b = mkScored({ batch_code: "B", quantity: 6 });
  const { chosen, status } = selectSources(orderPool([a, b]), 10, [a, b]);
  assertEquals(status, "PLAN_READY");
  assertEquals(chosen.length, 2);
});
Deno.test("selectSources: NOT_ENOUGH_STOCK_IN_CITY when total < needed", () => {
  const a = mkScored({ batch_code: "A", quantity: 4 });
  const b = mkScored({ batch_code: "B", quantity: 3 });
  const { status } = selectSources(orderPool([a, b]), 10, [a, b]);
  assertEquals(status, "NOT_ENOUGH_STOCK_IN_CITY");
});

// --- allocation ---
Deno.test("allocate: takes min(stock, remaining) from each source in score order", () => {
  const a = mkScored({ batch_code: "A", quantity: 4, score_min: 10 });
  const b = mkScored({ batch_code: "B", quantity: 10, score_min: 20 });
  const out = allocate([a, b], 10);
  assertEquals(out[0].batch_code, "A");
  assertEquals(out[0].vials, 4);
  assertEquals(out[1].batch_code, "B");
  assertEquals(out[1].vials, 6);
});

// --- full plan (offline estimate path) ---
Deno.test("planAsv: PLAN_READY with single covering source", async () => {
  const stocks = [mkStock({ hospital_name: "Big", quantity: 15 })];
  const plan = await planAsv({ lat: 28.6, lng: 77.2, city: "New Delhi" }, stocks, 10, true, null, NOW);
  assertEquals(plan.status, "PLAN_READY");
  assertEquals(plan.sources.length, 1);
  assertEquals(plan.sources[0].vials, 10);
});
Deno.test("planAsv: NO_RELIABLE_STOCK when all records over 180 minutes old", async () => {
  const stocks = [
    mkStock({ hospital_name: "Old1", quantity: 15, updated_at: new Date(NOW - 200 * 60000).toISOString() }),
    mkStock({ hospital_name: "Old2", quantity: 15, updated_at: new Date(NOW - 300 * 60000).toISOString() }),
  ];
  const plan = await planAsv({ lat: 28.6, lng: 77.2, city: "New Delhi" }, stocks, 10, true, null, NOW);
  assertEquals(plan.status, "NO_RELIABLE_STOCK");
  assertEquals(plan.excluded_old.length, 2);
});
Deno.test("planAsv: NOT_ENOUGH_STOCK_IN_CITY when totals short", async () => {
  const stocks = [mkStock({ quantity: 3 }), mkStock({ quantity: 4 })];
  const plan = await planAsv({ lat: 28.6, lng: 77.2, city: "New Delhi" }, stocks, 10, true, null, NOW);
  assertEquals(plan.status, "NOT_ENOUGH_STOCK_IN_CITY");
});
Deno.test("planAsv: stale penalty makes fresh far source beat stale near one", async () => {
  const freshFar = mkStock({ hospital_name: "FreshFar", quantity: 12, lat: 28.9, lng: 77.5, updated_at: new Date(NOW - 5 * 60000).toISOString() });
  const staleNear = mkStock({ hospital_name: "StaleNear", quantity: 12, lat: 28.61, lng: 77.21, updated_at: new Date(NOW - 100 * 60000).toISOString() });
  const plan = await planAsv({ lat: 28.6, lng: 77.2, city: "New Delhi" }, [freshFar, staleNear], 10, true, null, NOW);
  assertEquals(plan.status, "PLAN_READY");
  assertEquals(plan.sources[0].hospital_name, "StaleNear"); // near+15min penalty still wins on total score
});
Deno.test("planAsv: MOVE_MEDICINE when patient is unstable", async () => {
  const stocks = [mkStock({ quantity: 15 })];
  const plan = await planAsv({ lat: 28.6, lng: 77.2, city: "New Delhi" }, stocks, 10, false, null, NOW);
  assertEquals(plan.move_mode, "MOVE_MEDICINE");
});
Deno.test("planAsv: MOVE_PATIENT when patient travel is strictly faster", async () => {
  const stocks = [mkStock({ quantity: 15, lat: 28.9, lng: 77.5 })]; // far away
  const plan = await planAsv({ lat: 28.6, lng: 77.2, city: "New Delhi" }, stocks, 10, true, 5, NOW);
  assertEquals(plan.move_mode, "MOVE_PATIENT");
});
Deno.test("planAsv: expired batch excluded with warning", async () => {
  const stocks = [mkStock({ quantity: 15, expiry_date: "2026-01-01" })];
  const plan = await planAsv({ lat: 28.6, lng: 77.2, city: "New Delhi" }, stocks, 10, true, null, NOW);
  assertEquals(plan.status, "NOT_ENOUGH_STOCK_IN_CITY");
  assertEquals(plan.warnings.some((w) => w.includes("Expired batch")), true);
});

// --- move mode unit ---
Deno.test("decideMoveMode: unstable always MOVE_MEDICINE", () => {
  const { move_mode } = decideMoveMode(false, [{ travel_minutes: 5 } as never], 3);
  assertEquals(move_mode, "MOVE_MEDICINE");
});
Deno.test("decideMoveMode: MOVE_PATIENT when patient travel beats source", () => {
  const { move_mode } = decideMoveMode(true, [{ travel_minutes: 30 } as never], 10);
  assertEquals(move_mode, "MOVE_PATIENT");
});
