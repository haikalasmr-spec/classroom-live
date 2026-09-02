# CLASSROOM LIVE

WebRTC classroom meeting sederhana dengan Node.js, Express, Socket.IO, HTML, CSS, dan Vanilla JavaScript.

## Struktur

```text
classroom-live/
├── package.json
├── server.js
├── README.md
├── .gitignore
└── public/
    ├── index.html
    ├── meeting.html
    ├── style.css
    └── app.js
```

## Jalankan lokal

```bash
npm install
npm start
```

Buka `http://localhost:3000`.

## Test Teacher + Student

1. Browser A → Create Meeting.
2. Izinkan camera dan microphone.
3. Salin room code.
4. Browser B/incognito → Join Meeting dengan room code.
5. Izinkan camera dan microphone.
6. Keduanya seharusnya dapat melihat dan mendengar satu sama lain.
7. Uji mute, camera off, chat, raise hand, screen share, leave, lock, dan end meeting.

Untuk pengujian perangkat berbeda, gunakan laptop + Android/iPhone pada HTTPS deployment.

## HTTPS

Camera dan microphone di production memerlukan secure context (HTTPS). `localhost` tetap dapat dipakai untuk pengujian lokal.

## TURN

STUN bawaan dipakai sebagai fallback. Untuk jaringan yang sulit/NAT ketat, tambahkan TURN server melalui environment variable:

- `TURN_URL` — dapat berisi beberapa URL yang dipisahkan koma
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

Server mengekspos konfigurasi tersebut melalui `/config`; password TURN tidak ditulis ke frontend source.

## Deployment

Gunakan platform Node.js seperti Railway/Render/Fly.io/VPS. Pastikan start command:

```text
npm start
```

Platform harus menyediakan HTTPS. Set environment variable TURN jika diperlukan.

Health check:

```text
/health
```

Contoh respons: `{"ok":true,"rooms":0}`.

## Audio

Input microphone menggunakan echo cancellation, noise suppression, auto gain control, dan mono. Audio tidak diputar kembali dari preview lokal. Remote audio berasal dari track WebRTC pada video element sehingga tidak dibuat audio element duplikat.

Jika banyak peserta, jangan menganggap mesh ini setara dengan infrastruktur Zoom/Meet. Mesh membuat setiap browser berhubungan langsung dengan browser lain dan beban CPU/upload/download meningkat cepat. Server ini membatasi room demo sampai 12 peserta. Untuk kelas besar, arsitektur sebaiknya dipindahkan ke SFU seperti mediasoup/LiveKit/Janus/ion-sfu.

## Troubleshooting

- Camera/mic tidak muncul: izinkan permission pada site settings.
- Di HP tidak bisa: gunakan browser modern dan HTTPS.
- Tidak ada audio: cek mute, volume browser, speaker device, dan gunakan headset saat banyak perangkat berada di ruangan yang sama.
- Koneksi gagal: TURN biasanya diperlukan pada jaringan NAT/firewall tertentu.
- Screen share tidak tersedia: beberapa browser mobile memang membatasi `getDisplayMedia`.
- Jika webcam/headset dicabut: gunakan More → Restart camera & mic.

## Catatan keamanan

Chat dibatasi panjang dan rate-nya. Server memvalidasi membership room dan host controls. Media audio/video tidak melewati Socket.IO; Socket.IO hanya digunakan untuk signaling dan kontrol.
