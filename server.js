const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: true,
        methods: ["GET", "POST"]
    },
    transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 3000;

const MAX_PARTICIPANTS = 20;
const MAX_ACTIVE_MIC = 3;

const rooms = new Map();

const publicPath = path.join(__dirname, "public");

app.use(express.static(publicPath));

app.get("/", (req, res) => {
    res.sendFile(path.join(publicPath, "index.html"));
});

app.get("/meeting/:code", (req, res) => {
    res.sendFile(path.join(publicPath, "index.html"));
});


/* =========================================================
   ROOM CODE
========================================================= */

function createCode() {

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


/* =========================================================
   COUNT ACTIVE MICROPHONES
========================================================= */

function countActiveMics(room) {

    if (!room) return 0;

    let count = 0;

    for (const user of room.users.values()) {

        if (user.mic === true) {
            count++;
        }
    }

    return count;
}


/* =========================================================
   PARTICIPANTS
========================================================= */

function getParticipants(roomCode) {

    const room = rooms.get(roomCode);

    if (!room) return [];

    return [
        ...room.users.entries()
    ].map(
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


function sendParticipants(roomCode) {

    if (!rooms.has(roomCode)) return;

    io.to(roomCode).emit(
        "participants",
        getParticipants(roomCode)
    );
}


/* =========================================================
   REMOVE USER
========================================================= */

function removeUser(socket) {

    const roomCode =
        socket.data.room;

    if (!roomCode) return;

    const room =
        rooms.get(roomCode);

    if (!room) return;

    room.users.delete(socket.id);

    socket.to(roomCode).emit(
        "peer-left",
        socket.id
    );

    sendParticipants(roomCode);

    if (room.users.size === 0) {

        rooms.delete(roomCode);
    }

    socket.data.room = null;
    socket.data.role = null;
}


/* =========================================================
   CONNECTION
========================================================= */

io.on("connection", socket => {


    /* =====================================================
       CREATE ROOM
    ===================================================== */

    socket.on(
        "create-room",
        (data, callback) => {

            const roomCode =
                createCode();

            let name =
                String(
                    data?.name || "Guru"
                )
                    .trim()
                    .substring(0, 40);

            if (!name) {
                name = "Guru";
            }


            rooms.set(
                roomCode,
                {
                    host: socket.id,

                    users: new Map([
                        [
                            socket.id,
                            {
                                name,
                                role: "teacher",
                                camera: true,

                                /*
                                 * Guru otomatis mendapat
                                 * microphone pertama.
                                 */
                                mic: true,

                                hand: false
                            }
                        ]
                    ])
                }
            );


            socket.join(roomCode);

            socket.data.room =
                roomCode;

            socket.data.role =
                "teacher";


            if (callback) {

                callback({
                    ok: true,
                    code: roomCode
                });
            }


            sendParticipants(
                roomCode
            );
        }
    );


    /* =====================================================
       JOIN ROOM
    ===================================================== */

    socket.on(
        "join-room",
        (data, callback) => {

            const roomCode =
                String(
                    data?.code || ""
                )
                    .trim()
                    .toUpperCase();


            const room =
                rooms.get(roomCode);


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


            if (
                room.users.size >=
                MAX_PARTICIPANTS
            ) {

                if (callback) {

                    callback({
                        ok: false,
                        error:
                            "Meeting penuh. Maksimal 20 peserta."
                    });
                }

                return;
            }


            const existingPeers =
                [
                    ...room.users.entries()
                ].map(
                    ([id, user]) => ({
                        id,
                        name: user.name,
                        role: user.role
                    })
                );


            let name =
                String(
                    data?.name || "Siswa"
                )
                    .trim()
                    .substring(0, 40);


            if (!name) {
                name = "Siswa";
            }


            /*
             * Tentukan microphone siswa.
             *
             * Jika jumlah mic sudah 3,
             * siswa tetap masuk meeting
             * tetapi microphone OFF.
             */

            let requestedMic =
                data?.mic === true;

            let approvedMic = false;


            if (requestedMic) {

                if (
                    countActiveMics(room) <
                    MAX_ACTIVE_MIC
                ){

                    approvedMic = true;

                }else{

                    approvedMic = false;
                }

            }


            room.users.set(
                socket.id,
                {
                    name,
                    role: "student",
                    camera:
                        data?.camera !== false,
                    mic: approvedMic,
                    hand: false
                }
            );


            socket.join(roomCode);

            socket.data.room =
                roomCode;

            socket.data.role =
                "student";


            if (callback) {

                callback({
                    ok: true,
                    code: roomCode,
                    existingPeers,

                    /*
                     * Kirim keadaan mic
                     * sebenarnya dari server.
                     */
                    mic: approvedMic
                });
            }


            if (
                requestedMic &&
                !approvedMic
            ){

                socket.emit(
                    "mic-limit",
                    {
                        max:
                            MAX_ACTIVE_MIC,

                        message:
                            "Maksimal 3 microphone aktif. Microphone kamu dimatikan."
                    }
                );
            }


            socket.to(roomCode).emit(
                "peer-joined",
                {
                    id: socket.id,
                    name,
                    role: "student"
                }
            );


            sendParticipants(
                roomCode
            );
        }
    );


    /* =====================================================
       OFFER
    ===================================================== */

    socket.on(
        "offer",
        data => {

            if (!data?.to) return;

            if (!data?.offer) return;

            io.to(data.to).emit(
                "offer",
                {
                    from: socket.id,
                    offer: data.offer
                }
            );
        }
    );


    /* =====================================================
       ANSWER
    ===================================================== */

    socket.on(
        "answer",
        data => {

            if (!data?.to) return;

            if (!data?.answer) return;

            io.to(data.to).emit(
                "answer",
                {
                    from: socket.id,
                    answer: data.answer
                }
            );
        }
    );


    /* =====================================================
       ICE
    ===================================================== */

    socket.on(
        "ice-candidate",
        data => {

            if (!data?.to) return;

            if (!data?.candidate) return;

            io.to(data.to).emit(
                "ice-candidate",
                {
                    from: socket.id,
                    candidate: data.candidate
                }
            );
        }
    );


    /* =====================================================
       MEDIA STATE
    ===================================================== */

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


            /*
             * CAMERA
             *
             * Camera tidak dibatasi.
             */

            user.camera =
                data?.camera !== false;


            /*
             * MICROPHONE
             *
             * Server yang menentukan.
             */

            const requestedMic =
                data?.mic === true;


            if (!requestedMic) {

                /*
                 * User ingin mematikan mic.
                 */

                user.mic = false;

            } else if (!user.mic) {

                /*
                 * User ingin menyalakan mic.
                 */

                const activeMics =
                    countActiveMics(room);


                if (
                    activeMics <
                    MAX_ACTIVE_MIC
                ){

                    user.mic = true;

                }else{

                    user.mic = false;

                    socket.emit(
                        "mic-limit",
                        {
                            max:
                                MAX_ACTIVE_MIC,

                            active:
                                activeMics,

                            message:
                                "Maksimal 3 microphone aktif. Matikan microphone peserta lain terlebih dahulu."
                        }
                    );
                }
            }


            io.to(
                socket.data.room
            ).emit(
                "media-state",
                {
                    id: socket.id,
                    camera: user.camera,
                    mic: user.mic
                }
            );


            sendParticipants(
                socket.data.room
            );
        }
    );


    /* =====================================================
       RAISE HAND
    ===================================================== */

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
                !!data?.hand;


            io.to(
                socket.data.room
            ).emit(
                "hand-state",
                {
                    id: socket.id,
                    hand: user.hand
                }
            );


            sendParticipants(
                socket.data.room
            );
        }
    );


    /* =====================================================
       CHANGE NAME
    ===================================================== */

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
                String(
                    data?.name || ""
                )
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


            io.to(
                socket.data.room
            ).emit(
                "name-changed",
                {
                    id: socket.id,
                    name: newName
                }
            );


            sendParticipants(
                socket.data.room
            );
        }
    );


    /* =====================================================
       CHAT
    ===================================================== */

    socket.on(
        "chat-message",
        data => {

            const roomCode =
                socket.data.room;

            if (!roomCode) return;


            const room =
                rooms.get(
                    roomCode
                );

            if (!room) return;


            const user =
                room.users.get(
                    socket.id
                );

            if (!user) return;


            let message =
                String(
                    data?.message || ""
                )
                    .trim()
                    .substring(0, 500);


            if (!message) return;


            io.to(roomCode).emit(
                "chat-message",
                {
                    id: socket.id,
                    name: user.name,
                    role: user.role,
                    message,
                    time: Date.now()
                }
            );
        }
    );


    /* =====================================================
       LEAVE
    ===================================================== */

    socket.on(
        "leave-room",
        () => {

            removeUser(socket);
        }
    );


    /* =====================================================
       DISCONNECT
    ===================================================== */

    socket.on(
        "disconnect",
        () => {

            removeUser(socket);
        }
    );

});


/* =========================================================
   SERVER START
========================================================= */

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `CLASSROOM LIVE running on port ${PORT}`
        );

        console.log(
            `Maximum participants: ${MAX_PARTICIPANTS}`
        );

        console.log(
            `Maximum active microphones: ${MAX_ACTIVE_MIC}`
        );
    }
);
