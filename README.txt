CLASSROOM LIVE — HOSTING READY

File ini dibuat untuk hosting Node.js yang menyediakan HTTPS otomatis.

Paling mudah:
1. Upload folder/repository ini ke hosting Node.js.
2. Build command: npm install
3. Start command: npm start
4. Hosting akan memberi URL HTTPS.
5. Buka URL tersebut di HP/laptop.
6. Create Meeting -> kirim link ke siswa.
7. Maksimal 10 siswa per room.

Tidak perlu Node.js/npm/VS Code di HP siswa.

Catatan:
- Kamera dan microphone memerlukan HTTPS.
- WebRTC memakai STUN. Pada jaringan yang sangat ketat, TURN mungkin diperlukan.
- Server menyimpan room hanya di memory; restart server akan menghapus room aktif.
