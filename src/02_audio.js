// =====================================================================
//  02 音效模块：全部使用 Web Audio API 程序化合成（无任何音频文件）
//  - 自身声音直接进入 sfx 总线；其他角色的声音经过 PannerNode（HRTF）定位
//  - 距离越远高频衰减越多；被墙阻挡的声音额外做低通（闷响）
//  - 闪光弹致盲时对 sfx 总线做低通 + 耳鸣
// =====================================================================

// 枪声参数：crack=[高通频率,时长,音量] body=[低通频率,时长,音量] thump=[起始频率,结束频率,时长,音量] tail=[低通频率,时长,音量]
const GUN_SFX = {
  pistol: { crack: [3200, 0.05, 0.55], body: [1600, 0.11, 0.7], thump: [230, 75, 0.07, 0.55], tail: [900, 0.3, 0.12] },
  deagle: { crack: [2500, 0.07, 0.75], body: [900, 0.2, 0.95], thump: [150, 45, 0.13, 0.95], tail: [600, 0.6, 0.24] },
  smg:    { crack: [3600, 0.045, 0.45], body: [1800, 0.1, 0.6], thump: [210, 85, 0.06, 0.5], tail: [1000, 0.25, 0.1] },
  rifle:  { crack: [2300, 0.06, 0.72], body: [1000, 0.16, 0.95], thump: [135, 45, 0.1, 0.95], tail: [560, 0.55, 0.22] },
  m4:     { crack: [2900, 0.055, 0.62], body: [1300, 0.13, 0.85], thump: [155, 55, 0.09, 0.8], tail: [650, 0.45, 0.18] },
  sniper: { crack: [2000, 0.09, 0.95], body: [700, 0.32, 1.15], thump: [95, 32, 0.24, 1.25], tail: [380, 1.2, 0.36] },
  scout:  { crack: [2700, 0.07, 0.8], body: [950, 0.22, 1.0], thump: [125, 40, 0.16, 1.0], tail: [460, 0.85, 0.26] },
};

// 脚步声：不同地面材质的滤波参数
const STEP_SFX = {
  sand:  { f: 650, q: 0.6, g: 0.55, lp: 420 },
  stone: { f: 1300, q: 0.9, g: 0.5, lp: 700 },
  wood:  { f: 420, q: 1.2, g: 0.6, lp: 300, knock: 170 },
  metal: { f: 2400, q: 2.5, g: 0.35, lp: 900, ring: 1700 },
};

const SFX = {
  ctx: null,
  ready: false,
  voices: 0,
  MAX_VOICES: 70,
  listenerPos: new THREE.Vector3(1e6, 1e6, 1e6),   // 未初始化（或服务器上）时视为极远处

  /** 必须在用户手势（点击）里调用：创建音频上下文和总线 */
  init() {
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.knee.value = 10; this.comp.ratio.value = 5;
    this.comp.attack.value = 0.003; this.comp.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = SETTINGS.volume;
    this.deafen = ctx.createBiquadFilter();           // 闪光致盲时的"耳聋"低通
    this.deafen.type = 'lowpass'; this.deafen.frequency.value = 22000;
    this.sfx = ctx.createGain();
    this.sfx.connect(this.deafen); this.deafen.connect(this.master);
    this.ui = ctx.createGain(); this.ui.gain.value = 0.6; this.ui.connect(this.master);
    this.master.connect(this.comp); this.comp.connect(ctx.destination);

    // 2 秒白噪声缓冲，所有噪声类音效共用
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbient();
    this.ready = true;
  },

  setVolume(v) { if (this.master) this.master.gain.value = v; },
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); },
  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); },

  /** 每帧同步听者（相机）的位置与朝向 */
  updateListener(pos, fwd) {
    if (!this.ready) return;
    this.listenerPos.copy(pos);
    const L = this.ctx.listener;
    if (L.positionX) {
      L.positionX.value = pos.x; L.positionY.value = pos.y; L.positionZ.value = pos.z;
      L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    } else {
      L.setPosition(pos.x, pos.y, pos.z);
      L.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  },

  // ------------------------------------------------------------------
  //  基础构件
  // ------------------------------------------------------------------
  _track(node) { this.voices++; node.onended = () => { this.voices--; }; },

  /**
   * 获取声音的输出入口。pos 为空 → 玩家自身声音。
   * o.max 最远可听距离，o.ref 参考距离，o.occluded 是否被墙阻挡
   */
  _out(pos, o = {}) {
    if (!pos) return this.sfx;
    const dist = pos.distanceTo(this.listenerPos);
    if (dist > (o.max || 80)) return null;
    const ctx = this.ctx;
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF';
    pan.distanceModel = 'inverse';
    pan.refDistance = o.ref || 3;
    pan.rolloffFactor = o.roll !== undefined ? o.roll : 1;
    pan.maxDistance = 10000;
    if (pan.positionX) { pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z; }
    else pan.setPosition(pos.x, pos.y, pos.z);
    pan.connect(this.sfx);
    // 距离与遮挡造成的高频衰减
    let cutoff = 20000 * Math.pow(0.5, dist / (o.lpDist || 22));
    if (o.occluded) cutoff *= 0.3;
    cutoff = clamp(cutoff, 350, 20000);
    if (cutoff < 18000) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.Q.value = 0.5;
      lp.connect(pan);
      return lp;
    }
    return pan;
  },

  /** 噪声爆发：o.type 滤波类型，o.f 频率（o.f2 结束频率），o.q，o.g 音量，o.a 起音时间 */
  _noise(dest, t, dur, o) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.f || 1000, t);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + dur);
    f.Q.value = o.q !== undefined ? o.q : 0.8;
    const g = ctx.createGain();
    const a = o.a || 0.002;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.g || 0.5), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t, Math.random() * 1.5, dur + 0.05);
    this._track(src);
  },

  /** 振荡器音：o.type 波形，o.f → o.f2 频率滑动（o.fd 滑动时长），o.g 音量 */
  _tone(dest, t, dur, o) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + (o.fd || dur));
    const g = ctx.createGain();
    const a = o.a || 0.003;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.g || 0.3), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(dest);
    osc.start(t); osc.stop(t + dur + 0.05);
    this._track(osc);
  },

  _can(important) { return this.ready && (important || this.voices < this.MAX_VOICES); },

  // ------------------------------------------------------------------
  //  武器
  // ------------------------------------------------------------------
  gunshot(kind, pos, occluded) {
    if (!this._can(true)) return;
    const p = GUN_SFX[kind] || GUN_SFX.rifle;
    const dest = this._out(pos, { max: 120, ref: 6, roll: 0.9, lpDist: 30, occluded });
    if (!dest) return;
    const t = this.ctx.currentTime;
    const v = pos ? 1.25 : 0.9;
    const r = rand(0.94, 1.06);
    this._noise(dest, t, p.crack[1], { type: 'highpass', f: p.crack[0] * r, q: 0.7, g: p.crack[2] * v });
    this._noise(dest, t, p.body[1], { type: 'lowpass', f: p.body[0] * r, f2: p.body[0] * 0.35, q: 0.9, g: p.body[2] * v });
    this._tone(dest, t, p.thump[2], { type: 'sine', f: p.thump[0] * r, f2: p.thump[1], g: p.thump[3] * v });
    this._noise(dest, t + 0.012, p.tail[1], { type: 'lowpass', f: p.tail[0], f2: 160, q: 0.4, g: p.tail[2] * v, a: 0.02 });
  },
  dryFire() {
    if (!this._can()) return;
    const t = this.ctx.currentTime;
    this._noise(this.sfx, t, 0.03, { type: 'highpass', f: 3500, g: 0.25 });
    this._tone(this.sfx, t, 0.03, { type: 'square', f: 1400, f2: 900, g: 0.05 });
  },
  reloadPart(part, pos) {
    if (!this._can()) return;
    const dest = this._out(pos, { max: 12, ref: 1.5, roll: 1.4 });
    if (!dest) return;
    const t = this.ctx.currentTime;
    if (part === 'out') {
      this._noise(dest, t, 0.06, { type: 'bandpass', f: 1500, q: 2, g: 0.3 });
      this._tone(dest, t, 0.05, { type: 'triangle', f: 620, f2: 380, g: 0.12 });
    } else if (part === 'in') {
      this._noise(dest, t, 0.05, { type: 'bandpass', f: 2300, q: 2.5, g: 0.35 });
      this._noise(dest, t + 0.07, 0.05, { type: 'bandpass', f: 1800, q: 3, g: 0.3 });
      this._tone(dest, t, 0.04, { type: 'square', f: 900, g: 0.05 });
    } else { // bolt / slide
      this._noise(dest, t, 0.08, { type: 'bandpass', f: 3000, f2: 1800, q: 2, g: 0.3 });
      this._noise(dest, t + 0.12, 0.06, { type: 'bandpass', f: 2200, q: 3, g: 0.35 });
    }
  },
  deploy() {
    if (!this._can()) return;
    const t = this.ctx.currentTime;
    this._noise(this.sfx, t, 0.12, { type: 'bandpass', f: 2600, f2: 1500, q: 1.5, g: 0.18 });
  },
  knifeSwing(pos) {
    if (!this._can()) return;
    const dest = this._out(pos, { max: 12, ref: 1.5 });
    if (!dest) return;
    this._noise(dest, this.ctx.currentTime, 0.2, { type: 'bandpass', f: 700, f2: 2600, q: 1.2, g: 0.35, a: 0.03 });
  },
  knifeHit(flesh, pos) {
    if (!this._can()) return;
    const dest = this._out(pos, { max: 15, ref: 1.5 });
    if (!dest) return;
    const t = this.ctx.currentTime;
    if (flesh) {
      this._noise(dest, t, 0.12, { type: 'lowpass', f: 900, g: 0.8 });
      this._tone(dest, t, 0.1, { f: 180, f2: 90, g: 0.45 });
    } else {
      this._noise(dest, t, 0.08, { type: 'bandpass', f: 2800, q: 3, g: 0.5 });
      this._tone(dest, t, 0.18, { type: 'triangle', f: 2100, g: 0.08 });
    }
  },
  /** 子弹擦身而过的"嗖"声 */
  whiz(pos) {
    if (!this._can()) return;
    const dest = this._out(pos, { max: 6, ref: 1, roll: 0.5 });
    if (!dest) return;
    this._noise(dest, this.ctx.currentTime, 0.09, { type: 'bandpass', f: 4200, f2: 1500, q: 2.5, g: 0.5, a: 0.01 });
  },
  impact(material, pos) {
    if (!this._can()) return;
    const dest = this._out(pos, { max: 22, ref: 1.5, roll: 1.3 });
    if (!dest) return;
    const t = this.ctx.currentTime;
    if (material === 'metal') {
      this._tone(dest, t, 0.12, { type: 'triangle', f: rand(1800, 2600), g: 0.1 });
      this._noise(dest, t, 0.04, { type: 'highpass', f: 4000, g: 0.25 });
    } else if (material === 'wood') {
      this._noise(dest, t, 0.06, { type: 'bandpass', f: 900, q: 1.5, g: 0.35 });
    } else {
      this._noise(dest, t, 0.05, { type: 'bandpass', f: 2200, q: 1, g: 0.25 });
    }
  },

  // ------------------------------------------------------------------
  //  命中反馈
  // ------------------------------------------------------------------
  hitConfirm(head, helmet) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    if (head && helmet) {       // 爆头打在头盔上的"叮"
      this._tone(this.ui, t, 0.16, { f: 2600, g: 0.22 });
      this._tone(this.ui, t, 0.12, { f: 3900, g: 0.12 });
      this._noise(this.ui, t, 0.03, { type: 'highpass', f: 5000, g: 0.3 });
    } else if (head) {          // 无头盔爆头的闷响
      this._noise(this.ui, t, 0.09, { type: 'bandpass', f: 1600, q: 1.2, g: 0.6 });
      this._tone(this.ui, t, 0.07, { f: 420, f2: 200, g: 0.35 });
    } else {
      this._noise(this.ui, t, 0.05, { type: 'lowpass', f: 1400, g: 0.45 });
      this._tone(this.ui, t, 0.05, { f: 190, f2: 110, g: 0.25 });
    }
  },
  killConfirm(head) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._tone(this.ui, t, 0.09, { type: 'triangle', f: head ? 1320 : 990, g: 0.14 });
    this._tone(this.ui, t + 0.07, 0.14, { type: 'triangle', f: head ? 1760 : 1320, g: 0.12 });
  },
  hurt(head) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._tone(this.sfx, t, 0.16, { f: 130, f2: 60, g: 0.6 });
    this._noise(this.sfx, t, 0.12, { type: 'lowpass', f: 700, g: 0.55 });
    if (head) this._tone(this.sfx, t, 0.5, { f: 2900, g: 0.08, a: 0.02 });
  },

  // ------------------------------------------------------------------
  //  移动
  // ------------------------------------------------------------------
  footstep(pos, surface, vol = 1, occluded = false) {
    if (!this._can(!pos)) return;
    const s = STEP_SFX[surface] || STEP_SFX.sand;
    const dest = this._out(pos, { max: 30, ref: 2.2, roll: 1.25, lpDist: 18, occluded });
    if (!dest) return;
    const t = this.ctx.currentTime;
    const g = s.g * vol * (pos ? 1.35 : 0.42);
    this._noise(dest, t, 0.05, { type: 'bandpass', f: s.f * rand(0.85, 1.2), q: s.q, g });
    this._noise(dest, t + 0.028, 0.07, { type: 'lowpass', f: s.lp * rand(0.9, 1.1), q: 0.5, g: g * 0.7 });
    if (s.knock) this._tone(dest, t, 0.06, { type: 'triangle', f: s.knock * rand(0.9, 1.1), f2: s.knock * 0.7, g: g * 0.5 });
    if (s.ring) this._tone(dest, t, 0.14, { f: s.ring * rand(0.9, 1.15), g: g * 0.12 });
  },
  land(pos, hard, surface) {
    if (!this._can()) return;
    const dest = this._out(pos, { max: 30, ref: 2.2, roll: 1.2 });
    if (!dest) return;
    const t = this.ctx.currentTime;
    const g = (pos ? 1.2 : 0.55) * (hard ? 1 : 0.6);
    this._noise(dest, t, 0.12, { type: 'lowpass', f: surface === 'metal' ? 1500 : 500, g });
    this._tone(dest, t, 0.1, { f: 110, f2: 55, g: g * 0.6 });
  },

  // ------------------------------------------------------------------
  //  投掷物
  // ------------------------------------------------------------------
  pinPull() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._tone(this.sfx, t, 0.04, { type: 'triangle', f: 2600, g: 0.12 });
    this._noise(this.sfx, t + 0.05, 0.05, { type: 'highpass', f: 4200, g: 0.2 });
  },
  throwNade(pos) {
    if (!this._can()) return;
    const dest = this._out(pos, { max: 15, ref: 2 });
    if (!dest) return;
    this._noise(dest, this.ctx.currentTime, 0.22, { type: 'bandpass', f: 500, f2: 1600, q: 1, g: 0.3, a: 0.04 });
  },
  bounce(pos, speed) {
    if (!this._can()) return;
    const dest = this._out(pos, { max: 25, ref: 2, roll: 1.1 });
    if (!dest) return;
    const t = this.ctx.currentTime;
    const g = clamp(speed / 12, 0.08, 0.6);
    this._tone(dest, t, 0.09, { type: 'triangle', f: rand(1500, 2200), g: g * 0.5 });
    this._tone(dest, t, 0.06, { f: rand(2600, 3300), g: g * 0.3 });
    this._noise(dest, t, 0.03, { type: 'highpass', f: 3000, g: g * 0.6 });
  },
  explosion(pos, big) {
    if (!this.ready) return;
    const dest = this._out(pos, { max: 200, ref: big ? 14 : 8, roll: 0.8, lpDist: 45 });
    if (!dest) return;
    const t = this.ctx.currentTime;
    const k = big ? 1.5 : 1;
    this._noise(dest, t, 1.4 * k, { type: 'lowpass', f: 4500, f2: 120, q: 0.6, g: 1.3 });
    this._tone(dest, t, 0.9 * k, { f: 75, f2: 26, g: 1.2 });
    this._noise(dest, t, 0.25, { type: 'highpass', f: 1800, g: 0.8 });
    for (let i = 0; i < (big ? 8 : 4); i++) this._noise(dest, t + 0.05 + Math.random() * 0.5 * k, 0.12, { type: 'bandpass', f: rand(600, 2000), q: 1, g: 0.3 });
  },
  flashPop(pos) {
    if (!this.ready) return;
    const dest = this._out(pos, { max: 90, ref: 6, roll: 0.9 });
    if (!dest) return;
    const t = this.ctx.currentTime;
    this._noise(dest, t, 0.18, { type: 'highpass', f: 1800, g: 1.1 });
    this._tone(dest, t, 0.12, { type: 'square', f: 1400, f2: 180, g: 0.3 });
    this._noise(dest, t + 0.02, 0.6, { type: 'lowpass', f: 1200, f2: 200, g: 0.4 });
  },
  smokePop(pos) {
    if (!this.ready) return;
    const dest = this._out(pos, { max: 50, ref: 3 });
    if (!dest) return;
    const t = this.ctx.currentTime;
    this._noise(dest, t, 0.1, { type: 'lowpass', f: 900, g: 0.6 });
    this._noise(dest, t + 0.05, 3.2, { type: 'bandpass', f: 2600, q: 0.4, g: 0.35, a: 0.15 });
  },
  /** 闪光耳鸣 + 耳聋低通，intensity 0~1 */
  flashRing(duration, intensity) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._tone(this.ui, t, duration, { f: 3400, g: 0.14 * intensity, a: 0.05 });
    const f = this.deafen.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(clamp(9000 * (1 - intensity), 500, 20000), t);
    f.exponentialRampToValueAtTime(22000, t + duration);
  },

  // ------------------------------------------------------------------
  //  炸弹
  // ------------------------------------------------------------------
  bombBeep(pos) {
    if (!this.ready) return;
    const dest = this._out(pos, { max: 60, ref: 4, roll: 0.9 });
    if (!dest) return;
    const t = this.ctx.currentTime;
    this._tone(dest, t, 0.11, { type: 'square', f: 2050, g: 0.1 });
    this._tone(dest, t, 0.11, { f: 2050, g: 0.25 });
  },
  keypad(pos) {
    if (!this.ready) return;
    const dest = this._out(pos, { max: 25, ref: 2 });
    if (!dest) return;
    this._tone(dest, this.ctx.currentTime, 0.07, { type: 'square', f: pick([1300, 1500, 1700, 1900]), g: 0.08 });
  },
  defuseTick(pos) {
    if (!this.ready) return;
    const dest = this._out(pos, { max: 25, ref: 2 });
    if (!dest) return;
    const t = this.ctx.currentTime;
    this._noise(dest, t, 0.04, { type: 'bandpass', f: 3000, q: 3, g: 0.25 });
  },

  // ------------------------------------------------------------------
  //  界面与氛围
  // ------------------------------------------------------------------
  uiSound(kind) {
    if (!this.ready) return;
    const t = this.ctx.currentTime, u = this.ui;
    switch (kind) {
      case 'click': this._tone(u, t, 0.04, { type: 'triangle', f: 900, g: 0.15 }); break;
      case 'hover': this._tone(u, t, 0.025, { type: 'triangle', f: 1300, g: 0.05 }); break;
      case 'buy':
        this._tone(u, t, 0.06, { type: 'triangle', f: 1100, g: 0.2 });
        this._tone(u, t + 0.05, 0.09, { type: 'triangle', f: 1650, g: 0.18 });
        this._noise(u, t, 0.08, { type: 'bandpass', f: 3000, q: 2, g: 0.15 });
        break;
      case 'deny': this._tone(u, t, 0.16, { type: 'square', f: 200, g: 0.08 }); break;
      case 'roundStart':
        this._tone(u, t, 0.12, { type: 'triangle', f: 660, g: 0.2 });
        this._tone(u, t + 0.13, 0.25, { type: 'triangle', f: 990, g: 0.2 });
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this._tone(u, t + i * 0.11, 0.5, { type: 'triangle', f, g: 0.16 }));
        break;
      case 'lose':
        [440, 349, 294, 220].forEach((f, i) => this._tone(u, t + i * 0.14, 0.55, { type: 'triangle', f, g: 0.15 }));
        break;
      case 'planted':
        [880, 880, 1175].forEach((f, i) => this._tone(u, t + i * 0.16, 0.14, { type: 'square', f, g: 0.07 }));
        break;
      case 'tick': this._tone(u, t, 0.05, { f: 1600, g: 0.1 }); break;
    }
  },
  /** 环境风声：循环噪声 + 低频 LFO 调制滤波器 */
  startAmbient() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420; f.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.value = 0.045;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 180;
    lfo.connect(lfoG); lfoG.connect(f.frequency);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(); lfo.start();
    this.ambientGain = g;
  },
};
