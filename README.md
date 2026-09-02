# CLASSROOM LIVE

Real-time online classroom built with Node.js, Express, Socket.IO and WebRTC.

## What this version does

- Real camera and microphone using `getUserMedia()`.
- Browser echo cancellation, noise suppression and automatic gain control.
- Real-time audio/video through WebRTC; Socket.IO is signaling/control only.
- Symmetric participant view for small classrooms using WebRTC Mesh.
- Lobby with camera preview and microphone/speaker controls.
- Camera/microphone toggle and restart.
- Device selection and device-change detection.
- Screen sharing with `replaceTrack()`.
- Chat, raise hand and participant list.
- Teacher controls: remove participant, lock/unlock, end meeting.
- Participant cleanup on leave/disconnect.
- Socket.IO reconnect plus WebRTC ICE restart attempts.
- Connection statistics and conservative adaptive video bitrate/framerate.
- Audio-only mode, fullscreen and Picture-in-Picture when supported.
- `/health` endpoint for deployment health checks.

## Important architecture limitation

This version intentionally uses WebRTC Mesh because it is simple to deploy and understand. Mesh sends a separate peer connection for each participant, so bandwidth/CPU usage grows quickly as the class grows. It is suitable for small classroom testing, not a replacement for a large-scale Zoom/Google Meet SFU architecture.

For larger classes, move the media layer to an SFU such as mediasoup, LiveKit, Janus or another SFU. The UI and room/control concepts can be retained.

## Run locally

1. Install Node.js 18+.
2. Open a terminal inside this folder.
3. Run:

```bash
npm install
npm start
```

4. Open `http://localhost:3000`.
5. Click **Create Meeting** and allow camera/microphone.
6. Copy the room code.
7. Open a second browser/device and use **Join Meeting**.

For real camera/microphone on production hosting, use HTTPS. `localhost` is treated as a secure context by modern browsers.

## TURN configuration

STUN is configured client-side with a public STUN fallback for development. For production reliability, provide a TURN server. Do not put TURN credentials in GitHub.

Recommended production environment variables are:

- `PORT`
- `STUN_URL`
- `TURN_URL`
- `TURN_USERNAME`
- `TURN_PASSWORD`

The current client reads a runtime ICE configuration object if one is injected by your deployment. If you want server-side TURN configuration exposed safely, add a small `/config` endpoint that returns only the required public ICE settings. Never return unrelated secrets.

## Railway / Render

1. Push this folder to GitHub.
2. Create a Node.js service from the repository.
3. The start command is `npm start`.
4. The server uses `process.env.PORT || 3000`.
5. The platform HTTPS URL provides the secure context required for camera/microphone.
6. Test `/health`; it should return:

```json
{"ok":true}
```

## Troubleshooting

### Camera denied

Allow camera access for the site in browser permissions, then use **Restart camera & mic** or reload the lobby.

### Microphone denied

Allow microphone access and check the selected input device. A headset is recommended when possible because it naturally reduces acoustic feedback.

### No sound

Check browser/system output volume, make sure the remote participant is not muted locally, and test with two separate devices/headsets.

### Echo

Do not play the local microphone stream back to the local speaker. This application keeps the local preview muted and enables browser audio processing constraints. Using speakers near a microphone can still create acoustic feedback; a headset is the most reliable physical fix.

### Room not found

The room is held in server memory. Restarting the Node process removes active rooms. For production, persistent room metadata can be added without storing media.

### Connection fails

A direct WebRTC path may fail behind restrictive NAT/firewalls. Configure a real TURN server for production. STUN alone cannot relay media.

### HTTPS requirement

Camera/microphone APIs generally require a secure context. Use HTTPS in production; `localhost` works for local development.

## Testing checklist

- Teacher creates a room.
- Student joins and both can see/hear each other.
- A second student joins and all three can see/hear each other.
- Toggle camera while keeping audio active.
- Toggle microphone and confirm remote audio stops.
- Leave one participant and confirm their card/audio/peer disappears.
- Test screen sharing and stopping it.
- Lock the room and confirm a new join is rejected.
- End the meeting and confirm all clients return to the home page.
- Temporarily change networks and observe reconnect behavior.

## Honest quality note

The project uses browser-provided WebRTC audio processing and conservative network adaptation. No browser application can guarantee Zoom/Google Meet quality under every network/device condition. For large classes and the strongest reliability, an SFU, TURN infrastructure, telemetry and server-side media controls are required.
