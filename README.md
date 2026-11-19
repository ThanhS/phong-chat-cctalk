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
máy chủ tự chat cho đông vui (từ v3.4 còn 10 bot/phòng); Lô Tô 1 vòng/phòng, 10 bot chơi cùng.
Nhạc Lô Tô nằm trong thư mục `assets/loto/` (01–90 + intro).

### v3.3 — Chống spam / lạm dụng theo IP

- `POST /login`: tối đa 20 lần / 5 phút / IP; `POST /register`: tối đa
  5 tài khoản / 1 giờ / IP; `GET|POST /token`: tối đa 60 lần / 5 phút / IP.
- WebSocket: tối đa 10 kết nối cùng lúc / IP; chat tối đa 10 tin / 10 giây / IP.
- Phòng tự tạo: mỗi người tối đa 5 phòng, tối đa 50 phòng toàn máy chủ.
- Các giới hạn này chống lạm dụng (spam, dò mật khẩu, tạo nick rác),
  không chống được DDoS lớn — cần Cloudflare (cần tên miền riêng).

### v3.4 — Cấp áo BĐH đồng bộ + số người/phòng theo thời gian thực + 10 bot/phòng

- Cấp áo BĐH đồng bộ qua hub (`set-rank`): QTV/đen/vàng cấp áo thấp hơn
  áo mình cho người dưới mình (tím không cấp được gì); rank lưu vào kho
  tài khoản nên người được cấp áo giữ áo khi đổi phòng hay đăng nhập lại,
  mọi máy đều nhận `rank-changed` + presence mới ngay.
- Số người online mỗi phòng (`room-counts`, gồm người thật + bot) phát
  cho mọi máy khi có người vào/ra/tạo/xóa phòng, nên cột phòng trái hiển
  thị đúng theo thời gian thực thay vì chỉ biết phòng mình đang ở.
- Bot máy chủ giảm từ 35 xuống 10/phòng.

### v3.5 — Mã số, điểm, cấp bậc, thưởng điểm, màu chữ, bảo trì

- Mỗi tài khoản có **mã số 9 chữ số ngẫu nhiên, không trùng** (cấp khi
  đăng ký hoặc gieo; tài khoản cũ được bù lúc khởi động), **điểm thành
  viên** (tổng cả quá trình), **điểm tích lũy hôm nay** (tự về 0 khi sang
  ngày mới theo giờ Việt Nam) và **cấp bậc** = min(100, 1 + điểm/40).
  Hồ sơ (`profile`: id, name, rank, gender, code, points, daily, level,
  title) có trong `/login`, `/register`, `/me`, `auth-ok`, presence và
  room-state; bot cũng có mã số/điểm giả lập cố định.
- Cộng điểm: online đủ 1 giờ **+10** (QTV áo đỏ **+15**, BĐH áo đen
  **+12**; nhiều máy cùng lúc chỉ tính 1); mỗi lần được thả tim (`vote`)
  khi đang lên mic **+1** (mỗi cặp cách nhau 5 giây, mỗi người tối đa 60
  vote được tính/giờ). Điểm lưu file theo lô, không ghi mỗi giây.
- Quyền mới: QTV thưởng 1–100 điểm/lần (tối đa 1000/ngày), BĐH áo đen
  thưởng 1–50 điểm/lần (tối đa 300/ngày, chỉ cho người dưới mình)
  (`award`); cả phòng thấy thông báo `awarded`.
- Chat có màu chữ + cỡ chữ (`style`, chỉ nhận màu/cỡ trong danh sách cho
  phép; sai thì bỏ style, tin vẫn gửi).
- Chế độ bảo trì: đặt biến môi trường `MAINTENANCE=1` (tùy chọn
  `MAINTENANCE_MESSAGE`) — `/health` vẫn trả 200 kèm `maintenance:true`,
  còn `/login`, `/register`, `/token` trả 503 và `/ws` đóng mã 4503 để
  trang hiện màn hình chờ bảo trì. Bình thường `/health` có `maintenance:false`.
- Ping/pong mỗi 30 giây dọn kết nối chết (mất mạng, tắt tab đột ngột) để
  số người mỗi phòng luôn khớp thực tế.
- Test local: `node test-ws.mjs` — 90/90 PASS.
