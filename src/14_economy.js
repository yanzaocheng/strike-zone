// =====================================================================
//  14 经济模块（参考 CS:GO 规则）
//  - 击杀奖励按武器（匕首 $1500 / 冲锋枪 $600 / 步枪·手枪 $300 / L-96 $100）
//  - 回合胜利 $3250（全灭/超时）或 $3500（爆炸/拆除）
//  - 连败补偿 $1400 → $3400；T 方输掉但下了包额外 +$800
//  - 超时输掉回合时存活的 T 没有收入
//  - Bot 按团队平均资金决定全买 / 强起 / 保存
// =====================================================================

// 购买菜单：5 列
const SHOP = [
  { name: '手枪', items: ['g18', 'p2k', 'd50'] },
  { name: '冲锋枪', items: ['v45'] },
  { name: '步枪', items: ['g35', 'k47', 'm4'] },
  { name: '狙击枪', items: ['s08', 'l96'] },
  { name: '装备', items: ['vest', 'vesthelm', 'kit', 'he', 'flash', 'smoke'] },
];
const EQUIP = {
  vest: { name: '防弹衣', price: 650, desc: '躯干伤害减免' },
  vesthelm: { name: '防弹衣 + 头盔', price: 1000, desc: '头盔可减免爆头伤害' },
  kit: { name: '拆弹器', price: 400, side: 'CT', desc: '拆弹时间减半' },
};

const Economy = {
  streak: { T: 0, CT: 0 },
  decision: { T: 'full', CT: 'full' },

  reset() { this.streak = { T: 0, CT: 0 }; },
  give(ch, amount) {
    if (!amount) return;
    const before = ch.money;
    ch.money = clamp(ch.money + amount, 0, CFG.ECON.MAX);
    if (ch.isPlayer && ch.money !== before) UI.moneyDelta(ch.money - before);
  },

  /** 物品信息：名称/价格/是否可买/原因 */
  info(ch, id) {
    const w = WEAPONS[id], n = NADES[id], e = EQUIP[id];
    const side = (w && w.side) || (e && e.side);
    const r = { id, name: w ? w.full || w.name : n ? n.name : e.name, price: w ? w.price : n ? n.price : e.price, desc: w ? w.desc : e ? e.desc : '', ok: true, owned: false, reason: '' };
    if (side && side !== ch.team) { r.ok = false; r.reason = side === 'CT' ? '仅限 CT' : '仅限 T'; r.hidden = true; }
    if (w) {
      const cur = ch.inv[w.slot];
      if (cur && cur.def.id === id) { r.owned = true; r.ok = false; r.reason = '已拥有'; }
    } else if (n) {
      if (ch.inv[id] >= n.max) { r.owned = true; r.ok = false; r.reason = '已达上限'; }
      else if (ch.nadeCount() >= 4) { r.ok = false; r.reason = '投掷物已满'; }
    } else if (id === 'vest') {
      if (ch.armor >= 100) { r.owned = true; r.ok = false; r.reason = '已拥有'; }
    } else if (id === 'vesthelm') {
      if (ch.armor >= 100 && ch.helmet) { r.owned = true; r.ok = false; r.reason = '已拥有'; }
      else if (ch.armor >= 100) { r.price = 350; r.desc = '只需补买头盔'; }
    } else if (id === 'kit') {
      if (ch.kit) { r.owned = true; r.ok = false; r.reason = '已拥有'; }
    }
    if (r.ok && ch.money < r.price) { r.ok = false; r.reason = '资金不足'; }
    return r;
  },

  canBuyNow(ch) {
    if (!ch.alive) return false;
    if (!Round.buyTimeLeft()) return false;
    const z = MAP.BUYZONE[ch.team];
    return MAP.inRect(ch.pos.x, ch.pos.z, z);
  },

  buy(ch, id) {
    const r = this.info(ch, id);
    // 联机：购买由服务器校验执行，结果通过背包同步回来
    if (NET.mode === 'client' && ch.isPlayer) { if (r.ok) NetClient.send({ t: 'buy', id }); return r; }
    if (!r.ok) return r;
    ch.money -= r.price;
    const w = WEAPONS[id];
    if (w) {
      const old = ch.inv[w.slot];
      if (old && old.def.price > 0 && ch.isHuman) {
        const it = Items.drop('weapon', old, ch.pos.x, ch.pos.y + 1, ch.pos.z, rand(-0.6, 0.6), rand(-0.6, 0.6));
        it.dropper = ch;
      }
      ch.inv[w.slot] = newWeapon(id);
      if (ch.isHuman || w.slot === 'primary' || !ch.inv.primary) { ch.slot = ''; ch.switchTo(w.slot); }
      ch.boughtSlot = w.slot;
    } else if (NADES[id]) {
      ch.inv[id]++;
    } else if (id === 'vest') {
      ch.armor = 100;
    } else if (id === 'vesthelm') {
      ch.armor = 100; ch.helmet = true;
    } else if (id === 'kit') {
      ch.kit = true;
    }
    return r;
  },

  // ---------------- 回合结算 ----------------
  roundEnd(winner, reason) {
    const E = CFG.ECON;
    const loser = winner === 'T' ? 'CT' : 'T';
    const winAmt = reason === 'bomb' ? E.WIN_BOMB : reason === 'defuse' ? E.WIN_DEFUSE : reason === 'time' ? E.WIN_TIME : E.WIN_ELIM;
    this.streak[winner] = 0;
    this.streak[loser] = Math.min(this.streak[loser] + 1, E.LOSS.length);
    const lossAmt = E.LOSS[this.streak[loser] - 1];
    const planted = Bomb.state === 'planted' || Bomb.state === 'exploded' || Bomb.state === 'defused';
    for (const ch of Combat.chars) {
      if (ch.team === winner) this.give(ch, winAmt);
      else {
        if (reason === 'time' && ch.team === 'T' && ch.alive) continue;   // 超时存活的 T 无收入
        this.give(ch, lossAmt + (ch.team === 'T' && planted ? E.PLANT_TEAM_BONUS : 0));
      }
    }
  },

  // ---------------- Bot 购买 ----------------
  decide(team, pistolRound) {
    const members = Combat.chars.filter(c => c.team === team);
    const avg = members.reduce((s, c) => s + c.money, 0) / Math.max(1, members.length);
    if (pistolRound) return 'pistol';
    if (avg >= 3700) return 'full';
    if (this.streak[team] >= 3 && avg >= 2300) return 'force';
    if (avg < 2500) return 'eco';
    return 'force';
  },
  botBuy(b, decision) {
    const B = (id) => this.buy(b, id).ok;
    const m = () => b.money;
    const T = b.team === 'T';
    if (decision === 'pistol') {
      if (!T && chance(0.35)) { B('vest'); if (m() >= 400) B('kit'); }
      else if (chance(0.5)) B('vest');
      else if (m() >= 700) B('d50');
      if (m() >= 200) B('flash');
      return;
    }
    if (b.inv.primary) {
      // 保留了武器：补护甲与道具
      if (m() >= 1000) B('vesthelm'); else if (m() >= 650) B('vest');
      this.botNades(b, 600);
      if (!T && m() >= 400) B('kit');
      return;
    }
    if (decision === 'eco') {
      if (m() >= 1200 && chance(0.35)) B('d50');
      if (m() >= 2000 && chance(0.5)) B('vest');
      return;
    }
    // 全买 / 强起
    const rifle = T ? 'k47' : 'm4';
    const rp = WEAPONS[rifle].price;
    if (m() >= 4750 + 1000 && chance(decision === 'full' ? 0.18 : 0.08)) B('l96');
    else if (m() >= rp + 650) B(rifle);
    else if (T && m() >= 1800 + 650) B('g35');
    else if (m() >= 1700 + 650 && chance(0.25)) B('s08');
    else if (m() >= 1200 + 650) B('v45');
    else if (m() >= 1200) B('v45');
    if (m() >= 1000) B('vesthelm'); else if (m() >= 650) B('vest');
    if (!T && m() >= 400 && chance(0.7)) B('kit');
    this.botNades(b, 0);
    if (!b.inv.primary && m() >= 700) B('d50');
  },
  botNades(b, keep) {
    const order = shuffle(['flash', 'he', 'smoke', 'flash']);
    for (const n of order) if (b.money - NADES[n].price >= keep && chance(0.7)) this.buy(b, n);
  },
};
