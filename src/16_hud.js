// =====================================================================
//  16 界面模块：HUD（血量/护甲/弹药/金钱/计时/比分/击杀提示/准星/雷达）、
//  购买菜单、计分板、回合横幅、菜单与设置
// =====================================================================

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SETTING_SCHEMA = [
  { section: '控制' },
  { key: 'sens', label: '鼠标灵敏度', type: 'range', min: 0.2, max: 8, step: 0.05 },
  { key: 'zoomSens', label: '开镜灵敏度倍率', type: 'range', min: 0.3, max: 2, step: 0.05 },
  { key: 'invertY', label: '反转 Y 轴', type: 'check' },
  { key: 'fullscreen', label: '全屏并锁定快捷键', type: 'check', note: '防止 Ctrl+W 等浏览器快捷键误触' },
  { section: '画面' },
  { key: 'fov', label: '视野 (FOV)', type: 'range', min: 60, max: 95, step: 1 },
  { key: 'quality', label: '画质', type: 'select', options: [['low', '低（无阴影，最流畅）'], ['medium', '中（推荐）'], ['high', '高（高清阴影 + 抗锯齿）']] },
  { key: 'showFps', label: '显示帧率', type: 'check' },
  { section: '准星' },
  { key: 'crossColor', label: '颜色', type: 'color' },
  { key: 'crossSize', label: '长度', type: 'range', min: 2, max: 16, step: 1 },
  { key: 'crossGap', label: '间隙', type: 'range', min: 0, max: 12, step: 1 },
  { key: 'crossThick', label: '粗细', type: 'range', min: 1, max: 4, step: 1 },
  { key: 'crossDot', label: '中心点', type: 'check' },
  { key: 'crossDynamic', label: '动态准星', type: 'check', note: '准星间隙随实际扩散变化' },
  { section: '游戏' },
  { key: 'difficulty', label: 'Bot 难度', type: 'select', options: Object.keys(DIFFICULTY).map(k => [k, DIFFICULTY[k].name]) },
  { key: 'teammates', label: '队友 Bot 数量', type: 'range', min: 0, max: 4, step: 1, note: '下一场比赛生效' },
  { key: 'winRounds', label: '获胜所需回合', type: 'select', options: [[5, '5 回合（快速）'], [8, '8 回合'], [13, '13 回合（完整）']] },
  { key: 'trajectory', label: '投掷物轨迹预览', type: 'check' },
  { section: '音频' },
  { key: 'volume', label: '主音量', type: 'range', min: 0, max: 1, step: 0.01 },
];

const REASON_TEXT = { elim: '敌方全部阵亡', bomb: '炸弹已爆炸', defuse: '炸弹已被拆除', time: '回合时间耗尽' };
const WIN_TEXT = { T: '恐怖分子获胜', CT: '反恐精英获胜' };

/** 地址栏中的 ?room= 参数（邀请链接），保留 server/debug 等其他参数 */
function setRoomParam(code) {
  try {
    const q = new URLSearchParams(location.search);
    if (code) q.set('room', code); else q.delete('room');
    const s = q.toString().replace(/=(?=&|$)/g, '');
    history.replaceState(null, '', location.pathname + (s ? '?' + s : '') + location.hash);
  } catch (e) { /* 忽略 */ }
}

const UI = {
  buyOpen: false, scoreOpen: false, screen: 'start',
  buyCat: -1,
  feed: [],
  arcs: [],
  hitT: 0, hurtT: 0,
  fps: 0, fpsAcc: 0, fpsN: 0,
  centerT: 0,
  moneyT: 0,
  radarT: 0,
  burnPending: false,
  whiteT: 0, whiteAmt: 0,
  chatOpen: false, chatTeam: false, chat: [],

  init() {
    this.el = {};
    for (const id of ['hud', 'money', 'moneyDelta', 'buyTag', 'scoreT', 'scoreCT', 'timer', 'roundNo', 'aliveT', 'aliveCT', 'bombInfo', 'killFeed',
      'crosshair', 'hitMarker', 'dmgDirs', 'centerMsg', 'hint', 'progress', 'progressLabel', 'progressFill', 'hpVal', 'hpBar', 'hpStat', 'armorVal', 'armorBar',
      'helmTag', 'invList', 'wpnName', 'ammoMag', 'ammoRes', 'spectate', 'fps', 'locName', 'radar', 'smokeFx', 'flashFx', 'flashBurn', 'hurtFx', 'lowHpFx',
      'deathFx', 'scopeFx', 'roundBanner', 'rbTitle', 'rbSub', 'rbMvp', 'buyMenu', 'buyCols', 'buyMoney', 'buyTime', 'buyMsg', 'scoreboard', 'ammoPanel',
      'netInfo', 'chatLog', 'chatInputWrap', 'chatInput', 'chatMode']) this.el[id] = $(id);
    this.radarCtx = this.el.radar.getContext('2d');
    this.buildRadarBase();
    this.buildCrosshair();
    this.buildBuyMenu();
    this.buildSettings();
    // 队友无线电消息
    this.radioBox = document.createElement('div');
    this.radioBox.style.cssText = 'position:absolute;left:18px;bottom:96px;display:flex;flex-direction:column;gap:3px;font-size:13px;';
    this.el.hud.appendChild(this.radioBox);
    this.bindMenus();
    this.bindEvents();
    this.bindLobby();
    this.bindChat();
  },

  /** 是否有界面挡住了游戏输入 */
  blocking() { return this.buyOpen || this.screen !== null || this.chatOpen; },

  // ------------------------------------------------------------------
  //  菜单
  // ------------------------------------------------------------------
  showScreen(name) {
    for (const s of ['startScreen', 'pauseScreen', 'settingsScreen', 'helpScreen', 'matchEndScreen', 'mpScreen', 'teamScreen']) $(s).classList.add('hidden');
    $('clickToPlay').classList.add('hidden');
    this.screen = name;
    if (name) $(name + 'Screen').classList.remove('hidden');
    if (name === 'matchEnd' || name === 'start') this.el.roundBanner.classList.remove('show');
    this.el.hud.classList.toggle('hidden', name === 'start' || name === 'mp' || (name === 'matchEnd' && NET.mode !== 'client') || Game.state === 'menu');
    // 联机时的暂停菜单：不能重开比赛，"返回主菜单"即离开房间
    const mp = NET.mode === 'client';
    $('btnRestart').classList.toggle('hidden', mp);
    $('btnQuit').textContent = mp ? '离开房间' : '返回主菜单';
  },
  bindMenus() {
    const click = (id, fn) => $(id).addEventListener('click', (e) => { SFX.uiSound('click'); fn(e); });
    click('btnStart', () => Game.startMatch());
    click('btnSettings', () => { this.backTo = 'start'; this.showScreen('settings'); });
    click('btnHelp', () => { this.backTo = 'start'; this.showScreen('help'); });
    click('btnResume', () => Game.resume());
    click('btnSettings2', () => { this.backTo = 'pause'; this.showScreen('settings'); });
    click('btnHelp2', () => { this.backTo = 'pause'; this.showScreen('help'); });
    click('btnRestart', () => Game.startMatch());
    click('btnQuit', () => Game.toMenu());
    click('btnSetBack', () => this.showScreen(this.backTo || 'start'));
    click('btnHelpBack', () => this.showScreen(this.backTo || 'start'));
    click('btnSetReset', () => { Object.assign(SETTINGS, DEFAULT_SETTINGS); saveSettings(); this.buildSettings(); Game.applySettings(); });
    click('btnAgain', () => { if (NET.mode === 'client') Game.resume(); else Game.startMatch(); });
    click('btnMenu', () => Game.toMenu());
    click('btnMulti', () => this.openLobby());
    click('btnTeamT', () => { NetClient.send({ t: 'team', team: 'T' }); Game.resume(); });
    click('btnTeamCT', () => { NetClient.send({ t: 'team', team: 'CT' }); Game.resume(); });
    click('btnTeamBack', () => Game.resume());
    $('clickToPlay').addEventListener('click', () => Game.resume());
    for (const b of document.querySelectorAll('button')) b.addEventListener('mouseenter', () => SFX.uiSound('hover'));
  },
  buildSettings() {
    const body = $('settingsBody');
    body.innerHTML = '';
    let grid = null;
    for (const s of SETTING_SCHEMA) {
      if (s.section) {
        const h = document.createElement('div'); h.className = 'sectionT'; h.textContent = s.section; body.appendChild(h);
        grid = document.createElement('div'); grid.className = 'setGrid'; body.appendChild(grid);
        continue;
      }
      const lab = document.createElement('label'); lab.textContent = s.label; grid.appendChild(lab);
      let input, out = document.createElement('output');
      const val = SETTINGS[s.key];
      if (s.type === 'range') {
        input = document.createElement('input'); input.type = 'range'; input.min = s.min; input.max = s.max; input.step = s.step; input.value = val;
        out.textContent = (+val).toFixed(s.step < 1 ? (s.step < 0.1 ? 2 : 1) : 0);
        input.addEventListener('input', () => { SETTINGS[s.key] = +input.value; out.textContent = (+input.value).toFixed(s.step < 1 ? (s.step < 0.1 ? 2 : 1) : 0); saveSettings(); Game.applySettings(s.key); });
      } else if (s.type === 'check') {
        input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!val; input.style.justifySelf = 'start';
        input.addEventListener('change', () => { SETTINGS[s.key] = input.checked; saveSettings(); Game.applySettings(s.key); });
      } else if (s.type === 'select') {
        input = document.createElement('select');
        for (const [v, t] of s.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (String(v) === String(val)) o.selected = true; input.appendChild(o); }
        input.addEventListener('change', () => { SETTINGS[s.key] = typeof DEFAULT_SETTINGS[s.key] === 'number' ? +input.value : input.value; saveSettings(); Game.applySettings(s.key); });
      } else if (s.type === 'color') {
        input = document.createElement('input'); input.type = 'color'; input.value = val;
        input.addEventListener('input', () => { SETTINGS[s.key] = input.value; saveSettings(); Game.applySettings(s.key); });
      }
      grid.appendChild(input);
      out.textContent = s.note && s.type !== 'range' ? '' : out.textContent;
      grid.appendChild(out);
      if (s.note) { const n = document.createElement('div'); n.className = 'full'; n.style.cssText = 'font-size:12px;color:var(--dim);margin-top:-8px'; n.textContent = s.note; grid.appendChild(document.createElement('span')); grid.appendChild(n); }
    }
  },

  // ------------------------------------------------------------------
  //  准星
  // ------------------------------------------------------------------
  buildCrosshair() {
    const c = this.el.crosshair;
    c.innerHTML = '';
    this.ch = [];
    for (let i = 0; i < 5; i++) { const e = document.createElement('i'); c.appendChild(e); this.ch.push(e); }
    this.applyCrosshairStyle();
  },
  applyCrosshairStyle() {
    for (const e of this.ch) e.style.background = SETTINGS.crossColor;
    this.ch[4].style.display = SETTINGS.crossDot ? 'block' : 'none';
    this.lastGap = -1;
  },
  updateCrosshair(gap) {
    const g = Math.round(gap);
    if (g === this.lastGap) return;
    this.lastGap = g;
    const L = SETTINGS.crossSize, T = SETTINGS.crossThick, h = T / 2;
    const [t, b, l, r, d] = this.ch;
    t.style.cssText = `background:${SETTINGS.crossColor};width:${T}px;height:${L}px;left:${-h}px;top:${-g - L}px`;
    b.style.cssText = `background:${SETTINGS.crossColor};width:${T}px;height:${L}px;left:${-h}px;top:${g}px`;
    l.style.cssText = `background:${SETTINGS.crossColor};width:${L}px;height:${T}px;left:${-g - L}px;top:${-h}px`;
    r.style.cssText = `background:${SETTINGS.crossColor};width:${L}px;height:${T}px;left:${g}px;top:${-h}px`;
    d.style.cssText = `background:${SETTINGS.crossColor};width:${T}px;height:${T}px;left:${-h}px;top:${-h}px;display:${SETTINGS.crossDot ? 'block' : 'none'}`;
  },

  // ------------------------------------------------------------------
  //  购买菜单
  // ------------------------------------------------------------------
  buildBuyMenu() {
    const cols = this.el.buyCols;
    cols.innerHTML = '';
    this.buyBtns = [];
    SHOP.forEach((cat, ci) => {
      const col = document.createElement('div'); col.className = 'bcol';
      const h = document.createElement('h3'); h.innerHTML = `<kbd>${ci + 1}</kbd>${cat.name}`; col.appendChild(h);
      col.dataset.cat = ci;
      let n = 0;
      for (const id of cat.items) {
        const b = document.createElement('button'); b.className = 'bitem'; b.dataset.id = id;
        b.dataset.n = ++n;
        b.addEventListener('click', () => this.tryBuy(id, b));
        col.appendChild(b);
        this.buyBtns.push(b);
      }
      cols.appendChild(col);
    });
  },
  refreshBuyMenu() {
    const P = Game.player;
    this.el.buyMoney.textContent = '$' + P.money;
    const t = Round.buyTimeLeft();
    this.el.buyTime.textContent = t > 0 ? `剩余购买时间 ${Math.ceil(t)} 秒` : '购买时间已结束';
    // 同类物品重新编号（隐藏阵营限定物品）
    const counters = {};
    for (const b of this.buyBtns) {
      const r = Economy.info(P, b.dataset.id);
      const col = b.parentNode.dataset.cat;
      b.classList.toggle('hidden', !!r.hidden);
      if (r.hidden) continue;
      counters[col] = (counters[col] || 0) + 1;
      b.dataset.n = counters[col];
      const key = `${b.dataset.n}`;
      const html = `<span class="nm"><kbd>${key}</kbd>${r.name}</span><span class="ds">${r.desc || ''}</span><span class="pr">$${r.price}</span>`;
      if (b._html !== html) { b.innerHTML = html; b._html = html; }
      b.classList.toggle('cant', !r.ok && !r.owned);
      b.classList.toggle('owned', r.owned);
    }
    for (const col of this.el.buyCols.children) col.style.opacity = this.buyCat < 0 || +col.dataset.cat === this.buyCat ? 1 : 0.45;
  },
  tryBuy(id, btn) {
    const P = Game.player;
    if (!Economy.canBuyNow(P)) { this.buyMessage('当前不能购买（需在出生区域且在购买时间内）'); SFX.uiSound('deny'); return; }
    const r = Economy.buy(P, id);
    if (r.ok) {
      SFX.uiSound('buy');
      this.buyMessage(`已购买 ${r.name}`);
      if (btn) { btn.classList.remove('flash'); void btn.offsetWidth; btn.classList.add('flash'); }
    } else { SFX.uiSound('deny'); this.buyMessage(r.reason); }
    this.refreshBuyMenu();
  },
  buyMessage(t) { this.el.buyMsg.textContent = t; clearTimeout(this._bmT); this._bmT = setTimeout(() => this.el.buyMsg.textContent = '', 1800); },
  openBuy() {
    const P = Game.player;
    if (!Economy.canBuyNow(P)) { this.center('当前不能购买', '需在出生区域，且在回合开始后 20 秒内', 1.5); SFX.uiSound('deny'); return; }
    this.buyOpen = true;
    this.buyCat = -1;
    this.el.buyMenu.classList.remove('hidden');
    this.refreshBuyMenu();
    Input.unlock();
  },
  closeBuy(relock) {
    if (!this.buyOpen) return;
    this.buyOpen = false;
    this.el.buyMenu.classList.add('hidden');
    if (relock) Input.lock();
    else if (!Input.locked && this.screen === null) $('clickToPlay').classList.remove('hidden');
  },
  buyKey(code) {
    const m = code.match(/^Digit(\d)$/);
    if (!m) return;
    const n = +m[1];
    if (this.buyCat < 0) { if (n >= 1 && n <= SHOP.length) this.buyCat = n - 1; }
    else {
      const col = this.el.buyCols.children[this.buyCat];
      const btn = [...col.querySelectorAll('.bitem')].find(b => !b.classList.contains('hidden') && +b.dataset.n === n);
      if (btn) this.tryBuy(btn.dataset.id, btn);
      this.buyCat = -1;
    }
    this.refreshBuyMenu();
  },

  // ------------------------------------------------------------------
  //  计分板
  // ------------------------------------------------------------------
  renderScoreboard() {
    const rows = (team) => Combat.chars.filter(c => c.team === team).sort((a, b) => b.stats.k - a.stats.k || a.stats.d - b.stats.d).map(c => {
      const s = c.stats, hs = s.k ? Math.round(s.hs / s.k * 100) : 0;
      const adr = Round.number ? Math.round(s.dmg / Math.max(1, Round.number - (Round.state === 'end' || Round.state === 'over' ? 0 : 1))) : 0;
      const money = c.team === Game.player.team ? '$' + c.money : '';
      const tag = c.isPlayer ? '' : c.isBot ? ' <span style="color:var(--dim);font-size:11px">BOT</span>' : '';
      const ping = NET.mode === 'client' && !c.isBot && c.ping >= 0 ? ` <span style="color:var(--dim);font-size:11px">${c.isPlayer ? NetClient.rtt : c.ping}ms</span>` : '';
      return `<tr class="${c.alive ? '' : 'dead'} ${c.isPlayer ? 'me' : ''}"><td>${esc(c.name)}${tag}${ping}</td>
        <td class="n">${s.k}</td><td class="n">${s.d}</td><td class="n">${s.a}</td><td class="n">${hs}%</td><td class="n">${adr}</td><td class="n">${s.mvp ? '★' + s.mvp : ''}</td><td class="n">${money}</td><td class="n">${c.alive ? c.health : '阵亡'}</td></tr>`;
    }).join('');
    const head = `<colgroup><col style="width:30%"><col><col><col><col><col><col><col style="width:13%"><col></colgroup><tr><th>玩家</th><th class="n">杀</th><th class="n">死</th><th class="n">助</th><th class="n">爆头</th><th class="n">ADR</th><th class="n">MVP</th><th class="n">金钱</th><th class="n">HP</th></tr>`;
    this.el.scoreboard.innerHTML = `
      <table><caption><span class="tt">恐怖分子 T</span> <b style="float:right">${Round.score.T}</b></caption>${head}${rows('T')}</table>
      <table><caption><span class="ctt">反恐精英 CT</span> <b style="float:right">${Round.score.CT}</b></caption>${head}${rows('CT')}</table>
      <div style="font-size:12px;color:var(--dim)">地图：沙堡 de_sandfort · 第 ${Round.number} 回合 · 先赢 ${Round.winTarget()} 回合获胜 · Bot 难度：${DIFFICULTY[NET.mode === 'client' && NetClient.opts ? NetClient.opts.difficulty : SETTINGS.difficulty].name}${NET.mode === 'client' ? ' · 房间 ' + esc(NetClient.code) : ''}</div>`;
  },

  // ------------------------------------------------------------------
  //  事件驱动的 HUD 元素
  // ------------------------------------------------------------------
  bindEvents() {
    Events.on('kill', (e) => this.addKill(e));
    Events.on('damage', (e) => {
      const P = Game.player;
      if (e.attacker === P && e.victim !== P) {
        this.hitT = 0.18;
        this.el.hitMarker.classList.toggle('head', e.group === 'head');
        SFX.hitConfirm(e.group === 'head', e.helmet);
      }
      if (e.victim === P) {
        this.hurtT = Math.min(0.8, 0.25 + e.dmg / 60);
        P.onDamaged(e);
        if (e.attacker && e.attacker !== P) this.addArc(e.attacker.pos);
      }
    });
    Events.on('kill', () => {
      // 残局提示：玩家成为本方最后一人
      const P = Game.player;
      if (!P.alive || Round.state !== 'live' || this.clutchShown === Round.number) return;
      const mine = Round.alive(P.team), enemy = Round.alive(P.team === 'T' ? 'CT' : 'T');
      if (mine === 1 && enemy >= 1 && (SETTINGS.teammates > 0 || enemy >= 2)) {
        this.clutchShown = Round.number;
        this.center(`残局 1v${enemy}`, Bomb.state === 'planted' ? '守住炸弹！' : '', 2.2, '#ffd76a');
      }
    });
    Events.on('roundStart', (e) => {
      const need = Round.winTarget() - 1;
      const mine = Game.player.team, other = mine === 'T' ? 'CT' : 'T';
      const mp = Round.score.T === need && Round.score.CT === need ? '双方赛点！' : Round.score[mine] === need ? '我方赛点！' : Round.score[other] === need ? '对方赛点！' : '';
      this.center(`第 ${e.number} 回合${mp ? ' · ' + mp : ''}`, '冻结时间 — 按 B 购买装备', 2.5, mp ? '#ffd76a' : '');
      this.clearFeed();
      this.radioBox.innerHTML = '';
      this.el.roundBanner.classList.remove('show');
    });
    Events.on('roundLive', () => this.center(Game.player.team === 'T' ? '开始进攻！' : '守住包点！', Game.player.inv.bomb ? '你携带着炸弹：到 A 或 B 包点按住 E 安放' : '', 2.2));
    Events.on('bombPlanted', (e) => this.center('炸弹已安放', `${e.site} 包点 — ${CFG.ROUND.BOMB_TIME} 秒后爆炸`, 2.5, '#ff6a5a'));
    Events.on('bombDropped', () => { if (Round.state === 'live') this.center('炸弹掉落了！', '', 1.6, '#ffb13b'); });
    Events.on('defuseStart', (ch) => {
      const P = Game.player;
      if (P.alive && P.pos.distanceTo(Bomb.pos) < 28) this.center('听到拆弹声！', ch.kit ? '对方有拆弹器（5 秒）' : '', 1.8, '#69a7ff');
    });
    Events.on('roundEnd', (e) => this.showBanner(e));
    Events.on('radio', (e) => this.addRadio(e));
    Events.on('flashed', (e) => {
      if (e.ch === Game.player) { this.burnPending = true; SFX.flashRing(e.dur, e.amt); }
    });
    Events.on('matchOver', (e) => Game.onMatchOver(e));
  },

  center(title, sub = '', dur = 2, color = '') {
    this.el.centerMsg.innerHTML = `<span style="color:${color || 'inherit'}">${title}</span>${sub ? `<small>${sub}</small>` : ''}`;
    this.el.centerMsg.style.opacity = 1;
    // 回合横幅显示时，提示移到横幅下方
    this.el.centerMsg.style.top = this.el.roundBanner.classList.contains('show') ? '38%' : '22%';
    this.centerT = dur;
  },
  moneyDelta(d) {
    const e = this.el.moneyDelta;
    e.textContent = (d > 0 ? '+$' : '-$') + Math.abs(d);
    e.style.color = d > 0 ? '#9fe39a' : '#ff6a5a';
    e.style.opacity = 1;
    this.moneyT = 2.2;
  },
  whiteFlash(a) { this.whiteAmt = a; this.whiteT = 1.2; },

  addKill(e) {
    const P = Game.player;
    const killer = e.killer, victim = e.victim;
    const w = e.weaponId === 'bomb' ? 'C4' : WEAPONS[e.weaponId] ? WEAPONS[e.weaponId].name : NADES[e.weaponId] ? NADES[e.weaponId].name : e.weaponId;
    const div = document.createElement('div');
    div.className = 'kf' + (killer === P || victim === P ? ' me' : '');
    const hs = e.headshot ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="10" r="6" fill="none" stroke="#ff5a4f" stroke-width="2.5"/><path d="M12 2v5M12 13v5M4 10h5M15 10h5" stroke="#ff5a4f" stroke-width="2"/></svg>' : '';
    const pen = e.penetrated ? '<span style="color:#ffd76a;font-size:11px">穿透</span>' : '';
    const kname = killer && killer !== victim ? `<span class="${killer.team}">${esc(killer.name)}</span>` : '';
    div.innerHTML = `${kname}<span class="wpn">${w}</span>${pen}${hs}<span class="${victim.team}">${esc(victim.name)}</span>`;
    this.el.killFeed.appendChild(div);
    this.feed.push({ div, t: 7 });
    if (killer && killer.team === P.team) victim.deathSeen = true;   // 雷达上标记被我方击杀的敌人
    while (this.feed.length > 6) { const f = this.feed.shift(); f.div.remove(); }
    if (killer === P && victim !== P) SFX.killConfirm(e.headshot);
    if (victim === P) {
      P.onDeath(killer);
      const by = killer && killer !== P ? `${esc(killer.name)} 用 ${w}${e.headshot ? '（爆头）' : ''} 击杀了你` : '你阵亡了';
      this.center(by, '', 3, '#ff6a5a');
    }
  },
  clearFeed() { for (const f of this.feed) f.div.remove(); this.feed.length = 0; },
  addArc(from) {
    const div = document.createElement('div');
    div.className = 'dmgArc';
    this.el.dmgDirs.appendChild(div);
    this.arcs.push({ div, from: from.clone(), t: 1.1 });
    while (this.arcs.length > 5) this.arcs.shift().div.remove();
  },
  addRadio(e) {
    if (!e.from || e.from.team !== Game.player.team) return;
    const d = document.createElement('div');
    d.style.cssText = 'padding:3px 9px;background:rgba(0,0,0,.45);border-left:3px solid var(--t);transition:opacity .6s';
    d.innerHTML = `<b style="color:${e.from.team === 'CT' ? 'var(--ct)' : 'var(--t)'}">${esc(e.from.name)}</b>：${esc(e.text)}`;
    this.radioBox.appendChild(d);
    while (this.radioBox.children.length > 4) this.radioBox.firstChild.remove();
    setTimeout(() => { d.style.opacity = 0; setTimeout(() => d.remove(), 700); }, 5000);
  },
  showBanner(e) {
    const P = Game.player;
    this.centerT = 0; this.el.centerMsg.style.opacity = 0;   // 避免与中央提示重叠
    const title = this.el.rbTitle;
    title.textContent = WIN_TEXT[e.winner];
    title.className = 'title ' + e.winner;
    this.el.rbSub.textContent = REASON_TEXT[e.reason] + `  ·  T ${Round.score.T} : ${Round.score.CT} CT`;
    this.el.rbMvp.textContent = e.mvp ? `★ 本回合 MVP：${e.mvp.name}（${e.mvp.stats.rk} 杀）` : '';
    this.el.roundBanner.classList.add('show');
    SFX.uiSound(e.winner === P.team ? 'win' : 'lose');
    clearTimeout(this._bnT);
    this._bnT = setTimeout(() => this.el.roundBanner.classList.remove('show'), (CFG.ROUND.END_DELAY - 0.4) * 1000);
  },

  // ------------------------------------------------------------------
  //  每帧更新
  // ------------------------------------------------------------------
  update(dt, cam) {
    const P = Game.player;
    const E = this.el;
    // FPS
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) {
      this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0;
      E.fps.textContent = SETTINGS.showFps ? this.fps + ' FPS' + (Game.resScale < 0.99 ? ` · 渲染 ${Math.round(Game.resScale * 100)}%` : '') : '';
    }
    if (Game.state !== 'playing') return;
    // 血量护甲
    const hp = Math.max(0, P.health);
    this.setText(E.hpVal, hp);
    E.hpBar.style.width = hp + '%';
    E.hpStat.classList.toggle('low', hp <= 25);
    this.setText(E.armorVal, P.armor);
    E.armorBar.style.width = P.armor + '%';
    this.setText(E.helmTag, P.helmet ? '头盔' : '');
    // 金钱
    this.setText(E.money, '$' + P.money);
    E.buyTag.classList.toggle('hidden', !Economy.canBuyNow(P));
    if (this.moneyT > 0) { this.moneyT -= dt; if (this.moneyT < 0.6) E.moneyDelta.style.opacity = Math.max(0, this.moneyT / 0.6); }
    // 时间与比分
    const t = Round.displayTime();
    this.setText(E.timer, Round.state === 'freeze' ? '0:0' + Math.ceil(t) : fmtTime(t));
    E.timer.classList.toggle('bomb', Round.state === 'live' && Bomb.state === 'planted');
    this.setText(E.scoreT, Round.score.T); this.setText(E.scoreCT, Round.score.CT);
    this.setText(E.roundNo, `第 ${Round.number} 回合`);
    this.renderAlive('T', E.aliveT); this.renderAlive('CT', E.aliveCT);
    // 炸弹状态
    let bi = '';
    if (Bomb.state === 'planted' && Round.state !== 'end') bi = `炸弹已安放在 ${Bomb.site} 包点`;
    else if (P.inv.bomb) bi = '';
    this.setText(E.bombInfo, bi);
    // 武器与背包
    this.renderWeapon(P);
    // 提示与进度条
    E.hint.innerHTML = P.alive ? P.hint : '';
    if (P.alive && P.planting && Bomb.planting === P) {
      E.progress.classList.remove('hidden', 'defuse');
      this.setText(E.progressLabel, '正在安放炸弹…');
      E.progressFill.style.width = (Bomb.plantT / CFG.ROUND.PLANT_TIME * 100).toFixed(1) + '%';
    } else if (P.alive && Bomb.defuser === P) {
      E.progress.classList.remove('hidden'); E.progress.classList.add('defuse');
      this.setText(E.progressLabel, '正在拆除炸弹…');
      E.progressFill.style.width = (Bomb.defuseT / Bomb.defuseDur * 100).toFixed(1) + '%';
    } else if (!P.alive && P.specTarget && Bomb.defuser === P.specTarget) {
      E.progress.classList.remove('hidden'); E.progress.classList.add('defuse');
      this.setText(E.progressLabel, `${P.specTarget.name} 正在拆除炸弹…`);
      E.progressFill.style.width = (Bomb.defuseT / Bomb.defuseDur * 100).toFixed(1) + '%';
    } else E.progress.classList.add('hidden');
    // 联机信息
    if (NET.mode === 'client') {
      const nh = Combat.chars.filter(c => !c.isBot).length;
      this.setText(E.netInfo, `房间 ${NetClient.code} · ${NetClient.rtt}ms · ${nh} 名玩家 · Y 聊天 · M 换队`);
      const now = performance.now();
      for (const c of this.chat) if (!c.faded && now - c.t > 10000 && !this.chatOpen) { c.faded = true; c.el.style.opacity = 0; }
    }
    // 中央消息淡出
    if (this.centerT > 0) { this.centerT -= dt; if (this.centerT < 0.5) E.centerMsg.style.opacity = Math.max(0, this.centerT / 0.5); }
    // 击杀提示淡出
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const f = this.feed[i];
      f.t -= dt;
      if (f.t < 0.6) f.div.style.opacity = Math.max(0, f.t / 0.6);
      if (f.t <= 0) { f.div.remove(); this.feed.splice(i, 1); }
    }
    // 命中标记
    if (this.hitT > 0) { this.hitT -= dt; E.hitMarker.style.opacity = clamp(this.hitT / 0.12, 0, 1); } else E.hitMarker.style.opacity = 0;
    // 受击方向指示
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i];
      a.t -= dt;
      const ang = yawOf(a.from.x - P.pos.x, a.from.z - P.pos.z) - P.yaw;
      a.div.style.transform = `rotate(${-ang}rad)`;
      a.div.style.opacity = clamp(a.t, 0, 1);
      if (a.t <= 0) { a.div.remove(); this.arcs.splice(i, 1); }
    }
    // 全屏效果
    if (this.hurtT > 0) this.hurtT -= dt;
    E.hurtFx.style.opacity = Math.max(0, this.hurtT);
    E.lowHpFx.style.opacity = P.alive && hp <= 30 ? (0.45 + Math.sin(Clock.time * 5) * 0.2) * (1 - hp / 40) + 0.2 : 0;
    E.deathFx.style.opacity = P.alive ? 0 : 1;
    // 闪光致盲
    let flash = 0;
    if (P.alive && Clock.time < P.flashUntil) {
      const left = P.flashUntil - Clock.time, dur = P.flashDur;
      const elapsed = dur - left;
      flash = elapsed < dur * 0.55 ? P.flashAmt : P.flashAmt * (left / (dur * 0.45));
      flash = clamp(flash * 1.05, 0, 1);
    }
    if (this.whiteT > 0) { this.whiteT -= dt; flash = Math.max(flash, this.whiteAmt * clamp(this.whiteT / 1.2, 0, 1)); }
    E.flashFx.style.opacity = flash;
    E.flashBurn.style.opacity = flash > 0.05 ? Math.min(0.8, flash * 0.85) : 0;
    // 烟雾内部：屏幕灰化
    E.smokeFx.style.opacity = clamp(FX.smokeDepthAt(cam.position) * 1.3, 0, 1).toFixed(3);
    // 狙击镜
    const w = P.curWeapon();
    const scoped = P.alive && P.scope > 0 && w && w.def.kind === 'sniper';
    E.scopeFx.style.display = scoped ? 'block' : 'none';
    // 准星（狙击枪不开镜时没有准星，与 CS 一致）
    const showCross = P.alive && !scoped && !(w && w.def.kind === 'sniper') && P.slot !== 'bomb';
    E.crosshair.style.display = showCross ? 'block' : 'none';
    if (showCross) {
      let gap = SETTINGS.crossGap;
      if (SETTINGS.crossDynamic && w && w.def.spread) {
        const inacc = P.inaccuracy() * DEG;
        const px = Math.tan(inacc) / Math.tan(cam.fov * DEG / 2) * (innerHeight / 2);
        gap += Math.min(90, px * 0.75);
      }
      this.updateCrosshair(gap);
    }
    // 观战提示
    if (!P.alive && P.specTarget && P.specTarget.alive) this.setText(E.spectate, `观战：${P.specTarget.name}（${P.specTarget.health} HP）  ·  鼠标左/右键切换`);
    else if (!P.alive) this.setText(E.spectate, '你已阵亡 — 等待下一回合');
    else this.setText(E.spectate, '');
    // 位置名
    const area = MAP.areaAt(P.pos.x, P.pos.z);
    this.setText(E.locName, area ? area.name : '');
    // 雷达（30Hz）
    this.radarT -= dt;
    if (this.radarT <= 0) { this.radarT = 1 / 30; this.drawRadar(P); }
    if (this.buyOpen) {
      if (!Economy.canBuyNow(P)) this.closeBuy(true);
      else if ((this._bmR = (this._bmR || 0) - dt) <= 0) { this._bmR = 0.25; this.refreshBuyMenu(); }
    }
    if (this.scoreOpen) { if ((this._sbR = (this._sbR || 0) - dt) <= 0) { this._sbR = 0.3; this.renderScoreboard(); } }
  },
  setText(el, v) { v = String(v); if (el._v !== v) { el._v = v; el.textContent = v; } },
  renderAlive(team, el) {
    const list = Combat.chars.filter(c => c.team === team);
    const key = list.map(c => c.alive ? 1 : 0).join('');
    if (el._k === key) return;
    el._k = key;
    el.innerHTML = list.map(c => `<i class="${c.alive ? '' : 'dead'}"></i>`).join('');
  },
  renderWeapon(P) {
    const E = this.el;
    const w = P.curWeapon();
    if (w && w.def.mag) {
      E.ammoPanel.style.visibility = 'visible';
      this.setText(E.ammoMag, w.mag);
      this.setText(E.ammoRes, '/ ' + w.reserve);
      E.ammoMag.classList.toggle('low', w.mag <= Math.ceil(w.def.mag * 0.2));
      this.setText(E.wpnName, (P.reloading ? '换弹中… ' : '') + w.def.name);
    } else if (P.slot === 'nade') {
      E.ammoPanel.style.visibility = 'visible';
      this.setText(E.ammoMag, P.inv[P.nadeType]);
      this.setText(E.ammoRes, '');
      E.ammoMag.classList.remove('low');
      this.setText(E.wpnName, NADES[P.nadeType].name);
    } else {
      E.ammoPanel.style.visibility = P.alive && P.slot ? 'visible' : 'hidden';
      this.setText(E.ammoMag, P.slot === 'bomb' ? 'C4' : '');
      this.setText(E.ammoRes, ''); this.setText(E.wpnName, P.slot === 'knife' ? '匕首' : '');
      E.ammoMag.classList.remove('low');
    }
    const items = [];
    if (P.inv.primary) items.push(['1', P.inv.primary.def.name, P.slot === 'primary']);
    if (P.inv.secondary) items.push(['2', P.inv.secondary.def.name, P.slot === 'secondary']);
    items.push(['3', '匕首', P.slot === 'knife']);
    const nades = NADE_ORDER.filter(t => P.inv[t] > 0).map(t => NADES[t].name + (P.inv[t] > 1 ? ' ×' + P.inv[t] : '')).join(' · ');
    if (nades) items.push(['4', nades, P.slot === 'nade']);
    if (P.inv.bomb) items.push(['5', 'C4 炸弹', P.slot === 'bomb']);
    const key = items.map(i => i.join(',')).join('|') + P.alive;
    if (E.invList._k !== key) {
      E.invList._k = key;
      E.invList.innerHTML = P.alive ? items.map(i => `<div class="inv${i[2] ? ' on' : ''}"><kbd>${i[0]}</kbd>${i[1]}</div>`).join('') : '';
    }
  },

  // ------------------------------------------------------------------
  //  雷达
  // ------------------------------------------------------------------
  buildRadarBase() {
    const S = 10; // 每格像素
    const c = document.createElement('canvas');
    c.width = MAP.W * S; c.height = MAP.H * S;
    const ctx = c.getContext('2d');
    for (let r = 0; r < MAP.H; r++) for (let col = 0; col < MAP.W; col++) {
      const ch = MAP.at(col, r);
      let color = null;
      if (ch === '#') color = null;
      else if (ch === 'A' || ch === ':') color = '#8c8676';
      else if (MAP.isStair(ch)) color = '#7b7566';
      else if (ch === 't') color = '#55524a';
      else color = '#6b665a';
      if (color) { ctx.fillStyle = color; ctx.fillRect(col * S, r * S, S, S); }
    }
    // 墙边描线
    ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1.5;
    for (let r = 0; r < MAP.H; r++) for (let col = 0; col < MAP.W; col++) {
      if (MAP.isWall(col, r)) continue;
      const x = col * S, y = r * S;
      if (MAP.isWall(col, r - 1)) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + S, y); ctx.stroke(); }
      if (MAP.isWall(col, r + 1)) { ctx.beginPath(); ctx.moveTo(x, y + S); ctx.lineTo(x + S, y + S); ctx.stroke(); }
      if (MAP.isWall(col - 1, r)) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + S); ctx.stroke(); }
      if (MAP.isWall(col + 1, r)) { ctx.beginPath(); ctx.moveTo(x + S, y); ctx.lineTo(x + S, y + S); ctx.stroke(); }
    }
    // 包点
    for (const k in MAP.BOMBSITES) {
      const s = MAP.BOMBSITES[k];
      ctx.fillStyle = 'rgba(210,60,40,.22)';
      ctx.fillRect(s.rect[0] * S, s.rect[1] * S, (s.rect[2] - s.rect[0]) * S, (s.rect[3] - s.rect[1]) * S);
      ctx.fillStyle = 'rgba(255,120,90,.9)';
      ctx.font = `900 ${S * 3.2}px "Arial Black", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(k, s.center[0] * S, s.center[1] * S);
    }
    this.radarBase = c;
    this.radarScale = S / MAP.C; // 像素/米
  },
  drawRadar(P) {
    const ctx = this.radarCtx, R = 210, W = 420;
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath(); ctx.arc(R, R, R - 2, 0, TAU); ctx.clip();
    ctx.fillStyle = 'rgba(12,14,16,.7)'; ctx.fillRect(0, 0, W, W);
    const zoom = 1.25;                 // 雷达显示倍率
    const ppm = this.radarScale * zoom;
    const cx = P.pos.x, cz = P.pos.z;
    ctx.translate(R, R);
    ctx.rotate(P.yaw);
    ctx.scale(zoom, zoom);
    // 地图图像以世界坐标为基准绘制
    const ox = MAP.wx(0) * this.radarScale, oz = MAP.wz(0) * this.radarScale;
    ctx.drawImage(this.radarBase, ox - cx * this.radarScale, oz - cz * this.radarScale);
    ctx.restore();
    // 动态元素（在旋转坐标系中计算屏幕位置）
    const toScreen = (x, z) => {
      const dx = (x - cx) * ppm, dz = (z - cz) * ppm;
      const c = Math.cos(P.yaw), s = Math.sin(P.yaw);
      return [R + dx * c - dz * s, R + dx * s + dz * c];
    };
    ctx.save();
    ctx.beginPath(); ctx.arc(R, R, R - 2, 0, TAU); ctx.clip();
    for (const sm of FX.smokes) {
      const [x, y] = toScreen(sm.x, sm.z);
      ctx.fillStyle = `rgba(200,200,200,${0.45 * sm.density})`;
      ctx.beginPath(); ctx.arc(x, y, sm.radius * ppm, 0, TAU); ctx.fill();
    }
    const bi = Items.bombItem();
    const bombPos = Bomb.state === 'planted' ? Bomb.pos : bi ? bi.pos : null;
    if (bombPos && (P.team === 'T' || Bomb.state === 'planted')) {
      const [x, y] = toScreen(bombPos.x, bombPos.z);
      const on = Bomb.state !== 'planted' || (Clock.time % 0.6) < 0.35;
      ctx.fillStyle = on ? '#ff5a3a' : '#7a2a1a';
      ctx.fillRect(x - 7, y - 5, 14, 10);
      ctx.fillStyle = '#111'; ctx.fillRect(x - 3, y - 2, 6, 4);
    }
    for (const c of Combat.chars) {
      if (c === P) continue;
      const friend = c.team === P.team;
      if (!friend && (!c.alive || Clock.time - (c.spottedAt || -99) > 0.4)) {
        // 刚被发现的敌人显示，阵亡的敌人显示一个 ×
        if (!c.alive && c.deathSeen) { const [x, y] = toScreen(c.pos.x, c.pos.z); ctx.strokeStyle = 'rgba(255,90,70,.6)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6); ctx.stroke(); }
        continue;
      }
      const [x, y] = toScreen(c.pos.x, c.pos.z);
      if (!c.alive) { ctx.strokeStyle = 'rgba(233,179,71,.6)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x - 6, y + 6); ctx.stroke(); continue; }
      ctx.fillStyle = friend ? '#e9b347' : '#ff4d3d';
      ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 2; ctx.stroke();
    }
    // 自己
    ctx.translate(R, R);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(0, -13); ctx.lineTo(9, 10); ctx.lineTo(0, 5); ctx.lineTo(-9, 10); ctx.closePath(); ctx.fill();
    ctx.restore();
    // 北方标记
    const [nx, ny] = [R + Math.sin(P.yaw) * (R - 16), R - Math.cos(P.yaw) * (R - 16)];
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = '600 20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny);
  },

  // ------------------------------------------------------------------
  //  多人大厅
  // ------------------------------------------------------------------
  bindLobby() {
    const name = $('mpName');
    name.value = SETTINGS.mpName || '';
    name.addEventListener('change', () => { SETTINGS.mpName = name.value.trim().slice(0, 16); saveSettings(); NetClient.hello(); });
    const need = () => {
      SETTINGS.mpName = name.value.trim().slice(0, 16);
      saveSettings();
      if (!SETTINGS.mpName) { this.lobbyStatus('请先输入昵称', 'bad'); name.focus(); return false; }
      if (NetClient.status !== 'open') { this.lobbyStatus('尚未连接到服务器', 'bad'); NetClient.connect(); return false; }
      SFX.init();
      return true;
    };
    $('btnMpJoin').addEventListener('click', () => {
      const code = $('mpCode').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) { this.lobbyStatus('请输入 4 位房间号', 'bad'); return; }
      if (need()) { this.netNote = ''; NetClient.hello(); NetClient.joinRoom(code, $('mpTeam').value); this.lobbyStatus('正在加入房间 ' + code + '…'); }
    });
    $('btnMpCreate').addEventListener('click', () => {
      if (!need()) return;
      this.netNote = '';
      NetClient.hello();
      NetClient.createRoom({ winRounds: +$('mpRounds').value, difficulty: $('mpDiff').value, bots: $('mpBots').value === '1' }, $('mpTeam').value);
      this.lobbyStatus('正在创建房间…');
    });
    $('btnMpBack').addEventListener('click', () => { SFX.uiSound('click'); this.netNote = ''; this.showScreen('start'); });
    $('mpCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnMpJoin').click(); });
    NetClient.onLobby = (type, data) => {
      if (type === 'status') {
        const st = NetClient.status, note = this.netNote ? this.netNote + ' · ' : '';
        if (st === 'open') this.lobbyStatus(note + (note ? '已重新连接服务器' : '已连接服务器'), note ? 'bad' : 'ok');
        else if (st === 'connecting') this.lobbyStatus(note + '正在连接服务器…', note ? 'bad' : '');
        else if (st === 'closed') this.lobbyStatus(note + '无法连接服务器（请检查网络后点"多人对战"重试）', 'bad');
      } else if (type === 'rooms') this.renderRooms();
      else if (type === 'error') this.lobbyStatus(data, 'bad');
    };
    // 邀请链接：?room=ABCD 直接打开大厅并填入房间号
    const m = location.search.match(/[?&]room=([A-Za-z0-9]{4})/);
    if (m) { $('mpCode').value = m[1].toUpperCase(); this.inviteCode = m[1].toUpperCase(); }
  },
  openLobby() {
    this.showScreen('mp');
    NetClient.connect();
    if (NetClient.status === 'open') { this.lobbyStatus('已连接服务器', 'ok'); NetClient.listRooms(); }
    clearInterval(this._lobbyT);
    this._lobbyT = setInterval(() => {
      if (this.screen !== 'mp') { clearInterval(this._lobbyT); return; }
      NetClient.listRooms();
    }, 3000);
  },
  lobbyStatus(text, cls = '') { const e = $('mpStatus'); e.textContent = text; e.className = cls; },
  renderRooms() {
    const box = $('mpRooms');
    const rooms = NetClient.rooms || [];
    if (!rooms.length) { box.innerHTML = '<div class="mpEmpty">暂无房间，创建一个吧</div>'; return; }
    box.innerHTML = rooms.map(r => {
      const i = r.info || {};
      const st = i.state === 'live' || i.state === 'freeze' ? `第 ${i.round} 回合 · ${i.score ? i.score.join(' : ') : '0 : 0'}` : i.state === 'end' ? '回合结束' : '等待中';
      return `<div class="mpRoom"><div class="nm"><b>${esc(r.code)}</b>${esc(r.name)}<div class="meta">${r.humans}/${r.max} 人 · ${st} · 先赢 ${r.opts ? r.opts.winRounds : 8} 回合 · Bot ${DIFFICULTY[r.opts && r.opts.difficulty] ? DIFFICULTY[r.opts.difficulty].name : ''}</div></div>
        <button data-code="${esc(r.code)}" ${r.humans >= r.max ? 'disabled' : ''}>加入</button></div>`;
    }).join('');
    for (const b of box.querySelectorAll('button[data-code]')) {
      b.addEventListener('click', () => { $('mpCode').value = b.dataset.code; $('btnMpJoin').click(); });
    }
  },
  /** 进入房间后 */
  onNetEnter() {
    this.el.netInfo.classList.remove('hidden');
    this.clearFeed();
    this.chat.forEach(c => c.el.remove()); this.chat.length = 0;
    setRoomParam(NetClient.code);
    this.center(`已加入房间 ${NetClient.code}`, `把链接发给朋友即可邀请 · Y 聊天 · M 换队`, 3.5, '#ffd76a');
  },
  onNetLeave() {
    this.el.netInfo.classList.add('hidden');
    this.closeChat(false);
    this.chat.forEach(c => c.el.remove()); this.chat.length = 0;
    setRoomParam(null);
  },
  onBuyResult(m) {
    if (m.ok) { SFX.uiSound('buy'); this.buyMessage(`已购买 ${m.name || ''}`); }
    else { SFX.uiSound('deny'); this.buyMessage(m.reason || '购买失败'); }
    if (this.buyOpen) setTimeout(() => this.refreshBuyMenu(), 50);
  },
  showNetMatchOver(m) {
    const P = Game.player, s = P.stats;
    const win = m.w === P.team;
    $('meTitle').textContent = win ? '胜利' : '失败';
    $('meTitle').className = 'bigResult ' + (win ? 'win' : 'lose');
    $('meScore').textContent = `T ${m.s[0]} : ${m.s[1]} CT · 房间 ${NetClient.code} · 15 秒后开始下一场`;
    const hs = s.k ? Math.round(s.hs / s.k * 100) : 0;
    const rows = [['击杀 / 死亡 / 助攻', `${s.k} / ${s.d} / ${s.a}`], ['K/D', (s.k / Math.max(1, s.d)).toFixed(2)], ['爆头率', hs + '%'],
      ['场均伤害 ADR', Math.round(s.dmg / Math.max(1, Round.number))], ['MVP', s.mvp]];
    $('meStats').innerHTML = rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
    $('btnAgain').textContent = '继续（留在房间）';
    $('btnMenu').textContent = '离开房间';
    Input.unlock();
    this.showScreen('matchEnd');
  },

  // ------------------------------------------------------------------
  //  聊天
  // ------------------------------------------------------------------
  bindChat() {
    const inp = this.el.chatInput;
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.closeChat(true); }
      else if (e.key === 'Escape') { e.preventDefault(); this.closeChat(false); }
    });
    inp.addEventListener('keyup', (e) => e.stopPropagation());
  },
  openChat(team) {
    if (NET.mode !== 'client' || this.chatOpen) return;
    this.chatOpen = true;
    this.chatTeam = team;
    this.el.chatMode.textContent = team ? '队伍' : '全体';
    this.el.chatInputWrap.classList.remove('hidden');
    for (const c of this.chat) { c.el.style.opacity = 1; c.faded = false; c.t = performance.now(); }
    Input.keys.clear();
    setTimeout(() => this.el.chatInput.focus(), 0);
  },
  closeChat(sendIt) {
    if (!this.chatOpen) return;
    const text = this.el.chatInput.value.trim();
    if (sendIt && text) NetClient.send({ t: 'chat', text, team: this.chatTeam ? 1 : 0 });
    this.el.chatInput.value = '';
    this.el.chatInput.blur();
    this.el.chatInputWrap.classList.add('hidden');
    this.chatOpen = false;
    Input.keys.clear();
  },
  addChat(m) {
    const d = document.createElement('div');
    d.className = 'chatLine';
    if (m.sys) d.innerHTML = `<span class="sys">${esc(m.text)}</span>`;
    else d.innerHTML = `<span class="who ${m.tm === 'CT' ? 'CT' : 'T'}">${m.team ? '[队伍] ' : ''}${esc(m.n)}</span>${esc(m.text)}`;
    this.el.chatLog.appendChild(d);
    this.chat.push({ el: d, t: performance.now(), faded: false });
    while (this.chat.length > 8) this.chat.shift().el.remove();
    if (!m.sys) SFX.uiSound('hover');
  },

  /** 闪光弹"烧屏"残影：抓取当前画面 */
  captureBurn(renderer) {
    if (!this.burnPending) return;
    this.burnPending = false;
    const c = this.el.flashBurn;
    c.width = Math.floor(innerWidth / 4); c.height = Math.floor(innerHeight / 4);
    const ctx = c.getContext('2d');
    ctx.filter = 'grayscale(1) brightness(1.6) blur(2px)';
    ctx.drawImage(renderer.domElement, 0, 0, c.width, c.height);
  },
};
