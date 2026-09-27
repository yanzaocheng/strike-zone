// =====================================================================
//  19 联机客户端
//  - 大厅：连接服务器、房间列表、创建 / 加入房间（支持 ?room=房间号 邀请链接）
//  - 本机玩家：移动、视角、开火都在本地计算（零输入延迟），30Hz 上报服务器
//  - 其他玩家与 Bot：服务器 30Hz 快照，延迟 100ms 插值渲染
//  - 服务器事件（开火、命中、击杀、投掷物、炸弹、回合…）在本地回放为同名游戏事件，
//    因此单机模式的特效 / 音效 / HUD 代码可以直接复用
// =====================================================================

const NET_HELD = ['knife', 'g18', 'p2k', 'd50', 'v45', 'g35', 'k47', 'm4', 's08', 'l96', 'he', 'flash', 'smoke', 'c4'];
const NET_RSTATE = ['menu', 'freeze', 'live', 'end', 'over'];
const NET_BSTATE = ['carried', 'planted', 'defused', 'exploded'];
const nr2 = (v) => Math.round(v * 100) / 100;
const nr3 = (v) => Math.round(v * 1000) / 1000;

/** 其他玩家（真人或 Bot）在本地的副本：只负责显示，状态来自服务器快照 */
class RemoteChar extends Character {
  constructor(id, team, name, isBot) {
    super(team, name);
    this.id = id;
    this.remote = true;
    this.isBot = !!isBot;
    this.buf = [];
    this.netHeld = 'knife';
    this.flags = 0;
    this.ping = -1;
    this.alive = false;
    this.prevPos = new THREE.Vector3();
    this.netReload = false; this.netCharge = false; this.netPrim = ''; this.netSec = '';
    this.buildModel();
  }
  buildModel() {
    if (this.model) CharModel.dispose(this.model);
    this.model = CharModel.create(this.team, this.name, this.team === Game.player.team);
    this.model.root.visible = this.alive;
    Game.scene.add(this.model.root);
  }
  heldId() { return this.netHeld; }
  gearState() {
    const g = this._gear || (this._gear = { p: '', s: '', bomb: false });
    g.p = this.netPrim; g.s = this.netSec; g.bomb = !!this.inv.bomb;
    return g;
  }
  /** 收到一条快照：e = [id, 阵营, x, y, z, yaw, pitch, 下蹲%, 标志位, 血量, 手持武器, 主武器+1, 副武器+1] */
  push(tm, e) {
    const s = { t: tm, x: e[2], y: e[3], z: e[4], yaw: e[5], pitch: e[6], cr: e[7] / 100 };
    const last = this.buf[this.buf.length - 1];
    if (last && tm <= last.t) return;
    if (last && Math.hypot(s.x - last.x, s.z - last.z) > 4) this.buf.length = 0;   // 出生/传送：不做插值
    this.buf.push(s);
    if (this.buf.length > 40) this.buf.shift();
    const f = e[8];
    const alive = !!(f & 1);
    if (alive && !this.alive) this.revive(s);
    this.alive = alive;
    this.flags = f;
    this.onGround = !!(f & 2); this.walking = !!(f & 4); this.crouching = !!(f & 8);
    this.inv.bomb = !!(f & 512);
    this.netReload = !!(f & 1024); this.netCharge = !!(f & 2048);
    this.health = e[9];
    this.netHeld = NET_HELD[e[10]] || 'knife';
    this.netPrim = e[11] ? NET_HELD[e[11] - 1] || '' : '';
    this.netSec = e[12] ? NET_HELD[e[12] - 1] || '' : '';
  }
  revive(s) {
    this.buf = [s];
    this.pos.set(s.x, s.y, s.z);
    this.vel.set(0, 0, 0);
    this.model.reset();
  }
  spottedBy(team) { return !!(this.flags & (team === 'T' ? 16 : 32)); }
  /** 在渲染时刻 rt 插值出位置与朝向 */
  sample(rt, dt) {
    const B = this.buf;
    if (!B.length) return;
    let a = B[0], b = B[B.length - 1];
    if (rt <= a.t) b = a;
    else if (rt >= b.t) a = b;
    else for (let i = B.length - 1; i > 0; i--) if (B[i - 1].t <= rt) { a = B[i - 1]; b = B[i]; break; }
    const k = b.t > a.t ? clamp((rt - a.t) / (b.t - a.t), 0, 1) : 0;
    this.prevPos.copy(this.pos);
    this.pos.set(lerp(a.x, b.x, k), lerp(a.y, b.y, k), lerp(a.z, b.z, k));
    this.yaw = a.yaw + wrapAngle(b.yaw - a.yaw) * k;
    this.pitch = lerp(a.pitch, b.pitch, k);
    this.crouch = lerp(a.cr, b.cr, k);
    if (dt > 0) {
      const vx = clamp((this.pos.x - this.prevPos.x) / dt, -8, 8), vz = clamp((this.pos.z - this.prevPos.z) / dt, -8, 8);
      this.vel.x = damp(this.vel.x, vx, 12, dt); this.vel.z = damp(this.vel.z, vz, 12, dt);
    }
  }
  /** 每帧：脚步声、手持武器模型、动画 */
  tick(dt) {
    if (this.alive) {
      const hs = Math.hypot(this.vel.x, this.vel.z);
      if (this.onGround && hs > 3.2 && !this.walking && !this.crouching) {
        this.stepAcc += hs * dt;
        if (this.stepAcc > 1.9) {
          this.stepAcc = 0;
          const L = SFX.listenerPos;
          if (L.distanceTo(this.pos) < 30) {
            const occ = !World.segClear(L.x, L.y, L.z, this.pos.x, this.pos.y + 0.4, this.pos.z);
            SFX.footstep(this.pos, MAP.surfaceAt(this.pos.x, this.pos.z), 1, occ);
          }
        }
      }
      CharModel.setGun(this.model, this.netHeld);
    }
    this.updateModel(dt);
  }
  dispose() { if (this.model) CharModel.dispose(this.model); this.model = null; }
}

const NetClient = {
  ws: null,
  status: 'idle',        // idle | connecting | open | closed
  cid: 0,
  rooms: [],
  inRoom: false, code: '', roomName: '', opts: null, myId: 0, winRounds: 8,
  chars: new Map(),      // 角色 id → RemoteChar（本机玩家也在其中）
  renderT: 0, latestTm: 0, latestRecv: 0, haveSnap: false,
  sendAcc: 0, pingT: 0, rtt: 0,
  pendingNades: { he: [], flash: [], smoke: [] },
  invReady: false,
  onLobby: null,         // 大厅界面回调：(type, data)

  serverUrl() {
    const m = location.search.match(/[?&]server=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : CFG.NETCFG.URL;
  },
  lobby(type, data) { if (this.onLobby) this.onLobby(type, data); },
  connect() {
    if (this.ws && (this.status === 'open' || this.status === 'connecting')) return;
    this.status = 'connecting';
    this.lobby('status');
    let ws;
    try { ws = new WebSocket(this.serverUrl()); } catch (e) { this.status = 'closed'; this.lobby('status'); return; }
    this.ws = ws;
    ws.onopen = () => { this.status = 'open'; this.send({ t: 'hello', name: SETTINGS.mpName }); this.lobby('status'); };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch (err) { return; }
      try { this.onMessage(m); } catch (err) { console.error('[net]', err); }
    };
    ws.onclose = () => {
      const was = this.inRoom;
      this.status = 'closed';
      this.ws = null;
      this.lobby('status');
      if (was) this.onDisconnect('与服务器的连接已断开');
    };
    ws.onerror = () => {};
  },
  send(m) { if (this.ws && this.status === 'open') this.ws.send(JSON.stringify(m)); },

  // ---------------- 大厅 ----------------
  hello() { this.send({ t: 'hello', name: SETTINGS.mpName }); },
  listRooms() { this.send({ t: 'list' }); },
  createRoom(opts, team) { this.send({ t: 'create', name: SETTINGS.mpName, opts, team }); },
  joinRoom(code, team) { this.send({ t: 'join', name: SETTINGS.mpName, code, team }); },

  onMessage(m) {
    switch (m.t) {
      case 'welcome': this.cid = m.cid; this.rooms = m.rooms || []; this.lobby('rooms'); break;
      case 'rooms': this.rooms = m.rooms || []; this.lobby('rooms'); break;
      case 'error': this.lobby('error', m.msg); break;
      case 'joined': this.code = m.code; this.roomName = m.name; this.opts = m.opts; break;
      case 'you': this.enter(m); break;
      case 'kicked': this.onDisconnect(m.msg || '你已离开房间'); break;
      case 'roster': if (this.inRoom) this.applyRoster(m.l); break;
      case 'snap': if (this.inRoom) this.applySnap(m); break;
      case 'inv': if (this.inRoom) this.applyInv(m, false); break;
      case 'spawn': if (this.inRoom) this.applySpawn(m); break;
      case 'tp': if (this.inRoom) { Game.player.pos.set(m.p[0], m.p[1], m.p[2]); Game.player.vel.set(0, 0, 0); } break;
      case 'board': if (this.inRoom) this.applyBoard(m.l); break;
      case 'pong': this.rtt = Math.round((performance.now() / 1000 - m.c) * 1000); this.send({ t: 'rtt', v: this.rtt }); break;
      case 'ev': if (this.inRoom) this.onEvent(m); break;
    }
  },

  // ---------------- 进入 / 离开房间 ----------------
  enter(m) {
    this.inRoom = true;
    this.myId = m.id;
    this.code = m.code; this.roomName = m.name; this.opts = m.opts;
    this.winRounds = m.opts ? m.opts.winRounds : 8;
    this.haveSnap = false; this.invReady = false;
    this.pendingNades = { he: [], flash: [], smoke: [] };
    this.chars.clear();
    Game.startMultiplayer(m);
    this.chars.set(m.id, Game.player);
  },
  leaveRoom() {
    if (this.inRoom) this.send({ t: 'leave' });
    this.cleanup();
  },
  cleanup() {
    this.inRoom = false;
    for (const c of this.chars.values()) if (c.remote) c.dispose();
    this.chars.clear();
  },
  onDisconnect(msg) {
    if (!this.inRoom) return;
    this.cleanup();
    Game.leaveMultiplayer(msg);
  },

  // ---------------- 状态同步 ----------------
  applyRoster(list) {
    const P = Game.player;
    const seen = new Set();
    for (const [id, name, team, bot] of list) {
      seen.add(id);
      const t = team ? 'CT' : 'T';
      if (id === this.myId) {
        if (P.team !== t) { P.team = t; this.refreshModels(); }
        continue;
      }
      let c = this.chars.get(id);
      if (!c) { c = new RemoteChar(id, t, name, bot); this.chars.set(id, c); Combat.chars.push(c); }
      else if (c.team !== t || c.name !== name) { c.team = t; c.name = name; c.buildModel(); }
    }
    for (const [id, c] of this.chars) {
      if (!c.remote || seen.has(id)) continue;
      c.dispose();
      this.chars.delete(id);
      const i = Combat.chars.indexOf(c);
      if (i >= 0) Combat.chars.splice(i, 1);
    }
  },
  refreshModels() { for (const c of this.chars.values()) if (c.remote) c.buildModel(); },

  applySnap(m) {
    const now = performance.now() / 1000;
    if (!this.haveSnap) { this.renderT = m.tm - CFG.NETCFG.INTERP; this.haveSnap = true; }
    this.latestTm = m.tm;
    this.latestRecv = now;
    const r = m.r;
    Round.state = NET_RSTATE[r[0]] || 'live';
    Round.timer = r[1];
    Round.score.T = r[2]; Round.score.CT = r[3];
    Round.number = r[4];
    Round.netBuyLeft = r[5];
    this.winRounds = r[6];
    const b = m.b;
    Bomb.state = NET_BSTATE[b[0]] || 'carried';
    Bomb.pos.set(b[1], b[2], b[3]);
    Bomb.timer = b[4];
    Bomb.site = b[5] === 0 ? 'A' : b[5] === 1 ? 'B' : null;
    Bomb.planting = b[6] ? this.chars.get(b[6]) || null : null;
    Bomb.plantT = b[7];
    Bomb.defuser = b[8] ? this.chars.get(b[8]) || null : null;
    Bomb.defuseT = b[9];
    Bomb.defuseDur = b[10];
    const P = Game.player;
    for (const e of m.c) {
      if (e[0] === this.myId) { if (P.alive) P.health = e[9]; continue; }
      const c = this.chars.get(e[0]);
      if (c && c.remote) c.push(m.tm, e);
    }
  },

  pendingCount(type) {
    const a = this.pendingNades[type], now = performance.now();
    while (a.length && now - a[0] > 1500) a.shift();
    return a.length;
  },
  notePendingNade(type) { this.pendingNades[type].push(performance.now()); },

  /** 服务器同步的背包/金钱（弹药以本地为准，除非是回合开始的补满） */
  applyInv(m, spawn) {
    const P = Game.player;
    if (this.invReady && m.money !== P.money) UI.moneyDelta(m.money - P.money);
    this.invReady = true;
    P.money = m.money; P.armor = m.ar; P.helmet = !!m.hel; P.kit = !!m.kit;
    const setSlot = (slot, d) => {
      const cur = P.inv[slot];
      if (!d) { if (cur) { P.inv[slot] = null; if (P.slot === slot) P.switchBest(); } return; }
      if (!WEAPONS[d[0]]) return;
      if (!cur || cur.def.id !== d[0]) {
        const w = newWeapon(d[0]); w.mag = d[1]; w.reserve = d[2];
        P.inv[slot] = w;
        if (P.slot === slot) { P.slot = ''; P.switchTo(slot); }
      } else if (m.rf || spawn) { cur.mag = d[1]; cur.reserve = d[2]; }
    };
    setSlot('primary', m.p);
    setSlot('secondary', m.s);
    P.inv.he = Math.max(0, m.he - this.pendingCount('he'));
    P.inv.flash = Math.max(0, m.fl - this.pendingCount('flash'));
    P.inv.smoke = Math.max(0, m.sm - this.pendingCount('smoke'));
    P.inv.bomb = !!m.bomb;
    if (!P.alive || spawn) return;
    if (m.sw && P.inv[m.sw]) { P.slot = ''; P.switchTo(m.sw); }
    else if (P.slot === 'nade' && !P.hasNades()) P.switchBest();
    else if (P.slot === 'bomb' && !P.inv.bomb) P.switchBest();
    else if (!P.slot || (P.slot !== 'nade' && P.slot !== 'bomb' && !P.inv[P.slot])) P.switchBest();
  },

  applySpawn(m) {
    const P = Game.player;
    P.alive = true;
    P.health = m.hp;
    P.pos.set(m.p[0], m.p[1], m.p[2]);
    P.vel.set(0, 0, 0);
    P.yaw = m.yaw; P.pitch = 0;
    P.crouching = false; P.crouch = 0; P.height = CFG.PLAYER.HEIGHT;
    P.reloading = false; P.scope = 0; P.rescope = 0;
    P.planting = false; P.defusing = false; P.netUse = false;
    P.flashUntil = 0; P.tagUntil = 0; P.nextAttack = 0; P.shotIdx = 0; P.fireInacc = 0;
    P.nadeCharging = false; P.afterThrowAt = 0;
    P.specTarget = null; P.killer = null;
    this.pendingNades = { he: [], flash: [], smoke: [] };
    this.applyInv(m.inv, true);
    P.slot = '';
    P.switchTo(P.inv.primary ? 'primary' : 'secondary');
    P.drawEnd = 0;
  },

  applyBoard(list) {
    for (const e of list) {
      const c = this.chars.get(e[0]);
      if (!c) continue;
      const s = c.stats;
      s.k = e[1]; s.d = e[2]; s.a = e[3]; s.hs = e[4]; s.dmg = e[5]; s.mvp = e[6];
      if (e[7] >= 0 && c !== Game.player) c.money = e[7];
      c.ping = e[8];
    }
  },

  // ---------------- 服务器事件 ----------------
  onEvent(m) {
    const P = Game.player;
    const C = (id) => this.chars.get(id) || null;
    switch (m.e) {
      case 'shot': this.remoteShot(m); break;
      case 'knife': { const ch = C(m.c); if (ch && ch.remote) Events.emit('knife', { ch, heavy: !!m.h }); break; }
      case 'kill': this.onKill(m); break;
      case 'dmg': {
        const a = C(m.a);
        P.health = m.hp; P.armor = m.ar;
        P.tagUntil = Clock.time + CFG.PLAYER.TAG_TIME;
        Events.emit('damage', { victim: P, attacker: a, dmg: m.d, group: m.g, weaponId: m.w, dirx: 0, dirz: 0, helmet: false });
        break;
      }
      case 'hit': {
        const v = C(m.v);
        if (v) Events.emit('damage', { victim: v, attacker: P, dmg: m.d, group: m.g, helmet: !!m.h });
        break;
      }
      case 'flashed': Grenades.blind(P, m.d, m.a, null); break;
      case 'nade': {
        const owner = C(m.c) || P, mine = m.c === this.myId;
        if (mine) this.pendingNades[m.ty] && this.pendingNades[m.ty].shift();
        else { SFX.throwNade(owner.pos); if (owner.model) owner.model.onThrow(); }
        Grenades.netThrow(m, owner, mine);
        break;
      }
      case 'boom': Grenades.netBoom(m); break;
      case 'smokeState': FX.spawnSmoke(m.p[0], m.p[1], m.p[2], m.age); break;
      case 'planted':
        Bomb.state = 'planted';
        Bomb.site = m.site;
        Bomb.pos.set(m.p[0], m.p[1], m.p[2]);
        Bomb.planting = null;
        Bomb.showMesh(true, m.yaw || 0);
        if (!m.silent) Events.emit('bombPlanted', { ch: C(m.c), site: m.site });
        if (!m.silent) SFX.uiSound('planted');
        break;
      case 'defuseStart': { const ch = C(m.c); if (ch) { ch.kit = !!m.kit; Events.emit('defuseStart', ch); } break; }
      case 'defused': Bomb.state = 'defused'; Bomb.defuser = null; if (Bomb.led) { Bomb.led.visible = false; Bomb.glow.visible = false; } break;
      case 'exploded': Bomb.pos.set(m.p[0], m.p[1], m.p[2]); Bomb.state = 'exploded'; Bomb.explodeFx(); break;
      case 'itemAdd': {
        if (Items.byId(m.id)) break;
        let w = null;
        if (!m.k) { if (!WEAPONS[m.w]) break; w = newWeapon(m.w); w.mag = m.mag; w.reserve = m.res; }
        Items.drop(m.k ? 'bomb' : 'weapon', w, m.p[0], m.p[1], m.p[2], m.v[0], m.v[2], m.v[1], m.id);
        break;
      }
      case 'itemDel': { const it = Items.byId(m.id); if (it) Items.remove(it); break; }
      case 'roundStart':
        FX.clear(); Grenades.clear(); Items.clear(); Bomb.reset();
        Round.state = 'freeze'; Round.number = m.n;
        if (UI.screen === 'matchEnd') { UI.showScreen(null); if (!Input.locked) $('clickToPlay').classList.remove('hidden'); }
        Events.emit('roundStart', { number: m.n });
        break;
      case 'roundLive': Round.state = 'live'; SFX.uiSound('roundStart'); Events.emit('roundLive', {}); break;
      case 'roundEnd': {
        Round.state = 'end';
        Round.winner = m.w; Round.reason = m.r;
        if (Round.score[m.w] !== undefined) Round.score[m.w]++;
        const mvp = C(m.mvp);
        if (mvp) mvp.stats.rk = m.mk;
        Events.emit('roundEnd', { winner: m.w, reason: m.r, mvp });
        break;
      }
      case 'matchOver': UI.showNetMatchOver(m); break;
      case 'radio': { const from = C(m.c); if (from) Events.emit('radio', { from, text: m.text }); break; }
      case 'chat': UI.addChat(m); break;
      case 'buyres': UI.onBuyResult(m); break;
      case 'team':
        P.team = m.team;
        this.refreshModels();
        UI.center(`你已加入${m.team === 'T' ? '恐怖分子（T）' : '反恐精英（CT）'}`, '', 2.2);
        break;
      case 'teamq':
        UI.center(m.full ? '该阵营人数已满' : `下一回合将加入${m.team === 'T' ? '恐怖分子' : '反恐精英'}`, '', 2.2);
        break;
    }
  },

  onKill(m) {
    const P = Game.player;
    const k = this.chars.get(m.k) || null, v = this.chars.get(m.v);
    if (!v) return;
    if (v.remote) {
      let dx = 0, dz = 1;
      if (m.dx !== undefined) { dx = m.dx; dz = m.dz; }
      else if (k) { dx = v.pos.x - k.pos.x; dz = v.pos.z - k.pos.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; }
      v.startDeathAnim(dx, dz, m.w, !!m.hs);
      v.alive = false; v.health = 0;
    } else if (v === P) { P.alive = false; P.health = 0; }
    Events.emit('kill', { killer: k, victim: v, weaponId: m.w, headshot: !!m.hs, penetrated: !!m.pen });
  },

  /** 其他玩家/Bot 的开枪：在本地重放弹道、弹孔、枪口火光与枪声 */
  remoteShot(m) {
    const ch = this.chars.get(m.c), def = WEAPONS[m.w];
    if (!ch || !ch.remote || !def) return;
    const ox = m.o[0], oy = m.o[1], oz = m.o[2];
    const res = { ex: m.x[0], ey: m.x[1], ez: m.x[2], imp: m.im || [], bl: m.bl || null };
    const len = Math.hypot(res.ex - ox, res.ey - oy, res.ez - oz) || 1;
    const dx = (res.ex - ox) / len, dy = (res.ey - oy) / len, dz = (res.ez - oz) / len;
    Combat.presentBullet(ch, ox, oy, oz, dx, dy, dz, res);
    Events.emit('bullet', { shooter: ch, def, ox, oy, oz, ex: res.ex, ey: res.ey, ez: res.ez, res });
    Events.emit('shot', { ch, def });
  },

  // ---------------- 上报 ----------------
  sendHit(ch, g, mul, w, pen) {
    if (!ch || !ch.id) return;
    this.send({ t: 'hit', v: ch.id, g, m: nr3(mul), w, pen: pen ? 1 : 0 });
  },
  sendShot(w, ox, oy, oz, res) {
    this.send({
      t: 'shot', w, o: [nr2(ox), nr2(oy), nr2(oz)], x: [nr2(res.ex), nr2(res.ey), nr2(res.ez)],
      im: res.imp.slice(0, 6).map(m => [nr2(m[0]), nr2(m[1]), nr2(m[2]), nr3(m[3]), nr3(m[4]), nr3(m[5]), m[6], m[7]]),
      bl: res.bl ? res.bl.map(nr3) : 0,
    });
  },
  sendState() {
    const P = Game.player;
    if (!P.alive) return;
    const w = P.curWeapon();
    const f = (P.onGround ? 1 : 0) | (P.walking ? 2 : 0) | (P.crouching ? 4 : 0) | (P.scope ? 8 : 0) | (P.reloading ? 16 : 0) | (P.nadeCharging ? 32 : 0);
    this.send({
      t: 'st', p: [nr2(P.pos.x), nr2(P.pos.y), nr2(P.pos.z)], v: [nr2(P.vel.x), nr2(P.vel.y), nr2(P.vel.z)],
      a: [nr3(P.yaw), nr3(P.pitch)], cr: (P.crouch * 100) | 0, f, h: Math.max(0, NET_HELD.indexOf(P.heldId())),
      am: w && w.def.mag ? [w.mag, w.reserve] : 0,
    });
  },

  /** 每帧：推进插值时间、采样其他玩家、本地计时、上报状态与测延迟 */
  update(dt) {
    if (!this.inRoom) return;
    const now = performance.now() / 1000;
    if (this.haveSnap) {
      const target = this.latestTm + (now - this.latestRecv) - CFG.NETCFG.INTERP;
      this.renderT += dt;
      const err = target - this.renderT;
      if (Math.abs(err) > 0.5) this.renderT = target;
      else this.renderT += err * Math.min(1, dt * 3);
    }
    for (const c of this.chars.values()) if (c.remote) c.sample(this.renderT, dt);
    if (Round.timer > 0 && Round.state !== 'over') Round.timer = Math.max(0, Round.timer - dt);
    Round.netBuyLeft -= dt;
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / CFG.NETCFG.SEND_RATE) {
      this.sendAcc = Math.min(this.sendAcc - 1 / CFG.NETCFG.SEND_RATE, 0.1);
      this.sendState();
    }
    this.pingT -= dt;
    if (this.pingT <= 0) { this.pingT = 2; this.send({ t: 'ping', c: now }); }
  },
  tickReplicas(dt) { for (const c of this.chars.values()) if (c.remote) c.tick(dt); },
};
