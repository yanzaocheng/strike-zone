// =====================================================================
//  Strike Zone 联机服务器（主进程）
//  - WebSocket 大厅：房间列表、创建/加入房间
//  - 每个房间运行在独立的 worker 线程中（room.js：完整的游戏模拟）
//  - 主线程只负责连接管理与消息转发
//  启动：PORT=8795 node server.js
// =====================================================================
'use strict';
const http = require('http');
const path = require('path');
const { Worker } = require('worker_threads');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8795;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_ROOMS = +process.env.MAX_ROOMS || 6;
const MAX_PER_ROOM = 10;
const MAX_CLIENTS = 100;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map();     // code → room
const clients = new Map();   // cid → client
let nextCid = 1;

const log = (...a) => console.log(new Date().toISOString(), ...a);

function makeCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
function sanitizeName(s) {
  s = String(s || '').replace(/[\u0000-\u001f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || ('玩家' + Math.floor(100 + Math.random() * 900));
}
function send(c, data) {
  if (c.ws.readyState === 1) c.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
}
function roomList() {
  return [...rooms.values()].map(r => ({ code: r.code, name: r.name, humans: r.clients.size, max: MAX_PER_ROOM, opts: r.opts, info: r.info }));
}

// ---------------------------------------------------------------------
//  房间
// ---------------------------------------------------------------------
function createRoom(owner, opts) {
  if (rooms.size >= MAX_ROOMS) return null;
  let code;
  do { code = makeCode(); } while (rooms.has(code));
  const o = {
    winRounds: [5, 8, 13].includes(+opts.winRounds) ? +opts.winRounds : 8,
    difficulty: ['easy', 'normal', 'hard', 'expert'].includes(opts.difficulty) ? opts.difficulty : 'normal',
    bots: opts.bots !== false && opts.bots !== 0,
  };
  const name = sanitizeName(owner.name) + ' 的房间';
  const worker = new Worker(path.join(__dirname, 'room.js'), {
    workerData: { code, name, opts: o },
    resourceLimits: { maxOldGenerationSizeMb: 192 },
  });
  const room = { code, name, opts: o, worker, clients: new Set(), info: {}, emptySince: Date.now(), closing: false };
  worker.on('message', (m) => onWorkerMsg(room, m));
  worker.on('error', (e) => { log(`[room ${code}] worker error`, e && e.stack || e); closeRoom(room, '房间发生错误，已关闭'); });
  worker.on('exit', (codeNum) => {
    rooms.delete(room.code);
    for (const cid of room.clients) {
      const c = clients.get(cid);
      if (c && c.room === room) { c.room = null; c.team = ''; send(c, { t: 'kicked', msg: '房间已关闭' }); }
    }
    log(`[room ${code}] closed (exit ${codeNum})`);
  });
  rooms.set(code, room);
  log(`[room ${code}] created by ${owner.name}`, JSON.stringify(o));
  return room;
}
function closeRoom(room, msg) {
  if (room.closing) return;
  room.closing = true;
  for (const cid of room.clients) {
    const c = clients.get(cid);
    if (c && c.room === room) { c.room = null; c.team = ''; send(c, { t: 'kicked', msg: msg || '房间已关闭' }); }
  }
  room.clients.clear();
  rooms.delete(room.code);
  room.worker.terminate();
}
function onWorkerMsg(room, m) {
  if (m.type === 'info') { room.info = m.info; return; }
  if (m.type === 'empty') { room.emptySince = Date.now(); return; }
  const msg = m.msg;
  // 记录客户端阵营（队伍消息路由用）
  if (typeof m.to === 'number') {
    const c = clients.get(m.to);
    if (c && (msg.t === 'you' || (msg.t === 'ev' && msg.e === 'team'))) c.team = msg.team;
  }
  const data = JSON.stringify(msg);
  if (m.to === '*' || m.to === 'T' || m.to === 'CT') {
    for (const cid of room.clients) {
      if (cid === m.except) continue;
      const c = clients.get(cid);
      if (!c || (m.to !== '*' && c.team !== m.to)) continue;
      send(c, data);
    }
  } else {
    const c = clients.get(m.to);
    if (c && c.room === room) send(c, data);
  }
}
function joinRoom(c, room, team) {
  c.room = room;
  room.clients.add(c.cid);
  send(c, { t: 'joined', code: room.code, name: room.name, opts: room.opts });
  room.worker.postMessage({ type: 'join', cid: c.cid, name: c.name, team: team === 'T' || team === 'CT' ? team : 'auto' });
  log(`[room ${room.code}] + ${c.name} (${room.clients.size})`);
}
function leaveRoom(c) {
  const room = c.room;
  if (!room) return;
  room.clients.delete(c.cid);
  c.room = null; c.team = '';
  room.worker.postMessage({ type: 'leave', cid: c.cid });
  if (!room.clients.size) room.emptySince = Date.now();
  log(`[room ${room.code}] - ${c.name} (${room.clients.size})`);
}

// ---------------------------------------------------------------------
//  客户端
// ---------------------------------------------------------------------
function handle(c, m) {
  switch (m.t) {
    case 'hello':
      c.name = sanitizeName(m.name);
      send(c, { t: 'rooms', rooms: roomList() });
      break;
    case 'list':
      send(c, { t: 'rooms', rooms: roomList() });
      break;
    case 'create': {
      if (c.room) leaveRoom(c);
      if (!c.name) c.name = sanitizeName(m.name);
      const r = createRoom(c, m.opts || {});
      if (!r) { send(c, { t: 'error', msg: '服务器房间数已满，请稍后再试或加入已有房间' }); break; }
      joinRoom(c, r, m.team);
      break;
    }
    case 'join': {
      const r = rooms.get(String(m.code || '').trim().toUpperCase());
      if (!r || r.closing) { send(c, { t: 'error', msg: '房间不存在或已关闭' }); break; }
      if (r.clients.size >= MAX_PER_ROOM) { send(c, { t: 'error', msg: '房间已满（最多 10 人）' }); break; }
      if (c.room) leaveRoom(c);
      if (!c.name) c.name = sanitizeName(m.name);
      joinRoom(c, r, m.team);
      break;
    }
    case 'leave':
      leaveRoom(c);
      send(c, { t: 'left' });
      break;
    default:
      if (c.room) c.room.worker.postMessage({ type: 'msg', cid: c.cid, msg: m });
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/ws/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: clients.size, list: roomList() }));
    return;
  }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32 * 1024, perMessageDeflate: false });

wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_CLIENTS) { ws.close(1013, 'server full'); return; }
  const c = { cid: nextCid++, ws, name: '', room: null, team: '', msgs: 0, alive: true };
  clients.set(c.cid, c);
  ws.on('message', (data) => {
    if (++c.msgs > 300) { ws.close(1008, 'rate limit'); return; }
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(c, m); } catch (e) { log('handle error', e && e.stack || e); }
  });
  ws.on('pong', () => { c.alive = true; });
  ws.on('close', () => { leaveRoom(c); clients.delete(c.cid); });
  ws.on('error', () => {});
  send(c, { t: 'welcome', cid: c.cid, rooms: roomList() });
});

// 每秒清零消息计数；15 秒心跳；清理空房间
setInterval(() => { for (const c of clients.values()) c.msgs = 0; }, 1000);
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch (e) { /* 忽略 */ }
  }
}, 15000);
setInterval(() => {
  for (const r of rooms.values()) if (!r.clients.size && Date.now() - r.emptySince > 30000) closeRoom(r);
}, 5000);

server.listen(PORT, HOST, () => log(`Strike Zone server listening on ${HOST}:${PORT}`));
process.on('SIGTERM', () => { for (const r of rooms.values()) r.worker.terminate(); process.exit(0); });
