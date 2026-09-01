CLASSROOM LIVE FINAL
=====================
Upload these EXACTLY:
- server.js
- package.json
- public/index.html

Railway command: npm start

Important:
- This fixes the main WebRTC bug: ICE candidates are queued instead of being discarded before remoteDescription exists.
- Only the newly joined participant creates offers to existing participants, preventing offer collisions.
- Remote audio is explicitly unmuted and played.
- Microphone uses echoCancellation, noiseSuppression, autoGainControl and mono audio.
- Camera is not mirrored.
- Raise hand, participants, rename and chat are included.
- Maximum is 20, but this is WebRTC mesh, NOT SFU. Twenty participants can be heavy.
- The previous virtual-background implementation was removed because it replaced the camera stream incorrectly and caused the face/video to disappear. Do not re-add that broken implementation.
- Railway HTTPS is required for camera/microphone.
