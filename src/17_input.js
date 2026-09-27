// =====================================================================
//  17 输入模块：键盘 / 鼠标 / Pointer Lock / 全屏键盘锁定
//  - 使用 e.code（物理按键），不受输入法与键盘布局影响
//  - 每帧开始时锁存鼠标位移，帧末清空"本帧按下"状态
//  - 全屏时用 Keyboard Lock API 截获 Ctrl+W 等浏览器快捷键（Chrome/Edge）
// =====================================================================

const GAME_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyE', 'KeyR', 'KeyQ', 'KeyB', 'KeyF', 'KeyG', 'KeyY', 'KeyU', 'KeyM', 'Space', 'Tab',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'];

const Input = {
  keys: new Set(),
  pressedSet: new Set(),
  btns: [false, false, false],
  btnP: [false, false, false],
  mouseDX: 0, mouseDY: 0, wheel: 0,
  _ax: 0, _ay: 0, _wh: 0,
  locked: false,

  init(canvas) {
    this.canvas = canvas;
    window.addEventListener('keydown', (e) => this.onKey(e, true), true);
    window.addEventListener('keyup', (e) => this.onKey(e, false), true);
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const dx = e.movementX || 0, dy = e.movementY || 0;
      // 部分浏览器/驱动偶尔产生异常巨大的位移，丢弃
      if (Math.abs(dx) > 450 || Math.abs(dy) > 450) return;
      this._ax += dx; this._ay += dy;
    });
    document.addEventListener('mousedown', (e) => {
      if (Game.state === 'playing' && !this.locked && !UI.blocking() && e.target === canvas) { this.lock(); return; }
      if (!this.locked && !CFG.DEBUG) return;
      if (e.button < 3) { this.btns[e.button] = true; this.btnP[e.button] = true; }
    });
    document.addEventListener('mouseup', (e) => { if (e.button < 3) this.btns[e.button] = false; });
    document.addEventListener('wheel', (e) => { if (this.locked) { this._wh += Math.sign(e.deltaY); e.preventDefault(); } }, { passive: false });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this.btns.fill(false); Game.onUnlock(); }
      else Game.onLock();
    });
    document.addEventListener('pointerlockerror', () => {
      this.locked = false;
      if (Game.state === 'playing' && !UI.buyOpen && UI.screen === null) $('clickToPlay').classList.remove('hidden');
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.btns.fill(false); });
  },

  onKey(e, down) {
    const code = e.code;
    if (UI.chatOpen) return;          // 正在输入聊天：按键交给输入框
    if (Game.state === 'playing' && (GAME_KEYS.includes(code) || e.ctrlKey || e.altKey)) {
      // 游戏中阻止浏览器默认行为（Tab 切焦点、空格滚动、Ctrl+S/D 等）
      if (!(UI.screen && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT'))) e.preventDefault();
    }
    if (down) {
      if (!this.keys.has(code)) { this.pressedSet.add(code); Game.onKeyDown(code, e); }
      this.keys.add(code);
    } else {
      this.keys.delete(code);
      Game.onKeyUp(code, e);
    }
  },
  down(code) { return this.keys.has(code); },
  pressed(code) { return this.pressedSet.has(code); },
  btn(i) { return this.btns[i]; },
  btnPressed(i) { return this.btnP[i]; },

  beginFrame() {
    this.mouseDX = this._ax; this.mouseDY = this._ay; this._ax = 0; this._ay = 0;
    this.wheel = this._wh; this._wh = 0;
  },
  endFrame() { this.pressedSet.clear(); this.btnP.fill(false); },

  lock() {
    if (CFG.DEBUG && Game.headless) return;
    $('clickToPlay').classList.add('hidden');
    if (SETTINGS.fullscreen && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => {
        if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock(GAME_KEYS).catch(() => {});
      }).catch(() => {});
    }
    const c = this.canvas;
    try {
      const p = c.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { c.requestPointerLock(); } catch (e) { /* 忽略 */ } });
    } catch (e) {
      try { c.requestPointerLock(); } catch (e2) { /* 忽略 */ }
    }
  },
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); },
};
