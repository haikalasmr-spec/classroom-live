const express=require("express");
const http=require("http");
const path=require("path");
const {Server}=require("socket.io");

const app=express();
const server=http.createServer(app);
const io=new Server(server);
const PORT=process.env.PORT||3000;
const MAX=20;
const rooms=new Map();

app.use(express.static(path.join(__dirname,"public")));
app.get("/",(_,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get("/meeting/:code",(_,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

function newCode(){let c;do{c="CLASS-"+Math.random().toString(36).slice(2,6).toUpperCase()}while(rooms.has(c));return c}
function sendPeople(code){
 const r=rooms.get(code);if(!r)return;
 io.to(code).emit("participants",[...r.users].map(([id,u])=>({id,...u})));
}
function leave(s){
 const code=s.data.room;if(!code)return;
 const r=rooms.get(code);if(!r){s.data.room=null;return}
 r.users.delete(s.id);s.to(code).emit("peer-left",s.id);sendPeople(code);
 if(!r.users.size)rooms.delete(code);s.leave(code);s.data.room=null;
}

io.on("connection",s=>{
 s.on("create-room",(d,cb)=>{
  if(s.data.room)leave(s);
  const code=newCode(),name=String(d?.name||"Guru").trim().slice(0,40)||"Guru";
  rooms.set(code,{host:s.id,users:new Map([[s.id,{name,role:"teacher",camera:true,mic:true,hand:false}]])});
  s.join(code);s.data.room=code;s.data.role="teacher";cb({ok:true,code});sendPeople(code);
 });
 s.on("join-room",(d,cb)=>{
  const code=String(d?.code||"").trim().toUpperCase(),r=rooms.get(code);
  if(!r)return cb({ok:false,error:"Meeting tidak ditemukan."});
  if(r.users.size>=MAX)return cb({ok:false,error:"Meeting penuh. Maksimal 20 peserta."});
  const existing=[...r.users].map(([id,u])=>({id,name:u.name,role:u.role}));
  const name=String(d?.name||"Siswa").trim().slice(0,40)||"Siswa";
  r.users.set(s.id,{name,role:"student",camera:true,mic:true,hand:false});
  s.join(code);s.data.room=code;s.data.role="student";
  cb({ok:true,code,existingPeers:existing});
  s.to(code).emit("peer-joined",{id:s.id,name,role:"student"});sendPeople(code);
 });
 function relay(event,key){
  s.on(event,d=>{
   if(!s.data.room||!d?.to||!d?.[key])return;
   const r=rooms.get(s.data.room);
   if(r?.users.has(d.to))io.to(d.to).emit(event,{from:s.id,[key]:d[key]});
  });
 }
 relay("offer","offer");relay("answer","answer");relay("ice-candidate","candidate");

 s.on("media-state",d=>{
  const r=rooms.get(s.data.room),u=r?.users.get(s.id);if(!u)return;
  u.camera=!!d.camera;u.mic=!!d.mic;s.to(s.data.room).emit("media-state",{id:s.id,camera:u.camera,mic:u.mic});sendPeople(s.data.room);
 });
 s.on("raise-hand",d=>{
  const r=rooms.get(s.data.room),u=r?.users.get(s.id);if(!u)return;
  u.hand=!!d.hand;io.to(s.data.room).emit("hand-state",{id:s.id,hand:u.hand});sendPeople(s.data.room);
 });
 s.on("change-name",(d,cb)=>{
  const r=rooms.get(s.data.room),u=r?.users.get(s.id);if(!u)return cb({ok:false,error:"Meeting tidak ditemukan."});
  const name=String(d?.name||"").trim().slice(0,40);if(!name)return cb({ok:false,error:"Nama tidak boleh kosong."});
  u.name=name;cb({ok:true,name});io.to(s.data.room).emit("name-changed",{id:s.id,name});sendPeople(s.data.room);
 });
 s.on("chat-message",d=>{
  const r=rooms.get(s.data.room),u=r?.users.get(s.id);if(!u)return;
  const text=String(d?.text||"").trim().slice(0,500);if(!text)return;
  io.to(s.data.room).emit("chat-message",{id:s.id,name:u.name,text,time:new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})});
 });
 s.on("leave-room",()=>leave(s));s.on("disconnect",()=>leave(s));
});
server.listen(PORT,"0.0.0.0",()=>console.log("CLASSROOM LIVE on "+PORT));
