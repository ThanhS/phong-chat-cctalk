// Kiểm tra lưu trữ bền Postgres (v3.6).
// Chạy: node test-db.mjs
//   Phần A: db.js bằng pg-mem (SQL thật chạy trong bộ nhớ).
//   Phần B: server thật + Postgres thật (embedded-postgres chạy dưới user
//           nobody vì Postgres không chạy bằng root) qua DATABASE_URL —
//           khởi động với DB trống (gieo + lưu), restart (tải lại tài
//           khoản gồm điểm/mã số/áo, phòng tự tạo còn nguyên, thưởng điểm
//           còn), và DATABASE_URL hỏng (quay về lưu file, server vẫn chạy).
// Bản sao test + dữ liệu Postgres nằm ở /tmp và được dọn sạch khi xong.
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import pg from 'pg';
import { newDb } from 'pg-mem';
import { createDbStore } from './db.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RUN_DIR = `/tmp/cctalk-dbtest-${process.pid}`;
const PG_PORT = 55432;
const DATABASE_URL = `postgres://test:test@127.0.0.1:${PG_PORT}/cctalk`;
const DEAD_URL = 'postgres://test:test@127.0.0.1:55999/cctalk';

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(id, password, base) {
  const r = await fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`login ${id} failed: ${JSON.stringify(j)}`);
  return j;
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgs = [];
    ws.on('message', (d) => { try { msgs.push(JSON.parse(String(d))); } catch { /* bỏ */ } });
    ws.on('open', () => { ws.on('error', () => {}); resolve({ ws, msgs }); });
    ws.on('error', reject);
  });
}
async function waitFor(msgs, pred, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const found = msgs.find(pred);
    if (found) return found;
    await sleep(50);
  }
  return null;
}
async function waitHealth(base, timeout = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const r = await fetch(`${base}/health`); if (r.ok) return await r.json(); } catch { /* chưa lên */ }
    await sleep(400);
  }
  return null;
}
function startServer(port, extraEnv) {
  const env = {
    ...process.env,
    LIVEKIT_API_KEY: 'testkey', LIVEKIT_API_SECRET: 'testsecret',
    SESSION_SECRET: 'test-session-secret',
    ADMIN_PASSWORD: 'adminpass123', BDH_PASSWORD: 'bdhpass123',
    TEST_PASSWORD: 'testpass123', PORT: String(port),
    ...extraEnv,
  };
  const srv = spawn('node', ['server.js'], { cwd: RUN_DIR, env, stdio: 'pipe' });
  srv._out = '';
  srv.stdout.on('data', (d) => { srv._out += d; process.stdout.write(`[server${port}] ` + d); });
  srv.stderr.on('data', (d) => { srv._out += d; process.stdout.write(`[server${port}:err] ` + d); });
  return srv;
}
async function stopServer(srv) {
  const exited = new Promise((r) => srv.on('exit', r));
  srv.kill('SIGTERM');
  const done = await Promise.race([exited.then(() => true), sleep(10000).then(() => false)]);
  if (!done) { srv.kill('SIGKILL'); await exited; }
  return done;
}

const HELPER_SRC = `
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
const dir = process.argv[2];
const port = Number(process.argv[3]);
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'test', password: 'test', port, persistent: true });
if (!fs.existsSync(dir + '/PG_VERSION')) await pg.initialise();
await pg.start();
try { await pg.createDatabase('cctalk'); } catch { /* đã có */ }
console.log('PG_UP');
const stop = async () => { try { await pg.stop(); } catch { /* bỏ */ } process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.resume();
process.stdin.on('end', stop);
setInterval(() => {}, 1 << 30);
`;

async function main() {
  // ===== Phần A: db.js với pg-mem =====
  {
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    const pool = new Pool();
    const store = createDbStore(pool);
    await store.init();
    await store.init();
    check('v3.6 pg-mem: init tạo bảng kv (chạy 2 lần không lỗi)', true);
    check('v3.6 pg-mem: load key chưa có -> null', (await store.load('users')) === null);
    const u1 = { admin: { name: 'Quản Trị Viên', rank: 'qtv', code: '123456789', points: 42, daily: { date: '2026-11-20', points: 7 }, onlineMs: 0 } };
    await store.save('users', u1);
    const back1 = await store.load('users');
    check('v3.6 pg-mem: lưu + tải users khớp', back1?.admin?.points === 42 && back1?.admin?.code === '123456789' && back1?.admin?.daily?.points === 7, JSON.stringify(back1));
    await store.save('users', { admin: { ...u1.admin, points: 99 } });
    check('v3.6 pg-mem: ghi đè users (upsert)', (await store.load('users'))?.admin?.points === 99);
    const rooms = { customRooms: [{ room: 'phong-104', id: 104, label: 'Phòng DB (ID 104)', createdBy: 'admin' }], byCreator: { admin: 1 } };
    await store.save('rooms', rooms);
    const backR = await store.load('rooms');
    check('v3.6 pg-mem: lưu + tải rooms khớp', backR?.customRooms?.[0]?.room === 'phong-104' && backR?.customRooms?.[0]?.id === 104 && backR?.byCreator?.admin === 1, JSON.stringify(backR));
    await pool.end();
  }

  // ===== Phần B: server thật + Postgres thật =====
  let helper = null;
  try {
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
    fs.mkdirSync(RUN_DIR, { recursive: true });
    execSync(`cp -a ${DIR}/server.js ${DIR}/users.js ${DIR}/db.js ${DIR}/add-user.js ${DIR}/package.json ${DIR}/node_modules ${RUN_DIR}/`);
    fs.writeFileSync(path.join(RUN_DIR, 'pg-helper.mjs'), HELPER_SRC);
    fs.mkdirSync(path.join(RUN_DIR, 'pgdata'));
    fs.mkdirSync(path.join(RUN_DIR, 'home'));
    execSync(`chmod -R a+rX ${RUN_DIR} && chown -R nobody:nogroup ${RUN_DIR}/pgdata ${RUN_DIR}/home`);

    helper = spawn('runuser', ['-u', 'nobody', '--', 'env', `HOME=${RUN_DIR}/home`, 'node', path.join(RUN_DIR, 'pg-helper.mjs'), path.join(RUN_DIR, 'pgdata'), String(PG_PORT)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let pgUp = false;
    helper.stdout.on('data', (d) => { if (String(d).includes('PG_UP')) pgUp = true; });
    helper.stderr.on('data', (d) => process.stdout.write('[pg:err] ' + d));
    for (let i = 0; i < 300 && !pgUp; i++) await sleep(500);
    check('v3.6 Postgres test khởi động (embedded, user nobody)', pgUp);

    if (pgUp) {
      const P = 3105, B = `http://localhost:${P}`, W = `ws://localhost:${P}/ws`;

      // --- Lần chạy 1: DB trống -> gieo từ env + lưu lên DB ---
      const srv1 = startServer(P, { DATABASE_URL });
      const h1 = await waitHealth(B);
      check('v3.6 boot DB trống: /health storage=postgres', h1?.ok === true && h1?.storage === 'postgres', JSON.stringify(h1));
      const admin1 = await login('admin', 'adminpass123', B);
      const t1Login = await login('test001', 'testpass123', B);
      const test001Code = t1Login.user?.code;
      check('v3.6 boot DB trống: gieo tài khoản từ env, đăng nhập được', !!admin1.session && /^[1-9][0-9]{8}$/.test(test001Code || ''));

      const reg = await fetch(`${B}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'dbtest1', password: 'testpass123', name: 'DB Test' }),
      });
      const regJ = await reg.json();
      const dbtestCode = regJ.user?.code;
      check('v3.6 đăng ký tài khoản mới khi dùng DB', reg.status === 201 && /^[1-9][0-9]{8}$/.test(dbtestCode || ''), `status=${reg.status}`);

      const a = await connect(W);
      a.ws.send(JSON.stringify({ type: 'auth', token: admin1.session }));
      await waitFor(a.msgs, (m) => m.type === 'auth-ok');
      a.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      await waitFor(a.msgs, (m) => m.type === 'room-state');
      const t1 = await connect(W);
      t1.ws.send(JSON.stringify({ type: 'auth', token: t1Login.session }));
      await waitFor(t1.msgs, (m) => m.type === 'auth-ok');
      t1.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      await waitFor(t1.msgs, (m) => m.type === 'room-state');

      a.ws.send(JSON.stringify({ type: 'award', userId: 'test001', amount: 40 }));
      const p40 = await waitFor(t1.msgs, (m) => m.type === 'points' && m.userId === 'test001' && m.points === 40);
      check('v3.6 thưởng điểm 40 (lưu theo lô)', !!p40);
      a.ws.send(JSON.stringify({ type: 'set-rank', userId: 'test002', rank: 'bdh-vang' }));
      const rankOk = await waitFor(a.msgs, (m) => m.type === 'rank-changed' && m.userId === 'test002' && m.rank === 'bdh-vang');
      check('v3.6 cấp áo vàng cho test002', !!rankOk);
      a.ws.send(JSON.stringify({ type: 'create-room', name: 'Phòng DB' }));
      const created = await waitFor(a.msgs, (m) => m.type === 'room-created');
      check('v3.6 tạo phòng tự tạo (ID 104)', !!created && created.id === 104, JSON.stringify(created));
      // Thưởng thêm 10 rồi tắt ngay (trong cửa sổ lưu theo lô 5s) -> flush
      // lúc SIGTERM phải lưu nốt thành 50.
      a.ws.send(JSON.stringify({ type: 'award', userId: 'test001', amount: 10 }));
      await waitFor(t1.msgs, (m) => m.type === 'points' && m.userId === 'test001' && m.points === 50);
      a.ws.close();
      t1.ws.close();
      const exited1 = await stopServer(srv1);
      check('v3.6 server tắt sạch bằng SIGTERM (flush DB)', exited1);

      // Xóa file local để chứng minh lần chạy 2 lấy dữ liệu từ DB.
      fs.rmSync(path.join(RUN_DIR, 'data'), { recursive: true, force: true });

      // --- Lần chạy 2: restart -> tải lại từ DB ---
      const srv2 = startServer(P, { DATABASE_URL });
      const h2 = await waitHealth(B);
      check('v3.6 restart: /health storage=postgres, đủ 13 tài khoản (12 gieo + 1 đăng ký)', h2?.storage === 'postgres' && h2?.users === 13, JSON.stringify(h2));
      const dbtestLogin = await login('dbtest1', 'testpass123', B);
      check('v3.6 restart: tài khoản tự đăng ký còn nguyên + đúng mã số', dbtestLogin.user?.code === dbtestCode, JSON.stringify(dbtestLogin.user));
      const t2Login = await login('test002', 'testpass123', B);
      check('v3.6 restart: áo BĐH đã cấp còn nguyên (bdh-vang)', t2Login.rank === 'bdh-vang' && t2Login.user?.rank === 'bdh-vang', JSON.stringify(t2Login.user));
      const t1Login2 = await login('test001', 'testpass123', B);
      check('v3.6 restart: điểm thưởng còn nguyên (50) + mã số không đổi', t1Login2.user?.points === 50 && t1Login2.user?.code === test001Code, JSON.stringify(t1Login2.user));
      const roomsR = await (await fetch(`${B}/rooms`)).json();
      check('v3.6 restart: phòng tự tạo còn trong /rooms', roomsR.rooms?.some((r) => r.room === 'phong-104' && r.label === 'Phòng DB (ID 104)'), JSON.stringify(roomsR.rooms));
      const admin2 = await login('admin', 'adminpass123', B);
      const a2 = await connect(W);
      a2.ws.send(JSON.stringify({ type: 'auth', token: admin2.session }));
      await waitFor(a2.msgs, (m) => m.type === 'auth-ok');
      a2.ws.send(JSON.stringify({ type: 'join', room: '104' }));
      const st104 = await waitFor(a2.msgs, (m) => m.type === 'room-state' && m.room === 'phong-104');
      check('v3.6 restart: vào được phòng tự tạo đã khôi phục', !!st104);
      const tok = await fetch(`${B}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin2.session}` },
        body: JSON.stringify({ room: '104' }),
      });
      check('v3.6 restart: /token cho phòng đã khôi phục', tok.ok, `status=${tok.status}`);
      a2.ws.close();
      await stopServer(srv2);

      // Kiểm tra thẳng trong Postgres: bảng kv có đủ 2 key + đúng dữ liệu.
      const pool = new pg.Pool({ connectionString: DATABASE_URL });
      const kv = await pool.query('SELECT key, value FROM kv ORDER BY key');
      const byKey = Object.fromEntries(kv.rows.map((r) => [r.key, r.value]));
      check('v3.6 Postgres: bảng kv có key users + rooms', !!byKey.users && !!byKey.rooms, JSON.stringify(kv.rows.map((r) => r.key)));
      check('v3.6 Postgres: users.test001.points = 50', byKey.users?.test001?.points === 50, JSON.stringify(byKey.users?.test001));
      check('v3.6 Postgres: rooms chứa phong-104 + byCreator', byKey.rooms?.customRooms?.[0]?.room === 'phong-104' && byKey.rooms?.byCreator?.admin === 1, JSON.stringify(byKey.rooms));
      await pool.end();
    }

    // --- DATABASE_URL hỏng -> quay về lưu file, server vẫn chạy ---
    fs.rmSync(path.join(RUN_DIR, 'data'), { recursive: true, force: true });
    const P3 = 3106, B3 = `http://localhost:${P3}`;
    const srv3 = startServer(P3, { DATABASE_URL: DEAD_URL });
    const h3 = await waitHealth(B3);
    check('v3.6 DATABASE_URL hỏng: server vẫn chạy, storage=file', h3?.ok === true && h3?.storage === 'file', JSON.stringify(h3));
    check('v3.6 DATABASE_URL hỏng: có cảnh báo lớn trong log', /không nối được Postgres/.test(srv3._out));
    const admin3 = await login('admin', 'adminpass123', B3);
    check('v3.6 DATABASE_URL hỏng: đăng nhập bằng kho file vẫn được', !!admin3.session);
    await stopServer(srv3);
  } finally {
    // Dọn Postgres test: đóng stdin của helper + tắt postmaster theo PID.
    try { helper?.stdin?.end(); } catch { /* bỏ */ }
    await sleep(1500);
    try {
      const pidFile = path.join(RUN_DIR, 'pgdata', 'postmaster.pid');
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').split('\n')[0]);
        if (pid) process.kill(pid, 'SIGINT');
      }
    } catch { /* bỏ */ }
    await sleep(1500);
    try { helper?.kill('SIGKILL'); } catch { /* bỏ */ }
    try { execSync(`pkill -f "postgres.*${RUN_DIR}/pgdata" || true`); } catch { /* bỏ */ }
    await sleep(500);
    fs.rmSync(RUN_DIR, { recursive: true, force: true });
  }

  console.log(`\nKết quả: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('Lỗi test:', e); process.exit(1); });
