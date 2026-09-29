// Created: 2026-09-28. The Notebook view in the Talk to BB panel: every voice conversation (panel, Walk, Hey BB,
// check-ins), newest first and grouped by day, each expandable to its transcript; and every captured note, with
// delete. Read-only apart from deleting a note, which asks first.
import { useEffect, useState } from 'react';
import { useBbNavigate, useRpc } from '@get-bb/plugin-sdk/app';

type Summary={id:string;surface:string;startedAt:string;endedAt:string|null;seconds:number;legs:number;turnCount:number;actionCount:number;noteCount:number;truncated:boolean;preview:string};
// label is who spoke as a reader sees it: You, BB, or the thread's title on a direct line (with its threadId).
type Turn={speaker:string;label?:string;threadId?:string;text:string;at:string;typed?:boolean;noteId?:string;noteDeleted?:boolean};
type Action={id:string;kind:string;status:string;title:string;threadId:string|null;model:string|null;workerState:string|null;link:string|null;endedAt?:string|null};
type Thought={id:string;text:string;at:string;capturedAt:string;capturedVia:string;deleted?:boolean};
type Session={id:string;surface:string;startedAt:string;endedAt:string|null;truncated:boolean;turns:Turn[];actions:Action[];notes:Thought[]};

const SURFACE:Record<string,string>={panel:'Panel','walk':'Walk','hey-bb':'Hey BB','check-in':'Check-in'};
const SPEAKER:Record<string,string>={you:'You',bb:'BB',thread:'Thread'};
const VIA:Record<string,string>={siri:'Siri','action-button':'Action Button',control:'Control',walk:'Walk',voice:'In a call',app:'App'};

const time=(iso:string)=>new Date(iso).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
function day(iso:string){
  const d=new Date(iso),today=new Date(),yesterday=new Date();yesterday.setDate(today.getDate()-1);
  if(d.toDateString()===today.toDateString())return 'Today';
  if(d.toDateString()===yesterday.toDateString())return 'Yesterday';
  return d.toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});
}
function duration(s:Summary){
  if(!s.endedAt)return 'in progress';
  // Wall time across every leg (direct thread lines, reconnects); older entries only have their timestamps.
  const secs=Math.max(s.seconds||0,Math.round((Date.parse(s.endedAt)-Date.parse(s.startedAt))/1000),0);
  return secs<60?`${secs} s`:`${Math.round(secs/60)} min`;
}
function byDay<T>(rows:T[],at:(row:T)=>string){
  const groups:{day:string;rows:T[]}[]=[];
  for(const row of rows){const d=day(at(row));const last=groups.at(-1);if(last?.day===d)last.rows.push(row);else groups.push({day:d,rows:[row]});}
  return groups;
}

export function NotebookView(){
  const rpc=useRpc(),navigate=useBbNavigate();
  const [tab,setTab]=useState<'conversations'|'notes'>('conversations');
  const [sessions,setSessions]=useState<Summary[]|null>(null);
  const [notes,setNotes]=useState<Thought[]|null>(null);
  const [open,setOpen]=useState<Record<string,Session|'loading'|'failed'>>({});
  const [confirm,setConfirm]=useState<string|null>(null);
  const [error,setError]=useState('');
  // Bumped on every reload so expanded conversations close and fetch their (possibly scrubbed) text again.
  const [version,setVersion]=useState(0);
  async function load(){
    setError('');
    try {
      const [book,thoughts]=await Promise.all([rpc.call('notebook',{op:'list',limit:200}),rpc.call('thought',{op:'list',limit:200})]) as any[];
      setSessions(book?.sessions??[]);setNotes(thoughts?.thoughts??[]);setOpen({});setVersion(v=>v+1);
    } catch { setError('Could not load the notebook. Try Refresh.'); setSessions(s=>s??[]); setNotes(n=>n??[]); }
  }
  useEffect(()=>{void load();},[]);
  async function expand(id:string,isOpen:boolean){
    if(!isOpen||open[id])return;
    setOpen(o=>({...o,[id]:'loading'}));
    try {const r=await rpc.call('notebook',{op:'get',id}) as any;setOpen(o=>({...o,[id]:r?.session??'failed'}));}
    catch {setOpen(o=>({...o,[id]:'failed'}));}
  }
  async function remove(id:string){
    setConfirm(null);setError('');
    try {
      await rpc.call('thought',{op:'delete',id});
    } catch { setError('That note could not be deleted. Nothing changed.'); return; }
    setNotes(n=>(n??[]).filter(t=>t.id!==id));
    // The server also scrubbed it from the transcripts it was captured in; reload so none shows it.
    await load();
  }
  return <div className="ttbb-book">
    <div className="ttbb-book-tabs" role="tablist">
      <button role="tab" aria-selected={tab==='conversations'} className={tab==='conversations'?'is-on':''} onClick={()=>setTab('conversations')}>Conversations{sessions?` (${sessions.length})`:''}</button>
      <button role="tab" aria-selected={tab==='notes'} className={tab==='notes'?'is-on':''} onClick={()=>setTab('notes')}>Notes{notes?` (${notes.length})`:''}</button>
      <button className="ttbb-book-refresh" onClick={()=>void load()}>Refresh</button>
    </div>
    {error?<p className="ttbb-note ttbb-book-error" role="status">{error}</p>:null}
    {tab==='conversations'?<div className="ttbb-book-list" aria-label="Conversations">
      {sessions===null?<p className="ttbb-note">Loading…</p>:!sessions.length?<p className="ttbb-note">No conversations yet. Every call from the panel, Walk, Hey BB and check-ins is kept here for 30 days.</p>:null}
      {byDay(sessions??[],s=>s.startedAt).map(g=><section key={g.day}><h3>{g.day}</h3>
        {g.rows.map(s=>{const detail=open[s.id];return <details key={`${s.id}:${version}`} className="ttbb-book-session" onToggle={e=>void expand(s.id,(e.currentTarget as HTMLDetailsElement).open)}>
          <summary><span className="ttbb-book-meta">{time(s.startedAt)} · {SURFACE[s.surface]??s.surface} · {duration(s)}{s.actionCount?` · ${s.actionCount} action${s.actionCount===1?'':'s'}`:''}{s.noteCount?` · ${s.noteCount} note${s.noteCount===1?'':'s'}`:''}</span>
            <span className="ttbb-book-preview">{s.preview||'(nothing was said)'}</span></summary>
          {detail==='loading'||!detail?<p className="ttbb-note">Loading…</p>:detail==='failed'?<p className="ttbb-note">Could not load this conversation.</p>:<div className="ttbb-book-body">
            {detail.turns.map((t,i)=><div className={`ttbb-caption ${t.speaker==='thread'?'worker':t.speaker}`} key={i}><span>{t.threadId
              ?<button className="ttbb-speaker-link" title="Open this thread" onClick={()=>navigate.toThread(t.threadId!)}>{t.label??'Thread'}</button>
              :t.label??SPEAKER[t.speaker]??t.speaker}{t.typed?' · typed':''}{t.noteId&&!t.noteDeleted?' · saved as a note':''}</span><p>{t.text}</p></div>)}
            {detail.truncated?<p className="ttbb-note">The rest of this conversation was too long to keep.</p>:null}
            {detail.actions.length?<div className="ttbb-sources ttbb-actions"><strong>Actions</strong><div>{detail.actions.map(a=><button key={a.id} disabled={!a.threadId} onClick={()=>a.threadId&&navigate.toThread(a.threadId)}><span>{a.title}</span><small>{a.kind==='worker-line'?'direct line · ':''}{a.status.replaceAll('-',' ')}{a.workerState?` · Agent ${a.workerState.replaceAll('-',' ')}`:''}{a.model?` · ${a.model}`:''}</small></button>)}</div></div>:null}
            {detail.notes.length?<div className="ttbb-sources"><strong>Notes from this call</strong><div>{detail.notes.map(n=><small key={n.id}>{n.deleted?'(deleted)':n.text}</small>)}</div></div>:null}
          </div>}
        </details>;})}
      </section>)}
    </div>:<div className="ttbb-book-list" aria-label="Notes">
      {notes===null?<p className="ttbb-note">Loading…</p>:!notes.length?<p className="ttbb-note">No notes. Say “thought bubble” or “write this down” in a call, or use Siri, to capture one.</p>:null}
      {byDay(notes??[],n=>n.capturedAt??n.at).map(g=><section key={g.day}><h3>{g.day}</h3>
        {g.rows.map(n=><div key={n.id} className="ttbb-book-thought">
          <p>{n.text}</p>
          <div><small>{time(n.capturedAt??n.at)} · {VIA[n.capturedVia]??n.capturedVia}</small>
            {confirm===n.id?<span className="ttbb-book-confirm">Delete this note? <button className="ttbb-book-danger" onClick={()=>void remove(n.id)}>Delete</button><button onClick={()=>setConfirm(null)}>Cancel</button></span>
              :<button aria-label={`Delete note: ${n.text.slice(0,60)}`} onClick={()=>setConfirm(n.id)}>Delete</button>}</div>
        </div>)}
      </section>)}
    </div>}
  </div>;
}
