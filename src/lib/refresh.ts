// Realtime refresh signal: broadcast only, no patient data in payloads.
// The edge function broadcasts after writes; screens refetch via the API on signal.

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

const client = createClient(url, anonKey, { realtime: { params: { eventsPerSecond: 5 } } });

export function useRefreshSignal(onRefresh: () => void, scope?: string): boolean {
  const [live, setLive] = useState(false);
  const cbRef = useRef(onRefresh);
  cbRef.current = onRefresh;

  useEffect(() => {
    const channel = client.channel('swasthya-live');
    channel.on('broadcast', { event: 'refresh' }, (msg: { payload?: { scope?: string } }) => {
      if (!scope || !msg.payload?.scope || msg.payload.scope === scope) {
        cbRef.current();
      }
    })
      .subscribe((status: string) => {
        setLive(status === 'SUBSCRIBED');
      });

    const recon = setInterval(() => {
      if (channel.state !== 'joined') client.removeChannel(channel);
    }, 30000);

    return () => {
      clearInterval(recon);
      client.removeChannel(channel);
    };
  }, [scope]);

  return live;
}

// Poll fallback for environments where realtime is blocked: refetch every 15s.
export function usePollFallback(onRefresh: () => void, ms = 15000) {
  useEffect(() => {
    const iv = setInterval(onRefresh, ms);
    return () => clearInterval(iv);
  }, [onRefresh, ms]);
}
