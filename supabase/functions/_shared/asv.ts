// ASV (anti-snake-venom) transfer planner.

import {
  AMBULANCE_KMH,
  COLD_CHAIN_MAX_MIN,
  FRESH_MIN,
  MAX_SOURCES,
  POOL_SIZE,
  ROAD_FACTOR,
  STALE_MIN,
  STALE_PENALTY_MIN,
} from "./config.ts";
import { haversineKm, routeMatrix } from "./maps.ts";

export interface Origin {
  lat: number;
  lng: number;
  city?: string;
}

export interface StockCandidate {
  batch_id: string;
  hospital_id: string;
  hospital_name: string;
  city: string;
  lat: number;
  lng: number;
  batch_code: string;
  quantity: number;
  expiry_date: string;
  updated_at: string;
  toxicology_24x7: boolean;
}

export type Freshness = "FRESH" | "STALE" | "VERY_STALE";

export interface ScoredCandidate extends StockCandidate {
  freshness: Freshness;
  travel_minutes: number;
  km: number;
  estimated: boolean;
  score_min: number;
}

export interface PlannedSource {
  batch_id: string;
  hospital_id: string;
  hospital_name: string;
  batch_code: string;
  vials: number;
  travel_minutes: number;
  km: number;
  estimated: boolean;
  freshness: Freshness;
  toxicology_24x7: boolean;
}

export type PlanStatus = "PLAN_READY" | "NO_RELIABLE_STOCK" | "NOT_ENOUGH_STOCK_IN_CITY";

export interface AsvPlan {
  status: PlanStatus;
  move_mode: "MOVE_PATIENT" | "MOVE_MEDICINE";
  move_reason: string;
  sources: PlannedSource[];
  excluded_old: { hospital_name: string; batch_code: string; age_minutes: number }[];
  warnings: string[];
  estimated_any: boolean;
}

export function freshnessOf(updatedAt: string, now = Date.now()): Freshness {
  const ageMin = (now - new Date(updatedAt).getTime()) / 60000;
  if (ageMin <= FRESH_MIN) return "FRESH";
  if (ageMin <= STALE_MIN) return "STALE";
  return "VERY_STALE";
}

export function isExpired(expiryDate: string, now = Date.now()): boolean {
  return new Date(expiryDate + "T23:59:59Z").getTime() < now;
}

export function travelMinutes(km: number): number {
  return (km / AMBULANCE_KMH) * 60;
}

export function straightLineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return haversineKm(a, b) * ROAD_FACTOR;
}

export async function scoreCandidates(
  origin: Origin,
  stocks: StockCandidate[],
  now = Date.now(),
): Promise<{ scored: ScoredCandidate[]; excludedOld: { hospital_name: string; batch_code: string; age_minutes: number }[]; warnings: string[] }> {
  const warnings: string[] = [];
  const excludedOld: { hospital_name: string; batch_code: string; age_minutes: number }[] = [];
  const usable = stocks.filter((s) => {
    if (isExpired(s.expiry_date, now)) {
      warnings.push(`Expired batch ${s.batch_code} at ${s.hospital_name} excluded`);
      return false;
    }
    if (freshnessOf(s.updated_at, now) === "VERY_STALE") {
      const age = Math.round((now - new Date(s.updated_at).getTime()) / 60000);
      excludedOld.push({ hospital_name: s.hospital_name, batch_code: s.batch_code, age_minutes: age });
      return false;
    }
    return true;
  });
  const estimates = await routeMatrix(origin, usable.map((s) => ({ lat: s.lat, lng: s.lng })));
  const scored: ScoredCandidate[] = usable.map((s, i) => {
    const freshness = freshnessOf(s.updated_at, now);
    const est = estimates[i];
    const score = est.minutes + (freshness === "STALE" ? STALE_PENALTY_MIN : 0);
    return {
      ...s,
      freshness,
      travel_minutes: est.minutes,
      km: est.km,
      estimated: est.estimated,
      score_min: score,
    };
  });
  return { scored, excludedOld, warnings };
}

export function orderPool(scored: ScoredCandidate[]): ScoredCandidate[] {
  return [...scored].sort((a, b) => {
    if (a.toxicology_24x7 !== b.toxicology_24x7) return a.toxicology_24x7 ? -1 : 1;
    const aFresh = a.freshness === "FRESH" ? 0 : 1;
    const bFresh = b.freshness === "FRESH" ? 0 : 1;
    if (aFresh !== bFresh) return aFresh - bFresh;
    return a.score_min - b.score_min;
  }).slice(0, POOL_SIZE);
}

function combinations<T>(arr: T[], k: number): T[][] {
  const out: T[][] = [];
  const rec = (start: number, cur: T[]) => {
    if (cur.length === k) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      cur.push(arr[i]);
      rec(i + 1, cur);
      cur.pop();
    }
  };
  rec(0, []);
  return out;
}

export interface SelectionResult {
  chosen: ScoredCandidate[];
  status: PlanStatus;
}

export function selectSources(pool: ScoredCandidate[], vialsNeeded: number, stocks: StockCandidate[]): SelectionResult {
  for (let k = 1; k <= MAX_SOURCES; k++) {
    const combos = combinations(pool, k).filter((c) => c.reduce((sum, s) => sum + s.quantity, 0) >= vialsNeeded);
    if (combos.length > 0) {
      combos.sort((a, b) => Math.max(...a.map((s) => s.score_min)) - Math.max(...b.map((s) => s.score_min)));
      return { chosen: combos[0], status: "PLAN_READY" };
    }
  }
  const totalAll = stocks.reduce((sum, s) => sum + s.quantity, 0);
  if (totalAll >= vialsNeeded) return { chosen: [], status: "NO_RELIABLE_STOCK" };
  return { chosen: [], status: "NOT_ENOUGH_STOCK_IN_CITY" };
}

export function allocate(chosen: ScoredCandidate[], vialsNeeded: number): PlannedSource[] {
  const sorted = [...chosen].sort((a, b) => a.score_min - b.score_min);
  let remaining = vialsNeeded;
  const out: PlannedSource[] = [];
  for (const s of sorted) {
    if (remaining <= 0) break;
    const take = Math.min(s.quantity, remaining);
    remaining -= take;
    out.push({
      batch_id: s.batch_id,
      hospital_id: s.hospital_id,
      hospital_name: s.hospital_name,
      batch_code: s.batch_code,
      vials: take,
      travel_minutes: Math.round(s.travel_minutes),
      km: Math.round(s.km * 10) / 10,
      estimated: s.estimated,
      freshness: s.freshness,
      toxicology_24x7: s.toxicology_24x7,
    });
  }
  return out;
}

export function decideMoveMode(
  patientStable: boolean,
  sources: PlannedSource[],
  patientTravelMinutes: number | null,
): { move_mode: "MOVE_PATIENT" | "MOVE_MEDICINE"; reason: string } {
  if (!patientStable) {
    return { move_mode: "MOVE_MEDICINE", reason: "Patient unstable — medicine must travel, not the patient." };
  }
  const slowestSourceMin = sources.length ? Math.max(...sources.map((s) => s.travel_minutes)) : 0;
  if (patientTravelMinutes != null && patientTravelMinutes < slowestSourceMin) {
    return { move_mode: "MOVE_PATIENT", reason: `Patient can reach in ${Math.round(patientTravelMinutes)} min — faster than the slowest medicine leg (${Math.round(slowestSourceMin)} min).` };
  }
  return { move_mode: "MOVE_MEDICINE", reason: "Medicine travel is faster or equal — move the vials, not the patient." };
}

export async function planAsv(
  origin: Origin,
  stocks: StockCandidate[],
  vialsNeeded: number,
  patientStable: boolean,
  patientTravelMinutes?: number | null,
  now = Date.now(),
): Promise<AsvPlan> {
  const { scored, excludedOld, warnings } = await scoreCandidates(origin, stocks, now);
  const pool = orderPool(scored);
  const expiredIds = new Set(stocks.filter((s) => isExpired(s.expiry_date, now)).map((s) => s.batch_id));
  const { chosen, status } = selectSources(pool, vialsNeeded, stocks.filter((s) => !expiredIds.has(s.batch_id)));
  const sources = status === "PLAN_READY" ? allocate(chosen, vialsNeeded) : [];
  const { move_mode, reason } = decideMoveMode(patientStable, sources, patientTravelMinutes ?? null);

  const crossCity = origin.city != null && origin.city !== "" && sources.some((s) => {
    return !s.hospital_name.includes(origin.city!);
  });
  const finalWarnings = [...warnings];
  if (crossCity) finalWarnings.push("Cross-city transfer: ambulance authority approval may be needed");
  if (sources.some((s) => s.estimated)) finalWarnings.push("Travel times estimated from straight-line distance (no traffic data)");

  return {
    status,
    move_mode,
    move_reason: reason,
    sources,
    excluded_old: excludedOld,
    warnings: finalWarnings,
    estimated_any: sources.some((s) => s.estimated),
  };
}

export function custodyDerived(events: { event: string; at: string; location_name: string }[]): {
  currentLocation: string | null;
  transitMinutes: number | null;
  cold_chain_ok: boolean | null;
} {
  if (events.length === 0) return { currentLocation: null, transitMinutes: null, cold_chain_ok: null };
  const dispatched = events.filter((e) => e.event === "DISPATCHED").map((e) => new Date(e.at).getTime());
  const received = events.filter((e) => e.event === "RECEIVED").map((e) => new Date(e.at).getTime());
  const transit = dispatched.length && received.length
    ? (Math.max(...received) - Math.min(...dispatched)) / 60000
    : null;
  return {
    currentLocation: events[events.length - 1].location_name,
    transitMinutes: transit != null ? Math.round(transit) : null,
    cold_chain_ok: transit != null ? transit <= COLD_CHAIN_MAX_MIN : null,
  };
}
