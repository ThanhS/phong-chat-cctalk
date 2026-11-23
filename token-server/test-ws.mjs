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

const lastLogin = {};
async function login(id, password, base = BASE) {
  const r = await fetch(`${base}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`login ${id} failed: ${JSON.stringify(j)}`);
  lastLogin[id] = j;
  return j.session;
}

function connect(opts = {}, url = WS_URL) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
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
  const server = spawn('node', ['server.js'], { cwd: DIR, env: { ...env, WS_PING_MS: '1000' }, stdio: 'pipe' });
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
      const regCodes = [];
      let regGender = null;
      for (let i = 1; i <= 5; i++) {
        const r = await fetch(`${BASE}/register`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: `reg00${i}`, password: 'testpass123', gender: i === 1 ? 'female' : undefined }),
        });
        if (r.status === 201) {
          regOk += 1;
          const j = await r.json();
          regCodes.push(j.user?.code);
          if (i === 1) regGender = j.user?.gender;
        }
      }
      check('đăng ký 5 tài khoản liên tiếp OK', regOk === 5, `ok=${regOk}`);
      const r6 = await fetch(`${BASE}/register`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'reg006', password: 'testpass123' }),
      });
      check('đăng ký thứ 6 bị chặn 429', r6.status === 429, `status=${r6.status}`);


      // ===== v3.5 =====
      // 11. Mã số 9 chữ số, duy nhất.
      const codeRe = /^[1-9][0-9]{8}$/;
      const adminCode = lastLogin.admin?.user?.code;
      check('v3.5 /login trả profile có mã số 9 chữ số', codeRe.test(adminCode || ''), JSON.stringify(lastLogin.admin?.user));
      check('v3.5 /register cấp mã số 9 chữ số cho tài khoản mới', regCodes.length === 5 && regCodes.every((x) => codeRe.test(x || '')), JSON.stringify(regCodes));
      check('v3.5 /register lưu giới tính', regGender === 'female', String(regGender));
      c.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      const st208 = await waitFor(c.msgs, (m) => m.type === 'room-state' && m.room === 'giao-luu-ket-ban' && m.members.some((x) => x.id === 'test002' && x.code));
      const botCodes = st208 ? st208.members.filter((x) => x.bot).map((x) => x.code) : [];
      const allCodes = [adminCode, lastLogin.test001?.user?.code, lastLogin.test002?.user?.code, lastLogin.bdh?.user?.code, ...regCodes, ...botCodes];
      check('v3.5 mã số không trùng (người thật + bot)', allCodes.every((x) => codeRe.test(x || '')) && new Set(allCodes).size === allCodes.length, JSON.stringify(allCodes));
      // 12. Profile trong presence/room-state + /me + auth-ok.
      const me2 = st208?.members.find((x) => x.id === 'test002');
      check('v3.5 room-state members có profile (code/points/daily/level)', !!me2 && codeRe.test(me2.code) && me2.points === 0 && me2.daily === 0 && me2.level === 1 && me2.title === 'Thành viên', JSON.stringify(me2));
      const aBot = st208?.members.find((x) => x.bot);
      check('v3.5 bot có code/points/daily/level giả lập', !!aBot && codeRe.test(aBot.code) && Number.isInteger(aBot.points) && Number.isInteger(aBot.daily) && aBot.level === Math.min(100, 1 + Math.floor(aBot.points / 40)), JSON.stringify(aBot));
      const authA = a.msgs.find((m) => m.type === 'auth-ok');
      check('v3.5 auth-ok.user là profile', !!authA && authA.user.code === adminCode && authA.user.title === 'Quản trị viên phòng chính' && 'points' in authA.user, JSON.stringify(authA?.user));
      const meR = await fetch(`${BASE}/me`, { headers: { Authorization: `Bearer ${cSession}` } });
      const meJ = await meR.json();
      check('v3.5 /me có user profile', meJ.user?.code === lastLogin.test002?.user?.code, JSON.stringify(meJ));

      // 13. Vote: a (admin) vào 208, c (test002) thả tim cho admin -> +1.
      a.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      await waitFor(a.msgs, (m) => m.type === 'room-state' && m.room === 'giao-luu-ket-ban');
      c.ws.send(JSON.stringify({ type: 'vote', room: '208', userId: 'admin' }));
      const v1 = await waitFor(c.msgs, (m) => m.type === 'points' && m.userId === 'admin' && m.points === 1);
      check('v3.5 vote +1 điểm (cả phòng nhận points)', !!v1 && v1.daily === 1, JSON.stringify(v1));
      const v1a = await waitFor(a.msgs, (m) => m.type === 'points' && m.userId === 'admin' && m.points === 1);
      check('v3.5 người được vote cũng nhận points', !!v1a);
      c.ws.send(JSON.stringify({ type: 'vote', room: '208', userId: 'admin' }));
      c.ws.send(JSON.stringify({ type: 'vote', room: '208', userId: 'test002' }));
      c.ws.send(JSON.stringify({ type: 'vote', room: '208', userId: st208?.members.find((x) => x.bot)?.id }));
      const v2 = await waitFor(c.msgs, (m) => m.type === 'points' && m.points === 2, 1500);
      const errV = c.msgs.find((m) => m.type === 'error' && /vote/.test(m.message || ''));
      check('v3.5 vote trong 5s cooldown / tự vote / vote bot -> bỏ qua im lặng', !v2 && !errV && !c.msgs.some((m) => m.type === 'points' && m.userId === 'test002'));
      await sleep(5200);
      c.ws.send(JSON.stringify({ type: 'vote', room: '208', userId: 'admin' }));
      const v3 = await waitFor(c.msgs, (m) => m.type === 'points' && m.userId === 'admin' && m.points === 2);
      check('v3.5 hết cooldown 5s vote lại được +1', !!v3);

      // 14. Thưởng điểm (award).
      a.ws.send(JSON.stringify({ type: 'award', userId: 'test002', amount: 50 }));
      const aw = await waitFor(c.msgs, (m) => m.type === 'awarded' && m.toId === 'test002' && m.amount === 50);
      check('v3.5 QTV thưởng 50 điểm -> phòng nhận awarded', !!aw && aw.fromName === 'Quản Trị Viên' && aw.room === 'giao-luu-ket-ban', JSON.stringify(aw));
      const awP = await waitFor(c.msgs, (m) => m.type === 'points' && m.userId === 'test002' && m.points === 50 && m.level === 2);
      check('v3.5 điểm người được thưởng = 50, cấp bậc 2', !!awP, JSON.stringify(c.msgs.filter((m) => m.type === 'points').slice(-1)));
      a.ws.send(JSON.stringify({ type: 'award', userId: 'test002', amount: 101 }));
      check('v3.5 QTV thưởng 101 -> bad-amount', !!(await waitFor(a.msgs, (m) => m.type === 'error' && m.code === 'bad-amount')));
      a.ws.send(JSON.stringify({ type: 'award', userId: 'admin', amount: 10 }));
      check('v3.5 tự thưởng mình -> forbidden', !!(await waitFor(a.msgs, (m) => m.type === 'error' && m.code === 'forbidden')));
      a.ws.send(JSON.stringify({ type: 'award', userId: 'khongcoai', amount: 10 }));
      check('v3.5 thưởng người không tồn tại -> bad-user', !!(await waitFor(a.msgs, (m) => m.type === 'error' && m.code === 'bad-user')));
      const cErrBefore = c.msgs.filter((m) => m.type === 'error' && m.code === 'forbidden').length;
      c.ws.send(JSON.stringify({ type: 'award', userId: 'admin', amount: 5 }));
      check('v3.5 thành viên thường thưởng điểm -> forbidden', !!(await waitFor(c.msgs, (m) => m.type === 'error' && m.code === 'forbidden' && /thưởng/.test(m.message))) && c.msgs.filter((m) => m.type === 'error' && m.code === 'forbidden').length > cErrBefore);
      for (let i = 0; i < 9; i++) a.ws.send(JSON.stringify({ type: 'award', userId: 'test002', amount: 100 }));
      const aw950 = await waitFor(c.msgs, (m) => m.type === 'points' && m.userId === 'test002' && m.points === 950);
      check('v3.5 QTV thưởng tổng 950/ngày được', !!aw950);
      a.ws.send(JSON.stringify({ type: 'award', userId: 'test002', amount: 100 }));
      check('v3.5 QTV vượt 1000/ngày -> award-limit', !!(await waitFor(a.msgs, (m) => m.type === 'error' && m.code === 'award-limit')));
      const d3 = await connect();
      d3.ws.send(JSON.stringify({ type: 'auth', token: bdhSession }));
      await waitFor(d3.msgs, (m) => m.type === 'auth-ok');
      d3.ws.send(JSON.stringify({ type: 'award', userId: 'admin', amount: 10 }));
      check('v3.5 BĐH đen thưởng QTV (trên cấp) -> forbidden', !!(await waitFor(d3.msgs, (m) => m.type === 'error' && m.code === 'forbidden')));
      d3.ws.send(JSON.stringify({ type: 'award', userId: 'test002', amount: 51 }));
      check('v3.5 BĐH đen thưởng 51 -> bad-amount', !!(await waitFor(d3.msgs, (m) => m.type === 'error' && m.code === 'bad-amount')));
      for (let i = 0; i < 6; i++) d3.ws.send(JSON.stringify({ type: 'award', userId: 'test003', amount: 50 }));
      await waitFor(d3.msgs, () => d3.msgs.filter((m) => m.type === 'awarded' && m.toId === 'test003').length === 6);
      check('v3.5 BĐH đen thưởng tổng 300/ngày được (người nhận không ở phòng nào -> người thưởng vẫn nhận xác nhận)', d3.msgs.filter((m) => m.type === 'awarded' && m.toId === 'test003').length === 6, `awarded=${d3.msgs.filter((m) => m.type === 'awarded').length}`);
      d3.ws.send(JSON.stringify({ type: 'award', userId: 'test003', amount: 1 }));
      check('v3.5 BĐH đen vượt 300/ngày -> award-limit', !!(await waitFor(d3.msgs, (m) => m.type === 'error' && m.code === 'award-limit')));
      d3.ws.close();

      // 15. Style chữ chat.
      await sleep(900);
      a.ws.send(JSON.stringify({ type: 'message', room: '208', text: 'chữ đỏ cỡ 18', style: { color: '#DC2626', size: 18 } }));
      const sty = await waitFor(c.msgs, (m) => m.type === 'message' && m.msg?.text === 'chữ đỏ cỡ 18');
      check('v3.5 style hợp lệ được giữ + broadcast', !!sty && sty.msg.style?.color === '#dc2626' && sty.msg.style?.size === 18, JSON.stringify(sty?.msg));
      await sleep(900);
      a.ws.send(JSON.stringify({ type: 'message', room: '208', text: 'style sai', style: { color: 'red', size: 99 } }));
      const sty2 = await waitFor(c.msgs, (m) => m.type === 'message' && m.msg?.text === 'style sai');
      check('v3.5 style sai -> bỏ style, tin vẫn gửi', !!sty2 && !sty2.msg.style, JSON.stringify(sty2?.msg));
      const hist = await connect();
      hist.ws.send(JSON.stringify({ type: 'auth', token: cSession }));
      await waitFor(hist.msgs, (m) => m.type === 'auth-ok');
      hist.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      const hst = await waitFor(hist.msgs, (m) => m.type === 'room-state');
      check('v3.5 style lưu trong lịch sử chat', !!hst && hst.messages.find((m) => m.text === 'chữ đỏ cỡ 18')?.style?.size === 18);
      hist.ws.close();

      // 15b. Style v3.7: cỡ nguyên 12-20, màu #ffff00, đậm/nghiêng/gạch chân.
      await sleep(900);
      a.ws.send(JSON.stringify({ type: 'message', room: '208', text: 'v37 cỡ 15', style: { color: '#2563eb', size: 15 } }));
      const s15 = await waitFor(c.msgs, (m) => m.type === 'message' && m.msg?.text === 'v37 cỡ 15');
      check('v3.7 cỡ 15 được giữ', !!s15 && s15.msg.style?.size === 15, JSON.stringify(s15?.msg));
      await sleep(900);
      a.ws.send(JSON.stringify({ type: 'message', room: '208', text: 'v37 cỡ 21', style: { color: '#2563eb', size: 21 } }));
      const s21 = await waitFor(c.msgs, (m) => m.type === 'message' && m.msg?.text === 'v37 cỡ 21');
      check('v3.7 cỡ 21 -> bỏ style', !!s21 && !s21.msg.style, JSON.stringify(s21?.msg));
      await sleep(900);
      a.ws.send(JSON.stringify({ type: 'message', room: '208', text: 'v37 cỡ 11', style: { color: '#2563eb', size: 11 } }));
      const s11 = await waitFor(c.msgs, (m) => m.type === 'message' && m.msg?.text === 'v37 cỡ 11');
      check('v3.7 cỡ 11 -> bỏ style', !!s11 && !s11.msg.style, JSON.stringify(s11?.msg));
      await sleep(900);
      a.ws.send(JSON.stringify({ type: 'message', room: '208', text: 'v37 vàng đậm nghiêng gạch', style: { color: '#FFFF00', size: 16, b: true, i: true, u: true } }));
      const sbi = await waitFor(c.msgs, (m) => m.type === 'message' && m.msg?.text === 'v37 vàng đậm nghiêng gạch');
      check('v3.7 #ffff00 + b/i/u được giữ + broadcast', !!sbi && sbi.msg.style?.color === '#ffff00' && sbi.msg.style?.b === true && sbi.msg.style?.i === true && sbi.msg.style?.u === true, JSON.stringify(sbi?.msg));
      await sleep(900);
      a.ws.send(JSON.stringify({ type: 'message', room: '208', text: 'v37 b không phải boolean', style: { color: '#2563eb', size: 14, b: 'yes' } }));
      const sbn = await waitFor(c.msgs, (m) => m.type === 'message' && m.msg?.text === 'v37 b không phải boolean');
      check('v3.7 b không phải boolean -> bỏ cả style', !!sbn && !sbn.msg.style, JSON.stringify(sbn?.msg));
      const hist2 = await connect();
      hist2.ws.send(JSON.stringify({ type: 'auth', token: cSession }));
      await waitFor(hist2.msgs, (m) => m.type === 'auth-ok');
      hist2.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      const hst2 = await waitFor(hist2.msgs, (m) => m.type === 'room-state');
      const hm = hst2?.messages.find((m) => m.text === 'v37 vàng đậm nghiêng gạch');
      check('v3.7 b/i/u + #ffff00 lưu trong lịch sử', !!hm && hm.style?.color === '#ffff00' && hm.style?.b === true && hm.style?.i === true && hm.style?.u === true, JSON.stringify(hm));
      hist2.ws.close();

      // 16. Socket chết (không trả pong) + đóng đột ngột -> room-counts về đúng.
      await sleep(500);
      const base208 = () => { const l = c.msgs.filter((m) => m.type === 'room-counts').slice(-1)[0]; return l?.counts.find((x) => x.room === 'giao-luu-ket-ban')?.count; };
      const before = base208();
      const s3 = await login('test003', 'testpass123');
      const dead = await connect({ autoPong: false });
      dead.ws.send(JSON.stringify({ type: 'auth', token: s3 }));
      await waitFor(dead.msgs, (m) => m.type === 'auth-ok');
      dead.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      const up = await waitFor(c.msgs, (m) => m.type === 'room-counts' && m.counts.find((x) => x.room === 'giao-luu-ket-ban')?.count === before + 1);
      check('v3.5 socket mới vào 208 -> room-counts +1', !!up, `before=${before}`);
      const mark = c.msgs.length;
      const down = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 6000) { const f = c.msgs.slice(mark).find((m) => m.type === 'room-counts' && m.counts.find((x) => x.room === 'giao-luu-ket-ban')?.count === before); if (f) return f; await sleep(50); } return null; })();
      check('v3.5 socket không trả pong bị dọn -> room-counts về đúng', !!down);
      const abrupt = await connect();
      abrupt.ws.send(JSON.stringify({ type: 'auth', token: s3 }));
      await waitFor(abrupt.msgs, (m) => m.type === 'auth-ok');
      abrupt.ws.send(JSON.stringify({ type: 'join', room: '208' }));
      await waitFor(c.msgs.slice(0), () => true);
      const mark2 = c.msgs.length;
      await waitFor(abrupt.msgs, (m) => m.type === 'room-state');
      abrupt.ws.terminate();
      const down2 = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 6000) { const f = c.msgs.slice(mark2).find((m) => m.type === 'room-counts' && m.counts.find((x) => x.room === 'giao-luu-ket-ban')?.count === before); if (f) return f; await sleep(50); } return null; })();
      check('v3.5 đóng kết nối đột ngột -> room-counts về đúng', !!down2);
      const h = await (await fetch(`${BASE}/health`)).json();
      check('v3.5 /health luôn có maintenance:false', h.maintenance === false, JSON.stringify(h));

      // ===== v3.8: giới hạn thành viên/phòng =====
      // 17. Member đặt giới hạn -> forbidden; QTV đặt giới hạn 1 cho phòng 101.
      c.ws.send(JSON.stringify({ type: 'set-room-limit', room: '101', limit: 1 }));
      const limDenied = await waitFor(c.msgs, (m) => m.type === 'error' && m.code === 'forbidden' && /giới hạn/.test(m.message || ''));
      check('v3.8 thành viên đặt giới hạn -> forbidden', !!limDenied);
      a.ws.send(JSON.stringify({ type: 'join', room: '101' }));
      await waitFor(a.msgs, (m) => m.type === 'room-state' && m.room === 'dai-sanh');
      a.ws.send(JSON.stringify({ type: 'set-room-limit', room: '101', limit: 1 }));
      const limA = await waitFor(a.msgs, (m) => m.type === 'room-limit' && m.room === 'dai-sanh' && m.limit === 1);
      const limC = await waitFor(c.msgs, (m) => m.type === 'room-limit' && m.room === 'dai-sanh' && m.limit === 1);
      check('v3.8 QTV đặt giới hạn 1 -> phát room-limit cho mọi máy', !!limA && !!limC);
      // Danh sách phòng + room-state mang theo limit; cùng 1 người mở máy thứ 2 vẫn vào được.
      const a2 = await connect();
      a2.ws.send(JSON.stringify({ type: 'auth', token: adminSession }));
      const roomsA2 = await waitFor(a2.msgs, (m) => m.type === 'rooms');
      check('v3.8 rooms list có limit của phòng', roomsA2?.rooms.find((r) => r.room === 'dai-sanh')?.limit === 1, JSON.stringify(roomsA2?.rooms));
      a2.ws.send(JSON.stringify({ type: 'join', room: '101' }));
      const stateA2 = await waitFor(a2.msgs, (m) => m.type === 'room-state' && m.room === 'dai-sanh');
      check('v3.8 cùng người mở máy thứ 2 vào phòng đầy vẫn được + room-state có limit', !!stateA2 && stateA2.limit === 1, JSON.stringify(stateA2?.limit));
      // Người thật thứ 2 vào phòng đầy -> room-full, không vào được.
      const cStatesBefore = c.msgs.filter((m) => m.type === 'room-state' && m.room === 'dai-sanh').length;
      c.ws.send(JSON.stringify({ type: 'join', room: '101' }));
      const full = await waitFor(c.msgs, (m) => m.type === 'error' && m.code === 'room-full');
      check('v3.8 người thứ 2 vào phòng đầy -> room-full', !!full && /giới hạn 1/.test(full.message || ''), JSON.stringify(full));
      await sleep(300);
      check('v3.8 bị room-full thì không nhận room-state (không vào được)', c.msgs.filter((m) => m.type === 'room-state' && m.room === 'dai-sanh').length === cStatesBefore);
      // Bỏ giới hạn (0) -> vào lại được.
      a.ws.send(JSON.stringify({ type: 'set-room-limit', room: '101', limit: 0 }));
      const lim0 = await waitFor(c.msgs, (m) => m.type === 'room-limit' && m.room === 'dai-sanh' && m.limit === 0);
      check('v3.8 đặt giới hạn 0 -> phát room-limit 0', !!lim0);
      c.ws.send(JSON.stringify({ type: 'join', room: '101' }));
      const stateC101 = await waitFor(c.msgs, (m) => m.type === 'room-state' && m.room === 'dai-sanh');
      check('v3.8 bỏ giới hạn -> vào phòng lại được (limit 0)', !!stateC101 && stateC101.limit === 0);
      // Giới hạn sai -> bad-limit.
      const badBefore = a.msgs.filter((m) => m.type === 'error' && m.code === 'bad-limit').length;
      a.ws.send(JSON.stringify({ type: 'set-room-limit', room: '101', limit: 9999 }));
      a.ws.send(JSON.stringify({ type: 'set-room-limit', room: '101', limit: -1 }));
      a.ws.send(JSON.stringify({ type: 'set-room-limit', room: '101', limit: 2.5 }));
      const bad3 = await waitFor(a.msgs, () => a.msgs.filter((m) => m.type === 'error' && m.code === 'bad-limit').length >= badBefore + 3);
      check('v3.8 giới hạn 9999 / -1 / 2.5 -> bad-limit', !!bad3, `bad=${a.msgs.filter((m) => m.type === 'error' && m.code === 'bad-limit').length}`);
      a2.ws.close();

      a.ws.close();
      c.ws.close();
    }
  } finally {
    server.kill('SIGTERM');
    await sleep(500);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  // ===== v3.5: cộng điểm online (giờ rút ngắn 1.5s) — server riêng cổng 3103 =====
  {
    const P2 = 3103, B2 = `http://localhost:${P2}`, W2 = `ws://localhost:${P2}/ws`;
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    const srv = spawn('node', ['server.js'], { cwd: DIR, env: { ...env, PORT: String(P2), ONLINE_POINT_MS: '1500', BDH_PASSWORD: 'bdhpass123' }, stdio: 'pipe' });
    srv.stderr.on('data', (d) => process.stdout.write('[server2:err] ' + d));
    try {
      let ok2 = false;
      for (let i = 0; i < 20; i++) { try { if ((await fetch(`${B2}/health`)).ok) { ok2 = true; break; } } catch { /* chưa lên */ } await sleep(500); }
      check('v3.5 server điểm online khởi động', ok2);
      const sA = await login('admin', 'adminpass123', B2);
      const sB = await login('bdh', 'bdhpass123', B2);
      const sT = await login('test001', 'testpass123', B2);
      const cl = [];
      for (const tok of [sA, sB, sT, sT]) {
        const x = await connect({}, W2);
        x.ws.send(JSON.stringify({ type: 'auth', token: tok }));
        await waitFor(x.msgs, (m) => m.type === 'auth-ok');
        cl.push(x);
      }
      const pA = await waitFor(cl[0].msgs, (m) => m.type === 'points' && m.userId === 'admin', 6000);
      const pB = await waitFor(cl[1].msgs, (m) => m.type === 'points' && m.userId === 'bdh', 6000);
      const pT = await waitFor(cl[2].msgs, (m) => m.type === 'points' && m.userId === 'test001', 6000);
      check('v3.5 online đủ 1 "giờ" -> QTV +15', pA?.points === 15 && pA?.daily === 15, JSON.stringify(pA));
      check('v3.5 online đủ 1 "giờ" -> BĐH đen +12', pB?.points === 12, JSON.stringify(pB));
      check('v3.5 online đủ 1 "giờ" -> thành viên +10 (2 máy chỉ tính 1)', pT?.points === 10, JSON.stringify(pT));
      for (const x of cl) x.ws.close();
      await sleep(300);
    } finally {
      srv.kill('SIGTERM');
      await sleep(800);
    }
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8')); } catch { /* bỏ */ }
    check('v3.5 điểm online được lưu vào users.json khi tắt máy chủ', !!saved && saved.test001?.points >= 10 && saved.admin?.points >= 15, JSON.stringify({ t: saved?.test001?.points, a: saved?.admin?.points }));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  // ===== v3.5: chế độ bảo trì — server riêng cổng 3104 =====
  {
    const P3 = 3104, B3 = `http://localhost:${P3}`, W3 = `ws://localhost:${P3}/ws`;
    const srv = spawn('node', ['server.js'], { cwd: DIR, env: { ...env, PORT: String(P3), MAINTENANCE: '1', MAINTENANCE_MESSAGE: 'Đang nâng cấp v3.5' }, stdio: 'pipe' });
    srv.stderr.on('data', (d) => process.stdout.write('[server3:err] ' + d));
    try {
      let h = null;
      for (let i = 0; i < 20; i++) { try { const r = await fetch(`${B3}/health`); if (r.ok) { h = await r.json(); break; } } catch { /* chưa lên */ } await sleep(500); }
      check('v3.5 bảo trì: /health 200 maintenance:true + message', h?.ok === true && h?.maintenance === true && h?.message === 'Đang nâng cấp v3.5', JSON.stringify(h));
      const post = (p, body) => fetch(`${B3}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const rl = await post('/login', { id: 'admin', password: 'adminpass123' });
      const jl = await rl.json();
      check('v3.5 bảo trì: /login 503 error:maintenance', rl.status === 503 && jl.error === 'maintenance' && jl.message === 'Đang nâng cấp v3.5', `${rl.status} ${JSON.stringify(jl)}`);
      const rr = await post('/register', { id: 'newbie', password: 'testpass123' });
      check('v3.5 bảo trì: /register 503', rr.status === 503 && (await rr.json()).error === 'maintenance');
      const rt = await post('/token', { room: '101' });
      check('v3.5 bảo trì: /token 503', rt.status === 503);
      const code = await new Promise((resolve) => {
        const ws = new WebSocket(W3);
        ws.on('error', () => {});
        ws.on('close', (c) => resolve(c));
        setTimeout(() => resolve(null), 5000);
      });
      check('v3.5 bảo trì: /ws đóng mã 4503', code === 4503, `code=${code}`);
    } finally {
      srv.kill('SIGTERM');
      await sleep(800);
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }
  }

  console.log(`\nKết quả: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('Lỗi test:', e); process.exit(1); });
