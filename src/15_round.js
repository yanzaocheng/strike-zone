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
