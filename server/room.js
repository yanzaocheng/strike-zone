'use strict';
// =====================================================================
//  Strike Zone 联机房间（运行在 worker 线程中）
//  本文件由 build.js 自动生成：srv_head + 游戏模拟模块 + srv_room，请勿直接修改
// =====================================================================
const { parentPort, workerData } = require('worker_threads');
const THREE = require('three');
globalThis.location = { search: '' };

// #####################################################################
// ## 模块文件：00_config.js
// #####################################################################
// =====================================================================
//  00 配置模块：所有可调的游戏参数集中在这里
//  单位约定：长度=米，时间=秒，角度=度（运行时转弧度）
// =====================================================================

/** 是否运行在服务器（Node.js 房间线程）中 */
const IS_SERVER = typeof window === 'undefined';
/** 运行模式：'sp' 单机；'client' 联机客户端；'server' 联机服务器 */
const NET = { mode: IS_SERVER ? 'server' : 'sp' };

const CFG = {
  DEBUG: !IS_SERVER && /[?&]debug/.test(location.search),   // URL 带 ?debug 时开启调试接口
  // ---- 联机 ----
  NETCFG: {
    URL: 'wss://strike.predix.icu/ws',   // 默认游戏服务器（可用 ?server=ws://... 覆盖）
    SNAP_RATE: 30,                       // 服务器快照频率（次/秒）
    SEND_RATE: 30,                       // 客户端上报频率（次/秒）
    INTERP: 0.1,                         // 其他玩家的插值延迟（秒）
  },
  CELL: 1.6,                                  // 地图 ASCII 每格对应的实际尺寸（米）
  GRAVITY: 20,                                // 重力（米/秒²），接近 CS 的 800u/s²
  TEAM_SIZE: 5,                               // 敌方 Bot 数量

  // ---- 角色碰撞与移动（Source 引擎风格的加速度/摩擦模型） ----
  PLAYER: {
    HALF_W: 0.4,            // 碰撞盒半宽
    HEIGHT: 1.83,           // 站立高度
    CROUCH_HEIGHT: 1.37,    // 下蹲高度
    EYE: 1.64,              // 站立视高
    CROUCH_EYE: 1.18,       // 下蹲视高
    JUMP_VEL: 7.2,          // 起跳速度 → 跳高约 1.3 米
    STEP: 0.45,             // 可自动跨上的台阶高度
    BASE_SPEED: 6.35,       // 持刀满速（≈250u/s），各武器按 speed/250 缩放
    ACCEL: 5.5,             // 地面加速度系数（sv_accelerate）
    AIR_ACCEL: 12,          // 空中加速度系数（sv_airaccelerate）
    AIR_CAP: 0.76,          // 空中期望速度上限（允许少量空中转向）
    FRICTION: 5.2,          // 地面摩擦（sv_friction）
    STOP_SPEED: 2.0,        // 摩擦计算的最低速度（sv_stopspeed）
    WALK_MULT: 0.52,        // 静步速度倍率
    CROUCH_MULT: 0.34,      // 下蹲速度倍率
    TAG_MULT: 0.45,         // 中弹减速倍率（CS 的 tagging）
    TAG_TIME: 0.35,
  },

  // ---- 回合与炸弹 ----
  ROUND: {
    FREEZE_TIME: 6,         // 冻结时间（可购买、不可移动）
    ROUND_TIME: 115,        // 回合时间 1:55
    BUY_TIME: 20,           // 冻结结束后仍可购买的时间
    END_DELAY: 5,           // 回合结束后 5 秒开始下一回合
    BOMB_TIME: 40,          // 炸弹倒计时
    PLANT_TIME: 5,          // 安放炸弹需按住 E 的时间
    DEFUSE_TIME: 10,        // 拆弹时间
    DEFUSE_KIT_TIME: 5,     // 有拆弹器的拆弹时间
    BOMB_RADIUS: 17,        // 炸弹爆炸半径
    BOMB_DAMAGE: 500,
  },

  // ---- 经济（参考 CS:GO 规则） ----
  ECON: {
    START: 800,
    MAX: 16000,
    WIN_ELIM: 3250,         // 全灭对手获胜
    WIN_BOMB: 3500,         // 炸弹爆炸获胜
    WIN_DEFUSE: 3500,       // 拆弹获胜
    WIN_TIME: 3250,         // 时间耗尽（CT）获胜
    LOSS: [1400, 1900, 2400, 2900, 3400],  // 连败补偿
    PLANT_BONUS: 300,       // 安放炸弹的个人奖励
    PLANT_TEAM_BONUS: 800,  // T 输掉回合但成功下包时的团队额外奖励
    DEFUSE_BONUS: 300,      // 拆弹个人奖励
  },

  // ---- 投掷物 ----
  NADE: {
    THROW_SPEED: 17.5,      // 左键远投初速
    LOB_SPEED: 7.5,         // 右键近抛初速
    MID_SPEED: 12.5,        // 左右键同按：中等距离
    RADIUS: 0.07,
    BOUNCE: 0.45,           // 反弹系数
    FRICTION: 0.72,         // 接触时切向保留比例
    HE_FUSE: 1.6,
    FLASH_FUSE: 1.5,
    HE_DAMAGE: 98,
    HE_RADIUS: 9.5,
    FLASH_TIME: 4.8,        // 正对闪光时最长致盲时间
    SMOKE_RADIUS: 4.4,
    SMOKE_TIME: 18,
    SMOKE_BLOOM: 1.4,       // 烟雾从炸开到完全展开的时间
  },
};

// ---- Bot 难度预设 ----
//  reaction：发现目标后的反应时间区间；errInit：初始瞄准误差（度）；
//  errDecay：误差衰减速度；errMin：稳定后残余误差；turnSpeed：最大转身速度（度/秒）；
//  headChance：瞄头概率；spray：压枪能力（0~1）；
const DIFFICULTY = {
  easy:   { name: '简单', reaction: [0.65, 0.90], errInit: 9.0, errDecay: 1.4, errMin: 2.4, turnSpeed: 160, headChance: 0.08, spray: 0.10, hearing: 0.7, burst: 0.7 },
  normal: { name: '普通', reaction: [0.42, 0.60], errInit: 6.0, errDecay: 2.2, errMin: 1.4, turnSpeed: 260, headChance: 0.18, spray: 0.35, hearing: 1.0, burst: 1.0 },
  hard:   { name: '困难', reaction: [0.30, 0.42], errInit: 4.2, errDecay: 3.0, errMin: 0.9, turnSpeed: 380, headChance: 0.30, spray: 0.60, hearing: 1.15, burst: 1.2 },
  expert: { name: '专家', reaction: [0.22, 0.30], errInit: 3.0, errDecay: 3.8, errMin: 0.55, turnSpeed: 500, headChance: 0.42, spray: 0.80, hearing: 1.3, burst: 1.4 },
};

// ---- 玩家设置（保存在 localStorage） ----
const DEFAULT_SETTINGS = {
  sens: 2.0,              // 灵敏度（与 CS 的数值手感接近：每像素 sens×0.022 度）
  zoomSens: 1.0,          // 开镜灵敏度倍率
  invertY: false,
  fov: 74,                // 垂直视野（16:9 下约等于 CS 默认视野）
  volume: 0.8,
  quality: 'medium',      // low / medium / high
  difficulty: 'normal',
  teammates: 0,           // 队友 Bot 数量（0 = 1v5）
  winRounds: 8,           // 先赢 N 回合者获胜
  crossColor: '#4dff7a',
  crossSize: 6,
  crossGap: 3,
  crossThick: 2,
  crossDot: false,
  crossDynamic: true,     // 准星随扩散变化
  trajectory: true,       // 投掷物轨迹预览
  showFps: true,
  fullscreen: true,       // 开始游戏时进入全屏并锁定键盘（防止 Ctrl+W 关闭页面）
  mpName: '',             // 联机昵称
};

const SETTINGS = (() => {
  const s = Object.assign({}, DEFAULT_SETTINGS);
  try {
    const saved = JSON.parse(localStorage.getItem('strikezone.settings') || '{}');
    for (const k in saved) if (k in DEFAULT_SETTINGS && typeof saved[k] === typeof DEFAULT_SETTINGS[k]) s[k] = saved[k];
  } catch (e) { /* 本地存储不可用时使用默认设置 */ }
  return s;
})();

function saveSettings() {
  try { localStorage.setItem('strikezone.settings', JSON.stringify(SETTINGS)); } catch (e) { /* 忽略 */ }
}


// #####################################################################
// ## 模块文件：01_utils.js
// #####################################################################
// =====================================================================
//  01 工具模块：数学函数、随机数、可平铺噪声、简单事件总线
// =====================================================================

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function rand(a = 0, b = 1) { return a + Math.random() * (b - a); }
function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function chance(p) { return Math.random() < p; }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
  return arr;
}
/** 角度归一化到 (-PI, PI] */
function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
/** 帧率无关的指数平滑：lambda 越大越快 */
function damp(cur, target, lambda, dt) { return lerp(cur, target, 1 - Math.exp(-lambda * dt)); }
function dampAngle(cur, target, lambda, dt) { return cur + wrapAngle(target - cur) * (1 - Math.exp(-lambda * dt)); }
function smoothstep(e0, e1, x) { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); }
function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
/** 由 (yaw, pitch) 得到朝向单位向量（与相机约定一致：yaw=0 朝 -Z） */
function dirFromAngles(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  return out;
}
/** 由方向向量求 yaw（水平朝向） */
function yawOf(dx, dz) { return Math.atan2(-dx, -dz); }

// ---- 可复现的伪随机数（mulberry32） ----
class RNG {
  constructor(seed) { this.s = (seed >>> 0) || 1; }
  next() {
    let t = (this.s += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
}

// ---- 整数哈希 → [0,1) ----
function hash2(x, y, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * 可平铺的值噪声：晶格坐标对 period 取模，保证纹理首尾无缝衔接。
 * x、y 为晶格坐标（0..period）
 */
function tileNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % period) + period) % period, y0 = ((yi % period) + period) % period;
  const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
/** 分形噪声（fbm），px/py 为 0..1 的纹理坐标，basePeriod 为最低频的晶格数 */
function tileFbm(px, py, basePeriod, octaves, seed) {
  let sum = 0, amp = 0.5, norm = 0, p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += tileNoise(px * p, py * p, p, seed + o * 101) * amp;
    norm += amp; amp *= 0.5; p *= 2;
  }
  return sum / norm;
}

// ---- 极简事件总线：模块之间解耦（HUD、音效、AI 听觉都订阅游戏事件） ----
const Events = {
  map: new Map(),
  on(name, fn) { if (!this.map.has(name)) this.map.set(name, []); this.map.get(name).push(fn); },
  emit(name, data) { const arr = this.map.get(name); if (arr) for (let i = 0; i < arr.length; i++) arr[i](data); },
};

// ---- 复用的临时向量，避免每帧分配造成 GC 卡顿 ----
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3();
const _m4 = new THREE.Matrix4(), _q1 = new THREE.Quaternion(), _e1 = new THREE.Euler();

/** 全局时间（秒，暂停时不增长），由主循环维护 */
const Clock = { time: 0, dt: 0, frame: 0 };


// #####################################################################
// ## 模块文件：02_audio.js
// #####################################################################
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


// #####################################################################
// ## 模块文件：03_textures.js
// #####################################################################
// =====================================================================
//  03 程序化纹理模块：用 Canvas 2D 在运行时绘制所有贴图（无外部图片）
//  地面/墙面纹理使用可平铺噪声，保证重复时无接缝
// =====================================================================

const Tex = {
  anisotropy: 1,
  t: {},          // 已生成的纹理表

  _canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h || w; return c; },
  _finish(canvas, repeat = true) {
    const tex = new THREE.CanvasTexture(canvas);
    if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.anisotropy;
    return tex;
  },
  /** 逐像素绘制：fn(u, v, x, y, out) 往 out 写入 [r,g,b,a] */
  _pixels(ctx, w, h, fn) {
    const img = ctx.createImageData(w, h);
    const d = img.data;
    const out = [0, 0, 0, 255];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        out[3] = 255;
        fn(x / w, y / h, x, y, out);
        const i = (y * w + x) * 4;
        d[i] = out[0]; d[i + 1] = out[1]; d[i + 2] = out[2]; d[i + 3] = out[3];
      }
    }
    ctx.putImageData(img, 0, 0);
  },
  _set(out, base, k) {
    out[0] = clamp(base[0] * k, 0, 255); out[1] = clamp(base[1] * k, 0, 255); out[2] = clamp(base[2] * k, 0, 255);
  },
  /** 在平铺纹理上画圆点（跨边界时在对侧补画，保证无缝） */
  _wrapDot(ctx, S, x, y, r, style) {
    ctx.fillStyle = style;
    for (let ox = -S; ox <= S; ox += S) for (let oy = -S; oy <= S; oy += S) {
      if (x + ox + r < 0 || x + ox - r > S || y + oy + r < 0 || y + oy - r > S) continue;
      ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, TAU); ctx.fill();
    }
  },

  init(renderer) {
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const t = this.t;
    t.sand = this.sand();
    t.dirt = this.sand([176, 146, 104], 7);
    t.plaster = this.plaster();
    t.stone = this.blocks([196, 174, 132], 17, 128, 64);
    t.brick = this.bricks();
    t.tiles = this.tiles();
    t.dark = this.blocks([118, 114, 106], 31, 64, 32, 256);
    t.concrete = this.concrete();
    t.crate = this.crate();
    t.planks = this.planks();
    t.metal = this.metal();
    t.soft = this.softCircle();
    t.smoke = this.smokePuff();
    t.muzzle = this.muzzleFlash();
    t.hole = this.bulletHole();
    t.blood = this.bloodSplat();
    t.scorch = this.scorch();
  },

  // ------------------------------------------------------------------
  //  场景纹理
  // ------------------------------------------------------------------
  sand(base = [200, 170, 120], seed = 3) {
    const S = 512, c = this._canvas(S), ctx = c.getContext('2d');
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const n = tileFbm(u, v, 4, 5, seed);
      const n2 = tileFbm(u, v, 32, 3, seed + 50);
      const k = 0.8 + n * 0.32 + (n2 - 0.5) * 0.14 + (Math.random() - 0.5) * 0.09;
      this._set(o, base, k);
    });
    const rng = new RNG(seed * 7);
    for (let i = 0; i < 420; i++) {
      const r = rng.range(0.6, 2.4), l = rng.next() < 0.5;
      this._wrapDot(ctx, S, rng.range(0, S), rng.range(0, S), r, l ? 'rgba(255,240,210,.35)' : 'rgba(70,50,30,.30)');
    }
    return this._finish(c);
  },

  plaster() {
    const S = 512, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [214, 190, 146], worn = [188, 160, 118];
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const n = tileFbm(u, v, 3, 5, 21);
      const n2 = tileFbm(u, v, 24, 3, 22);
      const b = smoothstep(0.62, 0.8, tileFbm(u, v, 5, 4, 23)) * 0.7;
      const k = 0.9 + n * 0.12 + (n2 - 0.5) * 0.08 + (Math.random() - 0.5) * 0.05;
      o[0] = clamp(lerp(base[0], worn[0], b) * k, 0, 255);
      o[1] = clamp(lerp(base[1], worn[1], b) * k, 0, 255);
      o[2] = clamp(lerp(base[2], worn[2], b) * k, 0, 255);
    });
    // 裂纹（保持在中间区域，避免破坏平铺）
    const rng = new RNG(99);
    ctx.strokeStyle = 'rgba(70,52,34,.35)'; ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      let x = rng.range(80, S - 80), y = rng.range(80, S - 80);
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let k = 0; k < 12; k++) { x += rng.range(-9, 9); y += rng.range(-2, 11); ctx.lineTo(x, y); }
      ctx.stroke();
    }
    return this._finish(c);
  },

  /** 石块墙（错缝砌筑） */
  blocks(base, seed, bw, bh, S = 512) {
    const c = this._canvas(S), ctx = c.getContext('2d');
    const mortar = 3;
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const row = Math.floor(y / bh);
      const off = (row % 2) * (bw / 2);
      const bx = Math.floor(((x + off) % S) / bw);
      const lx = (x + off) % bw, ly = y % bh;
      const n = tileFbm(u, v, 8, 4, seed);
      if (lx < mortar || ly < mortar) {
        this._set(o, base, 0.62 + n * 0.15);
        return;
      }
      const tint = 0.85 + hash2(bx, row, seed) * 0.28;
      let k = tint * (0.86 + n * 0.22 + (Math.random() - 0.5) * 0.06);
      // 边缘倒角：左上亮、右下暗
      if (lx < mortar + 4 || ly < mortar + 4) k *= 1.08;
      else if (lx > bw - 5 || ly > bh - 5) k *= 0.88;
      this._set(o, base, k);
    });
    return this._finish(c);
  },

  bricks() {
    const S = 512, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [158, 92, 64], mortar = [176, 164, 146];
    const bw = 64, bh = 32;
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const row = Math.floor(y / bh);
      const off = (row % 2) * (bw / 2);
      const bx = Math.floor(((x + off) % S) / bw);
      const lx = (x + off) % bw, ly = y % bh;
      const n = tileFbm(u, v, 16, 3, 41);
      if (lx < 3 || ly < 3) { this._set(o, mortar, 0.8 + n * 0.2); return; }
      const h = hash2(bx, row, 42);
      const k = (0.78 + h * 0.34) * (0.88 + n * 0.2 + (Math.random() - 0.5) * 0.08);
      o[0] = clamp(base[0] * k, 0, 255); o[1] = clamp((base[1] + h * 18) * k, 0, 255); o[2] = clamp((base[2] + h * 10) * k, 0, 255);
    });
    return this._finish(c);
  },

  tiles() {
    const S = 512, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [196, 178, 142];
    const ts = 128, grout = 4;
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const tx = Math.floor(x / ts), ty = Math.floor(y / ts);
      const lx = x % ts, ly = y % ts;
      const n = tileFbm(u, v, 6, 4, 61);
      if (lx < grout || ly < grout) { this._set(o, base, 0.55 + n * 0.12); return; }
      const h = hash2(tx, ty, 62);
      const k = (0.84 + h * 0.22) * (0.88 + n * 0.2 + (Math.random() - 0.5) * 0.07);
      this._set(o, base, k);
    });
    const rng = new RNG(63);
    ctx.strokeStyle = 'rgba(60,48,32,.4)'; ctx.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const tx = rng.int(0, 3) * ts, ty = rng.int(0, 3) * ts;
      ctx.beginPath(); ctx.moveTo(tx + rng.range(10, 118), ty + 6);
      ctx.lineTo(tx + rng.range(20, 108), ty + rng.range(40, 90)); ctx.lineTo(tx + rng.range(10, 118), ty + 122);
      ctx.stroke();
    }
    return this._finish(c);
  },

  concrete() {
    const S = 256, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [156, 152, 144];
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const n = tileFbm(u, v, 4, 5, 71);
      const st = smoothstep(0.6, 0.8, tileFbm(u, v, 3, 3, 72));
      const k = (0.82 + n * 0.26 + (Math.random() - 0.5) * 0.08) * (1 - st * 0.18);
      this._set(o, base, k);
    });
    return this._finish(c);
  },

  /** 木箱：每个面完整映射一张（UV 0..1） */
  crate() {
    const S = 256, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [158, 116, 66], frame = [122, 86, 48];
    const bw = 26;
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const inFrame = x < bw || y < bw || x >= S - bw || y >= S - bw;
      const d = Math.abs((x - y)) ; // 对角支撑
      const inBrace = !inFrame && d < bw * 0.72;
      const grainDir = inFrame ? (x < bw || x >= S - bw ? x : y) : (inBrace ? (x + y) * 0.7 : y);
      const n = tileFbm(u, v, 8, 3, 81);
      const grain = 0.5 + 0.5 * Math.sin(grainDir * 0.9 + n * 14);
      let k = 0.8 + grain * 0.16 + (Math.random() - 0.5) * 0.06;
      const col = inFrame || inBrace ? frame : base;
      // 内部木板缝
      if (!inFrame && !inBrace && (y % 51) < 2) k *= 0.55;
      // 框与板交界阴影
      if (!inFrame && (x < bw + 3 || y < bw + 3 || x > S - bw - 4 || y > S - bw - 4)) k *= 0.7;
      if (!inFrame && !inBrace && d < bw * 0.72 + 3) k *= 0.72;
      this._set(o, col, k);
    });
    // 钉子
    for (const [x, y] of [[13, 13], [S - 13, 13], [13, S - 13], [S - 13, S - 13], [S / 2, 13], [S / 2, S - 13], [13, S / 2], [S - 13, S / 2]]) {
      ctx.fillStyle = 'rgba(40,36,32,.85)'; ctx.beginPath(); ctx.arc(x, y, 3, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(200,190,170,.35)'; ctx.beginPath(); ctx.arc(x - 1, y - 1, 1.2, 0, TAU); ctx.fill();
    }
    return this._finish(c);
  },

  planks() {
    const S = 256, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [140, 102, 62];
    const pw = 32;
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const p = Math.floor(x / pw);
      const lx = x % pw;
      const n = tileFbm(u, v, 4, 3, 91 + p);
      const grain = 0.5 + 0.5 * Math.sin(x * 1.3 + n * 20 + p * 3);
      let k = (0.78 + hash2(p, 0, 92) * 0.25) * (0.86 + grain * 0.14 + (Math.random() - 0.5) * 0.05);
      if (lx < 2) k *= 0.45;
      // 横向接缝
      const seam = (y + p * 83) % 256;
      if (seam < 2) k *= 0.5;
      this._set(o, base, k);
    });
    return this._finish(c);
  },

  metal() {
    const S = 256, c = this._canvas(S), ctx = c.getContext('2d');
    const base = [108, 118, 126], rust = [132, 78, 44];
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const corr = 0.82 + 0.18 * Math.sin(u * TAU * 16);
      const n = tileFbm(u, v, 5, 4, 101);
      const r = smoothstep(0.58, 0.75, tileFbm(u, v, 6, 4, 102));
      const k = corr * (0.86 + n * 0.2 + (Math.random() - 0.5) * 0.05);
      o[0] = clamp(lerp(base[0], rust[0], r) * k, 0, 255);
      o[1] = clamp(lerp(base[1], rust[1], r) * k, 0, 255);
      o[2] = clamp(lerp(base[2], rust[2], r) * k, 0, 255);
    });
    return this._finish(c);
  },

  // ------------------------------------------------------------------
  //  粒子/贴花纹理（带透明通道，不平铺）
  // ------------------------------------------------------------------
  softCircle() {
    const S = 64, c = this._canvas(S), ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    return this._finish(c, false);
  },
  smokePuff() {
    const S = 128, c = this._canvas(S), ctx = c.getContext('2d');
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const dx = u - 0.5, dy = v - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const n = tileFbm(u, v, 4, 4, 111);
      const a = clamp((1 - d) * 1.6, 0, 1) * (0.55 + n * 0.7);
      const k = 200 + n * 55;
      o[0] = k; o[1] = k; o[2] = k; o[3] = clamp(a * 255, 0, 255);
    });
    return this._finish(c, false);
  },
  muzzleFlash() {
    const S = 128, c = this._canvas(S), ctx = c.getContext('2d');
    ctx.translate(S / 2, S / 2);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 7; i++) {
      ctx.save();
      ctx.rotate(i / 7 * TAU + Math.random() * 0.3);
      const len = S * (0.32 + Math.random() * 0.16);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, 'rgba(255,235,170,1)'); g.addColorStop(0.5, 'rgba(255,170,60,.6)'); g.addColorStop(1, 'rgba(255,120,20,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(len, 0); ctx.lineTo(0, 7); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 0.24);
    g.addColorStop(0, 'rgba(255,255,230,1)'); g.addColorStop(0.5, 'rgba(255,200,90,.7)'); g.addColorStop(1, 'rgba(255,140,30,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, S * 0.24, 0, TAU); ctx.fill();
    return this._finish(c, false);
  },
  bulletHole() {
    const S = 64, c = this._canvas(S), ctx = c.getContext('2d');
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const dx = u - 0.5, dy = v - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const ang = Math.atan2(dy, dx);
      const rough = 0.32 + 0.1 * Math.sin(ang * 7) + 0.06 * Math.sin(ang * 13);
      let a = 0, k = 20;
      if (d < 0.16) { a = 1; k = 12; }
      else if (d < rough) { a = 0.75; k = 45; }
      else if (d < rough + 0.25) { a = 0.35 * (1 - (d - rough) / 0.25); k = 60; }
      o[0] = k; o[1] = k * 0.92; o[2] = k * 0.85; o[3] = a * 255;
    });
    return this._finish(c, false);
  },
  bloodSplat() {
    const S = 64, c = this._canvas(S), ctx = c.getContext('2d');
    const rng = new RNG(131);
    for (let i = 0; i < 14; i++) {
      const r = rng.range(3, 12), a = rng.range(0, TAU), d = rng.range(0, 18);
      ctx.fillStyle = `rgba(${110 + rng.int(0, 40)},8,8,${rng.range(0.6, 0.95)})`;
      ctx.beginPath(); ctx.arc(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, r, 0, TAU); ctx.fill();
    }
    return this._finish(c, false);
  },
  scorch() {
    const S = 128, c = this._canvas(S), ctx = c.getContext('2d');
    this._pixels(ctx, S, S, (u, v, x, y, o) => {
      const dx = u - 0.5, dy = v - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const n = tileFbm(u, v, 5, 4, 141);
      const a = clamp((1 - d) * (0.6 + n * 0.8), 0, 0.9);
      o[0] = 18; o[1] = 15; o[2] = 12; o[3] = a * 255;
    });
    return this._finish(c, false);
  },

  /** 墙上喷漆标识（包点字母、方向箭头）。箭头用图形绘制，不依赖字体字形 */
  sign(text, color = 'rgba(200,30,20,.88)', w = 256, h = 256, font = 190) {
    const c = this._canvas(w, h), ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.font = `900 ${font}px "Arial Black", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const arrows = { '→': 0, '↑': -Math.PI / 2, '←': Math.PI, '↓': Math.PI / 2 };
    const parts = text.split(' ').filter(Boolean);
    const aw = font * 0.95;
    const widths = parts.map(p => arrows[p] !== undefined ? aw : ctx.measureText(p).width);
    const gap = font * 0.18;
    let x = w / 2 - (widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1)) / 2;
    parts.forEach((p, i) => {
      const cx = x + widths[i] / 2, cy = h / 2;
      if (arrows[p] !== undefined) {
        ctx.save(); ctx.translate(cx, cy); ctx.rotate(arrows[p]);
        const L = aw * 0.5, t = font * 0.13, hd = font * 0.32;
        ctx.beginPath();
        ctx.moveTo(-L, -t); ctx.lineTo(L - hd, -t); ctx.lineTo(L - hd, -hd); ctx.lineTo(L, 0);
        ctx.lineTo(L - hd, hd); ctx.lineTo(L - hd, t); ctx.lineTo(-L, t); ctx.closePath(); ctx.fill();
        ctx.restore();
      } else ctx.fillText(p, cx, cy + font * 0.04);
      x += widths[i] + gap;
    });
    // 喷漆的斑驳感：随机擦除
    ctx.globalCompositeOperation = 'destination-out';
    const rng = new RNG(text.length * 17 + w);
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = `rgba(0,0,0,${rng.range(0.2, 0.7)})`;
      ctx.beginPath(); ctx.arc(rng.range(0, w), rng.range(0, h), rng.range(0.5, 3), 0, TAU); ctx.fill();
    }
    const tex = this._finish(c, false);
    return tex;
  },
};


// #####################################################################
// ## 模块文件：04_map.js
// #####################################################################
// =====================================================================
//  04 地图模块：地图《沙堡 de_sandfort》
//  - ASCII 网格描述墙体/地面/楼梯/地道，每格 CFG.CELL 米
//  - 道具（箱子、车辆、集装箱…）、Bot 战术点位、区域名、包点、出生点
//  - MapBuilder：把网格合并成少量大网格（按材质合批），同时生成碰撞盒
// =====================================================================
//
//  图例：#=墙  .=地面  :=高台(1.2m)  A=A包点(高台)  B=B包点  T=T出生点  C=CT出生点
//        t=有顶地道  d=门框(头顶有横梁)  > < ^ v = 楼梯（箭头指向上坡方向）
//
//  坐标：列 c 向东(+X)，行 r 向南(+Z)。地图中心在世界原点。
//
const MAP = {
  W: 44, H: 44,
  C: CFG.CELL,
  rows: [
    '############################################', // 0
    '#::::BBBBBBB####CCCCCCCCCCCC####AAAAAAAAAAA#', // 1
    '#::::BBBBBBB####CCCCCCCCCCCCCC>>AAAAAAAAAAA#', // 2
    '#^^^^BBBBBBB####CCCCCCCCCCCCCC>>AAAAAAAAAAA#', // 3
    '#^^^^BBBBBBB####CCCCCCCCCCCCCC>>AAAAAAAAAAA#', // 4
    '#BBBBBBBBBBB####CCCCCCCCCCCCCC>>AAAAAAAAAAA#', // 5
    '#BBBBBBBBBBB####CCCCCCCCCCCC####AAAAAAAAAAA#', // 6
    '#BBBBBBBBBBB######.......#######AAAAAAAAAAA#', // 7
    '#BBBBBBBBBBB..d..........#######AAAAAAAAAAA#', // 8
    '#BBBBBBBBBBB..d..........#######AAAAAAAAAAA#', // 9
    '#BBBBBBBBBBB..d..........#::::::AAAAAAAAAAA#', // 10
    '#BBBBBBBBBBB######.......#::::::AAAAAAAAAAA#', // 11
    '####ttt###########.......#::::#######^^^^^^#', // 12
    '####ttt############.....##::::#######^^^^^^#', // 13
    '####ttt############.....##::::#######......#', // 14
    '####ttt############.....##::::#######......#', // 15
    '####ttt############.....>>::::#######......#', // 16
    '####ttt############.....>>::::#######......#', // 17
    '####ttt############.....>>::::#######......#', // 18
    '####ttt############.....#############......#', // 19
    '####ttt############.....#############......#', // 20
    '####ttt############.....#############......#', // 21
    '####ttttttttttttttt.....#############......#', // 22
    '####ttttttttttttttt.....#############......#', // 23
    '####ttt############.....#############......#', // 24
    '####ttt############.....#############......#', // 25
    '####ttt##############dd##############......#', // 26
    '####ttt###########......#############......#', // 27
    '###.....##########..###.#############......#', // 28  ← 中门后的掩体墙，挡住出生点之间的直线视野
    '###.....##########..###.#############......#', // 29
    '###.....##########......###############dd###', // 30
    '###.....############...##############......#', // 31
    '###.....############...##############......#', // 32
    '###.....############...##############......#', // 33
    '###.....############...##############......#', // 34
    '###.....#######TTTTTTTTTTTTTT########......#', // 35
    '###............TTTTTTTTTTTTTT..............#', // 36
    '###............TTTTTTTTTTTTTT..............#', // 37
    '###............TTTTTTTTTTTTTT..............#', // 38
    '###............TTTTTTTTTTTTTT..............#', // 39
    '###............TTTTTTTTTTTTTT..............#', // 40
    '###############TTTTTTTTTTTTTT###############', // 41
    '###############TTTTTTTTTTTTTT###############', // 42
    '############################################', // 43
  ],
  LEVEL: { ':': 1.2, 'A': 1.2 },
  // 地面材质（渲染）与脚步声类型
  FLOOR: {
    '.': ['dirt', 'sand'], 'd': ['dirt', 'sand'], 'T': ['sand', 'sand'], 'C': ['concrete', 'stone'],
    'B': ['stoneFloor', 'stone'], 'A': ['tiles', 'stone'], ':': ['planks', 'wood'], 't': ['darkFloor', 'stone'],
  },

  at(c, r) { return (c < 0 || r < 0 || c >= this.W || r >= this.H) ? '#' : this.rows[r][c]; },
  isWall(c, r) { return this.at(c, r) === '#'; },
  isStair(ch) { return ch === '>' || ch === '<' || ch === '^' || ch === 'v'; },
  /** 平地格子的地面高度（楼梯/墙返回 NaN） */
  level(c, r) {
    const ch = this.at(c, r);
    if (ch === '#' || this.isStair(ch)) return NaN;
    return this.LEVEL[ch] || 0;
  },
  wx(c) { return (c - this.W / 2) * this.C; },   // 格子坐标（可为小数）→ 世界 X
  wz(r) { return (r - this.H / 2) * this.C; },
  cx(x) { return x / this.C + this.W / 2; },     // 世界 X → 格子坐标（小数）
  cz(z) { return z / this.C + this.H / 2; },
  surfaceAt(x, z) {
    const ch = this.at(Math.floor(this.cx(x)), Math.floor(this.cz(z)));
    if (this.isStair(ch)) return 'stone';
    return (this.FLOOR[ch] || this.FLOOR['.'])[1];
  },
  areaAt(x, z) {
    const c = this.cx(x), r = this.cz(z);
    for (const a of this.AREAS) if (c >= a.c1 && c < a.c2 && r >= a.r1 && r < a.r2) return a;
    return null;
  },
  /** 世界坐标是否在某个矩形（格子单位）内 */
  inRect(x, z, rc) {
    const c = this.cx(x), r = this.cz(z);
    return c >= rc[0] && c <= rc[2] && r >= rc[1] && r <= rc[3];
  },

  // ---------------- 区域名（HUD 位置显示 + AI 判断战线），先匹配者优先 ----------------
  AREAS: [
    { id: 'bsite', name: 'B 包点', c1: 1, r1: 1, c2: 12, r2: 12, lane: 'B' },
    { id: 'bdoors', name: 'B 门', c1: 12, r1: 7, c2: 18, r2: 12, lane: 'B' },
    { id: 'tunU', name: '上地道', c1: 3, r1: 12, c2: 7, r2: 28, lane: 'B' },
    { id: 'tunL', name: '下地道', c1: 7, r1: 21, c2: 19, r2: 25, lane: 'mid' },
    { id: 'tunOut', name: '地道外', c1: 3, r1: 28, c2: 15, r2: 41, lane: 'B' },
    { id: 'tspawn', name: 'T 出生点', c1: 15, r1: 35, c2: 29, r2: 43, lane: 'T' },
    { id: 'topmid', name: '中路上方', c1: 18, r1: 26, c2: 24, r2: 35, lane: 'mid' },
    { id: 'mid', name: '中路', c1: 19, r1: 13, c2: 24, r2: 26, lane: 'mid' },
    { id: 'ctmid', name: 'CT 中路', c1: 18, r1: 7, c2: 25, r2: 13, lane: 'mid' },
    { id: 'ctspawn', name: 'CT 出生点', c1: 16, r1: 1, c2: 30, r2: 7, lane: 'CT' },
    { id: 'ctramp', name: 'CT 坡道', c1: 30, r1: 1, c2: 32, r2: 7, lane: 'A' },
    { id: 'short', name: '小道', c1: 24, r1: 9, c2: 32, r2: 20, lane: 'A' },
    { id: 'asite', name: 'A 包点', c1: 32, r1: 1, c2: 43, r2: 12, lane: 'A' },
    { id: 'long', name: 'A 大道', c1: 37, r1: 12, c2: 43, r2: 30, lane: 'A' },
    { id: 'longdoor', name: '大道门', c1: 37, r1: 30, c2: 43, r2: 31, lane: 'A' },
    { id: 'outlong', name: '大道外', c1: 29, r1: 31, c2: 43, r2: 41, lane: 'A' },
  ],

  // ---------------- 包点（可安放炸弹的矩形，格子单位 [c1,r1,c2,r2]） ----------------
  BOMBSITES: {
    A: { id: 'A', rect: [32.6, 1.3, 42.7, 11.0], center: [37.2, 6.2] },
    B: { id: 'B', rect: [1.3, 3.2, 11.7, 11.4], center: [6.2, 7.0] },
  },
  BUYZONE: { T: [14.8, 34.8, 29.2, 43], CT: [15.8, 0.8, 30.2, 7.2] },
  SPAWNS: {
    T: [[17.5, 38.5], [19.6, 39.6], [21.6, 38.3], [23.6, 39.6], [25.2, 38.2], [18.4, 41.6], [21.8, 41.4], [24.0, 37.0], [16.4, 40.0], [27.2, 39.2]],
    CT: [[18.3, 4.3], [20.4, 4.8], [22.6, 4.2], [24.6, 4.8], [26.6, 4.0], [19.4, 5.8], [23.5, 5.8], [27.4, 2.8], [17.2, 3.0], [25.6, 2.2]],
  },

  // ---------------- 道具：x,z 为中心（格子单位），尺寸为米 ----------------
  PROPS: [
    // B 包点
    { t: 'car', x: 9.35, z: 2.6, rot: 0, color: [0.62, 0.66, 0.72] },
    { t: 'crate', x: 6.5, z: 6.6, s: 1.6 },
    { t: 'crate', x: 6.5, z: 6.6, s: 1.1 },           // 叠在上面
    { t: 'crate', x: 7.55, z: 6.35, s: 1.1 },
    { t: 'crate', x: 2.0, z: 9.55, s: 1.6 },
    { t: 'crate', x: 2.15, z: 8.35, s: 1.1 },
    { t: 'barrel', x: 10.6, z: 10.6, color: [0.55, 0.2, 0.16] },
    { t: 'barrel', x: 10.15, z: 10.75, color: [0.2, 0.34, 0.5] },
    { t: 'crate', x: 10.35, z: 6.8, s: 1.1 },
    { t: 'lowwall', x0: 3.2, z0: 5.5, x1: 4.8, z1: 5.75, h: 1.0 },
    // A 包点
    { t: 'crate', x: 37.0, z: 6.0, s: 1.6 },
    { t: 'crate', x: 37.0, z: 6.0, s: 1.1 },
    { t: 'crate', x: 38.1, z: 6.25, s: 1.1 },
    { t: 'crate', x: 42.45, z: 1.55, s: 1.6 },          // 角落
    { t: 'crate', x: 41.55, z: 1.45, s: 1.1 },
    { t: 'lowwall', x0: 38.6, z0: 9.8, x1: 41.2, z1: 10.05, h: 1.05 },
    { t: 'crate', x: 33.1, z: 8.85, s: 1.1 },
    { t: 'barrel', x: 32.65, z: 1.6, color: [0.5, 0.18, 0.14] },
    { t: 'barrel', x: 33.15, z: 1.45, color: [0.5, 0.18, 0.14] },
    { t: 'crate', x: 35.0, z: 2.4, s: 1.1 },
    // 中路 / CT 中路
    { t: 'crate', x: 19.9, z: 19.5, s: 1.6 },
    { t: 'crate', x: 18.6, z: 27.35, s: 1.1 },
    { t: 'crate', x: 18.75, z: 7.6, s: 1.1 },
    { t: 'barrel', x: 24.4, z: 11.55, color: [0.25, 0.4, 0.3] },
    // A 大道 / 大道外
    { t: 'container', x0: 41.45, z0: 19.0, x1: 42.97, z1: 22.9, color: [0.62, 0.22, 0.16] },
    { t: 'crate', x: 42.35, z: 28.3, s: 1.6 },
    { t: 'crate', x: 37.6, z: 15.1, s: 1.1 },
    { t: 'crate', x: 38.1, z: 33.0, s: 1.1 },
    { t: 'crate', x: 42.3, z: 38.4, s: 1.6 },
    { t: 'crate', x: 42.3, z: 37.2, s: 1.1 },
    { t: 'crate', x: 32.6, z: 36.6, s: 1.1 },
    // T 出生点
    { t: 'car', x: 26.2, z: 41.2, rot: 0, color: [0.66, 0.5, 0.32] },
    { t: 'crate', x: 15.35, z: 41.45, s: 1.1 },          // 贴墙摆放：原位置与墙之间留有 0.5 米窄缝，Bot 会被挤进去卡住
    { t: 'crate', x: 15.35, z: 41.45, s: 1.1 },
    { t: 'crate', x: 27.8, z: 35.8, s: 1.6 },
    // CT 出生点
    { t: 'truck', x: 21.5, z: 1.8, color: [0.3, 0.38, 0.3] },
    { t: 'crate', x: 17.1, z: 1.75, s: 1.1 },
    { t: 'crate', x: 16.6, z: 5.8, s: 1.6 },
    // 地道
    { t: 'crate', x: 4.45, z: 18.6, s: 1.1 },
    { t: 'crate', x: 3.5, z: 31.0, s: 1.1 },
    { t: 'barrel', x: 7.55, z: 35.6, color: [0.5, 0.44, 0.2] },
    { t: 'crate', x: 12.5, z: 36.45, s: 1.6 },
    // 棕榈树（装饰）
    { t: 'palm', x: 27.5, z: 1.5, h: 6.0 },
    { t: 'palm', x: 19.1, z: 6.45, h: 5.2 },
    { t: 'palm', x: 27.9, z: 41.9, h: 5.8 },
    { t: 'palm', x: 3.6, z: 39.3, h: 5.0 },
    { t: 'palm', x: 42.3, z: 11.3, h: 6.2 },
    // 打开的门板（装饰 + 可穿透掩体）
    { t: 'door', x0: 37.55, z0: 29.9, x1: 39.0, z1: 30.0 },
    { t: 'door', x0: 41.0, z0: 29.9, x1: 42.45, z1: 30.0 },
    { t: 'door', x0: 20.05, z0: 25.9, x1: 21.0, z1: 26.0 },
    { t: 'door', x0: 23.0, z0: 25.9, x1: 23.95, z1: 26.0 },
  ],

  // ---------------- 墙面喷漆标识 ----------------
  SIGNS: [
    { text: 'A', x: 37.5, z: 1, face: 'S', y: 3.1, size: 2.6 },
    { text: 'B', x: 7.4, z: 1, face: 'S', y: 2.7, size: 2.6 },
    { text: 'A →', x: 26.2, z: 35, face: 'S', y: 2.1, size: 2.6, color: 'rgba(235,225,200,.85)' },
    { text: '← B', x: 16.4, z: 35, face: 'S', y: 2.1, size: 2.6, color: 'rgba(235,225,200,.85)' },
    { text: 'MID', x: 18.6, z: 35, face: 'S', y: 2.9, size: 1.8, color: 'rgba(235,225,200,.8)' },
    { text: 'A ↑', x: 43, z: 34.2, face: 'W', y: 2.1, size: 2.4, color: 'rgba(235,225,200,.85)' },
    { text: 'B ↑', x: 3, z: 31.8, face: 'E', y: 2.1, size: 2.4, color: 'rgba(235,225,200,.85)' },
    { text: '← B', x: 16.0, z: 8, face: 'S', y: 2.1, size: 2.0, color: 'rgba(235,225,200,.8)' },
  ],

  // ---------------- Bot 战术点位（格子单位；look = 预瞄点） ----------------
  SPOTS: {
    CT: {
      A: [
        { p: [40.3, 9.2], look: [39.5, 30.5], crouch: true, name: 'A 平台' },
        { p: [35.6, 7.4], look: [28.5, 10.9], name: 'A 箱后' },
        { p: [41.3, 3.3], look: [39.8, 13.0], name: 'A 角落' },
        { p: [33.6, 3.6], look: [29.0, 10.9], name: 'CT 坡顶' },
        { p: [36.2, 10.3], look: [40.0, 20.0], crouch: true, name: 'A 边缘' },
      ],
      B: [
        { p: [2.6, 1.6], look: [5.5, 12.5], name: 'B 后平台' },
        { p: [9.9, 4.4], look: [5.5, 12.5], name: 'B 车后' },
        { p: [11.0, 9.4], look: [5.5, 12.5], name: 'B 门内' },
        { p: [7.9, 7.4], look: [5.5, 12.5], crouch: true, name: 'B 箱后' },
        { p: [4.0, 6.6], look: [5.5, 12.5], crouch: true, name: 'B 矮墙' },
      ],
      mid: [
        { p: [21.5, 9.6], look: [21.5, 27.0], name: 'CT 中路' },
        { p: [19.2, 11.8], look: [21.8, 26.5], name: '中路拐角' },
      ],
      aggro: [
        { p: [38.2, 27.4], look: [39.5, 35.0], lane: 'A', name: '大道门后' },
        { p: [5.5, 14.2], look: [5.5, 27.5], lane: 'B', name: '地道口' },
        { p: [17.8, 22.5], look: [8.0, 22.5], lane: 'mid', name: '下地道' },
        { p: [21.8, 23.6], look: [19.0, 29.5], lane: 'mid', name: '中门' },
        { p: [27.6, 15.0], look: [21.5, 17.5], lane: 'A', name: '小道' },
      ],
    },
    // T 方（队友 Bot）的推进路线（可选多条）与包后防守点
    T: {
      A: {
        routes: [
          [[33.0, 38.0], [39.8, 34.0], [39.5, 25.0], [39.6, 15.0]],          // 大道
          [[21.5, 30.0], [21.5, 20.0], [27.5, 16.0], [28.0, 11.0]],          // 中路 → 小道
        ],
        post: [{ p: [33.4, 4.3], look: [29.5, 3.5] }, { p: [40.2, 8.6], look: [39.8, 18.0] }, { p: [35.5, 9.8], look: [28.5, 10.9] }, { p: [38.8, 3.0], look: [32.0, 3.5] }],
      },
      B: {
        routes: [
          [[8.0, 38.0], [5.5, 30.0], [5.5, 18.0]],                            // 上地道
          [[21.5, 30.0], [21.0, 22.5], [10.0, 22.5], [5.5, 16.0]],            // 中路 → 下地道
        ],
        post: [{ p: [10.4, 9.8], look: [16.5, 9.0] }, { p: [3.2, 6.4], look: [11.0, 9.0] }, { p: [8.6, 3.6], look: [5.5, 12.5] }, { p: [5.0, 9.2], look: [12.0, 9.2] }],
      },
    },
  },
};

// =====================================================================
//  几何合批构建器：把大量方块面写进同一个 BufferGeometry
// =====================================================================
class GeoBuilder {
  constructor() { this.p = []; this.n = []; this.u = []; this.c = []; this.i = []; this.v = 0; }
  /** 四边形 a,b,c,d 需按逆时针（从法线方向看）；uv 为 8 个数；tint 为 rgb；sh 为 4 个顶点亮度 */
  quad(a, b, c, d, nx, ny, nz, uv, tint, sh) {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (let k = 0; k < 4; k++) {
      this.n.push(nx, ny, nz);
      const s = sh ? sh[k] : 1;
      this.c.push(tint[0] * s, tint[1] * s, tint[2] * s);
    }
    for (let k = 0; k < 8; k++) this.u.push(uv[k]);
    const v = this.v;
    this.i.push(v, v + 1, v + 2, v, v + 2, v + 3);
    this.v += 4;
  }
  tri(a, b, c, nx, ny, nz, uv, tint) {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let k = 0; k < 3; k++) { this.n.push(nx, ny, nz); this.c.push(tint[0], tint[1], tint[2]); }
    for (let k = 0; k < 6; k++) this.u.push(uv[k]);
    const v = this.v;
    this.i.push(v, v + 1, v + 2);
    this.v += 3;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.v > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere();
    return g;
  }
}

const WHITE = [1, 1, 1];

/**
 * 往构建器里写一个长方体
 * o.mode: 'world'（按世界坐标平铺 UV，o.s=每张纹理覆盖的米数）或 'box'（每面 0..1）
 * o.skip: 需要跳过的面（'px','nx','py','ny','pz','nz'）
 * o.ao: 侧面底部环境光遮蔽高度；o.aoMin: 底部亮度
 * o.top: 顶面单独使用的构建器（例如高台顶面用地面材质）
 */
function emitBox(gb, x0, y0, z0, x1, y1, z1, o = {}) {
  const s = o.s || 4, tint = o.tint || WHITE, skip = o.skip || '';
  const box = o.mode === 'box';
  const ao = o.ao || 0, aoMin = o.aoMin || 0.62;
  const side = (face, bl, br, tr, tl, nx, ny, nz, ua, ub) => {
    // 侧面：bl/br/tr/tl 仅用 [x,z]，高度由 y0/y1 决定；ua/ub 为左右两侧的水平 UV 坐标
    const emit = (ya, yb, sa, sb) => {
      const uv = box ? [0, (ya - y0) / (y1 - y0), 1, (ya - y0) / (y1 - y0), 1, (yb - y0) / (y1 - y0), 0, (yb - y0) / (y1 - y0)]
        : [ua, ya / s, ub, ya / s, ub, yb / s, ua, yb / s];
      gb.quad([bl[0], ya, bl[1]], [br[0], ya, br[1]], [tr[0], yb, tr[1]], [tl[0], yb, tl[1]], nx, ny, nz, uv, tint, [sa, sa, sb, sb]);
    };
    if (skip.includes(face)) return;
    const h = y1 - y0;
    if (ao > 0 && h > ao * 1.2) {
      emit(y0, y0 + ao, aoMin, 1);
      emit(y0 + ao, y1, 1, 1);
    } else if (ao > 0) {
      emit(y0, y1, aoMin, lerp(aoMin, 1, Math.min(1, h / ao)));
    } else emit(y0, y1, o.sideShade || 1, o.sideShade || 1);
  };
  // +X 面
  side('px', [x1, z1], [x1, z0], [x1, z0], [x1, z1], 1, 0, 0, -z1 / s, -z0 / s);
  // -X 面
  side('nx', [x0, z0], [x0, z1], [x0, z1], [x0, z0], -1, 0, 0, z0 / s, z1 / s);
  // +Z 面
  side('pz', [x0, z1], [x1, z1], [x1, z1], [x0, z1], 0, 0, 1, x0 / s, x1 / s);
  // -Z 面
  side('nz', [x1, z0], [x0, z0], [x0, z0], [x1, z0], 0, 0, -1, -x1 / s, -x0 / s);
  // 顶面
  if (!skip.includes('py')) {
    const tg = o.top || gb;
    const ts = o.topS || s;
    const uv = box ? [0, 0, 1, 0, 1, 1, 0, 1] : [x0 / ts, -z1 / ts, x1 / ts, -z1 / ts, x1 / ts, -z0 / ts, x0 / ts, -z0 / ts];
    const tsh = o.topShade || 1;
    tg.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], 0, 1, 0, uv, o.topTint || tint, [tsh, tsh, tsh, tsh]);
  }
  // 底面
  if (!skip.includes('ny')) {
    const uv = box ? [0, 0, 1, 0, 1, 1, 0, 1] : [x0 / s, z0 / s, x1 / s, z0 / s, x1 / s, z1 / s, x0 / s, z1 / s];
    const bsh = o.bottomShade || 0.7;
    gb.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], 0, -1, 0, uv, tint, [bsh, bsh, bsh, bsh]);
  }
}

/** 竖直圆柱（桶、车轮用），axis='y' 竖直，'x'/'z' 为水平方向 */
function emitCylinder(gb, cx, cy, cz, r, h, seg, tint, axis = 'y', s = 1) {
  const pt = (a, t) => {
    const ca = Math.cos(a) * r, sa = Math.sin(a) * r;
    if (axis === 'y') return [cx + ca, cy + t, cz + sa];
    if (axis === 'x') return [cx + t, cy + ca, cz + sa];
    return [cx + ca, cy + sa, cz + t];
  };
  const nrm = (a) => {
    const ca = Math.cos(a), sa = Math.sin(a);
    if (axis === 'y') return [ca, 0, sa];
    if (axis === 'x') return [0, ca, sa];
    return [ca, sa, 0];
  };
  const h0 = axis === 'y' ? 0 : -h / 2, h1 = axis === 'y' ? h : h / 2;
  for (let i = 0; i < seg; i++) {
    const a0 = i / seg * TAU, a1 = (i + 1) / seg * TAU;
    const n0 = nrm((a0 + a1) / 2);
    const u0 = i / seg * s, u1 = (i + 1) / seg * s;
    // 侧面（从外侧看逆时针）
    gb.quad(pt(a1, h0), pt(a0, h0), pt(a0, h1), pt(a1, h1), n0[0], n0[1], n0[2], [u1, 0, u0, 0, u0, h / 1.5, u1, h / 1.5], tint, [0.85, 0.85, 1, 1]);
    // 顶/底盖
    const ctop = axis === 'y' ? [cx, cy + h1, cz] : axis === 'x' ? [cx + h1, cy, cz] : [cx, cy, cz + h1];
    const cbot = axis === 'y' ? [cx, cy + h0, cz] : axis === 'x' ? [cx + h0, cy, cz] : [cx, cy, cz + h0];
    const nt = axis === 'y' ? [0, 1, 0] : axis === 'x' ? [1, 0, 0] : [0, 0, 1];
    gb.tri(ctop, pt(a1, h1), pt(a0, h1), nt[0], nt[1], nt[2], [0.5, 0.5, 0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5, 0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5], [tint[0] * 0.9, tint[1] * 0.9, tint[2] * 0.9]);
    gb.tri(cbot, pt(a0, h0), pt(a1, h0), -nt[0], -nt[1], -nt[2], [0.5, 0.5, 0.5, 0.5, 0.5, 0.5], [tint[0] * 0.6, tint[1] * 0.6, tint[2] * 0.6]);
  }
}

// =====================================================================
//  地图构建
// =====================================================================
const MapBuilder = {
  gbs: {},
  mats: {},
  meshes: [],
  gb(key) { return this.gbs[key] || (this.gbs[key] = new GeoBuilder()); },

  makeMaterials() {
    const T = Tex.t;
    const M = (map, color = 0xffffff, extra = {}) => new THREE.MeshLambertMaterial(Object.assign({ map, color, vertexColors: true }, extra));
    this.mats = {
      dirt: M(T.dirt), sand: M(T.sand), concrete: M(T.concrete), stoneFloor: M(T.stone, 0xe8dcc4),
      tiles: M(T.tiles), planks: M(T.planks), darkFloor: M(T.dark),
      plaster: M(T.plaster), stoneWall: M(T.stone), brickWall: M(T.brick), darkWall: M(T.dark),
      crate: M(T.crate), metal: M(T.metal), paint: M(T.concrete), door: M(T.planks, 0xb89a78),
      glass: new THREE.MeshLambertMaterial({ color: 0x1d2630, vertexColors: true }),
      leaf: new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide }),
      rubber: new THREE.MeshLambertMaterial({ color: 0x1b1b1b, vertexColors: true }),
      outside: M(T.plaster, 0xffffff), outGround: M(T.sand, 0xf0e6d0),
    };
  },

  build(scene) {
    this.scene = scene;
    if (!IS_SERVER) this.makeMaterials();
    this.computeWalls();
    this.buildFloors();
    this.buildStairs();
    this.buildWallBoxes();
    this.buildCeilings();
    this.buildProps();         // 道具通过 World.topAt 查询脚下高度（可叠放）
    this.buildOutside();
    World.build();
    if (IS_SERVER) { this.gbs = {}; return; }   // 服务器只需要碰撞体
    for (const key in this.gbs) {
      const geo = this.gbs[key].build();
      const mesh = new THREE.Mesh(geo, this.mats[key]);
      const out = key === 'outside' || key === 'outGround';
      mesh.castShadow = !out;
      mesh.receiveShadow = key !== 'outside';
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      this.meshes.push(mesh);
    }
    this.buildSigns(scene);
  },

  // ---- 墙体高度与材质：离地面越远越高（形成建筑轮廓），材质取决于附近区域 ----
  computeWalls() {
    const { W, H } = MAP;
    const dist = new Int16Array(W * H).fill(99);
    const q = [];
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (!MAP.isWall(c, r)) { dist[r * W + c] = 0; q.push(c, r); }
    // 切比雪夫距离的 BFS
    for (let qi = 0; qi < q.length; qi += 2) {
      const c = q[qi], r = q[qi + 1], d = dist[r * W + c];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= W || nr >= H) continue;
        const k = nr * W + nc;
        if (dist[k] > d + 1) { dist[k] = d + 1; q.push(nc, nr); }
      }
    }
    this.wallH = new Float32Array(W * H);
    this.wallMat = new Array(W * H);
    const heights = [0, 4.6, 5.8, 7.0, 8.2];
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      if (!MAP.isWall(c, r)) continue;
      const k = r * W + c, d = Math.min(dist[k], 4);
      let lv = 0, best = null;
      const rank = { t: 5, B: 4, A: 3, C: 3, ':': 2 };
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const ch = MAP.at(c + dc, r + dr);
        if (ch === '#') continue;
        const l = MAP.LEVEL[ch] || (MAP.isStair(ch) ? 0.6 : 0);
        if (l > lv) lv = l;
        if (Math.abs(dr) <= 1 && Math.abs(dc) <= 1 && (!best || (rank[ch] || 1) > (rank[best] || 1))) best = ch;
      }
      let h = heights[d] + lv;
      if (d >= 1 && hash2(c >> 2, r >> 2, 7) > 0.62) h += 0.8;
      this.wallH[k] = h;
      this.wallMat[k] = best === 't' ? 'darkWall' : best === 'B' ? 'brickWall' : (best === 'A' || best === 'C') ? 'stoneWall' : 'plaster';
    }
  },

  /** 顶点环境光遮蔽：统计共享该顶点的 4 个格子里有多少是墙/更高的台子 */
  vertexAO(c, r, level) {
    let n = 0;
    for (const [dc, dr] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const ch = MAP.at(c + dc, r + dr);
      if (ch === '#') n++;
      else { const l = MAP.level(c + dc, r + dr); if (l > level + 0.3) n++; }
    }
    return [1, 0.8, 0.68, 0.6, 0.6][n];
  },

  buildFloors() {
    const { W, H, C } = MAP;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const ch = MAP.at(c, r);
      if (ch === '#' || MAP.isStair(ch)) continue;
      const lv = MAP.level(c, r);
      const mat = MAP.FLOOR[ch][0];
      const x0 = MAP.wx(c), x1 = MAP.wx(c + 1), z0 = MAP.wz(r), z1 = MAP.wz(r + 1);
      const s = mat === 'planks' ? 2.5 : 4;
      const sh = [this.vertexAO(c, r + 1, lv), this.vertexAO(c + 1, r + 1, lv), this.vertexAO(c + 1, r, lv), this.vertexAO(c, r, lv)];
      this.gb(mat).quad([x0, lv, z1], [x1, lv, z1], [x1, lv, z0], [x0, lv, z0], 0, 1, 0,
        [x0 / s, -z1 / s, x1 / s, -z1 / s, x1 / s, -z0 / s, x0 / s, -z0 / s], WHITE, sh);
    }
    // 高台：按高度贪心合并成碰撞盒，侧面用石块材质
    const done = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const lv = MAP.level(c, r);
      if (!(lv > 0) || done[r * W + c]) continue;
      const mat = MAP.at(c, r) === ':' ? 'wood' : 'stone';
      let c2 = c;
      while (c2 + 1 < W && MAP.level(c2 + 1, r) === lv && !done[r * W + c2 + 1] && (MAP.at(c2 + 1, r) === ':') === (mat === 'wood')) c2++;
      let r2 = r;
      outer: while (r2 + 1 < H) {
        for (let k = c; k <= c2; k++) if (MAP.level(k, r2 + 1) !== lv || done[(r2 + 1) * W + k] || (MAP.at(k, r2 + 1) === ':') !== (mat === 'wood')) break outer;
        r2++;
      }
      for (let rr = r; rr <= r2; rr++) for (let cc = c; cc <= c2; cc++) done[rr * W + cc] = 1;
      const x0 = MAP.wx(c), x1 = MAP.wx(c2 + 1), z0 = MAP.wz(r), z1 = MAP.wz(r2 + 1);
      World.addBox(x0, 0, z0, x1, lv, z1, mat);
      emitBox(this.gb(mat === 'wood' ? 'planks' : 'stoneWall'), x0, 0, z0, x1, lv, z1, { skip: 'pyny', s: mat === 'wood' ? 2.5 : 4, ao: 0.5, aoMin: 0.7 });
    }
  },

  buildStairs() {
    const { W, H } = MAP;
    const seen = new Uint8Array(W * H);
    const STEP_RISE = 0.3;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const ch = MAP.at(c, r);
      if (!MAP.isStair(ch) || seen[r * W + c]) continue;
      const horiz = ch === '>' || ch === '<';
      // 找到同一行（或列）连续的楼梯段
      let len = 0;
      while (MAP.at(c + (horiz ? len : 0), r + (horiz ? 0 : len)) === ch) { seen[(r + (horiz ? 0 : len)) * W + c + (horiz ? len : 0)] = 1; len++; }
      // 低端与高端的地面高度
      let lowC, lowR, highC, highR;
      if (ch === '>') { lowC = c - 1; lowR = r; highC = c + len; highR = r; }
      else if (ch === '<') { lowC = c + len; lowR = r; highC = c - 1; highR = r; }
      else if (ch === '^') { lowC = c; lowR = r + len; highC = c; highR = r - 1; }
      else { lowC = c; lowR = r - 1; highC = c; highR = r + len; }
      const h0 = MAP.level(lowC, lowR) || 0, h1 = MAP.level(highC, highR) || 0;
      const n = Math.max(1, Math.round((h1 - h0) / STEP_RISE));
      const dh = (h1 - h0) / n;
      const L = len * MAP.C;
      // 起点（低端边缘）的世界坐标与方向
      const cx0 = MAP.wx(c), cz0 = MAP.wz(r);
      for (let k = 1; k < n; k++) {
        const s0 = (k - 1) * L / (n - 1), s1 = k * L / (n - 1);
        const top = h0 + dh * k;
        let x0, x1, z0, z1;
        if (ch === '>') { x0 = cx0 + s0; x1 = cx0 + s1; z0 = cz0; z1 = cz0 + MAP.C; }
        else if (ch === '<') { x1 = cx0 + L - s0; x0 = cx0 + L - s1; z0 = cz0; z1 = cz0 + MAP.C; }
        else if (ch === '^') { z1 = cz0 + L - s0; z0 = cz0 + L - s1; x0 = cx0; x1 = cx0 + MAP.C; }
        else { z0 = cz0 + s0; z1 = cz0 + s1; x0 = cx0; x1 = cx0 + MAP.C; }
        World.addBox(x0, 0, z0, x1, top, z1, 'stone');
        emitBox(this.gb('stoneFloor'), x0, 0, z0, x1, top, z1, { skip: 'ny', s: 4, topShade: 1.02, sideShade: 0.82 });
      }
    }
  },

  buildWallBoxes() {
    const { W, H } = MAP;
    const done = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const k = r * W + c;
      if (!MAP.isWall(c, r) || done[k]) continue;
      const h = this.wallH[k], m = this.wallMat[k];
      const same = (cc, rr) => MAP.isWall(cc, rr) && !done[rr * W + cc] && this.wallH[rr * W + cc] === h && this.wallMat[rr * W + cc] === m;
      let c2 = c;
      while (c2 + 1 < W && same(c2 + 1, r)) c2++;
      let r2 = r;
      outer: while (r2 + 1 < H) {
        for (let cc = c; cc <= c2; cc++) if (!same(cc, r2 + 1)) break outer;
        r2++;
      }
      for (let rr = r; rr <= r2; rr++) for (let cc = c; cc <= c2; cc++) done[rr * W + cc] = 1;
      const x0 = MAP.wx(c), x1 = MAP.wx(c2 + 1), z0 = MAP.wz(r), z1 = MAP.wz(r2 + 1);
      World.addBox(x0, 0, z0, x1, h, z1, 'stone');
      const tintK = 0.93 + hash2(c, r, 3) * 0.1;
      emitBox(this.gb(m), x0, 0, z0, x1, h, z1, { skip: 'ny', s: m === 'darkWall' ? 2.5 : 4, ao: 1.3, aoMin: 0.6, tint: [tintK, tintK, tintK * 0.98], topShade: 0.8 });
    }
    this.buildFacades();
  },

  /** 墙面装饰：临街的窗户与木门（纯视觉，贴在墙面上） */
  buildFacades() {
    const { W, H, C } = MAP;
    const glass = this.gb('glass'), wood = this.gb('door'), stone = this.gb('stoneWall');
    const dirs = [[0, -1, 'N'], [0, 1, 'S'], [-1, 0, 'W'], [1, 0, 'E']];
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      if (!MAP.isWall(c, r)) continue;
      const h = this.wallH[r * W + c];
      for (const [dc, dr, face] of dirs) {
        const ch = MAP.at(c + dc, r + dr);
        if (ch === '#' || ch === 't' || MAP.isStair(ch)) continue;
        const lv = MAP.level(c + dc, r + dr) || 0;
        const rnd = hash2(c * 7 + dc, r * 13 + dr, 77);
        // 墙面在世界坐标中的位置与朝向
        const fx = face === 'W' ? MAP.wx(c) : face === 'E' ? MAP.wx(c + 1) : MAP.wx(c + 0.5);
        const fz = face === 'N' ? MAP.wz(r) : face === 'S' ? MAP.wz(r + 1) : MAP.wz(r + 0.5);
        const nx = dc, nz = dr;
        const along = (w, y0, y1, d, gb, tint) => {
          // 贴墙的薄盒：沿墙宽 w，高 y0~y1，凸出 d
          if (nx !== 0) emitBox(gb, Math.min(fx, fx + nx * d), y0, fz - w / 2, Math.max(fx, fx + nx * d), y1, fz + w / 2, { s: 2, tint, skip: 'ny' });
          else emitBox(gb, fx - w / 2, y0, Math.min(fz, fz + nz * d), fx + w / 2, y1, Math.max(fz, fz + nz * d), { s: 2, tint, skip: 'ny' });
        };
        if (h - lv >= 5.3 && rnd < 0.34) {
          const y0 = lv + 3.0, y1 = lv + 4.1;
          along(0.95, y0 - 0.12, y1 + 0.12, 0.05, wood, [0.5, 0.4, 0.3]);    // 窗框
          along(0.78, y0, y1, 0.07, glass, [1, 1, 1]);                         // 玻璃（深色）
          along(1.15, y0 - 0.2, y0 - 0.08, 0.16, stone, [0.9, 0.88, 0.84]);    // 窗台
        } else if (rnd > 0.93 && ch !== 'A' && ch !== 'B') {
          along(1.1, lv, lv + 2.25, 0.06, wood, [0.62, 0.46, 0.32]);          // 封闭的木门
          along(1.3, lv + 2.25, lv + 2.4, 0.1, stone, [0.85, 0.82, 0.78]);     // 门楣
        }
      }
    }
  },

  buildCeilings() {
    const { W, H } = MAP;
    // 地道顶棚：3.2m 到 4.6m
    const done = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      if (MAP.at(c, r) !== 't' || done[r * W + c]) continue;
      let c2 = c;
      while (MAP.at(c2 + 1, r) === 't' && !done[r * W + c2 + 1]) c2++;
      let r2 = r;
      outer: while (true) {
        for (let cc = c; cc <= c2; cc++) if (MAP.at(cc, r2 + 1) !== 't' || done[(r2 + 1) * W + cc]) break outer;
        r2++;
      }
      for (let rr = r; rr <= r2; rr++) for (let cc = c; cc <= c2; cc++) done[rr * W + cc] = 1;
      const x0 = MAP.wx(c), x1 = MAP.wx(c2 + 1), z0 = MAP.wz(r), z1 = MAP.wz(r2 + 1);
      World.addBox(x0, 3.2, z0, x1, 4.6, z1, 'stone');
      emitBox(this.gb('darkWall'), x0, 3.2, z0, x1, 4.6, z1, { s: 2.5, bottomShade: 0.55, topShade: 0.75 });
      // 顶棚木梁（装饰）
      for (let rr = r; rr <= r2; rr += 2) {
        const bz = MAP.wz(rr) + 0.6;
        emitBox(this.gb('door'), x0, 2.95, bz, x1, 3.2, bz + 0.3, { s: 2, skip: 'py', tint: [0.6, 0.5, 0.42] });
      }
    }
    // 门框横梁
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      if (MAP.at(c, r) !== 'd') continue;
      let top = 99;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (MAP.isWall(c + dc, r + dr)) top = Math.min(top, this.wallH[(r + dr) * W + c + dc]);
      }
      if (top === 99) top = 4.6;
      const x0 = MAP.wx(c), x1 = MAP.wx(c + 1), z0 = MAP.wz(r), z1 = MAP.wz(r + 1);
      World.addBox(x0, 3.0, z0, x1, top, z1, 'stone');
      emitBox(this.gb('stoneWall'), x0, 3.0, z0, x1, top, z1, { s: 4, bottomShade: 0.6 });
      // 木质门楣
      emitBox(this.gb('door'), x0 - 0.02, 2.82, z0 - 0.02, x1 + 0.02, 3.0, z1 + 0.02, { s: 2, skip: 'py', tint: [0.55, 0.42, 0.32] });
    }
  },

  // ---- 道具 ----
  buildProps() {
    const C = MAP.C;
    let seed = 1;
    for (const p of MAP.PROPS) {
      seed++;
      if (p.t === 'crate') {
        const s = p.s || 1.1, hs = s / 2;
        const x = MAP.wx(p.x), z = MAP.wz(p.z);
        const y = World.topAt(x, z, 30);
        const k = 0.86 + hash2(seed, 1, 5) * 0.22;
        World.addBox(x - hs, y, z - hs, x + hs, y + s, z + hs, 'wood', 1);
        emitBox(this.gb('crate'), x - hs, y, z - hs, x + hs, y + s, z + hs, { mode: 'box', skip: 'ny', tint: [k, k * 0.97, k * 0.92] });
      } else if (p.t === 'barrel') {
        const x = MAP.wx(p.x), z = MAP.wz(p.z);
        const y = World.topAt(x, z, 30);
        World.addBox(x - 0.32, y, z - 0.32, x + 0.32, y + 0.95, z + 0.32, 'metal', 0.5);
        emitCylinder(this.gb('metal'), x, y, z, 0.32, 0.95, 12, p.color, 'y', 2);
        emitCylinder(this.gb('metal'), x, y + 0.3, z, 0.335, 0.05, 12, [p.color[0] * 0.7, p.color[1] * 0.7, p.color[2] * 0.7], 'y');
        emitCylinder(this.gb('metal'), x, y + 0.64, z, 0.335, 0.05, 12, [p.color[0] * 0.7, p.color[1] * 0.7, p.color[2] * 0.7], 'y');
      } else if (p.t === 'lowwall') {
        const x0 = MAP.wx(p.x0), x1 = MAP.wx(p.x1), z0 = MAP.wz(p.z0), z1 = MAP.wz(p.z1);
        const y = World.topAt((x0 + x1) / 2, (z0 + z1) / 2, 30);
        World.addBox(x0, y, z0, x1, y + p.h, z1, 'stone');
        emitBox(this.gb('stoneWall'), x0, y, z0, x1, y + p.h, z1, { s: 4, skip: 'ny', ao: 0.4, aoMin: 0.75 });
      } else if (p.t === 'door') {
        const x0 = MAP.wx(p.x0), x1 = MAP.wx(p.x1), z0 = MAP.wz(p.z0), z1 = MAP.wz(p.z1);
        World.addBox(x0, 0, z0, x1, 2.8, z1, 'wood', 1);
        emitBox(this.gb('door'), x0, 0, z0, x1, 2.8, z1, { s: 2, skip: 'ny', tint: [0.75, 0.62, 0.5] });
        emitBox(this.gb('metal'), x0 - 0.01, 0.35, z0 - 0.015, x1 + 0.01, 0.45, z1 + 0.015, { s: 2, tint: [0.35, 0.35, 0.35] });
        emitBox(this.gb('metal'), x0 - 0.01, 2.3, z0 - 0.015, x1 + 0.01, 2.4, z1 + 0.015, { s: 2, tint: [0.35, 0.35, 0.35] });
      } else if (p.t === 'container') {
        const x0 = MAP.wx(p.x0), x1 = MAP.wx(p.x1), z0 = MAP.wz(p.z0), z1 = MAP.wz(p.z1);
        World.addBox(x0, 0, z0, x1, 2.6, z1, 'metal', 0);
        emitBox(this.gb('metal'), x0, 0, z0, x1, 2.6, z1, { s: 2.6, skip: 'ny', tint: p.color, ao: 0.6, aoMin: 0.7 });
        emitBox(this.gb('metal'), x0 - 0.04, 2.45, z0 - 0.04, x1 + 0.04, 2.62, z1 + 0.04, { s: 2.6, tint: [p.color[0] * 0.75, p.color[1] * 0.75, p.color[2] * 0.75] });
      } else if (p.t === 'palm') {
        this.buildPalm(MAP.wx(p.x), MAP.wz(p.z), p.h || 5.5, seed);
      } else if (p.t === 'car') {
        this.buildCar(MAP.wx(p.x), MAP.wz(p.z), p.color);
      } else if (p.t === 'truck') {
        this.buildTruck(MAP.wx(p.x), MAP.wz(p.z), p.color);
      }
    }
  },

  buildCar(x, z, color) {
    const L = 3.9, Wd = 1.75;
    const y = World.topAt(x, z, 30);
    const paint = this.gb('paint'), glass = this.gb('glass'), rub = this.gb('rubber');
    // 车身
    World.addBox(x - L / 2, y, z - Wd / 2, x + L / 2, y + 1.0, z + Wd / 2, 'metal', 0.3);
    emitBox(paint, x - L / 2, y + 0.3, z - Wd / 2, x + L / 2, y + 1.0, z + Wd / 2, { mode: 'box', tint: color, bottomShade: 0.3 });
    emitBox(paint, x - L / 2 + 0.1, y + 0.18, z - Wd / 2 + 0.1, x + L / 2 - 0.1, y + 0.3, z + Wd / 2 - 0.1, { mode: 'box', tint: [0.2, 0.2, 0.2] });
    // 驾驶室
    const cx0 = x - 1.2, cx1 = x + 0.75;
    World.addBox(cx0, y + 1.0, z - 0.76, cx1, y + 1.62, z + 0.76, 'metal', 0.3);
    emitBox(paint, cx0, y + 1.0, z - 0.76, cx1, y + 1.62, z + 0.76, { mode: 'box', tint: color, skip: 'ny' });
    // 车窗（略微凸出于驾驶室表面）
    emitBox(glass, cx0 + 0.15, y + 1.07, z - 0.775, cx1 - 0.15, y + 1.55, z + 0.775, { mode: 'box', skip: 'pyny', tint: [1, 1, 1] });
    emitBox(glass, cx0 - 0.01, y + 1.07, z - 0.66, cx1 + 0.01, y + 1.55, z + 0.66, { mode: 'box', skip: 'pyny', tint: [1, 1, 1] });
    // 车轮
    for (const wx of [-1.25, 1.25]) for (const wz of [-0.8, 0.8]) {
      emitCylinder(rub, x + wx, y + 0.34, z + wz, 0.34, 0.24, 10, [1, 1, 1], 'z');
    }
    // 保险杠 / 车灯
    emitBox(rub, x - L / 2 - 0.06, y + 0.35, z - Wd / 2 + 0.05, x - L / 2 + 0.02, y + 0.55, z + Wd / 2 - 0.05, { mode: 'box' });
    emitBox(rub, x + L / 2 - 0.02, y + 0.35, z - Wd / 2 + 0.05, x + L / 2 + 0.06, y + 0.55, z + Wd / 2 - 0.05, { mode: 'box' });
  },

  /** 棕榈树：分段弯曲的树干 + 放射状叶片（只有树干有碰撞） */
  buildPalm(x, z, h, seed) {
    const y = World.topAt(x, z, 30);
    const trunk = this.gb('door'), leaf = this.gb('leaf');
    const rng = new RNG(seed * 31);
    const lean = rng.range(0, TAU), bend = rng.range(0.25, 0.6);
    World.addBox(x - 0.18, y, z - 0.18, x + 0.18, y + 2.4, z + 0.18, 'wood', 1);
    let px = x, pz = z, py = y;
    const segs = 7;
    for (let i = 0; i < segs; i++) {
      const t = (i + 1) / segs;
      const off = bend * t * t;
      const nx = x + Math.cos(lean) * off, nz = z + Math.sin(lean) * off, ny = y + h * t;
      const r = 0.17 - t * 0.05;
      emitBox(trunk, Math.min(px, nx) - r, py, Math.min(pz, nz) - r, Math.max(px, nx) + r, ny, Math.max(pz, nz) + r, { s: 1.5, tint: [0.62 - i * 0.02, 0.5, 0.38], skip: 'ny' });
      px = nx; pz = nz; py = ny;
    }
    for (let i = 0; i < 9; i++) {
      const a = i / 9 * TAU + rng.range(-0.2, 0.2);
      const L = rng.range(1.8, 2.5), droop = rng.range(0.5, 0.9);
      const ca = Math.cos(a), sa = Math.sin(a);
      // 每片叶子用两段下垂的平板近似
      const p0 = [px, py, pz], p1 = [px + ca * L * 0.55, py + 0.25, pz + sa * L * 0.55], p2 = [px + ca * L, py - droop, pz + sa * L];
      const wv = 0.32;
      const side = [-sa * wv, 0, ca * wv];
      for (const [A, B, k] of [[p0, p1, 1], [p1, p2, 0.6]]) {
        const a0 = [A[0] + side[0] * k, A[1], A[2] + side[2] * k], a1 = [A[0] - side[0] * k, A[1], A[2] - side[2] * k];
        const b0 = [B[0] + side[0] * k * 0.8, B[1], B[2] + side[2] * k * 0.8], b1 = [B[0] - side[0] * k * 0.8, B[1], B[2] - side[2] * k * 0.8];
        const g = 0.8 + rng.next() * 0.3;
        leaf.quad(a1, a0, b0, b1, 0, 1, 0, [0, 0, 1, 0, 1, 1, 0, 1], [0.36 * g, 0.52 * g, 0.22 * g], [0.8, 0.8, 1, 1]);
      }
    }
  },

  buildTruck(x, z, color) {
    const y = World.topAt(x, z, 30);
    const paint = this.gb('paint'), glass = this.gb('glass'), rub = this.gb('rubber');
    // 货箱
    const bx0 = x - 2.9, bx1 = x + 1.0;
    World.addBox(bx0, y, z - 1.15, bx1, y + 2.9, z + 1.15, 'metal', 0.3);
    emitBox(this.gb('metal'), bx0, y + 0.5, z - 1.15, bx1, y + 2.9, z + 1.15, { s: 2.6, tint: color, bottomShade: 0.3 });
    // 车头
    const hx0 = x + 1.0, hx1 = x + 2.9;
    World.addBox(hx0, y, z - 1.05, hx1, y + 2.2, z + 1.05, 'metal', 0.3);
    emitBox(paint, hx0, y + 0.5, z - 1.05, hx1, y + 2.2, z + 1.05, { mode: 'box', tint: [0.72, 0.7, 0.62], bottomShade: 0.3 });
    emitBox(glass, hx0 + 0.3, y + 1.35, z - 1.065, hx1 - 0.25, y + 2.05, z + 1.065, { mode: 'box', skip: 'pyny', tint: [1, 1, 1] });
    emitBox(glass, hx1 - 0.01, y + 1.35, z - 0.9, hx1 + 0.01, y + 2.05, z + 0.9, { mode: 'box', skip: 'pyny', tint: [1, 1, 1] });
    emitBox(rub, bx0, y + 0.3, z - 1.0, hx1, y + 0.5, z + 1.0, { mode: 'box' });
    for (const wx of [-2.2, -1.1, 2.1]) for (const wz of [-0.95, 0.95]) {
      emitCylinder(rub, x + wx, y + 0.45, z + wz, 0.45, 0.3, 10, [1, 1, 1], 'z');
    }
  },

  /** 地图外的远景：沙地、远处的建筑与塔楼（不投射阴影） */
  buildOutside() {
    const g = this.gb('outside'), ground = this.gb('outGround');
    const R = 420;
    ground.quad([-R, -0.02, R], [R, -0.02, R], [R, -0.02, -R], [-R, -0.02, -R], 0, 1, 0, [-R / 6, -R / 6, R / 6, -R / 6, R / 6, R / 6, -R / 6, R / 6], WHITE, [1, 1, 1, 1]);
    const rng = new RNG(2024);
    const half = MAP.W * MAP.C / 2;
    for (let i = 0; i < 90; i++) {
      const a = rng.range(0, TAU);
      const d = rng.range(half + 6, half + 70);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      // 避免远景建筑紧贴地图边界太高而产生压迫感
      const w = rng.range(5, 14), dd = rng.range(5, 14), h = rng.range(5, 12) + (d - half) * 0.12;
      const k = rng.range(0.8, 1.05);
      emitBox(g, x - w / 2, 0, z - dd / 2, x + w / 2, h, z + dd / 2, { s: 5, skip: 'ny', tint: [k, k * 0.95, k * 0.86], ao: 1.2, aoMin: 0.7 });
      if (rng.next() < 0.18) emitBox(g, x - 1.2, h, z - 1.2, x + 1.2, h + rng.range(4, 9), z + 1.2, { s: 5, skip: 'ny', tint: [k, k * 0.93, k * 0.82] });
    }
    // 远处的沙丘（压扁的圆柱层叠）
    for (let i = 0; i < 16; i++) {
      const a = i / 16 * TAU + rng.range(-0.1, 0.1), d = rng.range(150, 230);
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      for (let k = 0; k < 3; k++) emitCylinder(ground, x, 0, z, rng.range(40, 70) * (1 - k * 0.3), 6 + k * 5, 14, [0.92, 0.86, 0.74], 'y', 6);
    }
  },

  buildSigns(scene) {
    for (const s of MAP.SIGNS) {
      const wide = s.text.length > 1;
      const tex = Tex.sign(s.text, s.color || 'rgba(196,34,24,.9)', wide ? 512 : 256, 256, wide ? 170 : 200);
      const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
      const geo = new THREE.PlaneGeometry(s.size * (wide ? 2 : 1), s.size);
      const m = new THREE.Mesh(geo, mat);
      const off = 0.03;
      let x = MAP.wx(s.x), z = MAP.wz(s.z);
      if (s.face === 'S') { z += off; m.rotation.y = 0; }
      else if (s.face === 'N') { z -= off; m.rotation.y = Math.PI; }
      else if (s.face === 'E') { x += off; m.rotation.y = Math.PI / 2; }
      else { x -= off; m.rotation.y = -Math.PI / 2; }
      m.position.set(x, s.y, z);
      m.receiveShadow = true;
      scene.add(m);
    }
  },
};


// #####################################################################
// ## 模块文件：05_physics.js
// #####################################################################
// =====================================================================
//  05 物理模块
//  World：静态碰撞盒（AABB）+ 均匀网格空间索引 + 射线检测（DDA 遍历）
//  Physics：角色碰撞体的移动（分轴解算、自动上台阶、下楼梯贴地、蹲跳）
// =====================================================================

const World = {
  boxes: [],
  G: 3.2,                 // 空间索引格子尺寸
  minX: 0, minZ: 0, gw: 0, gh: 0, grid: null,
  stamp: 1,               // 去重标记（一个盒子可能跨多个格子）
  GROUND: { mat: 'ground', pen: 0, isGround: true, x0: -1e9, y0: -1, z0: -1e9, x1: 1e9, y1: 0, z1: 1e9 },

  /** mat：命中特效/脚步声材质；pen：子弹穿透难度系数（0=不可穿透，越小越容易穿透） */
  addBox(x0, y0, z0, x1, y1, z1, mat = 'stone', pen = 0) {
    const b = { x0, y0, z0, x1, y1, z1, mat, pen, id: this.boxes.length, stamp: 0 };
    this.boxes.push(b);
    return b;
  },

  build() {
    const half = MAP.W * MAP.C / 2 + 6;
    this.minX = this.minZ = -half;
    this.gw = this.gh = Math.ceil(half * 2 / this.G);
    this.grid = [];
    for (let i = 0; i < this.gw * this.gh; i++) this.grid.push([]);
    for (const b of this.boxes) {
      const i0 = clamp(Math.floor((b.x0 - this.minX) / this.G), 0, this.gw - 1);
      const i1 = clamp(Math.floor((b.x1 - this.minX) / this.G), 0, this.gw - 1);
      const j0 = clamp(Math.floor((b.z0 - this.minZ) / this.G), 0, this.gh - 1);
      const j1 = clamp(Math.floor((b.z1 - this.minZ) / this.G), 0, this.gh - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.grid[j * this.gw + i].push(b);
    }
  },

  /** 初始化用：某点正下方（maxY 以下）最高的表面高度，暴力遍历 */
  topAt(x, z, maxY) {
    let top = 0;
    for (const b of this.boxes) {
      if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && b.y1 <= maxY && b.y1 > top) top = b.y1;
    }
    return top;
  },

  /** 查询与 AABB 严格相交的盒子，结果写入 out */
  query(x0, y0, z0, x1, y1, z1, out) {
    out.length = 0;
    const s = ++this.stamp;
    const i0 = Math.max(0, Math.floor((x0 - this.minX) / this.G)), i1 = Math.min(this.gw - 1, Math.floor((x1 - this.minX) / this.G));
    const j0 = Math.max(0, Math.floor((z0 - this.minZ) / this.G)), j1 = Math.min(this.gh - 1, Math.floor((z1 - this.minZ) / this.G));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cell = this.grid[j * this.gw + i];
      for (let k = 0; k < cell.length; k++) {
        const b = cell[k];
        if (b.stamp === s) continue;
        b.stamp = s;
        if (b.x0 < x1 && b.x1 > x0 && b.y0 < y1 && b.y1 > y0 && b.z0 < z1 && b.z1 > z0) out.push(b);
      }
    }
    return out;
  },

  /**
   * 射线检测：d 必须是单位向量。命中返回 true，并填充 hit：
   * { t, x, y, z, nx, ny, nz, box }
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, hit) {
    let best = maxDist, bestBox = null, axis = -1;
    if (dy < -1e-9) {
      const t = -oy / dy;
      if (t >= 0 && t < best) { best = t; bestBox = this.GROUND; axis = 1; }
    }
    const G = this.G, gw = this.gw, gh = this.gh;
    const s = ++this.stamp;
    const fx = (ox - this.minX) / G, fz = (oz - this.minZ) / G;
    let cx = Math.floor(fx), cz = Math.floor(fz);
    const adx = Math.abs(dx), ady = Math.abs(dy), adz = Math.abs(dz);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tdx = adx > 1e-9 ? G / adx : Infinity, tdz = adz > 1e-9 ? G / adz : Infinity;
    let tmx = adx > 1e-9 ? (dx > 0 ? (cx + 1 - fx) : (fx - cx)) * G / adx : Infinity;
    let tmz = adz > 1e-9 ? (dz > 0 ? (cz + 1 - fz) : (fz - cz)) * G / adz : Infinity;
    const ix = adx > 1e-9 ? 1 / dx : 0, iy = ady > 1e-9 ? 1 / dy : 0, iz = adz > 1e-9 ? 1 / dz : 0;
    let t = 0;
    for (let iter = 0; iter < 400; iter++) {
      if (cx >= 0 && cz >= 0 && cx < gw && cz < gh) {
        const cell = this.grid[cz * gw + cx];
        for (let k = 0; k < cell.length; k++) {
          const b = cell[k];
          if (b.stamp === s) continue;
          b.stamp = s;
          // slab 相交测试
          let t0 = -Infinity, t1 = best, ax = -1;
          if (adx <= 1e-9) { if (ox <= b.x0 || ox >= b.x1) continue; }
          else {
            let ta = (b.x0 - ox) * ix, tb = (b.x1 - ox) * ix;
            if (ta > tb) { const q = ta; ta = tb; tb = q; }
            if (ta > t0) { t0 = ta; ax = 0; }
            if (tb < t1) t1 = tb;
            if (t0 > t1) continue;
          }
          if (ady <= 1e-9) { if (oy <= b.y0 || oy >= b.y1) continue; }
          else {
            let ta = (b.y0 - oy) * iy, tb = (b.y1 - oy) * iy;
            if (ta > tb) { const q = ta; ta = tb; tb = q; }
            if (ta > t0) { t0 = ta; ax = 1; }
            if (tb < t1) t1 = tb;
            if (t0 > t1) continue;
          }
          if (adz <= 1e-9) { if (oz <= b.z0 || oz >= b.z1) continue; }
          else {
            let ta = (b.z0 - oz) * iz, tb = (b.z1 - oz) * iz;
            if (ta > tb) { const q = ta; ta = tb; tb = q; }
            if (ta > t0) { t0 = ta; ax = 2; }
            if (tb < t1) t1 = tb;
            if (t0 > t1) continue;
          }
          if (t1 < 0) continue;              // 盒子在身后
          if (t0 < 0) { t0 = 0; ax = -2; }   // 起点在盒子内部
          if (t0 < best) { best = t0; bestBox = b; axis = ax; }
        }
      } else if ((cx < 0 && stepX < 0) || (cx >= gw && stepX > 0) || (cz < 0 && stepZ < 0) || (cz >= gh && stepZ > 0)) {
        break;
      }
      if (tmx < tmz) { t = tmx; tmx += tdx; cx += stepX; }
      else { t = tmz; tmz += tdz; cz += stepZ; }
      if (t > best) break;
    }
    if (!bestBox) return false;
    hit.t = best;
    hit.x = ox + dx * best; hit.y = oy + dy * best; hit.z = oz + dz * best;
    hit.nx = 0; hit.ny = 0; hit.nz = 0;
    if (axis === 0) hit.nx = dx > 0 ? -1 : 1;
    else if (axis === 1) hit.ny = dy > 0 ? -1 : 1;
    else if (axis === 2) hit.nz = dz > 0 ? -1 : 1;
    else { hit.nx = -dx; hit.ny = -dy; hit.nz = -dz; }
    hit.box = bestBox;
    return true;
  },

  /** 射线从盒子内部穿出的距离（用于计算穿透厚度） */
  exitDist(b, ox, oy, oz, dx, dy, dz) {
    let t1 = Infinity;
    if (Math.abs(dx) > 1e-9) t1 = Math.min(t1, ((dx > 0 ? b.x1 : b.x0) - ox) / dx);
    if (Math.abs(dy) > 1e-9) t1 = Math.min(t1, ((dy > 0 ? b.y1 : b.y0) - oy) / dy);
    if (Math.abs(dz) > 1e-9) t1 = Math.min(t1, ((dz > 0 ? b.z1 : b.z0) - oz) / dz);
    return Math.max(0, t1);
  },

  _hit: { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, box: null },
  /** 两点之间是否没有墙体遮挡 */
  segClear(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-6) return true;
    return !this.raycast(ax, ay, az, dx / len, dy / len, dz / len, len, this._hit);
  },

  _list: [],
  /** 某点（x,z）在 y 以下 maxDrop 范围内最高的支撑面；找不到返回 -Infinity */
  floorBelow(x, y, z, hw, maxDrop) {
    let best = -Infinity;
    if (y - maxDrop <= 0) best = 0;
    const list = this.query(x - hw, y - maxDrop, z - hw, x + hw, y + 0.02, z + hw, this._list);
    for (let i = 0; i < list.length; i++) if (list[i].y1 <= y + 0.02 && list[i].y1 > best) best = list[i].y1;
    return best;
  },
};

// =====================================================================
//  角色移动物理
//  body 需要：pos(脚底中心), vel, hw(半宽), height, onGround
// =====================================================================
const Physics = {
  EPS: 0.001,
  tmpA: [],
  tmpB: [],

  overlaps(b, bx) {
    const p = b.pos, hw = b.hw, E = this.EPS;
    return bx.x0 < p.x + hw - E && bx.x1 > p.x - hw + E &&
      bx.z0 < p.z + hw - E && bx.z1 > p.z - hw + E &&
      bx.y0 < p.y + b.height - E && bx.y1 > p.y + E;
  },
  /** 该位置是否没有任何碰撞盒 */
  free(x, y, z, hw, h) {
    if (y < -0.001) return false;
    const E = this.EPS;
    const list = World.query(x - hw + E, y + E, z - hw + E, x + hw - E, y + h - E, z + hw - E, this.tmpB);
    return list.length === 0;
  },

  /**
   * 推进角色一帧：内部按速度自动细分子步，重力在每个子步施加
   * 返回值中记录 landSpeed（落地时的下落速度，用于落地音效/伤害）
   */
  moveBody(b, dt, gravity = CFG.GRAVITY) {
    const sp = Math.max(Math.abs(b.vel.x), Math.abs(b.vel.z), Math.abs(b.vel.y) + gravity * dt);
    const n = clamp(Math.ceil(sp * dt / 0.22), 1, 10);
    const h = dt / n;
    const wasGround = b.onGround;
    b.landSpeed = 0;
    b.stepUp = 0;
    for (let i = 0; i < n; i++) {
      b.vel.y -= gravity * h;
      this._axis(b, 0, b.vel.x * h);
      this._axis(b, 2, b.vel.z * h);
      this._vert(b, h);
    }
    // 下台阶/下楼梯时贴地，避免"飞"下楼梯
    if (wasGround && !b.onGround && b.vel.y <= 0 && !b.jumped) {
      const fy = World.floorBelow(b.pos.x, b.pos.y, b.pos.z, b.hw - 0.05, CFG.PLAYER.STEP + 0.05);
      if (fy > -Infinity && this.free(b.pos.x, fy, b.pos.z, b.hw, b.height)) {
        b.pos.y = fy; b.onGround = true; b.vel.y = 0;
      }
    }
    b.jumped = false;
  },

  _axis(b, axis, d) {
    if (d === 0) return;
    const p = b.pos;
    if (axis === 0) p.x += d; else p.z += d;
    const E = this.EPS;
    const list = World.query(p.x - b.hw + E, p.y + E, p.z - b.hw + E, p.x + b.hw - E, p.y + b.height - E, p.z + b.hw - E, this.tmpA);
    for (let i = 0; i < list.length; i++) {
      const bx = list[i];
      if (!this.overlaps(b, bx)) continue;
      const rise = bx.y1 - p.y;
      // 自动上台阶：只在地面上、台阶不高、且上方有空间时
      if (b.onGround && rise > 0 && rise <= CFG.PLAYER.STEP && this.free(p.x, bx.y1 + E, p.z, b.hw, b.height)) {
        p.y = bx.y1 + E;
        b.stepUp += rise;
        continue;
      }
      if (axis === 0) { p.x = d > 0 ? bx.x0 - b.hw : bx.x1 + b.hw; b.vel.x = 0; }
      else { p.z = d > 0 ? bx.z0 - b.hw : bx.z1 + b.hw; b.vel.z = 0; }
    }
  },

  _vert(b, dt) {
    const p = b.pos;
    const oldY = p.y;
    p.y += b.vel.y * dt;
    let grounded = false;
    if (p.y <= 0) {
      p.y = 0;
      if (b.vel.y < 0) { b.landSpeed = Math.min(b.landSpeed, b.vel.y); b.vel.y = 0; }
      grounded = true;
      b.groundBox = null;
    }
    const E = this.EPS;
    const list = World.query(p.x - b.hw + E, p.y + E, p.z - b.hw + E, p.x + b.hw - E, p.y + b.height - E, p.z + b.hw - E, this.tmpA);
    for (let i = 0; i < list.length; i++) {
      const bx = list[i];
      if (!this.overlaps(b, bx)) continue;
      if (b.vel.y <= 0 && oldY >= bx.y1 - 0.05) {
        // 落到盒子顶面
        p.y = bx.y1;
        if (b.vel.y < 0) b.landSpeed = Math.min(b.landSpeed, b.vel.y);
        b.vel.y = 0;
        grounded = true;
        b.groundBox = bx;
      } else if (b.vel.y > 0 && oldY + b.height <= bx.y0 + 0.05) {
        // 撞到天花板
        p.y = bx.y0 - b.height - E;
        b.vel.y = 0;
      } else if (bx.y1 - p.y < 0.5 && this.free(p.x, bx.y1, p.z, b.hw, b.height)) {
        // 轻微嵌入（如在台阶边缘起身）：直接抬上去
        p.y = bx.y1;
        b.vel.y = Math.max(0, b.vel.y);
        grounded = true;
        b.groundBox = bx;
      }
    }
    b.onGround = grounded;
  },

  /** 脚下材质（用于脚步声） */
  surfaceOf(b) {
    if (b.groundBox) {
      const m = b.groundBox.mat;
      return m === 'wood' ? 'wood' : m === 'metal' ? 'metal' : 'stone';
    }
    return MAP.surfaceAt(b.pos.x, b.pos.z);
  },
};


// #####################################################################
// ## 模块文件：06_nav.js
// #####################################################################
// =====================================================================
//  06 导航模块：从碰撞体自动生成 0.8m 导航网格 + A* 寻路 + 路径平滑
//  - 每个格子记录可站立的地面高度；台阶差 ≤0.5m 可双向通行，
//    落差 ≤1.7m 只能往下跳（单向）
//  - 贴墙的格子增加代价，让 Bot 走在通道中间
// =====================================================================

const Nav = {
  S: 0.8,
  W: 0, H: 0, minX: 0, minZ: 0,
  h: null, ok: null, pen: null,

  build() {
    const half = MAP.W * MAP.C / 2;
    this.minX = this.minZ = -half;
    this.W = this.H = Math.round(half * 2 / this.S);
    const N = this.W * this.H;
    this.h = new Float32Array(N);
    this.ok = new Uint8Array(N);
    this.pen = new Float32Array(N);
    const list = [];
    const hw = 0.42;
    const cands = [];
    for (let j = 0; j < this.H; j++) for (let i = 0; i < this.W; i++) {
      const x = this.minX + (i + 0.5) * this.S, z = this.minZ + (j + 0.5) * this.S;
      World.query(x - hw, -1, z - hw, x + hw, 40, z + hw, list);
      cands.length = 0; cands.push(0);
      for (const b of list) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) cands.push(b.y1);
      cands.sort((a, b) => a - b);
      let found = -1;
      for (const hc of cands) {
        let blocked = false;
        for (const b of list) {
          // ① 格子中心处，候选高度正上方就是实体（例如台阶本身）→ 不能站在这个高度
          const inside = x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 && b.y0 < hc + 0.05 && b.y1 > hc + 0.01;
          // ② 身体范围内有高于台阶高度的障碍
          if (inside || (b.y0 < hc + 1.75 && b.y1 > hc + 0.36)) { blocked = true; break; }
        }
        if (!blocked) { found = hc; break; }
      }
      const k = j * this.W + i;
      if (found >= 0 && found < 4) { this.ok[k] = 1; this.h[k] = found; }
    }
    // 只保留从 T 出生点出发可达的区域（去掉箱子顶等孤岛）
    const sp = MAP.SPAWNS.T[0];
    const start = this.idx(MAP.wx(sp[0]), MAP.wz(sp[1]));
    const reach = new Uint8Array(N);
    const q = [start]; reach[start] = 1;
    while (q.length) {
      const cur = q.pop();
      const ci = cur % this.W, cj = (cur / this.W) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= this.W || nj >= this.H) continue;
        const nb = nj * this.W + ni;
        if (reach[nb] || !this.ok[nb]) continue;
        // 按真实通行规则扩展（上台阶 ≤0.5m，可跳下 ≤1.7m）
        if (!this.step(cur, nb)) continue;
        reach[nb] = 1; q.push(nb);
      }
    }
    for (let k = 0; k < N; k++) if (!reach[k]) this.ok[k] = 0;
    // 靠墙惩罚
    for (let j = 0; j < this.H; j++) for (let i = 0; i < this.W; i++) {
      const k = j * this.W + i;
      if (!this.ok[k]) continue;
      let near = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= this.W || nj >= this.H || !this.ok[nj * this.W + ni]) near++;
      }
      this.pen[k] = near ? 0.35 + near * 0.12 : 0;
    }
    // A* 用的工作数组
    this.g = new Float32Array(N);
    this.parent = new Int32Array(N);
    this.seen = new Uint32Array(N);
    this.closed = new Uint32Array(N);
    this.sid = 0;
    this.heapN = new Int32Array(N * 8);
    this.heapF = new Float32Array(N * 8);
  },

  idx(x, z) {
    const i = Math.floor((x - this.minX) / this.S), j = Math.floor((z - this.minZ) / this.S);
    if (i < 0 || j < 0 || i >= this.W || j >= this.H) return -1;
    return j * this.W + i;
  },
  cx(k) { return this.minX + ((k % this.W) + 0.5) * this.S; },
  cz(k) { return this.minZ + (((k / this.W) | 0) + 0.5) * this.S; },
  /** 可通行判断：a→b 相邻格子 */
  step(a, b) {
    const d = this.h[b] - this.h[a];
    return d <= 0.5 && d >= -1.7;
  },
  /** 最近的可走格子（优先同高度） */
  nearest(x, z, y = null) {
    const k0 = this.idx(x, z);
    if (k0 >= 0 && this.ok[k0] && (y === null || Math.abs(this.h[k0] - y) < 1.0)) return k0;
    const ci = Math.floor((x - this.minX) / this.S), cj = Math.floor((z - this.minZ) / this.S);
    let best = -1, bd = Infinity;
    for (let r = 1; r <= 6; r++) {
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= this.W || j >= this.H) continue;
        const k = j * this.W + i;
        if (!this.ok[k]) continue;
        const dx = this.cx(k) - x, dz = this.cz(k) - z;
        let d = dx * dx + dz * dz;
        if (y !== null) d += Math.abs(this.h[k] - y) * 4;
        if (d < bd) { bd = d; best = k; }
      }
      if (best >= 0) return best;
    }
    return best;
  },
  floorAt(x, z) {
    const k = this.nearest(x, z);
    return k >= 0 ? this.h[k] : 0;
  },

  /** A* 寻路，返回平滑后的世界坐标点数组（THREE.Vector3），失败返回 null */
  findPath(sx, sz, tx, tz, sy = null, ty = null) {
    const s = this.nearest(sx, sz, sy), t = this.nearest(tx, tz, ty);
    if (s < 0 || t < 0) return null;
    if (s === t) return [new THREE.Vector3(tx, this.h[t], tz)];
    const W = this.W, H = this.H;
    const sid = ++this.sid;
    const g = this.g, parent = this.parent, seen = this.seen, closed = this.closed, ok = this.ok, hh = this.h, pen = this.pen;
    const hN = this.heapN, hF = this.heapF;
    let hs = 0;
    const tI = t % W, tJ = (t / W) | 0;
    const heur = (k) => {
      const dx = Math.abs((k % W) - tI), dz = Math.abs(((k / W) | 0) - tJ);
      return dx > dz ? dx + 0.4142 * dz : dz + 0.4142 * dx;
    };
    const push = (k, f) => {
      let i = hs++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hF[p] <= f) break;
        hN[i] = hN[p]; hF[i] = hF[p]; i = p;
      }
      hN[i] = k; hF[i] = f;
    };
    const pop = () => {
      const top = hN[0];
      const lk = hN[--hs], lf = hF[hs];
      let i = 0;
      while (true) {
        let c = i * 2 + 1;
        if (c >= hs) break;
        if (c + 1 < hs && hF[c + 1] < hF[c]) c++;
        if (hF[c] >= lf) break;
        hN[i] = hN[c]; hF[i] = hF[c]; i = c;
      }
      hN[i] = lk; hF[i] = lf;
      return top;
    };
    g[s] = 0; parent[s] = -1; seen[s] = sid;
    push(s, heur(s));
    let found = false, expanded = 0;
    while (hs > 0) {
      const cur = pop();
      if (closed[cur] === sid) continue;
      closed[cur] = sid;
      if (cur === t) { found = true; break; }
      if (++expanded > 9000 || hs > hN.length - 16) break;
      const ci = cur % W, cj = (cur / W) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const nb = nj * W + ni;
        if (!ok[nb] || closed[nb] === sid || !this.step(cur, nb)) continue;
        const diag = di && dj;
        if (diag) {
          const a = cj * W + ni, b = nj * W + ci;
          if (!ok[a] || !ok[b] || !this.step(cur, a) || !this.step(cur, b)) continue;
        }
        const drop = hh[nb] < hh[cur] - 0.5 ? 2.0 : 0;
        const ng = g[cur] + (diag ? 1.4142 : 1) + pen[nb] + drop;
        if (seen[nb] !== sid || ng < g[nb]) {
          seen[nb] = sid; g[nb] = ng; parent[nb] = cur;
          push(nb, ng + heur(nb));
        }
      }
    }
    if (!found) return null;
    // 回溯
    const cells = [];
    for (let k = t; k !== -1; k = parent[k]) cells.push(k);
    cells.reverse();
    // 平滑：贪心地跳到最远的可直线到达的点（第一段从角色的实际位置出发检查）
    const out = [];
    // 起点不在可走格子里（例如紧贴箱子）：先走到最近的可走格子，避免直线穿过障碍
    let px = sx, pz = sz;
    if (this.idx(sx, sz) !== s) { out.push(new THREE.Vector3(this.cx(s), hh[s], this.cz(s))); px = this.cx(s); pz = this.cz(s); }
    let i = 0;
    while (i < cells.length - 1) {
      let j = i + 1;
      const lim = Math.min(cells.length - 1, i + 40);
      for (let k = i + 2; k <= lim; k++) {
        if (this.segOK(px, pz, this.cx(cells[k]), this.cz(cells[k]))) j = k; else break;
      }
      out.push(new THREE.Vector3(this.cx(cells[j]), hh[cells[j]], this.cz(cells[j])));
      i = j;
      px = this.cx(cells[j]); pz = this.cz(cells[j]);
    }
    // 终点使用精确目标位置（如果它就在终点格子里）
    const last = out[out.length - 1];
    if (last && this.idx(tx, tz) === t) { last.x = tx; last.z = tz; }
    return out;
  },

  /**
   * 世界坐标线段是否可以直线行走：沿线每 0.2m 采样，
   * 同时检查左右各偏移 0.2m 的两条平行线（考虑身体宽度），并检查高度连续性
   */
  segOK(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return true;
    const n = Math.ceil(len / 0.25);
    let prev = this.idx(ax, az);
    if (prev < 0 || !this.ok[prev]) return false;
    const list = this._segList || (this._segList = []);
    const hw = CFG.PLAYER.HALF_W + 0.02;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = ax + dx * t, z = az + dz * t;
      const k = this.idx(x, z);
      if (k < 0 || !this.ok[k]) return false;
      if (k !== prev && !this.step(prev, k)) return false;
      // 身体包围盒（离地 0.4m 以上）沿线必须畅通 —— 防止擦到箱子角卡住
      const y = Math.max(this.h[k], this.h[prev]);
      if (World.query(x - hw, y + 0.4, z - hw, x + hw, y + 1.75, z + hw, list).length) return false;
      prev = k;
    }
    return true;
  },

  /** 两格之间直线是否可走（DDA 遍历经过的所有格子） */
  lineOK(a, b) {
    const W = this.W;
    let i = a % W, j = (a / W) | 0;
    const ti = b % W, tj = (b / W) | 0;
    const di = ti - i, dj = tj - j;
    const si = di > 0 ? 1 : -1, sj = dj > 0 ? 1 : -1;
    const adi = Math.abs(di), adj = Math.abs(dj);
    let prev = a;
    // 以格子中心为起点的 DDA
    let tMaxI = adi ? 0.5 / adi : Infinity, tMaxJ = adj ? 0.5 / adj : Infinity;
    const tDI = adi ? 1 / adi : Infinity, tDJ = adj ? 1 / adj : Infinity;
    for (let n = 0; n < 200; n++) {
      if (i === ti && j === tj) return true;
      if (Math.abs(tMaxI - tMaxJ) < 1e-9) {
        // 正好穿过格子角点：两侧格子都必须可走
        const k1 = j * W + i + si, k2 = (j + sj) * W + i;
        if (!this.ok[k1] || !this.ok[k2]) return false;
        i += si; j += sj; tMaxI += tDI; tMaxJ += tDJ;
      } else if (tMaxI < tMaxJ) { i += si; tMaxI += tDI; }
      else { j += sj; tMaxJ += tDJ; }
      const k = j * W + i;
      if (!this.ok[k] || !this.step(prev, k)) return false;
      prev = k;
    }
    return false;
  },

  /** 直线距离内随机一个可走点 */
  randomNear(x, z, r) {
    for (let n = 0; n < 20; n++) {
      const a = Math.random() * TAU, d = Math.random() * r;
      const k = this.idx(x + Math.cos(a) * d, z + Math.sin(a) * d);
      if (k >= 0 && this.ok[k]) return new THREE.Vector3(this.cx(k), this.h[k], this.cz(k));
    }
    const k = this.nearest(x, z);
    return new THREE.Vector3(this.cx(k), this.h[k], this.cz(k));
  },
};


// #####################################################################
// ## 模块文件：07_effects.js
// #####################################################################
// =====================================================================
//  07 特效模块
//  - ParticleSystem：单次绘制的 GPU 点精灵粒子（尘土/火花/血/火焰/烟）
//  - DecalPool：InstancedMesh 实现的弹孔/血迹/焦痕贴花（环形复用）
//  - Tracers：曳光弹（LineSegments 一次绘制）
//  - 烟雾弹云团（Sprite 组）与爆炸
// =====================================================================

class ParticleSystem {
  constructor(scene, max, additive) {
    this.max = max;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    // CPU 侧数据
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('pcolor', this.aCol);
    g.setAttribute('psize', this.aSize);
    g.setAttribute('palpha', this.aAlpha);
    g.setDrawRange(0, 0);
    this.uniforms = { map: { value: additive ? Tex.t.soft : Tex.t.smoke }, scale: { value: 500 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `
        attribute vec3 pcolor; attribute float psize; attribute float palpha;
        uniform float scale; varying vec3 vC; varying float vA;
        void main() {
          vC = pcolor; vA = palpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(psize * scale / max(0.05, -mv.z), 900.0);
        }`,
      fragmentShader: `
        uniform sampler2D map; varying vec3 vC; varying float vA;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          float a = t.a * vA;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vC * t.rgb, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
  }
  spawn(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, grav = 0, drag = 0) {
    if (this.count >= this.max) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    this.life[i] = life; this.maxLife[i] = life;
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a;
    this.grav[i] = grav; this.drag[i] = drag;
    this.size[i] = s0; this.alpha[i] = a;
  }
  _copy(dst, src) {
    const d3 = dst * 3, s3 = src * 3;
    for (let k = 0; k < 3; k++) { this.pos[d3 + k] = this.pos[s3 + k]; this.vel[d3 + k] = this.vel[s3 + k]; this.col[d3 + k] = this.col[s3 + k]; }
    this.life[dst] = this.life[src]; this.maxLife[dst] = this.maxLife[src];
    this.s0[dst] = this.s0[src]; this.s1[dst] = this.s1[src]; this.a0[dst] = this.a0[src];
    this.grav[dst] = this.grav[src]; this.drag[dst] = this.drag[src];
    this.size[dst] = this.size[src]; this.alpha[dst] = this.alpha[src];
  }
  update(dt) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this._copy(i, --this.count); continue; }
      const i3 = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= dr; this.vel[i3 + 2] *= dr;
      this.vel[i3 + 1] = this.vel[i3 + 1] * dr - this.grav[i] * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < 0.02 && this.vel[i3 + 1] < 0) { this.pos[i3 + 1] = 0.02; this.vel[i3 + 1] *= -0.3; }
      const t = 1 - this.life[i] / this.maxLife[i];
      this.size[i] = lerp(this.s0[i], this.s1[i], t);
      this.alpha[i] = this.a0[i] * (t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9);
      i++;
    }
    this.points.geometry.setDrawRange(0, this.count);
    if (this.count > 0) {
      this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aSize.needsUpdate = true; this.aAlpha.needsUpdate = true;
    }
  }
  clear() { this.count = 0; this.points.geometry.setDrawRange(0, 0); }
}

class DecalPool {
  constructor(scene, tex, max, lit = true) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const opts = { map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };
    const mat = lit ? new THREE.MeshLambertMaterial(opts) : new THREE.MeshBasicMaterial(opts);
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.max = max;
    this.next = 0;
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.q2 = new THREE.Quaternion();
    this.n = new THREE.Vector3();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3();
    scene.add(this.mesh);
  }
  add(x, y, z, nx, ny, nz, size) {
    this.n.set(nx, ny, nz);
    this.q.setFromUnitVectors(ZUP, this.n);
    this.q2.setFromAxisAngle(ZUP, Math.random() * TAU);
    this.q.multiply(this.q2);
    this.p.set(x + nx * 0.012, y + ny * 0.012, z + nz * 0.012);
    this.s.set(size, size, size);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(this.next, this.m);
    this.next = (this.next + 1) % this.max;
    this.mesh.count = Math.min(this.max, this.mesh.count + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() { this.mesh.count = 0; this.next = 0; }
}
const ZUP = new THREE.Vector3(0, 0, 1);

/** 曳光弹：以约 280m/s 前进的一小段亮线 */
class Tracers {
  constructor(scene, max) {
    this.max = max;
    this.list = [];
    this.pos = new Float32Array(max * 6);
    this.col = new Float32Array(max * 6);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('color', this.aCol);
    g.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 4;
    scene.add(this.lines);
  }
  add(ax, ay, az, bx, by, bz) {
    if (this.list.length >= this.max) this.list.shift();
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1.5) return;
    this.list.push({ ax, ay, az, dx: dx / len, dy: dy / len, dz: dz / len, len, head: 0.6 });
  }
  update(dt) {
    let n = 0;
    const speed = 280, streak = 3.2;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i];
      t.head += speed * dt;
      const tail = t.head - streak;
      if (tail >= t.len) { this.list.splice(i, 1); continue; }
      const h = Math.min(t.head, t.len), tl = Math.max(0, tail);
      const o = n * 6;
      this.pos[o] = t.ax + t.dx * tl; this.pos[o + 1] = t.ay + t.dy * tl; this.pos[o + 2] = t.az + t.dz * tl;
      this.pos[o + 3] = t.ax + t.dx * h; this.pos[o + 4] = t.ay + t.dy * h; this.pos[o + 5] = t.az + t.dz * h;
      this.col[o] = 0.25; this.col[o + 1] = 0.18; this.col[o + 2] = 0.06;
      this.col[o + 3] = 1.0; this.col[o + 4] = 0.85; this.col[o + 5] = 0.45;
      n++;
    }
    this.lines.geometry.setDrawRange(0, n * 2);
    if (n) { this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; }
  }
  clear() { this.list.length = 0; this.lines.geometry.setDrawRange(0, 0); }
}

// 各材质的弹着点粉尘颜色
const IMPACT_COLOR = {
  stone: [0.75, 0.68, 0.55], ground: [0.78, 0.66, 0.46], wood: [0.5, 0.36, 0.2], metal: [0.55, 0.55, 0.55],
};

const FX = {
  ready: false,        // 只有客户端初始化渲染资源；服务器上只运行烟雾的逻辑部分
  smokes: [],          // 烟雾弹云团（逻辑 + 可选的 Sprite 组）
  shake: 0,            // 屏幕震动强度（由玩家相机读取）
  init(scene) {
    this.scene = scene;
    this.add = new ParticleSystem(scene, 1600, true);
    this.norm = new ParticleSystem(scene, 3000, false);
    this.holes = new DecalPool(scene, Tex.t.hole, 200);
    this.bloodDecals = new DecalPool(scene, Tex.t.blood, 60);
    this.scorches = new DecalPool(scene, Tex.t.scorch, 16);
    this.tracers = new Tracers(scene, 48);
    // 第三人称枪口火焰（Bot 开火时显示）
    this.flashes = [];
    const fm = new THREE.SpriteMaterial({ map: Tex.t.muzzle, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    for (let i = 0; i < 12; i++) {
      const s = new THREE.Sprite(fm);
      s.visible = false; s.userData.t = 0;
      scene.add(s); this.flashes.push(s);
    }
    this.flashIdx = 0;
    // 大型爆炸闪光（加色 Sprite）
    this.booms = [];
    const bm = new THREE.SpriteMaterial({ map: Tex.t.soft, color: 0xffd9a0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Sprite(bm.clone());
      s.visible = false; s.userData.t = 0;
      scene.add(s); this.booms.push(s);
    }
    this.smokeMat = new THREE.SpriteMaterial({ map: Tex.t.smoke, color: 0xb9bbb8, depthWrite: false, transparent: true, fog: true });
    this.ready = true;
  },

  setScale(h, fovDeg) {
    if (!this.ready) return;
    const s = h / (2 * Math.tan(fovDeg * DEG / 2));
    this.add.uniforms.scale.value = s;
    this.norm.uniforms.scale.value = s;
  },

  update(dt) {
    if (this.ready) {
      this.add.update(dt);
      this.norm.update(dt);
      this.tracers.update(dt);
      for (const s of this.flashes) if (s.visible && (s.userData.t -= dt) <= 0) s.visible = false;
      for (const s of this.booms) {
        if (!s.visible) continue;
        s.userData.t -= dt;
        const k = s.userData.t / s.userData.dur;
        if (k <= 0) { s.visible = false; continue; }
        s.material.opacity = k;
        const sc = s.userData.size * (1.2 - k * 0.5);
        s.scale.set(sc, sc, 1);
      }
    }
    this.updateSmokes(dt);
    this.shake = Math.max(0, this.shake - dt * 2.5);
  },

  clear() {
    for (const s of this.smokes) if (s.group) this.scene.remove(s.group);
    this.smokes.length = 0;
    if (!this.ready) return;
    this.add.clear(); this.norm.clear(); this.holes.clear(); this.bloodDecals.clear(); this.scorches.clear(); this.tracers.clear();
    for (const s of this.booms) s.visible = false;
  },

  // ---------------- 子弹命中 ----------------
  impact(x, y, z, nx, ny, nz, mat, exit = false) {
    if (!this.ready) return;
    const c = IMPACT_COLOR[mat] || IMPACT_COLOR.stone;
    const n = exit ? 4 : 7;
    for (let i = 0; i < n; i++) {
      const sp = rand(0.6, 2.6);
      this.norm.spawn(x, y, z, nx * sp + rand(-0.8, 0.8), ny * sp + rand(-0.3, 1.2), nz * sp + rand(-0.8, 0.8),
        rand(0.35, 0.8), rand(0.05, 0.1), rand(0.25, 0.5), c[0], c[1], c[2], 0.75, 1.5, 3);
    }
    if (mat === 'metal' || (mat === 'stone' && Math.random() < 0.3)) {
      for (let i = 0; i < 5; i++) {
        this.add.spawn(x, y, z, nx * rand(1, 5) + rand(-2, 2), ny * rand(1, 5) + rand(0, 3), nz * rand(1, 5) + rand(-2, 2),
          rand(0.08, 0.25), 0.04, 0.02, 1, 0.75, 0.4, 1, 9, 1);
      }
    }
    if (!mat || mat !== 'ground' || true) this.holes.add(x, y, z, nx, ny, nz, exit ? 0.09 : rand(0.07, 0.1));
  },
  blood(x, y, z, dx, dy, dz, head) {
    if (!this.ready) return;
    const n = head ? 12 : 7;
    for (let i = 0; i < n; i++) {
      const sp = rand(0.5, 2.5);
      this.norm.spawn(x, y, z, dx * sp + rand(-0.8, 0.8), dy * sp + rand(-0.2, 1.2), dz * sp + rand(-0.8, 0.8),
        rand(0.3, 0.7), rand(0.05, 0.09), rand(0.14, 0.3), rand(0.45, 0.62), 0.02, 0.02, 0.9, 6, 2);
    }
    // 喷到后方墙面/地面的血迹
    if (World.raycast(x, y, z, dx, dy - 0.3, dz, 2.5, World._hit)) {
      const h = World._hit;
      this.bloodDecals.add(h.x, h.y, h.z, h.nx, h.ny, h.nz, rand(0.3, 0.6));
    }
  },
  muzzle(x, y, z) {
    if (!this.ready) return;
    const s = this.flashes[this.flashIdx = (this.flashIdx + 1) % this.flashes.length];
    s.position.set(x, y, z);
    const k = rand(0.35, 0.55);
    s.scale.set(k, k, 1);
    s.material.rotation = Math.random() * TAU;
    s.visible = true; s.userData.t = 0.05;
  },
  boom(x, y, z, size, dur, color = 0xffd9a0) {
    if (!this.ready) return;
    const s = this.booms.find(b => !b.visible) || this.booms[0];
    s.position.set(x, y, z);
    s.material.color.setHex(color);
    s.userData.t = dur; s.userData.dur = dur; s.userData.size = size;
    s.visible = true;
  },

  // ---------------- 爆炸（高爆手雷 / C4） ----------------
  explosion(x, y, z, big) {
    if (!this.ready) return;
    const k = big ? 2.2 : 1;
    this.boom(x, y + 0.5, z, 9 * k, 0.35 * k);
    for (let i = 0; i < 40 * k; i++) {
      const a = Math.random() * TAU, e = Math.random() * 1.2, sp = rand(3, 11) * k;
      this.add.spawn(x, y + 0.3, z, Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp, Math.sin(a) * Math.cos(e) * sp,
        rand(0.25, 0.6), rand(0.5, 1.1) * k, rand(1.5, 2.6) * k, 1, rand(0.45, 0.7), 0.15, 1, -2, 4);
    }
    for (let i = 0; i < 26 * k; i++) {
      const a = Math.random() * TAU, sp = rand(0.5, 3) * k;
      this.norm.spawn(x + rand(-1, 1), y + rand(0.2, 1.5), z + rand(-1, 1), Math.cos(a) * sp, rand(0.8, 3), Math.sin(a) * sp,
        rand(1.8, 3.5) * (big ? 1.4 : 1), rand(1, 2) * k, rand(3.5, 6) * k, 0.2, 0.19, 0.17, 0.75, -0.4, 1.2);
    }
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * TAU, sp = rand(6, 16);
      this.add.spawn(x, y + 0.3, z, Math.cos(a) * sp, rand(2, 9), Math.sin(a) * sp, rand(0.4, 1.0), 0.06, 0.03, 1, 0.8, 0.4, 1, 14, 0.5);
    }
    this.scorches.add(x, Math.max(0.01, y), z, 0, 1, 0, 3.2 * k);
  },
  flashbang(x, y, z) {
    if (!this.ready) return;
    this.boom(x, y, z, 6, 0.18, 0xffffff);
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * TAU, sp = rand(3, 9);
      this.add.spawn(x, y, z, Math.cos(a) * sp, rand(-2, 5), Math.sin(a) * sp, rand(0.15, 0.4), 0.08, 0.02, 1, 1, 0.9, 1, 8, 1);
    }
  },

  // ---------------- 烟雾弹 ----------------
  spawnSmoke(x, y, z, age = 0) {
    const group = this.ready ? new THREE.Group() : null;
    const puffs = [];
    const N = this.ready ? 20 : 0;
    for (let i = 0; i < N; i++) {
      const s = new THREE.Sprite(this.smokeMat.clone());
      const a = Math.random() * TAU, r = Math.sqrt(Math.random());
      const off = new THREE.Vector3(Math.cos(a) * r * 0.78, rand(0.0, 0.75), Math.sin(a) * r * 0.78);
      const g = rand(0.62, 0.8);
      s.material.color.setRGB(g, g * 1.01, g * 0.98);
      s.material.rotation = Math.random() * TAU;
      s.userData = { off, size: rand(3.4, 5.0), spin: rand(-0.12, 0.12), seed: Math.random() * 10 };
      group.add(s);
      puffs.push(s);
    }
    if (group) this.scene.add(group);
    const sm = { group, puffs, x, y, z, t: age, center: new THREE.Vector3(x, y + 1.5, z), radius: 0.3, density: 1 };
    this.smokes.push(sm);
    return sm;
  },
  updateSmokes(dt) {
    const N = CFG.NADE;
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.t += dt;
      const bloom = smoothstep(0, N.SMOKE_BLOOM, s.t);
      const fade = s.t > N.SMOKE_TIME - 2.5 ? clamp((N.SMOKE_TIME - s.t) / 2.5, 0, 1) : 1;
      s.radius = N.SMOKE_RADIUS * (0.25 + 0.75 * bloom) * (fade < 1 ? 0.6 + 0.4 * fade : 1);
      s.density = fade;
      for (const p of s.puffs) {
        const u = p.userData;
        const R = N.SMOKE_RADIUS * (0.2 + 0.8 * bloom);
        p.position.set(s.x + u.off.x * R + Math.sin(s.t * 0.3 + u.seed) * 0.25, s.y + 0.6 + u.off.y * R * 0.7, s.z + u.off.z * R + Math.cos(s.t * 0.25 + u.seed) * 0.25);
        const sz = u.size * (0.35 + 0.65 * bloom);
        p.scale.set(sz, sz, 1);
        p.material.rotation += u.spin * dt;
        p.material.opacity = 0.92 * fade;
      }
      if (s.t >= N.SMOKE_TIME) {
        if (s.group) this.scene.remove(s.group);
        for (const p of s.puffs) p.material.dispose();
        this.smokes.splice(i, 1);
      }
    }
  },
  /** 线段 a→b 是否被烟雾阻挡（穿过烟雾球体的长度超过阈值） */
  smokeBlocks(ax, ay, az, bx, by, bz) {
    if (!this.smokes.length) return false;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) return false;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    for (const s of this.smokes) {
      if (s.density < 0.25 || s.t < 0.35) continue;
      const cx = s.center.x - ax, cy = s.center.y - ay, cz = s.center.z - az;
      const tca = cx * ux + cy * uy + cz * uz;
      const d2 = cx * cx + cy * cy + cz * cz - tca * tca;
      const r2 = s.radius * s.radius;
      if (d2 >= r2) continue;
      const thc = Math.sqrt(r2 - d2);
      const t0 = Math.max(0, tca - thc), t1 = Math.min(len, tca + thc);
      if (t1 - t0 > 0.9) return true;
      // 端点在烟里也算看不见（身在烟中）
      if (t1 > t0 && (t0 <= 0.01 || t1 >= len - 0.01) && t1 - t0 > 0.3) return true;
    }
    return false;
  },
  /** 某点处于烟雾中的深度（0..1），用于屏幕灰化 */
  smokeDepthAt(p) {
    let best = 0;
    for (const s of this.smokes) {
      const d = p.distanceTo(s.center);
      const k = (1 - d / (s.radius * 0.95)) * s.density;
      if (k > best) best = k;
    }
    return clamp(best, 0, 1);
  },
};


// #####################################################################
// ## 模块文件：08_weapons.js
// #####################################################################
// =====================================================================
//  08 武器模块
//  - WEAPONS：武器数值（伤害/护甲穿透/射速/弹匣/扩散/后坐力弹道/价格）
//  - GunModels：用几何体拼出枪械模型（第一人称 & 第三人称/掉落物）
//  - ViewModel：第一人称持枪渲染（独立场景，避免穿模）与动画
// =====================================================================

// ---- 后坐力弹道：每发子弹相对准心的偏移（度），x 向右，y 向上 ----
const PATTERN_K47 = [
  [0, 0], [0, 0.35], [0.05, 0.9], [-0.05, 1.6], [-0.15, 2.4], [0.05, 3.2], [0.3, 3.95], [0.45, 4.6], [0.3, 5.15], [-0.3, 5.55],
  [-1.0, 5.85], [-1.7, 6.05], [-2.2, 6.2], [-2.05, 6.4], [-1.4, 6.5], [-0.5, 6.55], [0.4, 6.5], [1.3, 6.45], [2.1, 6.55], [2.6, 6.7],
  [2.35, 6.8], [1.6, 6.75], [0.6, 6.8], [-0.4, 6.9], [-1.3, 6.85], [-2.0, 6.85], [-2.35, 6.95], [-1.9, 7.05], [-0.9, 7.05], [0.1, 7.1],
];
const PATTERN_M4 = [
  [0, 0], [0, 0.3], [0.05, 0.75], [0, 1.3], [-0.1, 1.95], [0.05, 2.6], [0.2, 3.2], [0.3, 3.7], [0.1, 4.1], [-0.3, 4.4],
  [-0.85, 4.6], [-1.3, 4.75], [-1.5, 4.9], [-1.2, 5.0], [-0.6, 5.05], [0.1, 5.05], [0.8, 5.0], [1.35, 5.05], [1.6, 5.15], [1.3, 5.25],
  [0.7, 5.2], [0.0, 5.25], [-0.6, 5.35], [-1.1, 5.3], [-1.3, 5.35], [-0.9, 5.45], [-0.3, 5.45], [0.3, 5.5], [0.8, 5.55], [1.0, 5.6],
];
/** 程序生成弹道：前 climbShots 发主要向上，之后左右摆动 */
function genPattern(n, climb, climbShots, sway, period, seed) {
  const r = new RNG(seed);
  const out = [[0, 0]];
  let y = 0;
  for (let i = 1; i < n; i++) {
    const k = i < climbShots ? 1 - i / climbShots * 0.35 : 0.08;
    y += climb * k * (0.85 + r.next() * 0.3);
    const x = Math.sin((i - climbShots * 0.7) / period * TAU) * sway * clamp((i - climbShots * 0.6) / 4, 0, 1) + (r.next() - 0.5) * 0.18;
    out.push([x, y]);
  }
  return out;
}
function samplePattern(p, idx) {
  if (!p) return ZERO2;
  const i0 = Math.min(p.length - 1, Math.floor(idx)), i1 = Math.min(p.length - 1, i0 + 1);
  const f = idx - Math.floor(idx);
  PAT_OUT[0] = lerp(p[i0][0], p[i1][0], f);
  PAT_OUT[1] = lerp(p[i0][1], p[i1][1], f);
  return PAT_OUT;
}
const ZERO2 = [0, 0], PAT_OUT = [0, 0];

// ---- 武器数值 ----
//  damage：基础伤害；armorPen：打在护甲上保留的伤害比例；falloff：每 12.7m 的伤害衰减系数
//  rate：射击间隔；pen：穿透能力；speed：持枪移动速度（u/s，250=满速）
//  spread：base 站立、crouch 下蹲、move 满速移动附加、air 空中附加、shot 每发附加、max 上限、recover 恢复时间常数
const WEAPONS = {
  knife: {
    id: 'knife', name: '匕首', slot: 'knife', kind: 'knife', price: 0, reward: 1500, speed: 250,
    damage: 40, heavy: 65, rate: 0.42, heavyRate: 1.0, range: 1.9, draw: 0.5, model: 'knife',
  },
  g18: {
    id: 'g18', name: 'G18', full: 'G18 手枪', slot: 'secondary', kind: 'pistol', side: 'T', price: 200, reward: 300,
    damage: 30, armorPen: 0.47, falloff: 0.85, rate: 0.15, auto: false, mag: 20, reserve: 120, reload: 2.2, draw: 0.75,
    speed: 240, pen: 1.0, snd: 'pistol', model: 'g18', kick: 1.1,
    spread: { base: 0.4, crouch: 0.32, move: 2.6, air: 6.0, shot: 1.3, max: 5, recover: 0.3 },
    pattern: genPattern(20, 0.55, 20, 0.3, 8, 11), recoverT: 0.14,
    desc: '默认手枪，弹匣容量大',
  },
  p2k: {
    id: 'p2k', name: 'P2K', full: 'P2K 手枪', slot: 'secondary', kind: 'pistol', side: 'CT', price: 200, reward: 300,
    damage: 35, armorPen: 0.505, falloff: 0.91, rate: 0.17, auto: false, mag: 12, reserve: 24, reload: 2.2, draw: 0.75,
    speed: 240, pen: 1.0, snd: 'pistol', model: 'p2k', kick: 1.2,
    spread: { base: 0.3, crouch: 0.24, move: 2.8, air: 6.0, shot: 1.4, max: 5, recover: 0.32 },
    pattern: genPattern(12, 0.6, 12, 0.3, 8, 12), recoverT: 0.15,
    desc: 'CT 默认手枪，精准',
  },
  d50: {
    id: 'd50', name: 'D-50', full: 'D-50 沙漠之鹰', slot: 'secondary', kind: 'pistol', price: 700, reward: 300,
    damage: 63, armorPen: 0.932, falloff: 0.81, rate: 0.225, auto: false, mag: 7, reserve: 35, reload: 2.2, draw: 0.9,
    speed: 230, pen: 2.0, snd: 'deagle', model: 'd50', kick: 3.2,
    spread: { base: 0.35, crouch: 0.28, move: 4.5, air: 9.0, shot: 3.5, max: 7, recover: 0.45 },
    pattern: genPattern(7, 1.6, 7, 0.5, 6, 13), recoverT: 0.22,
    desc: '一枪爆头，高风险高回报',
  },
  v45: {
    id: 'v45', name: 'V-45', full: 'V-45 冲锋枪', slot: 'primary', kind: 'smg', price: 1200, reward: 600,
    damage: 35, armorPen: 0.65, falloff: 0.85, rate: 0.09, auto: true, mag: 25, reserve: 100, reload: 3.1, draw: 1.0,
    speed: 230, pen: 1.0, snd: 'smg', model: 'v45', kick: 0.8,
    spread: { base: 0.55, crouch: 0.42, move: 2.8, air: 8.0, shot: 0.6, max: 4.5, recover: 0.3 },
    pattern: genPattern(25, 0.5, 9, 1.1, 10, 14), recoverT: 0.16,
    desc: '击杀奖励 $600，移动射击稳定',
  },
  g35: {
    id: 'g35', name: 'G-35', full: 'G-35 突击步枪', slot: 'primary', kind: 'rifle', price: 1800, reward: 300,
    damage: 30, armorPen: 0.775, falloff: 0.98, rate: 0.09, auto: true, mag: 35, reserve: 90, reload: 2.7, draw: 1.0,
    speed: 215, pen: 2.2, snd: 'm4', model: 'g35', kick: 0.9,
    spread: { base: 0.35, crouch: 0.26, move: 5.5, air: 11, shot: 0.55, max: 4.5, recover: 0.36 },
    pattern: genPattern(35, 0.62, 10, 1.6, 12, 15), recoverT: 0.18,
    desc: '经济型步枪，弹匣 35 发',
  },
  k47: {
    id: 'k47', name: 'K-47', full: 'K-47 突击步枪', slot: 'primary', kind: 'rifle', price: 2700, reward: 300,
    damage: 36, armorPen: 0.775, falloff: 0.98, rate: 0.1, auto: true, mag: 30, reserve: 90, reload: 2.45, draw: 1.0,
    speed: 215, pen: 2.5, snd: 'rifle', model: 'k47', kick: 1.0,
    spread: { base: 0.28, crouch: 0.2, move: 6.5, air: 12, shot: 0.55, max: 4.5, recover: 0.36 },
    pattern: PATTERN_K47, recoverT: 0.18,
    desc: '一枪爆头（含头盔），后坐力大',
  },
  m4: {
    id: 'm4', name: 'M4', full: 'M4 卡宾枪', slot: 'primary', kind: 'rifle', side: 'CT', price: 3100, reward: 300,
    damage: 33, armorPen: 0.70, falloff: 0.97, rate: 0.09, auto: true, mag: 30, reserve: 90, reload: 3.05, draw: 1.0,
    speed: 225, pen: 2.4, snd: 'm4', model: 'm4', kick: 0.85,
    spread: { base: 0.22, crouch: 0.16, move: 5.5, air: 11, shot: 0.45, max: 4.0, recover: 0.33 },
    pattern: PATTERN_M4, recoverT: 0.17,
    desc: 'CT 步枪，稳定易控',
  },
  s08: {
    id: 's08', name: 'S-08', full: 'S-08 轻型狙击枪', slot: 'primary', kind: 'sniper', price: 1700, reward: 300,
    damage: 88, armorPen: 0.85, falloff: 0.98, rate: 1.25, auto: false, mag: 10, reserve: 90, reload: 3.7, draw: 1.1,
    speed: 230, pen: 2.5, snd: 'scout', model: 's08', kick: 2.5, zoom: [34, 14], scopedSpeed: 230, bolt: true,
    spread: { base: 3.2, crouch: 2.8, move: 4.0, air: 5.0, shot: 1.0, max: 3, recover: 0.4, sBase: 0.03, sCrouch: 0.02, sMove: 3.5, sAir: 0.4 },
    desc: '机动性好，跳跃中依然精准',
  },
  l96: {
    id: 'l96', name: 'L-96', full: 'L-96 重型狙击枪', slot: 'primary', kind: 'sniper', price: 4750, reward: 100,
    damage: 115, armorPen: 0.975, falloff: 0.99, rate: 1.46, auto: false, mag: 5, reserve: 30, reload: 3.6, draw: 1.25,
    speed: 200, pen: 3.0, snd: 'sniper', model: 'l96', kick: 4.0, zoom: [30, 10], scopedSpeed: 150, bolt: true,
    spread: { base: 6.0, crouch: 5.0, move: 7.0, air: 14, shot: 3.0, max: 6, recover: 0.6, sBase: 0.02, sCrouch: 0.015, sMove: 7.0, sAir: 14 },
    desc: '一枪击杀躯干，击杀奖励仅 $100',
  },
};

// 投掷物与装备
const NADES = {
  he: { id: 'he', name: '高爆手雷', price: 300, max: 1, reward: 300, color: 0x4e5a2e },
  flash: { id: 'flash', name: '闪光弹', price: 200, max: 2, reward: 300, color: 0xb9bcbf },
  smoke: { id: 'smoke', name: '烟雾弹', price: 300, max: 1, reward: 300, color: 0x6d726e },
};
const NADE_ORDER = ['he', 'flash', 'smoke'];

/**
 * 把一个 Group 里所有 Mesh 合并成一个带顶点色的 BufferGeometry（颜色取自各自材质）。
 * 用于第三人称枪械、角色身体等，大幅减少绘制调用。
 */
function mergeGroup(root) {
  root.updateMatrixWorld(true);
  const pos = [], nor = [], col = [], idx = [];
  let base = 0;
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  root.traverse(o => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    const p = geo.attributes.position, n = geo.attributes.normal;
    nm.getNormalMatrix(o.matrixWorld);
    const c = o.userData.color || o.material.color;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); nor.push(v.x, v.y, v.z);
      col.push(c.r, c.g, c.b);
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) idx.push(geo.index.getX(i) + base);
    else for (let i = 0; i < p.count; i++) idx.push(i + base);
    base += p.count;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// =====================================================================
//  枪械模型
// =====================================================================
const GunModels = {
  cache: {},
  mats: null,
  initMats() {
    const P = (c, sh = 30, sp = 0x333333) => new THREE.MeshPhongMaterial({ color: c, shininess: sh, specular: sp });
    this.mats = {
      metal: P(0x2b2e33, 45, 0x555555), metalL: P(0x4a4e55, 50, 0x666666), steel: P(0x9a9ea4, 70, 0x999999),
      poly: P(0x1c1d20, 12, 0x222222), wood: P(0x7a4a26, 18, 0x2a2a2a), woodD: P(0x5a3519, 16, 0x222222),
      olive: P(0x4f5a38, 18, 0x2a2a2a), tan: P(0x9c8a64, 15, 0x222222), blue: P(0x3d4a5a, 20, 0x333333),
      glove: P(0x2a2622, 8, 0x111111), sleeveT: P(0x4f4431, 6, 0x111111), sleeveCT: P(0x2f3b4e, 6, 0x111111),
      skin: P(0xc69a7a, 8, 0x111111), lens: new THREE.MeshPhongMaterial({ color: 0x1a2d3c, shininess: 90, specular: 0x88aacc }),
      heCol: P(0x4e5a2e, 20), flashCol: P(0xb9bcbf, 40, 0x666666), smokeCol: P(0x6d726e, 20),
      c4: P(0x9b8a5e, 10), c4screen: new THREE.MeshBasicMaterial({ color: 0x5dff7a }), red: new THREE.MeshBasicMaterial({ color: 0xff2a1a }),
    };
  },
  _box(g, mat, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    g.add(m); return m;
  },
  _cyl(g, mat, r, len, x, y, z, axis = 'z', seg = 10, r2) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r2 !== undefined ? r2 : r, r, len, seg), mat);
    m.position.set(x, y, z);
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    else if (axis === 'x') m.rotation.z = Math.PI / 2;
    g.add(m); return m;
  },

  /** 构建模型：返回 Group，userData 包含 muzzle（枪口位置）、mag（弹匣，用于换弹动画）、slide（套筒） */
  build(id) {
    if (!this.mats) this.initMats();
    const M = this.mats;
    const g = new THREE.Group();
    const ud = g.userData;
    ud.muzzle = new THREE.Vector3(0, 0.03, -0.8);
    ud.rightHand = new THREE.Vector3(0, -0.05, 0.03);
    ud.leftHand = new THREE.Vector3(0, -0.02, -0.4);
    const B = (...a) => this._box(g, ...a), Cy = (...a) => this._cyl(g, ...a);
    const magGroup = (x, y, z) => { const mg = new THREE.Group(); mg.position.set(x, y, z); g.add(mg); ud.mag = mg; ud.magRest = mg.position.clone(); return mg; };
    switch (id) {
      case 'k47':
      case 'g35': {
        const ak = id === 'k47';
        const furn = ak ? M.wood : M.poly;
        B(M.metal, 0.05, 0.075, 0.40, 0, 0.02, -0.12);
        B(M.metalL, 0.046, 0.022, 0.36, 0, 0.068, -0.11);
        B(furn, 0.058, 0.055, 0.2, 0, 0.005, -0.43);
        B(furn, 0.042, 0.03, 0.18, 0, 0.055, -0.42);
        Cy(M.metal, 0.011, 0.27, 0, 0.025, -0.65);
        B(M.metal, 0.012, 0.045, 0.012, 0, 0.058, -0.72);
        B(M.metal, 0.022, 0.022, 0.03, 0, 0.035, -0.72);
        Cy(M.metal, 0.016, 0.05, 0, 0.025, -0.8);
        B(M.metal, 0.03, 0.02, 0.05, 0, 0.082, -0.29);
        const mg = magGroup(0, -0.03, -0.19);
        this._box(mg, ak ? M.metal : M.poly, 0.032, 0.1, 0.066, 0, -0.05, 0, 0.12);
        this._box(mg, ak ? M.metal : M.poly, 0.032, 0.1, 0.064, 0, -0.14, -0.028, 0.42);
        B(furn, 0.032, 0.1, 0.04, 0, -0.065, 0.025, -0.35);
        B(M.metal, 0.008, 0.008, 0.06, 0, -0.03, -0.03);
        if (ak) {
          B(M.wood, 0.042, 0.075, 0.26, 0, -0.012, 0.22, 0.09);
          B(M.woodD, 0.046, 0.11, 0.02, 0, -0.03, 0.35, 0.09);
        } else {
          B(M.metal, 0.012, 0.012, 0.26, 0.015, 0.02, 0.2);
          B(M.metal, 0.012, 0.012, 0.26, -0.015, -0.03, 0.2, 0.18);
          B(M.poly, 0.04, 0.1, 0.025, 0, -0.02, 0.33);
        }
        ud.muzzle.set(0, 0.025, -0.83);
        ud.leftHand.set(0, -0.015, -0.43);
        break;
      }
      case 'm4': {
        B(M.metal, 0.046, 0.06, 0.26, 0, 0.03, -0.1);
        B(M.metal, 0.042, 0.05, 0.2, 0, -0.02, -0.08);
        B(M.poly, 0.024, 0.014, 0.5, 0, 0.067, -0.2);
        B(M.poly, 0.022, 0.035, 0.05, 0, 0.09, -0.02);
        B(M.metalL, 0.056, 0.056, 0.26, 0, 0.03, -0.37);
        B(M.metal, 0.012, 0.06, 0.02, 0, 0.085, -0.47);
        Cy(M.metal, 0.01, 0.2, 0, 0.03, -0.58);
        Cy(M.metal, 0.014, 0.06, 0, 0.03, -0.69);
        const mg = magGroup(0, -0.04, -0.13);
        this._box(mg, M.metalL, 0.028, 0.16, 0.06, 0, -0.07, 0, 0.12);
        B(M.poly, 0.03, 0.1, 0.038, 0, -0.07, 0.03, -0.35);
        Cy(M.poly, 0.016, 0.18, 0, 0.02, 0.12);
        B(M.poly, 0.04, 0.085, 0.14, 0, 0.0, 0.21);
        ud.muzzle.set(0, 0.03, -0.73);
        ud.leftHand.set(0, 0.0, -0.37);
        break;
      }
      case 'v45': {
        B(M.poly, 0.055, 0.11, 0.34, 0, 0.0, -0.12);
        B(M.metal, 0.02, 0.012, 0.28, 0, 0.062, -0.12);
        Cy(M.metal, 0.012, 0.09, 0, 0.02, -0.33);
        const mg = magGroup(0, -0.06, -0.14);
        this._box(mg, M.poly, 0.03, 0.15, 0.05, 0, -0.07, 0, 0.05);
        B(M.poly, 0.032, 0.1, 0.04, 0, -0.08, 0.03, -0.3);
        B(M.poly, 0.012, 0.07, 0.2, 0, -0.01, 0.16);
        B(M.poly, 0.035, 0.09, 0.025, 0, -0.02, 0.26);
        ud.muzzle.set(0, 0.02, -0.39);
        ud.leftHand.set(0, -0.03, -0.26);
        break;
      }
      case 's08':
      case 'l96': {
        const awp = id === 'l96';
        const body = awp ? M.olive : M.blue;
        B(body, 0.058, 0.085, awp ? 0.6 : 0.52, 0, -0.005, -0.05);
        B(M.metal, 0.042, 0.05, 0.28, 0, 0.04, -0.07);
        Cy(M.metal, awp ? 0.013 : 0.01, awp ? 0.55 : 0.5, 0, 0.035, awp ? -0.6 : -0.55);
        if (awp) Cy(M.metal, 0.019, 0.07, 0, 0.035, -0.9);
        // 瞄准镜
        Cy(M.metal, 0.022, 0.3, 0, 0.11, -0.06);
        Cy(M.metal, awp ? 0.034 : 0.028, 0.07, 0, 0.11, -0.24, 'z', 12, awp ? 0.024 : 0.022);
        Cy(M.metal, 0.028, 0.06, 0, 0.11, 0.11);
        this._cyl(g, M.lens, 0.03, 0.004, 0, 0.11, -0.276);
        B(M.metal, 0.02, 0.04, 0.02, 0, 0.075, -0.15);
        B(M.metal, 0.02, 0.04, 0.02, 0, 0.075, 0.02);
        // 拉栓
        Cy(M.steel, 0.006, 0.05, 0.04, 0.04, 0.07, 'x');
        const knob = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), M.steel);
        knob.position.set(0.068, 0.04, 0.07); g.add(knob);
        const mg = magGroup(0, -0.05, -0.05);
        this._box(mg, M.metal, 0.035, 0.06, 0.08, 0, -0.03, 0);
        B(body, 0.036, 0.1, 0.05, 0, -0.08, 0.1, -0.3);
        B(body, 0.05, 0.13, 0.2, 0, -0.03, 0.33);
        ud.muzzle.set(0, 0.035, awp ? -0.94 : -0.8);
        ud.leftHand.set(0, -0.035, -0.36);
        ud.rightHand.set(0, -0.06, 0.1);
        break;
      }
      case 'g18':
      case 'p2k':
      case 'd50': {
        const de = id === 'd50';
        const L = de ? 0.25 : id === 'p2k' ? 0.2 : 0.185;
        const slide = new THREE.Group(); g.add(slide); ud.slide = slide;
        this._box(slide, de ? M.steel : M.metal, de ? 0.034 : 0.028, de ? 0.042 : 0.032, L, 0, 0.037, -L / 2 + 0.03);
        this._box(slide, M.poly, 0.006, 0.008, 0.01, 0, 0.058, -L + 0.04);
        this._box(slide, M.poly, 0.016, 0.008, 0.01, 0, 0.058, 0.02);
        B(de ? M.steel : M.poly, 0.026, 0.02, L * 0.9, 0, 0.012, -L / 2 + 0.035);
        B(de ? M.poly : M.poly, 0.028, 0.105, 0.045, 0, -0.04, 0.005, -0.25);
        B(M.poly, 0.006, 0.006, 0.05, 0, -0.006, -0.045);
        const mg = magGroup(0, -0.09, 0.02);
        this._box(mg, M.metal, 0.024, 0.02, 0.04, 0, 0, 0, -0.25);
        ud.muzzle.set(0, 0.037, -L + 0.02);
        ud.rightHand.set(0, -0.045, 0.01);
        ud.leftHand.set(-0.02, -0.05, 0.0);
        ud.pistol = true;
        break;
      }
      case 'knife': {
        B(M.poly, 0.024, 0.03, 0.11, 0, 0, 0.02);
        B(M.metal, 0.05, 0.012, 0.012, 0, 0, -0.04);
        B(M.steel, 0.004, 0.032, 0.15, 0, 0.004, -0.12);
        B(M.steel, 0.004, 0.022, 0.05, 0, 0.012, -0.205, -0.35);
        ud.muzzle.set(0, 0, -0.2);
        ud.rightHand.set(0, 0, 0.02);
        ud.leftHand = null;
        ud.knife = true;
        break;
      }
      case 'he': {
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.034, 12, 10), M.heCol); g.add(s);
        Cy(M.metal, 0.011, 0.03, 0, 0.04, 0, 'y');
        B(M.metal, 0.01, 0.06, 0.012, 0.012, 0.02, 0.012, 0, 0, -0.2);
        ud.rightHand.set(0, -0.02, 0.01); ud.leftHand = null; ud.nade = true;
        break;
      }
      case 'flash':
      case 'smoke': {
        const fl = id === 'flash';
        Cy(fl ? M.flashCol : M.smokeCol, 0.026, 0.11, 0, 0, 0, 'y', 12);
        Cy(M.metal, 0.012, 0.025, 0, 0.066, 0, 'y');
        if (!fl) Cy(M.olive, 0.0265, 0.02, 0, 0.02, 0, 'y', 12);
        B(M.metal, 0.01, 0.06, 0.012, 0.014, 0.04, 0.012, 0, 0, -0.2);
        ud.rightHand.set(0, -0.03, 0.01); ud.leftHand = null; ud.nade = true;
        break;
      }
      case 'c4': {
        B(M.c4, 0.19, 0.05, 0.11, 0, 0, 0);
        for (const zz of [-0.035, 0, 0.035]) Cy(M.tan, 0.017, 0.2, 0, 0.035, zz, 'x', 8);
        B(M.poly, 0.075, 0.012, 0.055, 0.03, 0.058, 0);
        B(M.c4screen, 0.04, 0.004, 0.018, 0.03, 0.065, -0.012);
        const led = this._box(g, M.red, 0.01, 0.006, 0.01, -0.02, 0.065, 0.015);
        ud.led = led;
        ud.rightHand.set(0.06, -0.03, 0.04); ud.leftHand.set(-0.07, -0.03, 0.02); ud.c4 = true;
        break;
      }
    }
    return g;
  },

  /** 第三人称/掉落物：把模型合并成一个网格（单次绘制），并记录握点、枪托位置等持握信息 */
  buildMerged(id) {
    const key = 'm_' + id;
    if (this.cache[key]) return this.cache[key];
    const src = this.build(id);
    const ud = src.userData;
    const geo = mergeGroup(src);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    this.cache[key] = {
      geo, muzzle: ud.muzzle.clone(),
      rh: (ud.rightHand || new THREE.Vector3()).clone(), lh: ud.leftHand ? ud.leftHand.clone() : null,
      mag: ud.magRest ? ud.magRest.clone() : null,
      butt: bb.max.z, len: bb.max.z - bb.min.z,
    };
    return this.cache[key];
  },
  worldMat: null,
  /** 世界中的枪械网格：枪与刀按真实尺寸缩小（第一人称模型为视角放大过），手雷与 C4 保持原尺寸 */
  makeWorldMesh(id) {
    if (!this.worldMat) this.worldMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const m = this.buildMerged(id);
    const mesh = new THREE.Mesh(m.geo, this.worldMat);
    mesh.castShadow = true;
    const u = mesh.userData;
    u.muzzle = m.muzzle; u.rh = m.rh; u.lh = m.lh; u.mag = m.mag; u.butt = m.butt; u.len = m.len;
    if (WEAPONS[id]) mesh.scale.setScalar(typeof AV_GUN_SCALE !== 'undefined' ? AV_GUN_SCALE : 0.78);
    return mesh;
  },
};

// =====================================================================
//  第一人称视图模型
// =====================================================================
const ViewModel = {
  scene: null, camera: null,
  root: null,          // 跟随相机的根节点（位移/摇摆/后坐）
  models: {},          // 已构建的第一人称模型（含手臂）
  cur: null, curId: '',
  // 动画状态
  t: 0, kick: 0, kickRot: 0, swayX: 0, swayY: 0, bob: 0, land: 0, drawT: 1, drawDur: 1,
  reloadT: -1, reloadDur: 1, inspectT: -1, knifeT: -1, knifeHeavy: false, boltT: -1, boltDur: 1, throwT: -1, pinT: -1,
  flashT: 0,
  init(aspect) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.01, 10);
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x8a7458, 0.75);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 0.95);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.flashLight = new THREE.PointLight(0xffb45a, 0, 1.2, 2);
    this.scene.add(this.flashLight);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    const fm = new THREE.SpriteMaterial({ map: Tex.t.muzzle, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true });
    this.muzzleSprite = new THREE.Sprite(fm);
    this.muzzleSprite.visible = false;
    this.muzzleSprite.renderOrder = 10;
    this.root.add(this.muzzleSprite);
  },

  /** 第一人称手臂材质（按颜色缓存，带布料纹理） */
  armMats: {},
  armMat(hex) {
    if (this.armMats[hex]) return this.armMats[hex];
    if (!Avatar.mat) Avatar.initMats();
    return (this.armMats[hex] = new THREE.MeshPhongMaterial({ color: hex, map: Avatar.mat.map, shininess: 10, specular: 0x181818 }));
  },
  /**
   * 第一人称手臂：上臂 / 前臂 / 手三段，外观与自己的第三人称人物一致（袖子颜色、手套、露指手套、挽袖）。
   * 每帧用两段 IK 从屏幕外的肩部解算到枪上的握点，换弹等动作中手移动时手臂会跟着动
   */
  buildArms(holder, look, s) {
    const sleeve = this.armMat(look.top), glove = this.armMat(look.glove), skin = this.armMat(look.skin);
    const cuffM = this.armMat(avShade(look.top, 0.85));
    const upper = new THREE.Group(), fore = new THREE.Group(), hand = new THREE.Group();
    holder.add(upper, fore, hand);
    const add = (geo, mat, parent, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); parent.add(m); return m;
    };
    add(avCapsule(0.052, 0.06, 0.3, 12, 3), sleeve, upper, 0, -0.3, 0);
    if (look.rolled) {
      add(avCapsule(0.04, 0.047, 0.22, 12, 3), skin, fore, 0, -0.27, 0);
      add(new THREE.CylinderGeometry(0.058, 0.058, 0.06, 14), cuffM, fore, 0, -0.05, 0);
    } else {
      add(avCapsule(0.043, 0.052, 0.27, 12, 3), sleeve, fore, 0, -0.27, 0);
      add(new THREE.CylinderGeometry(0.049, 0.047, 0.04, 14), cuffM, fore, 0, -0.245, 0);
    }
    if (s < 0 && look.team === 'CT') add(new THREE.CylinderGeometry(0.046, 0.046, 0.022, 14), this.armMat(0x111111), fore, 0, -0.225, 0);   // 手表
    // 手（手腕为原点，手指沿 -Y，右手掌心朝 -X）
    add(avRoundBox(0.034, 0.088, 0.082, 0.014, true), glove, hand, -s * 0.004, -0.047, 0);
    add(avRoundBox(0.032, 0.056, 0.076, 0.014, true), look.fingerless ? skin : glove, hand, -s * 0.013, -0.108, 0.003, 0, 0, s * 0.3);
    const th = add(avCapsule(0.01, 0.0115, 0.045, 8, 2), glove, hand, -s * 0.014, -0.075, -0.041);
    th.rotation.set(0.35, 0, -s * 0.25);
    add(new THREE.CylinderGeometry(0.045, 0.044, 0.03, 14), glove, hand, 0, 0.005, 0);
    hand.scale.setScalar(1.15);      // 第一人称略放大手部，更显眼
    return { upper, fore, hand };
  },
  /** 取得（或构建）带手臂的第一人称模型 */
  get(id, team) {
    const P = typeof Game !== 'undefined' && Game.player;
    const look = avatarLook(team, P ? P.name : '');
    const key = id + look.key;
    if (this.models[key]) return this.models[key];
    const gun = GunModels.build(id);
    const holder = new THREE.Group();
    holder.add(gun);
    const ud = gun.userData;
    const hu = holder.userData;
    if (ud.rightHand) {
      hu.armR = this.buildArms(holder, look, 1);
      hu.shR = ud.rightHand.clone().add(new THREE.Vector3(0.14, -0.34, 0.36));
    }
    if (ud.leftHand) {
      hu.armL = this.buildArms(holder, look, -1);
      hu.shL = ud.leftHand.clone().add(ud.pistol ? new THREE.Vector3(-0.2, -0.3, 0.38) : new THREE.Vector3(-0.16, -0.36, 0.32));
    }
    // 各类武器的持握位置（相机空间）：偏右下，枪管指向准星附近
    const kind = WEAPONS[id] ? WEAPONS[id].kind : id;
    let sc = 0.85;
    if (kind === 'pistol') { holder.position.set(0.11, -0.13, -0.42); sc = 0.9; }
    else if (kind === 'knife') { holder.position.set(0.15, -0.16, -0.4); holder.userData.baseRX = 0.35; holder.userData.baseRY = 0.3; holder.userData.baseRZ = 0.2; }
    else if (ud.nade) holder.position.set(0.14, -0.18, -0.38);
    else if (id === 'c4') { holder.position.set(0.04, -0.2, -0.4); holder.userData.baseRX = 0.6; }
    else if (kind === 'sniper') holder.position.set(0.15, -0.215, -0.42);
    else holder.position.set(0.15, -0.205, -0.41);
    holder.scale.setScalar(sc);
    holder.rotation.y = 0.03;
    holder.userData.rest = holder.position.clone();
    holder.userData.gun = gun;
    holder.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
    this.models[key] = holder;
    return holder;
  },

  /** 切换武器：播放抽枪动画 */
  equip(id, team, drawTime) {
    if (this.cur) this.root.remove(this.cur);
    this.cur = this.get(id, team);
    this.curId = id;
    this.root.add(this.cur);
    this.drawT = 0; this.drawDur = Math.max(0.25, drawTime * 0.7);
    this.reloadT = -1; this.inspectT = -1; this.knifeT = -1; this.boltT = -1; this.throwT = -1; this.pinT = -1;
    const gud = this.cur.userData.gun.userData;
    if (gud.mag) { gud.mag.position.copy(gud.magRest); gud.mag.visible = true; }
    this.cur.visible = true;
  },
  hide() { if (this.cur) this.root.remove(this.cur); this.cur = null; this.curId = ''; },

  fire(kick) {
    this.kick = Math.min(this.kick + 0.02 * kick + 0.012, 0.09);
    this.kickRot = Math.min(this.kickRot + 0.03 * kick + 0.015, 0.2);
    if (this.cur && this.cur.userData.gun.userData.slide) this.slideT = 0.08;
    const ud = this.cur ? this.cur.userData.gun.userData : null;
    if (ud && !ud.knife && !ud.nade) {
      this.flashT = 0.045;
      this.muzzleSprite.material.rotation = Math.random() * TAU;
      const s = rand(0.16, 0.24);
      this.muzzleSprite.scale.set(s, s, 1);
      this.flashLight.intensity = 3;
    }
    this.inspectT = -1;
  },
  startReload(dur) { this.reloadT = 0; this.reloadDur = dur; this.inspectT = -1; this.lhGrab = 0; this.lhAway = 0; },
  /** 手臂 IK（持枪模型局部坐标）：肩在屏幕外，手在枪的握点 */
  updateArms(h, ud) {
    const hu = h.userData;
    if (this.reloadT < 0) { this.lhGrab = 0; this.lhAway = 0; }
    const solve = (arm, sh, grip, hq, pole) => {
      _vmW.set(0, 0.06, 0).applyQuaternion(hq).add(grip);
      avIK(sh, _vmW, 0.3, 0.27, pole, _vmMid, _vmEnd, _vmHinge, false);
      arm.upper.position.copy(sh); avLimbQuat(arm.upper.quaternion, sh, _vmMid, _vmHinge);
      arm.fore.position.copy(_vmMid); avLimbQuat(arm.fore.quaternion, _vmMid, _vmEnd, _vmHinge);
      arm.hand.position.copy(_vmEnd); arm.hand.quaternion.copy(hq);
    };
    if (hu.armR) {
      const hq = ud.c4 ? _vmQ.setFromEuler(_vmE.set(0, 0, 0.5)) : _vmQ.copy(AV_GRIP_R);
      solve(hu.armR, hu.shR, ud.rightHand, hq, _vmP.set(0.7, -1, 0.35));
    }
    if (hu.armL) {
      _vmL.copy(ud.leftHand);
      if (this.lhGrab > 0 && ud.mag) {
        _vmT.copy(ud.mag.position).add(_vmT2.set(0, -0.09, 0.01));
        _vmL.lerp(_vmT, this.lhGrab);
        _vmL.y -= this.lhAway * 0.35; _vmL.z += this.lhAway * 0.08;
      }
      const hq = ud.pistol ? _vmQ2.copy(AV_GRIP_R) : ud.c4 ? _vmQ2.setFromEuler(_vmE.set(0, 0, -0.5)) : _vmQ2.copy(AV_GRIP_L);
      solve(hu.armL, hu.shL, _vmL, hq, _vmP.set(-0.6, -1, 0.25));
    }
  },
  startBolt(dur) { this.boltT = 0; this.boltDur = dur; },
  knife(heavy) { this.knifeT = 0; this.knifeHeavy = heavy; },
  inspect() { if (this.reloadT < 0 && this.drawT >= 1) this.inspectT = 0; },
  pin() { this.pinT = 0; },
  throwAnim() { this.throwT = 0; },

  /**
   * 每帧更新。p：玩家（读取移动速度、是否着地、鼠标位移）
   */
  update(dt, p, cam) {
    if (!this.cur) return;
    this.t += dt;
    // 让第一人称光照方向与世界太阳方向一致
    _q1.copy(cam.quaternion).invert();
    this.sun.position.copy(SUN_DIR).applyQuaternion(_q1);
    this.sun.intensity = lerp(0.25, 1.0, p.sunlit);
    this.hemi.intensity = lerp(0.55, 0.8, p.sunlit);
    const h = this.cur;
    const rest = h.userData.rest;
    const gun = h.userData.gun, ud = gun.userData;
    // 移动摇晃
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const moveK = p.onGround ? clamp(speed / 6, 0, 1) : 0;
    this.bob += dt * (6 + speed * 1.2) * (moveK > 0.05 ? 1 : 0);
    const bx = Math.sin(this.bob) * 0.012 * moveK, by = -Math.abs(Math.cos(this.bob)) * 0.01 * moveK;
    // 鼠标甩动的惯性
    this.swayX = damp(this.swayX, clamp(-p.mouseDX * 0.0009, -0.05, 0.05), 10, dt);
    this.swayY = damp(this.swayY, clamp(p.mouseDY * 0.0009, -0.04, 0.04), 10, dt);
    this.land = damp(this.land, 0, 8, dt);
    this.kick = damp(this.kick, 0, 14, dt);
    this.kickRot = damp(this.kickRot, 0, 12, dt);
    let px = rest.x + bx + this.swayX * 0.5, py = rest.y + by - this.land - p.crouch * 0.012, pz = rest.z + this.kick;
    let rx = (h.userData.baseRX || 0) + this.kickRot + this.swayY, ry = 0.03 + (h.userData.baseRY || 0) + this.swayX, rz = (h.userData.baseRZ || 0) + this.swayX * 0.6;
    // 抽枪
    if (this.drawT < 1) {
      this.drawT = Math.min(1, this.drawT + dt / this.drawDur);
      const k = 1 - Math.pow(1 - this.drawT, 3);
      py -= (1 - k) * 0.22; rx -= (1 - k) * 0.9;
    }
    // 换弹：倾斜 → 卸弹匣 → 装弹匣 → 复位
    if (this.reloadT >= 0) {
      this.reloadT += dt / this.reloadDur;
      const t = this.reloadT;
      const tilt = smoothstep(0, 0.15, t) * (1 - smoothstep(0.82, 1, t));
      rz += tilt * 0.45; rx += tilt * 0.12; py -= tilt * 0.03;
      if (ud.mag) {
        const mag = ud.mag, mr = ud.magRest;
        let off = 0;
        if (t < 0.18) off = 0;
        else if (t < 0.32) off = smoothstep(0.18, 0.32, t);
        else if (t < 0.55) off = 1;
        else if (t < 0.72) off = 1 - smoothstep(0.55, 0.72, t);
        mag.position.set(mr.x, mr.y - off * 0.3, mr.z + off * 0.05);
        mag.visible = !(t > 0.33 && t < 0.54);
      }
      // 左手：握住弹匣一起拔出 → 离开画面取新弹匣 → 装上 → 回到护木
      this.lhGrab = smoothstep(0.1, 0.2, t) * (1 - smoothstep(0.74, 0.86, t));
      this.lhAway = smoothstep(0.34, 0.42, t) * (1 - smoothstep(0.46, 0.55, t));
      if (t > 0.86) { const k = Math.sin((t - 0.86) / 0.14 * Math.PI); rx -= k * 0.06; pz += k * 0.02; }
      if (t >= 1) this.reloadT = -1;
    }
    // 狙击枪拉栓
    if (this.boltT >= 0) {
      this.boltT += dt / this.boltDur;
      const k = Math.sin(clamp((this.boltT - 0.25) / 0.45, 0, 1) * Math.PI);
      rz -= k * 0.25; py -= k * 0.02; rx += k * 0.05;
      if (this.boltT >= 1) this.boltT = -1;
    }
    // 手枪套筒后坐
    if (ud.slide) {
      this.slideT = Math.max(0, (this.slideT || 0) - dt);
      ud.slide.position.z = this.slideT > 0 ? 0.025 * (this.slideT / 0.08) : 0;
    }
    // 匕首挥砍
    if (this.knifeT >= 0) {
      this.knifeT += dt / (this.knifeHeavy ? 0.6 : 0.35);
      const k = Math.sin(clamp(this.knifeT, 0, 1) * Math.PI);
      if (this.knifeHeavy) { pz -= k * 0.12; rx -= k * 0.4; }
      else { px -= k * 0.14; ry += k * 0.9; rz += k * 0.4; pz -= k * 0.05; }
      if (this.knifeT >= 1) this.knifeT = -1;
    }
    // 投掷物：拉环 & 投出
    if (this.pinT >= 0) { this.pinT += dt / 0.35; const k = Math.sin(clamp(this.pinT, 0, 1) * Math.PI); py += k * 0.03; rx += k * 0.2; if (this.pinT >= 1) this.pinT = -1; }
    if (p.nadeCharging) { py += 0.02; pz += 0.05; rx += 0.35; }
    if (this.throwT >= 0) {
      this.throwT += dt / 0.4;
      const k = clamp(this.throwT, 0, 1);
      pz -= Math.sin(k * Math.PI) * 0.25; py += Math.sin(k * Math.PI) * 0.05; rx -= Math.sin(k * Math.PI) * 0.6;
      h.visible = k < 0.45;
      if (this.throwT >= 1) { this.throwT = -1; h.visible = true; }
    }
    // 检视
    if (this.inspectT >= 0) {
      this.inspectT += dt / 2.6;
      const k = smoothstep(0, 0.2, this.inspectT) * (1 - smoothstep(0.8, 1, this.inspectT));
      ry += k * 0.9; rz += k * 0.35; px -= k * 0.06; py += k * 0.03;
      if (this.inspectT >= 1) this.inspectT = -1;
    }
    // C4 的 LED 闪烁
    if (ud.led) ud.led.visible = (this.t % 1) < 0.5;
    h.position.set(px, py, pz);
    h.rotation.set(rx, ry, rz);
    this.updateArms(h, ud);
    // 枪口火焰
    if (this.flashT > 0) {
      this.flashT -= dt;
      _v1.copy(ud.muzzle);
      gun.localToWorld(_v1);
      this.root.worldToLocal(_v1);
      this.muzzleSprite.position.copy(_v1);
      this.muzzleSprite.visible = true;
      this.flashLight.position.copy(_v1);
    } else this.muzzleSprite.visible = false;
    this.flashLight.intensity = damp(this.flashLight.intensity, 0, 30, dt);
  },
};
const SUN_DIR = new THREE.Vector3(0.42, 0.82, 0.38).normalize();
const _vmW = new THREE.Vector3(), _vmMid = new THREE.Vector3(), _vmEnd = new THREE.Vector3(), _vmHinge = new THREE.Vector3();
const _vmP = new THREE.Vector3(), _vmL = new THREE.Vector3(), _vmT = new THREE.Vector3(), _vmT2 = new THREE.Vector3();
const _vmQ = new THREE.Quaternion(), _vmQ2 = new THREE.Quaternion(), _vmE = new THREE.Euler();


// #####################################################################
// ## 模块文件：09_character.js
// #####################################################################
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


// #####################################################################
// ## 模块文件：11_grenades.js
// #####################################################################
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


// #####################################################################
// ## 模块文件：12_bomb.js
// #####################################################################
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


// #####################################################################
// ## 模块文件：13_bot.js
// #####################################################################
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


// #####################################################################
// ## 模块文件：14_economy.js
// #####################################################################
// =====================================================================
//  14 经济模块（参考 CS:GO 规则）
//  - 击杀奖励按武器（匕首 $1500 / 冲锋枪 $600 / 步枪·手枪 $300 / L-96 $100）
//  - 回合胜利 $3250（全灭/超时）或 $3500（爆炸/拆除）
//  - 连败补偿 $1400 → $3400；T 方输掉但下了包额外 +$800
//  - 超时输掉回合时存活的 T 没有收入
//  - Bot 按团队平均资金决定全买 / 强起 / 保存
// =====================================================================

// 购买菜单：5 列
const SHOP = [
  { name: '手枪', items: ['g18', 'p2k', 'd50'] },
  { name: '冲锋枪', items: ['v45'] },
  { name: '步枪', items: ['g35', 'k47', 'm4'] },
  { name: '狙击枪', items: ['s08', 'l96'] },
  { name: '装备', items: ['vest', 'vesthelm', 'kit', 'he', 'flash', 'smoke'] },
];
const EQUIP = {
  vest: { name: '防弹衣', price: 650, desc: '躯干伤害减免' },
  vesthelm: { name: '防弹衣 + 头盔', price: 1000, desc: '头盔可减免爆头伤害' },
  kit: { name: '拆弹器', price: 400, side: 'CT', desc: '拆弹时间减半' },
};

const Economy = {
  streak: { T: 0, CT: 0 },
  decision: { T: 'full', CT: 'full' },

  reset() { this.streak = { T: 0, CT: 0 }; },
  give(ch, amount) {
    if (!amount) return;
    const before = ch.money;
    ch.money = clamp(ch.money + amount, 0, CFG.ECON.MAX);
    if (ch.isPlayer && ch.money !== before) UI.moneyDelta(ch.money - before);
  },

  /** 物品信息：名称/价格/是否可买/原因 */
  info(ch, id) {
    const w = WEAPONS[id], n = NADES[id], e = EQUIP[id];
    const side = (w && w.side) || (e && e.side);
    const r = { id, name: w ? w.full || w.name : n ? n.name : e.name, price: w ? w.price : n ? n.price : e.price, desc: w ? w.desc : e ? e.desc : '', ok: true, owned: false, reason: '' };
    if (side && side !== ch.team) { r.ok = false; r.reason = side === 'CT' ? '仅限 CT' : '仅限 T'; r.hidden = true; }
    if (w) {
      const cur = ch.inv[w.slot];
      if (cur && cur.def.id === id) { r.owned = true; r.ok = false; r.reason = '已拥有'; }
    } else if (n) {
      if (ch.inv[id] >= n.max) { r.owned = true; r.ok = false; r.reason = '已达上限'; }
      else if (ch.nadeCount() >= 4) { r.ok = false; r.reason = '投掷物已满'; }
    } else if (id === 'vest') {
      if (ch.armor >= 100) { r.owned = true; r.ok = false; r.reason = '已拥有'; }
    } else if (id === 'vesthelm') {
      if (ch.armor >= 100 && ch.helmet) { r.owned = true; r.ok = false; r.reason = '已拥有'; }
      else if (ch.armor >= 100) { r.price = 350; r.desc = '只需补买头盔'; }
    } else if (id === 'kit') {
      if (ch.kit) { r.owned = true; r.ok = false; r.reason = '已拥有'; }
    }
    if (r.ok && ch.money < r.price) { r.ok = false; r.reason = '资金不足'; }
    return r;
  },

  canBuyNow(ch) {
    if (!ch.alive) return false;
    if (!Round.buyTimeLeft()) return false;
    const z = MAP.BUYZONE[ch.team];
    return MAP.inRect(ch.pos.x, ch.pos.z, z);
  },

  buy(ch, id) {
    const r = this.info(ch, id);
    // 联机：购买由服务器校验执行，结果通过背包同步回来
    if (NET.mode === 'client' && ch.isPlayer) { if (r.ok) NetClient.send({ t: 'buy', id }); return r; }
    if (!r.ok) return r;
    ch.money -= r.price;
    const w = WEAPONS[id];
    if (w) {
      const old = ch.inv[w.slot];
      if (old && old.def.price > 0 && ch.isHuman) {
        const it = Items.drop('weapon', old, ch.pos.x, ch.pos.y + 1, ch.pos.z, rand(-0.6, 0.6), rand(-0.6, 0.6));
        it.dropper = ch;
      }
      ch.inv[w.slot] = newWeapon(id);
      if (ch.isHuman || w.slot === 'primary' || !ch.inv.primary) { ch.slot = ''; ch.switchTo(w.slot); }
      ch.boughtSlot = w.slot;
    } else if (NADES[id]) {
      ch.inv[id]++;
    } else if (id === 'vest') {
      ch.armor = 100;
    } else if (id === 'vesthelm') {
      ch.armor = 100; ch.helmet = true;
    } else if (id === 'kit') {
      ch.kit = true;
    }
    return r;
  },

  // ---------------- 回合结算 ----------------
  roundEnd(winner, reason) {
    const E = CFG.ECON;
    const loser = winner === 'T' ? 'CT' : 'T';
    const winAmt = reason === 'bomb' ? E.WIN_BOMB : reason === 'defuse' ? E.WIN_DEFUSE : reason === 'time' ? E.WIN_TIME : E.WIN_ELIM;
    this.streak[winner] = 0;
    this.streak[loser] = Math.min(this.streak[loser] + 1, E.LOSS.length);
    const lossAmt = E.LOSS[this.streak[loser] - 1];
    const planted = Bomb.state === 'planted' || Bomb.state === 'exploded' || Bomb.state === 'defused';
    for (const ch of Combat.chars) {
      if (ch.team === winner) this.give(ch, winAmt);
      else {
        if (reason === 'time' && ch.team === 'T' && ch.alive) continue;   // 超时存活的 T 无收入
        this.give(ch, lossAmt + (ch.team === 'T' && planted ? E.PLANT_TEAM_BONUS : 0));
      }
    }
  },

  // ---------------- Bot 购买 ----------------
  decide(team, pistolRound) {
    const members = Combat.chars.filter(c => c.team === team);
    const avg = members.reduce((s, c) => s + c.money, 0) / Math.max(1, members.length);
    if (pistolRound) return 'pistol';
    if (avg >= 3700) return 'full';
    if (this.streak[team] >= 3 && avg >= 2300) return 'force';
    if (avg < 2500) return 'eco';
    return 'force';
  },
  botBuy(b, decision) {
    const B = (id) => this.buy(b, id).ok;
    const m = () => b.money;
    const T = b.team === 'T';
    if (decision === 'pistol') {
      if (!T && chance(0.35)) { B('vest'); if (m() >= 400) B('kit'); }
      else if (chance(0.5)) B('vest');
      else if (m() >= 700) B('d50');
      if (m() >= 200) B('flash');
      return;
    }
    if (b.inv.primary) {
      // 保留了武器：补护甲与道具
      if (m() >= 1000) B('vesthelm'); else if (m() >= 650) B('vest');
      this.botNades(b, 600);
      if (!T && m() >= 400) B('kit');
      return;
    }
    if (decision === 'eco') {
      if (m() >= 1200 && chance(0.35)) B('d50');
      if (m() >= 2000 && chance(0.5)) B('vest');
      return;
    }
    // 全买 / 强起
    const rifle = T ? 'k47' : 'm4';
    const rp = WEAPONS[rifle].price;
    if (m() >= 4750 + 1000 && chance(decision === 'full' ? 0.18 : 0.08)) B('l96');
    else if (m() >= rp + 650) B(rifle);
    else if (T && m() >= 1800 + 650) B('g35');
    else if (m() >= 1700 + 650 && chance(0.25)) B('s08');
    else if (m() >= 1200 + 650) B('v45');
    else if (m() >= 1200) B('v45');
    if (m() >= 1000) B('vesthelm'); else if (m() >= 650) B('vest');
    if (!T && m() >= 400 && chance(0.7)) B('kit');
    this.botNades(b, 0);
    if (!b.inv.primary && m() >= 700) B('d50');
  },
  botNades(b, keep) {
    const order = shuffle(['flash', 'he', 'smoke', 'flash']);
    for (const n of order) if (b.money - NADES[n].price >= keep && chance(0.7)) this.buy(b, n);
  },
};


// #####################################################################
// ## 模块文件：15_round.js
// #####################################################################
// =====================================================================
//  15 回合管理模块
//  流程：freeze（冻结，可购买）→ live（1:55，下包后改为炸弹倒计时）→ end（5 秒）→ 下一回合
//  胜负：一方全灭 / 炸弹爆炸 / 拆弹成功 / 超时（CT 胜）
//  比赛：先赢 SETTINGS.winRounds 回合的一方获胜
// =====================================================================

const Round = {
  state: 'menu',
  number: 0,
  timer: 0,
  liveStart: 0,
  score: { T: 0, CT: 0 },
  winner: null, reason: '',
  matchOver: false,
  history: [],

  beforeRound: null,     // 服务器用于在每回合开始前调整 Bot 数量
  netBuyLeft: 0,         // 联机客户端：服务器同步的剩余购买时间
  isFrozen() { return this.state === 'freeze'; },
  /** 获胜所需回合数（联机时以房间设置为准） */
  winTarget() { return NET.mode === 'client' ? NetClient.winRounds : SETTINGS.winRounds; },
  canPlant() { return this.state === 'live' && Bomb.state === 'carried'; },
  /** 剩余购买时间（秒），0 表示不能购买 */
  buyTimeLeft() {
    if (NET.mode === 'client') return Math.max(0, this.netBuyLeft);
    if (this.state === 'freeze') return CFG.ROUND.BUY_TIME + this.timer;
    if (this.state === 'live' && Bomb.state !== 'planted') return Math.max(0, CFG.ROUND.BUY_TIME - (Clock.time - this.liveStart));
    return 0;
  },
  /** HUD 显示的时间 */
  displayTime() {
    if (NET.mode === 'client') return this.timer;
    if (this.state === 'live' && Bomb.state === 'planted') return Bomb.timer;
    return this.timer;
  },

  startMatch() {
    this.score = { T: 0, CT: 0 };
    this.number = 0;
    this.matchOver = false;
    this.history = [];
    Economy.reset();
    for (const ch of Combat.chars) {
      ch.money = CFG.ECON.START;
      ch.stats = { k: 0, d: 0, a: 0, hs: 0, dmg: 0, mvp: 0, rk: 0, rdmg: 0 };
      ch.survived = false;
      ch.inv.primary = null;
    }
    this.startRound(true);
  },

  startRound(first = false) {
    if (this.beforeRound) this.beforeRound();
    this.number++;
    FX.clear(); Grenades.clear(); Items.clear(); Bomb.reset();
    const spawns = { T: shuffle(MAP.SPAWNS.T.slice()), CT: shuffle(MAP.SPAWNS.CT.slice()) };
    const idx = { T: 0, CT: 0 };
    for (const ch of Combat.chars) {
      const keep = !first && ch.survived;
      ch.resetForRound(keep);
      const sp = spawns[ch.team][idx[ch.team]++ % spawns[ch.team].length];
      const x = MAP.wx(sp[0]) + rand(-0.2, 0.2), z = MAP.wz(sp[1]) + rand(-0.2, 0.2);
      ch.pos.set(x, Nav.floorAt(x, z), z);
      ch.spottedAt = -99; ch.deathSeen = false;
      ch.yaw = ch.team === 'T' ? rand(-0.15, 0.15) : Math.PI + rand(-0.15, 0.15);
      ch.pitch = 0;
      ch.onGround = true;
    }
    // 炸弹交给玩家（玩家是 T）；否则交给随机一名 T
    const ts = Combat.chars.filter(c => c.team === 'T');
    const humansT = ts.filter(c => c.isHuman);
    const carrier = humansT.length ? pick(humansT) : pick(ts);
    if (carrier) carrier.inv.bomb = true;
    // Bot 购买
    const pistol = this.number === 1;
    for (const team of ['T', 'CT']) {
      Economy.decision[team] = Economy.decide(team, pistol);
      for (const b of Combat.chars) if (b.isBot && b.team === team) Economy.botBuy(b, Economy.decision[team]);
    }
    for (const b of Combat.chars) if (b.isBot) { b.slot = ''; b.switchTo(b.inv.primary ? 'primary' : 'secondary'); b.drawEnd = 0; }
    this.state = 'freeze';
    this.timer = CFG.ROUND.FREEZE_TIME;
    this.winner = null;
    TeamAI.newRound();
    Events.emit('roundStart', { number: this.number });
  },

  update(dt) {
    if (this.state === 'freeze') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.state = 'live';
        this.timer = CFG.ROUND.ROUND_TIME;
        this.liveStart = Clock.time;
        SFX.uiSound('roundStart');
        Events.emit('roundLive', {});
      }
    } else if (this.state === 'live') {
      if (Bomb.state !== 'planted') {
        this.timer -= dt;
        if (this.timer <= 0) { this.timer = 0; this.end('CT', 'time'); }
      }
    } else if (this.state === 'end') {
      this.timer -= dt;
      if (this.timer <= 0) {
        if (this.matchOver) { this.state = 'over'; Events.emit('matchOver', { winner: this.score.T > this.score.CT ? 'T' : 'CT' }); }
        else this.startRound();
      }
    }
  },

  alive(team) { let n = 0; for (const c of Combat.chars) if (c.team === team && c.alive) n++; return n; },

  checkWin() {
    if (this.state !== 'live') return;
    const t = this.alive('T'), ct = this.alive('CT');
    if (ct === 0) this.end('T', 'elim');
    else if (t === 0 && Bomb.state !== 'planted') this.end('CT', 'elim');
  },

  end(winner, reason) {
    if (this.state !== 'live') return;
    this.state = 'end';
    this.timer = CFG.ROUND.END_DELAY;
    this.winner = winner; this.reason = reason;
    this.score[winner]++;
    Economy.roundEnd(winner, reason);
    // MVP
    let mvp = null;
    if (reason === 'bomb') mvp = Bomb.planter;
    else if (reason === 'defuse') mvp = Bomb.defuser || [...Combat.chars].filter(c => c.team === 'CT').sort((a, b) => b.stats.rk - a.stats.rk)[0];
    if (!mvp) mvp = Combat.chars.filter(c => c.team === winner).sort((a, b) => (b.stats.rk - a.stats.rk) || (b.stats.rdmg - a.stats.rdmg))[0];
    if (mvp) mvp.stats.mvp++;
    for (const c of Combat.chars) c.survived = c.alive;
    this.history.push(winner);
    if (this.score[winner] >= SETTINGS.winRounds) this.matchOver = true;
    Bomb.cancelDefuse(Bomb.defuser);
    Events.emit('roundEnd', { winner, reason, mvp });
  },
};

// 联机客户端上的回合状态完全由服务器同步，不在本地判定
Events.on('kill', () => { if (NET.mode !== 'client') Round.checkWin(); });
Events.on('bombExploded', () => { if (NET.mode !== 'client' && Round.state === 'live') Round.end('T', 'bomb'); });
Events.on('bombDefused', () => { if (NET.mode !== 'client' && Round.state === 'live') Round.end('CT', 'defuse'); });
Events.on('bombPlanted', () => {
  // 下包时若 T 已全灭（极少见）仍需等待爆炸/拆除
  if (NET.mode !== 'client') Round.checkWin();
});


// #####################################################################
// ## 模块文件：server/src/srv_room.js
// #####################################################################
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
