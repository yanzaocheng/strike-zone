// =====================================================================
//  Strike Zone 联机房间（运行在 worker 线程中）
//  本文件由 build.js 自动生成：srv_head + 游戏模拟模块 + srv_room，请勿直接修改
// =====================================================================
const { parentPort, workerData } = require('worker_threads');
const THREE = require('three');
globalThis.location = { search: '' };
