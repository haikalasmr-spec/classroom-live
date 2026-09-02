'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: false },
  maxHttpBufferSize: 1e6,
  pingInterval: 10000,
  pingTimeout: 20000
});

const PORT = Number(process.env.PORT) || 3000;
const rooms = new Map();
const RATE_WINDOW = 5000;
const MAX_MESSAGES_PER_WINDOW = 8;
const messageRates = new Map();
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// Runtime ICE configuration. Add TURN by setting TURN_URL, TURN_USERNAME and TURN_CREDENTIAL.
app.get('/config', (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map(v => v.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  res.json({ iceServers });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function cleanText(value, max = 80) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max);
}
function validRoomId(roomId) { return /^CL-[A-HJ-NP-Z2-9]{6}$/.test(roomId); }
function makeRoomId() {
  for (let tries = 0; tries < 100; tries++) {
    let code = 'CL-';
    for (let i = 0; i < 6; i++) code += ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not generate room code');
}
function publicParticipant(p) {
  return { id: p.id, name: p.name, role: p.role, micOn: p.micOn, cameraOn: p.cameraOn, handRaised: p.handRaised, joinedAt: p.joinedAt };
}
function publicRoom(room) {
  return {
    roomId: room.id,
    hostId: room.hostId,
    hostName: room.hostName,
    locked: room.locked,
    participants: [...room.participants.values()].map(publicParticipant)
  };
}
function roomForSocket(socket) { return socket.data.roomId ? rooms.get(socket.data.roomId) : null; }
function emitRoomState(room) { io.to(room.id).emit('room-state', publicRoom(room)); }
function removeSocketFromRoom(socket, reason = 'left') {
  const room = roomForSocket(socket);
  if (!room) return;
  const participant = room.participants.get(socket.id);
  room.participants.delete(socket.id);
  socket.leave(room.id);
  socket.data.roomId = null;
  if (participant) io.to(room.id).emit('participant-left', { id: socket.id, reason });
  if (room.hostId === socket.id) {
    const next = room.participants.values().next().value;
    if (next) {
      next.role = 'teacher';
      room.hostId = next.id;
      room.hostName = next.name;
      io.to(room.id).emit('host-changed', { hostId: next.id, hostName: next.name });
    } else {
      rooms.delete(room.id);
      return;
    }
  }
  emitRoomState(room);
  if (room.participants.size === 0) rooms.delete(room.id);
}
function isHost(socket, room) { return Boolean(room && room.hostId === socket.id); }
function canSendMessage(socket) {
  const now = Date.now();
  const arr = (messageRates.get(socket.id) || []).filter(t => now - t < RATE_WINDOW);
  if (arr.length >= MAX_MESSAGES_PER_WINDOW) { messageRates.set(socket.id, arr); return false; }
  arr.push(now); messageRates.set(socket.id, arr); return true;
}

io.on('connection', socket => {
  socket.on('create-room', ({ name } = {}, ack) => {
    const cleanName = cleanText(name, 40) || 'Teacher';
    if (roomForSocket(socket)) removeSocketFromRoom(socket, 'rejoin');
    const id = makeRoomId();
    const room = { id, hostId: socket.id, hostName: cleanName, locked: false, createdAt: Date.now(), participants: new Map() };
    room.participants.set(socket.id, { id: socket.id, name: cleanName, role: 'teacher', micOn: true, cameraOn: true, handRaised: false, joinedAt: Date.now() });
    rooms.set(id, room);
    socket.data.roomId = id;
    socket.join(id);
    socket.emit('room-created', publicRoom(room));
    emitRoomState(room);
    if (typeof ack === 'function') ack({ ok: true, room: publicRoom(room) });
  });

  socket.on('join-room', ({ roomId, name } = {}, ack) => {
    const id = cleanText(roomId, 20).toUpperCase();
    const cleanName = cleanText(name, 40) || 'Student';
    if (!validRoomId(id)) return ack?.({ ok: false, error: 'Invalid room code.' });
    const room = rooms.get(id);
    if (!room) return ack?.({ ok: false, error: 'Room not found. Check the code.' });
    if (room.locked) return ack?.({ ok: false, error: 'This meeting is locked.' });
    if (room.participants.size >= 12) return ack?.({ ok: false, error: 'This demo uses a 12-person mesh limit. Use an SFU for larger classes.' });
    if (roomForSocket(socket)) removeSocketFromRoom(socket, 'rejoin');
    const participant = { id: socket.id, name: cleanName, role: 'student', micOn: true, cameraOn: true, handRaised: false, joinedAt: Date.now() };
    room.participants.set(socket.id, participant);
    socket.data.roomId = id;
    socket.join(id);
    const existing = [...room.participants.values()].filter(p => p.id !== socket.id).map(publicParticipant);
    ack?.({ ok: true, room: publicRoom(room), selfId: socket.id, existing });
    socket.to(id).emit('participant-joined', publicParticipant(participant));
    emitRoomState(room);
  });

  socket.on('media-state', ({ micOn, cameraOn } = {}) => {
    const room = roomForSocket(socket); if (!room) return;
    const p = room.participants.get(socket.id); if (!p) return;
    if (typeof micOn === 'boolean') p.micOn = micOn;
    if (typeof cameraOn === 'boolean') p.cameraOn = cameraOn;
    socket.to(room.id).emit('media-state', { id: socket.id, micOn: p.micOn, cameraOn: p.cameraOn });
    emitRoomState(room);
  });

  socket.on('hand-raised', ({ raised } = {}) => {
    const room = roomForSocket(socket); if (!room) return;
    const p = room.participants.get(socket.id); if (!p) return;
    p.handRaised = Boolean(raised);
    io.to(room.id).emit('hand-raised', { id: socket.id, raised: p.handRaised });
    emitRoomState(room);
  });

  socket.on('chat-message', ({ text } = {}) => {
    const room = roomForSocket(socket); const p = room?.participants.get(socket.id);
    if (!room || !p || !canSendMessage(socket)) return;
    const message = cleanText(text, 500); if (!message) return;
    io.to(room.id).emit('chat-message', { id: crypto.randomUUID(), senderId: socket.id, senderName: p.name, text: message, timestamp: Date.now() });
  });

  socket.on('lock-meeting', ({ locked } = {}) => {
    const room = roomForSocket(socket); if (!isHost(socket, room)) return;
    room.locked = Boolean(locked);
    io.to(room.id).emit('meeting-locked', { locked: room.locked });
    emitRoomState(room);
  });

  socket.on('remove-participant', ({ participantId } = {}) => {
    const room = roomForSocket(socket); if (!isHost(socket, room)) return;
    if (!participantId || participantId === socket.id) return;
    const target = io.sockets.sockets.get(participantId);
    if (!target || target.data.roomId !== room.id) return;
    target.emit('participant-removed', { message: 'You were removed from the meeting by the host.' });
    removeSocketFromRoom(target, 'removed');
  });

  socket.on('end-meeting', () => {
    const room = roomForSocket(socket); if (!isHost(socket, room)) return;
    io.to(room.id).emit('meeting-ended', { message: 'Meeting ended by host.' });
    for (const p of room.participants.values()) {
      const s = io.sockets.sockets.get(p.id);
      if (s) { s.leave(room.id); s.data.roomId = null; }
    }
    rooms.delete(room.id);
  });

  // WebRTC signaling: server only relays signaling data, never media.
  socket.on('offer', ({ targetId, description } = {}) => {
    const room = roomForSocket(socket); if (!room || !room.participants.has(targetId) || !description) return;
    io.to(targetId).emit('offer', { fromId: socket.id, description });
  });
  socket.on('answer', ({ targetId, description } = {}) => {
    const room = roomForSocket(socket); if (!room || !room.participants.has(targetId) || !description) return;
    io.to(targetId).emit('answer', { fromId: socket.id, description });
  });
  socket.on('ice-candidate', ({ targetId, candidate } = {}) => {
    const room = roomForSocket(socket); if (!room || !room.participants.has(targetId) || !candidate) return;
    io.to(targetId).emit('ice-candidate', { fromId: socket.id, candidate });
  });

  socket.on('leave-room', () => removeSocketFromRoom(socket, 'left'));
  socket.on('disconnect', () => { removeSocketFromRoom(socket, 'disconnect'); messageRates.delete(socket.id); });
});

server.listen(PORT, () => console.log(`CLASSROOM LIVE listening on port ${PORT}`));
