# Forty Thrones

Papan digital abadi dengan 40 petak ("takhta"). Setiap petak menampilkan satu gambar dan satu caption. Siapa pun bisa merebutnya dengan membayar **minimal 10% lebih tinggi** dari harga terakhir, setelah masa kunci berakhir. Pemilik lama kehilangan petak dan uangnya tidak kembali, tetapi nama dan pembayarannya tercatat permanen.

Kode ini mengimplementasikan seluruh mekanisme dari dokumen proposal. Tanpa framework dan tanpa build step: Node.js + Express + SQLite, frontend HTML/CSS/JS biasa.

## Jalankan di komputer sendiri

Butuh Node.js 20 atau lebih baru.

```bash
npm install
cp .env.example .env
npm start
```

Buka http://localhost:3000. Di mode development (tanpa `GOOGLE_CLIENT_ID`), login memakai email apa saja, dan pembayaran memakai halaman checkout palsu (`PAYMENT_PROVIDER=mock`). Tidak ada uang sungguhan yang bergerak.

Tes otomatis: `npm test` (harga, QC gambar dan caption, dan alur perebutan lengkap termasuk kunci, riwayat, peringkat, moderasi, dan hapus akun).

## Mekanisme yang sudah ada

| Aturan proposal | Di kode |
|---|---|
| 40 petak tetap, papan melingkar 11x11 | `src/db.js`, `public/app.js` (`position`) |
| Harga lantai, lalu minimal +10% (dibulatkan ke atas, hitungan sen bulat) | `src/pricing.js` |
| Masa kunci, sisa waktu tidak ditampilkan | `FREEZE_HOURS`, `src/game.js` (`locked` saja yang dikirim ke klien) |
| Uang hangus, riwayat permanen per petak | tabel `claims`, `getTile()` |
| Satu gambar + caption, tanpa link, gambar terkunci setelah bayar | `src/qc.js`, gambar disimpan per klaim dan tidak ada endpoint ganti |
| QC otomatis sebelum bayar, gagal = unggah ulang tanpa biaya | `processImage()` jalan sebelum klaim dan checkout dibuat |
| Tombol report di tiap petak | `POST /api/reports`, `/api/admin/overview` |
| Google Sign-In, username unik dan permanen | `src/auth.js` |
| Notifikasi netral ke pemilik lama | `src/notify.js` (satu-satunya email yang dikirim) |
| Persetujuan eksplisit (18+, tanpa refund) dan catatannya | kolom `consent_*` di `claims` |
| Peringkat: terkaya, terlama bertahan, plus usulan tambahan | `getRankings()` |
| Batas pengeluaran per akun (opsional) | `MAX_SPEND_PER_ACCOUNT_CENTS` |
| Hapus akun = riwayat tetap, nama dianonimkan | `DELETE /api/me` |
| Tanpa hadiah, acak, tim, musim, balas dendam, hitung mundur | memang tidak ada |

## Hal-hal yang masih harus Anda putuskan atau isi

1. **Lama masa kunci.** Default `FREEZE_HOURS=24` hanyalah tempat penampung. Angka ini otomatis tampil di formulir pembayaran. Samakan dengan Syarat & Ketentuan.
2. **Teks `public/terms.html` dan `public/privacy.html`** adalah draf awal dari proposal, bukan nasihat hukum. Isi bagian dalam kurung siku, periksa ke sumber resmi, dan naikkan `CONSENT_VERSION` setiap teks berubah.
3. **Moderasi gambar.** QC saat ini memeriksa format, ukuran, dan proporsi, lalu men-decode ulang gambar (membuang metadata). Ini **tidak** mendeteksi konten dewasa, teks, atau QR code di dalam gambar. Colokkan layanan moderasi di fungsi `moderateImage()` pada `src/qc.js`. Sampai itu ada, tombol report dan fitur hapus oleh admin adalah satu-satunya pertahanan. Untuk produksi, ini sebaiknya jangan dilewati.
4. **Filter link di caption** menangkap URL, `www`, domain umum, dan beberapa trik penulisan ("foo(dot)com"). Pengguna yang gigih bisa saja menemukan celah, jadi tombol report tetap penting.

## Pembayaran

`PAYMENT_PROVIDER` bisa `mock` (hanya untuk development; server menolak start di production) atau `lemonsqueezy`.

Alur Lemon Squeezy (`src/payments/lemonsqueezy.js`):

1. Buat produk dan satu variant di dashboard Lemon Squeezy (harga bebas, karena harga dikirim per transaksi lewat `custom_price`).
2. Isi `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`.
3. Buat webhook di dashboard ke `https://DOMAIN-ANDA/webhooks/lemonsqueezy` untuk event `order_created`, isi secret-nya ke `LEMONSQUEEZY_WEBHOOK_SECRET`.
4. Tes dengan test mode sebelum live.

**Penting: verifikasi dulu.** Kode ditulis dari dokumentasi API yang saya ketahui dan belum pernah dijalankan terhadap akun Lemon Squeezy sungguhan. Cek ulang bentuk request/webhook dan `custom_price` di dokumentasi resmi mereka. Pastikan juga mereka menerima model "uang hangus" ini di kebijakan produk mereka, sebelum membangun lebih jauh. Penyedia lain (Paddle) bisa dipasang dengan membuat file baru di `src/payments/` yang punya `createCheckout()` dan fungsi pembaca webhook, lalu didaftarkan di `src/payments/index.js`.

### Dua orang membayar untuk petak yang sama

Petak tidak "dikunci" selama checkout berlangsung. Jika dua orang membayar hampir bersamaan, pembayaran yang tiba kedua akan ditolak oleh `confirmPayment()` dan klaimnya berstatus `needs_refund`. Pengguna melihat pesan bahwa pembayaran akan dikembalikan. **Refund itu harus Anda lakukan manual** dari dashboard penyedia pembayaran. Daftarnya ada di:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://DOMAIN-ANDA/api/admin/overview
```

## Admin

Tanpa UI admin, hanya API (diamankan `ADMIN_TOKEN`):

```bash
# laporan terbuka dan antrean refund
curl -H "Authorization: Bearer $ADMIN_TOKEN" $BASE_URL/api/admin/overview
# hapus gambar dan caption sebuah klaim (nama dan pembayaran tetap di riwayat, tanpa refund)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"reason":"abuse"}' $BASE_URL/api/admin/claims/12/remove
```

## Deploy

Aplikasi menyimpan database SQLite dan gambar di `DATA_DIR`. **Folder itu harus berada di disk persisten**, dan karena produk ini abadi, **cadangkan secara rutin** (misalnya salin `forty-thrones.sqlite` dan folder `uploads/` ke penyimpanan lain). Jalankan hanya satu instance.

Contoh dengan Docker:

```bash
docker build -t forty-thrones .
docker run -d --name ft -p 3000:3000 -v ft-data:/data --env-file .env forty-thrones
```

Taruh di belakang HTTPS (Caddy, Nginx, atau platform seperti Fly.io, Railway, atau VPS). Di production wajib: `NODE_ENV=production`, `SESSION_SECRET` acak, `BASE_URL` yang benar (https), `GOOGLE_CLIENT_ID`, dan `PAYMENT_PROVIDER=lemonsqueezy`.

### Google Sign-In

Buat OAuth client tipe Web di Google Cloud Console, tambahkan `BASE_URL` sebagai Authorized JavaScript origin, lalu isi `GOOGLE_CLIENT_ID`.

## Sebelum peluncuran publik

Dari proposal, dan masih di luar kode ini: daftar PSE (Komdigi), badan usaha, NIB/NPWP, konsultasi pajak (PPN lintas negara), teks S&K dan privasi final, serta pengecekan nama dan merek dagang.

## Struktur

```
src/server.js     rute HTTP, keamanan (helmet, rate limit, cek origin)
src/game.js       aturan permainan: klaim, konfirmasi bayar, riwayat, peringkat, moderasi
src/pricing.js    hitungan harga (integer sen)
src/qc.js         validasi caption, username, dan gambar
src/auth.js       Google Sign-In, sesi cookie
src/payments/     mock dan Lemon Squeezy
src/notify.js     email netral ke pemilik lama
public/           frontend (tanpa build)
tests/            tes otomatis
```
