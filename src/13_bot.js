// =====================================================================
//  13 Bot AI 模块
//  感知：视野 + 视线射线（墙体/烟雾阻挡）+ 听觉（枪声/脚步/落地/手雷）
//        发现目标需要累积"反应时间"，余光与远距离更慢
//  瞄准：初始误差（与需要转动的角度成正比）随时间衰减 + 最大转身速度 + 压枪能力
//  行为：据点防守 / 移动 / 交战 / 找掩体换弹 / 丢失目标后预瞄拐角 / 听声辨位 /
//        轮转支援 / 下包后回防拆弹 / 来不及拆弹时保枪 / T 队友推进与下包
// =====================================================================

const BOT_NAMES = {
  CT: ['Viper', 'Ghost', 'Falcon', 'Raven', 'Hawk', 'Titan', 'Blaze', 'Nova'],
  T: ['Jackal', 'Cobra', 'Nomad', 'Scorpion', 'Wolf'],
};
const _b1 = new THREE.Vector3(), _b2 = new THREE.Vector3(), _b3 = new THREE.Vector3(), _b4 = new THREE.Vector3(), _b5 = new THREE.Vector3();

/** 格子坐标 [c, r] → 世界坐标（含地面高度） */
function cellPos(cr, out) {
  const x = MAP.wx(cr[0]), z = MAP.wz(cr[1]);
  return out.set(x, Nav.floorAt(x, z), z);
}
function laneAt(x, z) { const a = MAP.areaAt(x, z); return a ? a.lane : 'mid'; }

class Bot extends Character {
  constructor(team, name, diffKey) {
    super(team, name);
    this.isBot = true;
    this.setDifficulty(diffKey);
    this.path = null; this.pathI = 0; this.goal = new THREE.Vector3(); this.moveMode = 'run';
    this.wantCrouch = false;
    this.progT = 0; this.progPos = new THREE.Vector3(); this.stuck = 0;
    this.known = new Map();
    this.target = null;
    this.percT = Math.random() * 0.1; this.thinkT = Math.random() * 0.2;
    this.errYaw = 0; this.errPitch = 0; this.errT = 0; this.jitY = 0; this.jitP = 0; this.headAim = false; this.headRollT = 0;
    this.look = new THREE.Vector3(); this.hasLook = false;
    this.state = 'idle'; this.stateT = 0;
    this.role = null; this.spot = null; this.aggroUntil = 0; this.spotShiftT = 0;
    this.burst = 0; this.burstPauseUntil = 0;
    this.strafe = 0; this.strafeUntil = 0;
    this.lostTarget = null; this.lostPos = new THREE.Vector3(); this.lostTime = -99; this.lostCorner = new THREE.Vector3();
    this.heardPos = new THREE.Vector3(); this.heardTime = -99; this.heardLoud = false; this.heardHandled = -99;
    this.coverUntil = 0; this.tookCoverAt = -99;
    this.nadeCD = 0;
    this.lookAwayUntil = 0;
    this.rotateTo = null; this.rotateAt = 0;
    this.tPhase = 'wait'; this.route = null; this.routeI = 0;
    this.radioT = 0;
  }
  setDifficulty(key) {
    this.diffKey = key;
    this.diff = DIFFICULTY[key] || DIFFICULTY.normal;
    this.reaction = rand(this.diff.reaction[0], this.diff.reaction[1]);
    this.crouchPref = chance(0.45);
  }
  onSwitch() { if (this.model) CharModel.setGun(this.model, this.heldId()); }
  onReload() {
    this._rsnd = false;
    SFX.reloadPart('out', this.pos);
    Events.emit('noise', { ch: this, x: this.pos.x, y: this.pos.y, z: this.pos.z, r: 7 });
  }

  resetForRound(keep) {
    super.resetForRound(keep);
    this.path = null; this.target = null; this.known.clear();
    this.state = 'idle'; this.stateT = 0; this.hasLook = false;
    this.lostTarget = null; this.lostTime = -99; this.heardTime = -99;
    this.coverUntil = 0; this.tookCoverAt = -99; this.nadeCD = Clock.time + rand(8, 20);
    this.rotateTo = null; this.strafe = 0; this.burst = 0; this.wantCrouch = false;
    this.tPhase = 'wait'; this.route = null; this.routeI = 0;
    this.reaction = rand(this.diff.reaction[0], this.diff.reaction[1]);
    if (this.model) CharModel.setGun(this.model, this.heldId());
  }
  setState(s) { if (this.state !== s) { this.state = s; this.stateT = 0; } }

  // ==================================================================
  update(dt) {
    if (!this.alive) { this.updateModel(dt); return; }
    const frozen = Round.isFrozen();
    if (this.reloading && !this._rsnd && this.reloadEnd - Clock.time < 0.6) { this._rsnd = true; SFX.reloadPart('in', this.pos); }
    this.updateWeaponState(dt);
    this.percT -= dt;
    if (this.percT <= 0 && !frozen) { this.percT = 0.1; this.perceive(); }
    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = 0.2; if (!frozen && Round.state !== 'end') this.think(); }
    if (this.state === 'defuse' && Bomb.updateDefuse(this, dt)) { this.setState('idle'); this.wantCrouch = false; }
    if (this.state === 'plant') {
      if (!this.inv.bomb) this.setState('idle');
      else if (Bomb.updatePlant(this, dt)) this.setState('idle');
    }
    this.updateAim(dt);
    if (!frozen && Round.state !== 'end') this.updateCombat(dt);
    this.updateMove(dt, frozen);
    CharModel.setGun(this.model, this.heldId());
    this.updateModel(dt);
  }

  // ==================================================================
  //  感知
  // ==================================================================
  perceive() {
    const now = Clock.time;
    const blind = now < this.flashUntil - this.flashDur * 0.25;
    this.eye(_b1);
    let best = null, bestScore = Infinity;
    for (const e of Combat.chars) {
      if (e.team === this.team) continue;
      if (!e.alive) { if (this.known.has(e)) this.known.delete(e); if (this.target === e) this.target = null; continue; }
      let k = this.known.get(e);
      if (!k) { k = { visT: 0, spotted: false, seenNow: false, lastSeen: -99, pos: new THREE.Vector3() }; this.known.set(e, k); }
      let vis = false, angK = 1, d = 0;
      if (!blind) {
        e.headPos(_b2);
        const dx = _b2.x - _b1.x, dz = _b2.z - _b1.z;
        d = Math.hypot(dx, dz);
        const ang = Math.abs(wrapAngle(yawOf(dx, dz) - this.yaw));
        if (d < 95 && (ang < 65 * DEG || d < 2.2)) {
          angK = ang < 25 * DEG ? 1 : ang < 45 * DEG ? 0.7 : 0.42;
          vis = this.canSee(_b1, e);
        }
      }
      if (vis) {
        const recent = now - k.lastSeen < 3;
        const moving = Math.hypot(e.vel.x, e.vel.z) > 2.5 ? 1.15 : 0.85;
        const distK = clamp(1.3 - d / 70, 0.55, 1.2);
        k.visT += 0.1 * angK * distK * moving * (recent ? 2.2 : 1);
        k.seenNow = true;
        k.lastSeen = now;
        k.pos.copy(e.pos);
        if (!k.spotted && k.visT >= this.reaction) {
          k.spotted = true;
          this.onSpotted(e, k);
        }
      } else {
        k.seenNow = false;
        k.visT = Math.max(0, k.visT - 0.15);
        if (k.spotted && now - k.lastSeen > 0.35) {
          k.spotted = false;
          if (this.target === e) this.loseTarget(e, k);
        }
      }
      if (k.spotted && k.seenNow) {
        let score = e.pos.distanceTo(this.pos);
        if (e === this.target) score -= 6;
        if (e.health < 40) score -= 2;
        if (score < bestScore) { bestScore = score; best = e; }
      }
    }
    if (best !== this.target) {
      if (best) this.acquire(best);
      this.target = best;
    }
  }
  canSee(eye, e) {
    e.headPos(_b3);
    if (World.segClear(eye.x, eye.y, eye.z, _b3.x, _b3.y, _b3.z) && !FX.smokeBlocks(eye.x, eye.y, eye.z, _b3.x, _b3.y, _b3.z)) return true;
    e.chestPos(_b3);
    if (World.segClear(eye.x, eye.y, eye.z, _b3.x, _b3.y, _b3.z) && !FX.smokeBlocks(eye.x, eye.y, eye.z, _b3.x, _b3.y, _b3.z)) return true;
    return false;
  }
  /** 锁定新目标：初始瞄准误差与需要转动的角度成正比（预瞄到位的 Bot 更致命） */
  acquire(e) {
    this.eye(_b1); e.chestPos(_b2);
    const ang = Math.abs(wrapAngle(yawOf(_b2.x - _b1.x, _b2.z - _b1.z) - this.yaw));
    const k = clamp(ang / (30 * DEG), 0.35, 1.5);
    const a = Math.random() * TAU;
    const mag = this.diff.errInit * k * rand(0.7, 1.2) * DEG;
    this.errYaw = Math.cos(a) * mag;
    this.errPitch = Math.sin(a) * mag * 0.6;
    this.headAim = chance(this.diff.headChance);
    this.headRollT = Clock.time + rand(0.8, 1.6);
    this.burst = 0;
    this.burstPauseUntil = Clock.time + rand(0.0, 0.08);
  }
  onSpotted(e, k) {
    const lane = laneAt(e.pos.x, e.pos.z);
    if (this.team === 'CT') TeamAI.alert(lane, e.inv.bomb ? 2 : 1);
    else if (Clock.time > this.radioT) {
      this.radioT = Clock.time + 6;
      const a = MAP.areaAt(e.pos.x, e.pos.z);
      Events.emit('radio', { from: this, text: `发现敌人 — ${a ? a.name : '附近'}` });
    }
  }
  loseTarget(e, k) {
    this.lostTarget = e;
    this.lostPos.copy(k.pos);
    this.lostTime = Clock.time;
    this.computeCorner(this.lostPos, this.lostCorner);
  }
  /** 计算从自己到某点的路径上第一个拐角（敌人最可能出现的地方），用于预瞄 */
  computeCorner(p, out) {
    const path = Nav.findPath(this.pos.x, this.pos.z, p.x, p.z, this.pos.y, p.y);
    out.copy(p);
    if (path && path.length) {
      let i = 0;
      while (i < path.length - 1 && path[i].distanceTo(this.pos) < 2.5) i++;
      out.copy(path[i]);
    }
    out.y += 1.5;
    return out;
  }
  hear(x, y, z, loud) {
    if (Clock.time < this.flashUntil - this.flashDur * 0.4) return;
    if (this.target) return;
    this.heardPos.set(x, y, z);
    this.heardTime = Clock.time;
    this.heardLoud = loud;
  }
  onDamaged(e) {
    const a = e.attacker;
    if (!a || a === this || a.team === this.team) return;
    // 受击扰动（aim punch）：中弹会打乱 Bot 的瞄准，先开枪命中的一方占优
    this.errYaw += rand(-1, 1) * 2.2 * DEG;
    this.errPitch += rand(0.4, 1.6) * DEG;
    this.burstPauseUntil = Math.max(this.burstPauseUntil, Clock.time + rand(0.06, 0.16));
    // 被打但没看到攻击者：立刻转向并更快发现
    let k = this.known.get(a);
    if (k) k.visT += 0.25;
    if (!this.target) {
      this.lostTarget = a; this.lostPos.copy(a.pos); this.lostTime = Clock.time;
      this.lostCorner.copy(a.pos); this.lostCorner.y += 1.4;
      this.hasLook = true; this.look.copy(this.lostCorner);
    }
    if (this.state === 'defuse' && this.health < 50 && Bomb.timer > (Bomb.defuseDur - Bomb.defuseT) + 3) { Bomb.cancelDefuse(this); this.setState('idle'); this.wantCrouch = false; }
  }

  // ==================================================================
  //  决策
  // ==================================================================
  think() {
    const now = Clock.time;
    this.stateT += 0.2;
    if (now < this.flashUntil - this.flashDur * 0.2) { this.setState('blind'); this.thinkBlind(); return; }
    if (this.state === 'blind') this.setState('idle');
    if (this.state === 'defuse' && this.thinkDefuse()) return;
    if (this.state === 'plant' && this.thinkPlant()) return;
    if (this.state === 'cover' && now < this.coverUntil) { if (this.thinkCover()) return; }
    if (this.target) { this.thinkEngage(); return; }
    this.strafe = 0;
    if (this.lostTarget && now - this.lostTime < 7 && this.thinkLost()) return;
    if (now - this.heardTime < 3 && this.thinkHeard()) return;
    this.thinkObjective();
  }

  thinkEngage() {
    const now = Clock.time;
    const t = this.target;
    this.setState('engage');
    const d = this.pos.distanceTo(t.pos);
    const w = this.curWeapon();
    if (this.slot === 'nade' || this.slot === 'bomb') { this.switchBest(); return; }
    // 弹匣打空
    if (w && w.def.mag && w.mag === 0) {
      if (w.reserve > 0) {
        if (d > 7 && this.findCover(t)) { this.setState('cover'); this.coverUntil = now + 3.2; }
        this.startReload();
      } else if (this.slot === 'primary' && this.inv.secondary && (this.inv.secondary.mag + this.inv.secondary.reserve) > 0) this.switchTo('secondary');
      else this.switchTo('knife');
      return;
    }
    // 血量低时撤到掩体后
    if (this.health < 38 && now - this.tookCoverAt > 8 && d > 6 && chance(0.45) && this.findCover(t)) {
      this.tookCoverAt = now; this.setState('cover'); this.coverUntil = now + rand(2.5, 4);
      return;
    }
    const kind = w ? w.def.kind : 'knife';
    if (kind === 'knife') { this.goTo(t.pos.x, t.pos.z, t.pos.y, 'run', true); this.wantCrouch = false; return; }
    // 用手枪/冲锋枪近距离可以边走边打，步枪/狙击站定射击
    this.path = null;
    if (kind === 'rifle' || kind === 'sniper') {
      this.wantCrouch = d > 15 && this.crouchPref && this.state !== 'defuse';
      if (this.diffKey !== 'easy' && d < 26 && chance(0.25) && now > this.strafeUntil + 0.3) { this.strafe = chance(0.5) ? 1 : -1; this.strafeUntil = now + rand(0.22, 0.45); }
    } else {
      this.wantCrouch = false;
      if (chance(0.5) && now > this.strafeUntil) { this.strafe = chance(0.5) ? 1 : -1; this.strafeUntil = now + rand(0.3, 0.7); }
    }
    if (kind === 'sniper' && d > 5 && !this.scope && now >= this.boltUntil && !this.reloading) { this.scope = 1; this.scopeStart = now; }
    if (kind === 'sniper' && d <= 5 && this.scope) this.scope = 0;
  }

  thinkCover() {
    if (this.atGoal(0.7)) {
      this.wantCrouch = true;
      const w = this.curWeapon();
      if (w && w.def.mag && w.mag < w.def.mag * 0.6) this.startReload();
      if (this.target && this.stateT > 0.8) { this.setState('engage'); return false; }
    }
    return true;
  }

  thinkLost() {
    const now = Clock.time;
    const since = now - this.lostTime;
    this.hasLook = true;
    this.look.copy(this.lostCorner);
    const anchor = (this.team === 'CT' && (this.role === 'A' || this.role === 'B') && Bomb.state !== 'planted');
    // 丢失目标 1~3 秒后可能扔一颗手雷
    if (since > 0.8 && since < 4 && now > this.nadeCD && this.inv.he > 0) {
      const d = this.pos.distanceTo(this.lostPos);
      if (d > 7 && d < 26 && chance(0.35)) { this.throwAt('he', this.lostPos); this.nadeCD = now + 12; return true; }
      this.nadeCD = now + 3;
    }
    if (anchor || this.state === 'hold' || since < rand(1.2, 2.4)) {
      this.path = null;
      this.setState('holdAngle');
      if (since > 5) { this.lostTarget = null; return false; }
      return true;
    }
    if (Bomb.state === 'planted' && this.team === 'CT') { this.lostTarget = null; return false; }
    // 追击：静步摸过去
    this.setState('hunt');
    this.wantCrouch = false;
    if (this.pos.distanceTo(this.lostPos) < 1.5) { this.lostTarget = null; return false; }
    this.goTo(this.lostPos.x, this.lostPos.z, this.lostPos.y, 'walk');
    return true;
  }

  thinkHeard() {
    if (this.heardHandled === this.heardTime) return this.state === 'holdSound';
    this.heardHandled = this.heardTime;
    const d = this.pos.distanceTo(this.heardPos);
    if (d > 40) return false;
    this.computeCorner(this.heardPos, _b5);
    this.hasLook = true;
    this.look.copy(_b5);
    this.setState('holdSound');
    const anchor = this.team === 'CT' && this.spot && this.pos.distanceTo(cellPos(this.spot.p, _b4)) < 2 && Bomb.state !== 'planted';
    if (anchor || this.heardLoud || d > 22 || chance(0.5)) this.path = null;
    else this.goTo(this.heardPos.x, this.heardPos.z, this.heardPos.y, 'walk');
    return true;
  }

  thinkBlind() {
    this.path = null;
    this.target = null;
    this.wantCrouch = chance(0.5);
    // 被闪时朝最后已知位置盲射
    if (this.lostTarget && Clock.time - this.lostTime < 4 && chance(0.3)) {
      this.hasLook = true; this.look.copy(this.lostPos); this.look.y += 1.3;
      this.blindFire = Clock.time + rand(0.2, 0.5);
    }
  }

  thinkDefuse() {
    if (Bomb.state !== 'planted') { this.setState('idle'); this.wantCrouch = false; return false; }
    if (this.target) {
      const remain = Bomb.defuseDur - Bomb.defuseT;
      if (remain > 1.5 && Bomb.timer > remain + 1.5) { Bomb.cancelDefuse(this); this.setState('engage'); this.wantCrouch = false; return false; }
    }
    this.wantCrouch = true;
    this.path = null;
    return true;
  }
  thinkPlant() {
    if (this.target || !this.inv.bomb) { Bomb.cancelPlant(this); this.setState('idle'); return false; }
    this.path = null;
    this.wantCrouch = true;
    return true;
  }

  // ---- 目标任务 ----
  thinkObjective() {
    if (this.team === 'CT') this.objectiveCT(); else this.objectiveT();
  }
  objectiveCT() {
    const now = Clock.time;
    if (Bomb.state === 'planted') { this.retake(); return; }
    if (this.rotateTo && now >= this.rotateAt) {
      this.role = this.rotateTo; this.rotateTo = null;
      this.spot = TeamAI.pickSpot(this, this.role);
      Events.emit('botRotate', this);
    }
    if (this.role === 'aggro' && now > this.aggroUntil) {
      const lane = this.spot && this.spot.lane === 'B' ? 'B' : 'A';
      this.role = lane === 'B' ? 'B' : (this.spot && this.spot.lane === 'mid' ? 'mid' : 'A');
      this.spot = TeamAI.pickSpot(this, this.role);
    }
    this.holdSpot(this.spot);
  }
  holdSpot(sp) {
    if (!sp) return;
    cellPos(sp.p, _b5);
    const d = Math.hypot(_b5.x - this.pos.x, _b5.z - this.pos.z);
    if (d > 0.9) {
      const near = this.nearDanger();
      this.goTo(_b5.x, _b5.z, _b5.y, near ? 'walk' : 'run');
      this.setState('move');
      this.hasLook = false;
      this.wantCrouch = false;
      return;
    }
    this.path = null;
    this.setState('hold');
    this.wantCrouch = !!sp.crouch;
    this.hasLook = true;
    cellPos(sp.look, this.look);
    this.look.y += 1.55;
    // 偶尔小幅调整视角，显得更自然
    if (Clock.time > this.spotShiftT) {
      this.spotShiftT = Clock.time + rand(2, 5);
      this.lookJit = rand(-0.8, 0.8);
    }
    this.look.x += (this.lookJit || 0);
  }
  /** 附近是否可能有敌人（最近听到或看到过） */
  nearDanger() {
    const now = Clock.time;
    if (now - this.heardTime < 6 && this.pos.distanceTo(this.heardPos) < 25) return true;
    if (now - this.lostTime < 10 && this.pos.distanceTo(this.lostPos) < 25) return true;
    return false;
  }
  retake() {
    const bp = Bomb.pos;
    const d = this.pos.distanceTo(bp);
    const defT = this.kit ? CFG.ROUND.DEFUSE_KIT_TIME : CFG.ROUND.DEFUSE_TIME;
    if (Bomb.timer < defT + d / 5.0 * 0.85 + 0.4 && !(Bomb.defuser === this)) {
      // 来不及拆 → 保枪撤退
      this.setState('save');
      const sp = MAP.SPAWNS.CT[0];
      cellPos(sp, _b5);
      this.goTo(_b5.x, _b5.z, _b5.y, 'run');
      this.hasLook = false;
      return;
    }
    // 接近包点时扔闪光弹
    if (d < 16 && d > 7 && this.inv.flash > 0 && Clock.time > this.nadeCD && chance(0.4)) {
      _b4.copy(bp); _b4.y += 2.5;
      this.throwAt('flash', _b4);
      this.nadeCD = Clock.time + 6;
      this.lookAwayUntil = Clock.time + 1.7;
      return;
    }
    if (d > 1.0) {
      this.goTo(bp.x, bp.z, bp.y, 'run');
      this.setState('retake');
      this.hasLook = false;
      this.wantCrouch = false;
      return;
    }
    if (Bomb.defuser && Bomb.defuser !== this && Bomb.defuser.alive) {
      // 队友在拆，帮忙警戒
      this.path = null; this.setState('hold');
      this.hasLook = true;
      this.look.set(this.pos.x - (bp.x - this.pos.x) * 5 + rand(-3, 3), this.pos.y + 1.5, this.pos.z - (bp.z - this.pos.z) * 5 + rand(-3, 3));
      return;
    }
    this.path = null;
    this.setState('defuse');
    Bomb.startDefuse(this);
    this.wantCrouch = true;
  }
  objectiveT() {
    const now = Clock.time;
    if (Bomb.state === 'planted') {
      const post = MAP.SPOTS.T[Bomb.site].post;
      if (!this.postSpot || this.postSite !== Bomb.site) { this.postSpot = pick(post); this.postSite = Bomb.site; }
      this.holdSpot(this.postSpot);
      return;
    }
    // 掉落的炸弹：离得最近的 T Bot 去捡
    const bi = Items.bombItem();
    if (bi && TeamAI.bombFetcher() === this) {
      this.goTo(bi.pos.x, bi.pos.z, bi.pos.y, 'run');
      this.setState('fetch');
      this.hasLook = false;
      this.wantCrouch = false;
      if (Math.hypot(bi.pos.x - this.pos.x, bi.pos.z - this.pos.z) < 1.2) {
        this.inv.bomb = true; Items.remove(bi);
        Events.emit('bombPicked', this);
        Events.emit('radio', { from: this, text: '我拿到炸弹了' });
      }
      return;
    }
    const site = TeamAI.tSite;
    if (!site) { this.setState('wait'); this.path = null; return; }
    // 携带炸弹：直接去包点安放
    if (this.inv.bomb) {
      const s = Bomb.siteAt(this.pos.x, this.pos.z);
      const k = this.lastSeenAny();
      if (s && now - k > 2.0 && this.onGround) {
        this.path = null;
        this.setState('plant');
        Bomb.startPlant(this);
        Events.emit('radio', { from: this, text: `正在 ${s} 点下包，掩护我！` });
        return;
      }
      Bomb.sitePos(site, _b5);
      this.goTo(_b5.x, _b5.z, _b5.y, 'run');
      this.setState('move');
      this.hasLook = false;
      this.wantCrouch = false;
      return;
    }
    // 沿路线推进
    if (!this.route || this.routeSite !== site) {
      this.route = pick(MAP.SPOTS.T[site].routes);
      this.routeSite = site; this.routeI = 0;
    }
    if (this.routeI < this.route.length) {
      cellPos(this.route[this.routeI], _b5);
      if (Math.hypot(_b5.x - this.pos.x, _b5.z - this.pos.z) < 1.5) {
        this.routeI++;
        // 到达进点位置：先往包点上空扔一颗闪光弹再冲
        if (this.routeI === this.route.length && this.inv.flash > 0 && now > this.nadeCD) {
          Bomb.sitePos(site, _b4); _b4.y += 3.5;
          this.throwAt('flash', _b4);
          this.nadeCD = now + 8;
          this.lookAwayUntil = now + 1.7;
          Events.emit('radio', { from: this, text: '闪光弹！' });
        }
        return;
      }
      this.goTo(_b5.x, _b5.z, _b5.y, this.nearDanger() ? 'walk' : 'run');
      this.setState('move');
      this.hasLook = false;
      this.wantCrouch = false;
      return;
    }
    if (!this.postSpot || this.postSite !== site) { this.postSpot = pick(MAP.SPOTS.T[site].post); this.postSite = site; }
    this.holdSpot(this.postSpot);
  }
  lastSeenAny() {
    let t = -99;
    for (const [, k] of this.known) if (k.lastSeen > t) t = k.lastSeen;
    return t;
  }

  /** 找一个威胁看不到的掩体位置 */
  findCover(t) {
    t.eye(_b4);
    let best = null, bestScore = Infinity;
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * TAU, r = rand(1.5, 9);
      const k = Nav.idx(this.pos.x + Math.cos(a) * r, this.pos.z + Math.sin(a) * r);
      if (k < 0 || !Nav.ok[k]) continue;
      const cx = Nav.cx(k), cz = Nav.cz(k), cy = Nav.h[k];
      if (Math.abs(cy - this.pos.y) > 1.3) continue;
      if (World.segClear(_b4.x, _b4.y, _b4.z, cx, cy + 1.2, cz)) continue;
      const dT = Math.hypot(cx - _b4.x, cz - _b4.z);
      if (dT < 5) continue;
      const score = r + Nav.pen[k] * 2 + (dT < 9 ? 4 : 0);
      if (score < bestScore) { bestScore = score; best = k; }
    }
    if (best === null) return false;
    return this.goTo(Nav.cx(best), Nav.cz(best), Nav.h[best], 'run', true);
  }

  /** 朝某点投掷（弹道解算：取较低的抛射角） */
  throwAt(type, p) {
    if (this.inv[type] <= 0) return;
    this.eye(_b1);
    const dx = p.x - _b1.x, dz = p.z - _b1.z, dy = p.y - _b1.y;
    const d = Math.hypot(dx, dz);
    const g = CFG.GRAVITY;
    let v = d > 14 ? CFG.NADE.THROW_SPEED : CFG.NADE.MID_SPEED;
    let disc = v ** 4 - g * (g * d * d + 2 * dy * v * v);
    if (disc < 0) { v = CFG.NADE.THROW_SPEED; disc = Math.max(0, v ** 4 - g * (g * d * d + 2 * dy * v * v)); }
    const pitch = Math.atan((v * v - Math.sqrt(disc)) / (g * d));
    const yaw = yawOf(dx, dz);
    this.switchTo('nade', type);
    this.yaw = yaw;
    Grenades.throwNade(this, type, v, yaw, clamp(pitch, -0.6, 1.2));
  }

  // ==================================================================
  //  瞄准与射击
  // ==================================================================
  updateAim(dt) {
    const now = Clock.time;
    const t = this.target;
    let ty = this.yaw, tp = 0, engaged = false;
    this.eye(_b1);
    const k = t ? this.known.get(t) : null;
    if (t && t.alive && k && k.seenNow) {
      engaged = true;
      if (now > this.headRollT) { this.headAim = chance(this.diff.headChance); this.headRollT = now + rand(0.8, 1.6); }
      if (this.headAim) t.headPos(_b2); else t.chestPos(_b2);
      _b2.x += t.vel.x * 0.06; _b2.z += t.vel.z * 0.06;
      const dx = _b2.x - _b1.x, dy = _b2.y - _b1.y, dz = _b2.z - _b1.z;
      const hd = Math.hypot(dx, dz);
      const decay = Math.exp(-this.diff.errDecay * dt);
      this.errYaw *= decay; this.errPitch *= decay;
      // 目标横向移动、自身移动都会拉大误差
      const lat = Math.abs((t.vel.x * dz - t.vel.z * dx) / Math.max(1, hd));
      this.errYaw += (Math.random() - 0.5) * lat / Math.max(4, hd) * dt * 2.2;
      const selfSp = Math.hypot(this.vel.x, this.vel.z);
      if (selfSp > 1) { this.errYaw += (Math.random() - 0.5) * selfSp * 0.012 * dt * 60 * DEG; this.errPitch += (Math.random() - 0.5) * selfSp * 0.006 * dt * 60 * DEG; }
      this.errT -= dt;
      if (this.errT <= 0) {
        this.errT = rand(0.2, 0.4);
        this.jitY = rand(-1, 1) * this.diff.errMin * DEG;
        this.jitP = rand(-0.6, 0.6) * this.diff.errMin * DEG;
      }
      ty = yawOf(dx, dz) + this.errYaw + this.jitY;
      tp = Math.atan2(dy, hd) + this.errPitch + this.jitP;
    } else if (now < this.lookAwayUntil) {
      ty = this.yaw; tp = -0.5;
      if (!this._awaySet) { this._awayYaw = this.yaw + Math.PI * 0.85; this._awaySet = true; }
      ty = this._awayYaw;
    } else if (this.hasLook) {
      this._awaySet = false;
      const dx = this.look.x - _b1.x, dy = this.look.y - _b1.y, dz = this.look.z - _b1.z;
      ty = yawOf(dx, dz); tp = Math.atan2(dy, Math.hypot(dx, dz));
    } else if (this.path && this.pathI < this.path.length) {
      // 移动中预瞄：看向下一个拐角之后的路段（敌人最可能出现的方向）
      this._awaySet = false;
      const wp = this.path[this.pathI];
      let dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
      const near = dx * dx + dz * dz < 36;
      if (near && this.pathI + 1 < this.path.length) {
        const nx = this.path[this.pathI + 1];
        dx = nx.x - this.pos.x; dz = nx.z - this.pos.z;
        tp = Math.atan2(nx.y + 1.5 - _b1.y, Math.hypot(dx, dz));
      } else tp = Math.atan2(wp.y + 1.5 - _b1.y, Math.max(1, Math.hypot(dx, dz)));
      if (dx * dx + dz * dz > 0.04) ty = yawOf(dx, dz);
      tp = clamp(tp, -0.4, 0.4);
    }
    const maxStep = this.diff.turnSpeed * DEG * dt * (engaged ? 1 : 0.6);
    const gain = 1 - Math.exp(-(engaged ? 13 : 7) * dt);
    const ey = wrapAngle(ty - this.yaw), ep = tp - this.pitch;
    this.yaw = wrapAngle(this.yaw + clamp(ey * gain, -maxStep, maxStep));
    this.pitch = clamp(this.pitch + clamp(ep * gain, -maxStep, maxStep), -1.3, 1.3);
  }

  updateCombat(dt) {
    const now = Clock.time;
    // 被闪时盲射
    if (this.blindFire && now < this.blindFire && this.canAttack()) {
      const w = this.curWeapon();
      if (w && w.def.mag && w.mag > 0) this.fireWeapon(this.yaw, this.pitch, this.diff.spray * 0.5);
      return;
    }
    const t = this.target;
    if (!t || !t.alive) return;
    const k = this.known.get(t);
    if (!k || !k.seenNow || !this.canAttack() || now < this.burstPauseUntil) return;
    if (this.slot === 'nade' || this.slot === 'bomb') return;
    const w = this.curWeapon();
    if (!w) return;
    this.eye(_b1);
    if (this.headAim) t.headPos(_b2); else t.chestPos(_b2);
    const dx = _b2.x - _b1.x, dy = _b2.y - _b1.y, dz = _b2.z - _b1.z;
    const hd = Math.hypot(dx, dz), dist = Math.hypot(hd, dy);
    const offY = wrapAngle(yawOf(dx, dz) - this.yaw), offP = Math.atan2(dy, hd) - this.pitch;
    const off = Math.hypot(offY, offP);
    const tol = Math.atan2(0.26, dist) + 0.45 * DEG;
    const kind = w.def.kind;
    if (kind === 'knife') { if (dist < 1.9 && off < 0.5) this.knifeAttack(chance(0.3)); return; }
    if (off > tol * 1.8) return;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if ((kind === 'rifle' || kind === 'sniper') && speed > this.maxSpeed() * 0.36) return;
    if (kind === 'sniper' && dist > 5 && (!this.scope || now - this.scopeStart < 0.32)) return;
    const res = this.fireWeapon(this.yaw, this.pitch, this.diff.spray);
    if (res === 'fired') {
      this.burst++;
      if (!w.def.auto) { this.burstPauseUntil = now + rand(0.1, 0.28) + dist * 0.006; this.burst = 0; }
      else {
        // 远距离点射、中距离短连发、近距离扫射（冲锋枪连发更长）
        const smg = kind === 'smg';
        const bk = this.diff.burst;
        const maxBurst = dist > 28 ? randInt(1, 3) : dist > 14 ? Math.round(randInt(2, 4) * bk) + (smg ? 2 : 0) : Math.round(randInt(6, 10) * bk) + (smg ? 6 : 0);
        if (this.burst >= maxBurst) { this.burst = 0; this.burstPauseUntil = now + rand(0.28, 0.5) / bk; }
      }
    } else if (res === 'empty') this.startReload();
  }

  // ==================================================================
  //  移动
  // ==================================================================
  goTo(x, z, y = null, mode = 'run', force = false) {
    this.moveMode = mode;
    if (!force && this.path && this.goal.distanceTo(_b4.set(x, this.goal.y, z)) < 0.8 && this.pathI < this.path.length) return true;
    const path = Nav.findPath(this.pos.x, this.pos.z, x, z, this.pos.y, y);
    this.goal.set(x, y === null ? 0 : y, z);
    this.path = path;
    this.pathI = 0;
    this.stuck = 0;
    return !!path;
  }
  atGoal(r = 0.6) {
    return !this.path || this.pathI >= this.path.length || Math.hypot(this.goal.x - this.pos.x, this.goal.z - this.pos.z) < r;
  }

  updateMove(dt, frozen) {
    const P = CFG.PLAYER;
    const now = Clock.time;
    let wx = 0, wz = 0;
    const busy = this.state === 'defuse' || this.state === 'plant';
    if (!frozen && !busy && Round.state !== 'end') {
      if (this.path) {
        while (this.pathI < this.path.length) {
          const wp = this.path[this.pathI];
          const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z;
          const d = Math.hypot(dx, dz);
          const last = this.pathI === this.path.length - 1;
          if (d < (last ? 0.3 : 0.55)) { this.pathI++; continue; }
          wx = dx / d; wz = dz / d;
          break;
        }
        if (this.pathI >= this.path.length) this.path = null;
      }
      // 交战横移
      if (this.strafe && now < this.strafeUntil && this.target) {
        const dx = this.target.pos.x - this.pos.x, dz = this.target.pos.z - this.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        wx += -dz / d * this.strafe; wz += dx / d * this.strafe;
      } else if (this.strafe && now >= this.strafeUntil) this.strafe = 0;
      // 脱困：向侧面挪一步
      if (now < this.unstickUntil && wx * wx + wz * wz > 0) {
        const l = Math.hypot(wx, wz), ux = wx / l, uz = wz / l, s = this.unstickDir;
        wx = ux * 0.3 - uz * s; wz = uz * 0.3 + ux * s;
      }
      // 与队友保持距离
      for (const o of Combat.chars) {
        if (o === this || !o.alive || o.team !== this.team) continue;
        const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < 1.0 && d2 > 1e-4) { const d = Math.sqrt(d2); wx += dx / d * 0.6; wz += dz / d * 0.6; }
      }
    }
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-4) { wx /= wl; wz /= wl; }
    this.walking = this.moveMode === 'walk' && !this.target;
    this.setCrouch(this.wantCrouch || busy);
    this.crouch = damp(this.crouch, this.crouching ? 1 : 0, 10, dt);
    let ws = wl > 1e-4 ? this.maxSpeed() : 0;
    // 接近终点时减速，避免滑过目标点
    if (this.path && this.pathI === this.path.length - 1 && !this.strafe) {
      const wp = this.path[this.pathI];
      ws = Math.min(ws, Math.max(1.2, Math.hypot(wp.x - this.pos.x, wp.z - this.pos.z) * 3.2));
    }
    if (this.walking) ws *= P.WALK_MULT;
    if (this.crouching) ws *= P.CROUCH_MULT;
    if (this.onGround) {
      const sp = Math.hypot(this.vel.x, this.vel.z);
      if (sp > 0) {
        const drop = Math.max(sp, P.STOP_SPEED) * P.FRICTION * dt;
        const ns = Math.max(0, sp - drop) / sp;
        this.vel.x *= ns; this.vel.z *= ns;
      }
      // 急停：交战时没有移动意图则反向加速（相当于按反方向键）
      if (ws === 0 && this.target && sp > 0.6) {
        const s2 = Math.hypot(this.vel.x, this.vel.z);
        const dec = Math.min(s2, P.ACCEL * this.maxSpeed() * dt);
        if (s2 > 0) { this.vel.x -= this.vel.x / s2 * dec; this.vel.z -= this.vel.z / s2 * dec; }
      }
      if (ws > 0) {
        const cur = this.vel.x * wx + this.vel.z * wz;
        const add = ws - cur;
        if (add > 0) { const acc = Math.min(add, P.ACCEL * this.maxSpeed() * dt); this.vel.x += acc * wx; this.vel.z += acc * wz; }
      }
    }
    Physics.moveBody(this, dt);
    // 卡住检测：一段时间没有进展就重新寻路，仍然卡住则跳一下
    this.progT += dt;
    if (this.progT > 0.6) {
      const moved = Math.hypot(this.pos.x - this.progPos.x, this.pos.z - this.progPos.z);
      if (this.path && moved < 0.2) {
        this.stuck++;
        if (this.stuck === 1) { this.unstickDir = chance(0.5) ? 1 : -1; this.unstickUntil = now + 0.45; }
        else if (this.stuck === 2) this.goTo(this.goal.x, this.goal.z, this.goal.y, this.moveMode, true);
        else if (this.stuck >= 3 && this.onGround) { this.vel.y = P.JUMP_VEL; this.jumped = true; this.vel.x += rand(-2, 2); this.vel.z += rand(-2, 2); this.stuck = 0; }
      } else this.stuck = 0;
      this.progPos.copy(this.pos);
      this.progT = 0;
    }
    // 脚步声
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hs > 3.2 && !this.walking && !this.crouching) {
      this.stepAcc += hs * dt;
      if (this.stepAcc > 1.9) {
        this.stepAcc = 0;
        const L = SFX.listenerPos;
        if (L.distanceTo(this.pos) < 30) {
          const occ = !World.segClear(L.x, L.y, L.z, this.pos.x, this.pos.y + 0.4, this.pos.z);
          SFX.footstep(this.pos, Physics.surfaceOf(this), 1, occ);
        }
        Events.emit('noise', { ch: this, x: this.pos.x, y: this.pos.y, z: this.pos.z, r: 17, step: true });
      }
    }
    if (this.landSpeed < -4) SFX.land(this.pos, false, Physics.surfaceOf(this));
  }
}

// =====================================================================
//  团队 AI：CT 阵型分配 / 信息与轮转，T 队友的进攻选择
// =====================================================================
const TeamAI = {
  setups: [
    { A: 2, B: 2, mid: 1 },
    { A: 2, B: 2, aggro: 1 },
    { A: 3, B: 1, mid: 1 },
    { A: 1, B: 3, mid: 1 },
    { A: 2, B: 1, mid: 1, aggro: 1 },
  ],
  lastAlert: {},
  tSite: null, tDecideAt: 0,

  bots(team) { return Combat.chars.filter(c => c.isBot && c.alive && c.team === team); },

  newRound() {
    this.fetcher = null;
    this.lastAlert = {};
    const now = Clock.time;
    const cts = shuffle(this.bots('CT'));
    const setup = pick(this.setups);
    const roles = [];
    for (const r of ['A', 'B', 'mid', 'aggro']) for (let i = 0; i < (setup[r] || 0); i++) roles.push(r);
    while (roles.length < cts.length) roles.push(pick(['A', 'B']));
    cts.forEach((b, i) => {
      b.role = roles[i];
      b.spot = null;
    });
    for (const b of cts) {
      b.spot = this.pickSpot(b, b.role);
      if (b.role === 'aggro') b.aggroUntil = now + CFG.ROUND.FREEZE_TIME + rand(18, 32);
    }
    this.tSite = null;
    this.tDecideAt = now + CFG.ROUND.FREEZE_TIME + rand(7, 12);
  },

  /** 为 Bot 挑选一个该区域内未被占用的据点 */
  pickSpot(bot, role) {
    const list = MAP.SPOTS.CT[role] || MAP.SPOTS.CT.A;
    const used = new Set(this.bots(bot.team).filter(b => b !== bot && b.spot).map(b => b.spot));
    const free = list.filter(s => !used.has(s));
    return pick(free.length ? free : list);
  },

  /** CT 发现敌人/队友阵亡时通报，其他 Bot 可能轮转支援 */
  alert(lane, strength) {
    if (lane !== 'A' && lane !== 'B' && lane !== 'mid') return;
    const now = Clock.time;
    if ((this.lastAlert[lane] || -99) > now - 5) return;
    this.lastAlert[lane] = now;
    for (const b of this.bots('CT')) {
      if (b.role === lane || b.target || Bomb.state === 'planted') continue;
      let p = b.role === 'mid' ? 0.7 : b.role === 'aggro' ? 0.35 : 0.3 * strength;
      if (lane === 'mid') p *= 0.5;
      if (chance(p)) { b.rotateTo = lane === 'mid' ? 'mid' : lane; b.rotateAt = now + rand(0.8, 2.6); }
    }
  },

  update() {
    const now = Clock.time;
    if (!this.tSite && now >= this.tDecideAt && Round.state === 'live') {
      // 跟随真人 T 玩家的进攻方向（多个玩家时取第一个在 A/B 路线上的）
      let site = null;
      for (const h of Combat.chars) {
        if (!h.isHuman || !h.alive || h.team !== 'T') continue;
        const l = laneAt(h.pos.x, h.pos.z);
        if (l === 'A' || l === 'B') { site = l; break; }
      }
      this.tSite = site || pick(['A', 'B']);
      if (this.bots('T').length) Events.emit('radio', { from: this.bots('T')[0], text: `我们去 ${this.tSite} 点！` });
    }
  },

  /** 地上的炸弹应由哪个 T Bot 去捡（玩家存活且离得近时交给玩家） */
  fetcher: null,
  bombFetcher() {
    const bi = Items.bombItem();
    if (!bi) { this.fetcher = null; return null; }
    for (const h of Combat.chars) if (h.isHuman && h.alive && h.team === 'T' && h.pos.distanceTo(bi.pos) < 25) return null;
    let best = null, bd = Infinity;
    for (const b of this.bots('T')) { if (!b.alive) continue; const d = b.pos.distanceTo(bi.pos); if (d < bd) { bd = d; best = b; } }
    // 已指派的人继续去捡，除非别人明显更近：否则两个距离相近的 Bot 会随着走位来回交换任务、原地打转
    const cur = this.fetcher;
    if (best && cur && cur !== best && cur.alive && cur.team === 'T' && cur.pos.distanceTo(bi.pos) - bd < 6) best = cur;
    this.fetcher = best;
    return best;
  },
};

// ---- Bot 的听觉：订阅噪声与枪声（联机客户端上没有 Bot，不处理） ----
Events.on('noise', (e) => {
  if (NET.mode === 'client') return;
  for (const b of Combat.chars) {
    if (!b.isBot || !b.alive || !e.ch || b.team === e.ch.team) continue;
    const d = Math.hypot(b.pos.x - e.x, b.pos.z - e.z);
    if (d < e.r * b.diff.hearing) b.hear(e.x, e.y, e.z, !!e.boom);
  }
});
Events.on('shot', (e) => {
  if (NET.mode === 'client') return;
  const s = e.ch;
  for (const b of Combat.chars) {
    if (!b.isBot || !b.alive || b.team === s.team) continue;
    const d = b.pos.distanceTo(s.pos);
    if (d < 55 * b.diff.hearing) b.hear(s.pos.x, s.pos.y, s.pos.z, true);
  }
});
Events.on('damage', (e) => { if (NET.mode !== 'client' && e.victim.isBot && e.victim.alive) e.victim.onDamaged(e); });
Events.on('kill', (e) => {
  if (NET.mode === 'client') return;
  const v = e.victim;
  if (v.team === 'CT' && v.isBot) TeamAI.alert(laneAt(v.pos.x, v.pos.z), 2);
});
Events.on('bombPlanted', () => {
  if (NET.mode === 'client') return;
  for (const b of Combat.chars) if (b.isBot && b.alive) { b.lostTarget = null; b.rotateTo = null; if (b.state === 'hold' || b.state === 'holdSound') b.setState('idle'); }
});
