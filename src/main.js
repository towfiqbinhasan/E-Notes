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
  const card = $('login-form');
  const msg = $('login-message');
  const say = (text, error = false) => {
    msg.textContent = text;
    msg.classList.toggle('error', error);
    if (error) { card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake'); }
  };

  if (!isConfigured) {
    $('login-config-warning').hidden = false;
    $('login-fields').hidden = true;
  }

  // Show "Continue with Google" only when Google is switched on in Supabase.
  showGoogleIfEnabled();

  // ----- Sign in / Create account tabs -----
  let mode = 'signin';
  const setMode = (m) => {
    mode = m;
    for (const t of card.querySelectorAll('.auth-tab')) t.classList.toggle('active', t.dataset.mode === m);
    card.querySelector('.auth-tabs').classList.toggle('second', m === 'signup');
    $('signup-extra').classList.toggle('open', m === 'signup');
    $('forgot-row').classList.toggle('gone', m === 'signup');
    $('btn-submit').querySelector('.label').textContent = m === 'signup' ? 'Create account' : 'Sign in';
    $('login-sub').textContent = m === 'signup' ? 'Create your free account. It takes 10 seconds.' : 'Welcome back! Sign in to your notebooks.';
    $('login-password').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    say('');
    checkMatch();
  };
  for (const t of card.querySelectorAll('.auth-tab')) t.onclick = () => setMode(t.dataset.mode);

  // ----- show / hide password -----
  for (const btn of card.querySelectorAll('.pw-toggle')) {
    btn.onclick = () => {
      const input = $(btn.dataset.for);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.classList.toggle('on', show);
      btn.title = show ? 'Hide password' : 'Show password';
    };
  }

  // ----- password strength + "passwords match" -----
  const strength = (pw) => {
    let score = 0;
    if (pw.length >= 6) score++;
    if (pw.length >= 10) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
    return pw ? Math.max(1, score) : 0;
  };
  function checkMatch() {
    const pw = $('login-password').value, cf = $('login-confirm').value;
    const sc = strength(pw);
    const meter = $('pw-strength');
    meter.dataset.score = sc;
    meter.querySelector('span').textContent = ['', 'Weak', 'Okay', 'Good', 'Strong'][sc];
    const m = $('pw-match');
    if (mode !== 'signup' || !cf) { m.textContent = ''; m.className = 'pw-match small'; return true; }
    const ok = pw === cf;
    m.textContent = ok ? '✓ Passwords match' : '✗ Passwords do not match';
    m.className = `pw-match small ${ok ? 'ok' : 'bad'}`;
    return ok;
  }
  $('login-password').addEventListener('input', checkMatch);
  $('login-confirm').addEventListener('input', checkMatch);

  const busy = (on) => {
    for (const b of document.querySelectorAll('#login-form button')) b.disabled = on;
    $('btn-submit').classList.toggle('loading', on);
  };
  const credentials = () => ({ email: $('login-email').value.trim(), password: $('login-password').value });

  card.onsubmit = async (e) => {
    e.preventDefault();
    const { email, password } = credentials();
    if (!/^\S+@\S+\.\S+$/.test(email)) return say('Please enter a valid email address.', true);
    if (password.length < 6) return say('The password needs at least 6 characters.', true);
    if (mode === 'signup') {
      if (!$('login-confirm').value) return say('Please type the password again to confirm it.', true);
      if (!checkMatch()) return say('The two passwords are not the same.', true);
    }
    busy(true);
    say(mode === 'signup' ? 'Creating your account…' : 'Signing in…');
    if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { emailRedirectTo: isWeb ? oauthRedirectUrl() : undefined },
      });
      busy(false);
      if (error) return say(error.message, true);
      if (data.session) { card.classList.add('success'); return setTimeout(() => location.reload(), 350); }
      say('Check your email to confirm your account, then sign in.');
      setMode('signin');
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    busy(false);
    if (error) return say(/invalid login/i.test(error.message) ? 'Wrong email or password.' : error.message, true);
    card.classList.add('success');
    setTimeout(() => location.reload(), 350);
  };

  $('btn-forgot').onclick = async () => {
    const email = $('login-email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return say('Type your email above first, then press "Forgot password?".', true);
    busy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: isWeb ? oauthRedirectUrl() : 'https://towfiqbinhasan.github.io/E-Notes/',
    });
    busy(false);
    if (error) return say(error.message, true);
    say('We sent you an email with a link to set a new password.');
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

// After a "Forgot password" email link, Supabase signs the user in for a password change.
function listenForPasswordRecovery() {
  if (!supabase) return;
  supabase.auth.onAuthStateChange((event) => {
    if (event !== 'PASSWORD_RECOVERY') return;
    const dlg = $('reset-dialog');
    const note = $('reset-message');
    dlg.showModal();
    $('reset-form').onsubmit = async (e) => {
      e.preventDefault();
      const pw = $('reset-password').value, cf = $('reset-confirm').value;
      if (pw.length < 6) { note.textContent = 'At least 6 characters.'; note.className = 'pw-match small bad'; return; }
      if (pw !== cf) { note.textContent = 'The two passwords are not the same.'; note.className = 'pw-match small bad'; return; }
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) { note.textContent = error.message; note.className = 'pw-match small bad'; return; }
      dlg.close();
      toast('Password changed ✓');
    };
  });
}
listenForPasswordRecovery();

async function showGoogleIfEnabled() {
  if (!isConfigured) return;
  try {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: import.meta.env.VITE_SUPABASE_ANON_KEY } });
    const settings = await res.json();
    const on = !!(settings.external && settings.external.google);
    $('btn-google').hidden = !on;
    $('google-divider').hidden = !on;
  } catch { /* offline: keep the button hidden */ }
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
