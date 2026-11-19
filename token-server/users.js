// Kho tài khoản phía máy chủ cho phòng chat ccTalk.
// Mật khẩu chỉ lưu dạng băm scrypt trong data/users.json (chỉ có trên máy
// chủ, KHÔNG commit file này) — trang web không bao giờ thấy mật khẩu hay
// file này. Trang chỉ gửi ID + mật khẩu lên POST /login và nhận về session.
import fs from 'node:fs';
import crypto from 'node:crypto';

const DATA_DIR = new URL('./data/', import.meta.url);
const USERS_FILE = new URL('./data/users.json', import.meta.url);

export const RANKS = new Set(['qtv', 'bdh-den', 'bdh-vang', 'bdh-tim', 'member']);
export const MANAGER_RANKS = new Set(['qtv', 'bdh-den', 'bdh-vang', 'bdh-tim']);

export function usersFileExists() {
  try { return fs.existsSync(USERS_FILE); } catch { return false; }
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [, n, r, p, saltHex, hashHex] = String(stored).split('$');
    const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64, { N: Number(n), r: Number(r), p: Number(p) });
    const expected = Buffer.from(hashHex, 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch { return false; }
}

export function loadUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (data && typeof data === 'object') return data;
  } catch { /* chưa có file hoặc lỗi đọc -> kho trống */ }
  return {};
}

export function saveUsers(users) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = new URL('./data/users.json.tmp', import.meta.url);
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

export function validId(id) {
  return typeof id === 'string' && /^[a-z0-9_]{3,20}$/.test(id);
}

// Đổi cấp bậc của 1 tài khoản và lưu ngay vào data/users.json (dùng cho
// cấp áo BĐH đồng bộ qua hub — v3.4). Trả về true nếu đổi được (id tồn
// tại và rank hợp lệ), false nếu không.
export function setUserRank(users, id, rank) {
  if (!users[id] || !RANKS.has(rank)) return false;
  users[id].rank = rank;
  saveUsers(users);
  return true;
}

// ---- Mã số + điểm + cấp bậc (v3.5) ---------------------------------------
// Mỗi tài khoản có: code (mã số 9 chữ số ngẫu nhiên, duy nhất, chữ số đầu
// 1-9), points (điểm thành viên — tổng cả quá trình), daily ({date, points}
// — điểm tích lũy trong ngày theo giờ Asia/Saigon, tự về 0 khi sang ngày
// mới), onlineMs (thời gian online cộng dồn chưa đủ 1 giờ). Cấp bậc (level)
// tính từ points, không lưu: min(100, 1 + floor(points / 40)).
export const TITLES = {
  qtv: 'Quản trị viên phòng chính',
  'bdh-den': 'Ban điều hành (áo đen)',
  'bdh-vang': 'Ban điều hành (áo vàng)',
  'bdh-tim': 'Ban điều hành (áo tím)',
  member: 'Thành viên',
};

// Ngày hiện tại theo giờ Việt Nam (UTC+7, không có giờ mùa hè).
export function todayVN(now = Date.now()) {
  return new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

export function levelOf(points) {
  return Math.min(100, 1 + Math.floor(Math.max(0, Number(points) || 0) / 40));
}

// Mã số 9 chữ số, chữ số đầu 1-9, không trùng với mã đã có (kể cả mã bot).
export function genCode(users, taken = new Set()) {
  const used = new Set(taken);
  for (const u of Object.values(users)) if (u && u.code) used.add(String(u.code));
  for (;;) {
    const code = String(crypto.randomInt(100000000, 1000000000));
    if (!used.has(code)) return code;
  }
}

// Điểm hôm nay (reset lười: daily.date khác ngày hôm nay -> 0).
export function dailyOf(u) {
  if (!u || !u.daily || u.daily.date !== todayVN()) return 0;
  return Number(u.daily.points) || 0;
}

// Cộng điểm vào cả points (tổng) và daily (hôm nay).
export function addPoints(u, amount) {
  const n = Math.max(0, Math.floor(Number(amount) || 0));
  if (!u || !n) return false;
  const today = todayVN();
  if (!u.daily || u.daily.date !== today) u.daily = { date: today, points: 0 };
  u.points = (Number(u.points) || 0) + n;
  u.daily.points = (Number(u.daily.points) || 0) + n;
  return true;
}

// Bù các trường v3.5 cho tài khoản cũ. Trả về true nếu có thay đổi (cần lưu).
export function ensureUserFields(users, taken = new Set()) {
  let changed = false;
  for (const u of Object.values(users)) {
    if (!u || typeof u !== 'object') continue;
    if (!u.code || !/^[1-9][0-9]{8}$/.test(String(u.code))) { u.code = genCode(users, taken); changed = true; }
    if (!Number.isInteger(u.points) || u.points < 0) { u.points = Math.max(0, Math.floor(Number(u.points) || 0)); changed = true; }
    if (!u.daily || typeof u.daily !== 'object') { u.daily = { date: todayVN(), points: 0 }; changed = true; }
    if (!Number.isFinite(u.onlineMs) || u.onlineMs < 0) { u.onlineMs = 0; changed = true; }
  }
  return changed;
}

// Gieo tài khoản demo từ biến môi trường — CHỈ chạy khi chưa có file users
// (lần khởi động đầu tiên). Mật khẩu lấy từ biến môi trường, không có giá
// trị mặc định nào ghi cứng trong code.
//   ADMIN_PASSWORD -> admin (qtv), BDH_PASSWORD -> bdh (bdh-den),
//   THANH_PASSWORD -> thanh (member, nếu đặt),
//   TEST_PASSWORD  -> test001..test010 (member).
// Trả về danh sách id đã gieo.
export function seedFromEnv(users) {
  const seeds = [];
  if (process.env.ADMIN_PASSWORD) seeds.push(['admin', process.env.ADMIN_PASSWORD, 'Quản Trị Viên', 'qtv']);
  if (process.env.BDH_PASSWORD) seeds.push(['bdh', process.env.BDH_PASSWORD, 'BĐH ccTalk Đen', 'bdh-den']);
  if (process.env.THANH_PASSWORD) seeds.push(['thanh', process.env.THANH_PASSWORD, 'thanh', 'member']);
  if (process.env.TEST_PASSWORD) {
    for (let i = 1; i <= 10; i++) {
      const id = `test${String(i).padStart(3, '0')}`;
      seeds.push([id, process.env.TEST_PASSWORD, `Test ${String(i).padStart(3, '0')}`, 'member']);
    }
  }
  const added = [];
  for (const [id, password, name, rank] of seeds) {
    if (!users[id]) {
      users[id] = {
        name, rank, passwordHash: hashPassword(password), createdAt: new Date().toISOString(),
        code: genCode(users), points: 0, daily: { date: todayVN(), points: 0 }, onlineMs: 0,
      };
      added.push(id);
    }
  }
  return added;
}
