// Browser helpers: geolocation, Web Speech API, distance, queue math.

import type { QueueEntry } from '@/types';

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export function getUserLocation(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no-geolocation'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(new Error(e.code === 1 ? 'denied' : 'error')),
      { timeout: 8000 },
    );
  });
}

// Web Speech API (webkit-prefixed in Chrome)
type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string; isFinal?: boolean }>>; resultIndex: number }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export function createRecognition(lang: string): SpeechRecognitionLike | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = true;
  return rec;
}

export function speak(text: string, lang: string) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.95;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {
    /* no-op */
  }
}

export function baseScore(level: string): number {
  return level === 'EMERGENCY' ? 100 : level === 'URGENT' ? 60 : 20;
}

export function waitingPoints(createdAt: string): number {
  return Math.min(20, Math.round((Date.now() - new Date(createdAt).getTime()) / 120000));
}

export function priorityScore(e: Pick<QueueEntry, 'triage_level' | 'created_at'>): number {
  return baseScore(e.triage_level) + waitingPoints(e.created_at);
}

export function sortQueue<T extends Pick<QueueEntry, 'triage_level' | 'created_at' | 'priority_score'>>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const diff = priorityScore(b) - priorityScore(a);
    if (diff !== 0) return diff;
    return a.priority_score - b.priority_score; // reception manual order (lower = earlier)
  });
}

export function formatToken(seq: number): string {
  return `OPD-${String(1000 + seq).padStart(4, '0')}`;
}

export function estimateWaitMinutes(position: number): number {
  return position * 8;
}

export function validateAbha(id: string): boolean {
  return /^91-\d{4}-\d{4}-\d{4}$/.test(id.trim());
}
