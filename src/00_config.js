// =====================================================================
//  00 配置模块：所有可调的游戏参数集中在这里
//  单位约定：长度=米，时间=秒，角度=度（运行时转弧度）
// =====================================================================

/** 是否运行在服务器（Node.js 房间线程）中 */
const IS_SERVER = typeof window === 'undefined';
/** 运行模式：'sp' 单机；'client' 联机客户端；'server' 联机服务器 */
const NET = { mode: IS_SERVER ? 'server' : 'sp' };

const CFG = {
  DEBUG: !IS_SERVER && /[?&]debug/.test(location.search),   // URL 带 ?debug 时开启调试接口
  // ---- 联机 ----
  NETCFG: {
    URL: 'wss://strike.predix.icu/ws',   // 默认游戏服务器（可用 ?server=ws://... 覆盖）
    SNAP_RATE: 30,                       // 服务器快照频率（次/秒）
    SEND_RATE: 30,                       // 客户端上报频率（次/秒）
    INTERP: 0.1,                         // 其他玩家的插值延迟（秒）
  },
  CELL: 1.6,                                  // 地图 ASCII 每格对应的实际尺寸（米）
  GRAVITY: 20,                                // 重力（米/秒²），接近 CS 的 800u/s²
  TEAM_SIZE: 5,                               // 敌方 Bot 数量

  // ---- 角色碰撞与移动（Source 引擎风格的加速度/摩擦模型） ----
  PLAYER: {
    HALF_W: 0.4,            // 碰撞盒半宽
    HEIGHT: 1.83,           // 站立高度
    CROUCH_HEIGHT: 1.37,    // 下蹲高度
    EYE: 1.64,              // 站立视高
    CROUCH_EYE: 1.18,       // 下蹲视高
    JUMP_VEL: 7.2,          // 起跳速度 → 跳高约 1.3 米
    STEP: 0.45,             // 可自动跨上的台阶高度
    BASE_SPEED: 6.35,       // 持刀满速（≈250u/s），各武器按 speed/250 缩放
    ACCEL: 5.5,             // 地面加速度系数（sv_accelerate）
    AIR_ACCEL: 12,          // 空中加速度系数（sv_airaccelerate）
    AIR_CAP: 0.76,          // 空中期望速度上限（允许少量空中转向）
    FRICTION: 5.2,          // 地面摩擦（sv_friction）
    STOP_SPEED: 2.0,        // 摩擦计算的最低速度（sv_stopspeed）
    WALK_MULT: 0.52,        // 静步速度倍率
    CROUCH_MULT: 0.34,      // 下蹲速度倍率
    TAG_MULT: 0.45,         // 中弹减速倍率（CS 的 tagging）
    TAG_TIME: 0.35,
  },

  // ---- 回合与炸弹 ----
  ROUND: {
    FREEZE_TIME: 6,         // 冻结时间（可购买、不可移动）
    ROUND_TIME: 115,        // 回合时间 1:55
    BUY_TIME: 20,           // 冻结结束后仍可购买的时间
    END_DELAY: 5,           // 回合结束后 5 秒开始下一回合
    BOMB_TIME: 40,          // 炸弹倒计时
    PLANT_TIME: 5,          // 安放炸弹需按住 E 的时间
    DEFUSE_TIME: 10,        // 拆弹时间
    DEFUSE_KIT_TIME: 5,     // 有拆弹器的拆弹时间
    BOMB_RADIUS: 17,        // 炸弹爆炸半径
    BOMB_DAMAGE: 500,
  },

  // ---- 经济（参考 CS:GO 规则） ----
  ECON: {
    START: 800,
    MAX: 16000,
    WIN_ELIM: 3250,         // 全灭对手获胜
    WIN_BOMB: 3500,         // 炸弹爆炸获胜
    WIN_DEFUSE: 3500,       // 拆弹获胜
    WIN_TIME: 3250,         // 时间耗尽（CT）获胜
    LOSS: [1400, 1900, 2400, 2900, 3400],  // 连败补偿
    PLANT_BONUS: 300,       // 安放炸弹的个人奖励
    PLANT_TEAM_BONUS: 800,  // T 输掉回合但成功下包时的团队额外奖励
    DEFUSE_BONUS: 300,      // 拆弹个人奖励
  },

  // ---- 投掷物 ----
  NADE: {
    THROW_SPEED: 17.5,      // 左键远投初速
    LOB_SPEED: 7.5,         // 右键近抛初速
    MID_SPEED: 12.5,        // 左右键同按：中等距离
    RADIUS: 0.07,
    BOUNCE: 0.45,           // 反弹系数
    FRICTION: 0.72,         // 接触时切向保留比例
    HE_FUSE: 1.6,
    FLASH_FUSE: 1.5,
    HE_DAMAGE: 98,
    HE_RADIUS: 9.5,
    FLASH_TIME: 4.8,        // 正对闪光时最长致盲时间
    SMOKE_RADIUS: 4.4,
    SMOKE_TIME: 18,
    SMOKE_BLOOM: 1.4,       // 烟雾从炸开到完全展开的时间
  },
};

// ---- Bot 难度预设 ----
//  reaction：发现目标后的反应时间区间；errInit：初始瞄准误差（度）；
//  errDecay：误差衰减速度；errMin：稳定后残余误差；turnSpeed：最大转身速度（度/秒）；
//  headChance：瞄头概率；spray：压枪能力（0~1）；
const DIFFICULTY = {
  easy:   { name: '简单', reaction: [0.65, 0.90], errInit: 9.0, errDecay: 1.4, errMin: 2.4, turnSpeed: 160, headChance: 0.08, spray: 0.10, hearing: 0.7, burst: 0.7 },
  normal: { name: '普通', reaction: [0.42, 0.60], errInit: 6.0, errDecay: 2.2, errMin: 1.4, turnSpeed: 260, headChance: 0.18, spray: 0.35, hearing: 1.0, burst: 1.0 },
  hard:   { name: '困难', reaction: [0.30, 0.42], errInit: 4.2, errDecay: 3.0, errMin: 0.9, turnSpeed: 380, headChance: 0.30, spray: 0.60, hearing: 1.15, burst: 1.2 },
  expert: { name: '专家', reaction: [0.22, 0.30], errInit: 3.0, errDecay: 3.8, errMin: 0.55, turnSpeed: 500, headChance: 0.42, spray: 0.80, hearing: 1.3, burst: 1.4 },
};

// ---- 玩家设置（保存在 localStorage） ----
const DEFAULT_SETTINGS = {
  sens: 2.0,              // 灵敏度（与 CS 的数值手感接近：每像素 sens×0.022 度）
  zoomSens: 1.0,          // 开镜灵敏度倍率
  invertY: false,
  fov: 74,                // 垂直视野（16:9 下约等于 CS 默认视野）
  volume: 0.8,
  quality: 'medium',      // low / medium / high
  difficulty: 'normal',
  teammates: 0,           // 队友 Bot 数量（0 = 1v5）
  winRounds: 8,           // 先赢 N 回合者获胜
  crossColor: '#4dff7a',
  crossSize: 6,
  crossGap: 3,
  crossThick: 2,
  crossDot: false,
  crossDynamic: true,     // 准星随扩散变化
  trajectory: true,       // 投掷物轨迹预览
  showFps: true,
  fullscreen: true,       // 开始游戏时进入全屏并锁定键盘（防止 Ctrl+W 关闭页面）
  mpName: '',             // 联机昵称
};

const SETTINGS = (() => {
  const s = Object.assign({}, DEFAULT_SETTINGS);
  try {
    const saved = JSON.parse(localStorage.getItem('strikezone.settings') || '{}');
    for (const k in saved) if (k in DEFAULT_SETTINGS && typeof saved[k] === typeof DEFAULT_SETTINGS[k]) s[k] = saved[k];
  } catch (e) { /* 本地存储不可用时使用默认设置 */ }
  return s;
})();

function saveSettings() {
  try { localStorage.setItem('strikezone.settings', JSON.stringify(SETTINGS)); } catch (e) { /* 忽略 */ }
}
