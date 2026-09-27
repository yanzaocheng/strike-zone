// =====================================================================
//  20 人物模块（仅客户端，服务器不加载）
//  - avatarLook：外观方案（阵营 × 变体：服装配色、头部装备、背包、护具、肤色），按名字确定性挑选，
//    联机时每个客户端看到的同一个人外观一致
//  - AvatarGeo：程序化几何（圆角盒 / 锥形胶囊 / 椭球），按骨骼刚性蒙皮，
//    整个人合并成 1 个 SkinnedMesh（1 次绘制），相同外观的角色共享几何体
//  - Avatar：18 根骨骼 + 程序化动画
//      · 步态：双脚按相位抬起、落地（腿部两段 IK），前进 / 后退 / 横移 / 静步 / 蹲走，空中收腿，落地缓冲
//      · 上下半身分离：下半身朝移动方向，上半身扭向准星；原地转身超过一定角度才挪脚
//      · 持枪：步枪抵肩（侧身站姿）、手枪双手、刀、手雷、C4，双手用两段 IK 握在枪的握把 / 护木上
//      · 动作：开火后坐、换弹、切枪、投掷（蓄力 → 出手）、挥刀 / 刺击、跪地下包 / 拆包、受击抖动
//      · 装备外显：主武器背在背上、手枪插在腿部枪套、匕首挂在胸前、C4 背在背上
//  - Ragdoll：死亡布娃娃（Verlet 质点 + 距离 / 角度约束 + 与场景碰撞盒碰撞），按中弹方向与部位受力
// =====================================================================

// ---- 骨骼：名称、父骨骼、绑定姿势（直立、双臂下垂）下的模型空间位置（脚底为原点，-Z 朝前，+X 朝右） ----
const AV_BONES = [
  ['root', -1, 0, 0, 0],
  ['pelvis', 0, 0, 0.98, 0],
  ['spine', 1, 0, 1.12, 0],
  ['chest', 2, 0, 1.30, 0],
  ['neck', 3, 0, 1.52, 0],
  ['head', 4, 0, 1.60, 0],
  ['armL', 3, -0.19, 1.47, 0],
  ['foreL', 6, -0.19, 1.17, 0],
  ['handL', 7, -0.19, 0.90, 0],
  ['armR', 3, 0.19, 1.47, 0],
  ['foreR', 9, 0.19, 1.17, 0],
  ['handR', 10, 0.19, 0.90, 0],
  ['thighL', 1, -0.095, 0.93, 0],
  ['shinL', 12, -0.095, 0.50, 0],
  ['footL', 13, -0.095, 0.08, 0],
  ['thighR', 1, 0.095, 0.93, 0],
  ['shinR', 15, 0.095, 0.50, 0],
  ['footR', 16, 0.095, 0.08, 0],
];
const AB = {};
AV_BONES.forEach((b, i) => { AB[b[0]] = i; });
/** 各骨骼相对父骨骼的绑定偏移 */
const AV_OFF = AV_BONES.map(b => b[1] < 0 ? new THREE.Vector3(b[2], b[3], b[4])
  : new THREE.Vector3(b[2] - AV_BONES[b[1]][2], b[3] - AV_BONES[b[1]][3], b[4] - AV_BONES[b[1]][4]));
const AV_ARM1 = 0.30, AV_ARM2 = 0.27, AV_LEG1 = 0.43, AV_LEG2 = 0.42;   // 上臂 / 前臂 / 大腿 / 小腿
const AV_GUN_SCALE = 0.78;          // 第三人称与掉落物枪械的缩放（第一人称模型按视角放大过）

// =====================================================================
//  外观
// =====================================================================
const AV_SKIN = [0xdcb28e, 0xc6966f, 0xa9774f, 0x8b5c3b, 0x6b452d];
const AV_HAIR = [0x2a1f17, 0x3d2b1b, 0x161616, 0x5b4128];
const AVATAR_LOOKS = {
  T: [
    // 黑色头套 + 深色外套 + 橄榄色胸挂，左臂红色袖标
    { id: 'tA', top: 0x3b3a36, pants: 0x74654b, vest: 0x4b4a35, pouch: 0x3f3e2c, boots: 0x3a2b1d, glove: 0x2b2622, head: 'balaclava', mask: 0x1d1d1d, band: 0x8e2a22, fingerless: true },
    // 沙色头巾 + 护目镜 + 背包
    { id: 'tB', top: 0x5f553b, pants: 0x4b4637, vest: 0x6d5d40, pouch: 0x5b4d34, boots: 0x4a3622, glove: 0x3a2f24, head: 'shemagh', mask: 0xb5a17b, mask2: 0x8a3b30, pack: 0x5c5440, goggles: true, band: 0x8e2a22 },
    // 酒红色毛线帽 + 连帽衫 + 黑色胸挂 + 胡子
    { id: 'tC', top: 0x2f3542, pants: 0x5d5342, vest: 0x2c2c2c, pouch: 0x252525, boots: 0x2c241c, glove: 0x222222, head: 'beanie', hat: 0x6b2b23, beard: true, fingerless: true, band: 0x8e2a22 },
    // 棒球帽 + 红色面巾 + 挽起袖子
    { id: 'tD', top: 0x7a6547, pants: 0x3f3b34, vest: 0x4d4b39, pouch: 0x403f30, boots: 0x3b2d20, glove: 0x2e2822, head: 'cap', hat: 0x3e4b3b, mask: 0x8c3b2f, rolled: true },
  ],
  CT: [
    // 头盔 + 护目镜 + 面罩，海军蓝制服，护膝，左臂浅蓝臂章
    { id: 'cA', top: 0x2d3a50, pants: 0x283249, vest: 0x1f242c, pouch: 0x1a1e24, boots: 0x161616, glove: 0x1b1b1b, head: 'helmet', hat: 0x2f3641, goggles: true, mask: 0x1b1d20, kneepads: true, patch: 0x7b9cc4 },
    // 头盔 + 耳机 + 电台，灰蓝制服
    { id: 'cB', top: 0x4a576b, pants: 0x3a4456, vest: 0x2e3a4b, pouch: 0x273241, boots: 0x1b1b1b, glove: 0x202020, head: 'helmet', hat: 0x3d4653, headset: true, kneepads: true, patch: 0x7b9cc4, radio: true },
    // 战术帽 + 耳机 + 胡子
    { id: 'cC', top: 0x3a4a5f, pants: 0x2c3444, vest: 0x262b33, pouch: 0x1f2329, boots: 0x181818, glove: 0x1c1c1c, head: 'cap', hat: 0x1e2531, headset: true, patch: 0x7b9cc4, radio: true, beard: true },
    // 头盔 + 黑色面罩 + 护目镜
    { id: 'cD', top: 0x2a3140, pants: 0x232a38, vest: 0x303741, pouch: 0x262c35, boots: 0x141414, glove: 0x181818, head: 'helmet', hat: 0x272d36, mask: 0x151515, goggles: true, kneepads: true, patch: 0x7b9cc4 },
  ],
};
/** 按名字确定性地挑选外观（同一个名字在所有客户端上外观一致） */
function avatarLook(team, name) {
  let h = 2166136261;
  const s = String(name || '?');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  const r = new RNG(h >>> 0);
  const vs = AVATAR_LOOKS[team] || AVATAR_LOOKS.T;
  const v = vs[Math.floor(r.next() * vs.length)];
  const skin = AV_SKIN[Math.floor(r.next() * AV_SKIN.length)];
  const hair = AV_HAIR[Math.floor(r.next() * AV_HAIR.length)];
  return Object.assign({}, v, { team, skin, hair, key: `${team}_${v.id}_${skin}_${hair}` });
}

// =====================================================================
//  程序化几何
// =====================================================================
const _avV = new THREE.Vector3(), _avV2 = new THREE.Vector3(), _avNM = new THREE.Matrix3(), _avC = new THREE.Color();
const _avQ = new THREE.Quaternion(), _avE = new THREE.Euler(), _avS = new THREE.Vector3();

/** 圆角盒（r=0 时为普通盒）。smooth=true 圆角更平滑（用于大块、显眼的部位） */
function avRoundBox(w, h, d, r, smooth) {
  if (!(r > 0)) return new THREE.BoxGeometry(w, h, d);
  const H = [w / 2, h / 2, d / 2];
  r = Math.min(r, H[0] * 0.96, H[1] * 0.96, H[2] * 0.96);
  const I = [H[0] - r, H[1] - r, H[2] - r];
  const ticks = (a) => { const s = H[a]; return smooth ? [-s, -s + r * 0.3, -s + r, s - r, s - r * 0.3, s] : [-s, -s + r, s - r, s]; };
  // 某个方向上圆角占满时中间两个刻度重合：去掉重复刻度，避免退化三角形
  const uniq = (a) => a.filter((v, i) => i === 0 || v - a[i - 1] > 1e-5);
  const pos = [], nor = [], uv = [], idx = [];
  for (const [a, s] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
    const ua = (a + 1) % 3, va = (a + 2) % 3;
    const tu = uniq(ticks(ua)), tv = uniq(ticks(va));
    const base = pos.length / 3, nu = tu.length;
    for (let j = 0; j < tv.length; j++) for (let i = 0; i < nu; i++) {
      const p = [0, 0, 0];
      p[a] = s * H[a]; p[ua] = tu[i]; p[va] = tv[j];
      const qx = clamp(p[0], -I[0], I[0]), qy = clamp(p[1], -I[1], I[1]), qz = clamp(p[2], -I[2], I[2]);
      let nx = p[0] - qx, ny = p[1] - qy, nz = p[2] - qz;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l; ny /= l; nz /= l;
      pos.push(qx + nx * r, qy + ny * r, qz + nz * r);
      nor.push(nx, ny, nz);
      uv.push(tu[i] / (2 * H[ua]) + 0.5, tv[j] / (2 * H[va]) + 0.5);
    }
    for (let j = 0; j < tv.length - 1; j++) for (let i = 0; i < nu - 1; i++) {
      const p0 = base + j * nu + i, p1 = p0 + 1, p2 = p0 + nu, p3 = p2 + 1;
      if (s > 0) idx.push(p0, p1, p2, p1, p3, p2);
      else idx.push(p0, p2, p1, p1, p2, p3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
/** 锥形胶囊：沿 +Y，从 y=0（半径 r0）到 y=len（半径 r1），两端为半球 */
function avCapsule(r0, r1, len, radial = 8, capSeg = 3) {
  const pts = [];
  for (let i = 0; i <= capSeg; i++) { const a = -Math.PI / 2 + i / capSeg * Math.PI / 2; pts.push(new THREE.Vector2(Math.max(0, Math.cos(a) * r0), Math.sin(a) * r0)); }
  for (let i = 0; i <= capSeg; i++) { const a = i / capSeg * Math.PI / 2; pts.push(new THREE.Vector2(Math.max(0, Math.cos(a) * r1), len + Math.sin(a) * r1)); }
  pts[0].x = 0; pts[pts.length - 1].x = 0;
  return new THREE.LatheGeometry(pts, radial);
}
/** 位置 + 旋转（YXZ 欧拉角）+ 缩放 → 矩阵 */
function avMat(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _avQ.setFromEuler(_avE.set(rx, ry, rz, 'YXZ'));
  return new THREE.Matrix4().compose(_avV.set(x, y, z), _avQ, _avS.set(sx, sy, sz));
}
/** 颜色明暗 */
function avShade(hex, k) {
  const c = _avC.setHex(hex);
  return (clamp(c.r * k, 0, 1) * 255 << 16) | (clamp(c.g * k, 0, 1) * 255 << 8) | (clamp(c.b * k, 0, 1) * 255);
}

/** 顶点累加器：把各部件变换到模型空间，写入颜色（含假环境光遮蔽）与蒙皮骨骼 */
class AvAcc {
  constructor() { this.P = []; this.N = []; this.U = []; this.C = []; this.S = []; this.I = []; this.n = 0; }
  add(geo, m, bone, color, grad = 0.14) {
    const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
    _avNM.getNormalMatrix(m);
    const c = _avC.setHex(color);
    const cr = c.r * 1.08, cg = c.g * 1.08, cb = c.b * 1.08;   // 布料纹理平均亮度约 0.92，这里补偿
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const base = this.n;
    for (let i = 0; i < pos.count; i++) {
      _avV.fromBufferAttribute(pos, i);
      const g = y1 > y0 ? (_avV.y - y0) / (y1 - y0) : 1;
      _avV.applyMatrix4(m);
      this.P.push(_avV.x, _avV.y, _avV.z);
      // 假 AO：部件自上而下变暗；越靠近地面越暗
      const k = (1 - grad * (1 - g)) * lerp(0.78, 1, smoothstep(0.02, 0.5, _avV.y));
      this.C.push(cr * k, cg * k, cb * k);
      _avV2.fromBufferAttribute(nor, i).applyMatrix3(_avNM).normalize();
      this.N.push(_avV2.x, _avV2.y, _avV2.z);
      if (uv) this.U.push(uv.getX(i), uv.getY(i)); else this.U.push(0, 0);
      this.S.push(bone);
    }
    const idx = geo.index, flip = m.determinant() < 0;
    const cnt = idx ? idx.count : pos.count;
    for (let i = 0; i < cnt; i += 3) {
      const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, d = idx ? idx.getX(i + 2) : i + 2;
      if (flip) this.I.push(base + a, base + d, base + b); else this.I.push(base + a, base + b, base + d);
    }
    this.n += pos.count;
    geo.dispose();
  }
  finish() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    const si = new Uint16Array(this.n * 4), sw = new Float32Array(this.n * 4);
    for (let i = 0; i < this.n; i++) { si[i * 4] = this.S[i]; sw[i * 4] = 1; }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    g.setIndex(this.I);
    // 包围球放大：覆盖持枪、倒地等所有姿势，避免被视锥错误剔除
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 2.0);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-2, -1.2, -2), new THREE.Vector3(2, 2.8, 2));
    return g;
  }
}

const AvatarGeo = {
  cache: {},
  /** lo=true：远处使用的低模（约 1/3 面数，省略五官、小挂件等细节；同时用于投射阴影） */
  get(look, lo = false) {
    const k = look.key + (lo ? '_lo' : '');
    return this.cache[k] || (this.cache[k] = this.build(look, lo));
  },

  build(L, lo) {
    const A = new AvAcc();
    const B = AB;
    // ---- 部件工具（低模时降低细分，小部件直接省略） ----
    const box = (bone, col, w, h, d, r, x, y, z, rx = 0, ry = 0, rz = 0, smooth = false, grad) => {
      if (lo && Math.max(w, h, d) < 0.06) return;
      const rr = lo && Math.min(w, h, d) < 0.07 ? 0 : r;
      A.add(avRoundBox(w, h, d, rr, smooth && !lo), avMat(x, y, z, rx, ry, rz), bone, col, grad);
    };
    const ell = (bone, col, sx, sy, sz, x, y, z, seg = 10, grad = 0.1) => {
      if (lo && Math.max(sx, sy, sz) < 0.035) return;
      const sg = lo ? Math.max(5, Math.round(seg * 0.5)) : seg;
      A.add(new THREE.SphereGeometry(1, sg, Math.max(4, sg - 2)), avMat(x, y, z, 0, 0, 0, sx, sy, sz), bone, col, grad);
    };
    const dome = (bone, col, sx, sy, sz, x, y, z, seg = 14, rx = 0) => A.add(new THREE.SphereGeometry(1, lo ? 8 : seg, lo ? 3 : 6, 0, TAU, 0, Math.PI / 2), avMat(x, y, z, rx, 0, 0, sx, sy, sz), bone, col, 0.08);
    const cyl = (bone, col, rt, rb, h, x, y, z, rx = 0, ry = 0, rz = 0, seg = 10) => {
      if (lo && Math.max(rt, rb) < 0.02) return;
      A.add(new THREE.CylinderGeometry(rt, rb, h, lo ? Math.max(5, seg >> 1) : seg, 1, false), avMat(x, y, z, rx, ry, rz), bone, col, 0.06);
    };
    const cap = (bone, col, ax, ay, az, bx, by, bz, ra, rb, radial = 8) => {
      // 胶囊从 b（半径 rb）指向 a（半径 ra）
      if (lo && Math.max(ra, rb) < 0.02) return;
      const dx = ax - bx, dy = ay - by, dz = az - bz, len = Math.hypot(dx, dy, dz);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
      A.add(avCapsule(rb, ra, len, lo ? 6 : radial, lo ? 2 : 3), new THREE.Matrix4().compose(new THREE.Vector3(bx, by, bz), q, new THREE.Vector3(1, 1, 1)), bone, col, 0.1);
    };
    const skin = L.skin, top = L.top, pants = L.pants, vest = L.vest, pouch = L.pouch;
    const faceCovered = L.head === 'balaclava' || L.head === 'shemagh';
    const lowerFace = !!L.mask && !faceCovered;   // 面巾 / 面罩只遮下半脸

    // ---------------- 骨盆 ----------------
    box(B.pelvis, pants, 0.33, 0.19, 0.215, 0.07, 0, 0.985, 0.005, 0, 0, 0, true);
    box(B.pelvis, pants, 0.15, 0.1, 0.17, 0.045, 0, 0.9, 0.0);
    box(B.pelvis, 0x2a2420, 0.345, 0.05, 0.228, 0.02, 0, 1.075, 0.005);
    box(B.pelvis, 0x8c8a80, 0.05, 0.034, 0.012, 0, 0, 1.075, -0.118);
    box(B.pelvis, pouch, 0.1, 0.1, 0.065, 0.03, -0.12, 0.99, 0.13);        // 后腰杂物袋
    box(B.pelvis, pouch, 0.07, 0.09, 0.05, 0.02, 0.15, 1.02, -0.09);       // 右前腰弹匣包

    // ---------------- 腹部 / 胸部 ----------------
    box(B.spine, top, 0.31, 0.2, 0.2, 0.075, 0, 1.18, 0.005, 0, 0, 0, true);
    box(B.chest, top, 0.37, 0.27, 0.225, 0.085, 0, 1.36, 0.0, 0, 0, 0, true);
    box(B.chest, top, 0.42, 0.1, 0.19, 0.05, 0, 1.455, 0.01, 0, 0, 0, true);
    box(B.chest, top, 0.2, 0.06, 0.13, 0.03, 0, 1.505, 0.02);
    cyl(B.chest, avShade(top, 0.92), 0.078, 0.088, 0.05, 0, 1.52, 0.006);
    // 防弹背心 / 胸挂：前后插板、侧面腰封、肩带、弹匣包
    box(B.chest, vest, 0.31, 0.3, 0.05, 0.02, 0, 1.33, -0.118);
    box(B.chest, vest, 0.31, 0.32, 0.05, 0.02, 0, 1.345, 0.118);
    box(B.spine, vest, 0.335, 0.12, 0.25, 0.045, 0, 1.2, 0.0);
    for (const s of [-1, 1]) box(B.chest, vest, 0.065, 0.03, 0.25, 0.012, s * 0.105, 1.492, 0.0);
    for (const x of [-0.085, 0, 0.085]) {
      box(B.chest, pouch, 0.075, 0.11, 0.05, 0.012, x, 1.255, -0.157);
      box(B.chest, avShade(vest, 1.12), 0.078, 0.028, 0.056, 0.008, x, 1.307, -0.158);
    }
    box(B.chest, pouch, 0.1, 0.07, 0.04, 0.012, 0.075, 1.4, -0.148);      // 右胸杂物袋
    if (L.radio) {
      box(B.chest, 0x202326, 0.06, 0.12, 0.045, 0.01, -0.125, 1.41, 0.165);
      cyl(B.chest, 0x151515, 0.004, 0.007, 0.3, -0.14, 1.6, 0.17, 0, 0, 0, 5);
    }
    if (L.pack) {
      box(B.chest, L.pack, 0.3, 0.34, 0.13, 0.05, 0, 1.3, 0.205, 0, 0, 0, true);
      box(B.chest, avShade(L.pack, 0.88), 0.3, 0.07, 0.14, 0.03, 0, 1.47, 0.205);
      for (const s of [-1, 1]) box(B.chest, avShade(L.pack, 0.92), 0.05, 0.16, 0.1, 0.02, s * 0.17, 1.27, 0.2);
    }

    // ---------------- 颈 / 头 ----------------
    cyl(B.neck, faceCovered ? L.mask : skin, 0.052, 0.058, 0.12, 0, 1.575, 0.005);
    if (L.head === 'shemagh' || L.head === 'cap' && L.mask) box(B.neck, L.mask, 0.19, 0.08, 0.18, 0.04, 0, 1.55, -0.005, 0, 0, 0, true);
    const headCol = faceCovered ? L.mask : skin;
    ell(B.head, headCol, 0.098, 0.117, 0.108, 0, 1.70, 0.008, 12);
    box(B.head, headCol, 0.148, 0.078, 0.135, 0.046, 0, 1.626, -0.03, 0, 0, 0, true);
    box(B.head, headCol, 0.026, 0.04, 0.03, 0.011, 0, 1.674, -0.11, -0.15);
    for (const s of [-1, 1]) ell(B.head, headCol, 0.016, 0.03, 0.022, s * 0.098, 1.69, 0.008, 6);
    if (L.head === 'balaclava') box(B.head, skin, 0.134, 0.036, 0.03, 0.012, 0, 1.705, -0.092);
    for (const s of [-1, 1]) {
      box(B.head, 0x191411, 0.026, 0.012, 0.01, 0, s * 0.036, 1.705, -0.105);
      if (!faceCovered) box(B.head, L.hair, 0.034, 0.01, 0.012, 0, s * 0.036, 1.724, -0.104);
    }
    if (L.beard && !lowerFace) box(B.head, L.hair, 0.146, 0.056, 0.104, 0.035, 0, 1.613, -0.055, 0, 0, 0, true);
    if (lowerFace) box(B.head, L.mask, 0.16, 0.088, 0.125, 0.04, 0, 1.63, -0.043, 0, 0, 0, true);
    // 头部装备
    if (L.head === 'helmet') {
      dome(B.head, L.hat, 0.124, 0.112, 0.134, 0, 1.712, 0.006, 16);
      cyl(B.head, avShade(L.hat, 0.85), 0.126, 0.128, 0.022, 0, 1.712, 0.006, 0, 0, 0, 16);
      box(B.head, 0x1a1a1a, 0.04, 0.032, 0.022, 0.006, 0, 1.795, -0.122);
      for (const s of [-1, 1]) box(B.head, 0x1c1c1c, 0.014, 0.022, 0.11, 0.004, s * 0.124, 1.735, 0.0);
    } else if (L.head === 'beanie') {
      dome(B.head, L.hat, 0.105, 0.095, 0.115, 0, 1.715, 0.008, 14);
      cyl(B.head, avShade(L.hat, 0.86), 0.107, 0.109, 0.035, 0, 1.722, 0.008, 0, 0, 0, 14);
    } else if (L.head === 'cap') {
      dome(B.head, L.hat, 0.104, 0.08, 0.113, 0, 1.732, 0.008, 14);
      box(B.head, L.hat, 0.155, 0.012, 0.095, 0.004, 0, 1.742, -0.124, 0.12);
      if (!L.headset) for (const s of [-1, 1]) box(B.head, L.hair, 0.012, 0.03, 0.05, 0.004, s * 0.099, 1.705, 0.03);
    } else if (L.head === 'shemagh') {
      ell(B.head, L.mask, 0.109, 0.125, 0.117, 0, 1.706, 0.012, 12);
      box(B.head, L.mask, 0.164, 0.092, 0.13, 0.04, 0, 1.63, -0.041, 0, 0, 0, true);
      box(B.head, L.mask2 || L.mask, 0.166, 0.022, 0.135, 0.008, 0, 1.66, -0.041);
      box(B.head, L.mask, 0.1, 0.12, 0.04, 0.02, 0, 1.6, 0.105, 0.25);
      box(B.head, skin, 0.136, 0.034, 0.03, 0.012, 0, 1.705, -0.095);
    }
    if (L.goggles) {
      const gy = L.head === 'helmet' ? 1.775 : 1.748;
      box(B.head, 0x1a1a1a, 0.136, 0.042, 0.026, 0.012, 0, gy, -0.112);
      for (const s of [-1, 1]) box(B.head, 0x27384a, 0.05, 0.03, 0.012, 0.008, s * 0.032, gy, -0.127);
      cyl(B.head, 0x1a1a1a, 0.12, 0.12, 0.018, 0, gy, 0.006, 0, 0, 0, 14);
    }
    if (L.headset) {
      for (const s of [-1, 1]) cyl(B.head, 0x1a1a1a, 0.036, 0.036, 0.034, s * 0.111, 1.69, 0.008, 0, 0, Math.PI / 2, 10);
      box(B.head, 0x1a1a1a, 0.01, 0.01, 0.07, 0.003, 0.1, 1.64, -0.06, 0, -0.5);   // 麦克风
    }

    // ---------------- 手臂 ----------------
    for (const s of [-1, 1]) {
      const x = 0.19 * s, arm = s < 0 ? B.armL : B.armR, fore = s < 0 ? B.foreL : B.foreR, hand = s < 0 ? B.handL : B.handR;
      ell(arm, top, 0.071, 0.068, 0.077, x, 1.455, 0.0, 10);
      cap(arm, top, x, 1.47, 0, x, 1.175, 0.0, 0.061, 0.053);
      if (s < 0 && L.patch) box(arm, L.patch, 0.012, 0.055, 0.075, 0.004, x - 0.061, 1.37, 0.0);
      if (s < 0 && L.band) cyl(arm, L.band, 0.064, 0.063, 0.05, x, 1.3, 0.0);
      ell(fore, top, 0.053, 0.055, 0.055, x, 1.17, 0.005, 8);
      if (L.kneepads) box(fore, 0x1d1f22, 0.07, 0.075, 0.045, 0.02, x, 1.17, 0.04);
      if (L.rolled) {
        cyl(fore, avShade(top, 0.95), 0.059, 0.059, 0.055, x, 1.125, 0.0);
        cap(fore, skin, x, 1.1, 0, x, 0.925, 0.0, 0.047, 0.038);
      } else {
        cap(fore, top, x, 1.17, 0, x, 0.935, 0.0, 0.052, 0.043);
        cyl(fore, avShade(top, 0.88), 0.047, 0.047, 0.035, x, 0.955, 0.0);
      }
      if (s < 0 && !L.rolled && L.team === 'CT') box(fore, 0x111111, 0.075, 0.02, 0.075, 0.02, x, 0.95, 0.0);   // 手表
      // 手：手掌 + 四指（略向掌心弯曲）+ 拇指
      box(hand, L.glove, 0.036, 0.085, 0.082, 0.015, x - s * 0.004, 0.855, 0.0);
      box(hand, L.fingerless ? skin : L.glove, 0.034, 0.055, 0.076, 0.015, x - s * 0.012, 0.792, 0.003, 0, 0, s * 0.25);
      cap(hand, L.glove, x - s * 0.01, 0.872, -0.036, x - s * 0.022, 0.822, -0.052, 0.013, 0.012, 6);
    }

    // ---------------- 腿 ----------------
    for (const s of [-1, 1]) {
      const x = 0.095 * s, thigh = s < 0 ? B.thighL : B.thighR, shin = s < 0 ? B.shinL : B.shinR, foot = s < 0 ? B.footL : B.footR;
      cap(thigh, pants, x, 0.955, 0.0, x, 0.52, -0.004, 0.091, 0.066, 10);
      box(thigh, avShade(pants, 0.86), 0.035, 0.13, 0.11, 0.015, x + s * 0.074, 0.7, 0.0);   // 侧口袋
      if (s > 0) {   // 右腿枪套
        box(thigh, 0x1c1c1c, 0.045, 0.16, 0.085, 0.015, x + s * 0.082, 0.76, 0.012);
        cyl(thigh, 0x1c1c1c, 0.075, 0.075, 0.025, x, 0.66, 0.0, 0, 0, 0, 10);
      }
      ell(shin, pants, 0.061, 0.063, 0.063, x, 0.5, -0.006, 8);
      if (L.kneepads) box(shin, 0x1d1f22, 0.1, 0.11, 0.05, 0.022, x, 0.5, -0.062);
      cap(shin, pants, x, 0.5, 0.0, x, 0.14, 0.005, 0.06, 0.047);
      cyl(shin, L.boots, 0.058, 0.055, 0.1, x, 0.15, 0.005);
      box(foot, L.boots, 0.105, 0.105, 0.25, 0.035, x, 0.058, -0.045, 0, 0, 0, true, 0.05);
      box(foot, avShade(L.boots, 0.88), 0.1, 0.065, 0.075, 0.03, x, 0.04, -0.14, 0, 0, 0, false, 0.02);
      box(foot, 0x1b1712, 0.11, 0.025, 0.265, 0.008, x, 0.0125, -0.045, 0, 0, 0, false, 0);
    }
    return A.finish();
  },
};

// =====================================================================
//  IK 与骨骼旋转工具
// =====================================================================
const _ikU = new THREE.Vector3();
/**
 * 两段 IK：根关节 A → 目标 T，段长 l1/l2，pole 为中间关节（肘/膝）的朝向。
 * 输出中间关节位置 mid、末端实际位置 end（够不到时停在最远处）、铰链轴 hinge
 */
function avIK(A, T, l1, l2, pole, mid, end, hinge, isLeg) {
  let dx = T.x - A.x, dy = T.y - A.y, dz = T.z - A.z;
  let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d < 1e-5) { dx = 0; dy = -1; dz = 0; d = 1; }
  const ux = dx / d, uy = dy / d, uz = dz / d;
  const dc = clamp(d, Math.abs(l1 - l2) + 0.02, (l1 + l2) * 0.9995);
  end.set(A.x + ux * dc, A.y + uy * dc, A.z + uz * dc);
  const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let px = pole.x, py = pole.y, pz = pole.z;
  const pd = px * ux + py * uy + pz * uz;
  px -= ux * pd; py -= uy * pd; pz -= uz * pd;
  let pl = Math.sqrt(px * px + py * py + pz * pz);
  if (pl < 1e-5) { px = uz; py = 0; pz = -ux; pl = Math.hypot(px, pz) || 1; if (pl < 1e-5) { px = 1; pl = 1; } }
  px /= pl; py /= pl; pz /= pl;
  mid.set(A.x + ux * a + px * h, A.y + uy * a + py * h, A.z + uz * a + pz * h);
  if (isLeg) hinge.set(uy * pz - uz * py, uz * px - ux * pz, ux * py - uy * px);
  else hinge.set(py * uz - pz * uy, pz * ux - px * uz, px * uy - py * ux);
}
const _lbX = new THREE.Vector3(), _lbY = new THREE.Vector3(), _lbZ = new THREE.Vector3(), _lbM = new THREE.Matrix4();
/** 肢体骨骼的朝向：+Y 从下一关节指回本关节，+X 为铰链轴 */
function avLimbQuat(out, top, bottom, hinge) {
  _lbY.subVectors(top, bottom).normalize();
  _lbX.copy(hinge).addScaledVector(_lbY, -hinge.dot(_lbY));
  if (_lbX.lengthSq() < 1e-8) _lbX.set(1, 0, 0).addScaledVector(_lbY, -_lbY.x);
  _lbX.normalize();
  _lbZ.crossVectors(_lbX, _lbY);
  _lbM.makeBasis(_lbX, _lbY, _lbZ);
  return out.setFromRotationMatrix(_lbM);
}
const _aeu = new THREE.Euler();
function avQuat(out, pitch, yaw, roll = 0) { return out.setFromEuler(_aeu.set(pitch, yaw, roll, 'YXZ')); }

// 握持方向：右手握枪（手指沿枪管向前）、左手托护木（掌心朝上）
const AV_GRIP_R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const AV_GRIP_L = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)));
// 背在背上的主武器、腿部枪套里的手枪、胸前的匕首、背上的 C4（骨骼局部坐标下的姿态）
// 主武器：枪口朝左上（枪的 -Z 轴），枪身侧面贴背（枪的 +Y 轴朝后）
const AV_BACK_Q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0.85, 0.5, 0).normalize(), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0.5, -0.85, 0).normalize()));
const AV_HOLSTER_Q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0)));
// 匕首：刀尖朝下挂在胸前，刀面朝前
const AV_SHEATH_Q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)));
const AV_C4BACK_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));

/** 手持物的持握类型 */
function avHoldType(id) {
  if (id === 'c4') return 'c4';
  if (NADES[id]) return 'nade';
  const w = WEAPONS[id];
  if (!w) return 'none';
  if (w.kind === 'knife') return 'knife';
  if (w.kind === 'pistol') return 'pistol';
  return 'rifle';
}
/** 简单阻尼弹簧：x'' = -k·x - c·x' */
function avSpring(s, dt, k, c) {
  s.v += (-k * s.x - c * s.v) * dt;
  s.x += s.v * dt;
}

// 临时变量
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _t3 = new THREE.Vector3(), _t4 = new THREE.Vector3(), _t5 = new THREE.Vector3();
const _tq1 = new THREE.Quaternion(), _tq2 = new THREE.Quaternion(), _tq3 = new THREE.Quaternion();
const _gunP = new THREE.Vector3(), _gunQ = new THREE.Quaternion(), _aimQ = new THREE.Quaternion();
const _handR = new THREE.Vector3(), _handL = new THREE.Vector3(), _hqR = new THREE.Quaternion(), _hqL = new THREE.Quaternion();
const _mid = new THREE.Vector3(), _end = new THREE.Vector3(), _hinge = new THREE.Vector3(), _pole = new THREE.Vector3();
const _footT = [new THREE.Vector3(), new THREE.Vector3()];

// =====================================================================
//  Avatar：一个角色的模型实例
// =====================================================================
class Avatar {
  static initMats() {
    const S = 128, c = Tex._canvas(S), ctx = c.getContext('2d');
    Tex._pixels(ctx, S, S, (u, v, x, y, o) => {
      const n = tileFbm(u, v, 8, 3, 77);
      const weave = ((x + y) % 4 < 2 ? 0.025 : -0.025) + (x % 2 ? 0.012 : -0.012);
      const g = clamp((0.92 + (n - 0.5) * 0.16 + weave) * 255, 0, 255);
      o[0] = o[1] = o[2] = g;
    });
    const tex = Tex._finish(c, true);
    tex.repeat.set(2, 2);
    Avatar.mat = new THREE.MeshPhongMaterial({ vertexColors: true, skinning: true, map: tex, shininess: 12, specular: 0x1c1c1c });
    // 轮廓光：掠射角处略微提亮，让人物在阴影里、复杂背景前也容易辨认
    Avatar.mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        { float rimK = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          reflectedLight.indirectDiffuse += diffuseColor.rgb * pow(rimK, 3.0) * 0.22; }`);
    };
  }

  constructor(team, name, friendly) {
    if (!Avatar.mat) Avatar.initMats();
    this.look = avatarLook(team, name);
    this.team = team;
    this.root = new THREE.Group();
    this.bones = AV_BONES.map(() => new THREE.Bone());
    AV_BONES.forEach((b, i) => {
      const bone = this.bones[i];
      bone.name = b[0];
      bone.position.copy(AV_OFF[i]);
      if (b[1] >= 0) this.bones[b[1]].add(bone);
    });
    this.root.add(this.bones[0]);
    this.root.updateMatrixWorld(true);
    const skel = new THREE.Skeleton(this.bones);
    this.mesh = new THREE.SkinnedMesh(AvatarGeo.get(this.look), Avatar.mat);
    this.mesh.bind(skel);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.root.add(this.mesh);
    // 低模：离镜头较远时代替高模显示（两者共用同一套骨骼）
    this.meshLo = new THREE.SkinnedMesh(AvatarGeo.get(this.look, true), Avatar.mat);
    this.meshLo.bind(skel);
    this.meshLo.castShadow = true;
    this.meshLo.receiveShadow = true;
    this.meshLo.visible = false;
    this.root.add(this.meshLo);
    this.far = false;
    // 模型空间姿势（每帧计算）
    this.mp = AV_BONES.map(() => new THREE.Vector3());
    this.mq = AV_BONES.map(() => new THREE.Quaternion());
    // 动画状态
    this.bodyYaw = 0; this.turning = false; this.first = true;
    this.phase = 0; this.spd = 0; this.gaitW = 0; this.strideX = 0; this.strideZ = -1;
    this.airK = 0; this.airT = 0; this.land = 0; this.kneelK = 0; this.chargeK = 0; this.turnK = 0;
    this.recoil = { x: 0, v: 0 }; this.flP = { x: 0, v: 0 }; this.flR = { x: 0, v: 0 }; this.flH = { x: 0, v: 0 };
    this.drawT = 1; this.reloadT = -1; this.reloadDur = 2.5; this.wasReload = false;
    this.throwT = -1; this.knifeT = -1; this.knifeHeavy = false;
    this.heldId = ''; this.hold = 'none'; this.gunMesh = null;
    this.gear = { p: null, s: null, k: null, c4: null };
    this.gearIds = { p: '', s: '', k: '', c4: '' };
    this.rag = null;
    this.deathT = -1;          // 兼容旧接口：>=0 表示已死亡
    this.tag = null;
    if (friendly) this.makeTag(name);
  }

  makeTag(name) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.font = '600 30px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillText(name, 129, 23);
    ctx.fillStyle = '#e9b347'; ctx.fillText(name, 128, 22);
    ctx.beginPath(); ctx.moveTo(116, 44); ctx.lineTo(140, 44); ctx.lineTo(128, 60); ctx.closePath(); ctx.fill();
    const sm = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true });
    this.tag = new THREE.Sprite(sm);
    this.tag.scale.set(1.1, 0.275, 1);
    this.tag.position.y = 2.2;
    this.tag.renderOrder = 20;
    this.root.add(this.tag);
  }

  /** 远近切换高 / 低模 */
  setFar(far) {
    if (far === this.far) return;
    this.far = far;
    this.mesh.visible = !far;
    this.meshLo.visible = far;
  }
  dispose() {
    if (this.root.parent) this.root.parent.remove(this.root);
    this.mesh.skeleton.dispose();
    if (this.tag) { this.tag.material.map.dispose(); this.tag.material.dispose(); }
  }

  // ------------------------------------------------------------------
  //  手持物与装备
  // ------------------------------------------------------------------
  setHeld(id) {
    id = id || '';
    // 投掷动作进行中：等出手动画播完再换手持物（Bot 投完会立即切枪）
    if (this.throwT >= 0 && this.hold === 'nade' && id !== this.heldId) { this.pendingHeld = id; return; }
    this.pendingHeld = null;
    if (id === this.heldId) return;
    if (this.gunMesh) this.root.remove(this.gunMesh);
    this.gunMesh = null;
    this.heldId = id;
    this.hold = avHoldType(id);
    this.reloadT = -1; this.throwT = -1; this.knifeT = -1;
    if (!this.first) this.drawT = 0;
    if (!id) return;
    const m = GunModels.makeWorldMesh(id);
    this.root.add(m);
    this.gunMesh = m;
  }
  /** 背枪 / 枪套 / 匕首 / C4 的外显 */
  syncGear(ch) {
    const g = ch.gearState ? ch.gearState() : null;
    const held = this.heldId;
    const want = {
      p: g && g.p && g.p !== held ? g.p : '',
      s: g && g.s && g.s !== held ? g.s : '',
      k: held !== 'knife' ? 'knife' : '',
      c4: g && g.bomb && held !== 'c4' ? 'c4' : '',
    };
    for (const k of ['p', 's', 'k', 'c4']) {
      if (want[k] === this.gearIds[k]) continue;
      if (this.gear[k]) this.gear[k].parent.remove(this.gear[k]);
      this.gear[k] = null;
      this.gearIds[k] = want[k];
      if (!want[k]) continue;
      const m = GunModels.makeWorldMesh(want[k]);
      m.castShadow = true;
      if (k === 'p') {
        // 主武器斜背在背上：枪口朝左上，枪身贴背
        const len = m.userData.len || 0.8;
        m.quaternion.copy(AV_BACK_Q);
        m.position.set(0.02, 0.07 - (len - 0.8) * 0.2, 0.2 + (this.look.pack ? 0.07 : 0));
        this.bones[AB.chest].add(m);
      } else if (k === 's') {
        m.quaternion.copy(AV_HOLSTER_Q);
        m.position.set(0.19 - 0.095 + 0.085, -0.19, 0.012);
        this.bones[AB.thighR].add(m);
      } else if (k === 'k') {
        m.quaternion.copy(AV_SHEATH_Q);
        m.position.set(-0.12, -0.02, -0.16);
        this.bones[AB.chest].add(m);
      } else {
        m.quaternion.copy(AV_C4BACK_Q);
        m.position.set(0, -0.14, 0.19 + (this.look.pack ? 0.07 : 0));
        this.bones[AB.chest].add(m);
      }
    }
  }

  // ------------------------------------------------------------------
  //  外部事件
  // ------------------------------------------------------------------
  onFire(def) {
    const k = def && def.kind === 'sniper' ? 1.6 : def && def.kind === 'pistol' ? 1.1 : 0.8;
    this.recoil.v += 9 * k;
  }
  onKnife(heavy) { this.knifeT = 0; this.knifeHeavy = heavy; }
  onThrow() {
    // 远程玩家的手持物可能已经切走：先切回投掷物再播放出手动作
    if (this.hold !== 'nade') return;
    this.throwT = 0; this.chargeK = Math.max(this.chargeK, 0.6);
  }
  onHit(dirx, dirz, group, dmg) {
    // 受击抖动：按子弹方向在身体局部坐标系中施加冲量
    const s = clamp((dmg || 25) / 30, 0.4, 1.6);
    const cy = Math.cos(this.bodyYaw), sy = Math.sin(this.bodyYaw);
    const lz = dirx * sy + dirz * cy;         // 子弹方向在身体前后轴上的分量（+Z 为向后）
    const lx = dirx * cy - dirz * sy;         // 左右分量
    const head = group === 'head';
    this.flP.v += lz * 3.2 * s * (head ? 0.6 : 1);
    this.flR.v += -lx * 2.4 * s;
    if (head) this.flH.v += lz * 7 * s;
  }

  reset() {
    this.rag = null;
    this.deathT = -1;
    this.first = true;
    this.root.visible = true;
    this.drawT = 1; this.reloadT = -1; this.throwT = -1; this.knifeT = -1; this.pendingHeld = null;
    this.recoil.x = this.recoil.v = 0;
    this.flP.x = this.flP.v = this.flR.x = this.flR.v = this.flH.x = this.flH.v = 0;
    this.kneelK = 0; this.chargeK = 0; this.land = 0; this.airK = 0;
    if (this.gunMesh) this.gunMesh.visible = true;
    const h = this.heldId;
    this.heldId = '__';
    this.setHeld(h);
    this.drawT = 1;
  }

  // ------------------------------------------------------------------
  //  每帧更新
  // ------------------------------------------------------------------
  update(ch, dt) {
    if (this.rag) {
      this.rag.step(dt);
      this.rag.pose(this);
      if (this.tag) this.tag.visible = false;
      return;
    }
    if (!ch.alive) { this.root.visible = false; return; }
    this.root.visible = true;
    this.root.position.copy(ch.pos);
    this.animate(ch, dt);
    this.syncGear(ch);
    const cam = Game.camera && Game.camera.position;
    const camD = cam ? Math.hypot(cam.x - ch.pos.x, cam.y - ch.pos.y - 1.2, cam.z - ch.pos.z) : 10;
    this.setFar(camD > (Game.camera ? 19 * Game.camera.zoom * (SETTINGS.fov / Game.camera.fov) : 19));
    if (this.tag) {
      const hp = this.mp[AB.head];
      const d = cam ? Math.hypot(cam.x - ch.pos.x, cam.y - ch.pos.y - hp.y - 0.4, cam.z - ch.pos.z) : 15;
      const s = clamp(d * 0.07, 0.3, 1.6);
      this.tag.scale.set(s, s * 0.25, 1);
      this.tag.position.set(hp.x, hp.y + 0.42, hp.z);
      this.tag.visible = d > 1.6;
    }
    this.first = false;
  }

  animate(ch, dt) {
    const P = this.mp, Q = this.mq, t = Clock.time;
    dt = Math.min(dt, 0.05);
    // ================= 输入 =================
    const vx = ch.vel.x, vz = ch.vel.z;
    const speed = Math.hypot(vx, vz);
    this.spd = damp(this.spd, speed, 10, dt);
    const aimYaw = ch.yaw;
    const pitch = clamp(ch.pitch || 0, -1.2, 1.2);
    const crouchK = clamp(ch.crouch || 0, 0, 1);
    const planting = Bomb.planting === ch, defusing = Bomb.defuser === ch;
    this.kneelK = damp(this.kneelK, planting || defusing ? 1 : 0, 7, dt);
    const kneelK = this.kneelK;
    if (this.first) { this.bodyYaw = aimYaw; this.spd = speed; }
    // 空中 / 落地
    const inAir = ch.onGround === false;
    if (inAir) this.airT += dt;
    else { if (this.airT > 0.22) this.land = Math.min(1, this.airT * 1.6); this.airT = 0; }
    this.airK = damp(this.airK, inAir && this.airT > 0.08 ? 1 : 0, inAir ? 8 : 14, dt);
    this.land = damp(this.land, 0, 7, dt);

    // ================= 下半身朝向 =================
    const moving = this.spd > 0.5 && !inAir;
    let target = this.bodyYaw;
    const prevYaw = this.bodyYaw;
    if (kneelK > 0.5) target = aimYaw;
    else if (moving) {
      let rel = wrapAngle(yawOf(vx, vz) - aimYaw);
      if (Math.abs(rel) > 1.75) rel = wrapAngle(rel + Math.PI);     // 后退：腿仍朝前方，倒着走
      target = aimYaw + clamp(rel, -1.0, 1.0) * 0.85;
      this.turning = false;
    } else {
      const diff = Math.abs(wrapAngle(this.bodyYaw - aimYaw));
      if (diff > 0.95) this.turning = true;
      if (this.turning) { target = aimYaw; if (diff < 0.08) this.turning = false; }
    }
    this.bodyYaw = dampAngle(this.bodyYaw, target, moving ? 9 : 7, dt);
    const twist = clamp(wrapAngle(aimYaw - this.bodyYaw), -1.25, 1.25);
    this.bodyYaw = wrapAngle(aimYaw - twist);
    this.root.rotation.set(0, this.bodyYaw, 0);
    const yawRate = dt > 0 ? Math.abs(wrapAngle(this.bodyYaw - prevYaw)) / dt : 0;
    this.turnK = damp(this.turnK, !moving && !inAir ? clamp(yawRate / 2.5, 0, 1) : 0, 10, dt);

    // ================= 步态 =================
    const walkK = clamp(this.spd / 2, 0, 1);
    const runK = smoothstep(3.2, 5.2, this.spd);
    const gaitTarget = inAir ? 0 : Math.max(smoothstep(0.25, 1.1, this.spd), this.turnK * 0.7);
    this.gaitW = damp(this.gaitW, gaitTarget, 9, dt);
    const freq = this.spd > 0.25 ? 1.15 + this.spd * 0.22 : 1.6;
    this.phase = (this.phase + dt * freq * TAU) % (TAU * 1000);
    // 步幅方向：身体局部坐标下的速度方向
    const cy = Math.cos(this.bodyYaw), sy = Math.sin(this.bodyYaw);
    const lvx = vx * cy - vz * sy, lvz = vx * sy + vz * cy;
    if (speed > 0.3) { const l = Math.hypot(lvx, lvz); this.strideX = damp(this.strideX, lvx / l, 12, dt); this.strideZ = damp(this.strideZ, lvz / l, 12, dt); }
    const sl = Math.hypot(this.strideX, this.strideZ) || 1;
    const sdx = this.strideX / sl, sdz = this.strideZ / sl;
    const amp = moving ? clamp(0.04 + this.spd * 0.058, 0, 0.34) * (1 - crouchK * 0.25) : 0.07 * this.turnK;
    const stanceF = lerp(0.5, 0.38, runK);
    const lift = lerp(0.09, 0.15, runK) * (1 - crouchK * 0.4);
    const gw = this.gaitW * (1 - kneelK);

    // ================= 骨盆 =================
    const bob = gw * amp * 0.1 * (1 - Math.cos(this.phase * 2));      // 支撑中期骨盆最低
    let ph = lerp(0.965, 0.52, crouchK) - bob - this.land * 0.1 - runK * gw * 0.02;
    let pz = lerp(0, 0.05, crouchK);
    ph = lerp(ph, 0.5, kneelK); pz = lerp(pz, 0.1, kneelK);
    const hipSway = gw * Math.sin(this.phase) * 0.1;
    const lean = crouchK * 0.28 + kneelK * 0.42 + runK * gw * 0.14 + this.land * 0.12;
    P[AB.pelvis].set(Math.sin(this.phase) * gw * 0.012, ph, pz);
    avQuat(Q[AB.pelvis], -lean * 0.3, twist * 0.12 + hipSway, Math.sin(this.phase) * gw * 0.035);

    // ================= 动作计时 =================
    const hold = this.hold;
    this.drawT = Math.min(1, this.drawT + dt / 0.45);
    const drawK = 1 - Math.pow(1 - this.drawT, 3);
    const reloading = ch.remote ? !!ch.netReload : !!ch.reloading;
    if (reloading && !this.wasReload) {
      this.reloadT = 0;
      const def = WEAPONS[this.heldId];
      this.reloadDur = ch.remote ? (def && def.reload || 2.5) : Math.max(0.4, ch.reloadEnd - Clock.time);
    }
    this.wasReload = reloading;
    if (this.reloadT >= 0) { this.reloadT += dt / this.reloadDur; if (this.reloadT >= 1 || !reloading) this.reloadT = -1; }
    const reloadK = this.reloadT >= 0 ? smoothstep(0, 0.12, this.reloadT) * (1 - smoothstep(0.85, 1, this.reloadT)) : 0;
    const charging = ch.remote ? !!ch.netCharge : !!ch.nadeCharging;
    this.chargeK = damp(this.chargeK, charging && hold === 'nade' ? 1 : 0, 9, dt);
    if (this.throwT >= 0) {
      this.throwT += dt / 0.42;
      if (this.throwT >= 1) { this.throwT = -1; if (this.pendingHeld !== null && this.pendingHeld !== undefined) this.setHeld(this.pendingHeld); }
    }
    if (this.knifeT >= 0) { this.knifeT += dt / (this.knifeHeavy ? 0.6 : 0.36); if (this.knifeT >= 1) this.knifeT = -1; }
    avSpring(this.recoil, dt, 260, 26);
    avSpring(this.flP, dt, 90, 12); avSpring(this.flR, dt, 90, 12); avSpring(this.flH, dt, 140, 14);

    // ================= 脊柱 / 头 =================
    const blade = hold === 'rifle' ? -0.42 : hold === 'pistol' ? -0.1 : hold === 'knife' ? -0.2 : hold === 'nade' ? -0.2 - this.chargeK * 0.4 : 0;
    const breath = Math.sin(t * 1.7) * 0.012 * (1 - gw);
    const rc = this.recoil.x * 0.035;
    const fp = this.flP.x * 0.18, fr = this.flR.x * 0.18, fh = this.flH.x * 0.25;
    // 前倾（下蹲、跪地、奔跑）先在骨盆坐标系里施加，再扭转上半身：头部位移始终沿身体正前方，便于与命中盒对齐
    this._fkLean(AB.spine, AB.pelvis, -lean * 0.7, pitch * 0.06 + fp * 0.5, twist * 0.3 + blade * 0.4 - twist * 0.12 - hipSway, fr * 0.5);
    this._fk(AB.chest, AB.spine, pitch * 0.14 + breath + rc + fp, twist * 0.35 + blade * 0.6, fr);
    this._fk(AB.neck, AB.chest, pitch * 0.22 + lean * 0.4 - rc * 0.5 - fp * 0.6 + fh * 0.4, twist * 0.15 - blade * 0.45, -fr * 0.5);
    this._fk(AB.head, AB.neck, pitch * 0.58 + lean * 0.6 - rc * 0.5 - fp * 0.9 + fh, twist * 0.2 - blade * 0.55, -fr * 0.5);
    // 肩与髋关节位置
    this._fkPos(AB.armL, AB.chest); this._fkPos(AB.armR, AB.chest);
    this._fkPos(AB.thighL, AB.pelvis); this._fkPos(AB.thighR, AB.pelvis);

    // ================= 手持物姿态 =================
    const gm = this.gunMesh, gud = gm ? gm.userData : null;
    const cP = P[AB.chest], cQ = Q[AB.chest];
    avQuat(_aimQ, pitch, twist);
    let leftFree = true, rightFree = false;
    let poleR = _t4.set(0.85, -0.55, 0.25), poleL = _t5.set(-0.7, -0.75, 0.05);
    if (kneelK > 0.5 && (defusing || hold === 'none')) {
      // 拆弹：手伸向地面上的炸弹，枪收起
      if (gm) gm.visible = false;
      const jit = Math.sin(t * 11) * 0.02;
      _handR.set(0.07, 0.16 + jit, -0.44); _handL.set(-0.07, 0.17 - jit, -0.42);
      _hqR.copy(Q[AB.chest]); _hqL.copy(Q[AB.chest]);
      poleR.set(0.8, -0.2, 0.4); poleL.set(-0.8, -0.2, 0.4);
      leftFree = false;
    } else if (gm) {
      gm.visible = true;
      const gs = gm.scale.x;
      if (hold === 'rifle') {
        _t1.set(0.105, 0.125, -0.085).applyQuaternion(cQ).add(cP);                 // 右肩窝
        _gunQ.copy(_aimQ);
        _tq1.setFromAxisAngle(_t2.set(1, 0, 0), this.recoil.x * 0.06 - reloadK * 0.4 - (1 - drawK) * 1.1);
        _gunQ.multiply(_tq1);
        if (reloadK > 0) _gunQ.multiply(_tq2.setFromAxisAngle(_t2.set(0, 0, 1), reloadK * 0.55));
        _gunP.set(0, -0.035 - reloadK * 0.05 - (1 - drawK) * 0.15, -(gud.butt || 0.3) * gs + this.recoil.x * 0.012 + (1 - drawK) * 0.12).applyQuaternion(_aimQ).add(_t1);
        _handR.copy(gud.rh).multiplyScalar(gs).applyQuaternion(_gunQ).add(_gunP);
        _hqR.copy(_gunQ).multiply(AV_GRIP_R);
        if (gud.lh) {
          _handL.copy(gud.lh).multiplyScalar(gs);
          _hqL.copy(_gunQ).multiply(AV_GRIP_L);
          if (reloadK > 0) {
            // 换弹：左手去握弹匣 → 到胸前弹匣包取新弹匣 → 装上 → 回到护木
            const r = this.reloadT;
            const k1 = smoothstep(0.08, 0.28, r) * (1 - smoothstep(0.72, 0.9, r));
            const k2 = smoothstep(0.3, 0.42, r) * (1 - smoothstep(0.5, 0.64, r));
            if (gud.mag) _t2.copy(gud.mag).add(_t3.set(0, -0.09, 0)).multiplyScalar(gs); else _t2.set(0, -0.12, -0.15);
            _handL.lerp(_t2, k1).applyQuaternion(_gunQ).add(_gunP);
            _t3.set(-0.085, -0.05, -0.2).applyQuaternion(cQ).add(cP);
            _handL.lerp(_t3, k2);
          } else _handL.applyQuaternion(_gunQ).add(_gunP);
          leftFree = false;
        }
      } else if (hold === 'pistol') {
        _t1.set(0.02, 0.16, -0.05).applyQuaternion(cQ).add(cP);
        _gunQ.copy(_aimQ).multiply(_tq1.setFromAxisAngle(_t2.set(1, 0, 0), this.recoil.x * 0.16 - reloadK * 0.5 - (1 - drawK) * 1.0));
        _gunP.set(0.035, -0.04 - reloadK * 0.06 - (1 - drawK) * 0.12, -0.4 + this.recoil.x * 0.01 + reloadK * 0.1 + (1 - drawK) * 0.15).applyQuaternion(_aimQ).add(_t1);
        _handR.copy(gud.rh).multiplyScalar(gs).applyQuaternion(_gunQ).add(_gunP);
        _hqR.copy(_gunQ).multiply(AV_GRIP_R);
        if (reloadK > 0) {
          const k2 = Math.sin(clamp((this.reloadT - 0.15) / 0.7, 0, 1) * Math.PI);
          _handL.set(-0.02, -0.12, 0.02).applyQuaternion(_gunQ).add(_gunP);
          _handL.lerp(_t3.set(-0.18, 1.02, -0.08), k2 * 0.8);
          _hqL.copy(_gunQ).multiply(AV_GRIP_R);
        } else {
          _handL.set(-0.028, -0.055, 0.0).applyQuaternion(_gunQ).add(_gunP);
          _hqL.copy(_gunQ).multiply(AV_GRIP_R);
        }
        leftFree = false;
        poleR.set(0.55, -0.8, 0.2); poleL.set(-0.55, -0.8, 0.2);
      } else if (hold === 'knife') {
        // 刀：右手持刀在身前偏右，轻击横向挥砍、重击向前刺
        let hx = 0.19, hy = -0.2, hz = -0.3, ry = 0, rx = -0.45;
        if (this.knifeT >= 0) {
          const k = this.knifeT;
          if (this.knifeHeavy) {
            const a = smoothstep(0, 0.3, k), b = smoothstep(0.3, 0.55, k) * (1 - smoothstep(0.65, 1, k));
            hy += a * 0.12 - b * 0.08; hz += a * 0.12 - b * 0.35; rx += b * 0.35;
          } else {
            const s = Math.sin(k * Math.PI), sw = smoothstep(0.05, 0.6, k);
            hx = lerp(0.3, -0.15, sw); hz -= s * 0.18; hy += s * 0.08; ry = lerp(-0.7, 0.9, sw); rx += s * 0.3;
          }
        }
        _t1.set(hx, hy - (1 - drawK) * 0.15, hz).applyQuaternion(_tq2.setFromAxisAngle(_t2.set(0, 1, 0), twist * 0.35 + blade * 0.6)).add(cP);
        avQuat(_gunQ, rx, twist + ry);
        _handR.copy(_t1);
        _gunP.copy(gud.rh).multiplyScalar(-gs).applyQuaternion(_gunQ).add(_handR);
        _hqR.copy(_gunQ);
        poleR.set(0.8, -0.6, 0.4);
        _handL.set(-0.13, -0.08, -0.24).applyQuaternion(cQ).add(cP);
        _hqL.copy(cQ);
        leftFree = false;
      } else if (hold === 'nade') {
        // 手雷：握在身前 → 蓄力举到头后 → 甩臂投出
        const ck = this.chargeK;
        _t1.set(lerp(0.17, 0.22, ck), lerp(-0.06, 0.3, ck), lerp(-0.26, 0.1, ck));
        let hideNade = false;
        if (this.throwT >= 0) {
          const k = this.throwT;
          const a = smoothstep(0, 0.45, k), b = smoothstep(0.45, 1, k);
          _t1.set(lerp(0.22, 0.12, a), lerp(0.3, 0.22, a) - b * 0.3, lerp(0.1, -0.5, a) + b * 0.15);
          hideNade = k > 0.35;
        }
        _t1.applyQuaternion(cQ).add(cP);
        _handR.copy(_t1);
        _gunQ.copy(cQ).multiply(_tq1.setFromAxisAngle(_t2.set(1, 0, 0), -0.6));
        _gunP.copy(gud.rh).multiplyScalar(-gs).applyQuaternion(_gunQ).add(_handR);
        _hqR.copy(_gunQ);
        gm.visible = !hideNade && this.drawT > 0.3;
        _handL.set(lerp(-0.08, -0.12, ck), lerp(-0.05, 0.1, ck), lerp(-0.25, -0.42, ck)).applyQuaternion(cQ).add(cP);
        _hqL.copy(cQ);
        poleR.set(0.9, -0.3 + ck * 0.3, 0.1);
        leftFree = false;
      } else if (hold === 'c4') {
        // C4：双手捧在身前；下包时跪地，放在地上敲键盘
        if (kneelK > 0.3) {
          const jit = Math.sin(t * 13) * 0.015 * kneelK;
          _gunP.set(0, lerp(0.95, 0.12, kneelK), lerp(-0.3, -0.45, kneelK));
          avQuat(_gunQ, 0, twist);
          _handR.set(0.07, _gunP.y + 0.05 + jit, _gunP.z + 0.02); _handL.set(-0.07, _gunP.y + 0.05 - jit, _gunP.z + 0.01);
        } else {
          _gunP.set(0, -0.2 - (1 - drawK) * 0.15, -0.28).applyQuaternion(cQ).add(cP);
          _gunQ.copy(cQ).multiply(_tq1.setFromAxisAngle(_t2.set(1, 0, 0), 0.25));
          _handR.set(0.085, 0, 0.02).applyQuaternion(_gunQ).add(_gunP);
          _handL.set(-0.085, 0, 0.01).applyQuaternion(_gunQ).add(_gunP);
        }
        _hqR.copy(_gunQ).multiply(_tq3.setFromAxisAngle(_t2.set(0, 0, 1), 0.4));
        _hqL.copy(_gunQ).multiply(_tq3.setFromAxisAngle(_t2.set(0, 0, 1), -0.4));
        poleR.set(0.8, -0.5, 0.3); poleL.set(-0.8, -0.5, 0.3);
        leftFree = false;
      }
      gm.position.copy(_gunP);
      gm.quaternion.copy(_gunQ);
    } else rightFree = true;

    // ================= 手臂 IK =================
    const swingArm = (side) => {
      // 空手时手臂自然下垂、随步伐摆动
      const s = side < 0 ? -1 : 1;
      const ph2 = this.phase + (s < 0 ? 0 : Math.PI);
      return _t3.set(s * 0.21, -0.36, -Math.sin(ph2) * 0.12 * gw - 0.04).applyQuaternion(cQ).add(cP);
    };
    if (rightFree) { _handR.copy(swingArm(1)); _hqR.copy(cQ); poleR.set(0.3, -0.2, 1); }
    if (leftFree) { _handL.copy(swingArm(-1)); _hqL.copy(cQ); poleL.set(-0.3, -0.2, 1); }
    this._arm(AB.armR, AB.foreR, AB.handR, _handR, _hqR, poleR.applyQuaternion(_tq2.setFromAxisAngle(_t2.set(0, 1, 0), twist * 0.7)));
    this._arm(AB.armL, AB.foreL, AB.handL, _handL, _hqL, poleL.applyQuaternion(_tq2.setFromAxisAngle(_t2.set(0, 1, 0), twist * 0.7)));

    // ================= 腿 IK =================
    for (let i = 0; i < 2; i++) {
      const s = i === 0 ? -1 : 1;
      const thigh = s < 0 ? AB.thighL : AB.thighR, shin = thigh + 1, foot = thigh + 2;
      const ft = _footT[i];
      // 静止站姿：左脚略前、右脚略后（持步枪时的侧身站姿）；蹲下时两脚前后分开
      const bx = s * lerp(0.11, 0.135, crouchK), bz = (s < 0 ? -0.04 : 0.05) + (s < 0 ? -0.08 : 0.06) * crouchK;
      ft.set(bx, 0.08, bz);
      // 步态：支撑相脚贴地向后划，摆动相抬脚前迈
      let footPitch = 0;
      if (gw > 0.001) {
        let u = ((this.phase + (s > 0 ? Math.PI : 0)) / TAU) % 1;
        let off, up = 0;
        if (u < stanceF) { off = lerp(1, -1, u / stanceF); }
        else { const w = (u - stanceF) / (1 - stanceF); off = lerp(-1, 1, smoothstep(0, 1, w)); up = Math.sin(w * Math.PI); footPitch = -Math.sin(w * Math.PI) * 0.35 + (w > 0.8 ? (w - 0.8) * 1.2 : 0); }
        ft.x += sdx * off * amp * gw;
        ft.z += sdz * off * amp * gw;
        ft.y += up * lift * gw;
      }
      // 空中收腿
      if (this.airK > 0.001) { ft.y += this.airK * (0.26 + (s < 0 ? 0.05 : 0)); ft.z -= this.airK * 0.08; footPitch -= this.airK * 0.3; }
      // 跪姿：右膝着地、左脚在前
      if (kneelK > 0.001) {
        _t1.set(s < 0 ? -0.14 : 0.13, 0.08, s < 0 ? -0.24 : 0.43);
        ft.lerp(_t1, kneelK);
        footPitch = lerp(footPitch, s > 0 ? 1.1 : 0, kneelK);
      }
      _pole.set(s * 0.12, kneelK > 0.5 && s > 0 ? -0.7 : 0, -1).applyQuaternion(_tq2.setFromAxisAngle(_t2.set(0, 1, 0), twist * 0.1));
      avIK(P[thigh], ft, AV_LEG1, AV_LEG2, _pole, _mid, _end, _hinge, true);
      avLimbQuat(Q[thigh], P[thigh], _mid, _hinge);
      avLimbQuat(Q[shin], _mid, _end, _hinge);
      P[shin].copy(_mid); P[foot].copy(_end);
      avQuat(Q[foot], footPitch, 0);
    }

    // ================= 写入骨骼 =================
    const bones = this.bones;
    bones[AB.pelvis].position.copy(P[AB.pelvis]);
    bones[AB.pelvis].quaternion.copy(Q[AB.pelvis]);
    for (let i = 2; i < AV_BONES.length; i++) {
      const par = AV_BONES[i][1];
      bones[i].quaternion.copy(_tq1.copy(Q[par]).invert().multiply(Q[i]));
    }
  }
  /** 正向运动学：子骨骼 = 父骨骼 × 绑定偏移 × 局部旋转（pitch/yaw/roll） */
  _fk(i, par, pitch, yaw, roll) {
    const P = this.mp, Q = this.mq;
    P[i].copy(AV_OFF[i]).applyQuaternion(Q[par]).add(P[par]);
    Q[i].copy(Q[par]).multiply(avQuat(_tq3, pitch, yaw, roll));
  }
  _fkPos(i, par) { this.mp[i].copy(AV_OFF[i]).applyQuaternion(this.mq[par]).add(this.mp[par]); }
  /** 带前倾的正向运动学：先绕父骨骼 X 轴前倾，再按 yaw/pitch/roll 旋转 */
  _fkLean(i, par, lean, pitch, yaw, roll) {
    const P = this.mp, Q = this.mq;
    P[i].copy(AV_OFF[i]).applyQuaternion(Q[par]).add(P[par]);
    Q[i].copy(Q[par]).multiply(_tq2.setFromAxisAngle(_t2.set(1, 0, 0), lean)).multiply(avQuat(_tq3, pitch, yaw, roll));
  }
  /** 手臂两段 IK：肩 → 腕（手掌握点往回退 6cm） */
  _arm(arm, fore, hand, grip, handQ, pole) {
    const P = this.mp, Q = this.mq;
    _t1.set(0, 0.06, 0).applyQuaternion(handQ).add(grip);
    avIK(P[arm], _t1, AV_ARM1, AV_ARM2, pole, _mid, _end, _hinge, false);
    avLimbQuat(Q[arm], P[arm], _mid, _hinge);
    avLimbQuat(Q[fore], _mid, _end, _hinge);
    P[fore].copy(_mid); P[hand].copy(_end);
    Q[hand].copy(handQ);
  }

  // ------------------------------------------------------------------
  //  死亡：切换为布娃娃
  // ------------------------------------------------------------------
  die(ch, dirx, dirz, weaponId, headshot) {
    if (this.rag) return;
    this.deathT = 0;
    if (this.gunMesh) this.gunMesh.visible = false;
    if (this.tag) this.tag.visible = false;
    if (!this.root.visible || this.first) { this.root.visible = false; return; }
    this.rag = new Ragdoll(this, ch, dirx, dirz, weaponId, headshot);
  }
}

// =====================================================================
//  布娃娃：15 个质点（头、颈、骨盆、肩肘手 ×2、髋膝脚 ×2）
// =====================================================================
const RAG_R = [0.11, 0.09, 0.12, 0.075, 0.055, 0.05, 0.075, 0.055, 0.05, 0.085, 0.06, 0.06, 0.085, 0.06, 0.06];
const RAG_M = [4, 6, 10, 5, 2.5, 1.2, 5, 2.5, 1.2, 6, 4, 2, 6, 4, 2];
const RAG_LINK = [[0, 1], [1, 3], [1, 6], [3, 6], [1, 2], [2, 9], [2, 12], [9, 12], [3, 9], [6, 12], [3, 12], [6, 9],
  [3, 4], [4, 5], [6, 7], [7, 8], [9, 10], [10, 11], [12, 13], [13, 14]];
// 最小距离约束（模拟关节活动范围）：[i, j, 相对初始长度的比例]
const RAG_MIN = [[0, 2, 0.93], [0, 3, 0.8], [0, 6, 0.8], [3, 5, 0.42], [6, 8, 0.42], [9, 11, 0.55], [12, 14, 0.55], [10, 13, 0.6], [11, 14, 0.5], [5, 2, 0.35], [8, 2, 0.35]];
const _rq = new THREE.Quaternion(), _rq2 = new THREE.Quaternion(), _rv = new THREE.Vector3(), _rv2 = new THREE.Vector3();
const _rx = new THREE.Vector3(), _ry = new THREE.Vector3(), _rz = new THREE.Vector3(), _rm = new THREE.Matrix4();
const RAG_G = 16, RAG_DT = 1 / 60;

class Ragdoll {
  constructor(av, ch, dirx, dirz, weaponId, headshot) {
    const P = av.mp, Q = av.mq, R = av.root;
    R.updateMatrixWorld(true);
    const local = [
      _rv.set(0, 0.09, 0).applyQuaternion(Q[AB.head]).add(P[AB.head]).clone(),
      P[AB.neck].clone(), P[AB.pelvis].clone(),
      P[AB.armL].clone(), P[AB.foreL].clone(), _rv.set(0, -0.06, 0).applyQuaternion(Q[AB.handL]).add(P[AB.handL]).clone(),
      P[AB.armR].clone(), P[AB.foreR].clone(), _rv.set(0, -0.06, 0).applyQuaternion(Q[AB.handR]).add(P[AB.handR]).clone(),
      P[AB.thighL].clone(), P[AB.shinL].clone(), P[AB.footL].clone(),
      P[AB.thighR].clone(), P[AB.shinR].clone(), P[AB.footR].clone(),
    ];
    this.inv = R.matrixWorld.clone().invert();
    this.p = local.map(v => v.applyMatrix4(R.matrixWorld));
    // 初速度：角色当前速度 + 中弹冲量（爆头冲量集中在头部，身体中弹集中在胸口）
    const def = WEAPONS[weaponId];
    let F = def ? clamp(def.damage / 34, 0.6, 3.2) * 2.4 : weaponId === 'he' || weaponId === 'bomb' ? 6 : 2.5;
    let dl = Math.hypot(dirx || 0, dirz || 0);
    let dx = dl > 1e-4 ? dirx / dl : 0, dz = dl > 1e-4 ? dirz / dl : 0;
    const blast = weaponId === 'he' || weaponId === 'bomb';
    const w = headshot ? [1.6, 1.0, 0.25, 0.6, 0.3, 0.2, 0.6, 0.3, 0.2, 0.15, 0.1, 0.05, 0.15, 0.1, 0.05]
      : [0.8, 1.0, 0.6, 0.9, 0.5, 0.3, 0.9, 0.5, 0.3, 0.35, 0.2, 0.1, 0.35, 0.2, 0.1];
    const vx = clamp(ch.vel.x, -7, 7), vz = clamp(ch.vel.z, -7, 7);
    this.o = this.p.map((p, i) => {
      const k = blast ? 1 : w[i];
      const ivx = vx * 0.8 + dx * F * k + rand(-0.15, 0.15), ivz = vz * 0.8 + dz * F * k + rand(-0.15, 0.15);
      const ivy = (blast ? 3 : headshot && i === 0 ? 0.8 : 0.2) * k;
      return new THREE.Vector3(p.x - ivx * RAG_DT, p.y - ivy * RAG_DT, p.z - ivz * RAG_DT);
    });
    // 膝盖先往前弯，身体自然瘫软
    for (const i of [10, 13]) { this.o[i].x += Math.sin(av.bodyYaw) * 0.6 * RAG_DT; this.o[i].z += Math.cos(av.bodyYaw) * 0.6 * RAG_DT; }
    this.im = RAG_M.map(m => 1 / m);
    this.len = RAG_LINK.map(([a, b]) => this.p[a].distanceTo(this.p[b]));
    this.minLen = RAG_MIN.map(([a, b, f]) => this.p[a].distanceTo(this.p[b]) * f);
    // 附近的碰撞盒
    const c = this.p[2];
    this.boxes = World.query(c.x - 2.6, c.y - 2.6, c.z - 2.6, c.x + 2.6, c.y + 2.6, c.z + 2.6, []);
    this.acc = 0; this.t = 0; this.still = 0; this.sleep = false;
    this.hinges = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0)];
    this.chestX = new THREE.Vector3(1, 0, 0);
  }

  step(dt) {
    if (this.sleep) return;
    this.acc += Math.min(dt, 0.1);
    let n = 0;
    while (this.acc >= RAG_DT && n < 3) { this.acc -= RAG_DT; this.sub(); n++; }
    if (n === 3) this.acc = 0;
  }
  sub() {
    const p = this.p, o = this.o;
    this.t += RAG_DT;
    let moved = 0;
    // Verlet 积分
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = o[i];
      const vx = (a.x - b.x) * 0.992, vy = (a.y - b.y) * 0.992, vz = (a.z - b.z) * 0.992;
      b.copy(a);
      a.x += vx; a.y += vy - RAG_G * RAG_DT * RAG_DT; a.z += vz;
      moved = Math.max(moved, Math.abs(vx) + Math.abs(vy) + Math.abs(vz));
    }
    for (let it = 0; it < 8; it++) {
      this.solve();
      if (it % 2 === 1) this.collide();
    }
    this.still = moved < 0.0012 ? this.still + 1 : 0;
    if (!this.pool && (this.still > 20 || this.t > 1.6)) {
      // 身下的血泊（在胸口与骨盆之间的地面上）
      this.pool = true;
      const c = this.p[1], d = this.p[2];
      const x = (c.x + d.x) / 2, z = (c.z + d.z) / 2;
      const fy = World.floorBelow(x, Math.min(c.y, d.y) + 0.3, z, 0.05, 1.5);
      if (fy > -Infinity && FX.ready) FX.bloodDecals.add(x, fy, z, 0, 1, 0, rand(0.75, 1.05));
    }
    if (this.still > 40 || this.t > 5) this.sleep = true;
  }
  solve() {
    const p = this.p, im = this.im;
    for (let k = 0; k < RAG_LINK.length; k++) this.link(RAG_LINK[k][0], RAG_LINK[k][1], this.len[k], false);
    for (let k = 0; k < RAG_MIN.length; k++) this.link(RAG_MIN[k][0], RAG_MIN[k][1], this.minLen[k], true);
    // 膝盖只能向前弯：膝盖相对"髋-脚"连线必须在身体前方
    const up = _rv.subVectors(p[1], p[2]), right = _rv2.subVectors(p[6], p[3]);
    const fwd = _rz.crossVectors(up, right);
    const fl = fwd.length();
    if (fl > 1e-5) {
      fwd.multiplyScalar(1 / fl);
      for (const [h, kn, f] of [[9, 10, 11], [12, 13, 14]]) {
        const mx = (p[h].x + p[f].x) / 2, my = (p[h].y + p[f].y) / 2, mz = (p[h].z + p[f].z) / 2;
        const d = (p[kn].x - mx) * fwd.x + (p[kn].y - my) * fwd.y + (p[kn].z - mz) * fwd.z;
        if (d < 0.015) { const c = (0.015 - d) * 0.5; p[kn].addScaledVector(fwd, c); }
      }
    }
    void im;
  }
  link(a, b, L, minOnly) {
    const p = this.p, pa = p[a], pb = p[b];
    const dx = pb.x - pa.x, dy = pb.y - pa.y, dz = pb.z - pa.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-6 || (minOnly && d >= L)) return;
    const wa = this.im[a], wb = this.im[b], diff = (d - L) / (d * (wa + wb));
    pa.x += dx * diff * wa; pa.y += dy * diff * wa; pa.z += dz * diff * wa;
    pb.x -= dx * diff * wb; pb.y -= dy * diff * wb; pb.z -= dz * diff * wb;
  }
  collide() {
    const p = this.p, o = this.o, boxes = this.boxes;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], r = RAG_R[i];
      let ground = false;
      if (a.y < r) { a.y = r; ground = true; }
      for (let k = 0; k < boxes.length; k++) {
        const b = boxes[k];
        if (a.x < b.x0 - r || a.x > b.x1 + r || a.y < b.y0 - r || a.y > b.y1 + r || a.z < b.z0 - r || a.z > b.z1 + r) continue;
        const qx = clamp(a.x, b.x0, b.x1), qy = clamp(a.y, b.y0, b.y1), qz = clamp(a.z, b.z0, b.z1);
        let dx = a.x - qx, dy = a.y - qy, dz = a.z - qz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2), k2 = (r - d) / d;
          a.x += dx * k2; a.y += dy * k2; a.z += dz * k2;
          if (dy / d > 0.6) ground = true;
        } else {
          // 质点进入盒子内部：沿穿透最浅的方向推出
          const e = [a.x - b.x0, b.x1 - a.x, a.y - b.y0, b.y1 - a.y, a.z - b.z0, b.z1 - a.z];
          let m = 0;
          for (let j = 1; j < 6; j++) if (e[j] < e[m]) m = j;
          const push = e[m] + r;
          if (m === 0) a.x -= push; else if (m === 1) a.x += push;
          else if (m === 2) a.y -= push; else if (m === 3) { a.y += push; ground = true; }
          else if (m === 4) a.z -= push; else a.z += push;
        }
      }
      if (ground) {   // 地面摩擦
        o[i].x = lerp(o[i].x, a.x, 0.35);
        o[i].z = lerp(o[i].z, a.z, 0.35);
      }
    }
  }

  /** 把质点位置换算成骨骼姿态 */
  pose(av) {
    const P = av.mp, Q = av.mq, inv = this.inv;
    const L = this.p.map((v, i) => (this._l || (this._l = this.p.map(() => new THREE.Vector3())))[i].copy(v).applyMatrix4(inv));
    const basis = (out, yTop, yBot, xA, xB, fallbackX) => {
      _ry.subVectors(yTop, yBot).normalize();
      if (xA) _rx.subVectors(xA, xB); else _rx.copy(fallbackX);
      _rx.addScaledVector(_ry, -_rx.dot(_ry));
      if (_rx.lengthSq() < 1e-8) _rx.copy(fallbackX).addScaledVector(_ry, -fallbackX.dot(_ry));
      _rx.normalize();
      _rz.crossVectors(_rx, _ry);
      return out.setFromRotationMatrix(_rm.makeBasis(_rx, _ry, _rz));
    };
    // 躯干
    P[AB.pelvis].copy(L[2]);
    basis(Q[AB.pelvis], L[1], L[2], L[12], L[9], this.chestX);
    basis(Q[AB.chest], L[1], L[2], L[6], L[3], this.chestX);
    this.chestX.copy(_rx);
    Q[AB.spine].copy(Q[AB.pelvis]).slerp(Q[AB.chest], 0.5);
    P[AB.spine].copy(AV_OFF[AB.spine]).applyQuaternion(Q[AB.pelvis]).add(P[AB.pelvis]);
    P[AB.chest].copy(AV_OFF[AB.chest]).applyQuaternion(Q[AB.spine]).add(P[AB.spine]);
    P[AB.neck].copy(AV_OFF[AB.neck]).applyQuaternion(Q[AB.chest]).add(P[AB.chest]);
    basis(Q[AB.neck], L[0], L[1], null, null, this.chestX);
    Q[AB.head].copy(Q[AB.neck]);
    P[AB.head].copy(AV_OFF[AB.head]).applyQuaternion(Q[AB.neck]).add(P[AB.neck]);
    // 四肢：铰链轴 = 两段的叉积（伸直时沿用上一帧）
    const limb = (hi, sh, el, ha, b1, b2, b3, leg) => {
      _rv.subVectors(L[el], L[sh]); _rv2.subVectors(L[ha], L[el]);
      _rx.crossVectors(_rv, _rv2);
      if (leg) _rx.negate();
      if (_rx.lengthSq() > 1e-6) this.hinges[hi].copy(_rx.normalize());
      const hg = this.hinges[hi];
      avLimbQuat(Q[b1], L[sh], L[el], hg);
      avLimbQuat(Q[b2], L[el], L[ha], hg);
      Q[b3].copy(Q[b2]);
    };
    limb(0, 3, 4, 5, AB.armL, AB.foreL, AB.handL, false);
    limb(1, 6, 7, 8, AB.armR, AB.foreR, AB.handR, false);
    limb(2, 9, 10, 11, AB.thighL, AB.shinL, AB.footL, true);
    limb(3, 12, 13, 14, AB.thighR, AB.shinR, AB.footR, true);
    const bones = av.bones;
    bones[AB.pelvis].position.copy(P[AB.pelvis]);
    bones[AB.pelvis].quaternion.copy(Q[AB.pelvis]);
    for (let i = 2; i < AV_BONES.length; i++) {
      const par = AV_BONES[i][1];
      bones[i].quaternion.copy(_rq.copy(Q[par]).invert().multiply(Q[i]));
    }
  }
}
