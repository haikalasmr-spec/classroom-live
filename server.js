const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 100000
});

const PORT = Number(process.env.PORT) || 3000;
const rooms = new Map();
const RATE = new Map();

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/health', (_req, res) => res.json({ ok: true }));

function cleanName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
}
function cleanRoom(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 12);
}
function validRoom(id) { return /^CL-[A-HJ-NP-Z2-9]{6}$/.test(id); }
function makeRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id;
  do {
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[crypto.randomInt(chars.length)];
    id = `CL-${s}`;
  } while (rooms.has(id));
  return id;
}
function publicParticipant(p) {
  return { id: p.id, name: p.name, role: p.role, micOn: p.micOn, cameraOn: p.cameraOn, screenSharing: p.screenSharing, handRaised: p.handRaised };
}
function roomSnapshot(room) { return [...room.participants.values()].map(publicParticipant); }
function rateLimit(socket, key, limit, windowMs) {
  const now = Date.now();
  const k = `${socket.id}:${key}`;
  const arr = (RATE.get(k) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) { RATE.set(k, arr); return false; }
  arr.push(now); RATE.set(k, arr); return true;
}
function roomOf(socket) { return socket.data.roomId ? rooms.get(socket.data.roomId) : null; }
function isHost(socket, room) { return !!room && room.hostId === socket.id; }
function leaveCurrentRoom(socket, reason = 'disconnect') {
  const room = roomOf(socket);
  if (!room) return;
  const participant = room.participants.get(socket.id);
  room.participants.delete(socket.id);
  socket.leave(room.id);
  socket.data.roomId = null;
  if (participant) {
    io.to(room.id).emit('participant-left', { participantId: participant.id, reason });
  }
  if (room.hostId === socket.id) {
    room.hostId = null;
    if (room.participants.size > 0) {
      const next = room.participants.values().next().value;
      room.hostId = next.id;
      next.role = 'teacher';
      io.to(room.id).emit('host-changed', { hostId: next.id, participant: publicParticipant(next) });
    }
  }
  if (room.participants.size === 0) rooms.delete(room.id);
  else io.to(room.id).emit('room-state', { roomId: room.id, locked: room.locked, participants: roomSnapshot(room) });
}

io.on('connection', socket => {
  socket.on('create-room', ({ name, clientId } = {}, ack) => {
    if (!rateLimit(socket, 'create', 5, 60000)) return ack?.({ ok: false, error: 'Too many room creation requests. Please wait.' });
    const clean = cleanName(name);
    if (!clean) return ack?.({ ok: false, error: 'Name is required.' });
    if (roomOf(socket)) leaveCurrentRoom(socket, 'switch-room');
    const id = makeRoomId();
    const participant = { id: socket.id, clientId: String(clientId || ''), name: clean, role: 'teacher', micOn: true, cameraOn: true, screenSharing: false, handRaised: false };
    const room = { id, hostId: socket.id, hostName: clean, locked: false, createdAt: Date.now(), participants: new Map([[socket.id, participant]]) };
    rooms.set(id, room);
    socket.data.roomId = id;
    socket.join(id);
    ack?.({ ok: true, roomId: id, participant: publicParticipant(participant), participants: roomSnapshot(room), locked: false });
    socket.emit('room-created', { roomId: id });
  });

  socket.on('join-room', ({ roomId, name, clientId } = {}, ack) => {
    if (!rateLimit(socket, 'join', 12, 60000)) return ack?.({ ok: false, error: 'Too many join requests. Please wait.' });
    const id = cleanRoom(roomId);
    const clean = cleanName(name);
    if (!validRoom(id)) return ack?.({ ok: false, error: 'Invalid room code.' });
    if (!clean) return ack?.({ ok: false, error: 'Name is required.' });
    const room = rooms.get(id);
    if (!room) return ack?.({ ok: false, error: 'Meeting no longer exists.' });
    if (room.locked) return ack?.({ ok: false, error: 'Room is locked. Ask the teacher to unlock it.' });
    if (roomOf(socket)) leaveCurrentRoom(socket, 'switch-room');
    const participant = { id: socket.id, clientId: String(clientId || ''), name: clean, role: 'student', micOn: true, cameraOn: true, screenSharing: false, handRaised: false };
    room.participants.set(socket.id, participant);
    socket.data.roomId = id;
    socket.join(id);
    const existing = roomSnapshot(room).filter(p => p.id !== socket.id);
    socket.emit('room-state', { roomId: id, locked: room.locked, participants: roomSnapshot(room) });
    socket.to(id).emit('participant-joined', { participant: publicParticipant(participant) });
    ack?.({ ok: true, roomId: id, participant: publicParticipant(participant), participants: roomSnapshot(room), existingParticipants: existing, locked: room.locked });
  });

  socket.on('rejoin-room', ({ roomId, name, role, clientId } = {}, ack) => {
    // Rejoin is intentionally a fresh socket participant. The client preserves its role only as a hint;
    // the server determines host privileges from the current room membership.
    const id = cleanRoom(roomId);
    const clean = cleanName(name);
    const room = rooms.get(id);
    if (!room || !clean) return ack?.({ ok: false, error: 'Unable to restore meeting.' });
    if (room.locked && role !== 'teacher') return ack?.({ ok: false, error: 'Room is locked.' });
    if (roomOf(socket)) leaveCurrentRoom(socket, 'rejoin');
    const isTeacherRecovery = role === 'teacher' && room.hostName === clean && !room.hostId;
    const actualRole = isTeacherRecovery ? 'teacher' : 'student';
    const participant = { id: socket.id, clientId: String(clientId || ''), name: clean, role: actualRole, micOn: true, cameraOn: true, screenSharing: false, handRaised: false };
    room.participants.set(socket.id, participant);
    if (actualRole === 'teacher') room.hostId = socket.id;
    socket.data.roomId = id;
    socket.join(id);
    ack?.({ ok: true, roomId: id, participant: publicParticipant(participant), participants: roomSnapshot(room), locked: room.locked });
    socket.to(id).emit('participant-joined', { participant: publicParticipant(participant) });
  });

  socket.on('signal-offer', ({ to, offer } = {}) => {
    const room = roomOf(socket); if (!room || !room.participants.has(to)) return;
    io.to(to).emit('signal-offer', { from: socket.id, offer });
  });
  socket.on('signal-answer', ({ to, answer } = {}) => {
    const room = roomOf(socket); if (!room || !room.participants.has(to)) return;
    io.to(to).emit('signal-answer', { from: socket.id, answer });
  });
  socket.on('signal-ice', ({ to, candidate } = {}) => {
    const room = roomOf(socket); if (!room || !room.participants.has(to)) return;
    io.to(to).emit('signal-ice', { from: socket.id, candidate });
  });

  socket.on('media-state', ({ micOn, cameraOn, screenSharing } = {}) => {
    const room = roomOf(socket); const p = room?.participants.get(socket.id); if (!p) return;
    if (typeof micOn === 'boolean') p.micOn = micOn;
    if (typeof cameraOn === 'boolean') p.cameraOn = cameraOn;
    if (typeof screenSharing === 'boolean') p.screenSharing = screenSharing;
    socket.to(room.id).emit('media-state', { participantId: socket.id, micOn: p.micOn, cameraOn: p.cameraOn, screenSharing: p.screenSharing });
  });
  socket.on('hand-raised', ({ raised } = {}) => {
    const room = roomOf(socket); const p = room?.participants.get(socket.id); if (!p || typeof raised !== 'boolean') return;
    p.handRaised = raised; io.to(room.id).emit('hand-raised', { participantId: socket.id, raised });
  });
  socket.on('chat-message', ({ text } = {}) => {
    const room = roomOf(socket); const p = room?.participants.get(socket.id); if (!p || !rateLimit(socket, 'chat', 20, 10000)) return;
    const clean = String(text ?? '').trim().slice(0, 500); if (!clean) return;
    io.to(room.id).emit('chat-message', { id: crypto.randomUUID(), participantId: p.id, name: p.name, text: clean, timestamp: Date.now() });
  });
  socket.on('set-lock', ({ locked } = {}, ack) => {
    const room = roomOf(socket); if (!isHost(socket, room) || typeof locked !== 'boolean') return ack?.({ ok: false, error: 'Host permission required.' });
    room.locked = locked; io.to(room.id).emit('meeting-locked', { locked }); ack?.({ ok: true });
  });
  socket.on('remove-participant', ({ participantId } = {}, ack) => {
    const room = roomOf(socket); if (!isHost(socket, room) || !room.participants.has(participantId)) return ack?.({ ok: false, error: 'Host permission required.' });
    const target = io.sockets.sockets.get(participantId); if (!target) return ack?.({ ok: false, error: 'Participant is no longer connected.' });
    target.emit('participant-removed', { reason: 'Removed by teacher.' });
    leaveCurrentRoom(target, 'removed');
    ack?.({ ok: true });
  });
  socket.on('end-meeting', (_data, ack) => {
    const room = roomOf(socket); if (!isHost(socket, room)) return ack?.({ ok: false, error: 'Host permission required.' });
    io.to(room.id).emit('meeting-ended', { message: 'Meeting ended by host.' });
    for (const [sid] of room.participants) {
      const s = io.sockets.sockets.get(sid); if (s) { s.leave(room.id); s.data.roomId = null; }
    }
    rooms.delete(room.id); ack?.({ ok: true });
  });
  socket.on('leave-room', () => leaveCurrentRoom(socket, 'leave'));
  socket.on('disconnect', () => { RATE.forEach((_v, k) => { if (k.startsWith(`${socket.id}:`)) RATE.delete(k); }); leaveCurrentRoom(socket, 'disconnect'); });
});

server.listen(PORT, () => console.log(`[SERVER] CLASSROOM LIVE listening on port ${PORT}`));
