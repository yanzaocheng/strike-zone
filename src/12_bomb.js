// =====================================================================
//  12 炸弹模块（C4）
//  状态：carried(携带) → planted(已安放) → exploded / defused
//  - T 在包点内按住 E 5 秒安放，安放期间不能移动，松开即中断
//  - 安放后 40 秒爆炸，蜂鸣频率逐渐加快
//  - CT 拆除需要 10 秒（有拆弹器 5 秒），拆弹者移动或死亡即中断
// =====================================================================

const Bomb = {
  state: 'carried',
  pos: new THREE.Vector3(),
  site: null,
  timer: 0,
  planter: null,
  plantT: 0, planting: null, plantStart: new THREE.Vector3(), keyT: 0,
  defuser: null, defuseT: 0, defuseDur: 10, defuseStart: new THREE.Vector3(), tickT: 0,
  beepT: 0, ledT: 0,
  mesh: null,

  init(scene) {
    this.scene = scene;
    if (!scene) return;       // 服务器：只有逻辑
    this.mesh = GunModels.makeWorldMesh('c4');
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.led = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
    this.led.visible = false;
    scene.add(this.led);
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: Tex.t.soft, color: 0xff3020, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.glow.scale.set(0.6, 0.6, 1);
    this.glow.visible = false;
    scene.add(this.glow);
  },

  reset() {
    this.state = 'carried';
    this.site = null; this.timer = 0; this.planter = null;
    this.planting = null; this.plantT = 0;
    this.defuser = null; this.defuseT = 0;
    this.showMesh(false);
  },
  /** 已安放炸弹的模型显示 */
  showMesh(on, yaw = 0) {
    if (!this.mesh) return;
    this.mesh.visible = on;
    if (!on) { this.led.visible = false; this.glow.visible = false; return; }
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.set(0, yaw, 0);
    this.led.position.set(this.pos.x, this.pos.y + 0.07, this.pos.z);
    this.glow.position.copy(this.led.position);
  },

  /** 坐标所在包点（'A' / 'B' / null） */
  siteAt(x, z) {
    for (const k in MAP.BOMBSITES) if (MAP.inRect(x, z, MAP.BOMBSITES[k].rect)) return k;
    return null;
  },
  sitePos(k, out) {
    const s = MAP.BOMBSITES[k];
    const x = MAP.wx(s.center[0]), z = MAP.wz(s.center[1]);
    return out.set(x, Nav.floorAt(x, z), z);
  },

  // ---------------- 安放 ----------------
  startPlant(ch) {
    this.planting = ch;
    this.plantT = 0;
    this.keyT = 0;
    this.plantStart.copy(ch.pos);
    Events.emit('plantStart', ch);
    Events.emit('noise', { ch, x: ch.pos.x, y: ch.pos.y, z: ch.pos.z, r: 16 });
  },
  /** 返回 true 表示安放完成 */
  updatePlant(ch, dt) {
    if (this.planting !== ch) this.startPlant(ch);
    if (ch.pos.distanceTo(this.plantStart) > 0.6) { this.cancelPlant(ch); return true; }
    this.plantT += dt;
    this.keyT -= dt;
    if (this.keyT <= 0) { this.keyT = 0.42; SFX.keypad(ch.isPlayer ? null : ch.pos); }
    if (this.plantT >= CFG.ROUND.PLANT_TIME) { this.plant(ch); return true; }
    return false;
  },
  cancelPlant(ch) {
    if (this.planting === ch) { this.planting = null; this.plantT = 0; }
  },
  plant(ch) {
    this.planting = null;
    this.state = 'planted';
    this.planter = ch;
    this.site = this.siteAt(ch.pos.x, ch.pos.z) || 'A';
    const fy = World.floorBelow(ch.pos.x, ch.pos.y + 0.1, ch.pos.z, 0.05, 2);
    this.pos.set(ch.pos.x, (fy > -Infinity ? fy : ch.pos.y) + 0.03, ch.pos.z);
    this.timer = CFG.ROUND.BOMB_TIME;
    this.beepT = 0;
    ch.inv.bomb = false;
    if (ch.slot === 'bomb') ch.switchBest();
    this.showMesh(true, ch.yaw);
    Economy.give(ch, CFG.ECON.PLANT_BONUS);
    SFX.uiSound('planted');
    Events.emit('bombPlanted', { ch, site: this.site });
  },

  // ---------------- 拆除 ----------------
  startDefuse(ch) {
    this.defuser = ch;
    this.defuseT = 0;
    this.defuseDur = ch.kit ? CFG.ROUND.DEFUSE_KIT_TIME : CFG.ROUND.DEFUSE_TIME;
    this.defuseStart.copy(ch.pos);
    Events.emit('defuseStart', ch);
  },
  updateDefuse(ch, dt) {
    if (this.state !== 'planted') return true;
    if (this.defuser !== ch) this.startDefuse(ch);
    if (ch.pos.distanceTo(this.defuseStart) > 0.6 || !ch.alive) { this.cancelDefuse(ch); return true; }
    this.defuseT += dt;
    this.tickT -= dt;
    if (this.tickT <= 0) { this.tickT = 0.5; SFX.defuseTick(this.pos); }
    if (this.defuseT >= this.defuseDur) { this.defuse(ch); return true; }
    return false;
  },
  cancelDefuse(ch) {
    if (this.defuser === ch) { this.defuser = null; this.defuseT = 0; }
  },
  defuse(ch) {
    this.state = 'defused';
    this.defuser = null;
    if (this.led) { this.led.visible = false; this.glow.visible = false; }
    Economy.give(ch, CFG.ECON.DEFUSE_BONUS);
    Events.emit('bombDefused', { ch });
  },

  update(dt) {
    if (NET.mode === 'client') {
      // 联机客户端：进度由服务器同步，这里只做快照之间的平滑与按键/拆弹音效
      if (this.planting && Round.state === 'live') {
        this.plantT += dt;
        this.keyT -= dt;
        if (this.keyT <= 0) { this.keyT = 0.42; SFX.keypad(this.planting.isPlayer ? null : this.planting.pos); }
      }
      if (this.defuser && this.state === 'planted') {
        this.defuseT += dt;
        this.tickT -= dt;
        if (this.tickT <= 0) { this.tickT = 0.5; SFX.defuseTick(this.pos); }
      }
    }
    if (this.state !== 'planted') return;
    if (Round.state === 'end') { if (this.led) { this.led.visible = false; this.glow.visible = false; } return; }
    this.timer -= dt;
    if (NET.mode !== 'client' && this.defuser && !this.defuser.alive) this.cancelDefuse(this.defuser);
    // 蜂鸣：40 秒时约 1 秒一次，最后 1 秒密集蜂鸣
    const interval = 0.1 + 0.9 * Math.pow(clamp(this.timer / CFG.ROUND.BOMB_TIME, 0, 1), 1.3);
    this.beepT -= dt;
    if (this.beepT <= 0) {
      this.beepT = interval;
      SFX.bombBeep(this.pos);
      this.ledT = 0.08;
    }
    this.ledT -= dt;
    const on = this.ledT > 0;
    if (this.led) { this.led.visible = on; this.glow.visible = on; }
    if (this.timer <= 0 && NET.mode !== 'client') this.explode();
  },

  explode() {
    this.state = 'exploded';
    this.explodeFx();
    Combat.radiusDamage(this.pos.x, this.pos.y + 0.5, this.pos.z, CFG.ROUND.BOMB_RADIUS, CFG.ROUND.BOMB_DAMAGE, this.planter, 'bomb');
    Events.emit('bombExploded', {});
  },
  /** 爆炸的画面与声音（联机客户端收到服务器消息时也调用） */
  explodeFx() {
    this.showMesh(false);
    if (IS_SERVER) return;
    const p = this.pos;
    FX.explosion(p.x, p.y, p.z, true);
    FX.boom(p.x, p.y + 3, p.z, 40, 0.8, 0xfff0d0);
    SFX.explosion(p, true);
    const P = Game.player;
    if (P) {
      const d = P.pos.distanceTo(p);
      FX.shake = Math.max(FX.shake, clamp(1.6 - d / 40, 0.3, 1.4));
      if (d < 45) UI.whiteFlash(clamp(1 - d / 45, 0.2, 0.9));
    }
  },
};
