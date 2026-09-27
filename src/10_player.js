// =====================================================================
//  10 玩家模块：第一人称控制
//  - Source 风格移动：地面摩擦 + 加速度（可急停），空中少量转向
//  - 鼠标视角（灵敏度按 CS 习惯：每像素 sens×0.022°），开镜自动降低灵敏度
//  - 后坐力视角抖动、受击视角抖动、爆炸震屏、上台阶镜头平滑
//  - 武器操作、投掷物、安放炸弹、拾取/丢弃、脚步声（静步/蹲走无声）
//  - 死亡后观战
// =====================================================================

class Player extends Character {
  constructor() {
    super('T', '你');
    this.isPlayer = true;
    this.isHuman = true;
    this.defusing = false;
    this.netUse = false;
    this.stepOffset = 0;
    this.kickP = 0; this.kickY = 0;
    this.hurtP = 0; this.hurtY = 0;
    this.mouseDX = 0; this.mouseDY = 0;
    this.sunlit = 1; this._sunT = 0;
    this.nadeCharging = false;
    this.trigFresh = -1;
    this.planting = false;
    this.hint = '';
    this.deathTime = 0;
    this.killer = null;
    this.specTarget = null;
    this.reloadSnd = 0;
  }

  onSwitch() {
    if (!this.alive) return;
    const w = this.curWeapon();
    ViewModel.equip(this.heldId(), this.team, w ? (w.def.draw || 0.8) : 0.5);
    SFX.deploy();
  }
  onReload(dur) {
    ViewModel.startReload(dur);
    this.reloadSnd = 0;
  }

  // ------------------------------------------------------------------
  update(dt) {
    if (!this.alive) { this.updateDead(dt); return; }
    const I = Input;
    const frozen = Round.isFrozen();
    const ui = UI.blocking();
    // ---- 鼠标视角 ----
    const w = this.curWeapon();
    let zoomMul = 1;
    if (this.scope && w && w.def.zoom) zoomMul = (w.def.zoom[this.scope - 1] / SETTINGS.fov) * SETTINGS.zoomSens;
    const sens = SETTINGS.sens * 0.022 * DEG * zoomMul;
    const mdx = ui ? 0 : I.mouseDX, mdy = ui ? 0 : I.mouseDY;
    this.yaw = wrapAngle(this.yaw - mdx * sens);
    this.pitch = clamp(this.pitch - mdy * sens * (SETTINGS.invertY ? -1 : 1), -89 * DEG, 89 * DEG);
    this.mouseDX = mdx; this.mouseDY = mdy;

    // ---- 下蹲 / 静步 ----
    const key = (c) => !ui && I.down(c);
    this.setCrouch(key('KeyC') || key('ControlLeft') || key('ControlRight'));
    this.crouch = damp(this.crouch, this.crouching ? 1 : 0, this.crouching ? 13 : 11, dt);
    this.walking = key('ShiftLeft') || key('ShiftRight');

    // ---- 移动 ----
    const P = CFG.PLAYER;
    let fwd = 0, side = 0;
    const canMove = !frozen && !this.planting && !this.defusing;
    if (canMove) {
      if (key('KeyW')) fwd += 1;
      if (key('KeyS')) fwd -= 1;
      if (key('KeyD')) side += 1;
      if (key('KeyA')) side -= 1;
    }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let wx = -sy * fwd + cy * side, wz = -cy * fwd - sy * side;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }
    let wishSpeed = wl > 0 ? this.maxSpeed() : 0;
    if (this.walking) wishSpeed *= P.WALK_MULT;
    if (this.crouching && this.onGround) wishSpeed *= P.CROUCH_MULT;
    if (this.onGround) {
      const speed = Math.hypot(this.vel.x, this.vel.z);
      if (speed > 0) {
        const control = Math.max(speed, P.STOP_SPEED);
        const drop = control * P.FRICTION * dt * (this.planting || this.defusing || frozen ? 3 : 1);
        const ns = Math.max(0, speed - drop) / speed;
        this.vel.x *= ns; this.vel.z *= ns;
      }
      // 加速度按武器满速计算（同 CS:GO 的 sv_accelerate_use_weapon_speed），否则蹲走/静步会被摩擦力卡住
      this.accelerate(wx, wz, wishSpeed, this.maxSpeed(), P.ACCEL, dt);
    } else {
      this.accelerate(wx, wz, Math.min(wishSpeed, P.AIR_CAP), wishSpeed, P.AIR_ACCEL, dt);
    }
    // 跳跃
    if (canMove && !ui && I.pressed('Space') && this.onGround) {
      this.vel.y = P.JUMP_VEL;
      this.onGround = false;
      this.jumped = true;
    }
    Physics.moveBody(this, dt);
    // 落地
    if (this.landSpeed < -3.5) {
      SFX.land(null, this.landSpeed < -8, Physics.surfaceOf(this));
      ViewModel.land = Math.min(0.05, -this.landSpeed * 0.004);
      if (!this.walking) Events.emit('noise', { ch: this, x: this.pos.x, y: this.pos.y, z: this.pos.z, r: 14 });
    }
    if (this.stepUp > 0) this.stepOffset -= this.stepUp;
    this.stepOffset = damp(this.stepOffset, 0, 14, dt);
    // 脚步声（跑动才有，静步/蹲走无声）
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hs > 3.2 && !this.walking && !this.crouching) {
      this.stepAcc += hs * dt;
      if (this.stepAcc > 1.9) {
        this.stepAcc = 0;
        SFX.footstep(null, Physics.surfaceOf(this), 1);
        Events.emit('noise', { ch: this, x: this.pos.x, y: this.pos.y, z: this.pos.z, r: 17, step: true });
      }
    } else this.stepAcc = Math.min(this.stepAcc, 1.2);

    // ---- 武器 ----
    this.updateWeaponState(dt);
    this.reloadSounds();
    this.handleWeapons(dt, I, ui || frozen && !this.canUseInFreeze());
    this.handleUse(dt, I, ui);

    // ---- 视觉反馈衰减 ----
    this.kickP = damp(this.kickP, 0, 11, dt);
    this.kickY = damp(this.kickY, 0, 11, dt);
    this.hurtP = damp(this.hurtP, 0, 9, dt);
    this.hurtY = damp(this.hurtY, 0, 9, dt);
    this.checkSunlit(dt);
  }

  canUseInFreeze() { return false; }

  /** Source 引擎的 Accelerate：ws 为用于计算的期望速度（空中被限制），wsFull 为完整期望速度 */
  accelerate(wx, wz, ws, wsFull, accel, dt) {
    if (ws <= 0) return;
    const cur = this.vel.x * wx + this.vel.z * wz;
    const add = ws - cur;
    if (add <= 0) return;
    let acc = accel * wsFull * dt;
    if (acc > add) acc = add;
    this.vel.x += acc * wx;
    this.vel.z += acc * wz;
  }

  reloadSounds() {
    if (!this.reloading) return;
    const w = this.curWeapon();
    const t = 1 - (this.reloadEnd - Clock.time) / w.def.reload;
    if (this.reloadSnd === 0 && t > 0.2) { SFX.reloadPart('out'); this.reloadSnd = 1; }
    if (this.reloadSnd === 1 && t > 0.68) { SFX.reloadPart('in'); this.reloadSnd = 2; }
    if (this.reloadSnd === 2 && t > 0.86) { SFX.reloadPart('bolt'); this.reloadSnd = 3; }
  }

  handleWeapons(dt, I, blocked) {
    if (this.afterThrowAt && Clock.time >= this.afterThrowAt) Grenades.afterThrow(this, this.afterThrowType);
    if (!blocked) {
      if (I.pressed('Digit1')) this.switchTo('primary');
      if (I.pressed('Digit2')) this.switchTo('secondary');
      if (I.pressed('Digit3')) this.switchTo('knife');
      if (I.pressed('Digit4')) this.cycleNade();
      if (I.pressed('Digit5')) this.switchTo('bomb');
      if (I.pressed('KeyQ')) this.quickSwitch();
      if (I.wheel) this.scrollWeapon(I.wheel > 0 ? 1 : -1);
      if (I.pressed('KeyR')) this.startReload();
      if (I.pressed('KeyF')) ViewModel.inspect();
      if (I.pressed('KeyG')) this.dropCurrent();
    }
    const L = !blocked && I.btn(0), R = !blocked && I.btn(2);
    const Lp = !blocked && I.btnPressed(0), Rp = !blocked && I.btnPressed(2);
    if (this.slot === 'nade') { Grenades.control(this, L, R, dt); return; }
    this.nadeCharging = false;
    const w = this.curWeapon();
    if (!w) return;
    const d = w.def;
    if (d.kind === 'knife') {
      if (L && this.canAttack()) { this.knifeAttack(false); ViewModel.knife(false); SFX.knifeSwing(null); }
      else if (Rp && this.canAttack()) { this.knifeAttack(true); ViewModel.knife(true); SFX.knifeSwing(null); }
      return;
    }
    // 狙击枪开镜（右键循环：1 倍 → 2 倍 → 关闭）
    if (Rp && d.zoom && !this.reloading && Clock.time >= this.drawEnd && Clock.time >= this.boltUntil) {
      this.scope = (this.scope + 1) % (d.zoom.length + 1);
      this.scopeStart = Clock.time;
      this.rescope = 0;
      SFX.uiSound('click');
    }
    if (Lp) this.trigFresh = Clock.time;
    const want = d.auto ? (L || Lp) : ((L || Lp) && this.trigFresh > 0 && Clock.time - this.trigFresh < 0.16);
    if (want && this.canAttack()) {
      if (w.mag <= 0) {
        SFX.dryFire();
        this.nextAttack = Clock.time + 0.28;
        this.trigFresh = -1;
        if (w.reserve > 0) this.startReload();
        return;
      }
      this.fireWeapon(this.yaw, this.pitch);
      if (!d.auto) this.trigFresh = -1;
      ViewModel.fire(d.kick);
      if (d.bolt) ViewModel.startBolt(d.rate);
      this.kickP += d.kick * 0.2 * DEG;
      this.kickY += rand(-0.12, 0.12) * d.kick * DEG;
    }
  }

  cycleNade() {
    if (!this.hasNades()) return;
    if (this.slot !== 'nade') { this.switchTo('nade'); return; }
    const i = NADE_ORDER.indexOf(this.nadeType);
    for (let k = 1; k <= 3; k++) {
      const t = NADE_ORDER[(i + k) % 3];
      if (this.inv[t] > 0 && t !== this.nadeType) { this.switchTo('nade', t); return; }
    }
  }
  quickSwitch() {
    const p = this.prevSlot;
    if (p === 'nade' ? this.hasNades() : p === 'bomb' ? this.inv.bomb : this.inv[p]) this.switchTo(p);
  }
  scrollWeapon(dir) {
    const order = ['primary', 'secondary', 'knife', 'nade', 'bomb'];
    const has = (s) => s === 'nade' ? this.hasNades() : s === 'bomb' ? this.inv.bomb : !!this.inv[s];
    let i = order.indexOf(this.slot);
    for (let k = 0; k < 5; k++) {
      i = (i + dir + 5) % 5;
      if (has(order[i])) { this.switchTo(order[i]); return; }
    }
  }
  dropCurrent() {
    const s = this.slot;
    if (s !== 'primary' && s !== 'secondary' && s !== 'bomb') return;
    if (NET.mode === 'client') {
      const w = s === 'bomb' ? null : this.inv[s];
      if (s === 'bomb' ? !this.inv.bomb : !w) return;
      NetClient.send({ t: 'drop', sl: s, mag: w ? w.mag : 0, res: w ? w.reserve : 0 });
      if (s === 'bomb') this.inv.bomb = false; else this.inv[s] = null;
      this.switchBest();
      return;
    }
    this.eye(_v1);
    dirFromAngles(this.yaw, this.pitch, _v2);
    let it;
    if (s === 'bomb') {
      if (!this.inv.bomb) return;
      this.inv.bomb = false;
      it = Items.drop('bomb', null, _v1.x, _v1.y - 0.4, _v1.z, _v2.x * 3.5, _v2.z * 3.5, 2);
    } else {
      const w = this.inv[s];
      if (!w) return;
      this.inv[s] = null;
      it = Items.drop('weapon', w, _v1.x, _v1.y - 0.4, _v1.z, _v2.x * 4, _v2.z * 4, 2);
    }
    it.dropper = this;
    this.switchBest();
  }
  pickup(it) {
    if (NET.mode === 'client') {
      if (Clock.time - (it.reqT || -9) < 0.6) return false;
      it.reqT = Clock.time;
      NetClient.send({ t: 'pickup', id: it.id });
      return true;
    }
    if (it.kind === 'bomb') {
      if (this.team !== 'T') return false;
      this.inv.bomb = true;
      Items.remove(it);
      Events.emit('bombPicked', this);
      return true;
    }
    const slot = it.w.def.slot;
    const old = this.inv[slot];
    if (old) {
      const d = Items.drop('weapon', old, this.pos.x, this.pos.y + 1, this.pos.z, rand(-0.5, 0.5), rand(-0.5, 0.5));
      d.dropper = this;
    }
    this.inv[slot] = it.w;
    Items.remove(it);
    SFX.reloadPart('in');
    this.slot = '';
    this.switchTo(slot);
    return true;
  }

  handleUse(dt, I, ui) {
    this.hint = '';
    const eDown = !ui && I.down('KeyE');
    const inSite = Bomb.siteAt(this.pos.x, this.pos.z);
    // 安放炸弹：T 在包点内按住 E（或手持 C4 按住左键）
    const want = this.team === 'T' && this.inv.bomb && inSite && this.onGround && (eDown || (this.slot === 'bomb' && !ui && I.btn(0))) && Round.canPlant();
    // 拆除炸弹：CT 在炸弹旁按住 E
    const nearBomb = this.team === 'CT' && Bomb.state === 'planted' && Round.state === 'live' && this.onGround && this.pos.distanceTo(Bomb.pos) < 1.4;
    const wantDefuse = nearBomb && eDown;
    if (NET.mode === 'client') {
      // 联机：本地只负责冻结移动，进度由服务器计算
      const use = want || wantDefuse;
      if (use !== this.netUse) { this.netUse = use; NetClient.send({ t: 'use', on: use ? 1 : 0 }); }
      if (want && this.slot !== 'bomb') this.switchTo('bomb');
      this.planting = want;
      this.defusing = wantDefuse;
    } else {
      if (want) {
        if (!this.planting) {
          if (this.slot !== 'bomb') this.switchTo('bomb');
          this.planting = true;
          Bomb.startPlant(this);
        }
        if (Bomb.updatePlant(this, dt)) this.planting = false;
      } else if (this.planting) {
        this.planting = false;
        Bomb.cancelPlant(this);
      }
      if (wantDefuse) {
        if (!this.defusing) { this.defusing = true; Bomb.startDefuse(this); }
        if (Bomb.updateDefuse(this, dt)) this.defusing = false;
      } else if (this.defusing) {
        this.defusing = false;
        Bomb.cancelDefuse(this);
      }
    }
    if (this.planting || this.defusing) return;
    if (this.inv.bomb && inSite && Round.canPlant() && this.team === 'T') this.hint = '按住 <b>E</b> 安放炸弹';
    else if (nearBomb) this.hint = `按住 <b>E</b> 拆除炸弹${this.kit ? '（拆弹器 5 秒）' : '（10 秒）'}`;
    // 拾取
    const it = Items.nearest(this, 1.5);
    if (it) {
      if (it.kind === 'bomb') {
        if (this.team === 'T') this.pickup(it);
      } else {
        const slot = it.w.def.slot;
        if (!this.inv[slot] && Clock.time - it.t > 0.4) this.pickup(it);
        else if (!this.hint) {
          this.hint = `按 <b>E</b> 拾取 ${it.w.def.full || it.w.def.name}`;
          if (!ui && I.pressed('KeyE')) this.pickup(it);
        }
      }
    }
  }

  /** 头顶是否有遮挡（用于第一人称武器的光照明暗） */
  checkSunlit(dt) {
    this._sunT -= dt;
    if (this._sunT <= 0) {
      this._sunT = 0.12;
      this.eye(_v1);
      this._sunTarget = World.raycast(_v1.x, _v1.y, _v1.z, SUN_DIR.x, SUN_DIR.y, SUN_DIR.z, 60, World._hit) ? 0 : 1;
    }
    this.sunlit = damp(this.sunlit, this._sunTarget === undefined ? 1 : this._sunTarget, 5, dt);
  }

  onDamaged(e) {
    // 受击视角抖动 + 受击方向指示
    this.hurtP += rand(1.2, 2.4) * DEG * (e.group === 'head' ? 1.6 : 1);
    this.hurtY += rand(-1.2, 1.2) * DEG;
    SFX.hurt(e.group === 'head');
  }

  onDeath(killer) {
    this.deathTime = Clock.time;
    this.killer = killer;
    this.specTarget = null;
    this.planting = false;
    this.defusing = false;
    if (this.netUse) { this.netUse = false; NetClient.send({ t: 'use', on: 0 }); }
    this.scope = 0;
    ViewModel.hide();
  }

  updateDead(dt) {
    const I = Input;
    const t = Clock.time - this.deathTime;
    if (t > 2.2) {
      if (!this.specTarget || !this.specTarget.alive) this.nextSpectate(1);
      if (!UI.blocking()) {
        if (I.btnPressed(0)) this.nextSpectate(1);
        if (I.btnPressed(2)) this.nextSpectate(-1);
      }
    }
  }
  nextSpectate(dir) {
    // 优先观战队友，没有队友时观战敌人
    let list = Combat.chars.filter(c => c.alive && c !== this && c.team === this.team);
    if (!list.length) list = Combat.chars.filter(c => c.alive && c !== this);
    if (!list.length) { this.specTarget = null; return; }
    let i = list.indexOf(this.specTarget);
    i = (i + dir + list.length) % list.length;
    if (i < 0) i = 0;
    this.specTarget = list[i];
  }

  /** 把玩家视角写入相机 */
  applyCamera(cam, dt) {
    const shake = FX.shake;
    if (this.alive) {
      const w = this.curWeapon();
      // 后坐力视角：弹道偏移的一半显示在视角上（CS 的 view punch）
      let rp = 0, ry = 0;
      if (w && w.def.pattern) { const p = samplePattern(w.def.pattern, this.shotIdx); rp = p[1] * 0.5 * DEG; ry = -p[0] * 0.5 * DEG; }
      const sx = shake ? (Math.random() - 0.5) * shake * 0.04 : 0, sp = shake ? (Math.random() - 0.5) * shake * 0.04 : 0;
      cam.position.set(this.pos.x, this.pos.y + this.eyeHeight() + this.stepOffset, this.pos.z);
      cam.rotation.set(this.pitch + rp + this.kickP + this.hurtP + sp, this.yaw + ry + this.kickY + this.hurtY + sx, 0, 'YXZ');
      return;
    }
    // ---- 死亡视角 / 观战 ----
    const t = Clock.time - this.deathTime;
    const tgt = this.specTarget;
    if (tgt && tgt.alive && t > 2.2) {
      tgt.eye(_v1);
      const back = 2.6, up = 0.55;
      const yaw = tgt.yaw;
      _v2.set(_v1.x + Math.sin(yaw) * back, _v1.y + up, _v1.z + Math.cos(yaw) * back);
      // 防止相机穿墙
      const dx = _v2.x - _v1.x, dy = _v2.y - _v1.y, dz = _v2.z - _v1.z;
      const len = Math.hypot(dx, dy, dz);
      if (World.raycast(_v1.x, _v1.y, _v1.z, dx / len, dy / len, dz / len, len, World._hit)) {
        const k = Math.max(0.3, World._hit.t - 0.25) / len;
        _v2.set(_v1.x + dx * k, _v1.y + dy * k, _v1.z + dz * k);
      }
      cam.position.lerp(_v2, 1 - Math.exp(-12 * dt));
      cam.rotation.set(clamp(tgt.pitch * 0.6, -0.8, 0.8) - 0.12, yaw, 0, 'YXZ');
    } else {
      // 倒地视角：缓慢下沉并看向击杀者
      const k = clamp(t / 0.8, 0, 1);
      cam.position.set(this.pos.x, this.pos.y + lerp(this.eyeHeight(), 0.45, k), this.pos.z);
      if (this.killer && this.killer !== this) {
        this.killer.eye(_v1);
        const yaw = yawOf(_v1.x - cam.position.x, _v1.z - cam.position.z);
        const pitch = Math.atan2(_v1.y - cam.position.y, Math.hypot(_v1.x - cam.position.x, _v1.z - cam.position.z));
        cam.rotation.set(damp(cam.rotation.x, pitch, 3, dt), dampAngle(cam.rotation.y, yaw, 3, dt), damp(cam.rotation.z, 0.25, 2, dt), 'YXZ');
      }
    }
  }
}
