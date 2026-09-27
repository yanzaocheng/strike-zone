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
