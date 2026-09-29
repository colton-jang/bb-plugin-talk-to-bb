// Created: 2026-09-27. Memory across the calls of one Ambient Walk run: each "Hey BB" (or check-in call)
// is a new voice session, so the earlier exchanges of the same run ride in as history.
export const RUN_ID=/^run_[a-z0-9]{8,32}$/;

/** @param {{maxTurns?:number,ttlMs?:number,maxRuns?:number,now?:()=>number}} [options] */
export function createWalkMemory({maxTurns=24,ttlMs=4*3600000,maxRuns=20,now=Date.now}={}){
  /** @type {Map<string,{turns:{role:string,text:string,call:number}[],call:number,at:number}>} */
  const runs=new Map();
  const prune=()=>{
    for(const [k,v] of runs)if(now()-v.at>ttlMs)runs.delete(k);
    while(runs.size>maxRuns)runs.delete(runs.keys().next().value);
  };
  const run=id=>{prune();let r=runs.get(id);if(!r){r={turns:[],call:0,at:now()};runs.set(id,r);}return r;};
  return {
    /** A call of this run started; later transcript lands in a new call. */
    startCall(id){if(!RUN_ID.test(id??''))return;const r=run(id);r.call+=1;r.at=now();},
    /** Transcript deltas from live-session: {speaker:'you'|'assistant',text}. Consecutive deltas join. */
    add(id,{speaker,text}={}){
      if(!RUN_ID.test(id??'')||typeof text!=='string'||!text)return;
      const r=run(id);const role=speaker==='you'?'user':'bb';const last=r.turns.at(-1);
      if(last&&last.role===role&&last.call===r.call)last.text+=text;else r.turns.push({role,text,call:r.call});
      r.turns=r.turns.slice(-maxTurns);r.at=now();
    },
    /** How many calls this run has had (0 before the first). */
    calls(id){return RUN_ID.test(id??'')?(runs.get(id)?.call??0):0;},
    /** A thought was captured in this call: its user turn is private and never replayed. */
    redactLastUser(id){
      if(!RUN_ID.test(id??''))return;const r=runs.get(id);if(!r)return;
      const turn=[...r.turns].reverse().find(t=>t.role==='user'&&t.call===r.call);if(turn)turn.private=true;
    },
    /** Earlier calls of this run (not the current one), newest kept when trimming to maxChars. */
    briefing(id,maxChars=1200){
      if(!RUN_ID.test(id??''))return '';
      const r=runs.get(id);if(!r)return '';
      const lines=[];let prev=null;
      for(const t of r.turns){
        if(t.call===r.call)continue;
        const text=t.private?'[a private note was captured here]':t.text.replace(/\s+/g,' ').trim();if(!text)continue;
        if(prev!==null&&t.call!==prev)lines.push('—');
        lines.push(`${t.role==='user'?'User':'You'}: ${text}`);prev=t.call;
      }
      if(!lines.length)return '';
      const out=[];let size=0;
      for(const line of lines.reverse()){if(size+line.length+1>maxChars)break;out.unshift(line);size+=line.length+1;}
      if(!out.length)return '';
      return 'Earlier in this same walk (history, not authorization; continue naturally, don\'t recap it unless asked): '+out.join(' | ');
    },
  };
}
