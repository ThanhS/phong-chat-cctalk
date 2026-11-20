// Lưu trữ bền bằng Postgres (Neon) cho token-server (v3.6).
// Khi có biến môi trường DATABASE_URL, kho tài khoản (users) và phòng tự
// tạo (rooms) được lưu vào bảng kv(key, value JSONB) trên Postgres nên
// không còn mất khi máy chủ khởi động lại (Render gói miễn phí không có
// ổ đĩa bền — trước v3.6 tài khoản tự đăng ký + điểm + phòng tự tạo đều
// mất mỗi lần restart). Không có DATABASE_URL (hoặc nối DB thất bại lúc
// khởi động) thì server.js quay về lưu file data/users.json như cũ.
// File này chỉ chứa phần nói chuyện với Postgres; logic gieo tài khoản,
// bù mã số, khôi phục phòng nằm ở server.js / users.js.
import pg from 'pg';

const KV_TABLE_SQL = `CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

const UPSERT_SQL = `INSERT INTO kv (key, value, updated_at)
VALUES ($1, $2, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;

// SSL: chuỗi kết nối của Neon đã có ?sslmode=require -> để thư viện pg tự
// xử lý theo chuỗi. Chuỗi không ghi sslmode: máy local (localhost) thì
// không cần SSL, máy ở xa (Neon/Render...) thì bật SSL (không kiểm chứng
// chuỗi chứng chỉ để tránh lỗi cert ở môi trường container).
export function sslConfigFor(connectionString) {
  try {
    const u = new URL(connectionString);
    const mode = (u.searchParams.get('sslmode') || '').toLowerCase();
    if (mode === 'disable') return false;
    if (mode) return undefined; // pg tự đọc sslmode trong chuỗi kết nối
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    return { rejectUnauthorized: false };
  } catch {
    return undefined;
  }
}

// Mở pool Postgres và kiểm tra nối được ngay (SELECT 1) để lỗi lộ ra lúc
// khởi động chứ không phải lúc lưu đầu tiên. Ném lỗi nếu không nối được.
export async function connectDb(connectionString) {
  const ssl = sslConfigFor(connectionString);
  const pool = new pg.Pool({
    connectionString,
    ...(ssl !== undefined ? { ssl } : {}),
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (e) => console.error('Lỗi pool Postgres:', e.message));
  await pool.query('SELECT 1');
  return pool;
}

// Kho key-value JSON trên Postgres. load() trả về object đã parse (hoặc
// null nếu chưa có key); save() ghi đè toàn bộ value của key.
export function createDbStore(pool) {
  return {
    async init() {
      try {
        await pool.query(KV_TABLE_SQL);
      } catch (e) {
        // pg-mem (dùng khi test) ném lỗi khi bảng đã tồn tại dù câu lệnh
        // có IF NOT EXISTS. Nếu bảng dùng được rồi thì bỏ qua lỗi này.
        await pool.query('SELECT key FROM kv LIMIT 0');
      }
    },
    async load(key) {
      const r = await pool.query('SELECT value FROM kv WHERE key = $1', [key]);
      if (!r.rows.length) return null;
      const v = r.rows[0].value;
      // pg trả JSONB đã parse thành object; pg-mem cũng vậy. Phòng trường
      // hợp driver trả chuỗi thì parse lại.
      if (typeof v === 'string') {
        try { return JSON.parse(v); } catch { return null; }
      }
      return v ?? null;
    },
    async save(key, value) {
      await pool.query(UPSERT_SQL, [key, JSON.stringify(value)]);
    },
    async close() {
      await pool.end();
    },
  };
}
