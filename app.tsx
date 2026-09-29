// Created: 2026-09-15.
import { useEffect, useRef, useState } from 'react';
import { definePluginApp, useBbContext, useBbNavigate } from '@get-bb/plugin-sdk/app';
import { FocusRequests } from './focus-ui.mjs';
import { Earcon, isAudible } from './earcon.mjs';
import { ScreenShare, SURFACES, shareFailureNote } from './screen-share.mjs';
import { NotebookView } from './notebook-view';
import './app.css';

// Same schedule as RETRY_DELAYS_MS in netdrop.mjs (server-side module; not imported here because
// it pulls in node:crypto). The first tries usually land inside the server's takeover window.
const RETRY_DELAYS_MS=[2000,4000,8000,15000];
// Same as NOTEBOOK_LIMITS.maxTurns: a long walk keeps its first words on screen too.
const CAPTION_LIMIT=1500;

const TOGGLE='talk-to-bb:toggle';
const BASE='/api/v1/plugins/talk-to-bb/http';
// On a direct thread line the voice is that thread's: its title labels the caption, not BB.
type Caption={speaker:string;text:string;title?:string;threadId?:string};
type Source={id:string;title:string;read:boolean};
type Receipt={id:string;kind:string;status:string;threadId:string|null;title:string;model?:string|null;workerState?:string;detail?:string};
type CarryOver={endedAt:string;reason:string;unfinished:string|null;commitments:string[];unresolved:{title:string;status:string;threadId:string|null}[];openReview?:{topic:string|null;noteCount:number|null;restored:boolean}|null;reviewRestored?:boolean;note:string};
type Note={seq:number;kind:string;text:string;anchor:string|null;adopted:string[]};
type Review={active:boolean;topic:string|null;notes:Note[];noteCount:number;held:number;awaiting:string[]};
const NO_REVIEW:Review={active:false,topic:null,notes:[],noteCount:0,held:0,awaiting:[]};
type Resources={socket?:WebSocket;context?:AudioContext;stream?:MediaStream;processor?:AudioWorkletNode;timer?:ReturnType<typeof setTimeout>};
type Share={active:boolean;surface:string|null;label:string|null;since:string|null;frames:number};
const IDLE_SHARE:Share={active:false,surface:null,label:null,since:null,frames:0};
// Direct-worker voice mode (direct-worker.mjs): which leg of the call is speaking.
type Leg={mode:'manager'|'switching'|'worker';title:string|null;threadId:string|null};
const MANAGER_LEG:Leg={mode:'manager',title:null,threadId:null};

function VoicePanel() {
  const [visible,setVisible]=useState(false), [phase,setPhase]=useState('idle');
  // The notebook replaces the call view in the panel; a live call keeps running underneath it.
  const [view,setView]=useState<'call'|'notebook'>('call');
  const [status,setStatus]=useState('Talk through anything happening in BB.');
  const [captions,setCaptions]=useState<Caption[]>([]),[sources,setSources]=useState<Source[]>([]);
  const [muted,setMuted]=useState(false),[micMuted,setMicMuted]=useState(false),[lookup,setLookup]=useState('');
  const [question,setQuestion]=useState('');
  const [receipts,setReceipts]=useState<Receipt[]>([]);
  const [share,setShare]=useState<Share>(IDLE_SHARE),[shareNote,setShareNote]=useState('');
  const [lastLook,setLastLook]=useState<{at:string;reason:string}|null>(null);
  const [notice,setNotice]=useState('');
  const [carry,setCarry]=useState<CarryOver|null>(null);
  // A single-use token to continue the same walk after the connection limit (handoff.mjs).
  const [handoff,setHandoff]=useState<{token:string;leg:number;expiresAt:string}|null>(null);
  const [noticeTail,setNoticeTail]=useState(true);
  // Unexpected drop (e.g. Wi-Fi -> 5G): retry on a schedule, then offer one Reconnect button.
  const [lost,setLost]=useState(false);
  // The soft "still working" sound (earcon.mjs); the server says when, through 'working' events.
  const earcon=useRef<Earcon|null>(null);
  const retry=useRef<{timer?:ReturnType<typeof setTimeout>;next:number}>({next:0});
  // Review policy is its own axis: independent of micMuted (input) and muted (output).
  const [review,setReview]=useState<Review>(NO_REVIEW);
  const [leg,setLeg]=useState<Leg>(MANAGER_LEG);
  const legRef=useRef<Leg>(MANAGER_LEG);
  const resources=useRef<Resources>({}),generation=useRef(0),ready=useRef(false),audible=useRef(true);
  const log=useRef<any[]>([]),captionsRef=useRef<Caption[]>([]),scroll=useRef<HTMLDivElement>(null),panel=useRef<HTMLElement>(null);
  const context=useBbContext(),contextRef=useRef(context),navigate=useBbNavigate();
  const navigateRef=useRef(navigate);navigateRef.current=navigate;
  contextRef.current=context;
  const send=(data:object)=>{const ws=resources.current.socket;if(ws?.readyState===1)ws.send(JSON.stringify(data));};
  const focus=useRef<FocusRequests|null>(null);
  if(!focus.current)focus.current=new FocusRequests({navigate:(id:string)=>navigateRef.current.toThread(id),currentThread:()=>contextRef.current.threadId,send});
  const screen=useRef<ScreenShare|null>(null);
  if(!screen.current)screen.current=new ScreenShare({
    getDisplayMedia:(constraints:any)=>navigator.mediaDevices.getDisplayMedia(constraints),
    send,onChange:(next:Share)=>setShare({...next}),
    // Frames go to the plugin's authenticated route, never the voice socket.
    upload:async(payload:any)=>{
      const response=await fetch(`${BASE}/frame`,{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(!response.ok)throw new Error(`frame upload ${response.status}`);
    },
  });
  const record=(type:string,data:object={})=>log.current.push({at:new Date().toISOString(),type,...data});
  function cleanup() {
    focus.current?.cancel();
    screen.current?.dispose();setShare(IDLE_SHARE);setShareNote('');setLastLook(null);
    generation.current++;ready.current=false;
    earcon.current?.stop();earcon.current=null;
    const r=resources.current;resources.current={};
    clearTimeout(r.timer);r.stream?.getTracks().forEach(t=>t.stop());r.processor?.disconnect();
    void r.context?.close().catch(()=>{});r.socket?.close();
  }
  function end() {record('end');send({type:'stop'});cleanup();setPhase('idle');setLookup('');setStatus('Session ended.');}
  useEffect(()=>{
    const toggle=()=>setVisible(v=>!v);
    const leave=()=>cleanup();
    window.addEventListener(TOGGLE,toggle);window.addEventListener('pagehide',leave);
    return()=>{window.removeEventListener(TOGGLE,toggle);window.removeEventListener('pagehide',leave);cleanup();};
  },[]);
  useEffect(()=>{if(visible)panel.current?.focus();},[visible]);
  // Liveness for the server (the SDK socket has no ping): audio flows every 20 ms, this covers pauses.
  useEffect(()=>{if(phase!=='live')return;const id=setInterval(()=>send({type:'ping'}),5000);return()=>clearInterval(id);},[phase]);
  useEffect(()=>{if(!lost)return;const back=()=>{clearTimeout(retry.current.timer);void start(undefined,{reconnect:true});};
    window.addEventListener('online',back);return()=>window.removeEventListener('online',back);},[lost]);
  useEffect(()=>{focus.current?.observe(context.threadId);if(ready.current)send({type:'context',context:{threadId:context.threadId,projectId:context.projectId}});},[context.threadId,context.projectId]);
  useEffect(()=>{if(scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[captions]);
  function append(speaker:string,text:string,line:{title?:string;threadId?:string}={}) {
    const rows=captionsRef.current,last=rows.at(-1);
    if(last?.speaker===speaker&&last.threadId===line.threadId)rows[rows.length-1]={...last,text:last.text+text};
    else rows.push({speaker,text,...(line.threadId?{title:line.title||'Thread',threadId:line.threadId}:{})});
    // The whole call stays on screen across direct thread lines and reconnects; the cap matches the notebook's.
    if(rows.length>CAPTION_LIMIT)rows.shift();setCaptions([...rows]);
  }
  function clearRetry(){clearTimeout(retry.current.timer);retry.current={next:0};}
  function scheduleRetry(){
    const n=retry.current.next;
    if(n>=RETRY_DELAYS_MS.length){setStatus('Connection lost. Press Reconnect to continue your walk.');return;}
    setStatus(`Connection lost. Reconnecting… (try ${n+1} of ${RETRY_DELAYS_MS.length})`);
    retry.current={next:n+1,timer:setTimeout(()=>void start(undefined,{reconnect:true}),RETRY_DELAYS_MS[n])};
  }
  function dropped(){cleanup();setPhase('idle');setLookup('');setLost(true);scheduleRetry();}
  async function start(continueToken?:string,{reconnect=false}:{reconnect?:boolean}={}) {
    if(!reconnect)clearRetry();
    cleanup(); const token=generation.current;
    const current=()=>token===generation.current;
    setPhase('connecting');setStatus(reconnect?'Reconnecting…':continueToken?'Refreshing the connection so your walk can continue…':'Allow microphone access to begin.');setMuted(false);setMicMuted(false);
    // A continued walk keeps its transcript and actions on screen; a new one starts clean.
    if(!continueToken&&!reconnect){setSources([]);setCaptions([]);captionsRef.current=[];log.current=[];setHandoff(null);setLost(false);}
    audible.current=true;setNotice('');setCarry(null);setReview(NO_REVIEW);
    // Any failure while continuing leaves the token in place so Continue walk can retry it.
    const failed=(message:string)=>{if(reconnect){cleanup();setPhase('idle');setLookup('');scheduleRetry();return;}cleanup();setPhase('idle');setLookup('');
      setStatus(continueToken?`Could not reconnect automatically (${message}) Press Continue walk to pick up where you left off.`:message);};
    legRef.current=MANAGER_LEG;setLeg(MANAGER_LEG);
    try {
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('Open BB in a full HTTPS browser tab to use your microphone.');
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,channelCount:1}});
      if(!current()){stream.getTracks().forEach(t=>t.stop());return;}
      resources.current.stream=stream;
      const audio=new AudioContext({sampleRate:16000});resources.current.context=audio;earcon.current=new Earcon(audio);
      if(audio.sampleRate!==16000)throw new Error('This browser cannot use the required audio format. Try Chrome.');
      await audio.audioWorklet.addModule(`${BASE}/audio.js`);if(!current())return;
      await audio.resume();if(!current())return;
      const processor=new AudioWorkletNode(audio,'voice-audio');resources.current.processor=processor;
      audio.createMediaStreamSource(stream).connect(processor);processor.connect(audio.destination);
      const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${BASE}/voice`);
      resources.current.socket=ws;ws.binaryType='arraybuffer';
      resources.current.timer=setTimeout(()=>{if(current()&&!ready.current)failed('Connection timed out. Please try again.');},25000);
      processor.port.onmessage=({data})=>{
        if(!current())return;
        if(data.type==='input'&&ready.current&&ws.readyState===1){
          if(ws.bufferedAmount>64000){end();setStatus('Audio upload fell behind. Please reconnect.');return;}
          ws.send(data.buffer);
        }
        if(data.type==='playback-stats')record('playback-stats',data);
        if(data.type==='overflow'){end();setStatus('Audio playback fell behind. Please reconnect.');}
      };
      ws.onopen=()=>{if(!current())return;setStatus('Connecting voice…');send({type:'start',context:{threadId:contextRef.current.threadId,projectId:contextRef.current.projectId},...(continueToken?{handoff:continueToken}:{})});};
      ws.onmessage=({data})=>{
        if(!current())return;
        if(data instanceof ArrayBuffer){if(isAudible(data))earcon.current?.stop();if(audible.current)processor.port.postMessage({type:'audio',buffer:data},[data]);return;}
        const e=JSON.parse(data);record(e.type,e);
        if(e.type==='ui-action'&&e.kind==='focus-thread')focus.current?.open(e);
        if(e.type==='ui-action'&&e.kind==='capture-screen')void screen.current?.handle(e);
        if(e.type==='screen-snapshot')setLastLook({at:new Date().toISOString(),reason:String(e.reason||'')});
        if(e.type==='actions')setReceipts(e.receipts||[]);
        if(e.type==='review')setReview({...NO_REVIEW,...e.state});
        if(e.type==='action')setReceipts(old=>[e.receipt,...old.filter(r=>r.id!==e.receipt.id)].slice(0,30));
        if(e.type==='ready'){ready.current=true;clearTimeout(resources.current.timer);setPhase('live');setHandoff(null);setLost(false);clearRetry();
          setStatus(continueToken?'Walk continued. Listening across all your BB projects.':'Listening across all your BB projects.');}
        if(e.type==='rate-limit')setStatus(e.text||'OpenAI is temporarily limiting backend requests. Retrying shortly.');
        if(e.type==='rate-limit-cleared')setStatus('Checking BB again…');
        if(e.type==='notice'){setNotice(e.text||'');setNoticeTail(!e.handoff);}
        if(e.type==='resume'){
          const s=e.summary||null;
          // A continued walk reports its own ledger counts; only a fresh call shows the last-session card.
          if(s?.handoff){setNotice(`Walk continued (part ${s.leg}). Carried over: ${s.parked} parked, ${s.sent} sent, ${s.inProgress} in progress.`);setNoticeTail(false);}
          else setCarry(s);
        }
        // The server tags a direct line's words with its thread, including its goodbye while switching back.
        if(e.type==='transcript')append(e.speaker==='assistant'&&e.leg==='worker'?'worker':e.speaker,e.text,e.speaker==='assistant'&&e.leg==='worker'?{title:e.title,threadId:e.threadId}:{});
        if(e.type==='leg'){
          const next:Leg=e.mode==='worker'||e.mode==='switching'?{mode:e.mode,title:e.target?.title??legRef.current.title,threadId:e.target?.threadId??legRef.current.threadId}:MANAGER_LEG;
          legRef.current=next;setLeg(next);
          // The worker line has no screen tool, so a share would only look like consent it cannot use.
          if(next.mode!=='manager'&&screen.current){screen.current.stop('user');setLastLook(null);}
          if(e.error)setStatus(e.error);
          else if(e.mode==='switching')setStatus(e.to==='worker'?`Handing you to ${e.target?.title||'the thread'}…`:'Taking you back to the manager…');
          else if(e.mode==='worker')setStatus(`Talking directly to ${e.target?.title||'the thread'}, in a different voice.`);
          else if(e.from==='worker')setStatus('Back with the manager.');
        }
        if(e.type==='flush'){earcon.current?.stop();processor.port.postMessage({type:'flush'});}
        // Server says work is pending in silence (or no longer): play or stop the soft sound. Quiet wins.
        if(e.type==='working'){if(e.on&&audible.current)earcon.current?.start();else earcon.current?.stop();}
        if(e.type==='playback'){audible.current=e.enabled;setMuted(!e.enabled);}
        if(e.type==='cue'&&typeof e.text==='string')setLookup(e.text);
        if(e.type==='lookup'){
          const action=['bb_focus_thread','bb_spawn_thread','bb_tell_thread','bb_stop_thread'].includes(e.name);
          const look=e.name==='bb_view_screen';
          setLookup(e.state==='reading'?(look?'Taking one snapshot of the shared screen…':action?'Carrying out your request…':'Checking BB…'):e.state==='failed'?(look?'No snapshot was taken. BB has not seen your screen.':'The tool could not finish. See the conversation for details.'):look?'Snapshot delivered':action?'Action receipt received':'Checked BB just now');
          if(e.sources?.length)setSources(old=>{
            const map=new Map(old.map(s=>[s.id,s]));
            for(const s of e.sources)map.set(s.id,{...s,read:s.read||map.get(s.id)?.read||false});
            return [...map.values()].sort((a,b)=>Number(b.read)-Number(a.read)).slice(0,60);
          });
        }
        if(e.type==='fault')failed(e.message);
        if(e.type==='closed'){cleanup();setPhase('idle');setLookup('');setNotice('');setLost(false);clearRetry();
          // At the limit the server hands over a token: reconnect straight away and keep walking.
          if(e.handoff?.token){setHandoff(e.handoff);setStatus('Refreshing the connection so your walk can continue…');void start(e.handoff.token);return;}
          const limit=e.limitMinutes?`${e.limitMinutes}-minute`:'Twenty-minute';
          setStatus(e.reason==='time-limit'||e.reason==='handoff'
            ?`${limit} limit reached (${Math.round(e.seconds)} seconds). Anything left open is carried into your next session; nothing was acted on.`
            :e.reason==='provider-expired'
            ?`The voice service ended the session at its own time limit (${Math.round(e.seconds)} seconds). Anything left open is carried into your next session; nothing was acted on.`
            :`Session ended (${Math.round(e.seconds)} seconds).`);}
      };
      // A socket that dies after the call was live is a dropped connection, not an ending.
      ws.onerror=()=>{if(current()){if(ready.current)dropped();else failed('Could not connect to Talk to BB. Please retry.');}};
      ws.onclose=()=>{if(current()){if(ready.current)dropped();else failed('Session ended.');}};
    } catch(cause) {
      if(!current())return;
      const error=cause as Error;
      failed(error.name==='NotAllowedError'?'Microphone blocked. Allow microphone access in this site’s browser permissions, then try again.':error.message);
    }
  }
  async function startShare() {
    setShareNote('');
    if(!navigator.mediaDevices?.getDisplayMedia){setShareNote('This browser cannot share a screen here. Open BB in a full browser tab.');return;}
    try {
      // getDisplayMedia must run inside this click; the browser's picker is the consent step.
      await screen.current!.start();record('screen-share',{active:true});
    } catch(cause) {
      const error=cause as Error;
      setShareNote(shareFailureNote(error));
      record('screen-share-declined',{name:error?.name??null});
    }
  }
  function stopShare() {screen.current?.stop('user');record('screen-share',{active:false});setShareNote('');setLastLook(null);}
  function toggleVoice() {
    const next=!muted;audible.current=!next;setMuted(next);
    if(next){resources.current.processor?.port.postMessage({type:'flush'});earcon.current?.stop();}
    else void resources.current.context?.resume();
    send({type:next?'mute':'resume'});record(next?'mute':'resume');
  }
  function toggleMic() {
    const next=!micMuted;resources.current.stream?.getAudioTracks().forEach(t=>t.enabled=!next);setMicMuted(next);record('microphone',{muted:next});
  }
  function toggleReview() {
    const next=!review.active;
    setReview(r=>({...r,active:next}));   // server echoes the authoritative state
    send({type:'review',on:next});record('review',{on:next});
  }
  function talkToThread() {if(context.threadId){send({type:'worker-start',threadId:context.threadId});record('worker-start',{threadId:context.threadId});}}
  function backToManager() {send({type:'worker-return'});record('worker-return');}
  function showHeldUpdates() {send({type:'review-drain'});record('review-drain');}
  function ask(text:string) {if(!text.trim()||!ready.current)return;append('you',text);record('typed-question',{text});send({type:'ask',text});setQuestion('');}
  function download() {
    const url=URL.createObjectURL(new Blob([JSON.stringify({created:new Date().toISOString(),captions:captionsRef.current,actions:receipts,reviewNotes:review.notes,diagnostics:log.current},null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='talk-to-bb.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  if(!visible)return phase==='live'||phase==='connecting'?<button className="ttbb-pill" onClick={()=>setVisible(true)}>● Talk to BB · {micMuted?'mic paused':'live'}</button>:null;
  return <section ref={panel} tabIndex={-1} className="ttbb-panel" role="dialog" aria-label="Talk to BB" onKeyDown={e=>{if(e.key==='Escape'){setVisible(false);e.stopPropagation();}}}>
    <header className="ttbb-header"><div><strong>{view==='notebook'?'Notebook':'Talk to BB'}</strong><span className="ttbb-eyebrow">{view==='notebook'?'Your conversations and notes, from every device':'Your work, across every thread'}</span></div><div className="ttbb-header-actions"><button className="ttbb-book-toggle" aria-pressed={view==='notebook'} title={view==='notebook'?'Back to the call':'Past conversations and your notes'} onClick={()=>setView(v=>v==='notebook'?'call':'notebook')}>{view==='notebook'?(phase==='live'?'Back to call':'Back'):'Notebook'}</button><button aria-label="Minimize Talk to BB" title="Minimize; conversation stays connected" onClick={()=>setVisible(false)}>−</button></div></header>
    {view==='notebook'?<NotebookView/>:<>
    <div className="ttbb-status" role="status"><span className={`ttbb-dot ${phase==='live'?'is-live':''}`}/>{status}</div>
    {share.active
      ?<div className="ttbb-sharing" role="status"><span className="ttbb-dot is-sharing"/><span>Sharing your {SURFACES[share.surface as keyof typeof SURFACES]||'surface'}{share.label?` — ${share.label}`:''}. BB sees it only when it takes a snapshot{share.frames?`; ${share.frames} so far`:', and has taken none yet'}.</span></div>
      :phase==='live'?<p className="ttbb-note ttbb-sharing-off">BB cannot see your screen. Share screen lets it take a snapshot when you ask.</p>:null}
    {lastLook&&share.active?<p className="ttbb-lookup" role="status">Snapshot taken{lastLook.reason?` — ${lastLook.reason}`:''}</p>:null}
    {shareNote?<p className="ttbb-note ttbb-sharing-off" role="status">{shareNote}</p>:null}
    {notice?<p className="ttbb-notice" role="status">{notice}{noticeTail?' Nothing continues on its own — say what should carry over.':''}</p>:null}
    {carry?<details className="ttbb-sources ttbb-carry" open><summary>Carried over from your last session</summary><div className="ttbb-carry-body">
      {carry.unfinished?<p><strong>Cut off mid-sentence:</strong> “{carry.unfinished}”</p>:null}
      {carry.commitments.length?<p><strong>Still recorded:</strong> {carry.commitments.join('; ')}</p>:null}
      {carry.unresolved.length?<p><strong>Never confirmed:</strong> {carry.unresolved.map(u=>`${u.title} (${u.status})`).join('; ')}</p>:null}
      {carry.openReview?<p><strong>{carry.openReview.restored?'Review reopened:':'Review still open:'}</strong> {carry.openReview.topic||'an untitled review'}{carry.openReview.noteCount===null?'':` · ${carry.openReview.noteCount} note${carry.openReview.noteCount===1?'':'s'}`}{carry.openReview.restored?' — agent actions are blocked again until you end it.':' — agent actions are available.'}</p>:null}
      <p className="ttbb-note">{carry.note}</p></div></details>:null}
    <div className="ttbb-controls">
      {phase==='idle'?<>{lost?<button className="ttbb-primary" onClick={()=>{clearTimeout(retry.current.timer);void start(undefined,{reconnect:true});}}>Reconnect</button>:null}{handoff&&Date.parse(handoff.expiresAt)>Date.now()?<button className="ttbb-primary" onClick={()=>void start(handoff.token)}>Continue walk</button>:null}<button className={handoff||lost?undefined:'ttbb-primary'} onClick={()=>void start()}>{handoff||lost?'Start a new call':'Start talking'}</button></>:<><button onClick={end}>End</button><button disabled={phase!=='live'} onClick={toggleMic}>{micMuted?'Resume mic':'Pause mic'}</button><button disabled={phase!=='live'} onClick={toggleVoice}>{muted?'Hear replies':'Quiet'}</button>{share.active?<button className="ttbb-sharing-stop" onClick={stopShare}>Stop sharing</button>:<button disabled={phase!=='live'} onClick={()=>void startShare()}>Share screen</button>}<button className={review.active?'ttbb-review-on':''} aria-pressed={review.active} title="Collect comments as notes; agents are not started or steered" disabled={phase!=='live'} onClick={toggleReview}>{review.active?'End review':'Review'}</button>{leg.mode==='worker'?<button className="ttbb-worker-back" onClick={backToManager}>Back to manager</button>:<button title="Talk directly to the thread open in BB, in a different voice" disabled={phase!=='live'||leg.mode!=='manager'||!context.threadId||review.active} onClick={talkToThread}>Talk to this thread</button>}</>}
    </div>
    {leg.mode==='worker'?<p className="ttbb-worker-banner" role="status">Direct line to {leg.title||'a thread'} — a different voice. Say “take me back to the manager”, or press Back to manager.</p>:null}
    {review.active?<p className="ttbb-review-banner" role="status">Review mode{review.topic?` · ${review.topic}`:''} — collecting notes. Agent actions are paused until you hand these off.</p>:null}
    {review.held?<p className="ttbb-held" role="status">{review.held} agent update{review.held===1?'':'s'} held <button onClick={showHeldUpdates}>Show updates</button></p>:null}
    {phase==='idle'&&!captions.length?<div className="ttbb-intro"><p>Discuss your work, bring a thread into view, or ask an agent to take the next step.</p><p className="ttbb-note">You direct the work. Assigned agents keep working after the call ends. Voice uses $0.05/min plus reasoning; agent usage is separate.</p></div>:null}
    {phase==='live'&&!captions.length?<div className="ttbb-suggestions">{['What needs my attention?','What are my agents working on?','Help me think through this thread.'].map(q=><button key={q} onClick={()=>ask(q)}>{q}</button>)}</div>:null}
    <div className="ttbb-captions" ref={scroll} aria-label="Conversation transcript">{captions.map((c,i)=><div className={`ttbb-caption ${c.speaker}`} key={i}><span>{c.speaker==='you'?'You':c.speaker==='worker'?c.title||'Thread':'BB'}</span><p>{c.text}</p></div>)}</div>
    {phase==='live'?<form className="ttbb-question" onSubmit={e=>{e.preventDefault();ask(question);}}><input aria-label="Type a question" placeholder="Or type a question…" maxLength={2000} value={question} onChange={e=>setQuestion(e.target.value)}/><button disabled={!question.trim()} type="submit">Ask</button></form>:null}
    {lookup?<p className="ttbb-lookup" role="status">{lookup}</p>:null}
    {review.notes.length?<details className="ttbb-sources ttbb-notes" open><summary>Review notes ({review.noteCount})</summary><div>{review.notes.map(n=><div key={n.seq}><span>{n.seq}. {n.text}</span><small>{n.kind}{n.anchor?` · ${n.anchor}`:''}</small>{n.adopted.map((a,i)=><small key={i}>adopted instead: {a}</small>)}</div>)}</div></details>:null}
    {receipts.length?<details className="ttbb-sources ttbb-actions" open><summary>Actions ({receipts.length})</summary><div>{receipts.slice(0,12).map(r=><button disabled={!r.threadId} key={r.id} onClick={()=>r.threadId&&navigate.toThread(r.threadId)}><span>{r.title}</span><small>{r.status.replaceAll('-',' ')}{r.workerState?` · Agent ${r.workerState.replaceAll('-',' ')}`:''}{r.model?` · ${r.model}`:''}</small>{r.detail?<small>{r.detail}</small>:null}</button>)}</div></details>:null}
    {sources.length?<details className="ttbb-sources"><summary>Threads checked ({sources.length})</summary><div>{sources.map(s=><button key={s.id} onClick={()=>navigate.toThread(s.id)}><span>{s.title}</span><small>{s.read?'Conversation read':'Found in BB'}</small></button>)}</div></details>:null}
    </>}
    <footer><span>{phase==='live'?(micMuted?'Microphone paused':muted?'Listening · replies muted':'Microphone on'):'Microphone off'}{share.active?' · screen shared':''}{review.active?' · Review on':''}</span><button onClick={download} disabled={!log.current.length}>Download conversation</button></footer>
  </section>;
}

export default definePluginApp(app=>{
  app.experimental_sidebarFooter.register({kind:'action',id:'talk-to-bb',label:'Talk to BB',icon:'Mic',onActivate:()=>{window.dispatchEvent(new Event(TOGGLE));}});
  app.slots.experimental_appOverlay({id:'talk-to-bb',component:VoicePanel});
});
