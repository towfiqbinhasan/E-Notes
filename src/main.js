// E-Notes entry point: auth -> local database -> UI -> background sync.
import './styles.css';
import { supabase, isConfigured } from './supabase.js';
import { openUserDb, getLastUser, setLastUser, clearLastUser } from './db.js';
import { loadAll } from './store.js';
import { startSync } from './sync.js';
import { initUI, applyTheme, toast } from './ui.js';
import { isWeb, oauthRedirectUrl, openExternal, onDeepLink } from './platform.js';

const $ = (id) => document.getElementById(id);
const LOCAL_USER = { id: 'local', email: '' };
const LOCAL_FLAG = 'enotes-local-mode';

applyTheme();
registerServiceWorker();

// Give up waiting for the network after a few seconds so the app opens offline.
const withTimeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res(null), ms))]);

async function boot() {
  let localMode = false;
  try { localMode = localStorage.getItem(LOCAL_FLAG) === '1'; } catch { /* ignore */ }
  // Without a sync server (no Supabase keys in this build) there is nothing to sign in to:
  // open the notebooks straight away, saved on this device.
  if (localMode || !isConfigured) return startApp(LOCAL_USER, { localMode: true });

  const res = await withTimeout(supabase.auth.getSession(), 5000);
  const session = res && res.data ? res.data.session : null;
  if (session) return startApp(session.user);

  // No session available (e.g. offline and the token could not be refreshed):
  // open the last account's local data; sync starts once the session is back.
  const last = await getLastUser();
  if (last && !navigator.onLine) return startApp(last, { offlineOnly: true });
  showLogin();
}

// ---------------- login screen ----------------

function showLogin() {
  $('splash').hidden = true;
  $('app').hidden = true;
  $('login').hidden = false;
  const msg = $('login-message');
  const say = (text, error = false) => { msg.textContent = text; msg.classList.toggle('error', error); };

  if (!isConfigured) {
    $('login-config-warning').hidden = false;
    $('login-fields').hidden = true;
  }

  const busy = (on) => {
    for (const b of document.querySelectorAll('#login-form button')) b.disabled = on;
  };
  const credentials = () => ({ email: $('login-email').value.trim(), password: $('login-password').value });

  $('login-form').onsubmit = async (e) => {
    e.preventDefault();
    busy(true);
    say('Signing in…');
    const { error } = await supabase.auth.signInWithPassword(credentials());
    busy(false);
    if (error) return say(error.message, true);
    location.reload();
  };

  $('btn-signup').onclick = async () => {
    if (!$('login-form').reportValidity()) return;
    busy(true);
    say('Creating account…');
    const { data, error } = await supabase.auth.signUp({
      ...credentials(),
      options: { emailRedirectTo: isWeb ? oauthRedirectUrl() : undefined },
    });
    busy(false);
    if (error) return say(error.message, true);
    if (data.session) location.reload();
    else say('Check your email to confirm your account, then sign in.');
  };

  $('btn-google').onclick = async () => {
    busy(true);
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: oauthRedirectUrl(), skipBrowserRedirect: !isWeb },
    });
    busy(false);
    if (error) return say(error.message, true);
    if (!isWeb && data && data.url) {
      say('Finish signing in in your browser…');
      openExternal(data.url);
    }
  };

  $('btn-local').onclick = () => {
    if (!confirm('Use E-Notes without an account? Notes stay on this device only and are not synced.')) return;
    try { localStorage.setItem(LOCAL_FLAG, '1'); } catch { /* ignore */ }
    location.reload();
  };
}

// Desktop / Android: Google sends us back via a deep link with ?code=...
onDeepLink(async (url) => {
  if (!supabase) return;
  const u = new URL(url);
  const params = new URLSearchParams(u.search || u.hash.replace(/^#/, ''));
  const code = params.get('code');
  const errorText = params.get('error_description');
  if (errorText) { toast(errorText, { error: true }); return; }
  if (!code) return;
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) toast(error.message, { error: true });
  else location.reload();
});

// ---------------- app ----------------

async function startApp(user, { localMode = false, offlineOnly = false } = {}) {
  await openUserDb(user.id);
  await loadAll();
  if (!localMode) await setLastUser({ id: user.id, email: user.email });

  $('splash').hidden = true;
  $('login').hidden = true;
  $('app').hidden = false;

  let sync = null;
  let ui = null;
  const begin = () => {
    sync = startSync({ supabase, userId: user.id, onStatus: (s) => ui && ui.setSyncStatus(s) });
    sync.onLiveInk((payload) => ui && ui.showLiveInk(payload));
  };

  ui = initUI({
    user,
    get sync() { return sync; },
    localMode,
    onSignOut: async () => {
      if (localMode) {
        try { localStorage.removeItem(LOCAL_FLAG); } catch { /* ignore */ }
        location.reload();
        return;
      }
      if (sync) sync.stop();
      await clearLastUser();
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      location.reload();
    },
  });

  if (localMode) return;
  if (!offlineOnly) {
    begin();
  } else {
    ui.setSyncStatus('offline');
    // When the connection comes back, restore the session and start syncing.
    window.addEventListener('online', async function retry() {
      const { data } = await supabase.auth.getSession();
      if (data.session && data.session.user.id === user.id) {
        window.removeEventListener('online', retry);
        begin();
      } else if (!data.session) {
        ui.setSyncStatus('signin');
      }
    });
  }

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.reload();
  });
}

// ---------------- PWA ----------------

function registerServiceWorker() {
  // Only for the hosted web app; Electron and Android already ship the files locally.
  if (!isWeb || !('serviceWorker' in navigator) || import.meta.env.DEV) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
  });
}

boot().catch((err) => {
  console.error(err);
  $('splash').hidden = true;
  document.body.insertAdjacentHTML('beforeend',
    `<p style="padding:24px">E-Notes could not start: ${String(err && err.message ? err.message : err).replace(/</g, '&lt;')}</p>`);
});
