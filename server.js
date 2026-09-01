const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e6
});

const PORT = process.env.PORT || 3000;
const MAX_PARTICIPANTS = 20;

const rooms = new Map();

const publicPath = path.join(__dirname, "public");

app.use(express.static(publicPath));

app.get("/", (req, res) => {
    res.sendFile(path.join(publicPath, "index.html"));
});

app.get("/meeting/:code", (req, res) => {
    res.sendFile(path.join(publicPath, "index.html"));
});


/* =====================================================
   ROOM CODE
===================================================== */

function createRoomCode() {

    let roomCode;

    do {

        roomCode =
            "CLASS-" +
            Math.random()
                .toString(36)
                .substring(2, 6)
                .toUpperCase();

    } while (rooms.has(roomCode));

    return roomCode;
}


/* =====================================================
   PARTICIPANTS
===================================================== */

function getParticipants(roomCode) {

    const room = rooms.get(roomCode);

    if (!room) return [];

    return [...room.users.entries()].map(
        ([id, user]) => ({
            id,
            name: user.name,
            role: user.role,
            camera: user.camera,
            mic: user.mic,
            hand: user.hand
        })
    );
}


function broadcastParticipants(roomCode) {

    if (!rooms.has(roomCode)) return;

    io.to(roomCode).emit(
        "participants",
        getParticipants(roomCode)
    );
}


/* =====================================================
   REMOVE USER
===================================================== */

function removeUser(socket) {

    const roomCode = socket.data.room;

    if (!roomCode) return;

    const room = rooms.get(roomCode);

    if (!room) return;

    room.users.delete(socket.id);

    socket.to(roomCode).emit(
        "peer-left",
        {
            id: socket.id
        }
    );

    broadcastParticipants(roomCode);

    if (room.users.size === 0) {
        rooms.delete(roomCode);
    }

    socket.data.room = null;
}


/* =====================================================
   SOCKET
===================================================== */

io.on("connection", socket => {


    /* =================================================
       CREATE ROOM
    ================================================= */

    socket.on(
        "create-room",
        (data, callback) => {

            const roomCode =
                createRoomCode();

            let name =
                String(data?.name || "Guru")
                    .trim()
                    .substring(0, 40);

            if (!name) {
                name = "Guru";
            }


            rooms.set(roomCode, {

                host: socket.id,

                users: new Map([
                    [
                        socket.id,
                        {
                            name,
                            role: "teacher",
                            camera: true,
                            mic: true,
                            hand: false
                        }
                    ]
                ])

            });


            socket.join(roomCode);

            socket.data.room = roomCode;
            socket.data.role = "teacher";


            if (callback) {

                callback({
                    ok: true,
                    code: roomCode
                });

            }


            broadcastParticipants(roomCode);

        }
    );


    /* =================================================
       JOIN ROOM
    ================================================= */

    socket.on(
        "join-room",
        (data, callback) => {

            const roomCode =
                String(data?.code || "")
                    .trim()
                    .toUpperCase();


            const room =
                rooms.get(roomCode);


            if (!room) {

                return callback({
                    ok: false,
                    error: "Meeting tidak ditemukan."
                });

            }


            if (
                room.users.size >=
                MAX_PARTICIPANTS
            ) {

                return callback({
                    ok: false,
                    error:
                        "Meeting penuh. Maksimal 20 peserta."
                });

            }


            let name =
                String(data?.name || "Siswa")
                    .trim()
                    .substring(0, 40);

            if (!name) {
                name = "Siswa";
            }


            const existingPeers =
                [...room.users.entries()]
                    .map(
                        ([id, user]) => ({
                            id,
                            name: user.name,
                            role: user.role
                        })
                    );


            room.users.set(
                socket.id,
                {
                    name,
                    role: "student",
                    camera: true,
                    mic: true,
                    hand: false
                }
            );


            socket.join(roomCode);

            socket.data.room = roomCode;
            socket.data.role = "student";


            callback({
                ok: true,
                code: roomCode,
                existingPeers
            });


            socket.to(roomCode).emit(
                "peer-joined",
                {
                    id: socket.id,
                    name,
                    role: "student"
                }
            );


            broadcastParticipants(roomCode);

        }
    );


    /* =================================================
       WEBRTC OFFER
    ================================================= */

    socket.on(
        "offer",
        data => {

            if (!data?.to || !data?.offer) {
                return;
            }


            io.to(data.to).emit(
                "offer",
                {
                    from: socket.id,
                    offer: data.offer
                }
            );

        }
    );


    /* =================================================
       WEBRTC ANSWER
    ================================================= */

    socket.on(
        "answer",
        data => {

            if (!data?.to || !data?.answer) {
                return;
            }


            io.to(data.to).emit(
                "answer",
                {
                    from: socket.id,
                    answer: data.answer
                }
            );

        }
    );


    /* =================================================
       ICE
    ================================================= */

    socket.on(
        "ice-candidate",
        data => {

            if (
                !data?.to ||
                !data?.candidate
            ) {
                return;
            }


            io.to(data.to).emit(
                "ice-candidate",
                {
                    from: socket.id,
                    candidate: data.candidate
                }
            );

        }
    );


    /* =================================================
       MEDIA STATE
    ================================================= */

    socket.on(
        "media-state",
        data => {

            const room =
                rooms.get(
                    socket.data.room
                );

            if (!room) return;


            const user =
                room.users.get(
                    socket.id
                );

            if (!user) return;


            user.camera =
                !!data.camera;

            user.mic =
                !!data.mic;


            socket.to(
                socket.data.room
            ).emit(
                "media-state",
                {
                    id: socket.id,
                    camera: user.camera,
                    mic: user.mic
                }
            );


            broadcastParticipants(
                socket.data.room
            );

        }
    );


    /* =================================================
       RAISE HAND
    ================================================= */

    socket.on(
        "raise-hand",
        data => {

            const room =
                rooms.get(
                    socket.data.room
                );

            if (!room) return;


            const user =
                room.users.get(
                    socket.id
                );

            if (!user) return;


            user.hand =
                !!data.hand;


            io.to(
                socket.data.room
            ).emit(
                "hand-state",
                {
                    id: socket.id,
                    hand: user.hand
                }
            );


            broadcastParticipants(
                socket.data.room
            );

        }
    );


    /* =================================================
       CHANGE NAME
    ================================================= */

    socket.on(
        "change-name",
        (data, callback) => {

            const room =
                rooms.get(
                    socket.data.room
                );


            if (!room) {

                if (callback) {

                    callback({
                        ok: false,
                        error:
                            "Meeting tidak ditemukan."
                    });

                }

                return;
            }


            const user =
                room.users.get(
                    socket.id
                );


            if (!user) return;


            let newName =
                String(data?.name || "")
                    .trim()
                    .substring(0, 40);


            if (!newName) {

                if (callback) {

                    callback({
                        ok: false,
                        error:
                            "Nama tidak boleh kosong."
                    });

                }

                return;
            }


            user.name =
                newName;


            if (callback) {

                callback({
                    ok: true,
                    name: newName
                });

            }


            socket.to(
                socket.data.room
            ).emit(
                "name-changed",
                {
                    id: socket.id,
                    name: newName
                }
            );


            broadcastParticipants(
                socket.data.room
            );

        }
    );


    /* =================================================
       CHAT
    ================================================= */

    socket.on(
        "chat-message",
        data => {

            const roomCode =
                socket.data.room;

            if (!roomCode) return;


            const room =
                rooms.get(roomCode);

            if (!room) return;


            const user =
                room.users.get(socket.id);

            if (!user) return;


            let message =
                String(data?.message || "")
                    .trim()
                    .substring(0, 500);


            if (!message) return;


            io.to(roomCode).emit(
                "chat-message",
                {
                    id: socket.id,
                    name: user.name,
                    message,
                    time: Date.now()
                }
            );

        }
    );


    /* =================================================
       LEAVE
    ================================================= */

    socket.on(
        "leave-room",
        () => {

            removeUser(socket);

        }
    );


    /* =================================================
       DISCONNECT
    ================================================= */

    socket.on(
        "disconnect",
        () => {

            removeUser(socket);

        }
    );

});


/* =====================================================
   SERVER
===================================================== */

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `CLASSROOM LIVE running on port ${PORT}`
        );

    }
);
