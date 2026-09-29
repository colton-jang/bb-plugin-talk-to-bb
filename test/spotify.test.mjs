// Created: 2026-09-28. Server-side Spotify pause/resume for "Hey BB": only undo our own pause.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpotify } from '../spotify.mjs';

function memory() {
  const map = new Map();
  return { map, get: async k => map.get(k), set: async (k, v) => { map.set(k, structuredClone(v)); }, delete: async k => map.delete(k) };
}
function fakeSpotify(state) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(`${init.method} ${url.replace('https://api.spotify.com/v1', '')}`);
    const reply = (status, json) => ({ status, text: async () => (json ? JSON.stringify(json) : '') });
    if (url.includes('/api/token')) {
      const body = new URLSearchParams(init.body);
      if (body.get('grant_type') === 'authorization_code') return reply(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 });
      return reply(200, { access_token: 'a2', expires_in: 3600 });
    }
    if (url.endsWith('/me/player/pause')) { if (!state.playing) return reply(403, { error: { reason: 'restriction' } }); state.playing = false; return reply(204); }
    if (url.includes('/me/player/play')) { state.playing = true; return reply(204); }
    if (url.endsWith('/me/player')) return reply(200, { is_playing: state.playing, item: { id: state.item }, device: { id: state.device, name: 'iPhone' } });
    return reply(404);
  };
  return { fetch, calls };
}
const tick = () => new Promise(r => setTimeout(r, 5));

test('connect with PKCE, then pause and resume only our own pause', async () => {
  const store = memory(); const state = { playing: true, item: 'song1', device: 'phone' };
  const { fetch, calls } = fakeSpotify(state);
  const s = createSpotify({ store, clientId: 'cid', fetch });
  const url = new URL(await s.authorizeUrl('https://example.test/cb'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('scope'), /user-modify-playback-state/);
  await s.finish('code', url.searchParams.get('state'));
  assert.equal((await store.get('spotify:auth')).refreshToken, 'r1');
  await assert.rejects(s.finish('code', url.searchParams.get('state')), /expired/, 'a state is single-use');

  const p = await s.pause('run_aaaaaaaa'); await tick();
  assert.equal(p.paused, true); assert.equal(state.playing, false);
  const r = await s.resume('run_aaaaaaaa');
  assert.equal(r.resumed, true); assert.equal(state.playing, true);
  assert.ok(calls.some(c => c.startsWith('PUT /me/player/play?device_id=phone')));
  assert.equal((await s.resume('run_aaaaaaaa')).reason, 'we did not pause it');
});

test('never resumes over the user\'s own choice; falls back when nothing is playing or not connected', async () => {
  const store = memory(); const state = { playing: true, item: 'song1', device: 'phone' };
  const { fetch } = fakeSpotify(state);
  const s = createSpotify({ store, clientId: 'cid', fetch });
  assert.equal((await s.pause('run_bbbbbbbb')).reason, 'not connected');
  const url = new URL(await s.authorizeUrl('https://example.test/cb'));
  await s.finish('code', url.searchParams.get('state'));

  await s.pause('run_bbbbbbbb'); await tick();
  state.playing = true; // the user pressed play themselves
  assert.equal((await s.resume('run_bbbbbbbb')).reason, 'already playing');

  await s.pause('run_bbbbbbbb'); await tick();
  state.item = 'song2'; // the user changed track
  assert.equal((await s.resume('run_bbbbbbbb')).reason, 'track changed');
  assert.equal(state.playing, false);

  const idle = await s.pause('run_cccccccc');
  assert.equal(idle.paused, false); assert.equal(idle.reason, 'not playing', 'a podcast in another app: the phone does its own switch');
});

test('an expired access token is refreshed', async () => {
  let t = 0; const store = memory(); const state = { playing: true, item: 'x', device: 'd' };
  const { fetch, calls } = fakeSpotify(state);
  const s = createSpotify({ store, clientId: 'cid', fetch, now: () => t });
  const url = new URL(await s.authorizeUrl('https://example.test/cb'));
  await s.finish('code', url.searchParams.get('state'));
  t = 2 * 3600 * 1000;
  assert.equal((await s.pause('run_dddddddd')).paused, true);
  assert.ok(calls.filter(c => c.includes('/api/token')).length === 2);
});
