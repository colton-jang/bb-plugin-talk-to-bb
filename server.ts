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
import { TalkSession } from './live-session.mjs';
import { createWorkerEventHandler, WORKER_EVENTS, collectEvents } from './worker-events.mjs';
import { setProfile } from './profile.mjs';
import { DEFAULT_TIME_ZONE, buildContinuity, saveContinuity, loadContinuity, resumeBriefing, resumeSummary, openReviewFor } from './reliability.mjs';
import worklet from './audio-source.mjs';

const contextSchema = z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/).nullable(), projectId: z.string().regex(/^proj_[a-z0-9]+$/).nullable() }).strict();
export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: z.object({configured:z.boolean(),active:z.boolean()}) },
  read: { input: z.object({name:z.string(),args:z.unknown()}).strict(), output: z.unknown() },
});

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {type:'string',label:'OpenAI API key (needs GPT-Live access)',secret:true},
    credentialFile: {type:'string',label:'Or: an env file on the BB server containing OPENAI_API_KEY',default:''},
    userName: {type:'string',label:'Your first name (the voice manager and agent briefs use it)',default:''},
    preferredMachine: {type:'string',label:'Machine to prefer for new agent work (name as shown in BB)',default:''},
    workerRules: {type:'string',label:'Extra rules appended to every agent brief (your tools, repo conventions, handoffs)',default:''},
    cliPath: {type:'string',label:'BB CLI executable on the BB server',default:process.env.BB_CLI || 'bb'},
    timeZone: {type:'string',label:'Time zone for resolving spoken dates',default:Intl.DateTimeFormat().resolvedOptions().timeZone||DEFAULT_TIME_ZONE},
    snapshotDirectory: {type:'string',label:'Where authorized screen snapshots are written on the BB server',default:join(homedir(),'.bb','talk-to-bb','snapshots')},
    managerThreadId: {type:'string',label:'Thread that receives notes voice records and requests it could not complete (a thr_ id; blank keeps them only in Talk to BB)',default:''},
  });
  const captureFailures: Record<string,string> = {
    'not-sharing':'The user is not sharing a screen right now, so there is nothing to look at. Ask them to press Share screen in the Talk to BB panel.',
    'frame-limit':'This session has reached its snapshot limit. Ask the user to describe what they are looking at instead.',
    'capture-in-progress':'A snapshot is already being taken. Wait for it rather than asking again.',
    'frame-too-large':'The shared surface could not be reduced to a sendable image. Ask the user to share a single window or tab instead of a whole screen.',
    'capture-failed':'The browser could not read the shared surface. Ask the user to re-share, or to describe what they see.',
  };
  const frames = new FrameInbox();
  let active: TalkSession | null = null;
  let activeReview: ReturnType<typeof createReviewManager> | null = null;
  let reserved = false;
  let publishReceipt:((receipt:any)=>void)|null=null;
  async function key() {
    const s = await settings.get();
    if (s.apiKey) return s.apiKey;
    if (!s.credentialFile) return '';
    try { return parseEnv(await readFile(s.credentialFile,'utf8')).OPENAI_API_KEY || ''; } catch { return ''; }
  }
  async function query(name:string,args:unknown,signal?:AbortSignal) {
    const s=await settings.get();
    return createReader({cliPath:s.cliPath,serverUrl:bb.server.loopbackBaseUrl,signal})(name,args);
  }
  bb.rpc.register(rpcContract,{
    status:async()=>({configured:Boolean(await key()),active:reserved}),
    read:({name,args})=>query(name,args),
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
  bb.http.experimental_websocket('/voice',()=>{
    let session:TalkSession|null=null;
    let review:ReturnType<typeof createReviewManager>|null=null;
    let sweeper:ReturnType<typeof setInterval>|undefined;
    let closed=false, starting=false, ownsReservation=false;
    let startup:ReturnType<typeof setTimeout>;
    const focusRequests=new Map<string,{threadId:string;resolve:()=>void;reject:()=>void;timer:ReturnType<typeof setTimeout>}>();
    const cancelFocus=()=>{for(const r of focusRequests.values()){clearTimeout(r.timer);r.reject();}focusRequests.clear();};
    const share=new ShareState();
    const frameRequests=new Map<string,{resolve:(frame:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
    let sessionId='';
    const cancelFrames=()=>{const error=new ActionError('The browser disconnected before the snapshot arrived.');if(sessionId)frames.cancel(sessionId,error);for(const r of frameRequests.values()){clearTimeout(r.timer);r.reject(error);}frameRequests.clear();};
    let snapshots:SnapshotStore|null=null;
    const uploads=new Map<string,{path:string;bytes:number}>();
    const releaseScreen=()=>{cancelFrames();share.clear();snapshots?.clear();uploads.clear();};
    return {
      onOpen(socket) { startup=setTimeout(()=>{if(!session){closed=true;socket.close(1000);}},15000); },
      async onMessage(socket,data) {
        if(closed) return;
        if(typeof data!=='string') { session?.audio(data); return; }
        // Frames travel over the authenticated POST route, so the socket keeps its original
        // control-message budget: nothing large has any business on it.
        if(data.length>16000) {socket.close(1009);return;}
        let message;
        try {message=JSON.parse(data);} catch {socket.close(1008);return;}
        const send=(type:string,value:object={})=>{if(socket.readyState===1)socket.send(JSON.stringify({type,...value}));};
        if(message.type==='start'&&!session&&!starting) {
          if(reserved) {send('fault',{message:'A voice session is already open. End it before starting another.'});socket.close(1000);return;}
          const parsed=contextSchema.safeParse(message.context??{threadId:null,projectId:null});
          if(!parsed.success) {socket.close(1008);return;}
          reserved=true;ownsReservation=true;starting=true;
          try {
            const apiKey=await key();
            if(closed) return;
            if(!apiKey) throw new Error('Missing credentials');
            clearTimeout(startup);
            sessionId=`${Date.now()}-${randomUUID()}`;
            const s=await settings.get();
            setProfile({name:s.userName,machine:s.preferredMachine,workerRules:s.workerRules});
            const previousReceipts=await recentReceipts(bb.storage.kv);
            if(closed)return;
            const actionCli=createCli({cliPath:s.cliPath,serverUrl:bb.server.loopbackBaseUrl,timeout:60000});
            snapshots=new SnapshotStore({directory:join(s.snapshotDirectory,sessionId.slice(-12))});

            let manager:ReturnType<typeof createManager>;
            session=new TalkSession({key:apiKey,sessionId,context:parsed.data,timeZone:s.timeZone||DEFAULT_TIME_ZONE,query:(name:string,args:any)=>{
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
              onReceipt:(receipt:any)=>send('action',{receipt}),
            });
            let reviewing=false;
            review=createReviewManager({store:bb.storage.kv,requests:session.userRequests,sessionId,originThreadId:parsed.data.threadId,
              gate:new NotificationGate({policy:'immediate'}),
              onState:(state:any)=>{
                send('review',{state});
                if(state.active!==reviewing){reviewing=state.active;session?.reviewMode(state.active,state);}
              }});
            session.reviewGate=review.gate; // One delivery path: notifyWorker applies review policy, then quiet.
            active=session;activeReview=review;
            publishReceipt=(receipt:any)=>send('action',{receipt});
            send('review',{state:review.state()});
            sweeper=setInterval(()=>{
              const drained=review?.sweep();
              if(drained?.items?.length)active?.announceBatch(drained.items,'review');
            },2000);
            session.on('transcript',()=>review?.gate.markActivity());
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
                const previous=await loadContinuity(bb.storage.kv,{sessionId});
                if(!previous||closed||!session)return;
                // Null when nothing is open: the call starts clean instead of opening on old words.
                const briefing=resumeBriefing({...previous,reviewRestored:Boolean(restored?.active)});
                if(briefing&&session.resume(briefing))
                  send('resume',{summary:{...resumeSummary(previous),reviewRestored:Boolean(restored?.active)}});
              } catch {/* a missing continuity record must never block a call */}
            })();});
            // A hold is only durable if it is written when it happens.
            session.on('deferred-notice',(notice:any)=>{if(notice?.reason==='review')review?.noteHeld();});
            session.on('lookup',(event:any)=>{
              const sources: {id:string;title:string;projectId:string|null}[]=[];
              if(event.result?.thread) sources.push(event.result.thread);
              if(event.result?.threads) sources.push(...event.result.threads);
              for(const group of ['active','archived']) for(const row of event.result?.[group]?.results??[]) sources.push(row.thread);
              send('lookup',{state:event.state,name:event.name,checkedAt:event.result?.checkedAt,
                sources:sources.slice(0,60).map(t=>({id:t.id,title:t.title,read:event.name==='bb_read_thread'}))});
            });
            const owned=session;
            session.on('closed',(value:any)=>{
              cancelFocus();releaseScreen();clearInterval(sweeper);
              void (async()=>{
                try {
                  await saveContinuity(bb.storage.kv,buildContinuity({sessionId,reason:value?.reason??'ended',context:owned.context,
                    utterances:owned.userRequests.parts,receipts:await recentReceipts(bb.storage.kv),seconds:value?.seconds??0,
                    heldNotices:owned.deferred,
                    openReview:await openReviewFor(bb.storage.kv,{resumableReview,ReviewNotes}).catch(()=>null)}));
                } catch {/* losing the continuity record must not break teardown */}
              })();
              if(active===owned){active=null;activeReview=null;publishReceipt=null;reserved=false;ownsReservation=false;}
              send('closed',value);socket.close(1000);
            });
            session.start();
          } catch {
            send('fault',{message:'Could not start voice. Check the plugin connection settings.'});
            if(ownsReservation){reserved=false;ownsReservation=false;} socket.close(1011);
          } finally { starting=false; if(closed&&ownsReservation&&!session){reserved=false;ownsReservation=false;} }
        } else if(message.type==='stop') session?.close();
        else if(message.type==='mute') session?.mute(true);
        else if(message.type==='resume') session?.mute(false);
        else if(message.type==='ask') session?.ask(message.text);
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
        else if(message.type==='context') {const parsed=contextSchema.safeParse(message.context);if(parsed.success)session?.updateContext(parsed.data);}
      },
      onClose() {closed=true;clearTimeout(startup);clearInterval(sweeper);cancelFocus();releaseScreen();session?.close();if(!session&&ownsReservation){reserved=false;ownsReservation=false;}},
      onError() {closed=true;clearTimeout(startup);clearInterval(sweeper);cancelFocus();releaseScreen();session?.close();},
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
  for(const event of WORKER_EVENTS)bb.events.on(event as any,async(data:any)=>{await onWorkerEvent(event,data);});
  bb.onDispose(()=>{active?.close();});
}
