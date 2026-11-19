// Kiểm tra hub WebSocket của token-server (chat + hiện diện + phòng chung).
// Chạy: node test-ws.mjs  (tự khởi động server test ở cổng 3102 rồi tắt)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3102;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/ws`;
const DATA_DIR = path.join(DIR, 'data');

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(id, password) {
  const r = await fetch(`${BASE}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`login ${id} failed: ${JSON.stringify(j)}`);
  return j.session;
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const msgs = [];
    ws.on('message', (d) => { try { msgs.push(JSON.parse(String(d))); } catch { /* bỏ */ } });
    ws.on('open', () => { ws.on('error', () => {}); resolve({ ws, msgs }); });
    ws.on('error', reject);
  });
}

async function waitFor(msgs, pred, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const found = msgs.find(pred);
    if (found) return found;
    await sleep(50);
  }
  return null;
}

async function main() {
  // Dọn data test cũ (nếu có) để server gieo tài khoản từ biến môi trường.
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const env = {
    ...process.env,
    LIVEKIT_API_KEY: 'testkey', LIVEKIT_API_SECRET: 'testsecret',
    SESSION_SECRET: 'test-session-secret',
    ADMIN_PASSWORD: 'adminpass123', BDH_PASSWORD: 'bdhpass123',
    TEST_PASSWORD: 'testpass123', PORT: String(PORT),
  };
  const server = spawn('node', ['server.js'], { cwd: DIR, env, stdio: 'pipe' });
  server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  server.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d));

  try {
    let healthy = false;
    for (let i = 0; i < 20; i++) {
      try { const r = await fetch(`${BASE}/health`); if (r.ok) { healthy = true; break; } } catch { /* chưa lên */ }
      await sleep(500);
    }
    check('server khởi động + /health', healthy);

    if (healthy) {
      const adminSession = await login('admin', 'adminpass123');
      const testSession = await login('test001', 'testpass123');
      check('đăng nhập admin + test001', !!adminSession && !!testSession);

      // 1. WS không auth -> bị đóng 4401 sau ~10s.
      const anon = new WebSocket(WS_URL);
      anon.on('error', () => {});
      const anonClosed = await new Promise((resolve) => {
        anon.on('close', (code) => resolve(code));
        setTimeout(() => resolve(null), 12000);
      });
      check('WS không auth bị đóng (4401)', anonClosed === 4401, `(code=${anonClosed})`);

      // 2. Hai client vào phòng 208.
      const a = await connect();
      const b = await connect();
      a.ws.send(JSON.stringify({ type: 'auth', token: adminSession }));
      b.ws.send(JSON.stringify({ type: 'auth', token: testSession }));
      check('auth admin OK', !!(await waitFor(a.msgs, (m) => m.type === 'auth-ok')));
      check('auth test001 OK', !!(await waitFor(b.msgs, (m) => m.type === 'auth-ok')));
      a.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      b.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      const stateA = await waitFor(a.msgs, (m) => m.type === 'room-state');
      check('vào phòng 208 nhận room-state', !!stateA && stateA.room === 'giao-luu-ket-ban');
      const presB = await waitFor(b.msgs, (m) => m.type === 'presence' && m.members.length === 2);
      check('presence thấy đủ 2 người', !!presB, JSON.stringify(b.msgs.filter((m) => m.type === 'presence').slice(-1)));

      // 3. Admin nhắn -> test001 nhận.
      a.ws.send(JSON.stringify({ type: 'message', room: '208', text: 'xin chào từ admin' }));
      const got = await waitFor(b.msgs, (m) => m.type === 'message' && m.msg?.text === 'xin chào từ admin');
      check('tin nhắn admin -> test001 nhận được', !!got);
      check('tin nhắn mang đúng tên + rank', got?.msg?.name === 'Quản Trị Viên' && got?.msg?.rank === 'qtv', JSON.stringify(got?.msg));

      // 4. Người thứ 3 vào sau nhận được lịch sử.
      const cSession = await login('test002', 'testpass123');
      const c = await connect();
      c.ws.send(JSON.stringify({ type: 'auth', token: cSession }));
      await waitFor(c.msgs, (m) => m.type === 'auth-ok');
      c.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      const stateC = await waitFor(c.msgs, (m) => m.type === 'room-state');
      check('người vào sau nhận lịch sử chat', !!stateC && stateC.messages.some((m) => m.text === 'xin chào từ admin'));

      // 5. Member tạo phòng -> bị từ chối; admin tạo -> mọi người nhận rooms mới.
      b.ws.send(JSON.stringify({ type: 'create-room', name: 'Phòng Test' }));
      const denied = await waitFor(b.msgs, (m) => m.type === 'error' && m.code === 'forbidden');
      check('member tạo phòng bị từ chối', !!denied);
      a.ws.send(JSON.stringify({ type: 'create-room', name: 'Phòng Test' }));
      const created = await waitFor(a.msgs, (m) => m.type === 'room-created');
      check('admin tạo phòng OK (ID 104)', !!created && created.id === 104, JSON.stringify(created));
      const roomsB = await waitFor(b.msgs, (m) => m.type === 'rooms' && m.rooms.some((r) => r.id === 104));
      check('phòng mới phát cho mọi người', !!roomsB);

      // 6. Vào phòng tự tạo được.
      a.ws.send(JSON.stringify({ type: 'join', room: '104' }));
      const stateNew = await waitFor(a.msgs, (m) => m.type === 'room-state' && m.room === 'phong-104');
      check('vào phòng tự tạo được', !!stateNew);

      // 7. Rời phòng -> presence cập nhật (208 còn lại test002).
      b.ws.close();
      const presC = await waitFor(c.msgs, (m) => m.type === 'presence' && m.members.length === 1 && m.members[0].id === 'test002', 5000);
      check('rời phòng cập nhật presence', !!presC, JSON.stringify(c.msgs.filter((m) => m.type === 'presence').slice(-1)));

      // 8. /token cho phòng tự tạo vẫn chạy (voice).
      const tok = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSession}` },
        body: JSON.stringify({ room: '104' }),
      });
      check('/token cho phòng tự tạo', tok.ok, `status=${tok.status}`);

      a.ws.close();
      c.ws.close();
    }
  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\nKết quả: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('Lỗi test:', e); process.exit(1); });
