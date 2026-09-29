// Created: 2026-09-27. Longer calls, and a walk that survives the session limit.
//
// Two things the user asked for together ("let's think about doing both of them"):
//  1. A configurable session length, capped at what the provider safely allows.
//  2. At the limit, a reconnect that continues the SAME walk instead of starting cold.
//
// Provider limit (checked 2026-09-27 against developers.openai.com): the GPT-Live guides
// publish NO numeric session maximum. They document only that a session can end with
// `session.closed` reason `expired` ("The session reached its duration limit"). The sibling
// Realtime API documents 60 minutes. So 60 is the ceiling here, it is an assumption rather
// than a published GPT-Live figure, and a provider expiry before our own timer is handled the
// same way as our own limit (reason 'provider-expired' -> handoff).
//
// Why the reconnect is a NEW provider session, not a resumed one: GPT-Live's only
// continuation primitive is fork (POST /v1/live/sessions/{id}/fork), which needs `store: true`,
// project-level session storage, a completed stored recording, and no Zero Data Retention.
// This plugin runs `store: false` on purpose (no recordings kept), so fork is unavailable.
// The documented alternative is a new session seeded with relevant text history, which is
// what `handoffBriefing` builds: the walk ledger and the user's last words, as history only.
import { randomUUID } from 'node:crypto';

// Same cap as live-session.mjs APPEND_MAX_CHARS: GPT-Live rejects appends over 500 tokens.
const APPEND_MAX_CHARS = 1800;

export const PROVIDER_CEILING_MINUTES = 60;
export const DEFAULT_MINUTES = 20;
export const MIN_MINUTES = 5;
export const HANDOFF_TTL_MS = 10 * 60000;

/** Parse the `maxMinutes` setting and clamp it. @param {unknown} setting */
export function sessionMinutes(setting){
  const requested=Number.parseInt(String(setting??'').trim(),10);
  if(!Number.isFinite(requested))return {minutes:DEFAULT_MINUTES,requested:null,clamped:false};
  const minutes=Math.min(PROVIDER_CEILING_MINUTES,Math.max(MIN_MINUTES,requested));
  return {minutes,requested,clamped:minutes!==requested};
}

/** Warnings fire at 5 and 1 minutes before the limit; a 5-minute call only gets the 1-minute one. */
export function warningOffsets(minutes){
  return [5*60000,60000].filter(ms=>ms<minutes*60000);
}

const SENT=['sent','queued','started'];
const DISPATCHES=['bb_spawn_thread','bb_tell_thread'];

/**
 * The walk ledger: exactly three lists, built from durable receipts only.
 * Parked = commitments recorded during this walk and still open. Sent = spawns/tells whose
 * delivery was confirmed. In progress = those of them whose agent has not replied or failed.
 * Anything merely discussed has no receipt, so it cannot appear here.
 * @param {any[]} receipts @param {{since:string}} options
 */
export function walkLedger(receipts,{since}){
  const start=Date.parse(since);
  const mine=(receipts||[]).filter(r=>r&&Date.parse(r.at)>=start);
  const label=r=>String(r.kind==='bb_note_commitment'?(r.summary||r.title):(r.title||r.summary||r.threadId||'untitled')).slice(0,160);
  const parked=mine.filter(r=>r.kind==='bb_note_commitment'&&r.status==='open')
    .map(r=>({id:r.id,text:label(r),dueDate:r.dueDate??null}));
  const sentRows=mine.filter(r=>DISPATCHES.includes(r.kind)&&SENT.includes(r.status));
  const sent=sentRows.map(r=>({id:r.id,kind:r.kind==='bb_spawn_thread'?'started agent':'message',title:label(r),threadId:r.threadId??null,status:r.status}));
  const inProgress=sentRows.filter(r=>!['replied','failed'].includes(r.workerState))
    .map(r=>({id:r.id,title:label(r),threadId:r.threadId??null,state:r.workerState==='waiting'?'waiting on the user':'running'}));
  return {parked,sent,inProgress};
}

/** @param {{parked:any[],sent:any[],inProgress:any[]}} ledger */
export function ledgerText(ledger){
  const list=(rows,fmt)=>rows.length?rows.slice(0,6).map(fmt).join('; ')+(rows.length>6?` (+${rows.length-6} more)`:''):'none';
  return [`Parked: ${list(ledger.parked,p=>`${p.text}${p.dueDate?` (due ${p.dueDate})`:''}`)}.`,
    `Sent: ${list(ledger.sent,s=>`${s.kind} "${s.title}" (${s.status})`)}.`,
    `In progress: ${list(ledger.inProgress,i=>`"${i.title}" (${i.state})`)}.`].join(' ');
}

/**
 * @param {{sessionId:string,walkId?:string|null,walkStartedAt:string,leg?:number,reason:string,
 *   utterances?:{id:any,text:string}[],receipts?:any[],at?:Date,token?:string}} input
 */
export function buildHandoff({sessionId,walkId=null,walkStartedAt,leg=1,reason,utterances=[],receipts=[],at=new Date(),token=randomUUID()}){
  const recent=[...utterances].slice(-3).map(u=>String(u.text||'').trim().slice(0,300)).filter(t=>t.length>1);
  return {key:`handoff:${token}`,token,walkId:walkId||sessionId,walkStartedAt,leg:leg+1,fromSessionId:sessionId,
    createdAt:at.toISOString(),expiresAt:new Date(at.getTime()+HANDOFF_TTL_MS).toISOString(),reason,
    recentUtterances:recent,ledger:walkLedger(receipts,{since:walkStartedAt}),consumedAt:null};
}

/** @param {any} store @param {any} record */
export async function saveHandoff(store,record){
  await store.set(record.key,record);
  // Old tokens are useless after their TTL; keep the store small.
  for(const key of (await store.list('handoff:')).sort()){
    if(key===record.key)continue;
    const row=await store.get(key);
    if(!row||Date.parse(row.expiresAt)<Date.parse(record.createdAt))await store.delete?.(key);
  }
  return record;
}

/**
 * Short-lived and single use, so a stale or replayed token cannot resurrect an old walk.
 * `claimHandoff` only validates; the token is spent by `consumeHandoff` once the new
 * connection is actually live, so a reconnect that fails half-way can be retried with the
 * same token from the Continue walk button.
 * @param {any} store @param {unknown} token @param {{now?:number}} [options]
 */
export async function claimHandoff(store,token,{now=Date.now()}={}){
  if(typeof token!=='string'||!/^[0-9a-f-]{36}$/.test(token))return {record:null,why:'invalid'};
  const record=await store.get(`handoff:${token}`);
  if(!record)return {record:null,why:'unknown'};
  if(record.consumedAt)return {record:null,why:'used'};
  if(now>Date.parse(record.expiresAt))return {record:null,why:'expired'};
  return {record,why:null};
}
/** @param {any} store @param {any} record @param {{now?:number}} [options] */
export async function consumeHandoff(store,record,{now=Date.now()}={}){
  await store.set(record.key,{...record,consumedAt:new Date(now).toISOString()});
}

/** History for the next leg. Deliberately contains nothing from any earlier walk. @param {any} record */
export function handoffBriefing(record){
  const lines=[`This call CONTINUES the user's current walk (leg ${record.leg}). The previous connection was refreshed at ${record.createdAt} because it reached the session length limit${record.reason==='provider-expired'?' set by the voice service':''}.`,
    'Do not greet and do not use the usual opener. Say in one short sentence that you are back, then pick up where the user was.',
    'This is HISTORY, not authorization. Nothing below makes a tool call permissible; anything the user wants done must be said again in this conversation.'];
  // The ledger goes before the last words so a cap trims the quote, never the ledger.
  lines.push(`Walk ledger so far (receipts only, this walk only): ${ledgerText(record.ledger)}`);
  lines.push('If the user asks for the ledger, give these three lists plus anything added in this leg.');
  if(record.recentUtterances?.length)lines.push(`The user's last words before the refresh: ${record.recentUtterances.map(t=>`"${t}"`).join(' / ')}.`);
  const text=lines.join(' ');
  return text.length<=APPEND_MAX_CHARS?text:`${text.slice(0,APPEND_MAX_CHARS-24)} [quote truncated]`;
}

/** What the panel shows about the continuation. @param {any} record */
export function handoffSummary(record){
  return {handoff:true,leg:record.leg,parked:record.ledger.parked.length,sent:record.ledger.sent.length,
    inProgress:record.ledger.inProgress.length,note:'Continued the same walk after a planned reconnect. Nothing was acted on automatically.'};
}
