# Máy chủ voice cho phòng chat kiểu ccTalk

Voice trực tiếp nhiều máy (điện thoại + PC) theo phòng, dùng **LiveKit** — SFU WebRTC
mã nguồn mở. Trang phòng chat test hiện tại là trang tĩnh nên không tự voice được;
gói này là phần máy chủ còn thiếu.

```
Điện thoại / PC (trình duyệt, livekit-client)
        │  1. xin token (POST /token)          2. voice WebRTC (wss + UDP)
        ▼                                     ▼
  token-server (Node, cổng 3001)      LiveKit server (cổng 7880/7881 + UDP 50000-60000)
        │ ký JWT bằng API secret
        └─ quyền publish theo cấp bậc (xem dưới)
```

## Phòng và quyền

| Phòng trong artifact | Room LiveKit |
|---|---|
| Giao Lưu Kết Bạn (ID 208) | `giao-luu-ket-ban` |
| Đại Sảnh (ID 101) | `dai-sanh` |
| Giao Lưu (ID 102) | `giao-luu` |
| Hỗ trợ (ID 103) | `ho-tro` |

| Cấp bậc | Quyền voice |
|---|---|
| QTV áo đỏ (`qtv`), BĐH áo đen/vàng/tím (`bdh-den`, `bdh-vang`, `bdh-tim`) | Nghe + nói luôn (`canPublish: true`) |
| Thành viên thường (`member`) | Chỉ nghe; chỉ được nói khi **đang trên mic** — front-end báo qua `POST /stage`, token xin lại lúc đó sẽ có `canPublish: true` |

Token sống 6 giờ (`TOKEN_TTL`). Secret API **không bao giờ** đưa lên trình duyệt —
token chỉ được ký ở token-server.

## Đăng nhập phía máy chủ (v2 — mới)

Từ v2, việc kiểm tra đăng nhập nằm ở token-server, trang web không còn giữ
mật khẩu hay danh sách tài khoản:
- Tài khoản lưu trong `token-server/data/users.json` (chỉ có trên máy chủ,
  đã thêm vào `.gitignore`, không bao giờ commit). Mật khẩu băm scrypt.
- Lần khởi động đầu tiên (chưa có file users): server tự gieo tài khoản từ
  biến môi trường `ADMIN_PASSWORD` (admin/QTV), `BDH_PASSWORD` (bdh/BĐH đen),
  `THANH_PASSWORD` (thanh/thành viên, nếu đặt), `TEST_PASSWORD`
  (test001–test010/thành viên). Từ lần sau, file users.json quyết định.
- Thêm/đổi tài khoản sau này: `node token-server/add-user.js <id> <mật khẩu> [rank] [tên]`
  rồi restart server. Đăng ký tài khoản mới cũng làm được qua `POST /register`
  (chỉ tạo được thành viên thường).
- `SESSION_SECRET` (trong `.env`, sinh bằng `openssl rand -hex 32`) ký
  session đăng nhập (hạn `SESSION_TTL`, mặc định 6h). Đổi secret là mọi phiên
  cũ hết hiệu lực.
- Chống dò mật khẩu: sai 10 lần / ID trong 5 phút thì khóa 5 phút (429).

| Endpoint | Dùng cho |
|---|---|
| `POST /login {id, password}` | Đăng nhập → `{session, id, name, rank}` (401 khi sai) |
| `POST /register {id, password, name?}` | Đăng ký thành viên thường → 201 + session (409 khi trùng ID) |
| `GET /me` (header `Authorization: Bearer <session>`) | Kiểm tra session còn hiệu lực |
| `GET\|POST /token` | **Bắt buộc session** — identity/rank lấy từ session, client gửi rank nào cũng bị bỏ qua (chống giả mạo QTV/BĐH) |
| `POST /stage` | Cần session (identity lấy từ session) hoặc header `x-stage-secret` |

Chế độ cũ (`/token` chấp nhận identity/rank do client gửi) mặc định đã TẮT.
Chỉ bật lại lúc chuyển đổi bằng `ALLOW_LEGACY_TOKEN=1` — không dùng online.

Trang phòng chat (bước tiếp theo) phải gọi `POST /login` rồi giữ `session`
(như cách trang giữ địa chỉ máy chủ voice), gửi kèm khi xin token/lên-xuống
mic; không còn mảng tài khoản/mật khẩu trong mã nguồn trang.

Test: `./test-token.sh` (cần đặt `ADMIN_PASSWORD` + `TEST_PASSWORD` đúng
với lúc gieo tài khoản) — kiểm tra cả đăng nhập sai, giả mạo rank và đăng ký.

## Chat + hiện diện + phòng chung thời gian thực (v3 — mới)

Từ v3, token-server còn là hub WebSocket để 2 máy (điện thoại + PC) thấy
cùng một phòng chat: cùng tin nhắn, cùng danh sách người đang online, cùng
phòng mới tạo. Không có hub này, mỗi máy chạy bot demo riêng nên nội dung
khác nhau.

- Nối: `wss://<host>/ws` (địa chỉ lấy từ ô "Máy chủ đăng nhập" trên trang —
  đổi `http→ws`, `https→wss`, thêm `/ws`). Tin đầu tiên bắt buộc là
  `{type:'auth', token}` với session JWT lấy từ `POST /login`; sai/hết hạn
  hoặc 10s không auth thì bị đóng (4401).
- Vào phòng: `{type:'join', room}` (`208`/`101`/`102`/`103` hoặc slug) →
  nhận `{type:'room-state'}` gồm danh sách người đang online + 50 tin gần
  nhất; mọi người trong phòng nhận `{type:'presence'}` khi có người vào/ra.
- Gửi chat: `{type:'message', room, text}` (1–500 ký tự, tối đa 1 tin/0.8s)
  → server phát `{type:'message', room, msg:{id,userId,name,rank,text,time}}`
  cho mọi người trong phòng (kể cả người gửi).
- Tạo phòng: `{type:'create-room', name}` — chỉ QTV/BĐH; ID tự tăng từ 104,
  phòng mới phát cho mọi người qua `{type:'rooms'}` (đồng thời dùng được
  cho voice qua `POST /token`, room `phong-<id>`). Xóa phòng tự tạo:
  `{type:'delete-room', room}` — chỉ QTV; người đang ở phòng đó nhận
  `{type:'room-closed'}`.
- `GET /health` trả thêm `ws: true`, số `connections` và số `rooms`.

Giới hạn v3: tin nhắn + phòng tự tạo chỉ giữ trong RAM — restart là mất
(Render gói miễn phí không có ổ đĩa bền; tài khoản thì gieo lại từ biến môi
trường nên không mất). Hàng đợi mic và Lô Tô **chưa** đồng bộ qua hub này
(vẫn chạy local từng máy).

Test: `node test-ws.mjs` — tự khởi động server test ở cổng 3102, kiểm tra
30 mục (auth, chat 2 chiều, lịch sử, presence, bot 35/phòng + bot tự chat,
Lô Tô chung: tạo vòng, chốt số, kêu số, KINH, 1 vòng/phòng, tạo phòng,
quyền, /token phòng mới) rồi tắt server và dọn data test.

Mỗi phòng mặc định có sẵn 35 bot (tên + giới tính cố định theo seed) luôn
online và tự chat mỗi ~10s/phòng — bot có mặt trong presence và lịch sử
như người thường, chỉ khác là có thêm trường `bot: true` + `gender` để
trang hiển thị tag BOT.

## Lô Tô chung giữa các máy (v3.2 — mới)

Lô Tô giờ đồng bộ qua hub WebSocket như chat: 1 vòng/phòng, ai cũng thấy
cùng một vòng, cùng danh sách người chơi, cùng số đã kêu, cùng người KINH.
- Tạo vòng: `{type:'loto-create', room, kinh}` — chỉ QTV/BĐH, kinh 2–6 số.
  Đang có vòng mở thì BĐH khác tạo sẽ bị từ chối (`loto-busy`); hết vòng
  (có người KINH) thì người khác tạo được vòng mới. Máy chủ tự sinh 10 bot
  chơi cùng mỗi vòng (số ngẫu nhiên), bot cũng có thể KINH.
- Chốt số: `{type:'loto-join', room, numbers}` — đủ `kinh` số khác nhau
  01–90, chỉ được chốt khi vòng đang chờ (chưa bắt đầu kêu).
- Bắt đầu kêu: `{type:'loto-start', room}` — chỉ chủ vòng (hoặc QTV).
  Mỗi số kêu xong, máy của chủ vòng gửi `{type:'loto-called', room, number}`
  lên máy chủ; máy chủ ghi lại, phát `{type:'loto-called'}` cho cả phòng
  và tự kiểm tra KINH (cả người thật lẫn bot).
- KINH: máy chủ phát `{type:'loto-kinh', room, winner}` và vòng chuyển
  sang `finished`; người chơi cũng có thể tự báo bằng `{type:'loto-kinh'}`.
- Đóng vòng: `{type:'loto-close', room}` — chủ vòng hoặc QTV/BĐH; xong
  thì tạo được vòng mới ngay.
- Trạng thái vòng đầy đủ (`{type:'loto-state'}`) gửi kèm khi vào phòng
  (`room-state.loto`) và phát lại mỗi khi đổi — người vào sau thấy vòng
  đang chơi dở. `GET /health` trả thêm số vòng đang mở (`lotoRounds`).
- Hàng đợi mic vẫn chưa đồng bộ (chạy local từng máy).

## Chạy thử trên máy mình (chưa cần VPS)

Cần: Docker + Docker Compose (máy test), hoặc chỉ Node 20+ để test riêng token-server.

```bash
cd cctalk-voice-server
cp .env.example .env        # sửa LIVEKIT_URL=ws://localhost:7880 để test local
docker compose up -d        # chạy cả LiveKit + token-server
./test-token.sh             # kiểm tra: health, token QTV/member, lên mic, phòng sai, LiveKit
docker compose logs -f      # xem log khi có lỗi
docker compose down         # dừng
```

Chỉ test token-server (không cần Docker):

```bash
cd token-server && npm install
LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... npm start
# cửa sổ khác:
curl "http://localhost:3001/token?room=208&identity=admin&rank=qtv"
```

## Chạy online trên VPS

**VPS tối thiểu:** 2 vCPU, 4 GB RAM, Ubuntu 22.04/24.04, ~60 người/phòng thì
4 GB RAM là vừa (audio-only nhẹ; video mới tốn). Ổ 20 GB. Cài Docker theo
hướng dẫn chính thức của Docker.

**1. Đưa code lên VPS** (scp/git), rồi:

```bash
cd cctalk-voice-server
cp .env.example .env
# SỬA .env: sinh key/secret mới (không dùng giá trị ví dụ):
#   docker run --rm livekit/livekit-server:v1.13.10 generate-keys
# Đặt LIVEKIT_URL=wss://voice.example.com (domain thật, xem bước 2)
docker compose up -d
./test-token.sh
```

**2. Port phải mở trên firewall VPS:**

| Port | Dùng cho |
|---|---|
| 7880 TCP | WebSocket signalling (qua reverse proxy thành `wss://`) |
| 7881 TCP | RTC qua TCP (fallback khi UDP bị chặn) |
| 50000–60000 UDP | Media voice (bắt buộc — voice sẽ rè/mất tiếng nếu chặn) |
| 80/443 TCP | Caddy (SSL + web) |
| 3001 TCP | Token-server (chỉ mở nếu front-end gọi trực tiếp; nếu qua Caddy thì không cần mở) |

**3. Domain + SSL (Caddy, tự cấp chứng chỉ):**
Đổi domain trong `caddy/Caddyfile` (`voice.example.com`, `token.example.com`),
trỏ DNS 2 domain về IP VPS, rồi thêm service Caddy vào compose (hoặc chạy
Caddy riêng trên VPS):

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
volumes:
  caddy-data:
```

Lúc này client dùng `LIVEKIT_URL=wss://voice.example.com` và gọi token qua
`https://token.example.com/token`. **Lưu ý:** media UDP không đi qua Caddy,
vẫn phải mở 50000–60000/UDP thẳng trên firewall.

**4. Kiểm tra server sống:**

```bash
docker compose ps
curl http://localhost:3001/health
./test-token.sh
# từ máy khác: mở trang chat, vào phòng 208 bằng 2 trình duyệt/máy, nói thử
```

## Dùng LiveKit Cloud thay cho LiveKit tự host

Nếu đã đăng ký LiveKit Cloud thì **không cần chạy LiveKit server** — Cloud lo
phần voice, chỉ cần chạy **token-server** để ký token theo phòng/cấp bậc.

**1. Lấy 3 thứ trong dashboard LiveKit Cloud** (giữ kín, đừng gửi cho ai):
- **WebSocket URL**: dạng `wss://xxx-xxxx.livekit.cloud`
- **API Key** và **API Secret** (mục API Keys trong project)

**2. Chạy chỉ token-server + Caddy trên VPS** (không cần mở port UDP vì
voice chạy trên Cloud):

```bash
cd cctalk-voice-server
cp .env.example .env
# Sửa .env:
#   LIVEKIT_URL=wss://xxx-xxxx.livekit.cloud   (URL Cloud của bạn)
#   LIVEKIT_API_KEY=...                        (key Cloud)
#   LIVEKIT_API_SECRET=...                     (secret Cloud)
# Đổi token.example.com trong caddy/Caddyfile.cloud thành domain thật,
# trỏ DNS domain đó về IP VPS.
docker compose -f docker-compose.cloud.yml up -d
curl http://localhost:3001/health
./test-token.sh   # bước kiểm tra LiveKit local sẽ FAIL là bình thường
                  # (không có server local); các bước token phải PASS
```

Chỉ cần mở port **80/443 TCP** (Caddy/SSL) — không cần 7880/7881 hay dải
UDP 50000–60000 nữa.

**3. Nối trang phòng chat:** mở trang test → nút **“Máy chủ voice”** → chọn
chế độ **LiveKit** → nhập **LiveKit URL** là `wss://xxx-xxxx.livekit.cloud`
và **địa chỉ token-server** là `https://token.example.com` (domain thật của
bạn) → **Lưu & kết nối**. Địa chỉ được lưu lại trên máy, lần sau tự nối.

**4. Test:** điện thoại + PC vào cùng 1 phòng, nói thử cả F2 lẫn nói tự do.

Lưu ý: trang chat chạy HTTPS nên token-server **bắt buộc phải HTTPS** — gọi
`http://IP:3001` từ trang sẽ bị trình duyệt chặn (mixed content). Vì vậy
token-server phải đi qua Caddy/domain như trên, đừng gọi thẳng IP.

## Đổi key/secret

1. Sinh cặp mới (`generate-keys` như trên).
2. Sửa `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` trong `.env` (cả 2 service dùng
   chung cặp này: LiveKit đọc qua `LIVEKIT_KEYS`, token-server đọc trực tiếp).
3. `docker compose up -d` (compose tự restart service khi env đổi).
4. Token cũ còn hạn sẽ hết hiệu lực ngay vì secret đã đổi — người đang trong
   phòng phải vào lại phòng để lấy token mới.

## Nối artifact phòng chat vào máy chủ voice

Trang artifact cần thêm `livekit-client` và, trước khi vào phòng, gọi:

```js
// 1. Đăng nhập trước để lấy session (giữ lại, gửi kèm mọi lần gọi sau):
const login = await (await fetch(`${TOKEN_URL}/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: userId, password }),
})).json();
const session = login.session; // rank lấy từ session, không gửi rank nữa
// 2. Xin token LiveKit bằng session:
const r = await fetch(`${TOKEN_URL}/token?room=208`, {
  headers: { Authorization: `Bearer ${session}` },
});
const { token, url } = await r.json();
await room.connect(url, token);           // livekit-client
await room.localParticipant.setMicrophoneEnabled(true); // khi được nói
```

- `room`: `208`/`101`/`102`/`103` hoặc slug `dai-sanh`/`giao-luu`/`ho-tro`.
- `rank`: `qtv` | `bdh-den` | `bdh-vang` | `bdh-tim` | `member`.
- Thành viên lên mic: front-end gọi `POST /stage {room, identity, onStage:true}`,
  rồi xin token mới (token cũ vẫn `canPublish: false` — LiveKit không tự nâng
  quyền token đang dùng). Xuống mic thì gọi `onStage:false`.

## Giới hạn đã biết (đọc trước khi chạy thật)

- **`/stage` và `/token` từ v2 yêu cầu session đăng nhập**, rank lấy từ
  session nên client không tự xưng cấp bậc được nữa. `STAGE_SECRET` vẫn dùng
  được cho code tin cậy phía máy chủ gọi `/stage` kèm header `x-stage-secret`.
- **Chưa có TURN.** Mạng công ty/trường chặn UDP có thể khiến vài người không
  nghe được. Nếu gặp, bật TURN tích hợp của LiveKit trong `config.yaml`
  (`turn: {enabled: true, udp_port: 3478, tls_port: 5349}`) và mở thêm port đó.
- **Chat chữ, hiện diện và phòng đã đồng bộ qua hub WebSocket v3** (xem trên).
  Hàng đợi mic và Lô Tô vẫn chạy local từng máy; Rivet (skill
  `rivet-actors`) là hướng thay thế nếu sau này muốn đồng bộ nốt 2 phần đó.
- **Skill `building-livekit-agents` làm về AI voice agent trên LiveKit Cloud.**
  Gói này không dùng AI agent — chỉ dùng LiveKit mã nguồn mở tự host để
  người-với-người nói chuyện với nhau (cùng cơ chế token/signalling).

## Xử lý nhanh khi lỗi

| Triệu chứng | Thường do |
|---|---|
| Vào phòng được nhưng không nghe ai | UDP 50000–60000 chưa mở, hoặc `LIVEKIT_URL` còn `ws://localhost` khi chạy online |
| Token 401 / `invalid API key` | Key/secret trong `.env` lệch với `LIVEKIT_KEYS` của LiveKit (2 chỗ phải giống nhau) |
| `curl: (7) Failed to connect` tới :3001 | Token-server chưa chạy — xem `docker compose logs token-server` |
| Mic không thu trên điện thoại | Trang phải chạy HTTPS (wss) thì trình duyệt mới cho dùng mic |
