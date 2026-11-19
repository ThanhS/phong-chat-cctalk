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
      users[id] = { name, rank, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
      added.push(id);
    }
  }
  return added;
}
