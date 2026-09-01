const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const mediasoup = require("mediasoup");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });

const PORT = Number(process.env.PORT || 3000);
const MAX_PARTICIPANTS = 20;

// Railway HTTP domain is used for the web app.
// For SFU media, Railway must expose a TCP Proxy to MEDIA_INTERNAL_PORT.
// Put the generated proxy hostname/port in MEDIA_ANNOUNCED_HOST / MEDIA_ANNOUNCED_PORT.
const MEDIA_INTERNAL_PORT = Number(process.env.MEDIA_INTERNAL_PORT || 40000);
const MEDIA_ANNOUNCED_HOST = process.env.MEDIA_ANNOUNCED_HOST || "";
const MEDIA_ANNOUNCED_PORT = Number(process.env.MEDIA_ANNOUNCED_PORT || MEDIA_INTERNAL_PORT);

const rooms = new Map();
let worker;

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {}
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1
    }
  }
];

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/meeting/:code", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/health", (req, res) => res.json({ ok: true, rooms: rooms.size }));

function makeCode() {
  let c;
  do c = "CLASS-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  while (rooms.has(c));
  return c;
}

function participants(room) {
  return [...room.peers.values()].map(p => ({
    id: p.id,
    name: p.name,
    role: p.role,
    camera: p.camera,
    mic: p.mic,
    hand: p.hand
  }));
}

function broadcastParticipants(room) {
  io.to(room.code).emit("participants", participants(room));
}

async function createRoom(code) {
  const router = await worker.createRouter({ mediaCodecs });
  return {
    code,
    router,
    peers: new Map(),
    transports: new Map(),
    producers: new Map(),
    consumers: new Map()
  };
}

async function createWebRtcTransport(router) {
  if (!MEDIA_ANNOUNCED_HOST) {
    throw new Error("MEDIA_ANNOUNCED_HOST is not configured.");
  }

  const transport = await router.createWebRtcTransport({
    webRtcServer: undefined,
    listenInfos: [
      {
        protocol: "tcp",
        ip: "0.0.0.0",
        port: MEDIA_INTERNAL_PORT,
        announcedAddress: MEDIA_ANNOUNCED_HOST,
        announcedPort: MEDIA_ANNOUNCED_PORT
      }
    ],
    enableUdp: false,
    enableTcp: true,
    preferUdp: false,
    preferTcp: true,
    initialAvailableOutgoingBitrate: 1000000
  });

  return transport;
}

function getRoom(socket) {
  return socket.data.room ? rooms.get(socket.data.room) : null;
}

function cleanupPeer(socket) {
  const room = getRoom(socket);
  if (!room) return;

  const peer = room.peers.get(socket.id);
  if (!peer) return;

  for (const transportId of peer.transportIds) {
    const t = room.transports.get(transportId);
    if (t) {
      try { t.close(); } catch {}
      room.transports.delete(transportId);
    }
  }

  for (const producerId of peer.producerIds) {
    const p = room.producers.get(producerId);
    if (p) {
      try { p.close(); } catch {}
      room.producers.delete(producerId);
    }
    io.to(room.code).emit("producer-closed", { producerId, peerId: socket.id });
  }

  for (const consumerId of peer.consumerIds) {
    const c = room.consumers.get(consumerId);
    if (c) {
      try { c.close(); } catch {}
      room.consumers.delete(consumerId);
    }
  }

  room.peers.delete(socket.id);
  socket.leave(room.code);
  socket.data.room = null;

  io.to(room.code).emit("peer-left", socket.id);
  broadcastParticipants(room);

  if (room.peers.size === 0) {
    try { room.router.close(); } catch {}
    rooms.delete(room.code);
  }
}

io.on("connection", socket => {
  socket.on("create-room", async (data, cb) => {
    try {
      const code = makeCode();
      const room = await createRoom(code);
      const name = String(data?.name || "Guru").trim().slice(0, 40) || "Guru";

      rooms.set(code, room);
      room.peers.set(socket.id, {
        id: socket.id, name, role: "teacher",
        camera: true, mic: true, hand: false,
        transportIds: new Set(), producerIds: new Set(), consumerIds: new Set()
      });

      socket.join(code);
      socket.data.room = code;
      socket.data.role = "teacher";

      cb({ ok: true, code });
      broadcastParticipants(room);
    } catch (e) {
      console.error(e);
      cb({ ok: false, error: e.message || "Could not create meeting." });
    }
  });

  socket.on("join-room", async (data, cb) => {
    try {
      const code = String(data?.code || "").trim().toUpperCase();
      const room = rooms.get(code);

      if (!room) return cb({ ok: false, error: "Meeting not found." });
      if (room.peers.size >= MAX_PARTICIPANTS) {
        return cb({ ok: false, error: "Meeting penuh. Maksimal 20 peserta." });
      }

      const existingPeers = [...room.peers.values()].map(p => ({
        id: p.id, name: p.name, role: p.role
      }));

      const name = String(data?.name || "Siswa").trim().slice(0, 40) || "Siswa";

      room.peers.set(socket.id, {
        id: socket.id, name, role: "student",
        camera: true, mic: true, hand: false,
        transportIds: new Set(), producerIds: new Set(), consumerIds: new Set()
      });

      socket.join(code);
      socket.data.room = code;
      socket.data.role = "student";

      cb({ ok: true, code, existingPeers });
      socket.to(code).emit("peer-joined", { id: socket.id, name, role: "student" });
      broadcastParticipants(room);
    } catch (e) {
      console.error(e);
      cb({ ok: false, error: e.message || "Could not join meeting." });
    }
  });

  socket.on("get-router-rtp-capabilities", (data, cb) => {
    const room = getRoom(socket);
    if (!room) return cb({ ok: false, error: "Not in a room." });
    cb({ ok: true, rtpCapabilities: room.router.rtpCapabilities });
  });

  socket.on("create-transport", async (data, cb) => {
    try {
      const room = getRoom(socket);
      const peer = room?.peers.get(socket.id);
      if (!room || !peer) return cb({ ok: false, error: "Not in a room." });

      const transport = await createWebRtcTransport(room.router);
      peer.transportIds.add(transport.id);
      room.transports.set(transport.id, transport);

      transport.on("dtlsstatechange", state => {
        if (state === "failed" || state === "closed") {
          try { transport.close(); } catch {}
        }
      });

      cb({
        ok: true,
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters
      });
    } catch (e) {
      console.error(e);
      cb({ ok: false, error: e.message || "Transport creation failed." });
    }
  });

  socket.on("connect-transport", async (data, cb) => {
    try {
      const room = getRoom(socket);
      const transport = room?.transports.get(data?.transportId);
      if (!transport) return cb({ ok: false, error: "Transport not found." });

      await transport.connect({ dtlsParameters: data.dtlsParameters });
      cb({ ok: true });
    } catch (e) {
      console.error(e);
      cb({ ok: false, error: e.message || "Transport connection failed." });
    }
  });

  socket.on("produce", async (data, cb) => {
    try {
      const room = getRoom(socket);
      const peer = room?.peers.get(socket.id);
      const transport = room?.transports.get(data?.transportId);
      if (!room || !peer || !transport) return cb({ ok: false, error: "Invalid transport." });

      const producer = await transport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters,
        appData: data.appData || {}
      });

      room.producers.set(producer.id, producer);
      peer.producerIds.add(producer.id);

      producer.on("transportclose", () => {
        room.producers.delete(producer.id);
        peer.producerIds.delete(producer.id);
      });

      socket.to(room.code).emit("new-producer", {
        producerId: producer.id,
        peerId: socket.id,
        kind: producer.kind,
        appData: producer.appData || {}
      });

      cb({ ok: true, id: producer.id });
    } catch (e) {
      console.error(e);
      cb({ ok: false, error: e.message || "Produce failed." });
    }
  });

  socket.on("get-producers", (data, cb) => {
    const room = getRoom(socket);
    const peer = room?.peers.get(socket.id);
    if (!room || !peer) return cb({ ok: false, producers: [] });

    const list = [...room.producers.values()]
      .filter(p => !peer.producerIds.has(p.id))
      .map(p => ({
        producerId: p.id,
        peerId: [...room.peers.values()].find(x => x.producerIds.has(p.id))?.id,
        kind: p.kind,
        appData: p.appData || {}
      }));

    cb({ ok: true, producers: list });
  });

  socket.on("consume", async (data, cb) => {
    try {
      const room = getRoom(socket);
      const peer = room?.peers.get(socket.id);
      if (!room || !peer) return cb({ ok: false, error: "Not in a room." });

      if (!room.router.canConsume({
        producerId: data.producerId,
        rtpCapabilities: data.rtpCapabilities
      })) {
        return cb({ ok: false, error: "Cannot consume this producer." });
      }

      const transport = room.transports.get(data.transportId);
      if (!transport) return cb({ ok: false, error: "Transport not found." });

      const consumer = await transport.consume({
        producerId: data.producerId,
        rtpCapabilities: data.rtpCapabilities,
        paused: true
      });

      room.consumers.set(consumer.id, consumer);
      peer.consumerIds.add(consumer.id);

      consumer.on("transportclose", () => {
        room.consumers.delete(consumer.id);
        peer.consumerIds.delete(consumer.id);
      });

      consumer.on("producerclose", () => {
        room.consumers.delete(consumer.id);
        peer.consumerIds.delete(consumer.id);
        try { consumer.close(); } catch {}
        socket.emit("consumer-closed", { consumerId: consumer.id, producerId: data.producerId });
      });

      const producerPeer = [...room.peers.values()].find(x => x.producerIds.has(data.producerId));

      cb({
        ok: true,
        id: consumer.id,
        producerId: data.producerId,
        peerId: producerPeer?.id,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        appData: producerPeer ? room.producers.get(data.producerId)?.appData || {} : {}
      });
    } catch (e) {
      console.error(e);
      cb({ ok: false, error: e.message || "Consume failed." });
    }
  });

  socket.on("resume-consumer", async (data, cb) => {
    try {
      const room = getRoom(socket);
      const consumer = room?.consumers.get(data?.consumerId);
      if (!consumer) return cb({ ok: false, error: "Consumer not found." });
      await consumer.resume();
      cb({ ok: true });
    } catch (e) {
      cb({ ok: false, error: e.message || "Resume failed." });
    }
  });

  socket.on("pause-producer", async (data, cb) => {
    try {
      const room = getRoom(socket);
      const producer = room?.producers.get(data?.producerId);
      if (!producer) return cb({ ok: false });
      if (data.paused) await producer.pause();
      else await producer.resume();
      cb({ ok: true });
    } catch {
      cb({ ok: false });
    }
  });

  socket.on("media-state", data => {
    const room = getRoom(socket);
    const user = room?.peers.get(socket.id);
    if (!user) return;
    user.camera = !!data.camera;
    user.mic = !!data.mic;
    socket.to(room.code).emit("media-state", {
      id: socket.id, camera: user.camera, mic: user.mic
    });
    broadcastParticipants(room);
  });

  socket.on("raise-hand", data => {
    const room = getRoom(socket);
    const user = room?.peers.get(socket.id);
    if (!user) return;
    user.hand = !!data.hand;
    io.to(room.code).emit("hand-state", { id: socket.id, hand: user.hand });
    broadcastParticipants(room);
  });

  socket.on("change-name", (data, cb) => {
    const room = getRoom(socket);
    const user = room?.peers.get(socket.id);
    if (!room || !user) return cb?.({ ok: false, error: "Not in a room." });

    const name = String(data?.name || "").trim().slice(0, 40);
    if (!name) return cb?.({ ok: false, error: "Nama tidak boleh kosong." });

    user.name = name;
    cb?.({ ok: true, name });
    io.to(room.code).emit("name-changed", { id: socket.id, name });
    broadcastParticipants(room);
  });

  socket.on("chat-message", data => {
    const room = getRoom(socket);
    const user = room?.peers.get(socket.id);
    if (!room || !user) return;

    const text = String(data?.text || "").trim().slice(0, 500);
    if (!text) return;

    io.to(room.code).emit("chat-message", {
      id: socket.id,
      name: user.name,
      text,
      time: new Date().toISOString()
    });
  });

  socket.on("leave-room", () => cleanupPeer(socket));
  socket.on("disconnect", () => cleanupPeer(socket));
});

(async () => {
  worker = await mediasoup.createWorker({
    logLevel: "warn",
    rtcMinPort: MEDIA_INTERNAL_PORT,
    rtcMaxPort: MEDIA_INTERNAL_PORT
  });

  worker.on("died", () => {
    console.error("mediasoup worker died; exiting.");
    process.exit(1);
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`CLASSROOM LIVE HTTP listening on ${PORT}`);
    console.log(`SFU TCP media internal port: ${MEDIA_INTERNAL_PORT}`);
    console.log(`SFU announced endpoint: ${MEDIA_ANNOUNCED_HOST || "(missing)"}:${MEDIA_ANNOUNCED_PORT}`);
  });
})().catch(err => {
  console.error(err);
  process.exit(1);
});
