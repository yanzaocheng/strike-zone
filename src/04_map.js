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
