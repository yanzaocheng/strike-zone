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
