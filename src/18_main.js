// =====================================================================
//  18 主模块：初始化渲染器与场景、主循环、画质设置、菜单镜头、调试接口
// =====================================================================

const Game = {
  state: 'loading',     // loading | menu | playing | over
  paused: false,
  headless: false,
  bots: [],
  player: null,
  last: 0,

  init() {
    if (typeof THREE === 'undefined') throw new Error('无法加载 Three.js（需要联网访问 cdnjs.cloudflare.com）');
    const canvas = $('view');
    const q = SETTINGS.quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q === 'high', powerPreference: 'high-performance', stencil: false });
    this.renderer.autoClear = false;
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = q !== 'low';
    this.renderer.shadowMap.type = q === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xcfdcea);
    this.scene.fog = new THREE.Fog(0xe0d2b4, 70, 260);
    this.camera = new THREE.PerspectiveCamera(SETTINGS.fov, innerWidth / innerHeight, 0.05, 700);
    this.camera.rotation.order = 'YXZ';

    // ---- 灯光：天空半球光 + 太阳平行光（带阴影） ----
    this.hemi = new THREE.HemisphereLight(0xc4d8ee, 0x9c8565, 0.66);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d6, 0.95);
    this.sun.position.copy(SUN_DIR).multiplyScalar(90);
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -46; sc.right = 46; sc.top = 46; sc.bottom = -46; sc.near = 10; sc.far = 200;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.buildSky();

    // ---- 各子系统 ----
    Tex.init(this.renderer);
    MapBuilder.build(this.scene);
    Nav.build();
    FX.init(this.scene);
    Items.init(this.scene);
    Bomb.init(this.scene);
    Grenades.init(this.scene);
    ViewModel.init(innerWidth / innerHeight);
    GunModels.initMats();
    this.player = new Player();
    Combat.chars = [this.player];
    UI.init();
    Input.init(canvas);
    this.applyQuality();

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('beforeunload', (e) => {
      if (this.state === 'playing' && !CFG.DEBUG) { e.preventDefault(); e.returnValue = ''; }
    });
    this.initDebug();
    this.state = 'menu';
    UI.showScreen('start');
    if (UI.inviteCode) UI.openLobby();       // 通过邀请链接打开：直接进入多人大厅
    $('loading').classList.add('hidden');
    this.loopFn = (t) => this.loop(t);
    requestAnimationFrame(this.loopFn);
  },

  /** 程序化天空：渐变 + 太阳光晕 */
  buildSky() {
    const geo = new THREE.SphereGeometry(600, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { sunDir: { value: SUN_DIR.clone() } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }',
      fragmentShader: `
        uniform vec3 sunDir; varying vec3 vDir;
        void main(){
          float h = clamp(vDir.y, -0.2, 1.0);
          vec3 horizon = vec3(0.93, 0.86, 0.74);
          vec3 zenith = vec3(0.36, 0.56, 0.82);
          vec3 col = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
          float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
          col += vec3(1.0, 0.9, 0.7) * (pow(s, 600.0) * 2.0 + pow(s, 12.0) * 0.18);
          if (h < 0.0) col = mix(horizon, vec3(0.8, 0.72, 0.6), -h * 4.0);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
  },

  /** 画质预设：像素比 / 阴影。动态分辨率在此基础上按帧率自动缩放 */
  basePixelRatio() {
    const q = SETTINGS.quality, dpr = window.devicePixelRatio || 1;
    return q === 'low' ? Math.min(dpr, 1) * 0.75 : q === 'medium' ? Math.min(dpr, 1) : Math.min(dpr, 2);
  },
  resScale: 1,
  applyQuality() {
    const q = SETTINGS.quality;
    this.resScale = 1;
    this.renderer.setPixelRatio(this.basePixelRatio());
    const shadows = q !== 'low';
    const size = q === 'high' ? 2048 : 1024;
    if (this.renderer.shadowMap.enabled !== shadows || this.sun.shadow.mapSize.x !== size) {
      this.renderer.shadowMap.enabled = shadows;
      this.sun.castShadow = shadows;
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      this.scene.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.needsUpdate = true); });
    }
    this.renderer.setSize(innerWidth, innerHeight);
    FX.setScale(innerHeight, this.camera.fov);
  },

  applySettings(key) {
    if (key === 'volume') SFX.setVolume(SETTINGS.volume);
    if (key === 'quality') this.applyQuality();
    if (key === 'difficulty') for (const b of this.bots) b.setDifficulty(SETTINGS.difficulty);
    if (!key || key.startsWith('cross')) UI.applyCrosshairStyle();
    if (!key) { SFX.setVolume(SETTINGS.volume); this.applyQuality(); }
  },

  onResize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    ViewModel.camera.aspect = innerWidth / innerHeight;
    ViewModel.camera.updateProjectionMatrix();
    FX.setScale(innerHeight, this.camera.fov);
  },

  // ------------------------------------------------------------------
  //  比赛流程
  // ------------------------------------------------------------------
  setupCharacters() {
    for (const b of this.bots) CharModel.dispose(b.model);
    this.bots = [];
    const P = this.player;
    Combat.chars = [P];
    const ctNames = shuffle(BOT_NAMES.CT.slice()), tNames = shuffle(BOT_NAMES.T.slice());
    for (let i = 0; i < CFG.TEAM_SIZE; i++) this.addBot('CT', ctNames[i]);
    for (let i = 0; i < SETTINGS.teammates; i++) this.addBot('T', tNames[i]);
  },
  addBot(team, name) {
    const b = new Bot(team, name, SETTINGS.difficulty);
    b.model = CharModel.create(team, name, team === this.player.team);
    this.scene.add(b.model.root);
    this.bots.push(b);
    Combat.chars.push(b);
    return b;
  },
  startMatch() {
    if (NET.mode === 'client') return;
    SFX.init(); SFX.resume();
    SFX.setVolume(SETTINGS.volume);
    this.setupCharacters();
    this.state = 'playing';
    this.paused = false;
    UI.closeBuy(false);
    UI.showScreen(null);
    $('scoreboard').classList.add('hidden');
    $('hud').classList.remove('hidden');
    Round.startMatch();
    Input.lock();
  },
  /** 进入联机房间（服务器已为本机分配角色） */
  startMultiplayer(you) {
    SFX.init(); SFX.resume();
    SFX.setVolume(SETTINGS.volume);
    for (const b of this.bots) CharModel.dispose(b.model);
    this.bots = [];
    NET.mode = 'client';
    const P = this.player;
    P.id = you.id;
    P.team = you.team;
    P.name = SETTINGS.mpName || '玩家';
    P.alive = false; P.health = 0; P.armor = 0;
    P.deathTime = Clock.time - 10; P.specTarget = null;
    P.stats = { k: 0, d: 0, a: 0, hs: 0, dmg: 0, mvp: 0, rk: 0, rdmg: 0 };
    Combat.chars = [P];
    FX.clear(); Grenades.clear(); Items.clear(); Bomb.reset();
    Round.state = 'freeze'; Round.score = { T: 0, CT: 0 };
    ViewModel.hide();
    this.state = 'playing';
    this.paused = false;
    UI.closeBuy(false);
    UI.showScreen(null);
    $('scoreboard').classList.add('hidden');
    $('hud').classList.remove('hidden');
    UI.onNetEnter();
    Input.lock();
  },
  /** 离开联机房间（主动离开或断线） */
  leaveMultiplayer(msg) {
    NetClient.cleanup();
    NET.mode = 'sp';
    const P = this.player;
    P.name = '你'; P.team = 'T'; P.id = ++CHAR_ID;
    Combat.chars = [P];
    UI.onNetLeave();
    this.toMenu();
    if (msg) { UI.netNote = msg; UI.openLobby(); UI.lobbyStatus(msg, 'bad'); }
  },
  toMenu() {
    if (NET.mode === 'client') { NetClient.leaveRoom(); this.leaveMultiplayer(); return; }
    this.state = 'menu';
    this.paused = false;
    Input.unlock();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    for (const b of this.bots) CharModel.dispose(b.model);
    this.bots = [];
    Combat.chars = [this.player];
    UI.closeBuy(false);
    UI.showScreen('start');
    ViewModel.hide();
    FX.clear(); Grenades.clear(); Items.clear(); Bomb.reset();
    Round.state = 'menu';
  },
  pause() {
    if (this.state !== 'playing' || this.paused) return;
    if (NET.mode === 'client') { if (!UI.screen) UI.showScreen('pause'); return; }
    this.paused = true;
    UI.showScreen('pause');
    SFX.suspend();
  },
  resume() {
    if (this.state !== 'playing') return;
    UI.showScreen(null);
    this.paused = false;
    SFX.resume();
    Input.lock();
  },
  onUnlock() {
    if (this.state !== 'playing') return;
    if (UI.buyOpen || UI.chatOpen || UI.screen) return;
    if (CFG.DEBUG && this.headless) return;
    this.pause();
  },
  onLock() {
    $('clickToPlay').classList.add('hidden');
    if (this.state === 'playing' && this.paused) { this.paused = false; UI.showScreen(null); SFX.resume(); }
  },
  onMatchOver(e) {
    $('btnAgain').textContent = '再来一局';
    $('btnMenu').textContent = '返回主菜单';
    this.state = 'over';
    Input.unlock();
    const P = this.player, s = P.stats;
    const win = e.winner === P.team;
    $('meTitle').textContent = win ? '胜利' : '失败';
    $('meTitle').className = 'bigResult ' + (win ? 'win' : 'lose');
    $('meScore').textContent = `T ${Round.score.T} : ${Round.score.CT} CT  ·  共 ${Round.number} 回合  ·  难度 ${DIFFICULTY[SETTINGS.difficulty].name}`;
    const hs = s.k ? Math.round(s.hs / s.k * 100) : 0;
    const rows = [['击杀 / 死亡 / 助攻', `${s.k} / ${s.d} / ${s.a}`], ['K/D', (s.k / Math.max(1, s.d)).toFixed(2)], ['爆头率', hs + '%'],
      ['场均伤害 ADR', Math.round(s.dmg / Math.max(1, Round.number))], ['MVP', s.mvp]];
    $('meStats').innerHTML = rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
    UI.showScreen('matchEnd');
  },

  onKeyDown(code, e) {
    if (this.state !== 'playing') return;
    if (code === 'Escape') {
      if (UI.buyOpen) UI.closeBuy(false);
      else if (UI.screen === 'settings' || UI.screen === 'help') UI.showScreen('pause');
      return;
    }
    if (UI.buyOpen) {
      if (code === 'KeyB') UI.closeBuy(true);
      else UI.buyKey(code);
      return;
    }
    if (UI.screen) return;
    if (NET.mode === 'client') {
      if (code === 'KeyY' || code === 'KeyU') { e.preventDefault(); UI.openChat(code === 'KeyU'); return; }
      if (code === 'KeyM') { Input.unlock(); UI.showScreen('team'); return; }
    }
    if (code === 'KeyB') UI.openBuy();
    if (code === 'Tab') { UI.scoreOpen = true; UI.renderScoreboard(); $('scoreboard').classList.remove('hidden'); }
  },
  onKeyUp(code) {
    if (code === 'Tab') { UI.scoreOpen = false; $('scoreboard').classList.add('hidden'); }
  },

  // ------------------------------------------------------------------
  //  主循环
  // ------------------------------------------------------------------
  loop(now) {
    requestAnimationFrame(this.loopFn);
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) dt = 0;
    this.autoResolution(dt);
    if (dt > 0.05) dt = 0.05;       // 卡顿时限制步长，防止穿墙
    Input.beginFrame();
    if (this.state === 'playing' && !this.paused) { if (!this.manual) this.step(dt); }
    else if (this.state === 'menu') this.menuCamera(dt);
    this.render(dt);
    Input.endFrame();
  },

  step(dt) {
    Clock.dt = dt;
    Clock.time += dt;
    Clock.frame++;
    if (NET.mode === 'client') {
      // 联机：回合 / Bot / 经济都在服务器上，本地只模拟自己并插值显示其他人
      NetClient.update(dt);
      this.player.update(dt);
      NetClient.tickReplicas(dt);
    } else {
      Round.update(dt);
      TeamAI.update();
      this.player.update(dt);
      for (const b of this.bots) b.update(dt);
    }
    this.separate();
    Grenades.update(dt);
    Bomb.update(dt);
    Items.update(dt);
    FX.update(dt);
    this.updateSpotting(dt);
    const P = this.player;
    P.applyCamera(this.camera, dt);
    // 视野（狙击镜缩放）
    const w = P.curWeapon();
    const fov = P.alive && P.scope && w && w.def.zoom ? w.def.zoom[P.scope - 1] : SETTINGS.fov;
    if (this.camera.fov !== fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); FX.setScale(innerHeight, fov); }
    this.camera.updateMatrixWorld();
    this.camera.getWorldDirection(_v5);
    SFX.updateListener(this.camera.position, _v5);
    if (P.alive) ViewModel.update(dt, P, this.camera);
  },

  /**
   * 动态分辨率：持续低于约 50 FPS 时逐步降低渲染分辨率（最低 55%），
   * 帧率充裕时再逐步恢复。解决低配电脑卡顿的问题。
   */
  _arT: 0, _arN: 0, _arSum: 0,
  autoResolution(dt) {
    if (this.state !== 'playing' || this.paused || CFG.DEBUG || dt <= 0 || dt > 0.25) return;
    this._arSum += dt; this._arN++;
    this._arT += dt;
    if (this._arT < 1.5) return;
    const avg = this._arSum / this._arN;
    this._arT = 0; this._arN = 0; this._arSum = 0;
    let s = this.resScale;
    if (avg > 1 / 48 && s > 0.55) s = Math.max(0.55, s * 0.85);
    else if (avg < 1 / 75 && s < 1) s = Math.min(1, s * 1.1);
    if (s !== this.resScale) {
      this.resScale = s;
      this.renderer.setPixelRatio(this.basePixelRatio() * s);
      this.renderer.setSize(innerWidth, innerHeight);
    }
  },

  /** 角色之间的简单推挤（防止重叠） */
  separate() {
    if (NET.mode === 'client') {
      const P = this.player;
      if (!P.alive) return;
      for (const o of Combat.chars) {
        if (o === P || !o.alive || Math.abs(o.pos.y - P.pos.y) > 1.5) continue;
        const dx = P.pos.x - o.pos.x, dz = P.pos.z - o.pos.z, d2 = dx * dx + dz * dz, min = 0.72;
        if (d2 >= min * min || d2 < 1e-6) continue;
        const d = Math.sqrt(d2), push = (min - d);
        if (Physics.free(P.pos.x + dx / d * push, P.pos.y, P.pos.z + dz / d * push, P.hw, P.height)) { P.pos.x += dx / d * push; P.pos.z += dz / d * push; }
      }
      return;
    }
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
        const d = Math.sqrt(d2), push = (min - d) * 0.5;
        const nx = dx / d, nz = dz / d;
        if (Physics.free(a.pos.x - nx * push, a.pos.y, a.pos.z - nz * push, a.hw, a.height)) { a.pos.x -= nx * push; a.pos.z -= nz * push; }
        if (Physics.free(b.pos.x + nx * push, b.pos.y, b.pos.z + nz * push, b.hw, b.height)) { b.pos.x += nx * push; b.pos.z += nz * push; }
      }
    }
  },

  /** 雷达"发现"：玩家视线内或被 T 队友看到的敌人 */
  _spotT: 0,
  updateSpotting(dt) {
    this._spotT -= dt;
    if (this._spotT > 0) return;
    this._spotT = 0.1;
    const P = this.player;
    const now = Clock.time;
    P.eye(_v1);
    for (const e of Combat.chars) {
      if (e.team === P.team || !e.alive) continue;
      let seen = !!(e.remote && e.spottedBy(P.team));
      for (const b of this.bots) {
        if (b.team !== P.team || !b.alive) continue;
        const k = b.known.get(e);
        if (k && k.spotted && k.seenNow) { seen = true; break; }
      }
      if (!seen && P.alive) {
        e.chestPos(_v2);
        const ang = Math.abs(wrapAngle(yawOf(_v2.x - _v1.x, _v2.z - _v1.z) - P.yaw));
        if (ang < 55 * DEG && World.segClear(_v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z) && !FX.smokeBlocks(_v1.x, _v1.y, _v1.z, _v2.x, _v2.y, _v2.z)) seen = true;
      }
      if (seen) e.spottedAt = now;
    }
  },

  render(dt) {
    const r = this.renderer;
    r.clear();
    r.render(this.scene, this.camera);
    UI.captureBurn(r);
    const P = this.player;
    if (this.state === 'playing' && P.alive && !(P.scope && P.curWeapon() && P.curWeapon().def.kind === 'sniper')) {
      r.clearDepth();
      r.render(ViewModel.scene, ViewModel.camera);
    }
    UI.update(dt, this.camera);
  },

  /** 主菜单背景：绕地图缓慢飞行 */
  _menuT: 0,
  menuCamera(dt) {
    this._menuT += dt * 0.05;
    const a = this._menuT;
    this.camera.position.set(Math.cos(a) * 34, 22 + Math.sin(a * 0.7) * 3, Math.sin(a) * 34);
    this.camera.lookAt(0, 0, 0);
    if (this.camera.fov !== SETTINGS.fov) { this.camera.fov = SETTINGS.fov; this.camera.updateProjectionMatrix(); }
    FX.update(dt);
  },

  // ------------------------------------------------------------------
  //  调试接口（URL 加 ?debug）：自动化测试使用
  // ------------------------------------------------------------------
  initDebug() {
    if (!CFG.DEBUG) return;
    window.SZ = {
      Game, Round, World, Nav, Bomb, FX, UI, Input, Combat, CFG, SETTINGS, MAP, TeamAI, Economy, Grenades, Items, Clock, WEAPONS,
      /** 同步推进 n 帧 */
      step(n = 60, dt = 1 / 60) { for (let i = 0; i < n; i++) { Input.beginFrame(); Game.step(dt); Input.endFrame(); } },
      start(headless = true, manual = true) { Game.headless = headless; Game.manual = manual; Game.startMatch(); },
      tp(c, r, yaw = null) { const P = Game.player; const x = MAP.wx(c), z = MAP.wz(r); P.pos.set(x, Nav.floorAt(x, z), z); P.vel.set(0, 0, 0); if (yaw !== null) P.yaw = yaw; },
      give(id) { const P = Game.player; P.inv[WEAPONS[id].slot] = newWeapon(id); P.slot = ''; P.switchTo(WEAPONS[id].slot); },
      key(code, down) { if (down) { Input.keys.add(code); Input.pressedSet.add(code); } else Input.keys.delete(code); },
      mouse(btn, down) { Input.btns[btn] = down; if (down) Input.btnP[btn] = true; },
    };
  },
};

// =====================================================================
//  事件 → 音效 / 特效桥接：枪声（带方位与遮挡）、枪口火光、曳光弹、刀、倒地
// =====================================================================
let TRACER_N = 0;
const _fxA = new THREE.Vector3();
/** 角色第三人称枪口的世界坐标（没有枪模时退化为眼睛位置） */
function muzzleWorld(ch, out) {
  const m = ch.model && ch.model.gunMesh;
  if (m && m.userData.muzzle) { out.copy(m.userData.muzzle); m.updateWorldMatrix(true, false); return m.localToWorld(out); }
  return ch.eye(out);
}
Events.on('bullet', (e) => {
  const ch = e.shooter;
  if (ch.isPlayer) {
    if (++TRACER_N % 3 !== 0) return;          // 玩家每 3 发显示一次曳光
    const cam = Game.camera;
    _fxA.set(0.12, -0.11, -0.7).applyQuaternion(cam.quaternion).add(cam.position);
  } else {
    if (Math.random() < 0.45) return;
    muzzleWorld(ch, _fxA);
  }
  FX.tracers.add(_fxA.x, _fxA.y, _fxA.z, e.ex, e.ey, e.ez);
});
Events.on('shot', (e) => {
  const ch = e.ch, d = e.def;
  if (ch.isPlayer) { SFX.gunshot(d.snd, null); return; }
  if (ch.model) ch.model.onFire(d);
  muzzleWorld(ch, _fxA);
  FX.muzzle(_fxA.x, _fxA.y, _fxA.z);
  const L = SFX.listenerPos;
  const occluded = !World.segClear(L.x, L.y, L.z, _fxA.x, _fxA.y, _fxA.z);
  SFX.gunshot(d.snd, _fxA, occluded);
});
Events.on('knife', (e) => { if (!e.ch.isPlayer) { SFX.knifeSwing(e.ch.pos); if (e.ch.model) e.ch.model.onKnife(e.heavy); } });
// 人物动作：受击抖动、投掷
Events.on('damage', (e) => {
  const v = e.victim;
  if (!v.model || v.isPlayer || !v.alive) return;
  let dx = e.dirx, dz = e.dirz;
  if (dx === undefined && e.attacker) { dx = v.pos.x - e.attacker.pos.x; dz = v.pos.z - e.attacker.pos.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; }
  v.model.onHit(dx || 0, dz || 0, e.group, e.dmg);
});
Events.on('nadeThrown', (g) => { if (g.owner && g.owner.model) g.owner.model.onThrow(); });
Events.on('kill', (e) => { SFX.land(e.victim.isPlayer ? null : e.victim.pos, true, 'sand'); });

// ---- 启动 ----
window.addEventListener('load', () => {
  try {
    Game.init();
  } catch (err) {
    console.error(err);
    $('loadMsg').textContent = '启动失败';
    $('errorBox').textContent = String(err && err.message || err);
  }
});
window.addEventListener('error', (e) => {
  if (Game.state === 'loading') $('errorBox').textContent = '脚本错误：' + e.message;
});
