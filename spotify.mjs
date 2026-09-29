// Created: 2026-09-28. Pause and resume the user's Spotify from the server, so a "Hey BB" call can skip the
// phone's audio-session switch (the ~1.9 s AirPods mode change) when Spotify is what's playing. Anything else
// playing, no Spotify connection, or a failed request means the phone falls back to its own switch.
// Auth is Spotify's Authorization Code flow with PKCE: a client ID only, no client secret on the server.
import { createHash, randomBytes } from 'node:crypto';

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
export const SPOTIFY_SCOPES = 'user-read-playback-state user-modify-playback-state';
const AUTH_KEY = 'spotify:auth';
const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * @param {{store:any, clientId:()=>Promise<string>|string, fetch?:typeof fetch, now?:()=>number, timeoutMs?:number}} options
 */
export function createSpotify({ store, clientId, fetch: http = fetch, now = Date.now, timeoutMs = 2500 }) {
  /** runId -> what we paused, so resume only undoes our own pause. */
  const paused = new Map();
  const id = async () => String((typeof clientId === 'function' ? await clientId() : clientId) || '').trim();

  async function call(method, path, { token, body, form } = {}) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await http(path.startsWith('http') ? path : `${API}${path}`, { method, signal: ctrl.signal,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : body ? { 'content-type': 'application/json' } : {}) },
        body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
      return { status: res.status, json };
    } finally { clearTimeout(timer); }
  }

  async function token() {
    const auth = await store.get(AUTH_KEY);
    if (!auth?.refreshToken) return null;
    if (auth.accessToken && auth.expiresAt - 60000 > now()) return auth.accessToken;
    const r = await call('POST', `${ACCOUNTS}/api/token`, { form: { grant_type: 'refresh_token', refresh_token: auth.refreshToken, client_id: await id() } });
    if (r.status !== 200 || !r.json?.access_token) return null;
    const next = { ...auth, accessToken: r.json.access_token, expiresAt: now() + (r.json.expires_in ?? 3600) * 1000,
      refreshToken: r.json.refresh_token || auth.refreshToken };
    await store.set(AUTH_KEY, next);
    return next.accessToken;
  }

  return {
    /** Step 1 of connecting: where to send the browser. The verifier waits in kv for the callback. */
    async authorizeUrl(redirectUri) {
      const client = await id();
      if (!client) throw new Error('Set the Spotify client ID in the Talk to BB settings first.');
      const verifier = b64url(randomBytes(48)); const state = b64url(randomBytes(16));
      await store.set(`spotify:pkce:${state}`, { verifier, redirectUri, at: now() });
      const q = new URLSearchParams({ client_id: client, response_type: 'code', redirect_uri: redirectUri, scope: SPOTIFY_SCOPES, state,
        code_challenge_method: 'S256', code_challenge: b64url(createHash('sha256').update(verifier).digest()) });
      return `${ACCOUNTS}/authorize?${q}`;
    },
    /** Step 2: the callback. Keeps only the refresh token (and a short-lived access token) in the plugin's kv. */
    async finish(code, state) {
      const pending = state && await store.get(`spotify:pkce:${state}`);
      if (!pending || now() - pending.at > 10 * 60000) throw new Error('That Spotify sign-in expired. Start it again.');
      await store.delete?.(`spotify:pkce:${state}`);
      const r = await call('POST', `${ACCOUNTS}/api/token`, { form: { grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri,
        client_id: await id(), code_verifier: pending.verifier } });
      if (r.status !== 200 || !r.json?.refresh_token) throw new Error(`Spotify refused the sign-in (${r.status}).`);
      await store.set(AUTH_KEY, { refreshToken: r.json.refresh_token, accessToken: r.json.access_token,
        expiresAt: now() + (r.json.expires_in ?? 3600) * 1000, connectedAt: new Date(now()).toISOString() });
      return true;
    },
    async disconnect() { await store.delete?.(AUTH_KEY); paused.clear(); return true; },
    async status() {
      const auth = await store.get(AUTH_KEY);
      const out = { configured: Boolean(await id()), connected: Boolean(auth?.refreshToken), connectedAt: auth?.connectedAt ?? null };
      if (!out.connected) return out;
      const t = await token();
      if (!t) return { ...out, connected: false, error: 'token refresh failed' };
      const r = await call('GET', '/me/player', { token: t });
      return { ...out, playing: Boolean(r.json?.is_playing), device: r.json?.device?.name ?? null, type: r.json?.currently_playing_type ?? null };
    },
    /**
     * Pause now, for this run's call. Fast path first (one PUT); what was playing is read afterwards, for resume.
     * @returns {Promise<{paused:boolean, reason:string, ms:number}>}
     */
    async pause(runId) {
      const t0 = now();
      const t = await token().catch(() => null);
      if (!t) return { paused: false, reason: 'not connected', ms: now() - t0 };
      let r;
      try { r = await call('PUT', '/me/player/pause', { token: t }); }
      catch { return { paused: false, reason: 'timeout', ms: now() - t0 }; }
      // 204/200: paused. 403: nothing playing (Spotify's "restriction violated"). 404: no active device.
      if (r.status !== 204 && r.status !== 200) return { paused: false, reason: r.status === 403 ? 'not playing' : r.status === 404 ? 'no active device' : `spotify ${r.status}`, ms: now() - t0 };
      const ms = now() - t0;
      const record = { at: now(), itemId: null, deviceId: null };
      paused.set(runId, record);
      call('GET', '/me/player', { token: t }).then(p => { record.itemId = p.json?.item?.id ?? null; record.deviceId = p.json?.device?.id ?? null; }).catch(() => {});
      return { paused: true, reason: 'paused', ms };
    },
    /**
     * Undo our own pause only: if the user pressed play, changed track or switched device meanwhile, leave it alone.
     * @returns {Promise<{resumed:boolean, reason:string, ms:number}>}
     */
    async resume(runId) {
      const t0 = now();
      const record = paused.get(runId);
      paused.delete(runId);
      if (!record) return { resumed: false, reason: 'we did not pause it', ms: 0 };
      const t = await token().catch(() => null);
      if (!t) return { resumed: false, reason: 'not connected', ms: now() - t0 };
      try {
        const p = await call('GET', '/me/player', { token: t });
        if (p.json?.is_playing) return { resumed: false, reason: 'already playing', ms: now() - t0 };
        if (record.itemId && p.json?.item?.id && p.json.item.id !== record.itemId) return { resumed: false, reason: 'track changed', ms: now() - t0 };
        if (record.deviceId && p.json?.device?.id && p.json.device.id !== record.deviceId) return { resumed: false, reason: 'device changed', ms: now() - t0 };
        const q = record.deviceId ? `?device_id=${encodeURIComponent(record.deviceId)}` : '';
        const r = await call('PUT', `/me/player/play${q}`, { token: t });
        return { resumed: r.status === 204 || r.status === 200, reason: r.status === 204 || r.status === 200 ? 'resumed' : `spotify ${r.status}`, ms: now() - t0 };
      } catch { return { resumed: false, reason: 'timeout', ms: now() - t0 }; }
    },
  };
}
