// Maps helpers. Uses the Routes API when GOOGLE_MAPS_SERVER_KEY is set; otherwise
// straight-line distance x 1.3 at 30 km/h, marked estimated.

import { AMBULANCE_KMH, ROAD_FACTOR, mapsKey } from "./config.ts";

export interface TravelEstimate {
  minutes: number;
  km: number;
  estimated: boolean;
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export async function routeMatrix(
  origin: { lat: number; lng: number },
  destinations: { lat: number; lng: number }[],
): Promise<TravelEstimate[]> {
  const key = mapsKey();
  if (!key) {
    return destinations.map((d) => {
      const km = haversineKm(origin, d) * ROAD_FACTOR;
      return { minutes: (km / AMBULANCE_KMH) * 60, km, estimated: true };
    });
  }
  try {
    const res = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,duration",
      },
      body: JSON.stringify({
        origins: [{ waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } }],
        destinations: destinations.map((d) => ({
          waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
        })),
        travelMode: "DRIVE",
      }),
    });
    if (!res.ok) throw new Error(`Routes ${res.status}`);
    const rows = (await res.json()) as { destinationIndex: number; distanceMeters: number; duration: string }[];
    const out: TravelEstimate[] = destinations.map((d) => {
      const km = haversineKm(origin, d) * ROAD_FACTOR;
      return { minutes: (km / AMBULANCE_KMH) * 60, km, estimated: true };
    });
    for (const row of rows) {
      if (row.destinationIndex == null) continue;
      out[row.destinationIndex] = {
        minutes: (Number(row.duration.replace("s", "")) || 0) / 60,
        km: row.distanceMeters / 1000,
        estimated: false,
      };
    }
    return out;
  } catch {
    return destinations.map((d) => {
      const km = haversineKm(origin, d) * ROAD_FACTOR;
      return { minutes: (km / AMBULANCE_KMH) * 60, km, estimated: true };
    });
  }
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  label: string;
  estimated: boolean;
}

// Demo fallback list of Delhi-NCR areas with known coordinates.
const AREA_LIST: GeocodeResult[] = [
  { lat: 28.6315, lng: 77.2167, label: "Connaught Place, New Delhi", estimated: true },
  { lat: 28.5672, lng: 77.21, label: "Ansari Nagar, New Delhi", estimated: true },
  { lat: 28.7495, lng: 77.0565, label: "Rohini, New Delhi", estimated: true },
  { lat: 28.5245, lng: 77.2066, label: "Saket, New Delhi", estimated: true },
  { lat: 28.5921, lng: 77.046, label: "Dwarka, New Delhi", estimated: true },
  { lat: 28.5729, lng: 77.3256, label: "Sector 12, Noida", estimated: true },
  { lat: 28.6274, lng: 77.3646, label: "Sector 62, Noida", estimated: true },
  { lat: 28.4744, lng: 77.504, label: "Sector Alpha, Greater Noida", estimated: true },
  { lat: 28.6652, lng: 77.3604, label: "Vasundhara, Ghaziabad", estimated: true },
  { lat: 28.6694, lng: 77.4378, label: "Civil Lines, Ghaziabad", estimated: true },
  { lat: 28.4595, lng: 77.0266, label: "Sector 44, Gurugram", estimated: true },
  { lat: 28.4088, lng: 77.3178, label: "Old Faridabad, Faridabad", estimated: true },
  { lat: 28.6139, lng: 77.209, label: "Central Delhi", estimated: true },
];

export async function geocodeAddress(query: string): Promise<GeocodeResult | null> {
  const key = mapsKey();
  if (key) {
    try {
      const res = await fetch("https://maps.googleapis.com/maps/api/geocode/json", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
        body: JSON.stringify({ address: query, region: "in" }),
      });
      if (res.ok) {
        const data = await res.json();
        const r = data?.results?.[0];
        if (r?.geometry?.location) {
          return {
            lat: r.geometry.location.lat,
            lng: r.geometry.location.lng,
            label: r.formatted_address ?? query,
            estimated: false,
          };
        }
      }
    } catch {
      // fall through to area list
    }
  }
  const q = query.trim().toLowerCase();
  const hit = AREA_LIST.find((a) => a.label.toLowerCase().includes(q)) ?? AREA_LIST.find((a) => q.includes(a.label.split(",")[0].toLowerCase()));
  return hit ?? null;
}

export const AREA_SUGGESTIONS = AREA_LIST;
