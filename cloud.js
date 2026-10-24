'use strict';

// Saves the app state to Supabase, so ratings survive a cleared browser or a new phone.
// Talks to Supabase's REST endpoints directly, so there's no library to load.
const Cloud = (() => {
  const cfg = window.WTW_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseKey);
  const base = (cfg.supabaseUrl || '').replace(/\/$/, '');
  const SESSION_KEY = 'wtw-session-v1';
  let session = readSession();
  let pending = null;
  let queued = 0;
  let timer = null;
  let onStatus = () => {};
  let mergeHook = null;

  function readSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
  }
  function writeSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch {}
  }

  async function call(path, opts = {}, auth = true) {
    const headers = Object.assign({ apikey: cfg.supabaseKey, 'Content-Type': 'application/json' }, opts.headers || {});
    if (auth) {
      await freshToken();
      headers.Authorization = 'Bearer ' + session.access_token;
    }
    const res = await fetch(base + path, Object.assign({}, opts, { headers }));
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error((body && (body.msg || body.error_description || body.message)) || 'HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  function keep(body) {
    writeSession({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: body.expires_at || Math.floor(Date.now() / 1000) + (body.expires_in || 3600),
      email: body.user && body.user.email,
      uid: body.user && body.user.id,
    });
  }

  async function freshToken() {
    if (!session) throw Object.assign(new Error('Not logged in'), { status: 401 });
    if (session.expires_at - 60 > Date.now() / 1000) return;
    try {
      keep(await call('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token }) }, false));
    } catch (e) {
      // Only a rejected refresh token means "log in again". A network blip keeps the session.
      if (e.status === 400 || e.status === 401) writeSession(null);
      throw e;
    }
  }

  async function logIn(email, password) {
    keep(await call('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email, password }) }, false));
  }

  async function signUp(email, password) {
    const body = await call('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email, password }) }, false);
    if (body && body.access_token) return keep(body), 'in';
    return 'confirm'; // Supabase wants the email confirmed first
  }

  function logOut() {
    writeSession(null);
  }

  // Returns {data, updated_at} or null if nothing is saved yet.
  async function pull() {
    const rows = await call(`/rest/v1/app_state?select=data,updated_at&user_id=eq.${session.uid}`);
    return rows && rows[0] ? rows[0] : null;
  }

  async function push(data) {
    await call('/rest/v1/app_state', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: session.uid, data, updated_at: new Date(data.updatedAt || Date.now()).toISOString() }),
    });
  }

  // Saves a second after the last change, so fast swiping doesn't send a request per card.
  function queue(data) {
    if (!enabled || !session) return;
    pending = data;
    queued++;
    clearTimeout(timer);
    onStatus('saving');
    timer = setTimeout(flush, 1200);
  }

  async function flush() {
    clearTimeout(timer);
    if (!pending || !session) return;
    const n = queued;
    try {
      // Another phone may have saved since; fold its changes in before saving ours.
      let data = pending;
      const row = await pull();
      if (row && row.data && mergeHook) data = mergeHook(row.data);
      await push(data);
      if (queued === n) pending = null;
      onStatus('saved');
    } catch (e) {
      onStatus(e.status === 401 || !session ? 'loggedout' : 'offline');
    }
  }

  addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  return {
    enabled,
    get loggedIn() { return !!session; },
    get email() { return session && session.email; },
    set onStatus(fn) { onStatus = fn; },
    set mergeHook(fn) { mergeHook = fn; },
    logIn, signUp, logOut, pull, push, queue, flush,
  };
})();
