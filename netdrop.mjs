// Created: 2026-09-27. Network-switch recovery for voice calls.
//
// Field bug (reported on a walk): moving from Wi-Fi to 5G ended the call, and pressing start
// again said "a session is already open" although nothing was. Root cause: the server allows
// one call at a time and released that lock only when it SAW the old socket close and the
// provider confirmed. A network switch leaves a half-open socket that the server does not see
// close for minutes, so the lock (and the provider session, still billing) outlived the call.
// The plugin SDK socket exposes no ping, so liveness is judged from client traffic: audio
// frames every 20 ms while live, plus an app ping every 5 s.
import { HANDOFF_TTL_MS } from './handoff.mjs';

/** A new start may take over a holder silent this long: live clients send audio every 20 ms. */
export const TAKEOVER_STALE_MS = 5000;
/** A holder silent this long is ended even if nobody reconnects, so a dead call stops billing.
 * Deliberately generous in case a native client goes quiet while its mic is paused. */
export const DEAD_CLIENT_MS = 45000;
export const EVICT_TIMEOUT_MS = 5000;
/** Browser reconnect schedule after an unexpected drop; the first tries usually land inside the
 * takeover window and are refused, the later ones take over. */
export const RETRY_DELAYS_MS = [2000, 4000, 8000, 15000];

/** Live timings, read at use so tests can shrink them. Production uses the constants above. */
export const TIMING = { takeoverStaleMs: TAKEOVER_STALE_MS, deadClientMs: DEAD_CLIENT_MS, evictTimeoutMs: EVICT_TIMEOUT_MS, watchdogIntervalMs: 2000 };

/** @param {{lastSeen:number,socketClosed:boolean}|null} holder @param {number} now */
export function holderIsStale(holder,now){
  return Boolean(holder)&&(holder.socketClosed||now-holder.lastSeen>TIMING.takeoverStaleMs);
}

/** An explicit handoff token wins; otherwise continue a walk that just died on a network loss.
 * @param {{explicit?:unknown,lastDrop?:{token:string,at:number}|null,now:number}} input */
export function pickHandoffToken({explicit,lastDrop=null,now}){
  if(typeof explicit==='string'&&explicit)return explicit;
  if(lastDrop&&now-lastDrop.at<=HANDOFF_TTL_MS)return lastDrop.token;
  return null;
}

/** Close, wait for the confirmed close, and force it if the provider never confirms.
 * @param {{close:()=>void,waitClosed:Promise<void>,force:()=>void,timeoutMs?:number}} input */
export async function evictWithTimeout({close,waitClosed,force,timeoutMs=TIMING.evictTimeoutMs}){
  close();
  const timedOut=await Promise.race([waitClosed.then(()=>false),new Promise(r=>setTimeout(()=>r(true),timeoutMs))]);
  if(!timedOut)return {confirmed:true};
  force();
  await Promise.race([waitClosed,new Promise(r=>setTimeout(r,1000))]);
  return {confirmed:false};
}
