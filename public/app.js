'use strict';

(() => {
  const qs = s => document.querySelector(s);
  const params = new URLSearchParams(location.search);
  const state = {
    socket: null, roomId: params.get('room') || null, name: params.get('name') || '', role: 'student', selfId: null,
    localStream: null, cameraTrack: null, screenTrack: null, peers: new Map(), participants: new Map(), pendingIce: new Map(),
    micOn: true, cameraOn: true, handRaised: false, audioOnly: false, joined: false, intentionalLeave: false, reconnecting: false,
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], selectedQuality: 'auto', statsTimer: null, micContext: null, micAnalyser: null,
    remoteAudio: new Map(), unread: 0, speakerTestTimer: null, facingMode: 'user'
  };

  const els = {
    grid: qs('#videoGrid'), empty: qs('#emptyState'), roomLabel: qs('#roomLabel'), badge: qs('#connectionBadge'),
    overlay: qs('#joinOverlay'), lobbyRoom: qs('#lobbyRoom'), preview: qs('#localPreview'), previewFallback: qs('#previewFallback'),
    lobbyError: qs('#lobbyError'), enter: qs('#enterBtn'), lobbyMic: qs('#lobbyMic'), lobbyCam: qs('#lobbyCam'), lobbyMeter: qs('#lobbyMeter'),
    micBtn: qs('#micBtn'), cameraBtn: qs('#cameraBtn'), flipBtn: qs('#flipBtn'), shareBtn: qs('#shareBtn'), handBtn: qs('#handBtn'), audioOnlyBtn: qs('#audioOnlyBtn'),
    moreBtn: qs('#moreBtn'), moreMenu: qs('#moreMenu'), peopleBtn: qs('#peopleBtn'), chatBtn: qs('#chatBtn'), leaveBtn: qs('#leaveBtn'),
    sidePanel: qs('#sidePanel'), peoplePanel: qs('#peoplePanel'), chatPanel: qs('#chatPanel'), peopleList: qs('#peopleList'), peopleCount: qs('#peopleCount'),
    chatMessages: qs('#chatMessages'), chatForm: qs('#chatForm'), chatInput: qs('#chatInput'), chatUnread: qs('#chatUnread'),
    systemAlert: qs('#systemAlert'), copyRoom: qs('#copyRoom'), inviteBtn: qs('#inviteBtn'), fullscreenBtn: qs('#fullscreenBtn'), pipBtn: qs('#pipBtn'),
    speakerTestBtn: qs('#speakerTestBtn'), restartMediaBtn: qs('#restartMediaBtn'), qualitySelect: qs('#qualitySelect'), hostControls: qs('#hostControls'), lockBtn: qs('#lockBtn'), endBtn: qs('#endBtn'),
    micMeter: qs('#micMeter')
  };

  function showError(text, lobby = false) { const el = lobby ? els.lobbyError : els.systemAlert; el.textContent = text; el.classList.remove('hidden'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.add('hidden'), 7000); }
  function setBadge(text, good = false) { els.badge.textContent = text; els.badge.style.color = good ? '#8ce5ad' : ''; }
  function displayName(p) { return p.id === state.selfId ? `${p.name} (You)` : p.name; }
  function initials(name) { return (name || '?').trim().split(/\s+/).slice(0,2).map(x => x[0]).join('').toUpperCase(); }
  function escapeText(text) { return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  async function loadConfig() { try { const r = await fetch('/config', { cache: 'no-store' }); if (r.ok) { const d = await r.json(); if (Array.isArray(d.iceServers) && d.iceServers.length) state.iceServers = d.iceServers; } } catch {} }

  async function getMedia() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera and microphone APIs are unavailable in this browser.');
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    const video = { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: state.facingMode };
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio, video }); }
    catch (first) {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio, video: false }); state.cameraOn = false; }
      catch (audioErr) {
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video }); state.micOn = false; }
        catch { throw new Error('Camera/microphone permission was denied or no usable device was found. Allow permissions in browser site settings.'); }
      }
    }
    state.localStream?.getTracks().forEach(t => t.stop());
    state.localStream = stream;
    state.cameraTrack = stream.getVideoTracks()[0] || null;
    const mic = stream.getAudioTracks()[0];
    state.micOn = !!mic && mic.enabled;
    state.cameraOn = !!state.cameraTrack && state.cameraTrack.enabled;
    els.preview.srcObject = stream;
    els.previewFallback.classList.toggle('hidden', !!state.cameraTrack);
    startMicMeter(mic);
    updateControls();
    return stream;
  }

  async function restartMedia() {
    try { await getMedia(); for (const [id, pc] of state.peers) { const senders = pc.getSenders(); const at = state.localStream?.getAudioTracks()[0]; const vt = state.localStream?.getVideoTracks()[0]; const as = senders.find(s => s.track?.kind === 'audio'); const vs = senders.find(s => s.track?.kind === 'video'); if (as && at) await as.replaceTrack(at); if (vs && vt) await vs.replaceTrack(vt); } sendMediaState(); }
    catch (e) { showError(e.message); }
  }

  function startMicMeter(track) {
    if (!track || !window.AudioContext) return;
    try {
      state.micContext?.close(); state.micContext = new AudioContext(); const src = state.micContext.createMediaStreamSource(new MediaStream([track])); state.micAnalyser = state.micContext.createAnalyser(); state.micAnalyser.fftSize = 256; src.connect(state.micAnalyser);
      const data = new Uint8Array(state.micAnalyser.fftSize);
      const tick = () => { if (!state.micAnalyser) return; state.micAnalyser.getByteTimeDomainData(data); let sum=0; for(const v of data){const n=(v-128)/128;sum+=n*n} const level=Math.min(1,Math.sqrt(sum/data.length)*3); [...els.lobbyMeter.children].forEach((x,i)=>x.classList.toggle('active', level > (i+1)/5)); [...els.micMeter.querySelectorAll('span')].forEach((x,i)=>x.classList.toggle('active', level > (i+1)/5)); requestAnimationFrame(tick); }; tick();
    } catch {}
  }

  function sendMediaState() { state.socket?.emit('media-state', { micOn: state.micOn, cameraOn: state.cameraOn }); }
  function updateControls() {
    els.micBtn.classList.toggle('off', !state.micOn); els.micBtn.querySelector('small').textContent = state.micOn ? 'Mute' : 'Unmute';
    els.cameraBtn.classList.toggle('off', !state.cameraOn); els.cameraBtn.querySelector('small').textContent = state.cameraOn ? 'Camera' : 'Camera off';
    els.handBtn.classList.toggle('active', state.handRaised); els.audioOnlyBtn.classList.toggle('active', state.audioOnly);
    els.lobbyMic.textContent = state.micOn ? '🎙 Microphone On' : '🔇 Microphone Off'; els.lobbyCam.textContent = state.cameraOn ? '▣ Camera On' : 'Camera Off';
  }

  function setTrackEnabled(kind, enabled) {
    const tracks = state.localStream?.getTracks().filter(t => t.kind === kind) || []; tracks.forEach(t => t.enabled = enabled);
  }
  function toggleMic() { if (!state.localStream?.getAudioTracks().length) return showError('No microphone is available.'); state.micOn = !state.micOn; setTrackEnabled('audio', state.micOn); sendMediaState(); updateControls(); renderPeople(); }
  function toggleCamera() { if (!state.localStream?.getVideoTracks().length) return showError('No camera is available.'); state.cameraOn = !state.cameraOn; setTrackEnabled('video', state.cameraOn); sendMediaState(); updateControls(); renderPeople(); }

  async function flipCamera() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    state.facingMode = state.facingMode === 'user' ? 'environment' : 'user';
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: state.facingMode, width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30,max:30} }, audio:false });
      const newTrack = newStream.getVideoTracks()[0]; if (!newTrack) throw new Error('Camera switch failed.');
      const old = state.localStream.getVideoTracks()[0]; state.localStream.removeTrack(old); old?.stop(); state.localStream.addTrack(newTrack); state.cameraTrack = newTrack; els.preview.srcObject = state.localStream;
      for (const pc of state.peers.values()) { const sender = pc.getSenders().find(s => s.track?.kind === 'video'); if (sender) await sender.replaceTrack(newTrack); }
      state.cameraOn = true; sendMediaState(); updateControls();
    } catch { state.facingMode = state.facingMode === 'user' ? 'environment' : 'user'; showError('Camera flip is not supported or permission was blocked.'); }
  }

  function connectSocket() {
    state.socket = io({ transports: ['websocket','polling'], reconnection: true, reconnectionAttempts: Infinity, timeout: 10000 });
    const s = state.socket;
    s.on('connect', () => { state.selfId = s.id; setBadge('Connected', true); if (!state.joined) joinOrCreate(); else recoverAfterReconnect(); });
    s.on('disconnect', reason => { if (!state.intentionalLeave) { state.reconnecting = true; setBadge('Reconnecting…'); showError(`Connection interrupted (${reason}). Trying to reconnect…`); } });
    s.on('connect_error', () => setBadge('Connection error'));
    s.on('room-created', room => applyRoom(room));
    s.on('room-state', room => applyRoom(room));
    s.on('participant-joined', p => { state.participants.set(p.id,p); renderPeople(); renderGrid(); if (state.joined) ensurePeer(p.id, true); });
    s.on('participant-left', ({id}) => removeParticipant(id));
    s.on('media-state', ({id,micOn,cameraOn}) => { const p=state.participants.get(id); if(p){p.micOn=micOn;p.cameraOn=cameraOn;renderPeople();renderGrid();} });
    s.on('hand-raised', ({id,raised}) => { const p=state.participants.get(id); if(p){p.handRaised=raised;renderPeople();renderGrid();} });
    s.on('host-changed', ({hostId}) => { state.role = hostId === state.selfId ? 'teacher' : 'student'; updateHostUI(); renderPeople(); });
    s.on('meeting-locked', ({locked}) => { showError(locked ? 'Meeting locked. New participants cannot join.' : 'Meeting unlocked.'); updateHostUI(); });
    s.on('meeting-ended', ({message}) => finishToHome(message || 'Meeting ended by host.'));
    s.on('participant-removed', ({message}) => finishToHome(message || 'You were removed.'));
    s.on('chat-message', msg => addChat(msg));
    s.on('offer', data => handleOffer(data));
    s.on('answer', data => handleAnswer(data));
    s.on('ice-candidate', data => handleIce(data));
  }

  function joinOrCreate() {
    if (params.get('new') === '1') state.socket.emit('create-room', { name: state.name }, res => { if(res && !res.ok) showError(res.error); });
    else if (state.roomId) state.socket.emit('join-room', { roomId: state.roomId, name: state.name }, res => { if(!res?.ok){ showError(res?.error || 'Could not join room.', true); return; } state.selfId=res.selfId; state.role='student'; applyRoom(res.room); for(const p of res.existing || []){ state.participants.set(p.id,p); ensurePeer(p.id,false); } enterMeeting(); });
    else showError('Missing room code.', true);
  }
  function recoverAfterReconnect() {
    // Socket IDs change after a reconnect. Rejoining creates a fresh participant identity and clean peers.
    closeAllPeers(); state.joined=false; state.participants.clear(); if(state.roomId) state.socket.emit('join-room',{roomId:state.roomId,name:state.name},res=>{if(!res?.ok){showError(res?.error||'Could not reconnect.',true);return;}state.selfId=res.selfId;applyRoom(res.room);for(const p of res.existing||[]){state.participants.set(p.id,p);ensurePeer(p.id,false)}state.joined=true;state.reconnecting=false;renderGrid();renderPeople();});
  }
  function applyRoom(room) { if(!room) return; state.roomId=room.roomId; state.role=room.hostId===state.selfId?'teacher':(room.participants.find(p=>p.id===state.selfId)?.role||state.role); els.roomLabel.textContent=room.roomId; els.lobbyRoom.textContent=`Room ${room.roomId} • ${state.role==='teacher'?'Teacher':'Student'}`; state.participants.clear(); for(const p of room.participants) state.participants.set(p.id,p); updateHostUI(room); renderPeople(); renderGrid(); }
  function updateHostUI(room=null) { const host = state.role==='teacher'; els.hostControls.classList.toggle('hidden',!host); if(host){const locked=room?.locked ?? false;els.lockBtn.textContent=locked?'Unlock meeting':'Lock meeting';} }

  async function enterMeeting() {
    if (!state.socket?.connected) return showError('Connecting to meeting server…', true);
    state.joined=true; state.intentionalLeave=false; els.overlay.classList.add('hidden'); renderGrid(); renderPeople(); updateControls(); startStats();
    for (const id of state.participants.keys()) if(id!==state.selfId) await ensurePeer(id, false);
  }

  function ensurePeer(id, initiator) {
    if (!state.joined || id===state.selfId) return state.peers.get(id);
    if(state.peers.has(id)) return state.peers.get(id);
    const pc=new RTCPeerConnection({iceServers:state.iceServers,bundlePolicy:'max-bundle',rtcpMuxPolicy:'require'}); state.peers.set(id,pc); state.pendingIce.set(id,[]);
    for(const track of state.localStream?.getTracks()||[]) pc.addTrack(track,state.localStream);
    pc.onicecandidate=e=>{if(e.candidate)state.socket.emit('ice-candidate',{targetId:id,candidate:e.candidate});};
    pc.ontrack=e=>attachRemoteTrack(id,e.streams[0],e.track);
    pc.onconnectionstatechange=()=>{ if(pc.connectionState==='failed') restartIce(id); else if(pc.connectionState==='closed'||pc.connectionState==='disconnected') setTimeout(()=>{if(state.peers.get(id)===pc&&pc.connectionState==='disconnected')restartIce(id)},1500); };
    pc.oniceconnectionstatechange=()=>{ if(pc.iceConnectionState==='failed') restartIce(id); };
    if(initiator) makeOffer(id,pc);
    return pc;
  }
  async function makeOffer(id,pc,iceRestart=false) { try { const offer=await pc.createOffer(iceRestart?{iceRestart:true}:undefined); await pc.setLocalDescription(offer); state.socket.emit('offer',{targetId:id,description:pc.localDescription}); } catch(e){ console.warn('offer',e); } }
  async function handleOffer({fromId,description}) { const pc=ensurePeer(fromId,false); if(!pc)return; try { await pc.setRemoteDescription(description); await flushIce(fromId); const answer=await pc.createAnswer(); await pc.setLocalDescription(answer); state.socket.emit('answer',{targetId:fromId,description:pc.localDescription}); } catch(e){ console.warn('answer',e); } }
  async function handleAnswer({fromId,description}) { const pc=state.peers.get(fromId); if(!pc)return; try{await pc.setRemoteDescription(description);await flushIce(fromId);}catch(e){console.warn('remote answer',e);} }
  async function handleIce({fromId,candidate}) { const pc=state.peers.get(fromId)||ensurePeer(fromId,false); if(!pc)return; if(pc.remoteDescription?.type){try{await pc.addIceCandidate(candidate)}catch(e){console.warn('ICE',e)}}else{const q=state.pendingIce.get(fromId)||[];q.push(candidate);state.pendingIce.set(fromId,q);} }
  async function flushIce(id){const pc=state.peers.get(id);const q=state.pendingIce.get(id)||[];for(const c of q){try{await pc.addIceCandidate(c)}catch{}}state.pendingIce.set(id,[]);}
  async function restartIce(id){const pc=state.peers.get(id);if(!pc||pc.signalingState==='closed')return; try{await makeOffer(id,pc,true)}catch{}}

  function attachRemoteTrack(id,stream,track){ let card=ensureCard(id); const video=card.querySelector('video'); if(!video.srcObject||video.srcObject.id!==stream.id){video.srcObject=stream;video.autoplay=true;video.playsInline=true;video.muted=false;video.volume=1;} if(track.kind==='audio') track.enabled=true; video.play().catch(()=>{}); updatePiPButton(video); }
  function ensureCard(id){ let card=qs(`[data-id="${CSS.escape(id)}"]`); if(card)return card; const p=state.participants.get(id)||{id,name:'Participant',role:'student',micOn:true,cameraOn:true,handRaised:false}; card=document.createElement('article');card.className='video-card';card.dataset.id=id;card.innerHTML=`<div class="avatar">${escapeText(initials(p.name))}</div><video autoplay playsinline></video><div class="tile-top"><span class="name-pill"></span><span class="state-pill"></span></div><div class="tile-bottom"><button class="tile-action fs">Fullscreen</button><button class="tile-action pip hidden">PiP</button></div>`; card.querySelector('.fs').addEventListener('click',()=>card.requestFullscreen?.());card.querySelector('.pip').addEventListener('click',()=>togglePiP(card.querySelector('video')));els.grid.appendChild(card);return card; }
  function renderGrid(){ const all=[...state.participants.values()]; els.empty.classList.toggle('hidden',all.length>1); els.grid.innerHTML=''; for(const p of all){const card=ensureCard(p.id);const video=card.querySelector('video');const avatar=card.querySelector('.avatar');const name=card.querySelector('.name-pill');const status=card.querySelector('.state-pill');name.textContent=displayName(p);status.textContent=`${p.role==='teacher'?'Teacher':'Student'} • ${p.micOn?'🎙':'🔇'} ${p.cameraOn?'▣':'□'}${p.handRaised?' • ✋':''}`;card.classList.toggle('audio-only',state.audioOnly||!p.cameraOn);avatar.textContent=initials(p.name);if(p.id===state.selfId){video.srcObject=state.localStream;video.muted=true;video.volume=0;video.play().catch(()=>{});}else if(video.srcObject)video.play().catch(()=>{}); updatePiPButton(video); } }
  function renderPeople(){els.peopleCount.textContent=state.participants.size;els.peopleList.innerHTML='';for(const p of state.participants.values()){const row=document.createElement('div');row.className='person-row';row.innerHTML=`<div class="person-avatar">${escapeText(initials(p.name))}</div><div class="person-meta"><div class="person-name"></div><div class="person-role"></div></div><div class="person-state"></div>`;row.querySelector('.person-name').textContent=displayName(p);row.querySelector('.person-role').textContent=p.role==='teacher'?'Teacher':'Student';row.querySelector('.person-state').textContent=`${p.micOn?'🎙':'🔇'} ${p.cameraOn?'▣':'□'}${p.handRaised?' ✋':''}`;if(state.role==='teacher'&&p.id!==state.selfId){const b=document.createElement('button');b.className='tile-action';b.textContent='Remove';b.addEventListener('click',()=>state.socket.emit('remove-participant',{participantId:p.id}));row.appendChild(b)}els.peopleList.appendChild(row)}}
  function removeParticipant(id){state.participants.delete(id);const pc=state.peers.get(id);pc?.close();state.peers.delete(id);state.pendingIce.delete(id);state.remoteAudio.get(id)?.pause();state.remoteAudio.delete(id);qs(`[data-id="${CSS.escape(id)}"]`)?.remove();renderPeople();renderGrid();}
  function closeAllPeers(){for(const pc of state.peers.values())pc.close();state.peers.clear();state.pendingIce.clear();for(const v of state.remoteAudio.values())v.pause();state.remoteAudio.clear();}

  function addChat(msg){const mine=msg.senderId===state.selfId;const box=document.createElement('div');box.className='chat-message'+(mine?' mine':'');const who=document.createElement('strong');who.textContent=mine?'You':msg.senderName;const p=document.createElement('p');p.textContent=msg.text;const t=document.createElement('time');t.textContent=new Date(msg.timestamp).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});box.append(who,p,t);els.chatMessages.appendChild(box);els.chatMessages.scrollTop=els.chatMessages.scrollHeight;if(!mine&&!els.chatPanel.classList.contains('hidden'))return;if(!mine){state.unread++;els.chatUnread.textContent=state.unread;els.chatUnread.classList.remove('hidden')}}
  function openPanel(which){els.sidePanel.classList.remove('hidden-mobile');document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.panel===which));els.peoplePanel.classList.toggle('hidden',which!=='people');els.chatPanel.classList.toggle('hidden',which!=='chat');if(which==='chat'){state.unread=0;els.chatUnread.classList.add('hidden')}}

  async function shareScreen(){if(!navigator.mediaDevices?.getDisplayMedia)return showError('Screen sharing is not supported on this browser/device.');try{const stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});const track=stream.getVideoTracks()[0];if(!track)return;state.screenTrack=track;for(const pc of state.peers.values()){const sender=pc.getSenders().find(s=>s.track?.kind==='video');if(sender)await sender.replaceTrack(track)};els.preview.srcObject=new MediaStream([track,...(state.localStream?.getAudioTracks()||[])]);track.onended=()=>stopScreenShare();}catch(e){if(e.name!=='AbortError')showError('Screen sharing failed. Camera remains active.');}}
  async function stopScreenShare(){if(!state.screenTrack)return;const cam=state.localStream?.getVideoTracks()[0];for(const pc of state.peers.values()){const sender=pc.getSenders().find(s=>s.track?.kind==='video');if(sender&&cam)await sender.replaceTrack(cam)}state.screenTrack.stop();state.screenTrack=null;els.preview.srcObject=state.localStream;}
  function toggleAudioOnly(){state.audioOnly=!state.audioOnly; if(state.audioOnly){setTrackEnabled('video',false);state.cameraOn=false;}else{if(state.cameraTrack){state.cameraOn=true;setTrackEnabled('video',true)}}sendMediaState();updateControls();renderGrid();}
  async function togglePiP(video){try{if(document.pictureInPictureElement)await document.exitPictureInPicture();else if(document.pictureInPictureEnabled&&video?.readyState>=2)await video.requestPictureInPicture();else showError('Picture-in-Picture is not supported here.');}catch{showError('Picture-in-Picture could not be opened.');}}
  function updatePiPButton(video){const b=video?.closest('.video-card')?.querySelector('.pip');if(b)b.classList.toggle('hidden',!(document.pictureInPictureEnabled&&video?.readyState>=2));if(document.pictureInPictureEnabled)els.pipBtn.classList.remove('hidden');}
  async function testSpeaker(){if(state.speakerTestTimer)return;const C=window.AudioContext||window.webkitAudioContext;if(!C)return showError('Speaker test is not supported by this browser.');try{const ctx=new C();const osc=ctx.createOscillator();const gain=ctx.createGain();osc.frequency.value=660;gain.gain.value=.045;osc.connect(gain).connect(ctx.destination);osc.start();state.speakerTestTimer=setTimeout(()=>{osc.stop();ctx.close();state.speakerTestTimer=null},500)}catch{showError('Speaker test failed.');}}

  function startStats(){clearInterval(state.statsTimer);state.statsTimer=setInterval(async()=>{let worst=0;for(const pc of state.peers.values()){try{const stats=await pc.getStats();stats.forEach(r=>{if(r.type==='candidate-pair'&&r.state==='succeeded'&&typeof r.currentRoundTripTime==='number')worst=Math.max(worst,r.currentRoundTripTime*1000);});}catch{}}const label=worst<120?'Excellent':worst<250?'Good':worst<500?'Fair':'Poor';setBadge(state.reconnecting?'Reconnecting…':label,label!=='Poor');adaptVideo(label)},5000)}
  async function adaptVideo(label){if(state.selectedQuality!=='auto')return;const target=label==='Poor'?360:label==='Fair'?480:720;const track=state.localStream?.getVideoTracks()[0];if(!track)return;try{await track.applyConstraints({width:{ideal:target,max:target},height:{ideal:target*9/16,max:target*9/16},frameRate:{ideal:label==='Poor'?15:24,max:30}})}catch{}}

  async function leave(){state.intentionalLeave=true;await stopScreenShare();closeAllPeers();state.localStream?.getTracks().forEach(t=>t.stop());state.localStream=null;state.socket?.emit('leave-room');state.socket?.disconnect();location.href='/';}
  function finishToHome(message){state.intentionalLeave=true;closeAllPeers();state.localStream?.getTracks().forEach(t=>t.stop());showError(message);setTimeout(()=>location.href='/',900)}

  async function copyText(text){try{await navigator.clipboard.writeText(text);showError('Copied.')}catch{showError('Copy failed. Copy it manually.')}}
  function bind(){
    els.enter.addEventListener('click',async()=>{try{if(!state.localStream)await getMedia();enterMeeting()}catch(e){showError(e.message,true)}});
    els.lobbyMic.addEventListener('click',toggleMic);els.lobbyCam.addEventListener('click',toggleCamera);els.micBtn.addEventListener('click',toggleMic);els.cameraBtn.addEventListener('click',toggleCamera);els.flipBtn.addEventListener('click',flipCamera);els.shareBtn.addEventListener('click',shareScreen);els.handBtn.addEventListener('click',()=>{state.handRaised=!state.handRaised;state.socket?.emit('hand-raised',{raised:state.handRaised});updateControls();});els.audioOnlyBtn.addEventListener('click',toggleAudioOnly);
    els.moreBtn.addEventListener('click',()=>els.moreMenu.classList.toggle('hidden'));els.peopleBtn.addEventListener('click',()=>openPanel('people'));els.chatBtn.addEventListener('click',()=>openPanel('chat'));els.leaveBtn.addEventListener('click',leave);
    document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>openPanel(t.dataset.panel)));
    els.chatForm.addEventListener('submit',e=>{e.preventDefault();const text=els.chatInput.value.trim();if(text){state.socket.emit('chat-message',{text});els.chatInput.value=''}});els.chatInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();els.chatForm.requestSubmit()}});
    els.copyRoom.addEventListener('click',()=>copyText(state.roomId||''));els.inviteBtn.addEventListener('click',()=>copyText(`${location.origin}/meeting.html?room=${encodeURIComponent(state.roomId||'')}`));els.fullscreenBtn.addEventListener('click',()=>els.grid.requestFullscreen?.());els.pipBtn.addEventListener('click',()=>togglePiP(els.grid.querySelector('video')));els.speakerTestBtn.addEventListener('click',testSpeaker);els.restartMediaBtn.addEventListener('click',restartMedia);els.lockBtn.addEventListener('click',()=>state.socket.emit('lock-meeting',{locked:els.lockBtn.textContent.includes('Lock')}));els.endBtn.addEventListener('click',()=>{if(confirm('End this meeting for everyone?'))state.socket.emit('end-meeting')});els.qualitySelect.addEventListener('change',e=>{state.selectedQuality=e.target.value;if(e.target.value!=='auto')adaptVideo(e.target.value==='720'?'Good':e.target.value==='480'?'Fair':'Poor')});
    navigator.mediaDevices?.addEventListener?.('devicechange',()=>showError('Device changed. You can use More → Restart camera & mic to select the new device.'));
    window.addEventListener('beforeunload',()=>{if(!state.intentionalLeave)state.socket?.emit('leave-room')});
  }

  async function boot(){bind();state.name=(state.name||'').trim()||'Guest';els.roomLabel.textContent=state.roomId||'New';await loadConfig();try{await getMedia()}catch(e){showError(e.message,true)}connectSocket();}
  boot();
})();
