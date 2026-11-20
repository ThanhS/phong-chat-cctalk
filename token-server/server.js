// Token server + đăng nhập phía máy chủ cho phòng chat kiểu ccTalk của Thanh.
// V2: kiểm tra đăng nhập nằm ở ĐÂY (phía máy chủ) — trang web không còn giữ
// mật khẩu hay danh sách tài khoản nữa, nên không ai xem nguồn trang mà lấy
// được mật khẩu QTV.
//   - Tài khoản lưu trong data/users.json (chỉ có trên máy chủ, không commit),
//     mật khẩu băm scrypt — xem users.js.
//   - POST /login {id, password} -> session JWT (HMAC, hạn 6h).
//   - POST /register {id, password, name?} -> tạo thành viên thường + session.
//   - GET /me (Bearer session) -> thông tin tài khoản.
//   - GET|POST /token: BẮT BUỘC session — identity/rank lấy từ session,
//     không tin rank do client gửi nữa (chống giả mạo QTV/BĐH).
//     Chế độ cũ (client gửi identity/rank) chỉ bật khi ALLOW_LEGACY_TOKEN=1
//     — mặc định TẮT, chỉ dùng lúc chuyển đổi.
//   - POST /stage: session hoặc header x-stage-secret như trước.
//   - QTV (áo đỏ) + BĐH (áo đen/vàng/tím): publish luôn.
//   - Thành viên thường: chỉ subscribe; chỉ được publish khi đang trên mic
//     (trạng thái mic do front-end báo qua POST /stage).
//
// Chạy:  LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... SESSION_SECRET=... \
//        ADMIN_PASSWORD=... BDH_PASSWORD=... TEST_PASSWORD=... node server.js
// Không dùng framework, chỉ dùng http + crypto có sẵn của Node.
// V3: thêm hub WebSocket /ws — chat + hiện diện + phòng chung giữa các máy
// (chi tiết giao thức ở mục "Hub WebSocket" phía dưới). Tin nhắn và phòng
// tự tạo chỉ giữ trong RAM; restart sẽ mất (Render gói miễn phí không có
// ổ đĩa bền). Hàng đợi mic chưa đồng bộ qua hub này.
// V3.1: bot 10/phòng luôn online + tự chat mỗi ~10s/phòng (giảm từ 35
// xuống 10 theo yêu cầu ngày 19/11/2026 — phòng đỡ rối, vẫn đủ đông vui).
// V3.2: Lô Tô đồng bộ qua hub — 1 vòng/phòng, chủ vòng kêu số, máy chủ
// kiểm tra KINH và phát cho cả phòng (chi tiết ở mục "Lô Tô" phía dưới).
// V3.3: chống spam/lạm dụng theo IP — giới hạn /login, /register, /token,
// chat và số kết nối WS trên 1 IP; mỗi người tối đa 5 phòng tự tạo.
// V3.4: cấp áo BĐH đồng bộ qua hub (set-rank, lưu kho tài khoản, phát
// rank-changed + presence cho mọi máy), phát số người/phòng (room-counts)
// cho mọi máy khi có người vào/ra/tạo/xóa phòng; bot 35 -> 10/phòng.
// V3.5: mã số 9 chữ số ngẫu nhiên cho mọi tài khoản, điểm thành viên (tổng)
// + điểm tích lũy hôm nay + cấp bậc (level); hồ sơ (profile) có trong
// /login, /register, /me, auth-ok, presence, room-state. Cộng điểm: online
// đủ 1 giờ +10 (QTV +15, BĐH đen +12), mỗi vote/thả tim +1; QTV + BĐH đen
// thưởng điểm (award) có hạn mức ngày. Màu + cỡ chữ chat (style, whitelist).
// Chế độ bảo trì MAINTENANCE=1. Ping/pong 30s dọn socket chết để số người
// mỗi phòng luôn khớp thực tế.
// V3.6: lưu trữ bền bằng Postgres (Neon) khi có DATABASE_URL — kho tài
// khoản + phòng tự tạo lưu vào bảng kv (xem db.js) nên không mất khi máy
// chủ khởi động lại; vẫn ghi file data/users.json làm bản sao local. Không
// có DATABASE_URL (hoặc nối DB lỗi lúc khởi động) thì lưu file như cũ.
// V3.7: style chữ chat mở rộng — thêm màu vàng #ffff00, cỡ chữ mọi số
// nguyên 12-20 (trước chỉ 12/14/16/18/20), thêm in đậm/in nghiêng/gạch
// chân (b/i/u, chỉ lưu khi true).

import http from 'node:http';
import crypto from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { WebSocketServer } from 'ws';
import { connectDb, createDbStore } from './db.js';
import {
  loadUsers, saveUsers, usersFileExists, seedFromEnv,
  hashPassword, verifyPassword, validId, RANKS, MANAGER_RANKS, setUserRank,
  TITLES, todayVN, levelOf, genCode, dailyOf, addPoints, ensureUserFields,
} from './users.js';

// ---- Bảo trì + tham số điểm (v3.5) ----------------------------------------
// MAINTENANCE=1: /health vẫn 200 nhưng báo maintenance:true; /login,
// /register, /token trả 503 {error:'maintenance', message}; /ws đóng mã 4503.
const MAINTENANCE = ['1', 'true', 'yes', 'on'].includes(String(process.env.MAINTENANCE || '').toLowerCase());
const MAINTENANCE_MESSAGE = String(process.env.MAINTENANCE_MESSAGE || 'Hệ thống đang bảo trì / cập nhật, vui lòng quay lại sau ít phút.').slice(0, 300);
// 1 "giờ online" (ms) — mặc định 3.600.000; test có thể rút ngắn bằng env.
const ONLINE_POINT_MS = Math.max(200, Number(process.env.ONLINE_POINT_MS) || 3_600_000);
// Chu kỳ quét online: 60 giây (rút theo ONLINE_POINT_MS khi test).
const ONLINE_TICK_MS = Math.min(60_000, Math.max(100, Math.floor(ONLINE_POINT_MS / 4)));
// Ping/pong dọn socket chết (mặc định 30 giây).
const WS_PING_MS = Math.max(200, Number(process.env.WS_PING_MS) || 30_000);
const ONLINE_POINTS = { qtv: 15, 'bdh-den': 12 }; // còn lại +10
const ONLINE_POINTS_DEFAULT = 10;
const VOTE_COOLDOWN_MS = 5_000;          // mỗi cặp người vote -> người nhận
const VOTE_MAX_PER_HOUR = 60;            // mỗi người vote tối đa 60 lần được tính / giờ
const AWARD_LIMITS = { qtv: { per: 100, day: 1000 }, 'bdh-den': { per: 50, day: 300 } };
const STYLE_COLORS = new Set(['#1f2937', '#dc2626', '#ea580c', '#ca8a04', '#ffff00', '#16a34a', '#0d9488', '#2563eb', '#7c3aed', '#db2777', '#92400e', '#475569', '#000000']);
const STYLE_SIZE_MIN = 12, STYLE_SIZE_MAX = 20; // (v3.7) mọi số nguyên trong khoảng này


const {
  LIVEKIT_URL = 'ws://localhost:7880',
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  TOKEN_PORT = '3001',
  TOKEN_TTL = '6h',
  SESSION_TTL = '6h',
  SESSION_SECRET: SESSION_SECRET_ENV = '',
  ALLOW_LEGACY_TOKEN = '0',
  STAGE_SECRET = '',
  CORS_ORIGIN = '*',
} = process.env;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error('Thiếu LIVEKIT_API_KEY hoặc LIVEKIT_API_SECRET. Copy .env.example thành .env và điền key/secret.');
  process.exit(1);
}

// Secret ký session: chạy online phải đặt cố định trong .env (đổi secret là
// mọi phiên đăng nhập cũ hết hiệu lực). Chạy test local mà chưa đặt thì tự
// sinh secret ngẫu nhiên cho lần chạy này (đăng nhập mất hiệu lực khi restart).
let SESSION_SECRET = SESSION_SECRET_ENV;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('CẢNH BÁO: chưa đặt SESSION_SECRET — đã tự sinh secret tạm cho lần chạy này. Chạy online phải đặt SESSION_SECRET cố định trong .env.');
}
const LEGACY_TOKEN = ALLOW_LEGACY_TOKEN === '1';
if (LEGACY_TOKEN) console.warn('CẢNH BÁO: ALLOW_LEGACY_TOKEN=1 — /token đang chấp nhận identity/rank do client gửi (không an toàn, chỉ dùng lúc chuyển đổi).');

// ---- Tiện ích -------------------------------------------------------------

function parseTtl(str, defSeconds) {
  const m = /^(\d+)(s|m|h|d)?$/.exec(String(str || '').trim());
  if (!m) return defSeconds;
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's'];
  return n * mult;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64urlJson = (obj) => b64url(JSON.stringify(obj));

function signSession(user) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.id, name: user.name, rank: user.rank,
    iat: now, exp: now + parseTtl(SESSION_TTL, 6 * 3600),
  };
  const data = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

function verifySession(token) {
  try {
    const [h, p, s] = String(token || '').split('.');
    if (!h || !p || !s) return null;
    const data = `${h}.${p}`;
    const sig = Buffer.from(s, 'base64url');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest();
    if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!payload.sub || !payload.rank || !RANKS.has(payload.rank)) return null;
    if (payload.exp * 1000 < Date.now()) return null;
    // Cấp bậc + tên lấy từ kho tài khoản (không lấy từ token) để đổi áo
    // BĐH có hiệu lực ngay với lần đăng nhập/kết nối/xin token tiếp theo
    // (v3.4) — token chỉ còn tác dụng chứng minh danh tính (sub).
    const stored = users[payload.sub];
    if (stored) {
      payload.rank = stored.rank;
      payload.name = stored.name;
    }
    return payload;
  } catch { return null; }
}

// ---- Kho tài khoản --------------------------------------------------------

// Lưu trữ bền (v3.6): có DATABASE_URL thì kho tài khoản + phòng tự tạo
// lưu trên Postgres (Neon, bảng kv — xem db.js); file data/users.json vẫn
// được ghi song song làm bản sao local. Không có DATABASE_URL, hoặc nối
// Postgres thất bại lúc khởi động, thì quay về lưu file như trước v3.6
// (máy chủ vẫn chạy bình thường).
let users = {};
let dbPool = null;
let dbStore = null;
let storageMode = 'file'; // 'postgres' khi DB sẵn sàng (hiện trong /health)
const BOT_CODES = new Set();

function seedOrLoadFromFile() {
  // Hành vi cũ (trước v3.6): có file thì tải file; chưa có file thì gieo
  // tài khoản demo từ biến môi trường ở lần khởi động đầu tiên.
  users = loadUsers();
  if (usersFileExists()) {
    console.log(`Đã tải ${Object.keys(users).length} tài khoản từ data/users.json.`);
    return;
  }
  const seeded = seedFromEnv(users);
  if (seeded.length) {
    saveUsers(users);
    console.log(`Đã tạo tài khoản từ biến môi trường: ${seeded.join(', ')}`);
  } else {
    console.log('Chưa có tài khoản nào. Đặt ADMIN_PASSWORD/BDH_PASSWORD/TEST_PASSWORD trong .env rồi restart, hoặc tạo bằng POST /register.');
  }
}

if (process.env.DATABASE_URL) {
  try {
    dbPool = await connectDb(process.env.DATABASE_URL);
    dbStore = createDbStore(dbPool);
    await dbStore.init();
    const fromDb = await dbStore.load('users');
    if (fromDb && typeof fromDb === 'object' && !Array.isArray(fromDb)) {
      users = fromDb;
      console.log(`Đã tải ${Object.keys(users).length} tài khoản từ Postgres (bảng kv).`);
    } else {
      // DB chưa có kho tài khoản: lấy từ file nếu có, không thì gieo từ
      // biến môi trường (như hành vi cũ), rồi lưu lên DB.
      seedOrLoadFromFile();
      await dbStore.save('users', users);
      console.log('Đã lưu kho tài khoản lên Postgres (bảng kv, key "users").');
    }
    storageMode = 'postgres';
  } catch (e) {
    console.error('CẢNH BÁO LỚN: không nối được Postgres qua DATABASE_URL — quay về lưu file data/users.json như cũ (dữ liệu sẽ mất khi máy chủ khởi động lại). Lỗi:', e.message);
    dbPool = null;
    dbStore = null;
    storageMode = 'file';
    seedOrLoadFromFile();
  }
} else {
  seedOrLoadFromFile();
}
// v3.5: bù mã số / điểm cho tài khoản cũ (mã bot được tránh ở genCode qua BOT_CODES).
if (ensureUserFields(users, BOT_CODES)) {
  try { saveUsers(users); } catch (e) { console.error('Lỗi lưu users.json:', e); }
  if (dbStore) await dbStore.save('users', users).catch((e) => console.error('Lỗi lưu users vào Postgres:', e.message));
}

// Lưu kho tài khoản ngay: ghi file (bản sao local) + ghi Postgres nếu có.
function persistUsers() {
  try { saveUsers(users); } catch (e) { console.error('Lỗi lưu users.json:', e); }
  if (dbStore) dbStore.save('users', users).catch((e) => console.error('Lỗi lưu users vào Postgres:', e.message));
}

// Lưu theo lô: đánh dấu bẩn rồi lưu tối đa 1 lần / 5 giây (điểm online,
// vote, thưởng điểm đi đường này để không ghi DB liên tục).
let usersDirty = false;
let saveTimer = null;
function scheduleSave() {
  usersDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!usersDirty) return;
    usersDirty = false;
    persistUsers();
  }, 5_000);
  if (saveTimer.unref) saveTimer.unref();
}
// Lưu nốt trước khi tắt (SIGTERM/SIGINT): ghi file + chờ ghi Postgres
// (tối đa 3 giây để không treo lúc Render tắt máy chủ).
async function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  usersDirty = false;
  try { saveUsers(users); } catch (e) { console.error(e); }
  if (dbStore) {
    const saves = Promise.all([dbStore.save('users', users), dbStore.save('rooms', roomsSnapshot())]);
    const timeout = new Promise((r) => setTimeout(r, 3_000));
    await Promise.race([saves, timeout]).catch((e) => console.error('Lỗi lưu vào Postgres lúc tắt:', e.message));
  }
}
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await flushSave();
    process.exit(0);
  });
}

// Hồ sơ công khai của 1 tài khoản thật (v3.5).
function profileOf(id) {
  const u = users[id];
  if (!u) return null;
  const p = {
    id, name: u.name, rank: u.rank, code: String(u.code || ''),
    points: Number(u.points) || 0, daily: dailyOf(u), level: levelOf(u.points),
    title: TITLES[u.rank] || TITLES.member,
  };
  if (u.gender === 'male' || u.gender === 'female') p.gender = u.gender;
  return p;
}

// Chống dò mật khẩu: tối đa 10 lần sai / ID trong 5 phút.
const loginAttempts = new Map(); // id -> { fails, firstAt }
function loginBlocked(id) {
  const e = loginAttempts.get(id);
  if (!e) return false;
  if (Date.now() - e.firstAt > 5 * 60 * 1000) { loginAttempts.delete(id); return false; }
  return e.fails >= 10;
}
function loginFailed(id) {
  const now = Date.now();
  const e = loginAttempts.get(id);
  if (!e || now - e.firstAt > 5 * 60 * 1000) loginAttempts.set(id, { fails: 1, firstAt: now });
  else e.fails += 1;
}

// ---- Phòng và cấp bậc (giữ nguyên từ v1) ----------------------------------

// Phòng trong artifact 'ban-test-phong-chat-cctalk'.
// Nhận cả ID số (208/101/102/103) lẫn slug; chuẩn hóa về 1 tên phòng LiveKit.
const ROOMS = {
  '208': 'giao-luu-ket-ban',
  '101': 'dai-sanh',
  '102': 'giao-luu',
  '103': 'ho-tro',
  'dai-sanh': 'dai-sanh',
  'giao-luu': 'giao-luu',
  'ho-tro': 'ho-tro',
  'giao-luu-ket-ban': 'giao-luu-ket-ban',
};
const ROOM_LABELS = {
  'giao-luu-ket-ban': 'Giao Lưu Kết Bạn (ID 208)',
  'dai-sanh': 'Đại Sảnh (ID 101)',
  'giao-luu': 'Giao Lưu (ID 102)',
  'ho-tro': 'Hỗ trợ (ID 103)',
};
const ALL_RANKS = RANKS;

// Sổ "ai đang trên mic" theo phòng: room -> Set(identity).
// Front-end gọi POST /stage mỗi khi có người lên/xuống mic.
const stage = new Map();
const stageSet = (room) => {
  if (!stage.has(room)) stage.set(room, new Set());
  return stage.get(room);
};

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-stage-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('Body không phải JSON')); }
    });
    req.on('error', reject);
  });
}

// Lấy session từ: header Authorization: Bearer ... (ưu tiên), rồi body.session,
// rồi query ?session=. Trả về payload session hoặc null.
function sessionFromReq(req, params) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (m) return verifySession(m[1]);
  if (params && params.session) return verifySession(params.session);
  return null;
}

async function issueToken({ room, identity, name, rank }) {
  const roomName = ROOMS[String(room).toLowerCase()];
  if (!roomName) {
    return { error: `Phòng không hợp lệ: ${room}. Phòng có: 208, 101, 102, 103 (hoặc dai-sanh, giao-luu, ho-tro).` };
  }
  if (!identity || typeof identity !== 'string') {
    return { error: 'Thiếu identity (ID người dùng).' };
  }
  const r = (rank || 'member').toLowerCase();
  if (!ALL_RANKS.has(r)) {
    return { error: `rank không hợp lệ: ${rank}. Dùng: qtv, bdh-den, bdh-vang, bdh-tim, member.` };
  }

  // QTV/BĐH publish luôn. Thành viên thường chỉ publish khi đang trên mic.
  const canPublish = MANAGER_RANKS.has(r) || stageSet(roomName).has(identity);

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: name || identity,
    ttl: TOKEN_TTL,
    // metadata để client hiển thị cấp bậc/áo.
    metadata: JSON.stringify({ rank: r, name: name || identity }),
  });
  at.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish,
    canSubscribe: true,
    canPublishData: true,
  });

  return {
    token: await at.toJwt(),
    url: LIVEKIT_URL,
    room: roomName,
    roomLabel: ROOM_LABELS[roomName],
    identity,
    name: name || identity,
    rank: r,
    canPublish,
    expiresIn: TOKEN_TTL,
  };
}

// ---- Chống spam / lạm dụng theo IP (v3.3) ---------------------------------
// Render đứng trước app nên IP thật của client nằm ở cuối X-Forwarded-For
// (mục cuối là IP mà proxy của Render nhìn thấy). Giới hạn trượt theo IP
// để 1 địa chỉ không flood được API hay mở hàng loạt kết nối WebSocket.
// Lưu ý: giới hạn này chống lạm dụng (spam, dò mật khẩu, tạo nick rác),
// không chống được DDoS lớn — việc đó cần Cloudflare (cần tên miền riêng).
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}
// Giới hạn trượt: tối đa `max` lần trong `windowMs` cho mỗi (ip, key).
const ipBuckets = new Map(); // `${ip}|${key}` -> { count, start }
function ipAllow(ip, key, max, windowMs) {
  const now = Date.now();
  const k = `${ip}|${key}`;
  const b = ipBuckets.get(k);
  if (!b || now - b.start > windowMs) { ipBuckets.set(k, { count: 1, start: now }); return true; }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}
// Dọn bucket cũ mỗi 10 phút để Map không phình vô hạn.
{
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of ipBuckets) {
      if (now - b.start > 60 * 60 * 1000) ipBuckets.delete(k);
    }
  }, 10 * 60 * 1000);
  if (t.unref) t.unref();
}

// Số kết nối WebSocket trên 1 IP (chống mở hàng loạt socket để spam chat).
const MAX_WS_PER_IP = 10;
const wsConnsByIp = new Map(); // ip -> count
function wsTrackIp(ws, ip) {
  ws.ip = ip;
  ws.ipTracked = true;
  wsConnsByIp.set(ip, (wsConnsByIp.get(ip) || 0) + 1);
}
function wsUntrackIp(ws) {
  if (!ws.ipTracked) return;
  ws.ipTracked = false;
  const n = (wsConnsByIp.get(ws.ip) || 1) - 1;
  if (n <= 0) wsConnsByIp.delete(ws.ip);
  else wsConnsByIp.set(ws.ip, n);
}

// Số phòng tự tạo: tối đa 5/người, tối đa 50 phòng trên toàn máy chủ.
const MAX_ROOMS_PER_USER = 5;
const MAX_CUSTOM_ROOMS = 50;
const roomsByCreator = new Map(); // userId -> count

// ---- Hub WebSocket: chat + hiện diện + phòng chung giữa các máy (v3) ------
// Trang web nối wss://<host>/ws (địa chỉ lấy từ ô "Máy chủ đăng nhập").
// Mọi tin nhắn chat, danh sách người đang online và phòng mới đều đi qua
// đây nên 2 máy (điện thoại + PC) thấy giống nhau. Không có máy chủ này,
// trang chạy chế độ bot demo cũ (mỗi máy tự sinh bot riêng).
// Giao thức (JSON, 1 message = 1 object):
//   Client -> Server:
//     {type:'auth', token}              — bắt buộc đầu tiên (session JWT từ /login)
//     {type:'join', room}               — vào phòng ('208'/'101'/... hoặc slug)
//     {type:'message', room, text}      — gửi chat (1-500 ký tự, tối đa 1 tin/0.8s)
//     {type:'leave', room}              — rời phòng
//     {type:'create-room', name}        — QTV/BĐH tạo phòng mới
//     {type:'delete-room', room}        — QTV xóa phòng tự tạo (không xóa 4 phòng mặc định)
//     {type:'set-rank', userId, rank}   — cấp áo BĐH đồng bộ (v3.4): QTV/đen/vàng
//                                          cấp áo thấp hơn áo mình cho người dưới mình;
//                                          rank 'member' = gỡ áo; không cấp được 'qtv'
//     {type:'message', ..., style:{color,size,b?,i?,u?}} — màu/cỡ chữ tùy chọn (v3.5;
//                                          v3.7: size nguyên 12-20, thêm đậm/nghiêng/gạch chân);
//                                          sai whitelist -> bỏ style
//     {type:'vote', room, userId}       — (v3.5) thả tim người đang lên mic: +1 điểm; cooldown 5s/cặp,
//                                          tối đa 60 vote tính/giờ/người; vi phạm -> bỏ qua im lặng
//     {type:'award', userId, amount}    — (v3.5) thưởng điểm: QTV 1-100/lần (1000/ngày), BĐH đen 1-50/lần
//                                          (300/ngày, chỉ cho người dưới mình); lỗi forbidden/bad-amount/
//                                          bad-user/award-limit
//     {type:'loto-create', room, kinh}  — QTV/BĐH mở vòng Lô Tô (kinh 2-6); 1 vòng/phòng
//     {type:'loto-join', room, numbers} — chốt số vào vòng đang mở
//     {type:'loto-start', room}         — chủ vòng bắt đầu kêu số
//     {type:'loto-called', room, number}— chủ vòng báo số vừa kêu (máy chủ kiểm tra KINH)
//     {type:'loto-kinh', room}          — người chơi tự báo KINH
//     {type:'loto-close', room}         — chủ vòng/QTV/BĐH đóng vòng
//   Server -> Client:
//     {type:'auth-ok', user:profile}  — profile (v3.5) = {id,name,rank,gender?,code,points,daily,level,title,bot?}
//                                          (members trong presence/room-state cũng là profile)
//     {type:'points', userId, points, daily, level} — (v3.5) điểm vừa đổi
//     {type:'awarded', room, fromName, toId, toName, amount} — (v3.5) vừa có người được thưởng điểm
//     {type:'rooms', rooms:[{room,label,id}]}            — danh sách phòng đầy đủ
//     {type:'room-state', room, label, members, messages, loto} — khi vào phòng (50 tin gần nhất + vòng Lô Tô hiện tại)
//     {type:'message', room, msg:{id,userId,name,rank,text,time}}
//     {type:'presence', room, members:[{id,name,rank}]} — gồm cả bot {id,name,rank,gender,bot:true}
//     tin nhắn bot có thêm bot:true + gender; bot tự nói mỗi ~10s/phòng
//     {type:'room-created', room, label, id}
//     {type:'room-closed', room}         — phòng đang ở bị xóa, client tự chuyển về Đại Sảnh
//     {type:'room-counts', counts:[{room, count}]} — số người online mỗi phòng
//                                          (người thật + bot), phát cho mọi máy khi có
//                                          người vào/ra/tạo/xóa phòng (v3.4)
//     {type:'rank-changed', userId, name, rank} — vừa có người được cấp/gỡ áo (v3.4)
//     {type:'loto-state', room, state}   — trạng thái vòng Lô Tô (null khi chưa có vòng)
//     {type:'loto-called', room, number} — số vừa kêu (ai cũng nhận, kể cả máy chủ vòng)
//     {type:'loto-kinh', room, winner}   — có người KINH, vòng kết thúc
//     {type:'loto-closed', room}         — vòng bị đóng, được tạo vòng mới
//     {type:'error', code, message}
// Trạng thái giữ trong RAM: tin nhắn + vòng Lô Tô mất khi restart. Tài
// khoản + phòng tự tạo thì bền từ v3.6 khi có DATABASE_URL (Postgres);
// không có DATABASE_URL thì phòng tự tạo vẫn chỉ ở RAM và tài khoản gieo
// lại từ biến môi trường mỗi lần khởi động (Render gói miễn phí không có
// ổ đĩa bền). Hàng đợi mic chưa đồng bộ qua hub này (vẫn chạy local từng
// máy). Lô Tô đồng bộ từ v3.2: 1 vòng/phòng, chủ vòng kêu số, máy chủ
// kiểm tra KINH và phát cho cả phòng.

const WS_AUTH_TIMEOUT_MS = 10_000;
const WS_MAX_MSG_LEN = 500;
const WS_MIN_MSG_GAP_MS = 800;
const WS_HISTORY = 50;

// Phòng tự tạo: slug -> { id, label, createdBy }. ID chạy từ 104.
const customRooms = new Map();
let nextRoomId = 104;

// ---- Phòng tự tạo: lưu/khôi phục qua Postgres (v3.6) ----------------------
// Ảnh chụp phòng tự tạo để lưu vào bảng kv (key "rooms"):
// { customRooms: [{room, id, label, createdBy}], byCreator: {userId: count} }.
function roomsSnapshot() {
  return {
    customRooms: [...customRooms].map(([room, r]) => ({ room, id: r.id, label: r.label, createdBy: r.createdBy })),
    byCreator: Object.fromEntries(roomsByCreator),
  };
}
function persistRooms() {
  if (dbStore) dbStore.save('rooms', roomsSnapshot()).catch((e) => console.error('Lỗi lưu phòng tự tạo vào Postgres:', e.message));
}
// Khôi phục phòng tự tạo từ bản lưu: đăng ký lại vào ROOMS/ROOM_LABELS
// y như lúc create-room, và đẩy nextRoomId lên sau ID lớn nhất đã dùng.
function restoreRooms(saved) {
  const list = Array.isArray(saved?.customRooms) ? saved.customRooms : [];
  let restored = 0;
  for (const r of list) {
    const room = String(r?.room || '');
    const id = Number(r?.id);
    const label = String(r?.label || '');
    const createdBy = String(r?.createdBy || '');
    if (!/^phong-\d+$/.test(room) || !Number.isInteger(id) || id < 104 || !label || customRooms.has(room)) continue;
    customRooms.set(room, { id, label, createdBy });
    ROOMS[String(id)] = room;
    ROOMS[room] = room;
    ROOM_LABELS[room] = label;
    if (id >= nextRoomId) nextRoomId = id + 1;
    restored += 1;
  }
  // Số phòng mỗi người đã tạo: lấy từ bản lưu; thiếu thì đếm lại từ phòng.
  const byCreator = saved?.byCreator && typeof saved.byCreator === 'object' ? saved.byCreator : null;
  if (byCreator) {
    for (const [uid, n] of Object.entries(byCreator)) {
      const c = Math.floor(Number(n));
      if (uid && Number.isFinite(c) && c > 0) roomsByCreator.set(uid, c);
    }
  } else {
    for (const r of customRooms.values()) {
      if (r.createdBy) roomsByCreator.set(r.createdBy, (roomsByCreator.get(r.createdBy) || 0) + 1);
    }
  }
  return restored;
}
if (dbStore) {
  try {
    const savedRooms = await dbStore.load('rooms');
    if (savedRooms) {
      const n = restoreRooms(savedRooms);
      if (n) console.log(`Đã khôi phục ${n} phòng tự tạo từ Postgres.`);
    }
  } catch (e) {
    console.error('Không tải được phòng tự tạo từ Postgres:', e.message);
  }
}
// Lưu định kỳ mỗi 30 phút (v3.6): tài khoản + phòng tự tạo lên Postgres
// (và file local) — ghi thưa để Neon ngủ giữa các lần ghi, đỡ tốn giờ chạy.
{
  const t = setInterval(() => { persistUsers(); persistRooms(); }, 30 * 60 * 1000);
  if (t.unref) t.unref();
}
// Tin nhắn theo phòng: roomName -> [{id,userId,name,rank,text,time}]
const roomMessages = new Map();
// Người đang online theo phòng: roomName -> Map userId -> {id,name,rank,conns}
const roomMembers = new Map();

let msgSeq = 0;
const nextMsgId = () => `m${Date.now().toString(36)}${(msgSeq++).toString(36)}`;

const DEFAULT_ROOM_ORDER = ['giao-luu-ket-ban', 'dai-sanh', 'giao-luu', 'ho-tro'];
const DEFAULT_ROOM_IDS = { 'giao-luu-ket-ban': 208, 'dai-sanh': 101, 'giao-luu': 102, 'ho-tro': 103 };

function roomLabelOf(roomName) { return ROOM_LABELS[roomName] || roomName; }
function messagesOf(roomName) {
  if (!roomMessages.has(roomName)) roomMessages.set(roomName, []);
  return roomMessages.get(roomName);
}
function membersMapOf(roomName) {
  if (!roomMembers.has(roomName)) roomMembers.set(roomName, new Map());
  return roomMembers.get(roomName);
}
// ---- Bot cho đông vui ------------------------------------------------------
// Mỗi phòng mặc định có sẵn 10 bot (tên + giới tính cố định theo seed nên
// lần restart nào cũng giống nhau). Bot luôn "online" và tự chat mỗi ~10s
// một phòng, để phòng lúc nào cũng đông vui dù chưa có người thật.
// Bot có mặt trong presence và room-state như người thường, chỉ khác là
// có thêm trường bot:true + gender để trang hiển thị tag BOT.
const BOTS_PER_ROOM = 10;
const BOT_CHAT_INTERVAL_MS = 10_000;
const BOT_MALE_NAMES = [
  'Ken_Ken', 'Sói Cô Đơn', 'Út Cưng', 'Đạt 09', 'Cọp Giấy', 'Bảo',
  'Tèo Em', 'Minh Tuấn Pro', 'Tuấn Anh 2k3', 'Phong Lữ Hành', 'Anh Tài Xế',
  'Gấu Bông', 'Hạt Dẻ Cười', 'Đạt 2k7', 'Cọp Con', 'Bé Bự', 'Anh Hai',
  'Tí Hon', 'Cu Tí', 'Bờm', 'Sói Đêm', 'Kẻ Cô Đơn', 'Anh Ba', 'Bé Ba',
  'Lộc Vàng', 'Tèo', 'Củ Khoai', 'Bé Mập', 'Anh Tư', 'Chú Cuội', 'Bé Na',
  'Khỉ Con', 'Voi Con', 'Cọp Vằn', 'Sói Trắng', 'Anh Năm',
];
const BOT_FEMALE_NAMES = [
  'Hồng Nhung', 'Mèo Ú', 'Bé Heo', 'Nắng Vàng', 'Hoa Hồng', 'Bé Bông',
  'Chị Google', 'Cô Ba', 'Bé Tư', 'Mây Trắng', 'Nắng Mai', 'Hoa Sen',
  'Bé Xinh', 'Chị Hai', 'Cô Tư', 'Bé Nhỏ', 'Mèo Con', 'Thỏ Trắng',
  'Gấu Trúc', 'Bướm Vàng', 'Hoa Đào', 'Bé Miu', 'Cô Gái', 'Nàng Thơ',
  'Bé Bắp', 'Hoa Cúc', 'Bé Dâu', 'Mèo Mun', 'Thỏ Ngọc', 'Bé Kem',
  'Cô Bé', 'Nắng Hồng', 'Bé Sữa', 'Hoa Lan', 'Bé Su', 'Mèo Lười',
];
const BOT_CHAT_LINES = [
  'chào cả nhà!', 'hôm nay phòng đông vui ghê', 'ai còn slot không cho mình ké với',
  'cho e xin cái áo', 'cảm ơn BĐH, mình làm được rồi', 'ai lên mic hát một bài đi',
  'phòng này đông vui ghê', 'mọi người đang làm gì đó', 'cho mình xin slot mic với',
  'tuyển thêm 6k7k c27 p269 mk1 co mic', 'kèo này thơm nè mọi người',
  'đang cần 1 bạn có mic, nói chuyện vui vẻ', 'c13 p298 mk298 6k> có mic k trẻ trâu',
  'ai rảnh ghép team không', 'hôm nay vui quá đi', 'BĐH ơi cho em lên mic với',
  'phòng này toàn người vui tính', 'ai biết hát thì lên mic đi',
  'mình mới vào, chào mọi người', 'đông vui quá, ở lại luôn',
  'cho xin 1 slot ghép team', 'ai còn mic không, cho ké',
  'hôm nay ca hát tới sáng luôn', 'mọi người ơi, cuối tuần vui vẻ nha',
  'phòng này lúc nào cũng đông', 'ai muốn ghép đôi không nè',
  'lên mic tâm sự đi mọi người', 'chào buổi tối cả nhà', 'đang nghe nhạc hay quá',
];

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function buildBotRoster(roomName, seed) {
  const rand = mulberry32(seed);
  const maleCount = Math.ceil(BOTS_PER_ROOM / 2);
  const femaleCount = BOTS_PER_ROOM - maleCount;
  const males = shuffled(BOT_MALE_NAMES, rand).slice(0, maleCount);
  const females = shuffled(BOT_FEMALE_NAMES, rand).slice(0, femaleCount);
  return [
    ...males.map((name) => ({ name, gender: 'male' })),
    ...females.map((name) => ({ name, gender: 'female' })),
  ].map(({ name, gender }, i) => {
    // Mã số / điểm giả lập cố định theo seed (v3.5).
    let code;
    do { code = String(100000000 + Math.floor(rand() * 900000000)); } while (BOT_CODES.has(code) || Object.values(users).some((u) => u && String(u.code) === code));
    BOT_CODES.add(code);
    const points = 40 + Math.floor(rand() * 1960);
    const daily = Math.floor(rand() * 120);
    return {
      id: `bot-${roomName}-${String(i + 1).padStart(2, '0')}`,
      name, gender, rank: 'member', bot: true,
      code, points, daily, level: levelOf(points), title: TITLES.member,
    };
  });
}
const botRosters = new Map(
  DEFAULT_ROOM_ORDER.map((room) => [room, buildBotRoster(room, DEFAULT_ROOM_IDS[room])]),
);
function botsOf(roomName) { return botRosters.get(roomName) || []; }
function membersOf(roomName) {
  const real = [...membersMapOf(roomName).values()].map(({ id, name, rank }) => profileOf(id) || { id, name, rank });
  return [...real, ...botsOf(roomName)];
}

// ---- Điểm: online / vote / thưởng (v3.5) ----------------------------------
// Gửi {type:'points'} cho mọi máy trong các phòng có user đó + chính user đó.
function wsSendPoints(userId) {
  const p = profileOf(userId);
  if (!p) return;
  const rooms = new Set();
  for (const [roomName, m] of roomMembers) if (m.has(userId)) rooms.add(roomName);
  const obj = { type: 'points', userId, points: p.points, daily: p.daily, level: p.level };
  for (const client of wss.clients) {
    if (!client.user) continue;
    if (client.user.sub === userId || (client.room && rooms.has(client.room))) wsSend(client, obj);
  }
}
// Quét online: mỗi user có >=1 socket đã auth (nhiều máy chỉ tính 1).
let lastOnlineTick = Date.now();
let ticksSinceSave = 0;
function onlineTick() {
  const now = Date.now();
  const elapsed = Math.max(0, now - lastOnlineTick);
  lastOnlineTick = now;
  const online = new Set();
  for (const client of wss.clients) if (client.user && client.readyState === 1) online.add(client.user.sub);
  let pointsChanged = false;
  for (const id of online) {
    const u = users[id];
    if (!u) continue;
    u.onlineMs = (Number(u.onlineMs) || 0) + elapsed;
    let gained = 0;
    while (u.onlineMs >= ONLINE_POINT_MS) {
      u.onlineMs -= ONLINE_POINT_MS;
      gained += ONLINE_POINTS[u.rank] || ONLINE_POINTS_DEFAULT;
    }
    if (gained) { addPoints(u, gained); pointsChanged = true; wsSendPoints(id); }
  }
  ticksSinceSave += 1;
  // Có điểm mới -> lưu (theo lô); chỉ tiến độ onlineMs -> lưu ~5 chu kỳ/lần.
  if (pointsChanged || (online.size && ticksSinceSave >= 5)) { ticksSinceSave = 0; scheduleSave(); }
}
{
  const t = setInterval(onlineTick, ONLINE_TICK_MS);
  if (t.unref) t.unref();
}
const voteLast = new Map();   // `${voter}>${target}` -> time
const voteBuckets = new Map(); // voter -> { count, start }
{
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of voteLast) if (now - v > 60_000) voteLast.delete(k);
    for (const [k, b] of voteBuckets) if (now - b.start > 3_600_000) voteBuckets.delete(k);
  }, 10 * 60 * 1000);
  if (t.unref) t.unref();
}
// Chuẩn hóa style chữ chat: sai -> null (bỏ style, không báo lỗi).
// (v3.7) size: mọi số nguyên 12-20; b/i/u (đậm/nghiêng/gạch chân) tùy chọn,
// chỉ lưu khi true; có mặt mà không phải boolean -> bỏ cả style.
function cleanStyle(style) {
  if (!style || typeof style !== 'object') return null;
  const color = style.color === undefined ? '#1f2937' : String(style.color).toLowerCase();
  const size = style.size === undefined ? 14 : Number(style.size);
  if (!STYLE_COLORS.has(color) || !Number.isInteger(size) || size < STYLE_SIZE_MIN || size > STYLE_SIZE_MAX) return null;
  const out = { color, size };
  for (const k of ['b', 'i', 'u']) {
    if (style[k] === undefined) continue;
    if (typeof style[k] !== 'boolean') return null;
    if (style[k]) out[k] = true;
  }
  return out;
}

// ---- Lô Tô chung giữa các máy (v3.2) --------------------------------------
// 1 vòng/phòng: QTV/BĐH tạo vòng (chọn cách kinh 2-6 số) -> mọi người chốt
// số -> chủ vòng bắt đầu kêu, mỗi số kêu xong chủ vòng báo lên máy chủ,
// máy chủ ghi lại + kiểm tra KINH + phát cho cả phòng. Ai KINH thì vòng
// kết thúc; đóng vòng (hoặc hết vòng) xong mới tạo được vòng mới. Máy chủ
// tự sinh 10 bot chơi cùng mỗi vòng (số ngẫu nhiên), bot cũng có thể KINH.
const LOTO_BOTS_PER_ROUND = 10;
const lotoByRoom = new Map(); // roomName -> state | null

function lotoStateOf(roomName) { return lotoByRoom.get(roomName) || null; }
function lotoPublic(state) {
  if (!state) return null;
  return {
    active: true, hostId: state.hostId, hostName: state.hostName, kinh: state.kinh,
    status: state.status, players: state.players, called: state.called,
    winner: state.winner, createdAt: state.createdAt,
  };
}
function lotoBroadcast(roomName) {
  wsBroadcast(roomName, { type: 'loto-state', room: roomName, state: lotoPublic(lotoStateOf(roomName)) });
}
function lotoRandomTicket(kinh, rand) {
  const nums = new Set();
  while (nums.size < kinh) nums.add(1 + Math.floor(rand() * 90));
  return [...nums].sort((a, b) => a - b);
}
function lotoMakeBots(roomName, kinh) {
  const roster = shuffled(botsOf(roomName), Math.random);
  return roster.slice(0, LOTO_BOTS_PER_ROUND).map((b) => ({
    userId: b.id, name: b.name, numbers: lotoRandomTicket(kinh, Math.random), bot: true, gender: b.gender,
  }));
}
function lotoCheckKinh(state) {
  const called = new Set(state.called);
  for (const p of state.players) {
    if (p.numbers.length && p.numbers.every((n) => called.has(n))) return p;
  }
  return null;
}
function lotoFinish(roomName, state, winner) {
  state.status = 'finished';
  state.winner = { userId: winner.userId, name: winner.name, numbers: winner.numbers, bot: !!winner.bot };
  wsBroadcast(roomName, { type: 'loto-kinh', room: roomName, winner: state.winner });
  lotoBroadcast(roomName);
}
function allRooms() {
  const list = DEFAULT_ROOM_ORDER.map((room) => ({ room, label: ROOM_LABELS[room], id: DEFAULT_ROOM_IDS[room] }));
  for (const [room, r] of customRooms) list.push({ room, label: r.label, id: r.id });
  return list;
}

// ---- Đồng bộ cấp áo + số người/phòng (v3.4) ------------------------------
// Thứ bậc áo (số càng nhỏ càng cao): dùng cho quyền cấp áo — chỉ QTV,
// BĐH đen, BĐH vàng được cấp áo; chỉ cấp cho người dưới mình và chỉ cấp
// áo thấp hơn áo mình (QTV -> đen/vàng/tím/gỡ áo, đen -> vàng/tím/gỡ áo,
// vàng -> tím/gỡ áo; tím không cấp được gì).
const RANK_ORDER = { qtv: 0, 'bdh-den': 1, 'bdh-vang': 2, 'bdh-tim': 3, member: 4 };
// Số người đang online mỗi phòng (người thật + bot) — phát cho MỌI máy
// đang nối để cột phòng trái hiển thị đúng theo thời gian thực (trước đây
// mỗi máy chỉ biết số người của phòng mình đang ở, các phòng khác hiện 0).
function roomCounts() {
  return allRooms().map((r) => ({ room: r.room, count: membersOf(r.room).length }));
}
function wsBroadcastRoomCounts() {
  wsBroadcastAll({ type: 'room-counts', counts: roomCounts() });
}

function wsSend(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function wsBroadcast(roomName, obj, exceptWs = null) {
  for (const client of wss.clients) {
    if (client === exceptWs) continue;
    if (client.room === roomName && client.user) wsSend(client, obj);
  }
}
function wsBroadcastAll(obj) {
  for (const client of wss.clients) {
    if (client.user) wsSend(client, obj);
  }
}
function wsBroadcastPresence(roomName) {
  wsBroadcast(roomName, { type: 'presence', room: roomName, members: membersOf(roomName) });
}
function wsJoinRoom(ws, roomName) {
  if (ws.room) wsLeaveRoom(ws);
  ws.room = roomName;
  const m = membersMapOf(roomName);
  const e = m.get(ws.user.sub);
  if (e) e.conns += 1;
  else m.set(ws.user.sub, { id: ws.user.sub, name: ws.user.name, rank: ws.user.rank, conns: 1 });
  wsSend(ws, {
    type: 'room-state', room: roomName, label: roomLabelOf(roomName),
    members: membersOf(roomName), messages: messagesOf(roomName),
    loto: lotoPublic(lotoStateOf(roomName)),
  });
  wsBroadcastPresence(roomName);
  wsBroadcastRoomCounts();
}
function wsLeaveRoom(ws) {
  if (!ws.room || !ws.user) return;
  const roomName = ws.room;
  ws.room = null;
  const m = membersMapOf(roomName);
  const e = m.get(ws.user.sub);
  if (e) {
    e.conns -= 1;
    if (e.conns <= 0) m.delete(ws.user.sub);
  }
  wsBroadcastPresence(roomName);
  wsBroadcastRoomCounts();
}

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  ws.user = null;
  ws.room = null;
  ws.lastMsgAt = 0;
  const authTimer = setTimeout(() => {
    if (!ws.user) {
      wsSend(ws, { type: 'error', code: 'unauthorized', message: 'Chưa đăng nhập (thiếu session).' });
      ws.close(4401, 'unauthorized');
    }
  }, WS_AUTH_TIMEOUT_MS);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch {
      return wsSend(ws, { type: 'error', code: 'bad-message', message: 'Tin nhắn không phải JSON.' });
    }
    if (!msg || typeof msg !== 'object') return;

    // Chưa đăng nhập: chỉ chấp nhận auth.
    if (!ws.user) {
      if (msg.type === 'auth') {
        const session = verifySession(msg.token);
        if (!session) {
          wsSend(ws, { type: 'error', code: 'unauthorized', message: 'Session không hợp lệ hoặc đã hết hạn.' });
          return ws.close(4401, 'unauthorized');
        }
        ws.user = session;
        clearTimeout(authTimer);
        wsSend(ws, { type: 'auth-ok', user: profileOf(session.sub) || { id: session.sub, name: session.name, rank: session.rank } });
        wsSend(ws, { type: 'rooms', rooms: allRooms() });
        wsSend(ws, { type: 'room-counts', counts: roomCounts() });
      }
      return;
    }

    switch (msg.type) {
      case 'join': {
        const roomName = ROOMS[String(msg.room ?? '').toLowerCase()];
        if (!roomName) return wsSend(ws, { type: 'error', code: 'bad-room', message: 'Phòng không hợp lệ.' });
        wsJoinRoom(ws, roomName);
        break;
      }
      case 'leave': {
        wsLeaveRoom(ws);
        break;
      }
      case 'message': {
        const roomName = ROOMS[String(msg.room ?? '').toLowerCase()];
        if (!roomName || ws.room !== roomName) return wsSend(ws, { type: 'error', code: 'not-in-room', message: 'Bạn chưa vào phòng này.' });
        const text = String(msg.text ?? '').trim();
        if (!text || text.length > WS_MAX_MSG_LEN) return wsSend(ws, { type: 'error', code: 'bad-text', message: `Tin nhắn dài 1-${WS_MAX_MSG_LEN} ký tự.` });
        const now = Date.now();
        if (now - ws.lastMsgAt < WS_MIN_MSG_GAP_MS) return wsSend(ws, { type: 'error', code: 'rate-limited', message: 'Gửi chậm lại một chút.' });
        if (!ipAllow(ws.ip || 'unknown', 'chat', 10, 10 * 1000)) return wsSend(ws, { type: 'error', code: 'rate-limited', message: 'Gửi chậm lại một chút.' });
        ws.lastMsgAt = now;
        const chatMsg = { id: nextMsgId(), userId: ws.user.sub, name: ws.user.name, rank: ws.user.rank, text, time: new Date(now).toISOString() };
        const style = cleanStyle(msg.style);
        if (style) chatMsg.style = style;
        const hist = messagesOf(roomName);
        hist.push(chatMsg);
        if (hist.length > WS_HISTORY) hist.splice(0, hist.length - WS_HISTORY);
        wsBroadcast(roomName, { type: 'message', room: roomName, msg: chatMsg });
        break;
      }
      case 'create-room': {
        if (!MANAGER_RANKS.has(ws.user.rank)) return wsSend(ws, { type: 'error', code: 'forbidden', message: 'Chỉ QTV/BĐH mới tạo được phòng.' });
        const name = String(msg.name ?? '').trim().slice(0, 40);
        if (name.length < 2) return wsSend(ws, { type: 'error', code: 'bad-name', message: 'Tên phòng dài 2-40 ký tự.' });
        if (customRooms.size >= MAX_CUSTOM_ROOMS) return wsSend(ws, { type: 'error', code: 'too-many-rooms', message: 'Đã đủ 50 phòng tự tạo, không tạo thêm được.' });
        const createdCount = roomsByCreator.get(ws.user.sub) || 0;
        if (createdCount >= MAX_ROOMS_PER_USER) return wsSend(ws, { type: 'error', code: 'too-many-rooms', message: 'Mỗi người chỉ tạo được tối đa 5 phòng.' });
        const id = nextRoomId++;
        const roomName = `phong-${id}`;
        const label = `${name} (ID ${id})`;
        customRooms.set(roomName, { id, label, createdBy: ws.user.sub });
        roomsByCreator.set(ws.user.sub, createdCount + 1);
        ROOMS[String(id)] = roomName;
        ROOMS[roomName] = roomName;
        ROOM_LABELS[roomName] = label;
        persistRooms();
        wsBroadcastAll({ type: 'rooms', rooms: allRooms() });
        wsBroadcastRoomCounts();
        wsSend(ws, { type: 'room-created', room: roomName, label, id });
        break;
      }
      case 'delete-room': {
        const roomName = ROOMS[String(msg.room ?? '').toLowerCase()];
        if (!roomName || !customRooms.has(roomName)) return wsSend(ws, { type: 'error', code: 'bad-room', message: 'Chỉ xóa được phòng tự tạo.' });
        if (ws.user.rank !== 'qtv') return wsSend(ws, { type: 'error', code: 'forbidden', message: 'Chỉ QTV mới xóa được phòng.' });
        const removed = customRooms.get(roomName);
        customRooms.delete(roomName);
        const rc = roomsByCreator.get(removed.createdBy) || 0;
        if (rc > 0) roomsByCreator.set(removed.createdBy, rc - 1);
        delete ROOMS[String(removed.id)];
        delete ROOMS[roomName];
        delete ROOM_LABELS[roomName];
        roomMessages.delete(roomName);
        roomMembers.delete(roomName);
        lotoByRoom.delete(roomName);
        persistRooms();
        wsBroadcastAll({ type: 'rooms', rooms: allRooms() });
        wsBroadcastRoomCounts();
        wsBroadcast(roomName, { type: 'room-closed', room: roomName });
        break;
      }
      case 'set-rank': {
        // Cấp áo BĐH đồng bộ (v3.4): đổi rank trong kho tài khoản (lưu
        // users.json) rồi phát cho mọi máy — người được cấp áo giữ áo khi
        // đổi phòng vì rank lấy từ kho, không còn chỉ đổi ở máy người cấp.
        const targetId = String(msg.userId ?? '').trim().toLowerCase();
        const newRank = String(msg.rank ?? '').trim();
        if (!targetId || !RANKS.has(newRank) || newRank === 'qtv') {
          return wsSend(ws, { type: 'error', code: 'bad-rank', message: 'Cấp bậc không hợp lệ.' });
        }
        if (targetId === ws.user.sub) {
          return wsSend(ws, { type: 'error', code: 'forbidden', message: 'Không tự đổi cấp bậc của mình.' });
        }
        const senderOrder = RANK_ORDER[ws.user.rank];
        const target = users[targetId];
        if (!target) return wsSend(ws, { type: 'error', code: 'bad-user', message: 'Không tìm thấy người này.' });
        const targetOrder = RANK_ORDER[target.rank];
        if (senderOrder > 2) return wsSend(ws, { type: 'error', code: 'forbidden', message: 'Cấp bậc của bạn không cấp được áo.' });
        if (targetOrder <= senderOrder) return wsSend(ws, { type: 'error', code: 'forbidden', message: 'Chỉ cấp áo cho người dưới cấp bậc của bạn.' });
        if (RANK_ORDER[newRank] <= senderOrder) return wsSend(ws, { type: 'error', code: 'forbidden', message: 'Chỉ cấp áo thấp hơn áo của bạn.' });
        if (!setUserRank(users, targetId, newRank)) return wsSend(ws, { type: 'error', code: 'bad-user', message: 'Không đổi được cấp bậc.' });
        persistUsers(); // v3.6: lưu cả lên Postgres (setUserRank chỉ ghi file)
        // Cập nhật rank cho các kết nối đang mở của người này (kể cả máy
        // khác) và rank trong presence của các phòng họ đang ở.
        const roomsOfTarget = new Set();
        for (const client of wss.clients) {
          if (client.user && client.user.sub === targetId) {
            client.user.rank = newRank;
            if (client.room) roomsOfTarget.add(client.room);
          }
        }
        for (const [roomName, m] of roomMembers) {
          const e = m.get(targetId);
          if (e) e.rank = newRank;
        }
        wsBroadcastAll({ type: 'rank-changed', userId: targetId, name: target.name, rank: newRank });
        for (const r of roomsOfTarget) wsBroadcastPresence(r);
        break;
      }
      case 'vote': {
        // Thả tim cho người đang lên mic (v3.5): +1 điểm, vi phạm -> bỏ qua im lặng.
        const roomName = ROOMS[String(msg.room ?? '').toLowerCase()];
        const targetId = String(msg.userId ?? '').trim().toLowerCase();
        if (!roomName || ws.room !== roomName || !targetId || targetId === ws.user.sub) break;
        if (!membersMapOf(roomName).has(targetId) || !users[targetId]) break;
        const now = Date.now();
        const pair = `${ws.user.sub}>${targetId}`;
        if (now - (voteLast.get(pair) || 0) < VOTE_COOLDOWN_MS) break;
        let b = voteBuckets.get(ws.user.sub);
        if (!b || now - b.start > 3_600_000) { b = { count: 0, start: now }; voteBuckets.set(ws.user.sub, b); }
        if (b.count >= VOTE_MAX_PER_HOUR) break;
        b.count += 1;
        voteLast.set(pair, now);
        addPoints(users[targetId], 1);
        scheduleSave();
        wsSendPoints(targetId);
        break;
      }
      case 'award': {
        // Thưởng điểm (v3.5): QTV 1-100/lần, 1000/ngày; BĐH đen 1-50/lần, 300/ngày.
        const lim = AWARD_LIMITS[ws.user.rank];
        if (!lim) return wsSend(ws, { type: 'error', code: 'forbidden', message: 'Chỉ QTV (áo đỏ) và BĐH áo đen mới thưởng điểm được.' });
        const targetId = String(msg.userId ?? '').trim().toLowerCase();
        const target = users[targetId];
        if (!targetId || !target) return wsSend(ws, { type: 'error', code: 'bad-user', message: 'Không tìm thấy người này.' });
        if (targetId === ws.user.sub) return wsSend(ws, { type: 'error', code: 'forbidden', message: 'Không tự thưởng điểm cho mình.' });
        if (ws.user.rank === 'bdh-den' && !(RANK_ORDER[target.rank] > RANK_ORDER['bdh-den'])) {
          return wsSend(ws, { type: 'error', code: 'forbidden', message: 'BĐH áo đen chỉ thưởng điểm cho người dưới cấp mình.' });
        }
        const amount = Number(msg.amount);
        if (!Number.isInteger(amount) || amount < 1 || amount > lim.per) {
          return wsSend(ws, { type: 'error', code: 'bad-amount', message: `Mỗi lần thưởng 1-${lim.per} điểm.` });
        }
        const giver = users[ws.user.sub];
        const today = todayVN();
        const used = giver && giver.awardDaily && giver.awardDaily.date === today ? Number(giver.awardDaily.total) || 0 : 0;
        if (used + amount > lim.day) {
          return wsSend(ws, { type: 'error', code: 'award-limit', message: `Hết hạn mức thưởng hôm nay (còn ${Math.max(0, lim.day - used)}/${lim.day} điểm).` });
        }
        if (giver) giver.awardDaily = { date: today, total: used + amount };
        addPoints(target, amount);
        scheduleSave(); // v3.6: thưởng điểm lưu theo lô (tối đa 1 lần ghi / 5 giây)
        wsSendPoints(targetId);
        const rooms = new Set();
        for (const [roomName, m] of roomMembers) if (m.has(targetId)) rooms.add(roomName);
        const sentTo = new Set();
        for (const roomName of rooms) {
          const obj = { type: 'awarded', room: roomName, fromName: ws.user.name, toId: targetId, toName: target.name, amount };
          for (const client of wss.clients) {
            if (client.user && client.room === roomName) { wsSend(client, obj); sentTo.add(client); }
          }
        }
        // Người thưởng / người nhận không cùng phòng vẫn nhận xác nhận.
        const direct = { type: 'awarded', room: [...rooms][0] || null, fromName: ws.user.name, toId: targetId, toName: target.name, amount };
        for (const client of wss.clients) {
          if (!client.user || sentTo.has(client)) continue;
          if (client === ws || client.user.sub === targetId) wsSend(client, direct);
        }
        break;
      }
      case 'loto-create': {
        if (!MANAGER_RANKS.has(ws.user.rank)) return wsSend(ws, { type: 'error', code: 'forbidden', message: 'Chỉ QTV/BĐH mới tạo được vòng Lô Tô.' });
        const roomName = ROOMS[String(msg.room ?? '').toLowerCase()];
        if (!roomName || ws.room !== roomName) return wsSend(ws, { type: 'error', code: 'not-in-room', message: 'Bạn chưa vào phòng này.' });
        const kinh = Number(msg.kinh);
        if (![2, 3, 4, 5, 6].includes(kinh)) return wsSend(ws, { type: 'error', code: 'bad-message', message: 'Cách kinh phải là 2, 3, 4, 5 hoặc 6 số.' });
        const existing = lotoStateOf(roomName);
        if (existing && existing.status !== 'finished') return wsSend(ws, { type: 'error', code: 'loto-busy', message: `Đã có vòng Lô Tô của ${existing.hostName} đang mở (Kinh ${existing.kinh} số). Hết vòng mới tạo được vòng mới.` });
        const state = {
          hostId: ws.user.sub, hostName: ws.user.name, kinh,
          status: 'registering', players: lotoMakeBots(roomName, kinh), called: [],
          winner: null, createdAt: new Date().toISOString(),
        };
        lotoByRoom.set(roomName, state);
        lotoBroadcast(roomName);
        break;
      }
      case 'loto-join': {
        const roomName = ROOMS[String(msg.room ?? '').toLowerCase()];
        if (!roomName || ws.room !== roomName) return wsSend(ws, { type: 'error', code: 'not-in-room', message: 'Bạn chưa vào phòng này.' });
        const state = lotoStateOf(roomName);
        if (!state) return wsSend(ws, { type: 'error', code: 'no-round', message: 'Chưa có vòng Lô Tô nào đang mở.' });
        if (state.status !== 'registering') return wsSend(ws, { type: 'error', code: 'loto-calling', message: 'Vòng đã bắt đầu kêu số, không chốt số được nữa.' });
        const nums = Array.isArray(msg.numbers) ? msg.numbers.map(Number) : [];
        const valid = nums.length === state.kinh
          && new Set(nums).size === nums.length
          && nums.every((n) => Number.isInteger(n) && n >= 1 && n <= 90);
        if (!valid) return wsSend(ws, { type: 'error', code: 'bad-numbers', message: `Chốt đủ ${state.kinh} số khác nhau từ 01 đến 90.` });
        const ticket = [...nums].sort((a, b) => a - b);
        const i = state.players.findIndex((p) => p.userId === ws.user.sub && !p.bot);
        const player = { userId: ws.user.sub, name: ws.user.name, numbers: ticket, bot: false };
        if (i >= 0) state.players[i] = player; else state.players.push(player);
        lotoBroadcast(roomName);
        break;
      }
      case 'loto-start': {
        const roomName = ROOMS[String(msg.room ?? '').toLowerCase()];
        if (!roomName || ws.room !== roomName) return wsSend(ws, { type: 'error', code: 'not-in-room', message: 'Bạn chưa vào phòng này.' });
        const state = lotoStateOf(roomName);
        if (!state) return wsSend(ws, { type: 'error', code: 'no-round', message: 'Chưa có vòng Lô Tô nào đang mở.' });
        if (state.hostId !== ws.user.sub && ws.user.rank !== 'qtv') return wsSend(ws, { type: 'error', code: 'not-host', message: 'Chỉ người tạo vòng (hoặc QTV) mới bắt đầu kêu số.' });
        if (state.status !== 'registering') return wsSend(ws, { type: 'error', code: 'loto-calling', message: 'Vòng đã bắt đầu rồi.' });
        state.status = 'calling';
        lotoBroadcast(roomName);
        break;
      }
      case 'loto-called': {
        const roomName = ROOMS[String(msg.room ?? '').toLowerCase()];
        if (!roomName || ws.room !== roomName) return wsSend(ws, { type: 'error', code: 'not-in-room', message: 'Bạn chưa vào phòng này.' });
        const state = lotoStateOf(roomName);
        if (!state) return wsSend(ws, { type: 'error', code: 'no-round', message: 'Chưa có vòng Lô Tô nào đang mở.' });
        if (state.hostId !== ws.user.sub && ws.user.rank !== 'qtv') return wsSend(ws, { type: 'error', code: 'not-host', message: 'Chỉ người tạo vòng (hoặc QTV) mới kêu số.' });
        if (state.status !== 'calling') return wsSend(ws, { type: 'error', code: 'loto-calling', message: 'Vòng chưa bắt đầu kêu số.' });
        const number = Number(msg.number);
        if (!Number.isInteger(number) || number < 1 || number > 90) return wsSend(ws, { type: 'error', code: 'bad-numbers', message: 'Số kêu phải từ 01 đến 90.' });
        if (state.called.includes(number)) return wsSend(ws, { type: 'error', code: 'already-called', message: `Số ${number} đã kêu rồi.` });
        state.called.push(number);
        wsBroadcast(roomName, { type: 'loto-called', room: roomName, number });
        const winner = lotoCheckKinh(state);
        if (winner) lotoFinish(roomName, state, winner);
        else lotoBroadcast(roomName);
        break;
      }
      case 'loto-kinh': {
        const roomName = ROOMS[String(msg.room ?? '').toLowerCase()];
        if (!roomName || ws.room !== roomName) return wsSend(ws, { type: 'error', code: 'not-in-room', message: 'Bạn chưa vào phòng này.' });
        const state = lotoStateOf(roomName);
        if (!state) return wsSend(ws, { type: 'error', code: 'no-round', message: 'Chưa có vòng Lô Tô nào đang mở.' });
        if (state.status !== 'calling') return wsSend(ws, { type: 'error', code: 'loto-calling', message: 'Vòng chưa bắt đầu kêu số.' });
        const me = state.players.find((p) => p.userId === ws.user.sub && !p.bot);
        if (!me) return wsSend(ws, { type: 'error', code: 'bad-numbers', message: 'Bạn chưa chốt số ở vòng này.' });
        const called = new Set(state.called);
        if (!me.numbers.every((n) => called.has(n))) return wsSend(ws, { type: 'error', code: 'bad-numbers', message: 'Số của bạn chưa đủ để KINH.' });
        lotoFinish(roomName, state, me);
        break;
      }
      case 'loto-close': {
        const roomName = ROOMS[String(msg.room ?? '').toLowerCase()];
        if (!roomName || ws.room !== roomName) return wsSend(ws, { type: 'error', code: 'not-in-room', message: 'Bạn chưa vào phòng này.' });
        const state = lotoStateOf(roomName);
        if (!state) return wsSend(ws, { type: 'error', code: 'no-round', message: 'Chưa có vòng Lô Tô nào đang mở.' });
        if (state.hostId !== ws.user.sub && !MANAGER_RANKS.has(ws.user.rank)) return wsSend(ws, { type: 'error', code: 'not-host', message: 'Chỉ người tạo vòng hoặc QTV/BĐH mới đóng được vòng.' });
        lotoByRoom.delete(roomName);
        wsBroadcast(roomName, { type: 'loto-closed', room: roomName });
        lotoBroadcast(roomName);
        break;
      }
      default:
        wsSend(ws, { type: 'error', code: 'unknown-type', message: `Không hiểu lệnh: ${msg.type}` });
    }
  });

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { clearTimeout(authTimer); wsLeaveRoom(ws); wsUntrackIp(ws); });
  ws.on('error', () => { /* socket lỗi: close sẽ dọn dẹp */ });
});

// Bot tự chat: mỗi phòng một timer ~10s, bot ngẫu nhiên nói một câu ngẫu nhiên.
function botChatTick(roomName) {
  const bots = botsOf(roomName);
  if (!bots.length) return;
  const bot = bots[Math.floor(Math.random() * bots.length)];
  const text = BOT_CHAT_LINES[Math.floor(Math.random() * BOT_CHAT_LINES.length)];
  const now = Date.now();
  const chatMsg = { id: nextMsgId(), userId: bot.id, name: bot.name, rank: 'member', text, time: new Date(now).toISOString(), bot: true, gender: bot.gender };
  const hist = messagesOf(roomName);
  hist.push(chatMsg);
  if (hist.length > WS_HISTORY) hist.splice(0, hist.length - WS_HISTORY);
  wsBroadcast(roomName, { type: 'message', room: roomName, msg: chatMsg });
}
for (const roomName of DEFAULT_ROOM_ORDER) {
  const t = setInterval(() => botChatTick(roomName), BOT_CHAT_INTERVAL_MS);
  if (t.unref) t.unref();
}

// Ping/pong (v3.5): socket không trả pong sau 1 chu kỳ (máy mất mạng, tab
// bị kill mà không đóng kết nối) bị cắt -> close dọn presence + room-counts.
{
  const t = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) { client.terminate(); continue; }
      client.isAlive = false;
      try { client.ping(); } catch { /* bỏ */ }
    }
  }, WS_PING_MS);
  if (t.unref) t.unref();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    // GET /health — kiểm tra token-server sống + có bật đăng nhập máy chủ không.
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        ok: true, service: 'cctalk-token-server', auth: true,
        legacyToken: LEGACY_TOKEN, users: Object.keys(users).length,
        livekitUrl: LIVEKIT_URL, time: new Date().toISOString(),
        ws: true, connections: wss.clients.size, rooms: allRooms().length,
        lotoRounds: lotoByRoom.size,
        storage: storageMode, // v3.6: 'postgres' (Neon) hoặc 'file' (users.json)
        maintenance: MAINTENANCE, ...(MAINTENANCE ? { message: MAINTENANCE_MESSAGE } : {}),
      });
    }

    // Bảo trì (v3.5): chặn đăng nhập / đăng ký / xin token voice.
    if (MAINTENANCE && ['/login', '/register', '/token'].includes(url.pathname)) {
      return send(res, 503, { error: 'maintenance', message: MAINTENANCE_MESSAGE });
    }

    // GET /rooms — danh sách phòng.
    if (req.method === 'GET' && url.pathname === '/rooms') {
      return send(res, 200, {
        rooms: Object.entries(ROOM_LABELS).map(([name, label]) => ({ room: name, label })),
      });
    }

    // POST /login {id, password} — đăng nhập, trả session.
    if (req.method === 'POST' && url.pathname === '/login') {
      const body = await readBody(req);
      if (!ipAllow(clientIp(req), 'login', 20, 5 * 60 * 1000)) {
        return send(res, 429, { error: 'Đăng nhập quá nhiều lần từ địa chỉ này, thử lại sau 5 phút.' });
      }
      const id = String(body.id || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!id || !password) return send(res, 400, { error: 'Thiếu ID hoặc mật khẩu.' });
      if (loginBlocked(id)) {
        return send(res, 429, { error: 'Đăng nhập sai quá nhiều lần, thử lại sau 5 phút.' });
      }
      const user = users[id];
      // Chạy verify cả khi không có user để thời gian trả lời không lộ user tồn tại.
      const ok = user ? verifyPassword(password, user.passwordHash) : verifyPassword(password, 'scrypt$16384$8$1$00000000000000000000000000000000$00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000');
      if (!ok) {
        loginFailed(id);
        return send(res, 401, { error: 'Sai ID hoặc mật khẩu.' });
      }
      loginAttempts.delete(id);
      return send(res, 200, {
        session: signSession({ id, name: user.name, rank: user.rank }),
        id, name: user.name, rank: user.rank, expiresIn: SESSION_TTL,
        user: profileOf(id),
      });
    }

    // POST /register {id, password, name?} — đăng ký thành viên thường.
    if (req.method === 'POST' && url.pathname === '/register') {
      const body = await readBody(req);
      if (!ipAllow(clientIp(req), 'register', 5, 60 * 60 * 1000)) {
        return send(res, 429, { error: 'Địa chỉ này đã đăng ký quá nhiều tài khoản, thử lại sau 1 giờ.' });
      }
      const id = String(body.id || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.name || '').trim().slice(0, 40) || id;
      if (!validId(id)) {
        return send(res, 400, { error: 'ID không hợp lệ: 3-20 ký tự [a-z0-9_].' });
      }
      if (!password || password.length < 4 || password.length > 64) {
        return send(res, 400, { error: 'Mật khẩu phải dài 4-64 ký tự.' });
      }
      if (users[id]) return send(res, 409, { error: `ID ${id} đã có người dùng.` });
      const gender = body.gender === 'male' || body.gender === 'female' ? body.gender : undefined;
      users[id] = {
        name, rank: 'member', passwordHash: hashPassword(password), createdAt: new Date().toISOString(),
        code: genCode(users, BOT_CODES), points: 0, daily: { date: todayVN(), points: 0 }, onlineMs: 0,
        ...(gender ? { gender } : {}),
      };
      persistUsers(); // v3.6: tài khoản mới lưu ngay (file + Postgres)
      return send(res, 201, {
        session: signSession({ id, name, rank: 'member' }),
        id, name, rank: 'member', expiresIn: SESSION_TTL,
        user: profileOf(id),
      });
    }

    // GET /me — thông tin tài khoản từ session.
    if (req.method === 'GET' && url.pathname === '/me') {
      const session = sessionFromReq(req, Object.fromEntries(url.searchParams.entries()));
      if (!session) return send(res, 401, { error: 'Chưa đăng nhập (thiếu session hợp lệ).' });
      return send(res, 200, { id: session.sub, name: session.name, rank: session.rank, user: profileOf(session.sub) });
    }

    // GET /stage/:room — ai đang trên mic trong phòng (debug).
    if (req.method === 'GET' && url.pathname.startsWith('/stage/')) {
      const roomName = ROOMS[decodeURIComponent(url.pathname.slice(7)).toLowerCase()];
      if (!roomName) return send(res, 400, { error: 'Phòng không hợp lệ.' });
      return send(res, 200, { room: roomName, onStage: [...stageSet(roomName)] });
    }

    // POST /stage { room, onStage } — báo ai lên/xuống mic.
    // Cần session (identity lấy từ session) hoặc header x-stage-secret
    // (khi STAGE_SECRET được đặt — cho code tin cậy phía máy chủ gọi).
    if (req.method === 'POST' && url.pathname === '/stage') {
      const body = await readBody(req);
      const session = sessionFromReq(req, body);
      let identity;
      if (session) {
        identity = session.sub;
        if (body.identity && String(body.identity).toLowerCase() !== identity) {
          return send(res, 400, { error: 'identity không khớp session.' });
        }
      } else if (STAGE_SECRET && req.headers['x-stage-secret'] === STAGE_SECRET) {
        identity = String(body.identity || '').toLowerCase();
      } else {
        return send(res, 401, { error: 'Cần đăng nhập (session) hoặc x-stage-secret.' });
      }
      const roomName = ROOMS[String(body.room ?? '').toLowerCase()];
      if (!roomName) return send(res, 400, { error: 'Phòng không hợp lệ.' });
      if (!identity) return send(res, 400, { error: 'Thiếu identity.' });
      if (body.onStage) stageSet(roomName).add(identity);
      else stageSet(roomName).delete(identity);
      return send(res, 200, { ok: true, room: roomName, onStage: [...stageSet(roomName)] });
    }

    // GET /token?room=208&session=...  hoặc  POST /token { room, session }
    // identity/rank lấy từ SESSION — client gửi rank nào cũng bị bỏ qua.
    if (url.pathname === '/token' && (req.method === 'GET' || req.method === 'POST')) {
      const params = req.method === 'POST'
        ? await readBody(req)
        : Object.fromEntries(url.searchParams.entries());
      if (!ipAllow(clientIp(req), 'token', 60, 5 * 60 * 1000)) {
        return send(res, 429, { error: 'Xin token quá nhiều lần, thử lại sau.' });
      }
      const session = sessionFromReq(req, params);
      if (session) {
        const out = await issueToken({
          room: params.room, identity: session.sub, name: session.name, rank: session.rank,
        });
        if (out.error) return send(res, 400, { error: out.error });
        return send(res, 200, out);
      }
      if (LEGACY_TOKEN) {
        const out = await issueToken(params);
        if (out.error) return send(res, 400, { error: out.error });
        return send(res, 200, out);
      }
      return send(res, 401, { error: 'Cần đăng nhập trước (thiếu session hợp lệ). Gọi POST /login để lấy session.' });
    }

    return send(res, 404, { error: 'Không có endpoint này. Dùng: GET /health, GET /rooms, POST /login, POST /register, GET /me, GET|POST /token, GET|POST /stage.' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: String(err.message || err) });
  }
});

// Nâng cấp HTTP -> WebSocket cho đường /ws (chat/presence/phòng chung).
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const ip = clientIp(req);
  if ((wsConnsByIp.get(ip) || 0) >= MAX_WS_PER_IP) { socket.destroy(); return; }
  if (MAINTENANCE) {
    // Bảo trì: nhận kết nối rồi đóng ngay mã 4503 (trang hiện màn hình chờ).
    wss.handleUpgrade(req, socket, head, (ws) => {
      try { ws.send(JSON.stringify({ type: 'error', code: 'maintenance', message: MAINTENANCE_MESSAGE })); } catch { /* bỏ */ }
      ws.close(4503, 'maintenance');
    });
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wsTrackIp(ws, ip);
    wss.emit('connection', ws, req);
  });
});

// Cổng lắng nghe: Render (và các PaaS khác) cấp cổng qua biến PORT —
// máy chủ PHẢI nghe đúng cổng đó thì Render mới kiểm tra sức khỏe (/health)
// được. Khi chạy local/Docker (không có PORT) thì dùng TOKEN_PORT (3001).
const LISTEN_PORT = Number(process.env.PORT || TOKEN_PORT);

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`cctalk-token-server đang chạy ở cổng ${LISTEN_PORT}`);
  console.log(`LiveKit URL trả cho client: ${LIVEKIT_URL}`);
  console.log(`Đăng nhập phía máy chủ: BẬT (session hạn ${SESSION_TTL})${LEGACY_TOKEN ? ' + chế độ legacy /token đang BẬT' : ''}`);
  console.log(`Phòng: ${Object.values(ROOM_LABELS).join(' | ')}`);
});
