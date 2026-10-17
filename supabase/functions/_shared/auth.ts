// Staff session tokens: HMAC-SHA256 signed, 8h expiry. Roles come from the token, never the body.

import { SESSION_TTL_HOURS, STAFF_SALT, sessionSecret } from "./config.ts";

export type StaffRole = "DOCTOR" | "RECEPTION" | "ADMIN";

export interface SessionClaims {
  sub: string;
  role: StaffRole;
  hospital_id: string | null;
  display_name: string;
  exp: number;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signToken(claims: Omit<SessionClaims, "exp">): Promise<string> {
  const full: SessionClaims = { ...claims, exp: Date.now() + SESSION_TTL_HOURS * 3600 * 1000 };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(full)));
  const key = await hmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(sig)}`;
}

export async function verifyToken(token: string): Promise<SessionClaims | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const key = await hmacKey();
  const expected = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const a = b64url(expected);
  if (a.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as SessionClaims;
    if (!claims.exp || claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(STAFF_SALT + password));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Returns claims or throws a Response-shaped error object.
export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function requireRole(req: Request, roles: StaffRole[]): Promise<SessionClaims> {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new AuthError("Missing session token", 401);
  const claims = await verifyToken(token);
  if (!claims) throw new AuthError("Invalid or expired session", 401);
  if (!roles.includes(claims.role)) throw new AuthError("Insufficient role", 403);
  return claims;
}
