// Thêm/đặt lại tài khoản trong data/users.json (chạy trên máy chủ).
// Dùng:  node add-user.js <id> <mật khẩu> [rank] [tên hiển thị]
// rank: qtv | bdh-den | bdh-vang | bdh-tim | member (mặc định member).
// Ví dụ: node add-user.js admin MatKhauManh123 qtv "Quản Trị Viên"
// Chạy xong restart token-server để nhận tài khoản mới.
import { loadUsers, saveUsers, hashPassword, validId, RANKS } from './users.js';

const [idRaw, password, rankRaw = 'member', ...nameParts] = process.argv.slice(2);
const id = (idRaw || '').toLowerCase();
const rank = (rankRaw || 'member').toLowerCase();
const name = nameParts.join(' ') || id;

if (!validId(id)) {
  console.error('ID không hợp lệ: 3-20 ký tự [a-z0-9_].');
  process.exit(1);
}
if (!password || password.length < 4 || password.length > 64) {
  console.error('Mật khẩu phải dài 4-64 ký tự.');
  process.exit(1);
}
if (!RANKS.has(rank)) {
  console.error(`rank không hợp lệ: ${rank}. Dùng: ${[...RANKS].join(', ')}.`);
  process.exit(1);
}

const users = loadUsers();
const existed = Boolean(users[id]);
users[id] = { name, rank, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
saveUsers(users);
console.log(`${existed ? 'Đã đặt lại' : 'Đã tạo'} tài khoản ${id} (${rank}).`);
