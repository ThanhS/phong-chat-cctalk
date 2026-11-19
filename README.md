# Phòng chat ccTalk — bản test

Bản test phòng chat kiểu ccTalk: phòng riêng, chat, voice (PeerJS / LiveKit), game Lô Tô.
Mở link GitHub Pages của repo này để chạy thử.

Lưu ý: trang kết nối tới token-server qua hub WebSocket để chat, phòng và
Lô Tô đồng bộ giữa các máy (xem mục bên dưới). Khi chưa nhập địa chỉ máy
chủ đăng nhập thì trang chạy chế độ bot demo local từng máy. Voice trực
tiếp giữa 2 máy cần PeerJS (miễn phí) hoặc LiveKit Cloud + token-server.

## Máy chủ đăng nhập + token voice (token-server)

Thư mục `token-server/` là máy chủ Node đăng nhập + cấp token LiveKit
(đăng nhập phía máy chủ, mật khẩu băm scrypt, không còn mật khẩu trong trang).
Chạy online bằng 1 trong 2 cách:
- **Render miễn phí:** mở https://render.com/deploy?repo=https://github.com/ThanhS/phong-chat-cctalk
  (file `render.yaml` ở gốc repo), đăng nhập Render bằng GitHub, điền các biến
  môi trường được hỏi (3 giá trị LiveKit Cloud + mật khẩu tài khoản demo), bấm Deploy.
  Render cấp địa chỉ HTTPS miễn phí, trang phòng chat nhập địa chỉ này vào ô
  "Máy chủ đăng nhập". Gói miễn phí ngủ sau 15 phút không dùng, lần gọi đầu
  sau đó mất ~30-60 giây để tỉnh lại.
- **VPS (Docker):** xem `docker-compose.yml` / `docker-compose.cloud.yml`
  và `.env.example` ở gốc repo.

## Đồng bộ chat, phòng, Lô Tô giữa các máy (hub WebSocket)

Từ bản v3, token-server có thêm hub WebSocket `/ws`: chat chữ, danh sách
người online, phòng tự tạo và vòng Lô Tô được đồng bộ giữa tất cả máy
đang mở trang (đăng nhập bằng session phía máy chủ). Mỗi phòng có 35 bot
máy chủ tự chat cho đông vui; Lô Tô 1 vòng/phòng, 10 bot chơi cùng.
Nhạc Lô Tô nằm trong thư mục `assets/loto/` (01–90 + intro).

### v3.3 — Chống spam / lạm dụng theo IP

- `POST /login`: tối đa 20 lần / 5 phút / IP; `POST /register`: tối đa
  5 tài khoản / 1 giờ / IP; `GET|POST /token`: tối đa 60 lần / 5 phút / IP.
- WebSocket: tối đa 10 kết nối cùng lúc / IP; chat tối đa 10 tin / 10 giây / IP.
- Phòng tự tạo: mỗi người tối đa 5 phòng, tối đa 50 phòng toàn máy chủ.
- Các giới hạn này chống lạm dụng (spam, dò mật khẩu, tạo nick rác),
  không chống được DDoS lớn — cần Cloudflare (cần tên miền riêng).
