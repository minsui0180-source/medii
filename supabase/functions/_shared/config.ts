// Shared config for the Swasthya Setu edge function.

export const MODEL = "gemini-3.8-flash"; // change if your key lists a different model (spec default: gemini-2.5-flash)
export const USE_REAL_HOSPITAL_NAMES = false; // true => keep seed hospital names; false => "Demo Hospital NN"

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

// ASV planner constants
export const ROAD_FACTOR = 1.3;
export const AMBULANCE_KMH = 30;
export const MAX_SOURCES = 3;
export const POOL_SIZE = 8;
export const FRESH_MIN = 60;
export const STALE_MIN = 180;
export const STALE_PENALTY_MIN = 15;
export const COLD_CHAIN_MAX_MIN = 120;
export const LEG_WINDOW_MIN = 3;
export const EMERGENCY_WINDOW_SEC = 90;

export const STAFF_SALT = "swasthya-demo-salt:";
export const SESSION_TTL_HOURS = 8;

export function sessionSecret(): string {
  return Deno.env.get("STAFF_SESSION_SECRET") ?? "demo-only-secret-change-me";
}

export function mapsKey(): string | null {
  return Deno.env.get("GOOGLE_MAPS_SERVER_KEY") ?? null;
}
