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
