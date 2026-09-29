// Created: 2026-09-15.
import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createReader, createCli } from './bb-read.mjs';
import { createManager, actionSchemas, recentReceipts, ActionError, SURFACE_LABELS } from './bb-manager.mjs';
import { createInbox } from './manager-inbox.mjs';
import { ShareState, SnapshotStore, FrameInbox, describeSnapshot, MAX_BODY_BYTES } from './screen-store.mjs';
import { createReviewManager, reviewSchemas, NotificationGate, resumableReview, ReviewNotes } from './review-notes.mjs';
import { TalkSession, DEFAULT_BACKEND, backendOptions } from './live-session.mjs';
import { timingLine } from './backend-timing.mjs';
import { attachCues, CUE_PROFILE_NAMES } from './cues.mjs';
import { createWorkerEventHandler, WORKER_EVENTS, collectEvents } from './worker-events.mjs';
import { setProfile } from './profile.mjs';
import { loadOperatingContext, sessionBriefing, operatingBriefing, trimOperatingContext } from './operating-context.mjs';
import { holderIsStale, pickHandoffToken, evictWithTimeout, TIMING } from './netdrop.mjs';
import { sessionMinutes, warningOffsets, buildHandoff, saveHandoff, claimHandoff, consumeHandoff, handoffBriefing, handoffSummary } from './handoff.mjs';
import { createWalkMemory } from './walk-memory.mjs';
import { ackText } from './hey-ack.mjs';
import { createSpotify } from './spotify.mjs';
import { DEFAULT_TIME_ZONE, buildContinuity, saveContinuity, loadContinuity, resumeBriefing, resumeSummary, openReviewFor } from './reliability.mjs';
import worklet from './audio-source.mjs';
import { createAmbient, ambientInput, ambientRpc, thoughtInput, thoughtRpc, createThoughtTool, withThoughtTool, findThoughtById } from './ambient.mjs';
import { createNotebook, notebookInput, surfaceOf } from './notebook.mjs';
import { DirectWorkerLegs, createWorkerLeg, resolveWorkerTarget, lookupMessage } from './direct-worker.mjs';

// ambientId: a call opened from an Ambient Walk check-in the user said yes to (Pocket's triage); it starts on those items.
// source 'hey-bb': a call Pocket opened because the user said "Hey BB" over their music; answers stay short.
// source 'checkin' (with ambientId): BB itself chimes in live with a batched check-in, no recording first.
// ambientRun: one Ambient Walk run; its earlier calls ride into the next one as history (walk-memory.mjs).
// music: what Pocket actually did to the user's music for this call, so BB never promises music it can't return.
// acked: Pocket played the /hey-ack greeting before the call, so BB must not greet again.
// bare: the user said only "Hey BB" and paused (true) or went straight into a request (false); true = BB greets first.
const contextSchema = z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/).nullable(), projectId: z.string().regex(/^proj_[a-z0-9]+$/).nullable(), ambientId: z.string().regex(/^amb_[a-z0-9]{8,32}$/).optional(), source: z.enum(['hey-bb','checkin']).optional(), ambientRun: z.string().regex(/^run_[a-z0-9]{8,32}$/).optional(), music: z.enum(['ducked','paused','none']).optional(), acked: z.boolean().optional(), bare: z.boolean().optional() }).strict();
export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: z.object({configured:z.boolean(),active:z.boolean()}) },
  read: { input: z.object({name:z.string(),args:z.unknown()}).strict(), output: z.unknown() },
  // Ambient Walk (ambient.mjs): thought capture from Siri/Action Button/controls, and the digest batcher.
  thought: { input: thoughtInput, output: z.unknown() },
  ambient: { input: ambientInput, output: z.unknown() },
  // The notebook (notebook.mjs): every voice conversation, read-only, for the panel and Pocket.
  notebook: { input: notebookInput, output: z.unknown() },
});

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {type:'string',label:'OpenAI API key (needs GPT-Live access)',secret:true},
    credentialFile: {type:'string',label:'Or: an env file on the BB server containing OPENAI_API_KEY',default:''},
    userName: {type:'string',label:'Your first name (the voice manager and agent briefs use it)',default:''},
    preferredMachine: {type:'string',label:'Machine to prefer for new agent work (name as shown in BB)',default:''},
    workerRules: {type:'string',label:'Extra rules appended to every agent brief (your tools, repo conventions, handoffs)',default:''},
    cueProfile: {type:'select',options:[...CUE_PROFILE_NAMES],label:'Spoken cues while a lookup or dispatch runs: off, subtle, steady or chatty (see README)',default:'off'},
    cliPath: {type:'string',label:'BB CLI executable on the BB server',default:process.env.BB_CLI || 'bb'},
    timeZone: {type:'string',label:'Time zone for resolving spoken dates',default:Intl.DateTimeFormat().resolvedOptions().timeZone||DEFAULT_TIME_ZONE},
    snapshotDirectory: {type:'string',label:'Where authorized screen snapshots are written on the BB server',default:join(homedir(),'.bb','talk-to-bb','snapshots')},
    managerThreadId: {type:'string',label:'Thread that receives notes voice records and requests it could not complete (a thr_ id; blank keeps them only in Talk to BB)',default:''},
    operatingContextFile: {type:'string',label:'Standing operating context file read at the start of every call (empty = off)',default:''},
    backendModel: {type:'string',label:'Backend model that runs every lookup and action (e.g. gpt-5.6-terra, gpt-5.6-luna, gpt-6-luna)',default:DEFAULT_BACKEND.model},
    backendReasoning: {type:'string',label:'Backend reasoning effort: empty = the model default, or none, low, medium, high',default:''},
    backendServiceTier: {type:'string',label:'Backend service tier: empty = the project default, or auto, default, flex, fast (priority)',default:''},
    phoneCallPrompt: {type:'select',options:['full','lean'],label:'Backend prompt for phone calls (Hey BB and Ambient check-ins): full, or lean (no screen, focus, review, direct-line or capability tools; brief operating context)',default:'full'},
    backendStandingContext: {type:'select',options:['full','brief','off'],label:'How much of the operating context file goes into the backend prompt: full, brief (goals, rules, focus, boundaries; no background snapshots) or off',default:'full'},
    maxMinutes: {type:'string',label:'Minutes per voice connection (5-60; GPT-Live publishes no maximum, 60 is the assumed ceiling)',default:'20'},
    walkHandoff: {type:'string',label:'At the limit, reconnect and continue the same walk (on/off)',default:'on'},
    lookupBudget: {type:'select',options:['full','lean'],label:'How much a thread read or overview hands the voice backend (lean keeps long calls fast and cheap)',default:'full'},
    spotifyClientId: {type:'string',label:'Spotify app client ID, for pausing Spotify on "Hey BB" (optional; see README)',default:''},
    spotifyRedirectUri: {type:'string',label:'Spotify redirect URI registered on that app (empty = derived from this server\'s address)',default:''},
  });
  const captureFailures: Record<string,string> = {
    'not-sharing':'The user is not sharing a screen right now, so there is nothing to look at. Ask them to press Share screen in the Talk to BB panel.',
    'frame-limit':'This session has reached its snapshot limit. Ask the user to describe what they are looking at instead.',
    'capture-in-progress':'A snapshot is already being taken. Wait for it rather than asking again.',
    'frame-too-large':'The shared surface could not be reduced to a sendable image. Ask the user to share a single window or tab instead of a whole screen.',
    'capture-failed':'The browser could not read the shared surface. Ask the user to re-share, or to describe what they see.',
  };
  const frames = new FrameInbox();
  const zone=async()=>(await settings.get()).timeZone||DEFAULT_TIME_ZONE;
  const backendOf=(s:any)=>backendOptions({model:s.backendModel,reasoning:s.backendReasoning,serviceTier:s.backendServiceTier});
  const ambient=createAmbient({store:bb.storage.kv,timeZone:zone});
  const notebook=createNotebook({store:bb.storage.kv});
  let active: TalkSession | null = null;
  let activeReview: ReturnType<typeof createReviewManager> | null = null;
  let reserved = false;
  // Network-switch recovery (2026-09-27): who holds the one-call lock, how recently it was heard
  // from, and how to end it. A phone moving from Wi-Fi to 5G leaves a half-open socket that never
  // closes, so the lock and the provider session must be released on staleness, not on close.
  let holder:{lastSeen:number;socketClosed:boolean;evict:(reason:string)=>Promise<void>}|null=null;
  // The handoff saved when a call died on a network loss; the next start continues that walk.
  let lastDrop:{token:string;at:number}|null=null;
  // Only one takeover at a time: a second reconnect arriving mid-takeover is refused, not doubled.
  let takingOver=false;
  let publishReceipt:((receipt:any)=>void)|null=null;
  async function key() {
    const s = await settings.get();
    if (s.apiKey) return s.apiKey;
    if (!s.credentialFile) return '';
    try { return parseEnv(await readFile(s.credentialFile,'utf8')).OPENAI_API_KEY || ''; } catch { return ''; }
  }
  async function query(name:string,args:unknown,signal?:AbortSignal) {
    const s=await settings.get();
    return createReader({cliPath:s.cliPath,serverUrl:bb.server.loopbackBaseUrl,signal,budget:s.lookupBudget})(name,args);
  }
  bb.rpc.register(rpcContract,{
    status:async()=>({configured:Boolean(await key()),active:reserved}),
    read:({name,args})=>query(name,args),
    thought:(input)=>thoughtRpc(bb.storage.kv,input),
    notebook:(input)=>input.op==='list'?notebook.list({limit:input.limit})
      :notebook.get(input.id,{findNote:(id:string)=>findThoughtById(bb.storage.kv,id)}),
    ambient:async(input)=>{
      const result:any=await ambientRpc(ambient,input,{timeZone:await zone()});
      // Remember what each handed-out check-in says, so the app can fetch it spoken (ambient-speech).
      if(input.op==='poll'||input.op==='flush')for(const d of [result?.interrupt,result?.digest])if(d?.id)rememberSpoken(d.id,`${d.title}. ${d.body}`,d);
      return result;
    },
  });
  // Ambient Walk speaks its check-ins like a navigation app: the Pocket iPhone app
  // fetches this audio and plays it over the user's music, ducked. Only check-ins
  // this server handed out can be spoken (no free text), in Walk's voice.
  const spokenText=new Map<string,{text:string,at:number,delivery?:any}>();
  const walkMemory=createWalkMemory();
  const spokenAudio=new Map<string,Uint8Array>();
  function rememberSpoken(id:string,text:string,delivery?:any){
    spokenText.set(id,{text,at:Date.now(),delivery});
    for(const [k,v] of spokenText)if(Date.now()-v.at>60*60_000||spokenText.size>50){spokenText.delete(k);spokenAudio.delete(k);}
  }
  // "Hey BB" acknowledgement for the NEXT wake of an Ambient run, spoken. Pocket prefetches it (at listening
  // start and after each call) so it plays the instant the wake matches, and only if the user paused after it.
  const ackAudio=new Map<string,Uint8Array>();
  const ackServed=new Map<string,{text:string,at:number}>();
  bb.http.route('GET','/hey-ack',async(c)=>{
    const run=c.req.query('run')??'';
    if(!/^run_[a-z0-9]{8,32}$/.test(run))return new Response('Bad run',{status:400});
    const calls=walkMemory.calls(run);
    let threads:any[]|null=null;
    if(calls===0){try{threads=((await query('bb_threads',{projectId:null,status:'all',offset:0})) as any)?.threads??null;}catch{threads=null;}}
    const ack=ackText({calls,threads});
    // speak=0: Pocket no longer plays it (GPT-Live answered at the same moment); BB says it instead.
    if(c.req.query('speak')==='0'){
      ackServed.set(run,{text:ack.text,at:Date.now()});
      bb.log.info(`hey-ack ${run} call ${calls + 1}: ${ack.tier} (text only)`);
      return Response.json({tier:ack.tier,text:ack.text},{headers:{'Cache-Control':'no-store'}});
    }
    let audio=ackAudio.get(ack.text);
    if(!audio){
      const apiKey=await key();
      if(!apiKey)return new Response('No OpenAI key',{status:503});
      const res=await fetch('https://api.openai.com/v1/audio/speech',{method:'POST',
        headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},
        body:JSON.stringify({model:'gpt-4o-mini-tts',voice:'marin',input:ack.text.slice(0,600),response_format:'mp3',
          instructions:'A quick, warm, casual greeting to someone who just said "Hey BB" while walking with music on. Brisk and natural, like a friend picking up.'})});
      if(!res.ok){bb.log.warn(`hey-ack ${ack.tier}: ${res.status}`);return new Response('Speech failed',{status:502});}
      audio=new Uint8Array(await res.arrayBuffer());
      if(ackAudio.size>40)ackAudio.clear();
      ackAudio.set(ack.text,audio);
    }
    ackServed.set(run,{text:ack.text,at:Date.now()});
    for(const [k,v] of ackServed)if(Date.now()-v.at>4*3600_000)ackServed.delete(k);
    bb.log.info(`hey-ack ${run} call ${calls + 1}: ${ack.tier} (${audio.byteLength} bytes)`);
    return new Response(audio as unknown as BodyInit,{headers:{'Content-Type':'audio/mpeg','Cache-Control':'no-store',
      'Content-Length':String(audio.byteLength),'X-Ack-Tier':ack.tier,'X-Ack-Text':encodeURIComponent(ack.text)}});
  });
  // Spotify pause/resume for Pocket's "Hey BB" (spotify.mjs). The phone calls pause at the wake and resume at the
  // hand-back; anything but a clean pause means it does its own audio switch, exactly as before.
  const spotify=createSpotify({store:bb.storage.kv,clientId:async()=>(await settings.get()).spotifyClientId});
  const spotifyRedirect=async(c:any)=>{
    const set=(await settings.get()).spotifyRedirectUri;
    if(set)return set;
    const host=c.req.header('x-forwarded-host')??c.req.header('host')??'';
    return `https://${host}/api/v1/plugins/talk-to-bb/http/spotify/callback`;
  };
  const page=(title:string,body:string)=>new Response(`<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:17px -apple-system,system-ui;margin:2em;max-width:32em"><h2>${title}</h2><p>${body}</p>`,{headers:{'Content-Type':'text/html; charset=utf-8'}});
  bb.http.route('GET','/spotify/connect',async(c)=>{
    try{return Response.redirect(await spotify.authorizeUrl(await spotifyRedirect(c)),302);}
    catch(e:any){return page('Spotify isn\'t set up yet',String(e?.message??e));}
  });
  bb.http.route('GET','/spotify/callback',async(c)=>{
    const error=c.req.query('error');
    if(error)return page('Spotify wasn\'t connected',`Spotify said: ${error.replace(/[<>&]/g,'')}.`);
    try{await spotify.finish(c.req.query('code')??'',c.req.query('state')??'');bb.log.info('spotify: connected');
      return page('Spotify connected','"Hey BB" can now pause Spotify directly. You can close this page.');}
    catch(e:any){return page('Spotify wasn\'t connected',String(e?.message??e).replace(/[<>&]/g,''));}
  });
  bb.http.route('GET','/spotify/status',async()=>Response.json(await spotify.status().catch((e:any)=>({connected:false,error:String(e?.message??e)}))));
  const runOf=async(c:any)=>{try{const b=await c.req.json();return /^run_[a-z0-9]{8,32}$/.test(b?.run??'')?b.run:null;}catch{return null;}};
  bb.http.route('POST','/spotify/pause',async(c)=>{
    const run=await runOf(c); if(!run)return new Response('Bad run',{status:400});
    const r=await spotify.pause(run); bb.log.info(`spotify pause ${run}: ${r.reason} in ${r.ms} ms`); return Response.json(r);
  });
  bb.http.route('POST','/spotify/resume',async(c)=>{
    const run=await runOf(c); if(!run)return new Response('Bad run',{status:400});
    const r=await spotify.resume(run); bb.log.info(`spotify resume ${run}: ${r.reason} in ${r.ms} ms`); return Response.json(r);
  });
  bb.http.route('GET','/ambient-speech',async(c)=>{
    const id=c.req.query('id')??'';
    // ask=1 (Pocket is listening for an answer): the check-in ends with a question the user can say yes or no to.
    const ask=c.req.query('ask')==='1';
    const found=/^amb_[a-z0-9]{8,32}$/.test(id)?spokenText.get(id):undefined;
    const n=(found?.delivery?.count??1)+(found?.delivery?.more??0);
    const question=found?.delivery?.kind==='urgent'?' Want to cover it now?':` Want to go through ${n===1?'it':'them'}?`;
    const entry=found?{...found,text:ask?found.text+question:found.text}:undefined;
    const cacheKey=ask?`${id}|ask`:id;
    if(!entry){bb.log.info(`ambient speech ${id||'(no id)'}: 404 unknown`);return new Response('Unknown check-in',{status:404});}
    let audio=spokenAudio.get(cacheKey);
    if(!audio){
      const apiKey=await key();
      if(!apiKey)return new Response('No OpenAI key',{status:503});
      const res=await fetch('https://api.openai.com/v1/audio/speech',{method:'POST',
        headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},
        body:JSON.stringify({model:'gpt-4o-mini-tts',voice:'marin',input:entry.text.slice(0,800),response_format:'mp3',
          instructions:'A brief, calm, friendly update spoken over the listener\'s music, like a running coach. Natural pace, no drama.'})});
      if(!res.ok){bb.log.warn(`ambient speech ${id}: ${res.status}`);return new Response('Speech failed',{status:502});}
      audio=new Uint8Array(await res.arrayBuffer());
      spokenAudio.set(cacheKey,audio);
    }
    bb.log.info(`ambient speech ${id}: 200 ${audio.byteLength} bytes`);
    return new Response(audio as unknown as BodyInit,{headers:{'Content-Type':'audio/mpeg','Cache-Control':'private, max-age=3600','Content-Length':String(audio.byteLength)}});
  });
  bb.http.route('GET','/audio.js',()=>new Response(worklet,{headers:{'Content-Type':'text/javascript','Cache-Control':'no-store'}}));
  // Screen frames arrive here, not over the voice socket. Default "local" auth means a
  // local BB app origin and a JSON content type; the capture id does the session binding.
  // Nothing about the body is logged or echoed back.
  bb.http.route('POST','/frame',async(c)=>{
    const declared=Number(c.req.header('content-length')??NaN);
    const reply=(status:number,ok:boolean,reason?:string)=>
      new Response(JSON.stringify(reason?{ok,reason}:{ok}),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    if(Number.isFinite(declared)&&declared>MAX_BODY_BYTES) return reply(413,false,'too-large');
    let raw:string;
    try { raw=await c.req.text(); } catch { return reply(400,false,'bad-request'); }
    let payload:any;
    try { payload=JSON.parse(raw); } catch { return reply(400,false,'bad-request'); }
    const result=frames.deliver({id:payload?.id,payload,byteLength:raw.length});
    return reply(result.status,result.ok,result.reason);
  });
  bb.http.experimental_websocket('/voice',(request)=>{
    // Pocket is a native app with no browser user agent; the notebook uses that to tell Walk from the panel.
    const userAgent=request?.headers?.get?.('user-agent')??'';
    // This connection's notebook entry: one per call, kept across a direct thread line and continued walks.
    let book:Awaited<ReturnType<typeof notebook.open>>=null;
    let session:TalkSession|null=null;
    let review:ReturnType<typeof createReviewManager>|null=null;
    let sweeper:ReturnType<typeof setInterval>|undefined;
    let closed=false, starting=false, ownsReservation=false, stopRequested=false, watchdog:ReturnType<typeof setInterval>|undefined;
    const closedWaiters:(()=>void)[]=[];
    const me={lastSeen:Date.now(),socketClosed:false,evict:async(reason:string)=>{
      // A direct worker line (cedar) is closed too; it has no walk of its own to hand off.
      try{legs.dispose();}catch{}
      const target=session;
      if(!target){if(holder===me)holder=null;if(ownsReservation){reserved=false;ownsReservation=false;}return;}
      await evictWithTimeout({close:()=>target.close(reason),waitClosed:new Promise<void>(r=>closedWaiters.push(r)),
        force:()=>{try{(target as any).socket?.terminate?.();}catch{}}});
      // If the provider never confirmed, release anyway: a dead holder must not block the user.
      if(holder===me)holder=null;
      if(active===target){active=null;activeReview=null;publishReceipt=null;reserved=false;ownsReservation=false;}
    }};
    let startup:ReturnType<typeof setTimeout>;
    const focusRequests=new Map<string,{threadId:string;resolve:()=>void;reject:()=>void;timer:ReturnType<typeof setTimeout>}>();
    const cancelFocus=()=>{for(const r of focusRequests.values()){clearTimeout(r.timer);r.reject();}focusRequests.clear();};
    const share=new ShareState();
    const frameRequests=new Map<string,{resolve:(frame:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
    let sessionId='';
    // One walk can span several connections (legs) when a handoff continues it.
    let walk={id:'',startedAt:'',leg:1};
    const cancelFrames=()=>{const error=new ActionError('The browser disconnected before the snapshot arrived.');if(sessionId)frames.cancel(sessionId,error);for(const r of frameRequests.values()){clearTimeout(r.timer);r.reject(error);}frameRequests.clear();};
    let snapshots:SnapshotStore|null=null;
    const uploads=new Map<string,{path:string;bytes:number}>();
    const releaseScreen=()=>{cancelFrames();share.clear();snapshots?.clear();uploads.clear();};
    // Direct-worker voice mode (direct-worker.mjs): one leg at a time on this socket. The
    // manager leg closes, a worker leg opens in its own voice, and the manager comes back
    // through the same start path below. The reservation and the browser mic never change hands.
    let lastContext:{threadId:string|null;projectId:string|null}={threadId:null,projectId:null};
    let peer:any=null, restartManager:(()=>void)|null=null;
    // The manager coming back after a direct thread line is the same call: same walk, same notebook entry.
    let returningFromWorker=false;
    const out=(type:string,value:object={})=>{if(peer?.readyState===1)peer.send(JSON.stringify({type,...value}));};
    const legs=new DirectWorkerLegs({send:out,
      openWorker:async(pending:any,{onReturn}:{onReturn:(args:any)=>any})=>{
        const apiKey=await key();
        if(!apiKey||closed)return null;
        const s=await settings.get();
        const leg=createWorkerLeg({key:apiKey,target:pending.target,
          cli:createCli({cliPath:s.cliPath,serverUrl:bb.server.loopbackBaseUrl,timeout:60000}),
          read:(name:string,args:unknown,signal?:AbortSignal)=>query(name,args,signal),
          store:bb.storage.kv,timeZone:s.timeZone||DEFAULT_TIME_ZONE,backend:backendOf(s),onReceipt:(receipt:any)=>{out('action',{receipt});book?.action(receipt);},onReturn});
        leg.on('audio',(bytes:Uint8Array)=>{if(peer?.readyState===1)peer.send(bytes);});
        // No 'fault' forwarding: a failed worker leg returns to the manager instead of ending the panel.
        for(const type of ['ready','playback','flush']) leg.on(type,(value:object)=>out(type,value));
        // The line's voice is the thread's, so the panel and the notebook name the thread, not BB.
        const line={threadId:pending.target.threadId,title:pending.target.title};
        leg.on('transcript',(value:any)=>{out('transcript',{...value,leg:'worker',...line});book?.transcript(value,{thread:line});});
        book?.leg();book?.workerLine({state:'opened',target:line});
        leg.on('closed',(value:any)=>book?.workerLine({state:value?.reason==='ended'&&!legs.returning?'ended':'returned',target:line}));
        leg.on('lookup',(event:any)=>{if(event?.name!=='__backend__')out('lookup',lookupMessage(pending.target,event));});
        leg.on('timing',(record:any)=>bb.log.info(`worker ${timingLine(record)}`));
        active=leg;publishReceipt=(receipt:any)=>out('action',{receipt});
        leg.on('closed',()=>{if(active===leg){active=null;publishReceipt=null;}});
        return leg;
      },
      startManager:()=>{session=null;review=null;returningFromWorker=true;restartManager?.();},
      endCall:(value:any)=>{out('closed',value);peer?.close(1000);},
    });
    const enterWorkerLine=async(target:any,{heard=null,immediate=false}:{heard?:string|null;immediate?:boolean}={})=>{
      // A worker line would bypass the review gate, so it waits until the review ends.
      if(review?.state().active)throw new ActionError('Review mode is on. End the review before opening a direct line to a thread.');
      const manager=session;
      if(!manager)throw new ActionError('The manager is not connected.');
      return legs.requestWorker(target,{heard,immediate,closeManager:(reason:string)=>manager.close(reason)});
    };
    return {
      onOpen(socket) { peer=socket; startup=setTimeout(()=>{if(!session){closed=true;socket.close(1000);}},15000); },
      onMessage:async function onMessage(socket,data) {
        if(closed) return;
        me.lastSeen=Date.now();
        peer=socket; restartManager??=()=>{void onMessage(socket,JSON.stringify({type:'start',context:lastContext}));};
        if(typeof data!=='string') { (legs.routing??session)?.audio(data); return; }
        // Frames travel over the authenticated POST route, so the socket keeps its original
        // control-message budget: nothing large has any business on it.
        if(data.length>16000) {socket.close(1009);return;}
        let message;
        try {message=JSON.parse(data);} catch {socket.close(1008);return;}
        const send=(type:string,value:object={})=>{if(socket.readyState===1)socket.send(JSON.stringify({type,...value}));};
        if(message.type==='start'&&!session&&!starting&&!legs.busy) {
          // This socket may re-enter here to bring the manager back after a direct worker line.
          // A holder elsewhere that has gone silent is a dead connection (e.g. Wi-Fi -> 5G): take
          // over instead of refusing. A holder still streaming is a genuinely live call elsewhere.
          if(reserved&&!ownsReservation&&holder&&holder!==me&&holderIsStale(holder,Date.now())&&!takingOver){
            takingOver=true;
            try {await holder.evict('network-lost');} finally {takingOver=false;}
            if(closed)return;
          }
          if(reserved&&!ownsReservation) {send('fault',{message:'A voice call is already live in another tab or device. End it there, then start again.'});socket.close(1000);return;}
          const parsed=contextSchema.safeParse(message.context??{threadId:null,projectId:null});
          if(!parsed.success) {socket.close(1008);return;}
          lastContext=parsed.data;
          reserved=true;ownsReservation=true;starting=true;holder=me;
          try {
            const apiKey=await key();
            if(closed) return;
            if(!apiKey) throw new Error('Missing credentials');
            clearTimeout(startup);
            sessionId=`${Date.now()}-${randomUUID()}`;
            const s=await settings.get();
            setProfile({name:s.userName,machine:s.preferredMachine,workerRules:s.workerRules});
            const limit=sessionMinutes(s.maxMinutes);
            const handoffOn=String(s.walkHandoff??'on').trim().toLowerCase()!=='off';
            // A handoff token continues the SAME walk; anything else starts a new one.
            // An explicit token (limit handoff) wins; otherwise a call that just died on a network
            // loss is continued automatically, within the handoff's 10-minute window.
            const token=pickHandoffToken({explicit:message.handoff,lastDrop,now:Date.now()});
            const claim=token?await claimHandoff(bb.storage.kv,token):{record:null,why:null};
            if(claim.record&&lastDrop?.token===token)lastDrop=null;
            const carried=claim.record;
            const fromWorker=returningFromWorker&&Boolean(walk.id);returningFromWorker=false;
            walk=carried?{id:carried.walkId,startedAt:carried.walkStartedAt,leg:carried.leg}
              :fromWorker?walk:{id:sessionId,startedAt:new Date().toISOString(),leg:1};
            const previousReceipts=await recentReceipts(bb.storage.kv);
            if(closed)return;
            // The first start on this socket opens its notebook entry; a continued walk adds to the walk's own.
            if(!book)book=await notebook.open({id:walk.id,surface:surfaceOf(parsed.data,{userAgent}),context:parsed.data,continued:Boolean(carried)}).catch(()=>null);
            book?.leg();
            const actionCli=createCli({cliPath:s.cliPath,serverUrl:bb.server.loopbackBaseUrl,timeout:60000});
            snapshots=new SnapshotStore({directory:join(s.snapshotDirectory,sessionId.slice(-12))});

            // Standing operating context goes into the backend instructions at session start: a
            // voice append over 500 tokens is rejected by GPT-Live and the call never starts.
            let standingBackend='';
            // A phone call on the lean prompt carries at most the brief operating context.
            const phoneLean=s.phoneCallPrompt==='lean'&&['hey-bb','checkin'].includes(parsed.data.source??'');
            const standingMode=phoneLean&&s.backendStandingContext!=='off'?'brief':s.backendStandingContext;
            try {standingBackend=operatingBriefing(trimOperatingContext(await loadOperatingContext(s.operatingContextFile),standingMode));}
            catch {/* a missing context file must never block a call */}
            if(closed)return;
            let manager:ReturnType<typeof createManager>;
            session=new TalkSession({key:apiKey,sessionId,context:parsed.data,timeZone:s.timeZone||DEFAULT_TIME_ZONE,standingBackend,backend:backendOf(s),toolset:phoneLean?'lean':'full',
              maxMs:limit.minutes*60000,warnMs:warningOffsets(limit.minutes),handoffAtLimit:handoffOn,query:(name:string,args:any)=>{
              if(Object.hasOwn(reviewSchemas,name)){if(!review)throw new Error('Review mode is not available yet.');return review(name,args);}
              // Review mode blocks agent actions until the user explicitly hands the notes off.
              if(Object.hasOwn(actionSchemas,name)){review?.guard(name,args);return manager(name,args);}
              return query(name,args,session?.controller.signal);
            }});
            // The SDK path is the fallback for when the CLI itself cannot run.
            // A short CLI timeout, so a hanging CLI falls through to the SDK while the user is still listening.
            const inbox=createInbox({threadId:s.managerThreadId,cli:createCli({cliPath:s.cliPath,serverUrl:bb.server.loopbackBaseUrl,timeout:10000}),
              send:(args:any)=>bb.sdk.threads.send(args)});
            manager=createManager({cli:actionCli,store:bb.storage.kv,requests:session.userRequests,sessionId,originThreadId:parsed.data.threadId,timeZone:s.timeZone||DEFAULT_TIME_ZONE,inbox,
              focus:({threadId,title}:{threadId:string;title:string})=>new Promise<void>((resolve,reject)=>{
                if(closed){reject(new Error('Browser disconnected'));return;}
                const id=randomUUID();
                const timer=setTimeout(()=>{focusRequests.delete(id);reject(new Error('Focus unconfirmed'));},8000);
                focusRequests.set(id,{threadId,resolve,reject:()=>reject(new Error('Browser disconnected')),timer});
                send('ui-action',{id,kind:'focus-thread',threadId,title});
              }),
              screen:{
                // Refuses unless the browser says it is sharing right now; there is no ambient capture.
                capture:async({reason}:{reason:string})=>{
                  if(closed)throw new ActionError('The browser disconnected, so nothing can be captured.');
                  if(!share.active)throw new ActionError(captureFailures['not-sharing']);
                  const id=randomUUID();
                  const frame=await new Promise<any>((resolve,reject)=>{
                    const timer=setTimeout(()=>{frames.close(id);frameRequests.delete(id);reject(new ActionError('The browser did not return a snapshot in time. Say you could not get a look at the screen.'));},15000);
                    const settle=(fn:Function)=>(value:any)=>{clearTimeout(timer);frames.close(id);frameRequests.delete(id);fn(value);};
                    const done=settle(resolve),fail=settle(reject);
                    // Redeemable over the HTTP route, or over the socket for a failure notice.
                    frames.open(id,{sessionId,resolve:done,reject:fail});
                    frameRequests.set(id,{resolve:done,reject:fail,timer});
                    send('ui-action',{id,kind:'capture-screen',reason:String(reason).slice(0,240)});
                  });
                  if(frame.ok!==true)throw new ActionError(captureFailures[frame.reason]||captureFailures['capture-failed']);
                  if(!share.active)throw new ActionError('The user stopped sharing before the snapshot could be used.');
                  const record=snapshots!.put(frame);
                  const described=describeSnapshot(record,snapshots!.age(record));
                  const surfaceLabel=SURFACE_LABELS[record.surface as keyof typeof SURFACE_LABELS]||SURFACE_LABELS.unknown;
                  const provided=session!.provideImage({dataUrl:record.dataUrl,detail:'high',
                    text:`Screen snapshot the user is sharing with you: their ${surfaceLabel} "${record.label}" as it looked at ${record.capturedAt} (${record.width}x${record.height}, downscaled from ${record.sourceWidth}x${record.sourceHeight}). Snapshot id ${record.id}. Reason for looking: ${String(reason).slice(0,240)}. This is one still frame, not a live view.`});
                  if(!provided)throw new ActionError('The snapshot could not be handed to the vision backend. Do not describe the screen.');
                  send('screen-snapshot',{snapshotId:record.id,capturedAt:record.capturedAt,reason:String(reason).slice(0,240),reused:frame.reused===true});
                  return {snapshot:described,share:share.describe()};
                },
                // Writes the JPEG only now, because the user has authorized handing it to an agent,
                // then uploads the bytes into the target project so a worker on ANY machine can open
                // it. The upload is bound to the project that owns the target thread.
                attach:async(snapshotId:string,projectId:string)=>{
                  const record=snapshots?.get(snapshotId);
                  if(!record)throw new ActionError('That snapshot is no longer held for this session. Take a fresh one with bb_view_screen before attaching it.');
                  if(snapshots!.stale(record))throw new ActionError('That snapshot is more than five minutes old. Take a fresh one with bb_view_screen before attaching it.');
                  if(!/^proj_[a-z0-9]+$/.test(projectId||''))throw new ActionError('The snapshot could not be bound to a project. Name the project that owns the target thread.');
                  const saved=await snapshots!.persist(snapshotId);
                  const cacheKey=`${saved.id}:${projectId}`;
                  let uploaded=uploads.get(cacheKey);
                  if(!uploaded){
                    const dto=await actionCli(['project','attachment','upload',projectId,'--client-file',saved.path,
                      '--filename',`${saved.id}.jpg`,'--mime-type','image/jpeg','--json']);
                    if(!dto?.path||typeof dto.path!=='string'||!(dto.sizeBytes>0))
                      throw new ActionError('The snapshot upload did not return a usable attachment. Do not tell the user the agent can see the screen.');
                    uploaded={path:dto.path,bytes:dto.sizeBytes};
                    uploads.set(cacheKey,uploaded);
                  }
                  return {snapshotId:saved.id,path:uploaded.path,bytes:uploaded.bytes,projectId,
                    capturedAt:saved.capturedAt,surface:saved.surface,label:saved.label};
                },
              },
              onReceipt:(receipt:any)=>{send('action',{receipt});book?.action(receipt);},
              talkToWorker:(target:any,{heard}:{heard:string|null})=>enterWorkerLine(target,{heard}),
            });
            let reviewing=false;
            review=createReviewManager({store:bb.storage.kv,requests:session.userRequests,sessionId,originThreadId:parsed.data.threadId,
              gate:new NotificationGate({policy:'immediate'}),
              onState:(state:any)=>{
                send('review',{state});
                if(state.active!==reviewing){reviewing=state.active;session?.reviewMode(state.active,state);}
              }});
            session.reviewGate=review.gate; // One delivery path: notifyWorker applies review policy, then quiet.
            // Responsiveness cues (cues.mjs): off unless opted in; they never report a result.
            attachCues(session,{profile:s.cueProfile,onCue:(cue:object)=>send('cue',cue),onEarcon:(state:object)=>send('working',state)});
            // "Thought bubble" during a live call: personal, so it never touches receipts or continuity.
            (session as any).query=withThoughtTool((session as any).query,createThoughtTool({store:bb.storage.kv,requests:session.userRequests,sessionId,
              onCaptured:(thought:any)=>{if(parsed.data.ambientRun)walkMemory.redactLastUser(parsed.data.ambientRun);book?.note(thought);}}));
            active=session;activeReview=review;
            publishReceipt=(receipt:any)=>send('action',{receipt});
            send('review',{state:review.state()});
            sweeper=setInterval(()=>{
              const drained=review?.sweep();
              if(drained?.items?.length)active?.announceBatch(drained.items,'review');
            },2000);
            session.on('transcript',()=>review?.gate.markActivity());
            // A rejected session config (e.g. a setting GPT-Live doesn't accept) must show up in the server log, not only on the phone.
            session.on('fault',(value:any)=>bb.log.warn(`voice fault: ${String(value?.message??JSON.stringify(value)).slice(0,300)}`));
            session.on('transcript',(value:any)=>book?.transcript(value));
            const runId=parsed.data.ambientRun;
            // The run's earlier calls (never this one), sized to what's left of the 1800-char append.
            const withWalkHistory=(base:string)=>{const h=runId?walkMemory.briefing(runId,1780-base.length-170):'';return h?`${base} ${h}`:base;};
            if(runId){walkMemory.startCall(runId);session.on('transcript',(value:any)=>walkMemory.add(runId,value));}
            send('actions',{receipts:previousReceipts});
            session.on('audio',(bytes:Uint8Array)=>{if(socket.readyState===1)socket.send(bytes);});
            for(const type of ['ready','transcript','playback','flush','fault','notice','rate-limit','rate-limit-cleared']) session.on(type,(value:object)=>send(type,value));
            // Prior-session context is offered as history only; it never re-enters the authorized request log.
            session.on('ready',()=>{void (async()=>{
              try {
                // An unfinished review is RESTORED, not merely mentioned: leaving the mode off
                // would silently re-permit the agent actions the user was reviewing instead of
                // approving. The panel shows it, so the restoration is visible rather than implied.
                const restored=await review?.resume({anchorThreadId:parsed.data.threadId}).catch(()=>null);
                if(restored?.active&&!closed&&session){reviewing=true;session.reviewMode(true,{...restored,restoredFromPreviousSession:true});}
                // Standing context first, independent of continuity: a first call of the day
                // has no previous session but still needs the user's goals and boundaries.
                // The walk opener and in-call ledger rules ride along on every call, file or not.
                // Short walk guidance as a voice append (the long context is already in the backend).
                // Hey BB has its own opener below; the walk opener (check live threads first) would compete with it.
                if(!closed&&session&&!['hey-bb','checkin'].includes(parsed.data.source??''))session.standing(sessionBriefing({continuation:Boolean(carried)}));
                // Opened from an Ambient check-in the user said yes to: start on those items, not the previous call.
                const ambientCtx=parsed.data.ambientId?spokenText.get(parsed.data.ambientId):undefined;
                // A live check-in (2026-09-28): BB wakes up and says it itself, then asks; the user's yes or no is the
                // first turn. Replaces the pre-rendered check-in voice and its separate answer window.
                if(ambientCtx&&parsed.data.source==='checkin'&&!closed&&session){
                  const d=ambientCtx.delivery??{};
                  const n=(d.count??1)+(d.more??0);
                  const question=d.kind==='urgent'?'Want to cover it now?':`Want to go through ${n===1?'it':'them'}?`;
                  const music=parsed.data.music;
                  const musicLine=music==='paused'?'Their music is paused while you talk.':music==='ducked'?'Their music is still playing, turned down, while you talk.':'';
                  session.resume(withWalkHistory(`Ambient Walk check-in. You are chiming in over the user's walk. ${musicLine} Threads: ${JSON.stringify(d.threadIds??[])}. `+
                    `If they say yes, in one or two short sentences say what came up and ask which to take first; read a thread before explaining or acting on it. `+
                    `If they say no or not now, say only "Back to your music." and nothing after it. Saying yes authorizes no agent action by itself. `+
                    `When they are done, say only "Back to your music."`));
                  session.greet(`${ambientCtx.text} ${question}`.slice(0,380));
                  return;
                }
                if(ambientCtx&&!closed&&session){
                  const d=ambientCtx.delivery??{};
                  // Opened from a check-in the user said yes to. The check-in goes in as context (like a resume);
                  // the user's own spoken "yeah", which Pocket streams first, is the turn that starts the call.
                  // (A cue or a synthetic user turn doesn't work: appends stay pending until the user's first turn,
                  // and a typed turn goes to the backend without the voice ever answering.)
                  session.resume(withWalkHistory(`Ambient Walk triage. The user has music playing and just heard this check-in: "${ambientCtx.text}" `+
                    `(threads: ${JSON.stringify(d.threadIds??[])}). They said yes to going through it now. When they speak, in one or two short sentences `+
                    `say what came up and ask which to take first. Read a thread before explaining or acting on it. Keep it brief; they want to get back to their music. `+
                    `Saying yes authorizes no agent action by itself. When they say they're done, say a one-line goodbye.`));
                  return;
                }
                // Opened by "Hey BB" over music: the user's buffered words are the first turn. Keep it short and
                // sign off so Pocket (which ends on the user's thanks or 8 s of quiet) can hand the music back.
                if(parsed.data.source==='hey-bb'&&!closed&&session){
                  const music=parsed.data.music;
                  const musicLine=music==='paused'?'Their music or podcast is paused while you talk.':music==='ducked'?'Their music is still playing, turned down, while you talk.':music==='none'?'Nothing is playing on their side.':'Their music may be playing.';
                  const signOff=music==='paused'||music==='ducked'?'"Back to your music."':'"Okay."';
                  const acked=parsed.data.acked&&parsed.data.ambientRun?ackServed.get(parsed.data.ambientRun)?.text:undefined;
                  const planned=!parsed.data.acked&&parsed.data.ambientRun?ackServed.get(parsed.data.ambientRun):undefined;
                  const greeting=planned&&Date.now()-planned.at<30*60_000?planned.text:undefined;
                  const bare=parsed.data.bare;
                  const ackLine=acked?`The phone already greeted them with: "${acked}" Do not greet again; answer what they say next. `
                    :bare===true?`You are greeting them now with "${greeting??'Hey.'}"; after that, answer what they say next. `
                    :bare===false?'They went straight into a request after "Hey BB": do not greet, answer it. '
                    :greeting?`If all they have said is "Hey BB", greet them with exactly: "${greeting}" and then wait for them. If they already asked something, skip the greeting and answer it. `:'';
                  session.resume(withWalkHistory(`Hey BB over music. ${musicLine} They said "Hey BB" to ask something quick. ${ackLine}`+
                    'Answer in one to three short sentences; offer more only if they ask. Read a thread before explaining or acting on it. '+
                    'Their own captured notes are found with bb_recall_thoughts, not bb_search. '+
                    `When they signal they are done (thanks, that is all, got it, I am good), say only a one-line sign-off such as ${signOff} and nothing after it.`));
                  // A bare wake: BB speaks first instead of waiting for a second "are you there?".
                  if(bare===true&&!closed&&session)session.greet(greeting??'Hey.');
                  return;
                }
                // A continued walk gets its own ledger and last words, never the previous walk's summary.
                if(carried){
                  await consumeHandoff(bb.storage.kv,carried).catch(()=>{});
                  if(!closed&&session&&session.resume(handoffBriefing(carried)))send('resume',{summary:handoffSummary(carried)});
                  return;
                }
                if(token&&claim.why)send('notice',{text:`The previous walk could not be continued (${claim.why}), so this is a fresh start. Nothing was acted on.`});
                const previous=await loadContinuity(bb.storage.kv,{sessionId});
                if(!previous||closed||!session)return;
                // Null when nothing is open: the call starts clean instead of opening on old words.
                // Back from a direct thread line, the "previous session" is this same call's first leg: the manager
                // still gets it as history, but the panel shows no last-session card mid-call.
                const briefing=resumeBriefing({...previous,reviewRestored:Boolean(restored?.active)});
                if(briefing&&session.resume(briefing)&&!fromWorker)
                  send('resume',{summary:{...resumeSummary(previous),reviewRestored:Boolean(restored?.active)}});
              } catch {/* a missing continuity record must never block a call */}
            })();});
            // A hold is only durable if it is written when it happens.
            session.on('timing',(record:any)=>bb.log.info(timingLine(record)));
            session.on('deferred-notice',(notice:any)=>{if(notice?.reason==='review')review?.noteHeld();});
            session.on('lookup',(event:any)=>{
              if(event?.name==='__backend__')return; // cue bookkeeping only; the panel shows real lookups
              const sources: {id:string;title:string;projectId:string|null}[]=[];
              if(event.result?.thread) sources.push(event.result.thread);
              if(event.result?.threads) sources.push(...event.result.threads);
              for(const group of ['active','archived']) for(const row of event.result?.[group]?.results??[]) sources.push(row.thread);
              // Notes: only how many matched (never their text), so the phone log can tell found from not found.
              send('lookup',{state:event.state,name:event.name,checkedAt:event.result?.checkedAt,
                ...(event.name==='bb_recall_thoughts'?{found:event.result?.matched??null,searched:event.result?.searched??null}:{}),
                sources:sources.slice(0,60).map(t=>({id:t.id,title:t.title,read:event.name==='bb_read_thread'}))});
            });
            const owned=session;
            // After a direct worker line, the return handoff lands once the manager is back.
            session.on('ready',()=>{setTimeout(()=>legs.managerReady(owned),750);});
            session.on('closed',(value:any)=>{
              cancelFocus();releaseScreen();clearInterval(sweeper);
              const endedWalk=walk;
              // A switch to a direct thread line keeps this socket's reservation, and the browser stays connected.
              const switching=!closed&&legs.managerClosed();
              if(active===owned){active=null;activeReview=null;publishReceipt=null;if(!switching){reserved=false;ownsReservation=false;}}
              if(switching&&session===owned){session=null;review=null;}
              if(!switching)void book?.close({reason:value?.reason??'ended'});
              void (async()=>{
                let receipts:any[]=[];
                try {
                  receipts=await recentReceipts(bb.storage.kv);
                  await saveContinuity(bb.storage.kv,buildContinuity({sessionId,reason:value?.reason??'ended',context:owned.context,
                    utterances:owned.userRequests.parts,receipts,seconds:value?.seconds??0,
                    heldNotices:owned.deferred,
                    openReview:await openReviewFor(bb.storage.kv,{resumableReview,ReviewNotes}).catch(()=>null)}));
                } catch {/* losing the continuity record must not break teardown */}
                // At the limit (ours or the provider's) the panel gets a single-use token to continue
                // this walk. If saving it fails the call simply ends as before, with continuity saved.
                let handoff=null;
                if(handoffOn&&['handoff','provider-expired','network-lost'].includes(value?.reason)){
                  try {
                    const record=buildHandoff({sessionId,walkId:endedWalk.id,walkStartedAt:endedWalk.startedAt,leg:endedWalk.leg,
                      reason:value.reason,utterances:owned.userRequests.parts,receipts});
                    await saveHandoff(bb.storage.kv,record);
                    handoff={token:record.token,leg:record.leg,expiresAt:record.expiresAt};
                    if(value.reason==='network-lost')lastDrop={token:record.token,at:Date.now()};
                  } catch {/* no token: the panel shows the plain end-of-session message */}
                }
                if(switching)return;
                send('closed',{...value,limitMinutes:limit.minutes,handoff});socket.close(1000);
                clearInterval(watchdog);if(holder===me)holder=null;
                for(const done of closedWaiters.splice(0))done();
              })();
            });
            session.start();
            // Orphan cleanup: a client silent this long is gone (half-open socket after a network
            // switch). End the provider session so it stops billing, and keep the walk continuable.
            watchdog=setInterval(()=>{
              const live=legs.routing??session;
              if(live&&!live.closing&&Date.now()-me.lastSeen>TIMING.deadClientMs){try{legs.dispose();}catch{}session?.close('network-lost');try{socket.close(1001);}catch{}}
            },TIMING.watchdogIntervalMs);
          } catch {
            send('fault',{message:'Could not start voice. Check the plugin connection settings.'});
            if(!session)void book?.close({reason:'failed'});
            if(ownsReservation){reserved=false;ownsReservation=false;} socket.close(1011);
          } finally { starting=false; if(closed&&ownsReservation&&!session){reserved=false;ownsReservation=false;} }
        } else if(message.type==='stop') {stopRequested=true;(legs.routing??session)?.close();}
        else if(message.type==='ping') send('pong',{at:Date.now()});
        else if(message.type==='mute') (legs.routing??session)?.mute(true);
        else if(message.type==='resume') (legs.routing??session)?.mute(false);
        else if(message.type==='ask'){const live=legs.routing??session;if(live){live.ask(message.text);if(typeof message.text==='string'&&message.text.length<=2000)book?.typed(message.text);}}
        else if(message.type==='worker-start'&&session&&!legs.busy){
          try {
            const s=await settings.get();
            const target=await resolveWorkerTarget(createCli({cliPath:s.cliPath,serverUrl:bb.server.loopbackBaseUrl}),message.threadId);
            await enterWorkerLine(target,{immediate:true});
          } catch(error:any){send('leg',{mode:'manager',error:error?.name==='ActionError'?error.message:'Could not open a direct line to that thread.'});}
        }
        else if(message.type==='worker-return'&&legs.routing){
          try {legs.requestManager({reason:'asked',immediate:true});} catch {/* already switching */}
        }
        else if(message.type==='screen-share'){
          const described=share.update(message.share);
          if(!described.active){cancelFrames();snapshots?.clear();}
          session?.updateScreenShare(described);
          send('screen-share',{share:described});
        }
        else if(message.type==='screen-frame'){
          const pending=frameRequests.get(message.id);
          if(pending){clearTimeout(pending.timer);frameRequests.delete(message.id);pending.resolve(message);}
        }
        else if(message.type==='review'&&review){
          const topic=typeof message.topic==='string'?message.topic.slice(0,200):'the item on screen';
          // On failure re-publish the authoritative state so the toggle cannot lie about the mode.
          void (message.on===false?review.endFromUi():review.startFromUi({topic,anchorThreadId:session?.context?.threadId??null}))
            .catch(()=>review?.publish());
        }
        else if(message.type==='review-drain'){
          const drained=review?.drainFromUi();
          // One batch phrasing for both release paths: review end and un-mute read identically.
          if(drained?.items?.length)session?.announceBatch(drained.items,'review');
        }
        else if(message.type==='ui-result'){
          const pending=focusRequests.get(message.id);
          if(pending){clearTimeout(pending.timer);focusRequests.delete(message.id);if(message.ok===true&&message.threadId===pending.threadId)pending.resolve();else pending.reject();}
        }
        else if(message.type==='context') {const parsed=contextSchema.safeParse(message.context);if(parsed.success){lastContext=parsed.data;session?.updateContext(parsed.data);}}
      },
      onClose() {closed=true;me.socketClosed=true;legs.dispose();clearTimeout(startup);clearInterval(sweeper);cancelFocus();releaseScreen();
        // No stop message means the connection dropped: keep the walk continuable.
        session?.close(stopRequested?'ended':'network-lost');
        // On a direct thread line there is no manager session left to close the notebook entry.
        if(!session)void book?.close({reason:stopRequested?'ended':'network-lost'});
        if(!session&&ownsReservation){reserved=false;ownsReservation=false;if(holder===me)holder=null;}},
      onError() {closed=true;me.socketClosed=true;legs.dispose();clearTimeout(startup);clearInterval(sweeper);cancelFocus();releaseScreen();session?.close(stopRequested?'ended':'network-lost');if(!session)void book?.close({reason:stopRequested?'ended':'network-lost'});},
    };
  });
  // Worker state survives the call. The dispatcher lives in worker-events.mjs so the same
  // code a test drives is the code the host calls: one event updates the newest matching
  // receipt only, and delivery policy stays inside the session.
  // Which turn answered a request from the live call is read from the thread's event log before
  // it is read back (B19); the real follow-on turn started 5 s after the idle before it, so the
  // window is 12 s. Thread reads use the SDK, not the CLI, which can hang.
  const onWorkerEvent=createWorkerEventHandler({store:bb.storage.kv,session:()=>active,publish:(receipt:any)=>publishReceipt?.(receipt),
    settleMs:12000,readThread:(threadId:string)=>bb.sdk.threads.get({threadId}) as Promise<any>,
    listEvents:(threadId:string,since:number)=>collectEvents((beforeSeq?:string)=>
      bb.sdk.threads.events.list({threadId,order:'desc',limit:'100',...(beforeSeq?{beforeSeq}:{})}) as Promise<any[]>,since)});
  bb.onDispose(()=>onWorkerEvent.dispose());
  // Awaited, not fire-and-forget: the host's dispatch waits for the receipt write.
  // Ambient Walk sees the same events after the live path; anything a live call already said is marked spoken.
  for(const event of WORKER_EVENTS)bb.events.on(event as any,async(data:any)=>{const result=await onWorkerEvent(event,data);await ambient.observe(event,data,result).catch(()=>{});});
  bb.onDispose(()=>{active?.close();});
}
