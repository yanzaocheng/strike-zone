// =====================================================================
//  Strike Zone 构建脚本
//  1) 客户端：把 src/ 下的全部模块按文件名顺序拼接，内联进 src/index.html → strike-zone.html
//  2) 服务器：srv_head + 游戏模拟模块（不含渲染/界面/输入）+ srv_room → server/room.js
//  用法：node build.js
// =====================================================================
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'strike-zone.html');
const SERVER_OUT = path.join(__dirname, 'server', 'room.js');

const read = (f) => fs.readFileSync(f, 'utf8');
const banner = (f) => `\n// #####################################################################\n// ## 模块文件：${f}\n// #####################################################################\n`;

// ---------------- 客户端 ----------------
const files = fs.readdirSync(SRC).filter(f => /^\d\d_.+\.js$/.test(f)).sort();
let script = "'use strict';\n";
for (const f of files) script += banner(f) + read(path.join(SRC, f)) + '\n';
if (script.includes('</script')) throw new Error('源码中不能出现 </script 字样');
const html = read(path.join(SRC, 'index.html'));
const marker = '/*__GAME_SCRIPT__*/';
if (!html.includes(marker)) throw new Error('index.html 缺少脚本占位符');
const out = html.replace(marker, () => script);
fs.writeFileSync(OUT, out, 'utf8');
console.log(`已生成 ${path.basename(OUT)}：${files.length} 个模块，${(out.length / 1024).toFixed(1)} KB，${out.split('\n').length} 行`);

// ---------------- 服务器房间线程 ----------------
// 服务器只需要模拟相关的模块：配置/工具/地图/物理/导航/武器数据/角色/投掷物/炸弹/Bot/经济/回合
const SIM = ['00_', '01_', '02_', '03_', '04_', '05_', '06_', '07_', '08_', '09_', '11_', '12_', '13_', '14_', '15_'];
const simFiles = files.filter(f => SIM.some(p => f.startsWith(p)));
let srv = "'use strict';\n" + read(path.join(__dirname, 'server', 'src', 'srv_head.js'));
for (const f of simFiles) srv += banner(f) + read(path.join(SRC, f)) + '\n';
srv += banner('server/src/srv_room.js') + read(path.join(__dirname, 'server', 'src', 'srv_room.js'));
fs.writeFileSync(SERVER_OUT, srv, 'utf8');
console.log(`已生成 server/room.js：${simFiles.length} 个模拟模块，${(srv.length / 1024).toFixed(1)} KB`);
