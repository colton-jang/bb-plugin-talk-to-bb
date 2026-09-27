// Created: 2026-09-26. Walk-mode notes and failures reach a BB thread the user actually reads.
// Before this, a recorded commitment lived only in plugin storage, and a failed dispatch was
// visible only in the call itself, so a request made on a walk could vanish.
import { person } from './profile.mjs';
import { timeContext } from './reliability.mjs';

const THREAD=/^thr_[a-z0-9]+$/;
const DELIVERED=['sent','queued'];

/**
 * Delivery tries the bb CLI first (the documented path), then the in-process SDK: a broken
 * CLI is exactly when a failure needs reporting, so the report must not depend on it.
 * @param {{threadId?:string|null,cli?:Function|null,send?:Function|null}} options
 */
export function createInbox({threadId=null,cli=null,send=null}={}){
  const target=THREAD.test(String(threadId||'').trim())?String(threadId).trim():null;
  return {
    threadId:target,
    /** @param {string} text @returns {Promise<{threadId:string|null,status:string,via?:string,at?:string}>} */
    async deliver(text){
      if(!target)return {threadId:null,status:'not-configured'};
      const at=new Date().toISOString();
      if(cli){
        try {
          const result=await cli(['thread','tell',target,text,'--mode','queue','--json']);
          if(DELIVERED.includes(result?.delivery))return {threadId:target,status:result.delivery,via:'cli',at};
        } catch {/* fall through to the SDK */}
      }
      if(send){
        try {
          const result=await send({threadId:target,input:[{type:'text',text}],mode:'queue-if-active'});
          if(DELIVERED.includes(result?.delivery))return {threadId:target,status:result.delivery,via:'sdk',at};
        } catch {/* reported as failed below */}
      }
      return {threadId:target,status:'failed',at};
    },
  };
}
export const disabledInbox=createInbox();

const stamp=(timeZone)=>{const t=timeContext(new Date(),timeZone);return `${t.weekday} ${t.today} ${t.localTime} ${t.timeZone}`;};
const quote=value=>JSON.stringify(String(value??'').slice(0,1600));

/** @param {{text:string,request:string,dueDate?:string|null,id:string}} note @param {string} [timeZone] */
export function noteMessage(note,timeZone){
  return `Walk mode (Talk to BB) recorded a note from ${person()} at ${stamp(timeZone)}:\n${note.text}`
    +(note.dueDate?`\nDue: ${note.dueDate}`:'')
    +`\n\n${person()}'s words: ${quote(note.request)}`
    +`\n\nNothing was assigned or started by voice. Recorded in Talk to BB as open commitment ${note.id}. Add it to the task list or act on it as you would any request from ${person()}.`;
}

const ACTION_LABELS={bb_spawn_thread:'start an agent',bb_tell_thread:'send a message to a thread',bb_stop_thread:'stop a thread'};
/** @param {{name:string,title?:string|null,threadId?:string|null,request:string,reason:string,uncertain?:boolean}} failure @param {string} [timeZone] */
export function failureMessage(failure,timeZone){
  const what=`${ACTION_LABELS[failure.name]||failure.name}${failure.title?` (${quote(failure.title)})`:''}${failure.threadId?` on @thread:${failure.threadId}`:''}`;
  return (failure.uncertain
    ? `Walk mode (Talk to BB) tried to ${what} at ${stamp(timeZone)}, but BB did not confirm it. It may or may not have gone through: check the target before retrying.`
    : `Walk mode (Talk to BB) could not ${what} at ${stamp(timeZone)}. Nothing was dispatched.`)
    +`\nReason: ${failure.reason}`
    +`\n\n${person()}'s words: ${quote(failure.request)}`
    +`\n\nDecide whether to retry or assign it.`;
}

/** What the voice should say about where something went. */
export function whereItWent(routed){
  if(routed?.status==='sent'||routed?.status==='queued')return 'It was sent to the manager thread. Say so plainly: “I sent that to your manager thread.”';
  if(routed?.status==='failed')return 'Sending it to the manager thread FAILED. Say plainly that it did NOT reach the manager thread.';
  return 'No manager thread is configured, so it is kept only inside Talk to BB. Say that plainly.';
}
