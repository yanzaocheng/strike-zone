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
