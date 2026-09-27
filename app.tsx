// Created: 2026-09-15.
import { useEffect, useRef, useState } from 'react';
import { definePluginApp, useBbContext, useBbNavigate } from '@get-bb/plugin-sdk/app';
import { FocusRequests } from './focus-ui.mjs';
import { ScreenShare, SURFACES, shareFailureNote } from './screen-share.mjs';
import './app.css';

const TOGGLE='talk-to-bb:toggle';
const BASE='/api/v1/plugins/talk-to-bb/http';
type Caption={speaker:string;text:string};
type Source={id:string;title:string;read:boolean};
type Receipt={id:string;kind:string;status:string;threadId:string|null;title:string;model?:string|null;workerState?:string;detail?:string};
type CarryOver={endedAt:string;reason:string;unfinished:string|null;commitments:string[];unresolved:{title:string;status:string;threadId:string|null}[];openReview?:{topic:string|null;noteCount:number|null;restored:boolean}|null;reviewRestored?:boolean;note:string};
type Note={seq:number;kind:string;text:string;anchor:string|null;adopted:string[]};
type Review={active:boolean;topic:string|null;notes:Note[];noteCount:number;held:number;awaiting:string[]};
const NO_REVIEW:Review={active:false,topic:null,notes:[],noteCount:0,held:0,awaiting:[]};
type Resources={socket?:WebSocket;context?:AudioContext;stream?:MediaStream;processor?:AudioWorkletNode;timer?:ReturnType<typeof setTimeout>};
type Share={active:boolean;surface:string|null;label:string|null;since:string|null;frames:number};
const IDLE_SHARE:Share={active:false,surface:null,label:null,since:null,frames:0};

function VoicePanel() {
  const [visible,setVisible]=useState(false), [phase,setPhase]=useState('idle');
  const [status,setStatus]=useState('Talk through anything happening in BB.');
  const [captions,setCaptions]=useState<Caption[]>([]),[sources,setSources]=useState<Source[]>([]);
  const [muted,setMuted]=useState(false),[micMuted,setMicMuted]=useState(false),[lookup,setLookup]=useState('');
  const [question,setQuestion]=useState('');
  const [receipts,setReceipts]=useState<Receipt[]>([]);
  const [share,setShare]=useState<Share>(IDLE_SHARE),[shareNote,setShareNote]=useState('');
  const [lastLook,setLastLook]=useState<{at:string;reason:string}|null>(null);
  const [notice,setNotice]=useState('');
  const [carry,setCarry]=useState<CarryOver|null>(null);
  // Review policy is its own axis: independent of micMuted (input) and muted (output).
  const [review,setReview]=useState<Review>(NO_REVIEW);
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
  useEffect(()=>{focus.current?.observe(context.threadId);if(ready.current)send({type:'context',context:{threadId:context.threadId,projectId:context.projectId}});},[context.threadId,context.projectId]);
  useEffect(()=>{if(scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;},[captions]);
  function append(speaker:string,text:string) {
    const rows=captionsRef.current;
    if(rows.at(-1)?.speaker===speaker)rows[rows.length-1]={speaker,text:rows[rows.length-1].text+text};
    else rows.push({speaker,text});
    if(rows.length>200)rows.shift();setCaptions([...rows]);
  }
  async function start() {
    cleanup(); const token=generation.current;
    const current=()=>token===generation.current;
    setPhase('connecting');setStatus('Allow microphone access to begin.');setMuted(false);setMicMuted(false);
    setSources([]);setCaptions([]);captionsRef.current=[];log.current=[];audible.current=true;setNotice('');setCarry(null);setReview(NO_REVIEW);
    try {
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('Open BB in a full HTTPS browser tab to use your microphone.');
      const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,channelCount:1}});
      if(!current()){stream.getTracks().forEach(t=>t.stop());return;}
      resources.current.stream=stream;
      const audio=new AudioContext({sampleRate:16000});resources.current.context=audio;
      if(audio.sampleRate!==16000)throw new Error('This browser cannot use the required audio format. Try Chrome.');
      await audio.audioWorklet.addModule(`${BASE}/audio.js`);if(!current())return;
      await audio.resume();if(!current())return;
      const processor=new AudioWorkletNode(audio,'voice-audio');resources.current.processor=processor;
      audio.createMediaStreamSource(stream).connect(processor);processor.connect(audio.destination);
      const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${BASE}/voice`);
      resources.current.socket=ws;ws.binaryType='arraybuffer';
      resources.current.timer=setTimeout(()=>{if(current()&&!ready.current){cleanup();setPhase('idle');setStatus('Connection timed out. Please try again.');}},25000);
      processor.port.onmessage=({data})=>{
        if(!current())return;
        if(data.type==='input'&&ready.current&&ws.readyState===1){
          if(ws.bufferedAmount>64000){end();setStatus('Audio upload fell behind. Please reconnect.');return;}
          ws.send(data.buffer);
        }
        if(data.type==='playback-stats')record('playback-stats',data);
        if(data.type==='overflow'){end();setStatus('Audio playback fell behind. Please reconnect.');}
      };
      ws.onopen=()=>{if(!current())return;setStatus('Connecting voice…');send({type:'start',context:{threadId:contextRef.current.threadId,projectId:contextRef.current.projectId}});};
      ws.onmessage=({data})=>{
        if(!current())return;
        if(data instanceof ArrayBuffer){if(audible.current)processor.port.postMessage({type:'audio',buffer:data},[data]);return;}
        const e=JSON.parse(data);record(e.type,e);
        if(e.type==='ui-action'&&e.kind==='focus-thread')focus.current?.open(e);
        if(e.type==='ui-action'&&e.kind==='capture-screen')void screen.current?.handle(e);
        if(e.type==='screen-snapshot')setLastLook({at:new Date().toISOString(),reason:String(e.reason||'')});
        if(e.type==='actions')setReceipts(e.receipts||[]);
        if(e.type==='review')setReview({...NO_REVIEW,...e.state});
        if(e.type==='action')setReceipts(old=>[e.receipt,...old.filter(r=>r.id!==e.receipt.id)].slice(0,30));
        if(e.type==='ready'){ready.current=true;clearTimeout(resources.current.timer);setPhase('live');setStatus('Listening across all your BB projects.');}
        if(e.type==='rate-limit')setStatus(e.text||'OpenAI is temporarily limiting backend requests. Retrying shortly.');
        if(e.type==='rate-limit-cleared')setStatus('Checking BB again…');
        if(e.type==='notice')setNotice(e.text||'');
        if(e.type==='resume')setCarry(e.summary||null);
        if(e.type==='transcript')append(e.speaker,e.text);
        if(e.type==='flush')processor.port.postMessage({type:'flush'});
        if(e.type==='playback'){audible.current=e.enabled;setMuted(!e.enabled);}
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
        if(e.type==='fault'){cleanup();setPhase('idle');setLookup('');setStatus(e.message);}
        if(e.type==='closed'){cleanup();setPhase('idle');setLookup('');setNotice('');
          setStatus(e.reason==='time-limit'
            ?`Twenty-minute limit reached (${Math.round(e.seconds)} seconds). Anything left open is carried into your next session; nothing was acted on.`
            :`Session ended (${Math.round(e.seconds)} seconds).`);}
      };
      ws.onerror=()=>{if(current()){cleanup();setPhase('idle');setStatus('Could not connect to Talk to BB. Please retry.');}};
      ws.onclose=()=>{if(current()){cleanup();setPhase('idle');setLookup('');setStatus('Session ended.');}};
    } catch(cause) {
      if(!current())return;
      cleanup();setPhase('idle');
      const error=cause as Error;
      setStatus(error.name==='NotAllowedError'?'Microphone blocked. Allow microphone access in this site’s browser permissions, then try again.':error.message);
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
    if(next)resources.current.processor?.port.postMessage({type:'flush'});
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
  function showHeldUpdates() {send({type:'review-drain'});record('review-drain');}
  function ask(text:string) {if(!text.trim()||!ready.current)return;append('you',text);record('typed-question',{text});send({type:'ask',text});setQuestion('');}
  function download() {
    const url=URL.createObjectURL(new Blob([JSON.stringify({created:new Date().toISOString(),captions:captionsRef.current,actions:receipts,reviewNotes:review.notes,diagnostics:log.current},null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='talk-to-bb.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  if(!visible)return phase==='live'||phase==='connecting'?<button className="ttbb-pill" onClick={()=>setVisible(true)}>● Talk to BB · {micMuted?'mic paused':'live'}</button>:null;
  return <section ref={panel} tabIndex={-1} className="ttbb-panel" role="dialog" aria-label="Talk to BB" onKeyDown={e=>{if(e.key==='Escape'){setVisible(false);e.stopPropagation();}}}>
    <header className="ttbb-header"><div><strong>Talk to BB</strong><span className="ttbb-eyebrow">Your work, across every thread</span></div><button aria-label="Minimize Talk to BB" title="Minimize; conversation stays connected" onClick={()=>setVisible(false)}>−</button></header>
    <div className="ttbb-status" role="status"><span className={`ttbb-dot ${phase==='live'?'is-live':''}`}/>{status}</div>
    {share.active
      ?<div className="ttbb-sharing" role="status"><span className="ttbb-dot is-sharing"/><span>Sharing your {SURFACES[share.surface as keyof typeof SURFACES]||'surface'}{share.label?` — ${share.label}`:''}. BB sees it only when it takes a snapshot{share.frames?`; ${share.frames} so far`:', and has taken none yet'}.</span></div>
      :phase==='live'?<p className="ttbb-note ttbb-sharing-off">BB cannot see your screen. Share screen lets it take a snapshot when you ask.</p>:null}
    {lastLook&&share.active?<p className="ttbb-lookup" role="status">Snapshot taken{lastLook.reason?` — ${lastLook.reason}`:''}</p>:null}
    {shareNote?<p className="ttbb-note ttbb-sharing-off" role="status">{shareNote}</p>:null}
    {notice?<p className="ttbb-notice" role="status">{notice} Nothing continues on its own — say what should carry over.</p>:null}
    {carry?<details className="ttbb-sources ttbb-carry" open><summary>Carried over from your last session</summary><div className="ttbb-carry-body">
      {carry.unfinished?<p><strong>Cut off mid-sentence:</strong> “{carry.unfinished}”</p>:null}
      {carry.commitments.length?<p><strong>Still recorded:</strong> {carry.commitments.join('; ')}</p>:null}
      {carry.unresolved.length?<p><strong>Never confirmed:</strong> {carry.unresolved.map(u=>`${u.title} (${u.status})`).join('; ')}</p>:null}
      {carry.openReview?<p><strong>{carry.openReview.restored?'Review reopened:':'Review still open:'}</strong> {carry.openReview.topic||'an untitled review'}{carry.openReview.noteCount===null?'':` · ${carry.openReview.noteCount} note${carry.openReview.noteCount===1?'':'s'}`}{carry.openReview.restored?' — agent actions are blocked again until you end it.':' — agent actions are available.'}</p>:null}
      <p className="ttbb-note">{carry.note}</p></div></details>:null}
    <div className="ttbb-controls">
      {phase==='idle'?<button className="ttbb-primary" onClick={()=>void start()}>Start talking</button>:<><button onClick={end}>End</button><button disabled={phase!=='live'} onClick={toggleMic}>{micMuted?'Resume mic':'Pause mic'}</button><button disabled={phase!=='live'} onClick={toggleVoice}>{muted?'Hear replies':'Quiet'}</button>{share.active?<button className="ttbb-sharing-stop" onClick={stopShare}>Stop sharing</button>:<button disabled={phase!=='live'} onClick={()=>void startShare()}>Share screen</button>}<button className={review.active?'ttbb-review-on':''} aria-pressed={review.active} title="Collect comments as notes; agents are not started or steered" disabled={phase!=='live'} onClick={toggleReview}>{review.active?'End review':'Review'}</button></>}
    </div>
    {review.active?<p className="ttbb-review-banner" role="status">Review mode{review.topic?` · ${review.topic}`:''} — collecting notes. Agent actions are paused until you hand these off.</p>:null}
    {review.held?<p className="ttbb-held" role="status">{review.held} agent update{review.held===1?'':'s'} held <button onClick={showHeldUpdates}>Show updates</button></p>:null}
    {phase==='idle'&&!captions.length?<div className="ttbb-intro"><p>Discuss your work, bring a thread into view, or ask an agent to take the next step.</p><p className="ttbb-note">You direct the work. Assigned agents keep working after the call ends. Voice uses $0.05/min plus reasoning; agent usage is separate.</p></div>:null}
    {phase==='live'&&!captions.length?<div className="ttbb-suggestions">{['What needs my attention?','What are my agents working on?','Help me think through this thread.'].map(q=><button key={q} onClick={()=>ask(q)}>{q}</button>)}</div>:null}
    <div className="ttbb-captions" ref={scroll} aria-label="Conversation transcript">{captions.map((c,i)=><div className={`ttbb-caption ${c.speaker}`} key={i}><span>{c.speaker==='you'?'You':'BB'}</span><p>{c.text}</p></div>)}</div>
    {phase==='live'?<form className="ttbb-question" onSubmit={e=>{e.preventDefault();ask(question);}}><input aria-label="Type a question" placeholder="Or type a question…" maxLength={2000} value={question} onChange={e=>setQuestion(e.target.value)}/><button disabled={!question.trim()} type="submit">Ask</button></form>:null}
    {lookup?<p className="ttbb-lookup" role="status">{lookup}</p>:null}
    {review.notes.length?<details className="ttbb-sources ttbb-notes" open><summary>Review notes ({review.noteCount})</summary><div>{review.notes.map(n=><div key={n.seq}><span>{n.seq}. {n.text}</span><small>{n.kind}{n.anchor?` · ${n.anchor}`:''}</small>{n.adopted.map((a,i)=><small key={i}>adopted instead: {a}</small>)}</div>)}</div></details>:null}
    {receipts.length?<details className="ttbb-sources ttbb-actions" open><summary>Actions ({receipts.length})</summary><div>{receipts.slice(0,12).map(r=><button disabled={!r.threadId} key={r.id} onClick={()=>r.threadId&&navigate.toThread(r.threadId)}><span>{r.title}</span><small>{r.status.replaceAll('-',' ')}{r.workerState?` · Agent ${r.workerState.replaceAll('-',' ')}`:''}{r.model?` · ${r.model}`:''}</small>{r.detail?<small>{r.detail}</small>:null}</button>)}</div></details>:null}
    {sources.length?<details className="ttbb-sources"><summary>Threads checked ({sources.length})</summary><div>{sources.map(s=><button key={s.id} onClick={()=>navigate.toThread(s.id)}><span>{s.title}</span><small>{s.read?'Conversation read':'Found in BB'}</small></button>)}</div></details>:null}
    <footer><span>{phase==='live'?(micMuted?'Microphone paused':muted?'Listening · replies muted':'Microphone on'):'Microphone off'}{share.active?' · screen shared':''}{review.active?' · Review on':''}</span><button onClick={download} disabled={!log.current.length}>Download conversation</button></footer>
  </section>;
}

export default definePluginApp(app=>{
  app.experimental_sidebarFooter.register({kind:'action',id:'talk-to-bb',label:'Talk to BB',icon:'Mic',onActivate:()=>{window.dispatchEvent(new Event(TOGGLE));}});
  app.slots.experimental_appOverlay({id:'talk-to-bb',component:VoicePanel});
});
