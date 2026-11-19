# Phòng chat ccTalk — bản test

Bản test phòng chat kiểu ccTalk: phòng riêng, chat, voice (PeerJS / LiveKit), game Lô Tô.
Mở link GitHub Pages của repo này để chạy thử.

Lưu ý: đây là bản test front-end tĩnh — tài khoản và phòng chỉ tồn tại trong
phiên mở trang, không có máy chủ lưu trữ chung. Voice trực tiếp giữa 2 máy
cần PeerJS (miễn phí) hoặc LiveKit Cloud + token-server.

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
