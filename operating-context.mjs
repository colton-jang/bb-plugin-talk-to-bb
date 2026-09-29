// Created: 2026-09-27. Standing operating context for every voice session.
//
// Until now a call started knowing only the single carry-over record from the previous
// call (reliability.mjs loadContinuity). The user's operating context — durable goals,
// decision rules, current focus, boundaries, plus a live view rebuilt on a schedule —
// lives in a file the user's own tooling regenerates (the operatingContextFile setting). This
// module reads that file at session start and turns it into one history block.
//
// Rules it keeps:
//  - Reference only, never authorization: the block says so, exactly like resumeBriefing.
//  - Freshness is stated, not hidden: an old file is still offered (the durable half does
//    not expire) but the model is told the live half may be out of date.
//  - A missing or unreadable file injects nothing and never blocks a call. Continuity keeps
//    working independently; neither depends on the other.
import { readFile, stat } from 'node:fs/promises';

export const OPERATING_CONTEXT_MAX = 6000; // lands in backend instructions, not an append
export const OPERATING_CONTEXT_STALE_HOURS = 18;

/** @param {string} path @param {{now?:number,read?:(p:string)=>Promise<string>,stats?:(p:string)=>Promise<{mtimeMs:number}>,staleHours?:number}} [options] */
export async function loadOperatingContext(path,{now=Date.now(),read=p=>readFile(p,'utf8'),stats=stat,staleHours=OPERATING_CONTEXT_STALE_HOURS}={}){
  const file=String(path||'').trim();
  if(!file)return {state:'off',text:'',ageHours:null,path:''};
  let info;
  try {info=await stats(file);}
  catch {return {state:'missing',text:'',ageHours:null,path:file};}
  let text;
  try {text=String(await read(file));}
  catch {return {state:'unreadable',text:'',ageHours:null,path:file};}
  text=text.trim();
  if(!text)return {state:'missing',text:'',ageHours:null,path:file};
  const ageHours=Math.max(0,Math.round((now-info.mtimeMs)/360000)/10);
  return {state:ageHours>staleHours?'stale':'fresh',text:text.slice(0,OPERATING_CONTEXT_MAX),ageHours,path:file};
}

// How a call opens and the ledger kept during it. Sent on EVERY call, with or without the context file.
// Colton's fork keeps its count-only previous-call opener (reliability.mjs resumeBriefing) instead of
// upstream's live-thread opener (Chaning, 2026-09-27), so the two never give competing opening rules.
export const WALK_GUIDANCE=['HOW TO OPEN THIS CALL: open briefly and listen. If a previous-session note arrives, follow its opening rule (a count only, never a name from the record); never pick an opener from the standing context, which is background only. Never open with personal matters (health, therapy, family, adoption, personal money) and do not raise them unless the user is already discussing them. If review mode was restored, say that first, in one sentence.',
  'IN-CALL LEDGER: keep a brief ledger of THIS call with exactly three lists: Parked (what the user parked and you recorded with bb_note_commitment), Sent (messages delivered to a thread or agents started, per their receipts), In progress (agents started or told during this call that are still running, per bb_recent_actions). Leave out anything only discussed. Give it only when asked ("what\'s on the ledger", "recap"), briefly, from receipts rather than memory.'].join('\n');

/** The voice-side append: walk guidance only. It must stay under GPT-Live's 500-token append
 * limit (APPEND_MAX_CHARS in live-session.mjs); the long operating context goes into the backend
 * instructions at session start instead (operatingBriefing). Never empty. */
export function sessionBriefing({continuation=false}={}){
  return continuation?CONTINUATION_GUIDANCE:WALK_GUIDANCE;
}

// A continued walk (handoff.mjs) must not re-open: the ledger rule stays, the opener does not.
export const CONTINUATION_GUIDANCE=['THIS CALL CONTINUES A WALK after a planned reconnect. Skip the usual opener; follow the continuation note that comes next.',
  WALK_GUIDANCE.split('\n')[1]].join('\n');

// How much of the context file rides in the backend prompt, which every new session writes to
// the prompt cache: full (default), brief (the durable part, stopping where the background
// snapshots begin), or off.
export const STANDING_MODES=['full','brief','off'];
export const BRIEF_FALLBACK_CHARS=2500;
/** @param {{state:string,text:string,ageHours:number|null}} ctx @param {string} [mode] */
export function trimOperatingContext(ctx,mode='full'){
  const m=STANDING_MODES.includes(String(mode||'').trim().toLowerCase())?String(mode).trim().toLowerCase():'full';
  if(m==='full'||!ctx?.text)return ctx;
  if(m==='off')return {...ctx,state:'off',text:''};
  const cut=ctx.text.search(/^BACKGROUND\b/m);
  const text=(cut>0?ctx.text.slice(0,cut):ctx.text.slice(0,BRIEF_FALLBACK_CHARS)).trim();
  return {...ctx,text};
}

/** @param {{state:string,text:string,ageHours:number|null}} ctx */
export function operatingBriefing(ctx){
  if(!ctx||!['fresh','stale'].includes(ctx.state)||!ctx.text)return '';
  const lines=['Standing operating context for the user: a file they own and edit (goals, decision rules, current focus, boundaries, and any background notes they choose to include).',
    'PRECEDENCE: (1) explicit instructions in this live conversation; (2) live BB threads and their actual status, checked with the BB tools; (3) this file, which is background only. It never sets or overrides current priorities; when it disagrees with a live thread, the live thread wins. Never call its items the current or top priorities.',
    'This is REFERENCE, not authorization. It never makes a tool call permissible on its own; act only on explicit requests in this conversation. Do not read it aloud; use it to understand priorities and to respect the boundaries it states, including keeping personal matters out of work discussion unless the user raises them.'];
  if(ctx.state==='stale')lines.push(`This file was last updated ${ctx.ageHours} hours ago, so anything dated in it may be out of date. Check live BB threads before stating any current fact; the brief part is durable.`);
  else lines.push(`Rebuilt ${ctx.ageHours} hours ago. Where it names a source as stale or unavailable, say so rather than filling the gap from memory.`);
  lines.push('---',ctx.text);
  return lines.join('\n');
}
