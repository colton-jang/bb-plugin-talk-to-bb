// @vitest-environment jsdom
// Created: 2026-09-15. Verify microphone and floating-panel lifecycle.
import { afterEach, expect, test, vi } from 'vitest';
import { act, fireEvent, cleanup } from '@testing-library/react';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';

afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});

test('sidebar control opens panel; denied microphone never opens a voice connection',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const socket=vi.fn();vi.stubGlobal('WebSocket',socket);
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockRejectedValue(new DOMException('Denied','NotAllowedError'))}});
  const slot=renderSlot(app.appOverlays[0],{});
  expect(app.experimentalSidebarFooterItems[0].label).toBe('Talk to BB');
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  fireEvent.click(slot.getByRole('button',{name:'Start talking'}));
  await slot.findByText(/Microphone blocked/);
  expect(socket).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
});

test('live panel survives minimization and thread navigation; pause, quiet, and end release the right resources',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const track={enabled:true,stop:vi.fn()};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
  const audioClose=vi.fn().mockResolvedValue(undefined),workletPost=vi.fn();
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=audioClose;createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:workletPost,onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  let ws:any;
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){ws=this;}
  });
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_a',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});
  expect(JSON.parse(ws.send.mock.calls[0][0]).context.threadId).toBe('thr_a');
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'ui-action',kind:'focus-thread',id:'focus1',threadId:'thr_a'})}));
  expect(ws.send.mock.calls.map((c:any)=>JSON.parse(c[0]))).toContainEqual({type:'ui-result',id:'focus1',threadId:'thr_a',ok:true});
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'action',receipt:{id:'act1',kind:'bb_spawn_thread',status:'started',title:'Delegated task',threadId:'thr_worker',model:'claude-opus-5[1m]'}})}));
  expect(slot.getByText('Delegated task')).toBeTruthy();
  fireEvent.click(slot.getByRole('button',{name:'Pause mic'}));expect(track.enabled).toBe(false);
  fireEvent.click(slot.getByRole('button',{name:'Resume mic'}));expect(track.enabled).toBe(true);
  fireEvent.click(slot.getByRole('button',{name:'Quiet'}));expect(workletPost).toHaveBeenCalledWith({type:'flush'});
  fireEvent.click(slot.getByRole('button',{name:'Minimize Talk to BB'}));
  expect(slot.queryByRole('dialog')).toBeNull();expect(track.stop).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole('button',{name:/Talk to BB · live/}));
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'lookup',state:'done',sources:[{id:'thr_b',title:'Another project thread',read:true}]})}));
  fireEvent.click(slot.getByText('Another project thread'));
  expect(slot.inspection.navigateCalls).toContainEqual({method:'toThread',threadId:'thr_b'});
  expect(track.stop).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole('button',{name:'End'}));
  expect(track.stop).toHaveBeenCalledOnce();expect(audioClose).toHaveBeenCalledOnce();expect(ws.close).toHaveBeenCalledOnce();
  expect(slot.getByText('Microphone off')).toBeTruthy();
  slot.lifecycle.unmount();
});

// Created: 2026-09-15. Shared screen context: the indicator must never outrun the capture.
const SHARED_FRAME='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2Q==';

function stubDisplayRendering(){
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype,'readyState','get').mockReturnValue(4);
  vi.spyOn(HTMLVideoElement.prototype,'videoWidth','get').mockReturnValue(2560);
  vi.spyOn(HTMLVideoElement.prototype,'videoHeight','get').mockReturnValue(1440);
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:vi.fn()} as any);
  vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue(SHARED_FRAME);
}

async function liveSession(getDisplayMedia:any){
  const app=await loadPluginApp(()=>import('../app'));
  const posted:any[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{
    posted.push({url:String(url),method:init.method,contentType:init.headers['Content-Type'],
      credentials:init.credentials,body:JSON.parse(init.body)});
    return {ok:true,status:200};
  }));
  const micTrack={enabled:true,stop:vi.fn()};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{
    getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[micTrack],getAudioTracks:()=>[micTrack]}),getDisplayMedia,
  }});
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:vi.fn(),onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  let ws:any;
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){ws=this;}
  });
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_a',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});
  const sentOfType=(type:string)=>ws.send.mock.calls.map((c:any)=>JSON.parse(c[0])).filter((m:any)=>m.type===type);
  return {slot,ws,sentOfType,posted};
}

test('screen sharing is opt-in, visibly indicated, and released on Stop sharing and End',async()=>{
  stubDisplayRendering();
  const displayTrack={label:'Chrome — Proposal draft',getSettings:()=>({displaySurface:'browser'}),
    stop:vi.fn(),addEventListener:vi.fn()};
  const displayStream={getVideoTracks:()=>[displayTrack],getTracks:()=>[displayTrack]};
  const getDisplayMedia=vi.fn().mockResolvedValue(displayStream);
  const {slot,ws,sentOfType,posted}=await liveSession(getDisplayMedia);

  // Before any selection the panel says plainly that BB cannot see the screen.
  expect(slot.getByText(/BB cannot see your screen/)).toBeTruthy();
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'ui-action',kind:'capture-screen',id:'cap0',reason:'read the error'})}));
  expect(posted.at(-1)).toMatchObject({url:'/api/v1/plugins/talk-to-bb/http/frame',method:'POST',
    contentType:'application/json',credentials:'same-origin',
    body:{type:'screen-frame',id:'cap0',ok:false,reason:'not-sharing'}});
  expect(sentOfType('screen-frame')).toEqual([]);
  expect(getDisplayMedia).not.toHaveBeenCalled();

  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Share screen'})));
  expect(getDisplayMedia).toHaveBeenCalledOnce();
  expect(slot.getByText(/Sharing your browser tab — Chrome — Proposal draft/)).toBeTruthy();
  expect(slot.getByText(/has taken none yet/)).toBeTruthy();
  expect(sentOfType('screen-share')[0].share).toMatchObject({active:true,surface:'browser',label:'Chrome — Proposal draft'});

  await act(async()=>ws.onmessage({data:JSON.stringify({type:'ui-action',kind:'capture-screen',id:'cap1',reason:'read the error'})}));
  const frame=posted.at(-1).body;
  expect(frame).toMatchObject({id:'cap1',ok:true,image:SHARED_FRAME,surface:'browser',width:1152});
  expect(typeof frame.capturedAt).toBe('string');
  // The image must never appear on the voice socket.
  expect(JSON.stringify(ws.send.mock.calls)).not.toContain('data:image/');
  expect(sentOfType('screen-frame')).toEqual([]);
  expect(slot.getByText(/1 so far/)).toBeTruthy();

  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Stop sharing'})));
  expect(displayTrack.stop).toHaveBeenCalledOnce();
  expect(slot.queryByText(/Sharing your browser tab/)).toBeNull();
  expect(slot.getByText(/BB cannot see your screen/)).toBeTruthy();
  expect(sentOfType('screen-share').at(-1).share.active).toBe(false);
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'ui-action',kind:'capture-screen',id:'cap2',reason:'again'})}));
  expect(posted.at(-1).body).toEqual({type:'screen-frame',id:'cap2',ok:false,reason:'not-sharing'});

  // Sharing again then ending the call must release the display track with the microphone.
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Share screen'})));
  fireEvent.click(slot.getByRole('button',{name:'End'}));
  expect(displayTrack.stop).toHaveBeenCalledTimes(2);
  expect(slot.queryByRole('button',{name:'Stop sharing'})).toBeNull();
  slot.lifecycle.unmount();
});

test('a cancelled screen picker leaves the panel saying BB still cannot see the screen',async()=>{
  stubDisplayRendering();
  const getDisplayMedia=vi.fn().mockRejectedValue(new DOMException('Denied','NotAllowedError'));
  const {slot,ws,sentOfType,posted}=await liveSession(getDisplayMedia);
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Share screen'})));
  expect(slot.getByText(/Screen sharing was not started/)).toBeTruthy();
  expect(slot.queryByText(/Sharing your/)).toBeNull();
  expect(slot.queryByRole('button',{name:'Stop sharing'})).toBeNull();
  expect(sentOfType('screen-share')).toEqual([]);
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'ui-action',kind:'capture-screen',id:'cap1',reason:'look'})}));
  expect(posted.at(-1).body).toEqual({type:'screen-frame',id:'cap1',ok:false,reason:'not-sharing'});
  expect(sentOfType('screen-frame')).toEqual([]);
  slot.lifecycle.unmount();
});

test('a host that cannot open a picker says so instead of printing the platform string',async()=>{
  stubDisplayRendering();
  // What the BB desktop app actually does: the API is present, and Chromium rejects
  // because the Electron shell registers no display-media request handler.
  const getDisplayMedia=vi.fn().mockRejectedValue(new DOMException('Not supported','NotSupportedError'));
  const {slot,ws,sentOfType,posted}=await liveSession(getDisplayMedia);
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Share screen'})));
  expect(getDisplayMedia).toHaveBeenCalled();
  // The bare platform string is what the user reported; it must never reach them.
  expect(slot.queryByText('Not supported')).toBeNull();
  expect(slot.getByText(/cannot open a screen picker/)).toBeTruthy();
  expect(slot.getByText(/browser tab/)).toBeTruthy();
  // A refused start is still not sharing: no indicator, no capture, no state drift.
  expect(slot.queryByText(/Sharing your/)).toBeNull();
  expect(slot.queryByRole('button',{name:'Stop sharing'})).toBeNull();
  expect(sentOfType('screen-share')).toEqual([]);
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'ui-action',kind:'capture-screen',id:'cap1',reason:'look'})}));
  expect(posted.at(-1).body).toEqual({type:'screen-frame',id:'cap1',ok:false,reason:'not-sharing'});
  expect(sentOfType('screen-frame')).toEqual([]);
  slot.lifecycle.unmount();
});

test('the review toggle is a third, separate control; notes render and held updates release on request',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const track={enabled:true,stop:vi.fn()};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:vi.fn(),onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  let ws:any;
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){ws=this;}
  });
  const sent=()=>ws.send.mock.calls.map((c:any)=>JSON.parse(c[0]));
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_proposal',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});

  // Pause mic, Quiet and Review are three distinct controls.
  expect(slot.getByRole('button',{name:'Pause mic'})).toBeTruthy();
  expect(slot.getByRole('button',{name:'Quiet'})).toBeTruthy();
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Review'})));
  expect(sent()).toContainEqual({type:'review',on:true});
  expect(sent().some((m:any)=>m.type==='mute')).toBe(false);

  await act(async()=>ws.onmessage({data:JSON.stringify({type:'review',state:{active:true,topic:'the proposal',held:2,noteCount:2,awaiting:[],
    notes:[{seq:1,kind:'comment',text:'The intro spends too long on methodology',anchor:null,adopted:['Cut it to two lines']},
           {seq:2,kind:'decision',text:'We are not naming the pilot work',anchor:null,adopted:[]}]}})}));
  expect(slot.getByText(/Review mode · the proposal/)).toBeTruthy();
  expect(slot.getByText('1. The intro spends too long on methodology')).toBeTruthy();
  expect(slot.getByText('adopted instead: Cut it to two lines')).toBeTruthy();
  expect(slot.getByText(/2 agent updates held/)).toBeTruthy();
  expect(slot.getByText(/Review on/)).toBeTruthy();

  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Show updates'})));
  expect(sent()).toContainEqual({type:'review-drain'});

  // Muting audio while reviewing must not end the review.
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Quiet'})));
  expect(slot.getByRole('button',{name:'End review'})).toBeTruthy();
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'End review'})));
  expect(sent()).toContainEqual({type:'review',on:false});
  expect(track.stop).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
});

test('the panel warns before the cap and shows what carried over without replaying it',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const track={enabled:true,stop:vi.fn()};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:vi.fn(),onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  let ws:any;
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){ws=this;}
  });
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_a',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'resume',summary:{endedAt:'2026-09-16T04:04:00.000Z',reason:'time-limit',
    unfinished:'actually make that seven thirty and',commitments:['Send Sam the budget number'],
    unresolved:[{title:'Move the Thursday block',status:'uncertain',threadId:null}],
    note:'Nothing was resumed automatically. Restate anything you still want done.'}})}));
  expect(slot.getByText(/seven thirty/)).toBeTruthy();
  expect(slot.getByText(/Send Sam the budget number/)).toBeTruthy();
  expect(slot.getByText(/Move the Thursday block \(uncertain\)/)).toBeTruthy();
  expect(slot.getByText(/Nothing was resumed automatically/)).toBeTruthy();
  const beforeNotice=ws.send.mock.calls.length;
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'notice',kind:'time-remaining',text:'About 5 minutes left in this voice session.'})}));
  expect(slot.getByText(/About 5 minutes left/)).toBeTruthy();
  expect(slot.getByText(/Nothing continues on its own/)).toBeTruthy();
  expect(ws.send.mock.calls.length).toBe(beforeNotice);
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'closed',seconds:1200,reason:'time-limit'})}));
  expect(slot.getByText(/Twenty-minute limit reached \(1200 seconds\)/)).toBeTruthy();
  expect(slot.queryByText(/About 5 minutes left/)).toBeNull();
  expect(track.stop).toHaveBeenCalledOnce();
  slot.lifecycle.unmount();
});

test('a review restored from the previous session is visible in the panel, not implied',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const track={enabled:true,stop:vi.fn()};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:vi.fn(),onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  let ws:any;
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){ws=this;}
  });
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_a',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});
  // The server restores the mode and says so; the panel must show both, not one.
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'review',state:{active:true,topic:'the Acme proposal',
    notes:[{seq:1,kind:'correction',text:'The pricing table is too dense',anchor:null,adopted:[]}],noteCount:1,held:2,awaiting:[]}})}));
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'resume',summary:{endedAt:'2026-09-16T04:04:00.000Z',reason:'time-limit',
    unfinished:null,commitments:[],unresolved:[],openReview:{topic:'the Acme proposal',noteCount:1,restored:true},
    note:'Nothing was resumed automatically. Restate anything you still want done.'}})}));
  expect(slot.getByText(/Review mode · the Acme proposal/)).toBeTruthy();
  expect(slot.getByText(/Review reopened:/)).toBeTruthy();
  expect(slot.getByText(/agent actions are blocked again until you end it/)).toBeTruthy();
  expect(slot.getByText(/1\. The pricing table is too dense/)).toBeTruthy();
  expect(slot.getByText(/2 agent updates held/)).toBeTruthy();
  expect(slot.getByRole('button',{name:'End review'})).toBeTruthy();
  slot.lifecycle.unmount();
});

// Created 2026-09-27: the walk handoff at the connection limit.
function liveHarness(){
  const track={enabled:true,stop:vi.fn()};
  const getUserMedia=vi.fn().mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]});
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia}});
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:vi.fn(),onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  const sockets:any[]=[];
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){sockets.push(this);}
  });
  return {sockets,getUserMedia};
}
const HANDOFF_ID='11111111-2222-3333-4444-555555555555';

test('at the connection limit the panel reconnects by itself and keeps the transcript',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const {sockets}=liveHarness();
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_a',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{sockets[0].onopen();sockets[0].onmessage({data:JSON.stringify({type:'ready'})});});
  await act(async()=>sockets[0].onmessage({data:JSON.stringify({type:'transcript',speaker:'you',text:'about the Ascend budget'})}));
  await act(async()=>sockets[0].onmessage({data:JSON.stringify({type:'closed',seconds:3300,reason:'handoff',limitMinutes:55,
    handoff:{token:HANDOFF_ID,leg:2,expiresAt:new Date(Date.now()+600000).toISOString()}})}));
  expect(sockets.length).toBe(2);
  await act(async()=>sockets[1].onopen());
  expect(JSON.parse(sockets[1].send.mock.calls[0][0])).toMatchObject({type:'start',handoff:HANDOFF_ID});
  expect(slot.getByText('about the Ascend budget')).toBeTruthy();
  await act(async()=>{sockets[1].onmessage({data:JSON.stringify({type:'ready'})});
    sockets[1].onmessage({data:JSON.stringify({type:'resume',summary:{handoff:true,leg:2,parked:1,sent:2,inProgress:1}})});});
  expect(slot.getByText(/Walk continued \(part 2\)\. Carried over: 1 parked, 2 sent, 1 in progress\./)).toBeTruthy();
  expect(slot.queryByText(/Nothing continues on its own/)).toBeNull();
  expect(slot.queryByRole('button',{name:'Continue walk'})).toBeNull();
  slot.lifecycle.unmount();
});

test('if the automatic reconnect fails, one Continue walk button retries with the same token',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const {sockets}=liveHarness();
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:null,projectId:null}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{sockets[0].onopen();sockets[0].onmessage({data:JSON.stringify({type:'ready'})});});
  await act(async()=>sockets[0].onmessage({data:JSON.stringify({type:'closed',seconds:1200,reason:'handoff',limitMinutes:20,
    handoff:{token:HANDOFF_ID,leg:2,expiresAt:new Date(Date.now()+600000).toISOString()}})}));
  await act(async()=>sockets[1].onerror());
  expect(slot.getByText(/Could not reconnect automatically.*Press Continue walk/)).toBeTruthy();
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Continue walk'})));
  await act(async()=>sockets[2].onopen());
  expect(JSON.parse(sockets[2].send.mock.calls[0][0])).toMatchObject({type:'start',handoff:HANDOFF_ID});
  slot.lifecycle.unmount();
});

test('a plain limit names the configured length; a provider expiry says so',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const {sockets}=liveHarness();
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:null,projectId:null}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{sockets[0].onopen();sockets[0].onmessage({data:JSON.stringify({type:'ready'})});});
  await act(async()=>sockets[0].onmessage({data:JSON.stringify({type:'closed',seconds:2700,reason:'time-limit',limitMinutes:45})}));
  expect(slot.getByText(/45-minute limit reached \(2700 seconds\)/)).toBeTruthy();
  expect(slot.queryByRole('button',{name:'Continue walk'})).toBeNull();
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{sockets[1].onopen();sockets[1].onmessage({data:JSON.stringify({type:'ready'})});});
  await act(async()=>sockets[1].onmessage({data:JSON.stringify({type:'closed',seconds:3600,reason:'provider-expired'})}));
  expect(slot.getByText(/voice service ended the session at its own time limit/)).toBeTruthy();
  slot.lifecycle.unmount();
});

test('a responsiveness cue updates the status line and the tool result replaces it',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const track={enabled:true,stop:vi.fn()};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:vi.fn(),onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  let ws:any;
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){ws=this;}
  });
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_a',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'lookup',state:'reading',name:'bb_spawn_thread',sources:[]})}));
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'cue',kind:'dispatch',text:'Starting the agent (not confirmed yet) · 8s',spoken:false})}));
  expect(slot.getByText('Starting the agent (not confirmed yet) · 8s')).toBeTruthy();
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'lookup',state:'done',name:'bb_spawn_thread',sources:[]})}));
  expect(slot.queryByText(/not confirmed yet/)).toBeNull();
  expect(slot.getByText('Action receipt received')).toBeTruthy();
  fireEvent.click(slot.getByRole('button',{name:'End'}));
  slot.lifecycle.unmount();
});

// Created: 2026-09-27. Direct-worker voice mode in the panel.
test('the panel opens a direct line to the selected thread, labels its voice, and has a way back',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const track={enabled:true,stop:vi.fn()};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
  vi.stubGlobal('AudioContext',class {
    sampleRate=16000;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
    resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);createMediaStreamSource=()=>({connect:vi.fn()});
  });
  vi.stubGlobal('AudioWorkletNode',class {port={postMessage:vi.fn(),onmessage:null};connect=vi.fn();disconnect=vi.fn();});
  let ws:any;
  vi.stubGlobal('WebSocket',class {
    readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;
    constructor(){ws=this;}
  });
  const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:'thr_pocket',projectId:'proj_a'}});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
  await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});
  const sent=()=>ws.send.mock.calls.map((c:any)=>JSON.parse(c[0]));
  fireEvent.click(slot.getByRole('button',{name:'Talk to this thread'}));
  expect(sent()).toContainEqual({type:'worker-start',threadId:'thr_pocket'});
  const target={threadId:'thr_pocket',title:'pocket-ios: build milestone 1'};
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'leg',mode:'switching',to:'worker',target,voice:'cedar'})}));
  expect(slot.getByText(/Handing you to pocket-ios/)).toBeTruthy();
  await act(async()=>{ws.onmessage({data:JSON.stringify({type:'ready'})});ws.onmessage({data:JSON.stringify({type:'leg',mode:'worker',target,voice:'cedar'})});});
  expect(slot.getByText(/Direct line to pocket-ios: build milestone 1/)).toBeTruthy();
  expect(slot.getByText(/Talking directly to pocket-ios/)).toBeTruthy();
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'transcript',speaker:'assistant',text:'You are talking to the build thread.',leg:'worker',...target})}));
  const captions=()=>[...slot.getByLabelText('Conversation transcript').querySelectorAll('.ttbb-caption')].map(c=>[c.querySelector('span')!.textContent,c.querySelector('p')!.textContent]);
  expect(captions()).toEqual([['pocket-ios: build milestone 1','You are talking to the build thread.']]);
  fireEvent.click(slot.getByRole('button',{name:'Back to manager'}));
  expect(sent()).toContainEqual({type:'worker-return'});
  // The line's goodbye, sent while switching back, is still the thread's; the manager's words after it are BB's.
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'transcript',speaker:'assistant',text:' Taking you back.',leg:'worker',...target})}));
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'leg',mode:'manager',target,voice:'marin',from:'worker'})}));
  await act(async()=>ws.onmessage({data:JSON.stringify({type:'transcript',speaker:'assistant',text:'Back with you.'})}));
  expect(captions()).toEqual([['pocket-ios: build milestone 1','You are talking to the build thread. Taking you back.'],['BB','Back with you.']]);
  expect(slot.queryByText(/Direct line to/)).toBeNull();
  expect(slot.getByText('Back with the manager.')).toBeTruthy();
  expect(slot.getByRole('button',{name:'Talk to this thread'})).toBeTruthy();
  expect(track.stop).not.toHaveBeenCalled();
  slot.lifecycle.unmount();
});

// Created 2026-09-27: network switch (Wi-Fi -> 5G). A socket that dies mid-call is a drop, not an end.
test('a dropped connection retries by itself, reconnects when the network returns, and falls back to one Reconnect button',async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});
  try {
    const app=await loadPluginApp(()=>import('../app'));
    const {sockets}=liveHarness();
    const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:null,projectId:null}});
    await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
    await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
    await act(async()=>{sockets[0].onopen();sockets[0].onmessage({data:JSON.stringify({type:'ready'})});});
    await act(async()=>{vi.advanceTimersByTime(5100);});
    expect(sockets[0].send.mock.calls.map((c:any)=>JSON.parse(c[0]))).toContainEqual({type:'ping'});
    await act(async()=>sockets[0].onmessage({data:JSON.stringify({type:'transcript',speaker:'you',text:'the Ascend budget'})}));
    // Wi-Fi -> 5G: the socket just dies.
    await act(async()=>sockets[0].onclose());
    expect(slot.getByText(/Connection lost\. Reconnecting… \(try 1 of 4\)/)).toBeTruthy();
    expect(slot.getByText('the Ascend budget')).toBeTruthy();
    await act(async()=>{vi.advanceTimersByTime(2100);});
    expect(sockets.length).toBe(2);
    await act(async()=>sockets[1].onopen());
    expect(JSON.parse(sockets[1].send.mock.calls[0][0]).type).toBe('start');
    // The server still sees the old call as live for a moment and refuses: that is a retry, not an end.
    await act(async()=>sockets[1].onmessage({data:JSON.stringify({type:'fault',message:'A voice call is already live in another tab or device.'})}));
    expect(slot.getByText(/try 2 of 4/)).toBeTruthy();
    // The phone comes back online: reconnect now, without waiting for the timer.
    await act(async()=>{window.dispatchEvent(new Event('online'));});
    expect(sockets.length).toBe(3);
    // Every remaining try fails -> one Reconnect button.
    await act(async()=>sockets[2].onerror());
    await act(async()=>{vi.advanceTimersByTime(8100);});
    await act(async()=>sockets[3].onerror());
    await act(async()=>{vi.advanceTimersByTime(15100);});
    await act(async()=>sockets[4].onerror());
    expect(slot.getByText(/Connection lost\. Press Reconnect to continue your walk\./)).toBeTruthy();
    await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Reconnect'})));
    await act(async()=>{sockets[5].onopen();sockets[5].onmessage({data:JSON.stringify({type:'ready'})});});
    expect(slot.queryByRole('button',{name:'Reconnect'})).toBeNull();
    expect(slot.getByText('the Ascend budget')).toBeTruthy();
    slot.lifecycle.unmount();
  } finally { vi.useRealTimers(); }
});

// Created 2026-09-27: the soft "still working" sound is played by the panel, never the voice model.
test('the panel plays the soft working sound only while the server says so, and stops on speech, Quiet and end',async()=>{
  vi.useFakeTimers({shouldAdvanceTime:true});
  try {
    const app=await loadPluginApp(()=>import('../app'));
    const oscillators:any[]=[];
    const param=()=>({setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),exponentialRampToValueAtTime:vi.fn()});
    const track={enabled:true,stop:vi.fn()};
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn().mockResolvedValue({getTracks:()=>[track],getAudioTracks:()=>[track]})}});
    vi.stubGlobal('AudioContext',class {
      sampleRate=16000;state='running';currentTime=0;audioWorklet={addModule:vi.fn().mockResolvedValue(undefined)};destination={};
      resume=vi.fn().mockResolvedValue(undefined);close=vi.fn().mockResolvedValue(undefined);createMediaStreamSource=()=>({connect:vi.fn()});
      createOscillator(){const o={type:'',frequency:param(),connect:vi.fn(),start:vi.fn(),stop:vi.fn()};oscillators.push(o);return o;}
      createGain(){return {gain:param(),connect:vi.fn()};}
    });
    vi.stubGlobal('AudioWorkletNode',class {port={postMessage:vi.fn(),onmessage:null};connect=vi.fn();disconnect=vi.fn();});
    const sockets:any[]=[];
    vi.stubGlobal('WebSocket',class {readyState=1;bufferedAmount=0;send=vi.fn();close=vi.fn();onopen:any;onmessage:any;onclose:any;onerror:any;constructor(){sockets.push(this);}});
    const slot=renderSlot(app.appOverlays[0],{},{context:{threadId:null,projectId:null}});
    await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
    await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Start talking'})));
    const ws=sockets[0];
    await act(async()=>{ws.onopen();ws.onmessage({data:JSON.stringify({type:'ready'})});});
    await act(async()=>{vi.advanceTimersByTime(3000);});
    expect(oscillators.length).toBe(0);
    await act(async()=>ws.onmessage({data:JSON.stringify({type:'working',on:true,category:'thinking'})}));
    await act(async()=>{vi.advanceTimersByTime(2000);});
    const bubbles=oscillators.length;
    expect(bubbles).toBeGreaterThanOrEqual(3);
    expect(oscillators[0].type).toBe('sine');
    // The manager starts speaking: the sound stops at once.
    const voice=new Int16Array(320).fill(3000);
    await act(async()=>ws.onmessage({data:new ArrayBuffer(640)}));
    expect(oscillators.length).toBeGreaterThanOrEqual(bubbles);
    await act(async()=>ws.onmessage({data:voice.buffer}));
    const afterVoice=oscillators.length;
    await act(async()=>{vi.advanceTimersByTime(3000);});
    expect(oscillators.length).toBe(afterVoice);
    // Back on, then the server says the work is done.
    await act(async()=>ws.onmessage({data:JSON.stringify({type:'working',on:true})}));
    await act(async()=>ws.onmessage({data:JSON.stringify({type:'working',on:false,reason:'idle'})}));
    const afterOff=oscillators.length;
    await act(async()=>{vi.advanceTimersByTime(3000);});
    expect(oscillators.length).toBe(afterOff);
    // Quiet: no sound even if the server asks.
    fireEvent.click(slot.getByRole('button',{name:'Quiet'}));
    await act(async()=>ws.onmessage({data:JSON.stringify({type:'working',on:true})}));
    await act(async()=>{vi.advanceTimersByTime(3000);});
    expect(oscillators.length).toBe(afterOff);
    fireEvent.click(slot.getByRole('button',{name:'Hear replies'}));
    await act(async()=>ws.onmessage({data:JSON.stringify({type:'working',on:true})}));
    fireEvent.click(slot.getByRole('button',{name:'End'}));
    const atEnd=oscillators.length;
    await act(async()=>{vi.advanceTimersByTime(3000);});
    expect(oscillators.length).toBe(atEnd);
    slot.lifecycle.unmount();
  } finally { vi.useRealTimers(); }
});

// Created: 2026-09-28. The Notebook view: past conversations from every device, and notes with a confirmed delete.
test('Notebook lists conversations by day, opens a transcript with thread links, and deletes a note only after confirming',async()=>{
  const app=await loadPluginApp(()=>import('../app'));
  const now=new Date().toISOString();
  let notes=[{id:'tht_aaaaaaaaaaaaaaaa',text:'Shorter onboarding email',at:now,capturedAt:now,capturedVia:'siri'},
    {id:'tht_bbbbbbbbbbbbbbbb',text:'Keep this one',at:now,capturedAt:now,capturedVia:'voice'}];
  const deleted:string[]=[];
  const slot=renderSlot(app.appOverlays[0],{},{rpc:{
    notebook:(input:any)=>input.op==='list'
      ?{sessions:[{id:'1790000000000-00000000-0000-4000-8000-000000000001',surface:'walk',startedAt:now,endedAt:now,seconds:60,legs:1,turnCount:2,actionCount:1,noteCount:0,truncated:false,preview:'What changed since this morning?'}]}
      :{session:{id:input.id,surface:'walk',startedAt:now,endedAt:now,truncated:false,
        turns:[{speaker:'you',label:'You',text:'What changed since this morning?',at:now},{speaker:'bb',label:'BB',text:'Two agents replied.',at:now},
          {speaker:'thread',label:'Permit renewal',threadId:'thr_permit',link:'@thread:thr_permit',text:'Waiting on the agency.',at:now},{speaker:'bb',label:'BB',text:'Back with the manager.',at:now}],
        actions:[{id:'r1',kind:'bb_tell_thread',status:'sent',title:'Release notes follow-up',threadId:'thr_release',model:null,workerState:null,link:'@thread:thr_release'},
          {id:'line-1',kind:'worker-line',status:'returned',title:'Permit renewal',threadId:'thr_permit',model:null,workerState:null,link:'@thread:thr_permit'}],notes:[]}},
    thought:(input:any)=>{if(input.op==='delete'){deleted.push(input.id);notes=notes.filter(n=>n.id!==input.id);return {id:input.id,deleted:true};}return {thoughts:notes};},
  } as any});
  await act(async()=>window.dispatchEvent(new Event('talk-to-bb:toggle')));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Notebook'})));
  expect(await slot.findByText('Today')).toBeTruthy();
  const preview=await slot.findByText('What changed since this morning?');
  const details=preview.closest('details')!;
  await act(async()=>{details.open=true;details.dispatchEvent(new Event('toggle'));});
  expect(await slot.findByText('Two agents replied.')).toBeTruthy();
  // One continuous transcript: the thread speaks under its (linked) title, the manager as BB, before and after.
  const body=details.querySelector('.ttbb-book-body')!;
  expect([...body.querySelectorAll('.ttbb-caption')].map(c=>c.querySelector('span')!.textContent))
    .toEqual(['You','BB','Permit renewal','BB']);
  fireEvent.click(slot.getByRole('button',{name:'Permit renewal'}));
  expect(slot.inspection.navigateCalls).toContainEqual({method:'toThread',threadId:'thr_permit'});
  expect(slot.getByText('direct line · returned')).toBeTruthy();
  fireEvent.click(slot.getByText('Release notes follow-up'));
  expect(slot.inspection.navigateCalls).toContainEqual({method:'toThread',threadId:'thr_release'});
  await act(async()=>fireEvent.click(slot.getByRole('tab',{name:/Notes/})));
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Delete note: Shorter onboarding email'})));
  expect(deleted).toEqual([]);
  expect(slot.getByText('Delete this note?')).toBeTruthy();
  await act(async()=>fireEvent.click(slot.getByRole('button',{name:'Delete'})));
  expect(deleted).toEqual(['tht_aaaaaaaaaaaaaaaa']);
  await act(async()=>{});
  expect(slot.queryByText('Shorter onboarding email')).toBeNull();
  expect(slot.getByText('Keep this one')).toBeTruthy();
  fireEvent.click(slot.getByRole('button',{name:'Back'}));
  expect(slot.getByRole('button',{name:'Start talking'})).toBeTruthy();
  slot.lifecycle.unmount();
});
