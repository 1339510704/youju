// ============================================================
// 侦探社（detect）云函数配置
// ------------------------------------------------------------
// 搜索能力复用你已部署的两个 Cloudflare Worker（都不需要改线上代码）：
//   SEARCH_BASE  → zhenjiajiandingsuo：元宝搜索 + 来源分级
//                  （official / academic / media / selfmedia / vertical / marketing）
//                  出题时只从 official / academic / media 里摘句子，避免自媒体的错知识
//   JUDGE_BASE   → zhentanshe：博主引擎 + 权威域名库 + Jev 裁决（备用，可不填）
//
// 为什么不把元宝搜索的 API KEY 放进这里：
//   1. key 已在 Worker 的环境变量里（WSA_API_KEY），云函数只调 Worker 的 HTTP 接口；
//   2. 这样 key 不进小程序包、也不进微信云函数，泄露面最小；
//   3. 以后换 key / 加引擎，只改 Worker，小程序不用重新发版。
//
// ⚠️ 小程序端【不能】直接请求这些域名（dpdns.org 未备案，微信 request 白名单过不了），
//    必须由云函数中转 —— 云函数出网不受白名单限制。
// ============================================================
module.exports = {
  // 元宝搜索 + 来源分级（出题/问答都走它）
  SEARCH_BASE: 'https://zhenjiajiandingsuo.robai.dpdns.org',

  // 备用：多引擎 + Jev 裁决（留空则不启用）
  JUDGE_BASE: 'https://zhentanshe.robai.dpdns.org',

  // 若以后给 Worker 加了访问口令，填这里（会以 Authorization: Bearer 发送）
  WORKER_TOKEN: '',

  // 单次搜索超时（毫秒）。元宝搜索实测 8～12 秒，偶尔更慢，所以给足 25 秒，
  // 同时记得把云函数超时时间调到 60 秒（云开发控制台 → 云函数 → detect → 配置）
  TIMEOUT_MS: 25000,

  // 默认出几题（3～8）
  ROUNDS: 5,

  // 一局最多几人（2 人对战；单人模式另算）
  MAX_PLAYERS: 2,

  // 出题时可用的来源分级（只信这三类）
  ALLOWED_TIERS: ['official', 'academic', 'media']
};
