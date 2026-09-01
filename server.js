const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.get("/meeting/:code", (req,res) =>
  res.sendFile(path.join(__dirname,"public","index.html"))
);

function code() {
  let c;
  do c = "CLASS-" + Math.random().toString(36).slice(2,6).toUpperCase();
  while (rooms.has(c));
  return c;
}
function sendParticipants(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit("participants",
    [...room.users.entries()].map(([id,u]) => ({
      id,name:u.name,role:u.role,camera:u.camera,mic:u.mic
    }))
  );
}
function remove(socket) {
  const rc=socket.data.room;
  if(!rc) return;
  const room=rooms.get(rc);
  if(!room) return;
  room.users.delete(socket.id);
  socket.to(rc).emit("peer-left",socket.id);
  sendParticipants(rc);
  if(room.users.size===0) rooms.delete(rc);
  socket.data.room=null;
}
io.on("connection",socket=>{
  socket.on("create-room",(data,cb)=>{
    const rc=code(), name=String(data?.name||"Guru").slice(0,40);
    rooms.set(rc,{host:socket.id,users:new Map([[socket.id,{name,role:"teacher",camera:true,mic:true}]])});
    socket.join(rc); socket.data.room=rc; socket.data.role="teacher";
    cb({ok:true,code:rc});
    sendParticipants(rc);
  });
  socket.on("join-room",(data,cb)=>{
    const rc=String(data?.code||"").trim().toUpperCase();
    const room=rooms.get(rc);
    if(!room) return cb({ok:false,error:"Meeting not found."});
    const students=[...room.users.values()].filter(u=>u.role==="student").length;
    if(students>=10) return cb({ok:false,error:"Meeting Full. Maksimal 10 siswa."});
    const existing=[...room.users.entries()].map(([id,u])=>({id,name:u.name,role:u.role}));
    const name=String(data?.name||"Siswa").slice(0,40);
    room.users.set(socket.id,{name,role:"student",camera:true,mic:true});
    socket.join(rc); socket.data.room=rc; socket.data.role="student";
    cb({ok:true,code:rc,existingPeers:existing});
    socket.to(rc).emit("peer-joined",{id:socket.id,name,role:"student"});
    sendParticipants(rc);
  });
  socket.on("offer",d=>io.to(d.to).emit("offer",{from:socket.id,offer:d.offer}));
  socket.on("answer",d=>io.to(d.to).emit("answer",{from:socket.id,answer:d.answer}));
  socket.on("ice-candidate",d=>io.to(d.to).emit("ice-candidate",{from:socket.id,candidate:d.candidate}));
  socket.on("media-state",d=>{
    const room=rooms.get(socket.data.room), u=room?.users.get(socket.id);
    if(!u) return;
    u.camera=!!d.camera; u.mic=!!d.mic;
    socket.to(socket.data.room).emit("media-state",{id:socket.id,camera:u.camera,mic:u.mic});
    sendParticipants(socket.data.room);
  });
  socket.on("leave-room",()=>remove(socket));
  socket.on("disconnect",()=>remove(socket));
});
server.listen(PORT,()=>console.log(`CLASSROOM LIVE listening on ${PORT}`));
