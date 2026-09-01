# CLASSROOM LIVE — SFU + Railway

Files:
- server.js
- package.json
- public/index.html

Important Railway networking:
1. Deploy this repository from GitHub.
2. Generate the normal HTTPS domain for the web app.
3. Create a TCP Proxy for the SAME Railway service, targeting internal port 40000.
4. Railway gives a proxy hostname and proxy port.
5. Add Railway Variables:
   MEDIA_INTERNAL_PORT=40000
   MEDIA_ANNOUNCED_HOST=<TCP proxy hostname>
   MEDIA_ANNOUNCED_PORT=<TCP proxy port>
6. Redeploy.

The web app uses HTTPS/Socket.IO for signaling and mediasoup for SFU media.
The SFU is configured for TCP because Railway public networking documents HTTP/HTTPS and TCP Proxy; do not assume a normal Railway HTTPS domain exposes UDP.

For best reliability with WebRTC on restrictive networks, a dedicated TURN service may still be needed. The application itself is otherwise self-contained.

The client keeps the existing dark Classroom Live style and includes:
- SFU audio/video
- up to 20 participants per room
- participant panel
- raise hand
- rename
- chat
- camera/mic controls
- local image virtual background
- background removal
- reconnection handling
