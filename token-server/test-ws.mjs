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
      const presB = await waitFor(b.msgs, (m) => m.type === 'presence' && m.members.filter((x) => !x.bot).length === 2);
      check('presence thấy đủ 2 người thật', !!presB, JSON.stringify(b.msgs.filter((m) => m.type === 'presence').slice(-1)));
      check('presence có 10 bot cho đông vui', !!presB && presB.members.filter((x) => x.bot).length === 10, `bots=${presB ? presB.members.filter((x) => x.bot).length : '?'}`);

      // 2b. Số người/phòng phát cho mọi máy: 208 có 12 (10 bot + 2 người), các phòng khác 10.
      const countsB = await waitFor(b.msgs, (m) => m.type === 'room-counts' && m.counts.find((x) => x.room === 'giao-luu-ket-ban')?.count === 12);
      check('room-counts: phòng 208 = 12 người', !!countsB, JSON.stringify(b.msgs.filter((m) => m.type === 'room-counts').slice(-1)));
      check('room-counts: phòng khác = 10 bot', !!countsB && countsB.counts.find((x) => x.room === 'dai-sanh')?.count === 10 && countsB.counts.find((x) => x.room === 'giao-luu')?.count === 10 && countsB.counts.find((x) => x.room === 'ho-tro')?.count === 10, JSON.stringify(countsB?.counts));

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

      // 4b. Bot tự chat: trong ~20s phải thấy tin bot ở phòng 208.
      const botMsg = await waitFor(b.msgs, (m) => m.type === 'message' && m.msg?.bot === true, 20000);
      check('bot tự chat (có tag bot)', !!botMsg, JSON.stringify(botMsg?.msg));

      // 4c. Lô Tô chung: admin tạo vòng, BĐH khác tạo thì bị chặn, chốt số + kêu số + KINH chung.
      const bdhSession = await login('bdh', 'bdhpass123');
      const d = await connect();
      d.ws.send(JSON.stringify({ type: 'auth', token: bdhSession }));
      await waitFor(d.msgs, (m) => m.type === 'auth-ok');
      d.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      await waitFor(d.msgs, (m) => m.type === 'room-state');

      a.ws.send(JSON.stringify({ type: 'loto-create', room: '208', kinh: 3 }));
      const lotoStateB = await waitFor(b.msgs, (m) => m.type === 'loto-state' && m.state && m.state.active && m.state.kinh === 3);
      check('BĐH tạo vòng -> cả phòng nhận loto-state', !!lotoStateB && lotoStateB.state.status === 'registering');
      check('vòng mới có 10 bot chơi cùng', !!lotoStateB && lotoStateB.state.players.filter((p) => p.bot).length === 10, `bots=${lotoStateB ? lotoStateB.state.players.filter((p) => p.bot).length : '?'}`);
      d.ws.send(JSON.stringify({ type: 'loto-create', room: '208', kinh: 4 }));
      const busy = await waitFor(d.msgs, (m) => m.type === 'error' && m.code === 'loto-busy');
      check('BĐH khác tạo vòng khi đang có vòng -> bị chặn', !!busy);
      b.ws.send(JSON.stringify({ type: 'loto-join', room: '208', numbers: [5, 12, 33] }));
      const joinedB = await waitFor(b.msgs, (m) => m.type === 'loto-state' && m.state.players.some((p) => p.userId === 'test001' && p.numbers.join(',') === '5,12,33'));
      check('thành viên chốt số -> cả phòng thấy', !!joinedB);
      b.ws.send(JSON.stringify({ type: 'loto-join', room: '208', numbers: [1, 2] }));
      const badNums = await waitFor(b.msgs, (m) => m.type === 'error' && m.code === 'bad-numbers');
      check('chốt sai số lượng -> báo lỗi', !!badNums);
      a.ws.send(JSON.stringify({ type: 'loto-start', room: '208' }));
      const callingB = await waitFor(b.msgs, (m) => m.type === 'loto-state' && m.state.status === 'calling');
      check('chủ vòng bắt đầu kêu -> cả phòng thấy', !!callingB);
      b.ws.send(JSON.stringify({ type: 'loto-join', room: '208', numbers: [7, 8, 9] }));
      const lateJoin = await waitFor(b.msgs, (m) => m.type === 'error' && m.code === 'loto-calling');
      check('đang kêu số thì không chốt số được nữa', !!lateJoin);
      a.ws.send(JSON.stringify({ type: 'loto-called', room: '208', number: 5 }));
      const called5 = await waitFor(b.msgs, (m) => m.type === 'loto-called' && m.number === 5);
      check('số kêu được phát cho cả phòng', !!called5);
      a.ws.send(JSON.stringify({ type: 'loto-called', room: '208', number: 12 }));
      await waitFor(b.msgs, (m) => m.type === 'loto-called' && m.number === 12);
      a.ws.send(JSON.stringify({ type: 'loto-called', room: '208', number: 33 }));
      const kinhB = await waitFor(b.msgs, (m) => m.type === 'loto-kinh' && m.winner?.userId === 'test001');
      check('đủ số -> KINH phát cho cả phòng', !!kinhB, JSON.stringify(kinhB?.winner));
      const finishedB = await waitFor(b.msgs, (m) => m.type === 'loto-state' && m.state.status === 'finished');
      check('vòng chuyển sang finished sau KINH', !!finishedB);
      d.ws.send(JSON.stringify({ type: 'loto-create', room: '208', kinh: 2 }));
      const newRound = await waitFor(d.msgs, (m) => m.type === 'loto-state' && m.state && m.state.active && m.state.kinh === 2 && m.state.status === 'registering');
      check('hết vòng -> BĐH khác tạo được vòng mới', !!newRound);
      // Người vào sau thấy vòng hiện tại trong room-state.
      c.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      const stateC2 = await waitFor(c.msgs, (m) => m.type === 'room-state' && m.loto && m.loto.active && m.loto.kinh === 2);
      check('người vào sau thấy vòng Lô Tô trong room-state', !!stateC2);
      d.ws.close();

      // 5. Member tạo phòng -> bị từ chối; admin tạo -> mọi người nhận rooms mới.
      b.ws.send(JSON.stringify({ type: 'create-room', name: 'Phòng Test' }));
      const denied = await waitFor(b.msgs, (m) => m.type === 'error' && m.code === 'forbidden');
      check('member tạo phòng bị từ chối', !!denied);
      a.ws.send(JSON.stringify({ type: 'create-room', name: 'Phòng Test' }));
      const created = await waitFor(a.msgs, (m) => m.type === 'room-created');
      check('admin tạo phòng OK (ID 104)', !!created && created.id === 104, JSON.stringify(created));
      const roomsB = await waitFor(b.msgs, (m) => m.type === 'rooms' && m.rooms.some((r) => r.id === 104));
      check('phòng mới phát cho mọi người', !!roomsB);

      // 5b. Giới hạn phòng: mỗi người tối đa 5 phòng tự tạo (admin đã tạo 1).
      for (let i = 0; i < 4; i++) {
        a.ws.send(JSON.stringify({ type: 'create-room', name: `Phòng Test ${i + 2}` }));
        const ok = await waitFor(a.msgs, (m) => m.type === 'room-created' && m.id === 105 + i);
        if (!ok) break;
      }
      const roomsCount = a.msgs.filter((m) => m.type === 'room-created').length;
      check('tạo thêm 4 phòng (đủ 5/người)', roomsCount === 5, `created=${roomsCount}`);
      a.ws.send(JSON.stringify({ type: 'create-room', name: 'Phòng Test 6' }));
      const tooMany = await waitFor(a.msgs, (m) => m.type === 'error' && m.code === 'too-many-rooms');
      check('tạo phòng thứ 6 -> bị chặn (tối đa 5/người)', !!tooMany);

      // 6. Vào phòng tự tạo được.
      a.ws.send(JSON.stringify({ type: 'join', room: '104' }));
      const stateNew = await waitFor(a.msgs, (m) => m.type === 'room-state' && m.room === 'phong-104');
      check('vào phòng tự tạo được', !!stateNew);

      // 6b. Số người/phòng cập nhật khi đổi phòng: 104 có 1 người (a), 208 còn 12 (b, c + 10 bot; d đã rời sau vòng Lô Tô).
      const countsC = await waitFor(c.msgs, (m) => m.type === 'room-counts' && m.counts.find((x) => x.room === 'phong-104')?.count === 1 && m.counts.find((x) => x.room === 'giao-luu-ket-ban')?.count === 12);
      check('room-counts: phòng tự tạo = 1, phòng 208 còn 12', !!countsC, JSON.stringify(c.msgs.filter((m) => m.type === 'room-counts').slice(-1)));

      // 7. Rời phòng -> presence cập nhật (208 còn lại test002).
      b.ws.close();
      const presC = await waitFor(c.msgs, (m) => m.type === 'presence' && m.members.filter((x) => !x.bot).length === 1 && m.members.find((x) => !x.bot)?.id === 'test002', 5000);
      check('rời phòng cập nhật presence', !!presC, JSON.stringify(c.msgs.filter((m) => m.type === 'presence').slice(-1)));
      const countsC2 = await waitFor(c.msgs, (m) => m.type === 'room-counts' && m.counts.find((x) => x.room === 'giao-luu-ket-ban')?.count === 11);
      check('room-counts cập nhật khi có người rời phòng (208 còn 11)', !!countsC2);

      // 8. /token cho phòng tự tạo vẫn chạy (voice).
      const tok = await fetch(`${BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminSession}` },
        body: JSON.stringify({ room: '104' }),
      });
      check('/token cho phòng tự tạo', tok.ok, `status=${tok.status}`);

      // 8b. Cấp áo BĐH đồng bộ (v3.4): admin cấp áo vàng cho test001 -> mọi máy nhận rank-changed.
      a.ws.send(JSON.stringify({ type: 'set-rank', userId: 'test001', rank: 'bdh-vang' }));
      const rankA = await waitFor(a.msgs, (m) => m.type === 'rank-changed' && m.userId === 'test001' && m.rank === 'bdh-vang');
      check('admin cấp áo vàng cho test001 -> phát rank-changed', !!rankA);
      const rankC = await waitFor(c.msgs, (m) => m.type === 'rank-changed' && m.userId === 'test001' && m.rank === 'bdh-vang');
      check('máy khác cũng nhận rank-changed', !!rankC);
      // Người được cấp áo giữ áo khi đăng nhập lại + đổi phòng (rank lấy từ kho tài khoản).
      const bSession2 = await login('test001', 'testpass123');
      const b2 = await connect();
      b2.ws.send(JSON.stringify({ type: 'auth', token: bSession2 }));
      const authB2 = await waitFor(b2.msgs, (m) => m.type === 'auth-ok');
      check('đăng nhập lại vẫn giữ áo vàng', !!authB2 && authB2.user.rank === 'bdh-vang', JSON.stringify(authB2?.user));
      b2.ws.send(JSON.stringify({ type: 'join', room: '102' }));
      const stateB2 = await waitFor(b2.msgs, (m) => m.type === 'room-state' && m.room === 'giao-luu');
      check('đổi phòng vẫn giữ áo vàng', !!stateB2 && stateB2.members.find((x) => x.id === 'test001')?.rank === 'bdh-vang');
      // Thành viên thường không cấp được áo; BĐH đen không cấp được áo đen (ngang cấp).
      c.ws.send(JSON.stringify({ type: 'set-rank', userId: 'test001', rank: 'bdh-tim' }));
      const deniedMember = await waitFor(c.msgs, (m) => m.type === 'error' && m.code === 'forbidden');
      check('thành viên thường cấp áo -> bị từ chối', !!deniedMember);
      const d2 = await connect();
      d2.ws.send(JSON.stringify({ type: 'auth', token: bdhSession }));
      await waitFor(d2.msgs, (m) => m.type === 'auth-ok');
      d2.ws.send(JSON.stringify({ type: 'set-rank', userId: 'test002', rank: 'bdh-den' }));
      const deniedBlack = await waitFor(d2.msgs, (m) => m.type === 'error' && m.code === 'forbidden');
      check('BĐH đen cấp áo đen (ngang cấp) -> bị từ chối', !!deniedBlack);
      // BĐH đen cấp được áo vàng cho thành viên; admin gỡ áo về lại thành viên (dọn dẹp).
      d2.ws.send(JSON.stringify({ type: 'set-rank', userId: 'test002', rank: 'bdh-vang' }));
      const rankD2 = await waitFor(d2.msgs, (m) => m.type === 'rank-changed' && m.userId === 'test002' && m.rank === 'bdh-vang');
      check('BĐH đen cấp áo vàng cho thành viên được', !!rankD2);
      a.ws.send(JSON.stringify({ type: 'set-rank', userId: 'test002', rank: 'member' }));
      const demoteC = await waitFor(c.msgs, (m) => m.type === 'rank-changed' && m.userId === 'test002' && m.rank === 'member');
      check('admin gỡ áo test002 về thành viên', !!demoteC);
      a.ws.send(JSON.stringify({ type: 'set-rank', userId: 'test001', rank: 'member' }));
      const demoteB = await waitFor(a.msgs, (m) => m.type === 'rank-changed' && m.userId === 'test001' && m.rank === 'member');
      check('admin gỡ áo test001 về thành viên', !!demoteB);
      b2.ws.close();
      d2.ws.close();

      // 9. Giới hạn kết nối WS theo IP: đang có 2 kết nối (a, c) -> mở thêm 8 được, cái thứ 9 bị từ chối.
      const extra = [];
      for (let i = 0; i < 8; i++) extra.push(await connect());
      check('mở thêm 8 kết nối WS (đủ 10/IP)', extra.length === 8);
      const refused = await new Promise((resolve) => {
        const ws = new WebSocket(WS_URL);
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        ws.on('open', () => finish(false));
        ws.on('error', () => finish(true));
        ws.on('close', () => finish(true));
        setTimeout(() => finish(false), 5000);
      });
      check('kết nối WS thứ 11/IP bị từ chối', refused);
      for (const conn of extra) conn.ws.close();

      // 10. Giới hạn đăng ký theo IP: 5 tài khoản liên tiếp OK, cái thứ 6 bị chặn 429.
      let regOk = 0;
      for (let i = 1; i <= 5; i++) {
        const r = await fetch(`${BASE}/register`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: `reg00${i}`, password: 'testpass123' }),
        });
        if (r.status === 201) regOk += 1;
      }
      check('đăng ký 5 tài khoản liên tiếp OK', regOk === 5, `ok=${regOk}`);
      const r6 = await fetch(`${BASE}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'reg006', password: 'testpass123' }),
      });
      check('đăng ký thứ 6 bị chặn 429', r6.status === 429, `status=${r6.status}`);

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
