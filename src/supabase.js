// Supabase client. Keys come from .env (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).
import { createClient } from '@supabase/supabase-js';
import { isWeb } from './platform.js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isConfigured = !!(url && key && !url.includes('YOUR-PROJECT'));

export const supabase = isConfigured
  ? createClient(url, key, {
      auth: {
        persistSession: true,           // session survives restarts and works offline
        autoRefreshToken: true,
        flowType: 'pkce',
        detectSessionInUrl: isWeb,      // desktop/Android receive the code through a deep link
      },
      realtime: { params: { eventsPerSecond: 20 } },
    })
  : null;
