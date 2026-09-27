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
