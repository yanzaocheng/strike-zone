// =====================================================================
//  09 角色模块（玩家与 Bot 共用）
//  - CharModel：第三人称人物模型的门面（实现见 20_avatar.js）
//  - Character：生命/护甲/背包/武器状态/扩散计算/开火/近战/下蹲
//  - Combat：子弹射线（含穿透）、命中盒判定、伤害结算、击杀
//  - Items：地面上的掉落武器与 C4
// =====================================================================

// ---- 命中盒（局部坐标，朝 -Z），站立/下蹲两套，按下蹲程度插值；头部另随俯仰前后移动（与人物模型一致） ----
const HITBOXES = [
  // 部位, 中心(站), 中心(蹲), 半尺寸(站), 半尺寸(蹲)
  { g: 'head', c: [0, 1.68, -0.01], cc: [0, 1.215, -0.06], h: [0.12, 0.14, 0.13], hc: [0.12, 0.14, 0.13] },
  { g: 'chest', c: [0, 1.33, 0], cc: [0, 0.9, -0.03], h: [0.23, 0.19, 0.15], hc: [0.23, 0.19, 0.16] },
  { g: 'arm', c: [0.08, 1.3, -0.3], cc: [0.08, 0.92, -0.3], h: [0.2, 0.07, 0.15], hc: [0.2, 0.07, 0.15] },
  { g: 'stomach', c: [0, 1.03, 0], cc: [0, 0.66, -0.02], h: [0.2, 0.12, 0.13], hc: [0.2, 0.11, 0.14] },
  { g: 'legs', c: [0, 0.46, 0], cc: [0, 0.27, -0.12], h: [0.19, 0.46, 0.13], hc: [0.2, 0.27, 0.26] },
];
const HIT_MULT = { head: 4.0, chest: 1.0, arm: 1.0, stomach: 1.25, legs: 0.75 };

/**
 * 第三人称人物模型的门面：具体实现（几何、骨骼动画、布娃娃）在 20_avatar.js（仅客户端）。
 * 服务器上没有模型，所有调用都以 model 为空直接返回。
 */
const CharModel = {
  create(team, name, friendly) { return new Avatar(team, name, friendly); },
  setGun(m, id) { if (m) m.setHeld(id); },
  dispose(m) { if (m) m.dispose(); },
};

function newWeapon(id) {
  const def = WEAPONS[id];
  return { def, mag: def.mag || 0, reserve: def.reserve || 0 };
}

let CHAR_ID = 0;
class Character {
  constructor(team, name) {
    this.id = ++CHAR_ID;
    this.team = team;
    this.name = name;
    this.isPlayer = false;     // 本机第一人称玩家
    this.isHuman = false;      // 真人控制（本机玩家 / 服务器上的联机玩家）
    this.isBot = false;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.hw = CFG.PLAYER.HALF_W;
    this.height = CFG.PLAYER.HEIGHT;
    this.onGround = true; this.groundBox = null; this.landSpeed = 0; this.stepUp = 0; this.jumped = false;
    this.yaw = 0; this.pitch = 0;
    this.crouching = false; this.crouch = 0; this.walking = false;
    this.alive = true; this.health = 100; this.armor = 0; this.helmet = false; this.kit = false;
    this.money = CFG.ECON.START;
    this.inv = { primary: null, secondary: null, knife: newWeapon('knife'), he: 0, flash: 0, smoke: 0, bomb: false };
    this.slot = 'secondary'; this.prevSlot = 'knife'; this.nadeType = 'he';
    this.nextAttack = 0; this.reloading = false; this.reloadEnd = 0; this.drawEnd = 0;
    this.shotIdx = 0; this.fireInacc = 0; this.lastShot = -10;
    this.scope = 0; this.scopeStart = 0; this.rescope = 0; this.boltUntil = 0;
    this.tagUntil = 0;
    this.flashUntil = 0; this.flashDur = 0; this.flashAmt = 0;
    this.stats = { k: 0, d: 0, a: 0, hs: 0, dmg: 0, mvp: 0, rk: 0, rdmg: 0 };
    this.damagers = new Map();
    this.model = null;
    this.stepAcc = 0;
    this.lastDamageFrom = null;
  }

  // ---------------- 背包与武器 ----------------
  curWeapon() {
    const s = this.slot;
    return s === 'primary' || s === 'secondary' || s === 'knife' ? this.inv[s] : null;
  }
  /** 当前手持物品的模型 id */
  heldId() {
    const w = this.curWeapon();
    if (w) return w.def.model || w.def.id;
    if (this.slot === 'nade') return this.nadeType;
    if (this.slot === 'bomb') return 'c4';
    return 'knife';
  }
  hasNades() { return this.inv.he + this.inv.flash + this.inv.smoke > 0; }
  nadeCount() { return this.inv.he + this.inv.flash + this.inv.smoke; }
  maxSpeed() {
    const B = CFG.PLAYER.BASE_SPEED;
    const w = this.curWeapon();
    let sp = 250;
    if (w) sp = (this.scope && w.def.scopedSpeed) ? w.def.scopedSpeed : w.def.speed;
    else if (this.slot === 'nade') sp = 245;
    let v = B * sp / 250;
    if (Clock.time < this.tagUntil) v *= CFG.PLAYER.TAG_MULT;
    return v;
  }
  /** 当前总扩散（度） */
  inaccuracy() {
    const w = this.curWeapon();
    if (!w || !w.def.spread) return 0;
    const d = w.def, s = d.spread;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const maxSp = CFG.PLAYER.BASE_SPEED * d.speed / 250;
    const mv = Math.pow(clamp((speed - maxSp * 0.3) / (maxSp * 0.7), 0, 1), 1.4);
    const crouched = this.crouch > 0.6;
    let base = crouched ? s.crouch : s.base, move = s.move, air = s.air;
    if (d.kind === 'sniper' && this.scope > 0) {
      // 开镜后约 0.25 秒逐渐变准
      const k = smoothstep(0, 0.28, Clock.time - this.scopeStart);
      base = lerp(base, crouched ? s.sCrouch : s.sBase, k);
      move = s.sMove; air = s.sAir;
    }
    return base + move * mv + (this.onGround ? 0 : air) + this.fireInacc;
  }
  eyeHeight() { return lerp(CFG.PLAYER.EYE, CFG.PLAYER.CROUCH_EYE, this.crouch); }
  eye(out) { return out.set(this.pos.x, this.pos.y + this.eyeHeight(), this.pos.z); }
  headPos(out) {
    const k = this.crouch, p = this.pitch || 0, f = -0.15 * Math.sin(p);   // 低头时头部前移、抬头时后移
    return out.set(this.pos.x - Math.sin(this.yaw) * f, this.pos.y + lerp(1.68, 1.215, k) - 0.1 * (1 - Math.cos(p)), this.pos.z - Math.cos(this.yaw) * f);
  }
  chestPos(out) { const k = this.crouch; return out.set(this.pos.x, this.pos.y + lerp(1.28, 0.9, k), this.pos.z); }

  /** 切换武器槽位：'primary' | 'secondary' | 'knife' | 'nade' | 'bomb' */
  switchTo(slot, nadeType) {
    if (!this.alive) return false;
    if (slot === 'nade') {
      if (!this.hasNades()) return false;
      if (nadeType && this.inv[nadeType] <= 0) return false;
      if (!nadeType || this.inv[nadeType] <= 0) nadeType = NADE_ORDER.find(t => this.inv[t] > 0);
      if (this.slot === 'nade' && this.nadeType === nadeType) return false;
      this.nadeType = nadeType;
    } else if (slot === 'bomb') {
      if (!this.inv.bomb || this.slot === 'bomb') return false;
    } else {
      if (!this.inv[slot] || this.slot === slot) return false;
    }
    if (this.slot !== slot) this.prevSlot = this.slot;
    this.slot = slot;
    this.reloading = false;
    this.scope = 0; this.rescope = 0;
    this.nadeCharging = false;
    const w = this.curWeapon();
    const draw = w ? (w.def.draw || 0.8) : slot === 'bomb' ? 0.6 : 0.5;
    this.drawEnd = Clock.time + draw;
    this.shotIdx = 0;
    this.onSwitch && this.onSwitch();
    return true;
  }
  /** 当前槽位的武器没了（投完手雷等），自动切到最好的武器 */
  switchBest() {
    const s = this.inv.primary ? 'primary' : this.inv.secondary ? 'secondary' : 'knife';
    this.slot = '';
    this.switchTo(s);
  }
  startReload() {
    const w = this.curWeapon();
    if (!w || !w.def.mag || this.reloading || w.mag >= w.def.mag || w.reserve <= 0) return false;
    if (Clock.time < this.drawEnd) return false;
    this.reloading = true;
    this.reloadEnd = Clock.time + w.def.reload;
    this.scope = 0; this.rescope = 0;
    this.onReload && this.onReload(w.def.reload);
    return true;
  }
  updateWeaponState(dt) {
    const w = this.curWeapon();
    const t = Clock.time;
    if (this.reloading && w && t >= this.reloadEnd) {
      const need = w.def.mag - w.mag, take = Math.min(need, w.reserve);
      w.mag += take; w.reserve -= take;
      this.reloading = false;
      this.shotIdx = 0;
    }
    // 后坐力恢复
    if (w && w.def.pattern) {
      if (t - this.lastShot > w.def.rate * 1.15) this.shotIdx *= Math.exp(-dt / (w.def.recoverT || 0.18));
      if (this.shotIdx < 0.05) this.shotIdx = 0;
    } else this.shotIdx = 0;
    if (w && w.def.spread) this.fireInacc *= Math.exp(-dt / (w.def.spread.recover * 0.45));
    else this.fireInacc = 0;
    // 狙击枪开枪后拉栓完成自动重新开镜
    if (this.rescope && t >= this.boltUntil && !this.reloading) {
      if (w && w.def.kind === 'sniper' && w.mag > 0) { this.scope = this.rescope; this.scopeStart = t; }
      this.rescope = 0;
    }
  }
  canAttack() {
    const t = Clock.time;
    return this.alive && t >= this.nextAttack && t >= this.drawEnd && !this.reloading;
  }
  /** 开火：yaw/pitch 为基础瞄准角，comp 为压枪补偿（0~1，Bot 使用） */
  fireWeapon(yaw, pitch, comp = 0) {
    const w = this.curWeapon();
    if (!w || !w.def.mag) return 'none';
    const d = w.def;
    if (w.mag <= 0) { this.nextAttack = Clock.time + 0.25; return 'empty'; }
    const inacc = this.inaccuracy();
    const pat = samplePattern(d.pattern, this.shotIdx);
    const px = pat[0] * (1 - comp), py = pat[1] * (1 - comp);
    const r = inacc * Math.random(), a = Math.random() * TAU;
    const fy = yaw - (px + Math.cos(a) * r) * DEG;
    const fp = pitch + (py + Math.sin(a) * r) * DEG;
    dirFromAngles(fy, fp, _cDir);
    this.eye(_cEye);
    Combat.fireBullet(this, _cEye.x, _cEye.y, _cEye.z, _cDir.x, _cDir.y, _cDir.z, d);
    w.mag--;
    this.shotIdx += 1;
    this.fireInacc = Math.min(d.spread.max, this.fireInacc + d.spread.shot);
    this.lastShot = Clock.time;
    this.nextAttack = Clock.time + d.rate;
    if (d.bolt) {
      this.boltUntil = Clock.time + d.rate;
      if (this.scope) { this.rescope = this.scope; this.scope = 0; }
    }
    Events.emit('shot', { ch: this, def: d });
    return 'fired';
  }
  knifeAttack(heavy) {
    const d = WEAPONS.knife;
    this.nextAttack = Clock.time + (heavy ? d.heavyRate : d.rate);
    this.eye(_cEye);
    dirFromAngles(this.yaw, this.pitch, _cDir);
    Events.emit('knife', { ch: this, heavy });
    const hit = Combat.traceMelee(this, _cEye, _cDir, d.range);
    if (NET.mode === 'client' && this.isPlayer) NetClient.send({ t: 'knife', h: heavy ? 1 : 0 });
    if (hit && hit.char) {
      const v = hit.char;
      // 背刺：攻击者位于受害者身后
      const vf = _v6.set(-Math.sin(v.yaw), 0, -Math.cos(v.yaw));
      const back = vf.dot(_v5.set(_cDir.x, 0, _cDir.z).normalize()) > 0.5;
      const dmg = heavy ? (back ? 180 : 65) : (back ? 90 : 40);
      if (NET.mode === 'client') NetClient.send({ t: 'hit', v: v.id, g: 'chest', w: 'knife', kn: heavy ? 1 : 0, bk: back ? 1 : 0 });
      else Combat.damage(v, dmg, this, 'knife', 'chest', _cDir.x, _cDir.z, false, true);
      SFX.knifeHit(true, this.isPlayer ? null : this.pos);
      return true;
    }
    if (hit && hit.world) {
      const h = hit.world;
      FX.impact(h.x, h.y, h.z, h.nx, h.ny, h.nz, h.box.mat);
      SFX.knifeHit(false, this.isPlayer ? null : this.pos);
    }
    return false;
  }

  /** 下蹲/起身（考虑空中蹲跳与头顶空间） */
  setCrouch(want) {
    const P = CFG.PLAYER;
    if (want === this.crouching) return;
    const dh = P.HEIGHT - P.CROUCH_HEIGHT;
    if (want) {
      this.crouching = true;
      this.height = P.CROUCH_HEIGHT;
      // 空中下蹲：收腿（脚底上移），视线高度保持不变 → 能跳上更高的箱子
      if (!this.onGround) { this.pos.y += dh; this.crouch = 1; }
    } else {
      if (this.onGround) {
        if (!Physics.free(this.pos.x, this.pos.y, this.pos.z, this.hw, P.HEIGHT)) return;
      } else {
        if (Physics.free(this.pos.x, this.pos.y - dh, this.pos.z, this.hw, P.HEIGHT)) { this.pos.y -= dh; this.crouch = 0; }
        else if (!Physics.free(this.pos.x, this.pos.y, this.pos.z, this.hw, P.HEIGHT)) return;
      }
      this.crouching = false;
      this.height = P.HEIGHT;
    }
  }

  /** 回合开始时重置状态；keep=是否保留装备（上回合存活） */
  resetForRound(keep) {
    this.alive = true;
    this.health = 100;
    if (!keep) {
      this.armor = 0; this.helmet = false; this.kit = false;
      this.inv.primary = null;
      this.inv.secondary = newWeapon(this.team === 'CT' ? 'p2k' : 'g18');
      this.inv.he = this.inv.flash = this.inv.smoke = 0;
    } else {
      for (const s of ['primary', 'secondary']) {
        const w = this.inv[s];
        if (w) { w.mag = w.def.mag; w.reserve = w.def.reserve; }
      }
      if (!this.inv.secondary && !this.inv.primary) this.inv.secondary = newWeapon(this.team === 'CT' ? 'p2k' : 'g18');
    }
    this.inv.bomb = false;
    this.vel.set(0, 0, 0);
    this.crouching = false; this.crouch = 0; this.height = CFG.PLAYER.HEIGHT;
    this.reloading = false; this.scope = 0; this.rescope = 0; this.fireInacc = 0; this.shotIdx = 0;
    this.nextAttack = 0; this.tagUntil = 0; this.flashUntil = 0; this.flashAmt = 0;
    this.afterThrowAt = 0; this.nadeCharging = false; this.planting = false;
    this.damagers.clear();
    this.stats.rk = 0; this.stats.rdmg = 0;
    this.slot = '';
    this.switchTo(this.inv.primary ? 'primary' : 'secondary');
    this.drawEnd = 0;
    if (this.model) this.model.reset();
  }

  // ---------------- 第三人称模型 ----------------
  updateModel(dt) { if (this.model) this.model.update(this, dt); }
  /** 死亡：模型切换为布娃娃（dirx/dirz 为致命一击的方向） */
  startDeathAnim(dirx, dirz, weaponId, headshot) { if (this.model) this.model.die(this, dirx, dirz, weaponId, headshot); }
  /** 身上可见的装备（背枪、枪套、C4） */
  gearState() {
    const p = this.inv.primary, s = this.inv.secondary;
    const g = this._gear || (this._gear = { p: '', s: '', bomb: false });
    g.p = p ? p.def.model || p.def.id : '';
    g.s = s ? s.def.model || s.def.id : '';
    g.bomb = !!this.inv.bomb;
    return g;
  }
}
const _cDir = new THREE.Vector3(), _cEye = new THREE.Vector3();

// =====================================================================
//  战斗结算
// =====================================================================
const Combat = {
  chars: [],
  hit: { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, box: null },
  _o: new THREE.Vector3(),

  /** 射线与角色命中盒求交，返回 {t, g} 或 null */
  rayChar(ch, ox, oy, oz, dx, dy, dz, maxT) {
    const p = ch.pos;
    // 粗筛：射线到角色中轴线中点的距离
    const cx = p.x - ox, cy = p.y + 0.9 - oy, cz = p.z - oz;
    const tc = cx * dx + cy * dy + cz * dz;
    if (tc < -1.5 || tc > maxT + 1.5) return null;
    const qx = cx - dx * tc, qy = cy - dy * tc, qz = cz - dz * tc;
    if (qx * qx + qy * qy + qz * qz > 1.6) return null;
    // 转到角色局部坐标（绕 Y 轴旋转 -yaw）
    const cs = Math.cos(ch.yaw), sn = Math.sin(ch.yaw);
    const rx = ox - p.x, ry = oy - p.y, rz = oz - p.z;
    const lox = cs * rx - sn * rz, loz = sn * rx + cs * rz, loy = ry;
    const ldx = cs * dx - sn * dz, ldz = sn * dx + cs * dz, ldy = dy;
    const k = ch.crouch;
    let best = maxT, bg = null;
    const hp = ch.pitch || 0, hdz = 0.15 * Math.sin(hp), hdy = -0.1 * (1 - Math.cos(hp));
    for (const hb of HITBOXES) {
      let ccx = lerp(hb.c[0], hb.cc[0], k), ccy = lerp(hb.c[1], hb.cc[1], k), ccz = lerp(hb.c[2], hb.cc[2], k);
      if (hb.g === 'head') { ccy += hdy; ccz += hdz; }
      const hx = lerp(hb.h[0], hb.hc[0], k), hy = lerp(hb.h[1], hb.hc[1], k), hz = lerp(hb.h[2], hb.hc[2], k);
      let t0 = -Infinity, t1 = Infinity;
      // x
      if (Math.abs(ldx) < 1e-9) { if (Math.abs(lox - ccx) > hx) continue; }
      else { let a = (ccx - hx - lox) / ldx, b = (ccx + hx - lox) / ldx; if (a > b) { const q = a; a = b; b = q; } t0 = Math.max(t0, a); t1 = Math.min(t1, b); }
      if (Math.abs(ldy) < 1e-9) { if (Math.abs(loy - ccy) > hy) continue; }
      else { let a = (ccy - hy - loy) / ldy, b = (ccy + hy - loy) / ldy; if (a > b) { const q = a; a = b; b = q; } t0 = Math.max(t0, a); t1 = Math.min(t1, b); }
      if (Math.abs(ldz) < 1e-9) { if (Math.abs(loz - ccz) > hz) continue; }
      else { let a = (ccz - hz - loz) / ldz, b = (ccz + hz - loz) / ldz; if (a > b) { const q = a; a = b; b = q; } t0 = Math.max(t0, a); t1 = Math.min(t1, b); }
      if (t0 > t1 || t1 < 0) continue;
      const t = Math.max(0, t0);
      if (t < best) { best = t; bg = hb.g; }
    }
    return bg ? { t: best, g: bg } : null;
  },

  /**
   * 发射一颗子弹：世界遮挡 + 角色命中 + 可穿透木箱/门板
   * 结果 res = { ex,ey,ez 终点, imp: [[x,y,z,nx,ny,nz,材质,是否穿出]…], bl: [x,y,z,dx,dy,dz,爆头] | null }
   * 单机/服务器：直接结算伤害；联机客户端：把命中上报服务器，由服务器校验后结算
   */
  fireBullet(shooter, ox, oy, oz, dx, dy, dz, def) {
    const client = NET.mode === 'client';
    let power = def.pen || 1, dmgMul = 1, traveled = 0, penetrated = false;
    const range = 250;
    let sx = ox, sy = oy, sz = oz;
    const res = { ex: ox + dx * 60, ey: oy + dy * 60, ez: oz + dz * 60, imp: [], bl: null };
    const hit = this.hit;
    for (let seg = 0; seg < 4; seg++) {
      const hitWorld = World.raycast(sx, sy, sz, dx, dy, dz, range - traveled, hit);
      const wT = hitWorld ? hit.t : range - traveled;
      // 角色
      let bestC = null, bestT = wT;
      for (const ch of this.chars) {
        if (!ch.alive || ch === shooter || ch.team === shooter.team) continue;
        const r = this.rayChar(ch, sx, sy, sz, dx, dy, dz, bestT);
        if (r && r.t < bestT) { bestT = r.t; bestC = { ch, g: r.g }; }
      }
      if (bestC) {
        const mul = Math.pow(def.falloff || 1, (traveled + bestT) / 12.7) * dmgMul;
        const hx = sx + dx * bestT, hy = sy + dy * bestT, hz = sz + dz * bestT;
        res.bl = [hx, hy, hz, dx, dy, dz, bestC.g === 'head' ? 1 : 0];
        res.ex = hx; res.ey = hy; res.ez = hz;
        if (client) NetClient.sendHit(bestC.ch, bestC.g, mul, def.id, penetrated);
        else this.damage(bestC.ch, def.damage * HIT_MULT[bestC.g] * mul, shooter, def.id, bestC.g, dx, dz, penetrated);
        break;
      }
      if (!hitWorld) break;
      // 击中墙体/道具
      const box = hit.box;
      const hx = hit.x, hy = hit.y, hz = hit.z;
      res.ex = hx; res.ey = hy; res.ez = hz;
      res.imp.push([hx, hy, hz, hit.nx, hit.ny, hit.nz, box.mat, 0]);
      if (!box.pen || box.isGround || power <= 0) break;
      const thick = World.exitDist(box, hx + dx * 0.002, hy + dy * 0.002, hz + dz * 0.002, dx, dy, dz);
      const cost = thick * box.pen * 2;
      if (cost >= power) break;
      dmgMul *= 1 - 0.5 * cost / power;
      power -= cost;
      penetrated = true;
      traveled += hit.t + thick + 0.004;
      sx = hx + dx * (thick + 0.004); sy = hy + dy * (thick + 0.004); sz = hz + dz * (thick + 0.004);
      res.imp.push([sx, sy, sz, dx, dy, dz, box.mat, 1]);
    }
    this.presentBullet(shooter, ox, oy, oz, dx, dy, dz, res);
    Events.emit('bullet', { shooter, def, ox, oy, oz, ex: res.ex, ey: res.ey, ez: res.ez, res });
    if (client && shooter.isPlayer) NetClient.sendShot(def.id, ox, oy, oz, res);
  },

  /** 子弹的视觉与声音表现：弹孔、火花、血雾、耳边呼啸（服务器上跳过） */
  presentBullet(shooter, ox, oy, oz, dx, dy, dz, res) {
    if (IS_SERVER) return;
    for (const m of res.imp) {
      FX.impact(m[0], m[1], m[2], m[3], m[4], m[5], m[6], !!m[7]);
      if (!m[7] && (shooter.isPlayer || Math.random() < 0.35)) SFX.impact(m[6], _v4.set(m[0], m[1], m[2]));
    }
    const b = res.bl;
    if (b) FX.blood(b[0], b[1], b[2], b[3], b[4], b[5], !!b[6]);
    // 子弹从玩家耳边飞过的"嗖"声
    const P = Game.player;
    if (P && P.alive && shooter !== P && shooter.team !== P.team) {
      P.eye(_v4);
      const cx = _v4.x - ox, cy = _v4.y - oy, cz = _v4.z - oz;
      const t = cx * dx + cy * dy + cz * dz;
      const len = Math.hypot(res.ex - ox, res.ey - oy, res.ez - oz);
      if (t > 2 && t < len + 1) {
        const qx = cx - dx * t, qy = cy - dy * t, qz = cz - dz * t;
        if (qx * qx + qy * qy + qz * qz < 1.4 * 1.4) SFX.whiz(_v4.set(ox + dx * t, oy + dy * t, oz + dz * t));
      }
    }
  },

  /** 近战判定：短射线（胶囊近似：略微放宽角色命中范围） */
  traceMelee(shooter, eye, dir, range) {
    let best = null, bestT = range;
    for (const ch of this.chars) {
      if (!ch.alive || ch === shooter || ch.team === shooter.team) continue;
      const r = this.rayChar(ch, eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, bestT);
      if (r) { bestT = r.t; best = ch; continue; }
      // 放宽：离准星很近的敌人也算命中
      const dx = ch.pos.x - eye.x, dz = ch.pos.z - eye.z;
      const d = Math.hypot(dx, dz);
      if (d < range && d > 0.1 && (dx * dir.x + dz * dir.z) / d > 0.9 && Math.abs(ch.pos.y + 1 - eye.y) < 1.2 && d < bestT) { bestT = d; best = ch; }
    }
    if (best && World.segClear(eye.x, eye.y, eye.z, best.pos.x, best.pos.y + 1.1, best.pos.z)) return { char: best };
    if (World.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, range, this.hit)) return { world: Object.assign({}, this.hit) };
    return null;
  },

  /**
   * 伤害结算（含护甲减免）
   * group：命中部位；dirx/dirz：子弹方向（用于受击指示与倒地方向）
   */
  damage(victim, raw, attacker, weaponId, group, dirx, dirz, penetrated = false, melee = false) {
    if (NET.mode === 'client' || !victim.alive || Game.state === 'menu') return;
    const def = WEAPONS[weaponId];
    const armorPen = def ? (def.armorPen || 0.85) : weaponId === 'he' ? 0.57 : 1;
    let dmg = raw;
    const protectedPart = group === 'head' ? victim.helmet : group !== 'legs';
    let armorHit = false;
    if (victim.armor > 0 && protectedPart && weaponId !== 'bomb') {
      let newDmg = dmg * armorPen;
      let armorDmg = (dmg - newDmg) * 0.5;
      if (armorDmg > victim.armor) { newDmg = dmg - victim.armor * 2; armorDmg = victim.armor; }
      victim.armor = Math.max(0, Math.round(victim.armor - armorDmg));
      dmg = newDmg;
      armorHit = true;
    }
    dmg = Math.max(1, Math.round(dmg));
    const dealt = Math.min(dmg, victim.health);
    victim.health -= dmg;
    victim.tagUntil = Clock.time + CFG.PLAYER.TAG_TIME;
    if (attacker && attacker !== victim) {
      if (attacker.team !== victim.team) {
        attacker.stats.dmg += dealt;
        attacker.stats.rdmg += dealt;
        victim.damagers.set(attacker, (victim.damagers.get(attacker) || 0) + dealt);
      }
      victim.lastDamageFrom = attacker;
    }
    Events.emit('damage', { victim, attacker, dmg, group, weaponId, dirx, dirz, armorHit, helmet: group === 'head' && victim.helmet });
    if (victim.health <= 0) this.kill(victim, attacker, weaponId, group === 'head', penetrated, dirx, dirz);
  },

  kill(victim, attacker, weaponId, headshot, penetrated, dirx = 0, dirz = 1) {
    if (NET.mode === 'client') return;
    victim.health = 0;
    victim.alive = false;
    victim.stats.d++;
    victim.startDeathAnim(dirx, dirz, weaponId, headshot);
    victim.vel.set(0, 0, 0);
    if (attacker && attacker !== victim && attacker.team !== victim.team) {
      attacker.stats.k++; attacker.stats.rk++;
      if (headshot) attacker.stats.hs++;
      const reward = weaponId === 'bomb' ? 0 : WEAPONS[weaponId] ? WEAPONS[weaponId].reward : NADES[weaponId] ? NADES[weaponId].reward : 300;
      Economy.give(attacker, reward);
      // 助攻：造成 41+ 伤害的其他人
      for (const [ch, d] of victim.damagers) if (ch !== attacker && ch.team !== victim.team && d >= 41) ch.stats.a++;
    }
    Items.dropOnDeath(victim);
    Events.emit('kill', { killer: attacker, victim, weaponId, headshot, penetrated, dirx, dirz });
  },

  /** 范围伤害（高爆手雷 / C4），被墙挡住的目标不受伤 */
  radiusDamage(x, y, z, radius, maxDmg, attacker, weaponId) {
    for (const ch of this.chars) {
      if (!ch.alive) continue;
      const cx = ch.pos.x, cy = ch.pos.y + 0.9, cz = ch.pos.z;
      const d = Math.hypot(cx - x, cy - y, cz - z);
      if (d > radius) continue;
      if (weaponId !== 'bomb' && ch !== attacker && attacker && ch.team === attacker.team) continue;   // 无友伤（自伤保留）
      // 遮挡检测：身体上中下任意一点可见即受伤
      const vis = World.segClear(x, y + 0.2, z, cx, cy + 0.5, cz) || World.segClear(x, y + 0.2, z, cx, cy - 0.5, cz) || World.segClear(x, y + 0.2, z, cx, cy + 0.9, cz);
      if (!vis && weaponId !== 'bomb') continue;
      let dmg = weaponId === 'bomb'
        ? maxDmg * Math.exp(-Math.pow(d / (radius * 0.36), 2))
        : maxDmg * Math.pow(1 - d / radius, 1.3);
      if (!vis) dmg *= 0.3;
      if (dmg < 1) continue;
      const len = d || 1;
      this.damage(ch, dmg, attacker, weaponId, 'chest', (cx - x) / len, (cz - z) / len);
    }
  },
};

// =====================================================================
//  地面掉落物（武器 / C4）
// =====================================================================
const Items = {
  list: [],
  nextId: 1,
  init(scene) { this.scene = scene; },
  /** 生成掉落物；netId 由联机客户端传入（服务器分配的编号） */
  drop(kind, w, x, y, z, vx = 0, vz = 0, vy = 1.5, netId = 0) {
    let mesh = null;
    if (this.scene) {
      mesh = GunModels.makeWorldMesh(kind === 'bomb' ? 'c4' : w.def.model || w.def.id);
      mesh.rotation.set(0, Math.random() * TAU, Math.PI / 2 * (kind === 'bomb' ? 0 : 1));
      this.scene.add(mesh);
    }
    const it = { id: netId || this.nextId++, kind, w, mesh, pos: new THREE.Vector3(x, y, z), vel: new THREE.Vector3(vx, vy, vz), settled: false, t: Clock.time };
    if (mesh) mesh.position.copy(it.pos);
    this.list.push(it);
    if (!netId) Events.emit('itemAdd', it);
    if (kind === 'bomb') Events.emit('bombDropped', it);
    return it;
  },
  byId(id) { return this.list.find(i => i.id === id) || null; },
  dropOnDeath(ch) {
    const p = ch.pos;
    const w = ch.inv.primary || (ch.inv.secondary && ch.inv.secondary.def.price > 200 ? ch.inv.secondary : null);
    if (w) { this.drop('weapon', w, p.x, p.y + 1.0, p.z, rand(-1, 1), rand(-1, 1)); }
    if (ch.inv.bomb) { ch.inv.bomb = false; this.drop('bomb', null, p.x + rand(-0.3, 0.3), p.y + 0.9, p.z + rand(-0.3, 0.3), rand(-0.6, 0.6), rand(-0.6, 0.6)); }
  },
  remove(it) {
    const i = this.list.indexOf(it);
    if (i < 0) return;
    this.list.splice(i, 1);
    if (it.mesh) this.scene.remove(it.mesh);
    Events.emit('itemDel', it);
  },
  clear() {
    for (const it of this.list) if (it.mesh) this.scene.remove(it.mesh);
    this.list.length = 0;
  },
  update(dt) {
    for (const it of this.list) {
      if (it.settled) continue;
      const p = it.pos, v = it.vel;
      v.y -= CFG.GRAVITY * dt;
      const nx = p.x + v.x * dt, nz = p.z + v.z * dt;
      if (World.segClear(p.x, p.y + 0.1, p.z, nx, p.y + 0.1, nz)) { p.x = nx; p.z = nz; }
      else { v.x = 0; v.z = 0; }
      const floor = World.floorBelow(p.x, p.y, p.z, 0.05, 3);
      p.y += v.y * dt;
      if (floor > -Infinity && p.y <= floor + 0.04) {
        p.y = floor + 0.04; v.set(0, 0, 0); it.settled = true;
      }
      if (p.y < -5) { p.y = 0.04; it.settled = true; }
      if (it.mesh) it.mesh.position.copy(p);
    }
  },
  /** 离角色最近的可拾取物品 */
  nearest(ch, maxD = 1.5) {
    let best = null, bd = maxD;
    for (const it of this.list) {
      if (Clock.time - it.t < 0.6 && it.dropper === ch) continue;
      const d = Math.hypot(it.pos.x - ch.pos.x, it.pos.z - ch.pos.z);
      if (d < bd && Math.abs(it.pos.y - ch.pos.y) < 1.4) { bd = d; best = it; }
    }
    return best;
  },
  bombItem() { return this.list.find(i => i.kind === 'bomb') || null; },
};
