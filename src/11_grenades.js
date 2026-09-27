// =====================================================================
//  11 投掷物模块：高爆手雷 / 闪光弹 / 烟雾弹
//  - 固定步长（1/120 秒）弹道模拟：重力 + 墙面/地面反弹 + 摩擦
//  - 轨迹预览与真实飞行使用同一套模拟，所见即所得
//  - 左键远投、右键近抛、左右键同时 = 中距离
// =====================================================================

const NADE_STEP = 1 / 120;

const Grenades = {
  list: [],
  nextId: 1,
  cid: 0,
  init(scene) {
    this.scene = scene;
    if (!scene) return;     // 服务器：只有逻辑，没有网格
    // 轨迹预览线
    const N = 160;
    this.prevPos = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    this.prevAttr = new THREE.BufferAttribute(this.prevPos, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.prevAttr);
    g.setDrawRange(0, 0);
    this.preview = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.75, depthWrite: false }));
    this.preview.frustumCulled = false;
    this.preview.renderOrder = 5;
    scene.add(this.preview);
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 24), new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    this.marker.visible = false;
    this.marker.renderOrder = 5;
    scene.add(this.marker);
    this.previewN = N;
  },

  clear() {
    for (const g of this.list) if (g.mesh) this.scene.remove(g.mesh);
    this.list.length = 0;
    this.hidePreview();
  },
  hidePreview() { if (!this.preview) return; this.preview.geometry.setDrawRange(0, 0); this.marker.visible = false; },

  /** 计算投掷初始位置和速度 */
  launch(ch, speed, yaw, pitch, outP, outV) {
    ch.eye(outP);
    dirFromAngles(yaw, pitch, outV);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    outP.x += outV.x * 0.25 + rx * 0.06; outP.y += outV.y * 0.25 - 0.05; outP.z += outV.z * 0.25 + rz * 0.06;
    outV.multiplyScalar(speed);
    outV.x += ch.vel.x * 0.9; outV.z += ch.vel.z * 0.9; outV.y += Math.max(0, ch.vel.y) * 0.5;
  },
  /** CS 的做法：平视时出手角度略微上抬 */
  throwPitch(pitch) { return pitch + 8 * DEG * (1 - Math.abs(pitch) / (Math.PI / 2)); },

  /**
   * 单步物理：返回 true 表示发生了碰撞（用于播放弹跳音效）
   * g 需要 { p, v, resting }
   */
  step(g, dt, hit) {
    if (g.resting) return false;
    const N = CFG.NADE, R = N.RADIUS;
    g.v.y -= CFG.GRAVITY * dt;
    let remaining = dt, bounced = false;
    for (let iter = 0; iter < 3 && remaining > 1e-6; iter++) {
      const sp = g.v.length();
      if (sp < 1e-5) break;
      const dx = g.v.x / sp, dy = g.v.y / sp, dz = g.v.z / sp;
      const dist = sp * remaining;
      if (World.raycast(g.p.x, g.p.y, g.p.z, dx, dy, dz, dist + R, hit)) {
        const travel = Math.max(0, hit.t - R);
        g.p.x += dx * travel; g.p.y += dy * travel; g.p.z += dz * travel;
        remaining -= travel / sp;
        const nx = hit.nx, ny = hit.ny, nz = hit.nz;
        const vn = g.v.x * nx + g.v.y * ny + g.v.z * nz;
        if (vn < 0) {
          // 反射：法向速度按反弹系数反向，切向速度乘摩擦
          const tx = g.v.x - vn * nx, ty = g.v.y - vn * ny, tz = g.v.z - vn * nz;
          g.v.set(tx * N.FRICTION - vn * nx * N.BOUNCE, ty * N.FRICTION - vn * ny * N.BOUNCE, tz * N.FRICTION - vn * nz * N.BOUNCE);
          if (-vn > 1.2) { bounced = true; g.lastImpact = -vn; }
        }
        if (ny > 0.7 && g.v.length() < 0.9) { g.v.set(0, 0, 0); g.resting = true; break; }
        if (travel < 1e-4 && iter === 2) break;
      } else {
        g.p.x += dx * dist; g.p.y += dy * dist; g.p.z += dz * dist;
        remaining = 0;
      }
    }
    if (g.p.y < 0.02) { g.p.y = 0.02; if (g.v.y < 0) g.v.y = -g.v.y * N.BOUNCE; }
    return bounced;
  },

  _sim: { p: new THREE.Vector3(), v: new THREE.Vector3(), resting: false },
  _hit: { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, box: null },
  /** 预测投掷轨迹，把采样点写入 out（Float32Array），返回点数 */
  simulate(p0, v0, maxT, out, maxPts) {
    const s = this._sim;
    s.p.copy(p0); s.v.copy(v0); s.resting = false;
    let n = 0, t = 0, k = 0;
    const put = () => { if (n < maxPts) { out[n * 3] = s.p.x; out[n * 3 + 1] = s.p.y; out[n * 3 + 2] = s.p.z; n++; } };
    put();
    while (t < maxT && !s.resting) {
      this.step(s, NADE_STEP, this._hit);
      t += NADE_STEP;
      if (++k % 3 === 0) put();
    }
    put();
    return n;
  },

  /** 玩家操作：按住拔销，松开投出 */
  control(ch, L, R, dt) {
    const N = CFG.NADE;
    if (!ch.nadeCharging) {
      this.hidePreview();
      if ((L || R) && ch.canAttack() && ch.inv[ch.nadeType] > 0) {
        ch.nadeCharging = true; ch.nadeL = L; ch.nadeR = R;
        ViewModel.pin(); SFX.pinPull();
      }
      return;
    }
    ch.nadeL = ch.nadeL || L; ch.nadeR = ch.nadeR || R;
    const speed = ch.nadeL && ch.nadeR ? N.MID_SPEED : ch.nadeR ? N.LOB_SPEED : N.THROW_SPEED;
    if (L || R) {
      // 轨迹预览
      if (SETTINGS.trajectory) {
        this.launch(ch, speed, ch.yaw, this.throwPitch(ch.pitch), _v1, _v2);
        const maxT = ch.nadeType === 'smoke' ? 3 : ch.nadeType === 'he' ? N.HE_FUSE : N.FLASH_FUSE;
        const n = this.simulate(_v1, _v2, maxT, this.prevPos, this.previewN);
        this.prevAttr.needsUpdate = true;
        this.preview.geometry.setDrawRange(1, n - 1);
        this.marker.position.copy(this._sim.p).y += 0.03;
        this.marker.rotation.x = -Math.PI / 2;
        this.marker.visible = true;
      }
      return;
    }
    // 松开：投出
    this.hidePreview();
    this.throwNade(ch, ch.nadeType, speed, ch.yaw, this.throwPitch(ch.pitch));
    ch.nadeCharging = false;
    ViewModel.throwAnim();
  },

  /** 生成一枚飞行中的投掷物。vis=true 表示仅用于显示（联机客户端），爆炸以服务器为准 */
  spawn(owner, type, p, v, vis = false, id = 0) {
    let mesh = null;
    if (this.scene) {
      mesh = GunModels.makeWorldMesh(type);
      mesh.scale.setScalar(1.4);
      mesh.castShadow = false;
      mesh.position.copy(p);
      this.scene.add(mesh);
    }
    const g = { id: id || this.nextId++, type, owner, p, v, t: 0, acc: 0, resting: false, restT: 0, mesh, vis,
      spin: new THREE.Vector3(rand(-12, 12), rand(-12, 12), rand(-12, 12)), lastImpact: 0 };
    this.list.push(g);
    return g;
  },

  /** 投出一枚投掷物（玩家与 Bot 共用） */
  throwNade(ch, type, speed, yaw, pitch) {
    if (ch.inv[type] <= 0) return null;
    ch.inv[type]--;
    const p = new THREE.Vector3(), v = new THREE.Vector3();
    this.launch(ch, speed, yaw, pitch, p, v);
    let g;
    if (NET.mode === 'client' && ch.isPlayer) {
      // 联机：本地立即显示，同时告诉服务器（服务器用相同的初速度模拟真实的那一枚）
      g = this.spawn(ch, type, p, v, true);
      g.cid = ++this.cid;
      NetClient.notePendingNade(type);
      NetClient.send({ t: 'nade', ty: type, p: [p.x, p.y, p.z], v: [v.x, v.y, v.z], cid: g.cid });
    } else {
      g = this.spawn(ch, type, p, v);
      Events.emit('nadeThrown', g);
    }
    SFX.throwNade(ch.isPlayer ? null : ch.pos);
    ch.nextAttack = Clock.time + 0.6;
    // 投完后切换：玩家等出手动画结束（按游戏时间），Bot 立即切换
    if (ch.isPlayer) { ch.afterThrowAt = Clock.time + 0.38; ch.afterThrowType = type; }
    else this.afterThrow(ch, type);
    return g;
  },
  /** 客户端：服务器广播的投掷（自己投的则把本地那枚与服务器编号关联） */
  netThrow(m, owner, isMine) {
    if (isMine) {
      const g = this.list.find(x => x.vis && x.cid === m.cid && !x.linked);
      if (g) { g.id = m.id; g.linked = true; return; }
    }
    this.spawn(owner, m.ty, new THREE.Vector3(m.p[0], m.p[1], m.p[2]), new THREE.Vector3(m.v[0], m.v[1], m.v[2]), true, m.id);
  },
  /** 客户端：服务器宣布投掷物爆开 */
  netBoom(m) {
    const i = this.list.findIndex(g => g.id === m.id);
    if (i >= 0) { const g = this.list[i]; if (g.mesh) this.scene.remove(g.mesh); this.list.splice(i, 1); }
    this.effects(m.ty, _v1.set(m.p[0], m.p[1], m.p[2]));
  },
  /** 服务器：客户端请求投掷（校验背包与出手位置） */
  serverThrow(ch, type, pa, va, cid) {
    if (!ch.alive || !NADES[type] || ch.inv[type] <= 0) return null;
    const p = new THREE.Vector3(pa[0], pa[1], pa[2]), v = new THREE.Vector3(va[0], va[1], va[2]);
    ch.eye(_v1);
    if (p.distanceTo(_v1) > 2.5) p.copy(_v1);
    if (v.length() > 26) v.setLength(26);
    ch.inv[type]--;
    const g = this.spawn(ch, type, p, v);
    g.cid = cid;
    Events.emit('nadeThrown', g);
    return g;
  },

  /** 同类还有则继续拿着，否则换别的投掷物/最好的武器 */
  afterThrow(ch, type) {
    ch.afterThrowAt = 0;
    if (!ch.alive) return;
    if (ch.inv[type] > 0) { ch.slot = ''; ch.switchTo('nade', type); }
    else if (ch.hasNades()) { ch.slot = ''; ch.switchTo('nade'); }
    else ch.switchBest();
  },

  update(dt) {
    const N = CFG.NADE;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const g = this.list[i];
      g.t += dt;
      g.acc += dt;
      while (g.acc >= NADE_STEP) {
        g.acc -= NADE_STEP;
        if (this.step(g, NADE_STEP, this._hit)) {
          SFX.bounce(g.p, g.lastImpact);
          if (!g.vis) Events.emit('noise', { ch: g.owner, x: g.p.x, y: g.p.y, z: g.p.z, r: 10, nade: true });
        }
      }
      if (g.resting) g.restT += dt;
      if (g.mesh) {
        g.mesh.position.copy(g.p);
        if (!g.resting) { g.mesh.rotation.x += g.spin.x * dt; g.mesh.rotation.y += g.spin.y * dt; g.mesh.rotation.z += g.spin.z * dt; }
      }
      // 仅显示用的投掷物：等服务器的爆炸消息（超时兜底移除）
      if (g.vis) {
        if (g.t > 6) { if (g.mesh) this.scene.remove(g.mesh); this.list.splice(i, 1); }
        continue;
      }
      let boom = false;
      if (g.type === 'he' && g.t >= N.HE_FUSE) boom = true;
      else if (g.type === 'flash' && g.t >= N.FLASH_FUSE) boom = true;
      else if (g.type === 'smoke' && ((g.resting && g.restT > 0.25 && g.t > 1.0) || g.t > 3.5)) boom = true;
      if (boom) {
        this.detonate(g);
        if (g.mesh) this.scene.remove(g.mesh);
        this.list.splice(i, 1);
      }
    }
  },

  /** 爆开时的视觉与声音（服务器上为空操作） */
  effects(type, p) {
    if (IS_SERVER) return;
    if (type === 'he') {
      FX.explosion(p.x, p.y, p.z, false);
      SFX.explosion(p, false);
      const P = Game.player;
      if (P) { const d = P.pos.distanceTo(p); FX.shake = Math.max(FX.shake, clamp(1.2 - d / 14, 0, 1)); }
    } else if (type === 'flash') {
      FX.flashbang(p.x, p.y, p.z);
      SFX.flashPop(p);
    } else {
      if (NET.mode === 'client') FX.spawnSmoke(p.x, p.y, p.z);
      SFX.smokePop(p);
    }
  },

  detonate(g) {
    const N = CFG.NADE;
    const p = g.p;
    this.effects(g.type, p);
    Events.emit('nadeBoom', g);
    if (g.type === 'he') {
      Combat.radiusDamage(p.x, p.y, p.z, N.HE_RADIUS, N.HE_DAMAGE, g.owner, 'he');
      Events.emit('noise', { ch: g.owner, x: p.x, y: p.y, z: p.z, r: 45, boom: true });
    } else if (g.type === 'flash') {
      for (const ch of Combat.chars) {
        if (!ch.alive) continue;
        ch.eye(_v3);
        const dist = _v3.distanceTo(p);
        if (dist > 32) continue;
        if (!World.segClear(p.x, p.y + 0.05, p.z, _v3.x, _v3.y, _v3.z)) continue;
        if (FX.smokeBlocks(p.x, p.y, p.z, _v3.x, _v3.y, _v3.z)) continue;
        dirFromAngles(ch.yaw, ch.pitch, _v4);
        const dx = (p.x - _v3.x) / dist, dy = (p.y - _v3.y) / dist, dz = (p.z - _v3.z) / dist;
        const dot = _v4.x * dx + _v4.y * dy + _v4.z * dz;
        const angK = dot > 0.5 ? 1 : dot > -0.1 ? 0.55 : 0.18;
        const distK = clamp(1 - (dist - 4) / 28, 0.3, 1);
        const amt = angK * distK;
        if (amt < 0.15) continue;
        this.blind(ch, N.FLASH_TIME * amt, amt, g.owner);
      }
      Events.emit('noise', { ch: g.owner, x: p.x, y: p.y, z: p.z, r: 35, boom: true });
    } else {
      FX.spawnSmoke(p.x, p.y, p.z);
      Events.emit('smoke', { x: p.x, z: p.z });
    }
  },

  blind(ch, dur, amt, by) {
    const t = Clock.time;
    const remaining = Math.max(0, ch.flashUntil - t);
    if (dur < remaining) return;
    ch.flashUntil = t + dur;
    ch.flashDur = dur;
    ch.flashAmt = amt;
    ch.flashedBy = by;
    Events.emit('flashed', { ch, dur, amt, by });
  },
};
