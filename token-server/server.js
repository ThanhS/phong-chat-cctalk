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

import http from 'node:http';
import crypto from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import {
  loadUsers, saveUsers, usersFileExists, seedFromEnv,
  hashPassword, verifyPassword, validId, RANKS, MANAGER_RANKS,
} from './users.js';

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
    return payload;
  } catch { return null; }
}

// ---- Kho tài khoản --------------------------------------------------------

// Gieo tài khoản demo từ biến môi trường chỉ ở lần khởi động đầu tiên
// (khi chưa có file data/users.json). Từ lần sau, file users.json quyết định.
let users = loadUsers();
if (!usersFileExists()) {
  const seeded = seedFromEnv(users);
  if (seeded.length) {
    saveUsers(users);
    console.log(`Đã tạo tài khoản từ biến môi trường: ${seeded.join(', ')}`);
  } else {
    console.log('Chưa có tài khoản nào. Đặt ADMIN_PASSWORD/BDH_PASSWORD/TEST_PASSWORD trong .env rồi restart, hoặc tạo bằng POST /register.');
  }
} else {
  console.log(`Đã tải ${Object.keys(users).length} tài khoản từ data/users.json.`);
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
      });
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
      });
    }

    // POST /register {id, password, name?} — đăng ký thành viên thường.
    if (req.method === 'POST' && url.pathname === '/register') {
      const body = await readBody(req);
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
      users[id] = { name, rank: 'member', passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
      saveUsers(users);
      return send(res, 201, {
        session: signSession({ id, name, rank: 'member' }),
        id, name, rank: 'member', expiresIn: SESSION_TTL,
      });
    }

    // GET /me — thông tin tài khoản từ session.
    if (req.method === 'GET' && url.pathname === '/me') {
      const session = sessionFromReq(req, Object.fromEntries(url.searchParams.entries()));
      if (!session) return send(res, 401, { error: 'Chưa đăng nhập (thiếu session hợp lệ).' });
      return send(res, 200, { id: session.sub, name: session.name, rank: session.rank });
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

server.listen(Number(TOKEN_PORT), '0.0.0.0', () => {
  console.log(`cctalk-token-server đang chạy ở cổng ${TOKEN_PORT}`);
  console.log(`LiveKit URL trả cho client: ${LIVEKIT_URL}`);
  console.log(`Đăng nhập phía máy chủ: BẬT (session hạn ${SESSION_TTL})${LEGACY_TOKEN ? ' + chế độ legacy /token đang BẬT' : ''}`);
  console.log(`Phòng: ${Object.values(ROOM_LABELS).join(' | ')}`);
});
