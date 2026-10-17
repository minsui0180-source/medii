// Live updates via Supabase Realtime (replaces Socket.io in this stack).

import { supabase } from './supabase';
import { useEffect, useState } from 'react';
import type { QueueEntry, EmergencyRequest, Hospital } from '@/types';

export function useQueueLive() {
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [q, h] = await Promise.all([
        supabase.from('queue_entries').select('*').order('created_at', { ascending: true }),
        supabase.from('hospitals').select('*'),
      ]);
      if (!cancelled) {
        setQueue((q.data as QueueEntry[]) ?? []);
        setHospitals((h.data as Hospital[]) ?? []);
        setLoaded(true);
      }
    }
    load();

    const ch = supabase
      .channel('swasthya-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue_entries' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hospitals' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'emergency_requests' }, () => load())
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, []);

  return { queue, hospitals, loaded };
}

export function useEmergencyRequestsLive() {
  const [requests, setRequests] = useState<EmergencyRequest[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data } = await supabase
        .from('emergency_requests')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
      if (!cancelled) setRequests((data as EmergencyRequest[]) ?? []);
    }
    load();
    const ch = supabase
      .channel('swasthya-emergencies')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'emergency_requests' }, () => load())
      .subscribe();
    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, []);

  return requests;
}
