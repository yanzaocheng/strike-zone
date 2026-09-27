// =====================================================================
//  联机房间逻辑：每个房间一个 worker 线程，复用游戏的完整模拟代码
//  - 服务器权威：Bot AI、回合、经济、炸弹、投掷物、掉落物、伤害结算
//  - 真人玩家：位置/视角由客户端上报（做合理性校验），命中由客户端上报、服务器校验后结算
// =====================================================================

// ---- 服务器上用不到的界面模块：空实现 ----
const Game = { player: null, state: 'playing', bots: [] };
const UI = new Proxy({}, { get: () => () => {} });
const NetClient = { send() {}, sendHit() {}, sendShot() {} };

const ROOM = workerData;   // { code, name, opts: { winRounds, difficulty, bots } }
const HELD_IDS = ['knife', 'g18', 'p2k', 'd50', 'v45', 'g35', 'k47', 'm4', 's08', 'l96', 'he', 'flash', 'smoke', 'c4'];
const RSTATE = { menu: 0, freeze: 1, live: 2, end: 3, over: 4 };
const BSTATE = { carried: 0, planted: 1, defused: 2, exploded: 3 };
const _s1 = new THREE.Vector3(), _s2 = new THREE.Vector3();
const q2 = (v) => Math.round(v * 100) / 100;
const q3 = (v) => Math.round(v * 1000) / 1000;

// ---- 初始化世界 ----
SETTINGS.difficulty = ROOM.opts.difficulty;
SETTINGS.winRounds = ROOM.opts.winRounds;
SETTINGS.teammates = 0;
MapBuilder.build(new THREE.Scene());
Nav.build();
Items.init(null); Bomb.init(null); Grenades.init(null);
Combat.chars = [];

const humans = new Map();       // cid → NetHuman
let worldTime = 0;
let restartTimer = null;

/** 发给主线程转发：to = 客户端 id | '*' 全体 | 'T' / 'CT' 队伍 */
function post(to, msg, except = 0) { parentPort.postMessage({ to, msg, except }); }
function ev(to, e, data, except = 0) { post(to, Object.assign({ t: 'ev', e }, data), except); }

// =====================================================================
//  真人玩家（服务器侧）
// =====================================================================
class NetHuman extends Character {
  constructor(cid, name, team) {
    super(team, name);
    this.isHuman = true;
    this.cid = cid;
    this.useOn = false; this.planting = false;
    this.lastSt = -1; this.stepAcc = 0; this.ping = 0;
    this.netHeld = '';
    this.invDirty = true; this.invSwitch = '';
    this.pendingTeam = null;
    this.tokens = {};        // 命中频率令牌桶（按武器）
    this.shotTokens = 12;
    this.alive = false;
    this.spawnPos = new THREE.Vector3();
  }
  heldId() { return this.netHeld || super.heldId(); }

  /** 应用客户端上报的状态（位置做防瞬移校验） */
  applyState(m) {
    if (!this.alive || !Array.isArray(m.p)) return;
    const x = +m.p[0], y = +m.p[1], z = +m.p[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    const dt = this.lastSt < 0 ? 0.05 : Math.max(0.016, worldTime - this.lastSt);
    this.lastSt = worldTime;
    if (Round.state === 'freeze') {
      // 冻结时间只能在出生点附近转身
      if (Math.hypot(x - this.spawnPos.x, z - this.spawnPos.z) > 0.6) this.correct(this.spawnPos);
    } else {
      const d = Math.hypot(x - this.pos.x, z - this.pos.z);
      if (d > 9.5 * dt + 1.3 || Math.abs(y - this.pos.y) > 4 || Math.abs(x) > 40 || Math.abs(z) > 40) this.correct(this.pos);
      else this.pos.set(x, y, z);
    }
    if (Array.isArray(m.v)) this.vel.set(clamp(+m.v[0] || 0, -12, 12), clamp(+m.v[1] || 0, -30, 12), clamp(+m.v[2] || 0, -12, 12));
    if (Array.isArray(m.a)) { this.yaw = wrapAngle(+m.a[0] || 0); this.pitch = clamp(+m.a[1] || 0, -1.56, 1.56); }
    const f = m.f | 0;
    this.onGround = !!(f & 1); this.walking = !!(f & 2); this.crouching = !!(f & 4); this.scope = (f & 8) ? 1 : 0;
    this.netReload = !!(f & 16); this.netCharge = !!(f & 32);     // 仅用于其他客户端的动画
    this.crouch = clamp((m.cr | 0) / 100, 0, 1);
    this.height = this.crouching ? CFG.PLAYER.CROUCH_HEIGHT : CFG.PLAYER.HEIGHT;
    const held = HELD_IDS[m.h | 0];
    if (held) this.setHeld(held, m.am);
  }
  correct(p) {
    this.pos.copy(p);
    post(this.cid, { t: 'tp', p: [q2(p.x), q2(p.y), q2(p.z)] });
  }
  /** 客户端当前手持的武器 → 服务器侧槽位（击杀武器判定、第三人称模型）+ 弹药 */
  setHeld(held, am) {
    const inv = this.inv;
    const mdl = (w) => w && (w.def.model || w.def.id);
    if (mdl(inv.primary) === held) this.slot = 'primary';
    else if (mdl(inv.secondary) === held) this.slot = 'secondary';
    else if (held === 'knife') this.slot = 'knife';
    else if (NADES[held] && inv[held] > 0) { this.slot = 'nade'; this.nadeType = held; }
    else if (held === 'c4' && inv.bomb) this.slot = 'bomb';
    else return;
    this.netHeld = held;
    const w = this.curWeapon();
    if (w && w.def.mag && Array.isArray(am)) {
      w.mag = clamp(am[0] | 0, 0, w.def.mag);
      w.reserve = clamp(am[1] | 0, 0, w.def.reserve);
    }
  }

  update(dt) {
    if (!this.alive) return;
    // 跑步脚步声 → Bot 的听觉
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hs > 3.2 && !this.walking && !this.crouching) {
      this.stepAcc += hs * dt;
      if (this.stepAcc > 1.9) { this.stepAcc = 0; Events.emit('noise', { ch: this, x: this.pos.x, y: this.pos.y, z: this.pos.z, r: 17, step: true }); }
    }
    // 安放炸弹（T）
    const wantPlant = this.useOn && this.team === 'T' && this.inv.bomb && Bomb.siteAt(this.pos.x, this.pos.z) && Round.canPlant();
    if (wantPlant) {
      if (!this.planting) { this.planting = true; Bomb.startPlant(this); }
      if (Bomb.updatePlant(this, dt)) { this.planting = false; this.invDirty = true; }
    } else if (this.planting) { this.planting = false; Bomb.cancelPlant(this); }
    // 拆除炸弹（CT）
    const wantDefuse = this.useOn && this.team === 'CT' && Bomb.state === 'planted' && Round.state === 'live' && this.pos.distanceTo(Bomb.pos) < 1.7;
    if (wantDefuse) { if (Bomb.defuser !== this) Bomb.startDefuse(this); Bomb.updateDefuse(this, dt); }
    else if (Bomb.defuser === this) Bomb.cancelDefuse(this);
    // 自动拾取：炸弹（T），以及空槽位的武器
    const it = Items.nearest(this, 1.2);
    if (it) {
      if (it.kind === 'bomb') { if (this.team === 'T') pickupFor(this, it); }
      else if (!this.inv[it.w.def.slot] && Clock.time - it.t > 0.4) pickupFor(this, it);
    }
  }
}

function pickupFor(h, it) {
  if (!h.alive) return;
  if (it.kind === 'bomb') {
    if (h.team !== 'T') return;
    h.inv.bomb = true;
    Items.remove(it);
    Events.emit('bombPicked', h);
  } else {
    const slot = it.w.def.slot;
    const old = h.inv[slot];
    if (old) { const d = Items.drop('weapon', old, h.pos.x, h.pos.y + 1, h.pos.z, rand(-0.5, 0.5), rand(-0.5, 0.5)); d.dropper = h; }
    h.inv[slot] = it.w;
    Items.remove(it);
    h.invSwitch = slot;
  }
  h.invDirty = true;
}

// =====================================================================
//  加入 / 离开 / 队伍
// =====================================================================
function humansOf(team) { let n = 0; for (const h of humans.values()) if ((h.pendingTeam || h.team) === team) n++; return n; }
function chooseTeam(want) {
  const t = humansOf('T'), ct = humansOf('CT');
  if ((want === 'T' || want === 'CT') && humansOf(want) < 5) return want;
  return t <= ct ? 'T' : 'CT';
}

function join(cid, name, want) {
  const team = chooseTeam(want);
  const h = new NetHuman(cid, name, team);
  // 中途加入：按队友平均资金发钱，保证能立即参与
  const mates = Combat.chars.filter(c => c.team === team);
  h.money = Round.number > 1 && mates.length ? Math.round(mates.reduce((s, c) => s + c.money, 0) / mates.length) : CFG.ECON.START;
  humans.set(cid, h);
  Combat.chars.push(h);
  post(cid, { t: 'you', id: h.id, team, code: ROOM.code, name: ROOM.name, opts: ROOM.opts });
  if (Round.state === 'menu' || Round.state === 'over') {
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    Round.startMatch();              // 第一个人进入：开始比赛（startRound 内会补齐 Bot）
  } else if (Round.state === 'freeze') {
    balanceBots();
    spawnNow(h);
  }
  sendRoster();
  sendFullState(h);
  systemChat(`${name} 加入了${team === 'T' ? '恐怖分子' : '反恐精英'}`);
}

function leave(cid) {
  const h = humans.get(cid);
  if (!h) return;
  humans.delete(cid);
  if (h.alive) { Items.dropOnDeath(h); h.alive = false; }
  if (Bomb.planting === h) Bomb.cancelPlant(h);
  if (Bomb.defuser === h) Bomb.cancelDefuse(h);
  const i = Combat.chars.indexOf(h);
  if (i >= 0) Combat.chars.splice(i, 1);
  sendRoster();
  systemChat(`${h.name} 离开了房间`);
  if (Round.state === 'live') Round.checkWin();
  if (!humans.size) parentPort.postMessage({ type: 'empty' });
}

/** 冻结时间内加入的玩家立即出生（顶替一个本队 Bot 的位置） */
function spawnNow(h) {
  h.resetForRound(false);
  const sps = MAP.SPAWNS[h.team];
  let best = sps[0], bd = -1;
  for (const sp of sps) {
    const x = MAP.wx(sp[0]), z = MAP.wz(sp[1]);
    let md = 99;
    for (const c of Combat.chars) if (c !== h && c.alive) md = Math.min(md, Math.hypot(c.pos.x - x, c.pos.z - z));
    if (md > bd) { bd = md; best = sp; }
  }
  const x = MAP.wx(best[0]), z = MAP.wz(best[1]);
  h.pos.set(x, Nav.floorAt(x, z), z);
  h.spawnPos.copy(h.pos);
  h.yaw = h.team === 'T' ? 0 : Math.PI;
  sendSpawn(h);
}

/** 每回合开始前：处理换队请求，并用 Bot 补齐两队人数 */
function balanceBots() {
  for (const h of humans.values()) {
    if (h.pendingTeam && h.pendingTeam !== h.team) {
      h.team = h.pendingTeam;
      h.inv.primary = null; h.survived = false; h.armor = 0; h.helmet = false; h.kit = false;
      ev(h.cid, 'team', { team: h.team });
    }
    h.pendingTeam = null;
  }
  const nT = humansOf('T'), nCT = humansOf('CT');
  for (const team of ['T', 'CT']) {
    const hs = team === 'T' ? nT : nCT;
    const target = ROOM.opts.bots ? Math.max(0, 5 - hs) : Math.max(0, Math.max(nT, nCT, 1) - hs);
    const bots = Game.bots.filter(b => b.team === team);
    while (bots.length > target) removeBot(bots.pop());
    while (bots.length < target) bots.push(addBot(team));
  }
  sendRoster();
}
function addBot(team) {
  const used = new Set(Combat.chars.map(c => c.name));
  const name = BOT_NAMES[team].find(n => !used.has(n)) || `${team}-${Game.bots.length + 1}`;
  const b = new Bot(team, name, SETTINGS.difficulty);
  const mates = Combat.chars.filter(c => c.team === team);
  if (Round.number > 1 && mates.length) b.money = Math.round(mates.reduce((s, c) => s + c.money, 0) / mates.length);
  Game.bots.push(b);
  Combat.chars.push(b);
  return b;
}
function removeBot(b) {
  const i = Game.bots.indexOf(b);
  if (i >= 0) Game.bots.splice(i, 1);
  const j = Combat.chars.indexOf(b);
  if (j >= 0) Combat.chars.splice(j, 1);
  if (b.inv.bomb) {
    b.inv.bomb = false;
    const h = [...humans.values()].find(x => x.team === 'T' && x.alive);
    if (h) { h.inv.bomb = true; h.invDirty = true; }
  }
}
Round.beforeRound = balanceBots;

// =====================================================================
//  客户端消息
// =====================================================================
function onClientMsg(cid, m) {
  const h = humans.get(cid);
  if (!h || !m) return;
  switch (m.t) {
    case 'st': h.applyState(m); break;
    case 'shot': relayShot(h, m); break;
    case 'hit': onHit(h, m); break;
    case 'knife':
      if (h.alive) { ev('*', 'knife', { c: h.id, h: m.h ? 1 : 0 }, cid); Events.emit('noise', { ch: h, x: h.pos.x, y: h.pos.y, z: h.pos.z, r: 8 }); }
      break;
    case 'nade':
      if (Array.isArray(m.p) && Array.isArray(m.v) && Grenades.serverThrow(h, m.ty, m.p.map(Number), m.v.map(Number), m.cid | 0)) h.invDirty = true;
      else h.invDirty = true;   // 失败时也同步一次，纠正客户端的预测
      break;
    case 'buy': onBuy(h, String(m.id)); break;
    case 'drop': onDrop(h, m); break;
    case 'pickup': {
      const it = Items.byId(m.id | 0);
      if (it && h.alive && Math.hypot(it.pos.x - h.pos.x, it.pos.z - h.pos.z) < 2.3) pickupFor(h, it);
      break;
    }
    case 'use': h.useOn = !!m.on; break;
    case 'team':
      if ((m.team === 'T' || m.team === 'CT') && m.team !== h.team) {
        if (humansOf(m.team) >= 5) { ev(cid, 'teamq', { team: m.team, full: 1 }); break; }
        h.pendingTeam = m.team;
        ev(cid, 'teamq', { team: m.team });
      }
      break;
    case 'chat': {
      const text = String(m.text || '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 120);
      if (!text) break;
      const payload = { c: h.id, n: h.name, text, team: m.team ? 1 : 0, tm: h.team };
      if (m.team) ev(h.team, 'chat', payload); else ev('*', 'chat', payload);
      break;
    }
    case 'ping': post(cid, { t: 'pong', c: m.c }); break;
    case 'rtt': h.ping = clamp(m.v | 0, 0, 999); break;
    case 'dbg_tp':   // 仅用于自动化测试（SZ_DEBUG=1 启动时有效）
      if (process.env.SZ_DEBUG === '1' && Array.isArray(m.p)) { h.pos.set(+m.p[0], +m.p[1], +m.p[2]); h.lastSt = worldTime; if (m.yaw !== undefined) h.yaw = +m.yaw; }
      break;
    case 'dbg_give':
      if (process.env.SZ_DEBUG === '1' && WEAPONS[m.id] && h.alive) { const w = WEAPONS[m.id]; h.inv[w.slot] = newWeapon(m.id); h.invSwitch = w.slot; h.invDirty = true; }
      break;
    case 'dbg_score':
      if (process.env.SZ_DEBUG === '1') { Round.score.T = m.T | 0; Round.score.CT = m.CT | 0; if (m.timer) Round.timer = +m.timer; }
      break;
  }
}

/** 转发玩家的开枪表现（弹道/弹孔），并让 Bot 听到枪声 */
function relayShot(h, m) {
  if (!h.alive || h.shotTokens < 1) return;
  const def = WEAPONS[m.w];
  if (!def || !Array.isArray(m.o) || !Array.isArray(m.x)) return;
  h.shotTokens -= 1;
  const num = (a, n) => Array.isArray(a) && a.length >= n && a.slice(0, n).every(v => Number.isFinite(+v));
  const im = Array.isArray(m.im) ? m.im.filter(a => num(a, 6)).slice(0, 6).map(a => [+a[0], +a[1], +a[2], +a[3], +a[4], +a[5], String(a[6]).slice(0, 8), a[7] ? 1 : 0]) : [];
  const bl = num(m.bl, 7) ? m.bl.slice(0, 7).map(Number) : 0;
  if (!num(m.o, 3) || !num(m.x, 3)) return;
  ev('*', 'shot', { c: h.id, w: def.id, o: m.o.slice(0, 3).map(Number), x: m.x.slice(0, 3).map(Number), im, bl }, h.cid);
  Events.emit('shot', { ch: h, def });
}

/** 命中校验：武器归属、射速、距离与视线，然后按服务器数值结算伤害 */
function onHit(h, m) {
  const v = Combat.chars.find(c => c.id === (m.v | 0));
  if (!v || !v.alive || !h.alive || v.team === h.team) return;
  const w = String(m.w);
  const def = WEAPONS[w];
  if (!def) return;
  const owned = w === 'knife' || (h.inv.primary && h.inv.primary.def.id === w) || (h.inv.secondary && h.inv.secondary.def.id === w);
  if (!owned) return;
  // 令牌桶：容量 3，按武器射速回复
  const tk = h.tokens[w] || (h.tokens[w] = { n: 3, t: worldTime });
  tk.n = Math.min(3, tk.n + (worldTime - tk.t) / Math.max(0.08, (w === 'knife' ? 0.4 : def.rate) * 0.8));
  tk.t = worldTime;
  if (tk.n < 1) return;
  tk.n -= 1;
  // 距离与视线（考虑网络延迟：检查受害者最近 0.4 秒内的位置）
  h.eye(_s1);
  const dist = _s1.distanceTo(v.pos);
  if (dist > (w === 'knife' ? 3.2 : 220)) return;
  if (!m.pen && !recentlyVisible(_s1, v)) return;
  let dmg;
  if (w === 'knife') dmg = m.kn ? (m.bk ? 180 : 65) : (m.bk ? 90 : 40);
  else {
    const g = HIT_MULT[m.g] ? m.g : 'chest';
    dmg = def.damage * HIT_MULT[g] * clamp(+m.m || 0, 0, 1);
    m.g = g;
  }
  const dx = v.pos.x - h.pos.x, dz = v.pos.z - h.pos.z, l = Math.hypot(dx, dz) || 1;
  Combat.damage(v, dmg, h, w, w === 'knife' ? 'chest' : m.g, dx / l, dz / l, !!m.pen, w === 'knife');
}
function recentlyVisible(eye, v) {
  const H = v.hist || [];
  for (let i = H.length - 4; i >= 0; i -= 4) {
    if (worldTime - H[i] > 0.45) break;
    const x = H[i + 1], y = H[i + 2], z = H[i + 3];
    for (const oy of [1.25, 1.6, 0.6]) if (World.segClear(eye.x, eye.y, eye.z, x, y + oy, z)) return true;
  }
  v.chestPos(_s2);
  return World.segClear(eye.x, eye.y, eye.z, _s2.x, _s2.y, _s2.z);
}

function onBuy(h, id) {
  if (!Economy.canBuyNow(h)) { ev(h.cid, 'buyres', { ok: 0, id, reason: '当前不能购买（需在出生区域且在购买时间内）' }); return; }
  const r = Economy.buy(h, id);
  ev(h.cid, 'buyres', { ok: r.ok ? 1 : 0, id, name: r.name, reason: r.reason || '' });
  if (r.ok) { h.invDirty = true; if (WEAPONS[id]) h.invSwitch = WEAPONS[id].slot; }
}

function onDrop(h, m) {
  if (!h.alive) return;
  h.eye(_s1);
  dirFromAngles(h.yaw, h.pitch, _s2);
  let it = null;
  if (m.sl === 'bomb') {
    if (!h.inv.bomb) return;
    h.inv.bomb = false;
    it = Items.drop('bomb', null, _s1.x, _s1.y - 0.4, _s1.z, _s2.x * 3.5, _s2.z * 3.5, 2);
  } else if (m.sl === 'primary' || m.sl === 'secondary') {
    const w = h.inv[m.sl];
    if (!w) return;
    w.mag = clamp(m.mag | 0, 0, w.def.mag); w.reserve = clamp(m.res | 0, 0, w.def.reserve);
    h.inv[m.sl] = null;
    it = Items.drop('weapon', w, _s1.x, _s1.y - 0.4, _s1.z, _s2.x * 4, _s2.z * 4, 2);
  }
  if (it) it.dropper = h;
  h.invDirty = true;
}

// =====================================================================
//  发送给客户端的数据
// =====================================================================
function invMsg(h, refill = false) {
  const w = (x) => x ? [x.def.id, x.mag, x.reserve] : 0;
  const m = {
    t: 'inv', money: h.money, ar: h.armor, hel: h.helmet ? 1 : 0, kit: h.kit ? 1 : 0, hp: h.health,
    p: w(h.inv.primary), s: w(h.inv.secondary), he: h.inv.he, fl: h.inv.flash, sm: h.inv.smoke, bomb: h.inv.bomb ? 1 : 0,
    rf: refill ? 1 : 0, sw: h.invSwitch || '',
  };
  h.invSwitch = '';
  return m;
}
function sendSpawn(h) {
  if (!h.alive) return;
  h.spawnPos.copy(h.pos);
  h.lastSt = -1;
  post(h.cid, { t: 'spawn', p: [q2(h.pos.x), q2(h.pos.y), q2(h.pos.z)], yaw: q3(h.yaw), hp: h.health, inv: invMsg(h, true) });
  h.invDirty = false;
}
function sendRoster() {
  post('*', { t: 'roster', l: Combat.chars.map(c => [c.id, c.name, c.team === 'T' ? 0 : 1, c.isBot ? 1 : 0]) });
}
function sendBoard() {
  for (const team of ['T', 'CT']) {
    post(team, {
      t: 'board', l: Combat.chars.map(c => [c.id, c.stats.k, c.stats.d, c.stats.a, c.stats.hs, c.stats.dmg, c.stats.mvp,
        c.team === team ? c.money : -1, c.isHuman ? c.ping : -1, c.alive ? 1 : 0]),
    });
  }
}
/** 刚加入的玩家：同步当前的掉落物、炸弹与烟雾 */
function sendFullState(h) {
  for (const it of Items.list) post(h.cid, itemAddMsg(it));
  for (const s of FX.smokes) ev(h.cid, 'smokeState', { p: [q2(s.x), q2(s.y), q2(s.z)], age: q2(s.t) });
  if (Bomb.state === 'planted') ev(h.cid, 'planted', { c: Bomb.planter ? Bomb.planter.id : 0, site: Bomb.site, p: [q2(Bomb.pos.x), q2(Bomb.pos.y), q2(Bomb.pos.z)], silent: 1 });
  post(h.cid, invMsg(h, true));
  h.invDirty = false;
  sendBoard();
}
function itemAddMsg(it) {
  return { t: 'ev', e: 'itemAdd', id: it.id, k: it.kind === 'bomb' ? 1 : 0, w: it.w ? it.w.def.id : '', mag: it.w ? it.w.mag : 0, res: it.w ? it.w.reserve : 0,
    p: [q2(it.pos.x), q2(it.pos.y), q2(it.pos.z)], v: [q2(it.vel.x), q2(it.vel.y), q2(it.vel.z)] };
}
function systemChat(text) { ev('*', 'chat', { c: 0, n: '系统', text, team: 0, sys: 1 }); }

/** 被某队发现的敌人（Bot 用自己的感知记忆，真人用视线检测）——用于雷达 */
let spotCache = { T: new Set(), CT: new Set() }, spotT = 0;
function computeSpotted(team) {
  const set = new Set();
  for (const e of Combat.chars) {
    if (e.team === team || !e.alive) continue;
    for (const m of Combat.chars) {
      if (m.team !== team || !m.alive) continue;
      if (m.isBot) {
        const k = m.known.get(e);
        if (k && k.spotted && k.seenNow) { set.add(e.id); break; }
      } else {
        m.eye(_s1); e.chestPos(_s2);
        const ang = Math.abs(wrapAngle(yawOf(_s2.x - _s1.x, _s2.z - _s1.z) - m.yaw));
        if (ang < 60 * DEG && World.segClear(_s1.x, _s1.y, _s1.z, _s2.x, _s2.y, _s2.z) && !FX.smokeBlocks(_s1.x, _s1.y, _s1.z, _s2.x, _s2.y, _s2.z)) { set.add(e.id); break; }
      }
    }
  }
  return set;
}

function snapshot() {
  if (++spotT >= 3) { spotT = 0; spotCache = { T: computeSpotted('T'), CT: computeSpotted('CT') }; }
  const r = [RSTATE[Round.state] || 0, q2(Round.displayTime()), Round.score.T, Round.score.CT, Round.number, q2(Round.buyTimeLeft()), SETTINGS.winRounds];
  const B = Bomb;
  const b = [BSTATE[B.state] || 0, q2(B.pos.x), q2(B.pos.y), q2(B.pos.z), q2(B.timer), B.site === 'A' ? 0 : B.site === 'B' ? 1 : -1,
    B.planting ? B.planting.id : 0, q2(B.plantT), B.defuser ? B.defuser.id : 0, q2(B.defuseT), B.defuseDur];
  const c = Combat.chars.map(ch => {
    const f = (ch.alive ? 1 : 0) | (ch.onGround ? 2 : 0) | (ch.walking ? 4 : 0) | (ch.crouching ? 8 : 0) |
      (spotCache.T.has(ch.id) ? 16 : 0) | (spotCache.CT.has(ch.id) ? 32 : 0) | (ch.isBot ? 256 : 0) | (ch.inv.bomb ? 512 : 0) |
      (ch.reloading || ch.netReload ? 1024 : 0) | (ch.nadeCharging || ch.netCharge ? 2048 : 0);
    // 主 / 副武器（+1，0 表示没有）：其他客户端据此显示背上的枪与腿部枪套
    const pw = ch.inv.primary, sw = ch.inv.secondary;
    return [ch.id, ch.team === 'T' ? 0 : 1, q2(ch.pos.x), q2(ch.pos.y), q2(ch.pos.z), q3(ch.yaw), q3(ch.pitch), (ch.crouch * 100) | 0, f, Math.max(0, ch.health), HELD_IDS.indexOf(ch.heldId()),
      pw ? HELD_IDS.indexOf(pw.def.model || pw.def.id) + 1 : 0, sw ? HELD_IDS.indexOf(sw.def.model || sw.def.id) + 1 : 0];
  });
  post('*', { t: 'snap', tm: q3(worldTime), r, b, c });
  for (const h of humans.values()) if (h.invDirty) { post(h.cid, invMsg(h)); h.invDirty = false; }
}

// =====================================================================
//  游戏事件 → 网络广播
// =====================================================================
Events.on('roundStart', (e) => {
  ev('*', 'roundStart', { n: e.number });
  for (const h of humans.values()) sendSpawn(h);
  sendRoster();
});
Events.on('roundLive', () => ev('*', 'roundLive', {}));
Events.on('roundEnd', (e) => ev('*', 'roundEnd', { w: e.winner, r: e.reason, mvp: e.mvp ? e.mvp.id : 0, mk: e.mvp ? e.mvp.stats.rk : 0 }));
Events.on('matchOver', (e) => {
  ev('*', 'matchOver', { w: e.winner, s: [Round.score.T, Round.score.CT] });
  sendBoard();
  restartTimer = setTimeout(() => { restartTimer = null; if (humans.size) Round.startMatch(); }, 15000);
});
Events.on('kill', (e) => ev('*', 'kill', { k: e.killer ? e.killer.id : 0, v: e.victim.id, w: e.weaponId, hs: e.headshot ? 1 : 0, pen: e.penetrated ? 1 : 0, dx: q2(e.dirx || 0), dz: q2(e.dirz || 0) }));
Events.on('damage', (e) => {
  const v = e.victim, a = e.attacker;
  if (v.isHuman) ev(v.cid, 'dmg', { a: a ? a.id : 0, d: e.dmg, g: e.group, w: e.weaponId, hp: Math.max(0, v.health), ar: v.armor });
  if (a && a.isHuman && a !== v) ev(a.cid, 'hit', { v: v.id, g: e.group, h: e.helmet ? 1 : 0, d: e.dmg });
});
Events.on('flashed', (e) => { if (e.ch.isHuman) ev(e.ch.cid, 'flashed', { d: q2(e.dur), a: q2(e.amt) }); });
Events.on('bullet', (e) => {
  if (e.shooter.isHuman) return;   // 真人的弹道由客户端上报并转发
  const r = e.res;
  ev('*', 'shot', { c: e.shooter.id, w: e.def.id, o: [q2(e.ox), q2(e.oy), q2(e.oz)], x: [q2(r.ex), q2(r.ey), q2(r.ez)],
    im: r.imp.map(m => [q2(m[0]), q2(m[1]), q2(m[2]), q3(m[3]), q3(m[4]), q3(m[5]), m[6], m[7]]), bl: r.bl ? r.bl.map(q3) : 0 });
});
Events.on('knife', (e) => { if (!e.ch.isHuman) ev('*', 'knife', { c: e.ch.id, h: e.heavy ? 1 : 0 }); });
Events.on('nadeThrown', (g) => {
  ev('*', 'nade', { id: g.id, c: g.owner.id, ty: g.type, p: [q3(g.p.x), q3(g.p.y), q3(g.p.z)], v: [q3(g.v.x), q3(g.v.y), q3(g.v.z)], cid: g.cid || 0 });
  if (g.owner.isHuman) g.owner.invDirty = true;
});
Events.on('nadeBoom', (g) => ev('*', 'boom', { id: g.id, ty: g.type, p: [q2(g.p.x), q2(g.p.y), q2(g.p.z)] }));
Events.on('plantStart', (ch) => ev('*', 'plantStart', { c: ch.id }));
Events.on('bombPlanted', (e) => {
  ev('*', 'planted', { c: e.ch.id, site: e.site, p: [q2(Bomb.pos.x), q2(Bomb.pos.y), q2(Bomb.pos.z)], yaw: q3(e.ch.yaw) });
  if (e.ch.isHuman) e.ch.invDirty = true;
});
Events.on('defuseStart', (ch) => ev('*', 'defuseStart', { c: ch.id, kit: ch.kit ? 1 : 0 }));
Events.on('bombDefused', (e) => ev('*', 'defused', { c: e.ch ? e.ch.id : 0 }));
Events.on('bombExploded', () => ev('*', 'exploded', { p: [q2(Bomb.pos.x), q2(Bomb.pos.y), q2(Bomb.pos.z)] }));
Events.on('bombPicked', (ch) => { if (ch.isHuman) ch.invDirty = true; });
Events.on('itemAdd', (it) => post('*', itemAddMsg(it)));
Events.on('itemDel', (it) => ev('*', 'itemDel', { id: it.id }));
Events.on('radio', (e) => { if (e.from) ev(e.from.team, 'radio', { c: e.from.id, text: e.text }); });
// 金钱变化时同步背包
const _give = Economy.give.bind(Economy);
Economy.give = (ch, amt) => { _give(ch, amt); if (ch.isHuman) ch.invDirty = true; };

// =====================================================================
//  主循环：60Hz 模拟，30Hz 快照
// =====================================================================
function separateBots() {
  const cs = Combat.chars;
  for (let i = 0; i < cs.length; i++) {
    const a = cs[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < cs.length; j++) {
      const b = cs[j];
      if (!b.alive || Math.abs(a.pos.y - b.pos.y) > 1.5) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
      const d2 = dx * dx + dz * dz, min = 0.72;
      if (d2 >= min * min || d2 < 1e-6) continue;
      const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
      // 真人的位置以客户端为准，只推开 Bot
      const pa = a.isBot ? (b.isBot ? 0.5 : 1) : 0, pb = b.isBot ? (a.isBot ? 0.5 : 1) : 0;
      const push = min - d;
      if (pa && Physics.free(a.pos.x - nx * push * pa, a.pos.y, a.pos.z - nz * push * pa, a.hw, a.height)) { a.pos.x -= nx * push * pa; a.pos.z -= nz * push * pa; }
      if (pb && Physics.free(b.pos.x + nx * push * pb, b.pos.y, b.pos.z + nz * push * pb, b.hw, b.height)) { b.pos.x += nx * push * pb; b.pos.z += nz * push * pb; }
    }
  }
}
function recordHistory() {
  for (const c of Combat.chars) {
    const H = c.hist || (c.hist = []);
    H.push(worldTime, c.pos.x, c.pos.y, c.pos.z);
    if (H.length > 4 * 30) H.splice(0, 4);
  }
}
function stepWorld(dt) {
  worldTime += dt;
  Clock.time += dt; Clock.dt = dt; Clock.frame++;
  for (const h of humans.values()) h.shotTokens = Math.min(12, h.shotTokens + dt * 18);
  if (Round.state === 'menu') return;
  Round.update(dt);
  TeamAI.update();
  for (const h of humans.values()) h.update(dt);
  for (const b of Game.bots) b.update(dt);
  separateBots();
  Grenades.update(dt);
  Bomb.update(dt);
  Items.update(dt);
  FX.update(dt);
  recordHistory();
}

const STEP = 1 / 60;
let last = performance.now(), acc = 0, snapAcc = 0, boardAcc = 0, infoAcc = 0;
setInterval(() => {
  const now = performance.now();
  let d = (now - last) / 1000;
  last = now;
  if (d > 0.25) d = 0.25;
  acc += d;
  try {
    while (acc >= STEP) { acc -= STEP; stepWorld(STEP); }
    snapAcc += d;
    if (snapAcc >= 1 / CFG.NETCFG.SNAP_RATE) {
      snapAcc = Math.min(snapAcc - 1 / CFG.NETCFG.SNAP_RATE, 0.05);
      if (humans.size) snapshot();
    }
    boardAcc += d;
    if (boardAcc >= 1) { boardAcc = 0; if (humans.size) sendBoard(); }
    infoAcc += d;
    if (infoAcc >= 2) {
      infoAcc = 0;
      parentPort.postMessage({ type: 'info', info: { humans: humans.size, T: humansOf('T'), CT: humansOf('CT'), round: Round.number, score: [Round.score.T, Round.score.CT], state: Round.state } });
    }
  } catch (err) {
    console.error(`[room ${ROOM.code}]`, err && err.stack || err);
  }
}, 1000 / 60);

parentPort.on('message', (m) => {
  try {
    if (m.type === 'join') join(m.cid, m.name, m.team);
    else if (m.type === 'leave') leave(m.cid);
    else if (m.type === 'msg') onClientMsg(m.cid, m.msg);
  } catch (err) {
    console.error(`[room ${ROOM.code}] message error`, err && err.stack || err);
  }
});
