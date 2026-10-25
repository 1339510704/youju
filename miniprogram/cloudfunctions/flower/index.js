// ============================================================
// flower 云函数 —— 小红花与会员中枢
//
// 小红花是本小程序的"内部积分货币"：
//   赚：家庭成员接单/完成任务、班级成员发帖被赞 …（见 EARN_RULES）
//   花：兑换小红花 / 兑换家庭自定义奖励
// 因为全程不涉及现金交易，个人主体小程序 + iOS 端都能合规使用。
//
// 对外动作（客户端可调）：rules / balance / rank / redeem / adjust
// 内部动作（仅云函数之间调用，需 _token）：earn
// ============================================================
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const config = require('./config.js');
const TRIAL_DAYS = (config && config.VIRTUAL_PAY && config.VIRTUAL_PAY.trialDays) || 30;

// 内部调用口令：仅存在于服务端代码里，前端拿不到。
// content 云函数调用本函数的内部动作时必须带上。
const INTERNAL_SECRET = 'hsmp-internal-flower-2026';

// 管理员密钥：只有知道此密钥的人可以生成/查看兑换码（仅开发者本人）
const ADMIN_KEY = 'shuli9527';

// ---------------- 赚花规则（做家务型） ----------------
// daily = 每人每天最多能靠该行为赚几次；delta = 单次基础花数
const EARN_RULES = {
  order_add:    { delta: 1, daily: 3,  label: '点了一道菜' },
  order_take:   { delta: 2, daily: 5,  label: '接单认领' },
  order_done:   { delta: 5, daily: 10, label: '完成一道菜' },
  todo_done:    { delta: 3, daily: 9,  label: '按时完成待办' },
  todo_late:    { delta: 1, daily: 5,  label: '补完成待办' },
  festival_add: { delta: 2, daily: 4,  label: '记录重要节日' },
  reminder_add: { delta: 1, daily: 3,  label: '设置提醒' },
  finance_add:  { delta: 1, daily: 3,  label: '记一笔账' },
  plan_add:     { delta: 3, daily: 3,  label: '建立攒钱目标' },
  checkin:      { delta: 2, daily: 1,  label: '回家签到' },
  detect_win:   { delta: 3, daily: 3,  label: '侦探社答题获胜' }
};

// ---------------- 防刷闸 ----------------
// 现有「每日上限 + 同对象去重」有个明显漏洞：删掉一条再重新添加，refId 就变了，
// 去重失效，可以无限刷。所以再补三道闸：
//   1. 每人每天赚花总量上限（所有规则合计）
//   2. 同一规则两次得花的最小时间间隔（防连点）
//   3. 同一规则每人每小时的次数上限（防"删了再加"循环刷）
const ANTI_CHEAT = {
  dailyTotal: 30,   // 每天最多赚 30 朵（够用了：完成 6 道菜 = 30 朵）
  minGapSec: 3,     // 同一规则两次至少间隔 3 秒
  hourCap: 12       // 同一规则每小时最多 12 次
};

// ---------------- 等级徽章 ----------------
// 按「累计获得」升级（不是余额，花掉不会掉级）。图标在 images/ic/ 下一眼能看出区别。
// dailyTotal 是每天 30 朵，节奏大致是：大红花 2 天 / 红心 5 天 / 心连心 12 天 / 小屋 24 天
const BADGES = [
  { key: 'flower', name: '小红花', icon: 'flower_red', need: 0   },
  { key: 'big',    name: '大红花', icon: 'flower_big', need: 50  },
  { key: 'heart',  name: '红心',   icon: 'heart',      need: 150 },
  { key: 'hearts', name: '心连心', icon: 'hearts',     need: 350 },
  { key: 'house',  name: '一个家', icon: 'house',      need: 700 }
];

function badgeOf(earned) {
  const e = Math.max(0, Number(earned) || 0);
  let cur = BADGES[0], next = null;
  for (let i = 0; i < BADGES.length; i++) {
    if (e >= BADGES[i].need) cur = BADGES[i];
    else { next = BADGES[i]; break; }
  }
  const span = next ? (next.need - cur.need) : 1;
  return {
    key: cur.key, name: cur.name, icon: cur.icon, need: cur.need, earned: e,
    next: next ? { key: next.key, name: next.name, icon: next.icon, need: next.need } : null,
    left: next ? (next.need - e) : 0,
    progress: next ? Math.max(0, Math.min(100, Math.round((e - cur.need) / span * 100))) : 100
  };
}

// 累计获得：老数据没有这个字段时，从流水里算一次并存下来，之后都走累加
async function getEarnedTotal(spaceId, m) {
  if (typeof m.earnedTotal === 'number') return m.earnedTotal;
  let total = 0;
  try {
    const r = await db.collection('flowerLogs')
      .where({ spaceId, openid: m.openid, delta: _.gt(0) }).limit(1000).get();
    total = (r.data || []).reduce((s2, x) => s2 + (x.delta || 0), 0);
  } catch (e) { total = 0; }
  try { await db.collection('members').doc(m._id).update({ data: { earnedTotal: total } }); } catch (e) {}
  return total;
}

// ---------------- 会员等级：已下线 ----------------
// 原先的「普通成员 / 小红花会员 / 超级会员」等级体系（含 earnRate 积分倍率）已整体移除。
// 小红花只看「累计获得」升徽章（见 BADGES），与会员/付费无关。

// ---------------- 小工具 ----------------
// 云函数默认时区是 UTC，这里统一按北京时间算"今天 0 点"对应的 UTC 时刻
function today0() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  bj.setUTCHours(0, 0, 0, 0);
  return new Date(bj.getTime() - 8 * 3600 * 1000);
}

async function getUserDoc(openid) {
  try {
    const r = await db.collection('users').doc(openid).get();
    return r.data || null;
  } catch (e) {
    return null;
  }
}

// 头像 fileID → 临时链接（服务端有全部文件读写权限；小程序端换"别人的头像"会失败，
// 表现就是家人互相看不到头像）。随排行榜接口一起返回，客户端不必再单独调用。
async function avatarUrlsOf(list) {
  const arr = list || [];
  const ids = [];
  arr.forEach(x => {
    const v = x && x.avatarUrl;
    if (typeof v === 'string' && v.indexOf('cloud://') === 0 && ids.indexOf(v) < 0) ids.push(v);
  });
  if (!ids.length) return arr;
  const r = await cloud.getTempFileURL({ fileList: ids.slice(0, 50) }).catch(() => null);
  const map = {};
  ((r && r.fileList) || []).forEach(x => { if (x && x.fileID && x.tempFileURL) map[x.fileID] = x.tempFileURL; });
  if (!Object.keys(map).length) return arr;
  return arr.map(x => (x && map[x.avatarUrl]) ? Object.assign({}, x, { avatarUrl: map[x.avatarUrl] }) : x);
}

// 新增或更新全局用户资料
async function upsertUser(openid, patch) {
  const exists = !!(await getUserDoc(openid));
  if (exists) {
    await db.collection('users').doc(openid).update({ data: Object.assign({ updatedAt: db.serverDate() }, patch) });
  } else {
    await db.collection('users').add({
      data: Object.assign({
        _id: openid, openid, nickName: '', avatarUrl: '',
        bg: { type: 'default', value: '' },
        bgUnlock: false,
        memberUntil: Date.now() + TRIAL_DAYS * 86400000,   // 新用户免费试用
        createdAt: db.serverDate(), updatedAt: db.serverDate()
      }, patch)
    });
  }
}

async function getMemberDoc(spaceId, openid) {
  const r = await db.collection('members').where({ spaceId, openid }).limit(1).get();
  return r.data[0] || null;
}

// 扣除小红花（带回显校验）
async function spendFlowers(spaceId, openid, amount, reason, label) {
  const m = await getMemberDoc(spaceId, openid);
  if (!m) return { ok: false, errMsg: '你还不是该空间的成员' };
  const cur = m.flowers || 0;
  if (cur < amount) return { ok: false, errMsg: '小红花不够，还差 ' + (amount - cur) + ' 朵' };
  await db.collection('members').doc(m._id).update({ data: { flowers: _.inc(-amount) } });
  await db.collection('flowerLogs').add({
    // byName：记下「谁做的」，红花明细里就能显示「小明 点菜：红烧肉」
    data: { spaceId, openid, byName: m.nickName || '', delta: -amount, reason, label, createdAt: db.serverDate() }
  });
  return { ok: true, balance: cur - amount };
}

// 发放小红花（内部调用）：带每日上限 + 同一对象去重 + 会员加成
async function earnFlower(spaceId, openid, ruleKey, refId, label) {
  const rule = EARN_RULES[ruleKey];
  if (!rule || !rule.delta) return { ok: true, delta: 0 };
  const m = await getMemberDoc(spaceId, openid);
  if (!m) return { ok: false, errMsg: '不是空间成员' };

  const dayStart = today0();

  // 闸 0：本规则每日上限
  if (rule.daily) {
    const c = await db.collection('flowerLogs')
      .where({ spaceId, openid, reason: ruleKey, createdAt: _.gte(dayStart) }).count();
    if (c.total >= rule.daily) return { ok: true, delta: 0, capped: true };
  }

  // 闸 1：同一规则每小时次数上限（防「删了再加」绕开 refId 去重）
  const hourAgo = new Date(Date.now() - 3600 * 1000);
  const hc = await db.collection('flowerLogs')
    .where({ spaceId, openid, reason: ruleKey, createdAt: _.gte(hourAgo) }).count();
  if (hc.total >= ANTI_CHEAT.hourCap) return { ok: true, delta: 0, capped: true, by: 'hour' };

  // 闸 2：同一规则两次得花的最小间隔（防连点）
  const last = await db.collection('flowerLogs')
    .where({ spaceId, openid, reason: ruleKey })
    .orderBy('createdAt', 'desc').limit(1).get();
  if (last.data.length) {
    const t = last.data[0].createdAt ? new Date(last.data[0].createdAt).getTime() : 0;
    if (t && Date.now() - t < ANTI_CHEAT.minGapSec * 1000) {
      return { ok: true, delta: 0, capped: true, by: 'gap' };
    }
  }

  // 闸 3：每人每天赚花总量上限（所有规则合计）
  const todayLogs = await db.collection('flowerLogs')
    .where({ openid, delta: _.gt(0), createdAt: _.gte(dayStart) }).limit(500).get();
  const total = (todayLogs.data || []).reduce((s, x) => s + (x.delta || 0), 0);
  if (total >= ANTI_CHEAT.dailyTotal) return { ok: true, delta: 0, capped: true, by: 'total' };

  // 同一个对象（如同一道菜、同一篇帖子）同一规则只给一次，防重复点击刷花
  if (refId) {
    const d = await db.collection('flowerLogs')
      .where({ spaceId, openid, reason: ruleKey, refId }).count();
    if (d.total > 0) return { ok: true, delta: 0, dup: true };
  }

  const delta = Math.max(1, Math.round(rule.delta));

  if (typeof m.earnedTotal !== 'number') await getEarnedTotal(spaceId, m);
  await db.collection('members').doc(m._id).update({
    data: { flowers: _.inc(delta), earnedTotal: _.inc(delta) }
  });
  await db.collection('flowerLogs').add({
    // byName：记下「谁做的」（老数据没这个字段，前端会用成员表兜底）
    data: { spaceId, openid, byName: m.nickName || '', delta, reason: ruleKey, label: label || rule.label, refId: refId || '', createdAt: db.serverDate() }
  });
  return { ok: true, delta };
}

// （已下线的历史额度逻辑）

// ============================================================
// 家庭自定义兑换项
// 让家庭成员自己定义"小红花能换什么"：亲亲一次、免做家务一天、周末点外卖…
// 这些是家庭内部的情感互动，不涉及任何交易，完全合规。
// ============================================================

// 一些好玩的默认项，建空间后可选一键添加（也可全部删除）
const DEFAULT_REWARDS = [
  { name: '亲亲一次',       cost: 20,  emoji: '😘' },
  { name: '抱抱一次',       cost: 15,  emoji: '🤗' },
  { name: '免做家务一天',   cost: 50,  emoji: '🛋️' },
  { name: '周末点一次外卖', cost: 80,  emoji: '🍜' },
  { name: '决定今晚看什么', cost: 30,  emoji: '📺' }
];

// 兑换项合法范围
const REWARD_LIMIT = { minCost: 1, maxCost: 999, maxCount: 30, maxNameLen: 12 };

async function listRewards(spaceId) {
  try {
    const r = await db.collection('rewards').where({ spaceId, enabled: true }).limit(100).get();
    return (r.data || []).sort((a, b) => (a.cost || 0) - (b.cost || 0));
  } catch (e) {
    return [];
  }
}

// ---------------- 兑换码工具 ----------------
// 用户输入时不区分横线 / 空格 / 大小写，统一规范化后再比对
function normCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function fmtCode(code) {
  const c = normCode(code);
  return (c.match(/.{1,4}/g) || []).join('-');
}
// 去掉容易看错的 0/O/1/I，剩 32 个字符；6 位 ≈ 1.1e9 组合
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randCode() {
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return out;
}

// ---------------- 一键备份（仅开发者本人，需 adminKey） ----------------
// 集合清单与 init 云函数保持一致。
// ⚠️ 备份文件也存在本环境的云存储里，而环境一旦被释放，云存储会一起没，
//    所以生成之后必须把文件下载到本地/电脑，才算真的备份下来了。
const BACKUP_COLLECTIONS = [
  'spaces', 'members', 'users', 'flowerLogs', 'codes', 'dishes', 'orders',
  'todos', 'festivals', 'reminders', 'finance', 'plans', 'rewards',
  'rewardOrders', 'payOrders'
];
const BACKUP_PAGE = 100;    // 单次 get 最多 100 条
const BACKUP_CAP = 5000;    // 单个集合最多导出多少条，防超时 / 内存爆

async function fetchAllDocs(name) {
  const out = [];
  for (let skip = 0; skip < BACKUP_CAP; skip += BACKUP_PAGE) {
    let r = null;
    try {
      r = await db.collection(name).skip(skip).limit(BACKUP_PAGE).get();
    } catch (e) {
      return { list: out, err: (e && (e.errMsg || e.message)) || String(e) };
    }
    const list = (r && r.data) || [];
    if (!list.length) break;
    out.push.apply(out, list);
    if (list.length < BACKUP_PAGE) break;
  }
  return { list: out, err: '' };
}

// 北京时间戳：20260922-135501（文件名排序即时间序）
function bjStamp(d) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return t.getUTCFullYear() + p(t.getUTCMonth() + 1) + p(t.getUTCDate()) + '-'
    + p(t.getUTCHours()) + p(t.getUTCMinutes()) + p(t.getUTCSeconds());
}

// 导出全部集合 → 一个 JSON → 存进云存储 backup/，并回一个临时下载链接
async function runBackup() {
  const now = new Date();
  const data = {};
  const counts = {};
  const errors = [];
  let total = 0;
  for (const name of BACKUP_COLLECTIONS) {
    const r = await fetchAllDocs(name);
    data[name] = r.list;
    counts[name] = r.list.length;
    total += r.list.length;
    if (r.err) errors.push(name + '：' + r.err);
  }
  const payload = {
    app: 'home-space-mp',
    exportedAt: now.toISOString(),
    exportedAtBj: bjStamp(now),
    counts, total, data
  };
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  const cloudPath = 'backup/hsmp-' + bjStamp(now) + '.json';
  const up = await cloud.uploadFile({ cloudPath, fileContent: buf });
  let url = '';
  try {
    const t = await cloud.getTempFileURL({ fileList: [up.fileID] });
    url = ((t && t.fileList && t.fileList[0]) || {}).tempFileURL || '';
  } catch (e) { /* 拿不到链接就只给 fileID，控制台照样能下 */ }
  return {
    success: true, fileID: up.fileID, cloudPath, url,
    sizeKB: Math.max(1, Math.round(buf.length / 1024)),
    counts, total, errors
  };
}

// ============================================================
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action } = event;

  try {
    // ---- 内部动作：必须带口令，客户端拿不到口令 ----
    if (action === 'earn') {
      if (event._token !== INTERNAL_SECRET) return { success: false, errMsg: '非法调用' };
      const openid = event.openid;
      if (!openid) return { success: false, errMsg: '缺少 openid' };
      const r = await earnFlower(event.spaceId, openid, event.rule, event.refId, event.label);
      return Object.assign({ success: !!r.ok }, r);
    }

    // ---- 规则表（前端展示"能得几朵花"） ----
    if (action === 'rules') {
      return { success: true, earn: EARN_RULES };
    }

    // ---- 每日签到：每个账号每天一次，+2 朵（服务端按 openid 判定，前端改不了）----
    if (action === 'checkin') {
      // 会员到期：签到属操作类（会发花），且到期应只能查看，直接拒绝
      try {
        const u = await db.collection('users').doc(OPENID).get();
        const until = (u && u.data && u.data.memberUntil) || 0;
        if (until <= Date.now()) return { success: false, code: 'MEMBER_EXPIRED', errMsg: '会员已到期，请续费后再操作' };
      } catch (e) {}
      const m = await getMemberDoc(event.spaceId, OPENID);
      if (!m) return { success: false, errMsg: '你还不是该空间的成员' };
      // 按 openid 全局判「今天签过没」，不按空间 —— 换空间也领不到第二次
      const dup = await db.collection('flowerLogs')
        .where({ openid: OPENID, reason: 'checkin', createdAt: _.gte(today0()) }).count();
      if (dup.total > 0) return { success: true, already: true, flowers: m.flowers || 0 };

      const r = await earnFlower(event.spaceId, OPENID, 'checkin', '', '回家签到');
      if (!r.ok) return { success: false, errMsg: r.errMsg };
      const after = await getMemberDoc(event.spaceId, OPENID);
      return { success: true, already: false, delta: r.delta || 0, earned: r.delta || 0, flowers: (after && after.flowers) || 0 };
    }

    // ---- 会员中心（红花页）聚合：一次往返拿齐全部数据 ----
    // 原来前端要打 4 次云调用（balance / heatmap / rewards / rewardOrders），
    // 弱网下就是"进红花页要卡一下"的主因。这里在服务端内并行取完一起返回。
    if (action === 'vipOverview') {
      const m = await getMemberDoc(event.spaceId, OPENID);
      if (!m) return { success: false, errMsg: '你还不是该空间的成员' };
      const limit = Math.min(50, Math.max(1, parseInt(event.limit, 10) || 30));
      const days = Math.min(90, Math.max(7, parseInt(event.days, 10) || 35));

      const since = new Date(Date.now() - days * 24 * 3600 * 1000);
      // 明细改成「全家的流水」：这样每行都能显示「谁 做了什么」。
      // 同时带一份成员 nickname，给没有 byName 的老流水兜底（openid → 昵称）。
      const [logsRes, cnt, heatRes, rewards, orders, memRes] = await Promise.all([
        db.collection('flowerLogs')
          .where({ spaceId: event.spaceId })
          .orderBy('createdAt', 'desc').limit(limit).get().catch(() => ({ data: [] })),
        db.collection('flowerLogs')
          .where({ spaceId: event.spaceId }).count().catch(() => ({ total: 0 })),
        db.collection('flowerLogs')
          .where({ spaceId: event.spaceId, createdAt: _.gte(since) })
          .field({ createdAt: true }).limit(5000).get().catch(() => ({ data: [] })),
        listRewards(event.spaceId),
        db.collection('rewardOrders')
          .where({ spaceId: event.spaceId, status: 'pending' })
          .orderBy('createdAt', 'desc').limit(50).get().catch(() => ({ data: [] })),
        db.collection('members')
          .where({ spaceId: event.spaceId }).limit(100).get().catch(() => ({ data: [] }))
      ]);
      const memberNames = {};
      (memRes.data || []).forEach(x => { if (x && x.openid) memberNames[x.openid] = x.nickName || '家人'; });

      const earned = await getEarnedTotal(event.spaceId, m);
      // ⚠️ 腾讯云 SCF 默认 UTC，按东八区算日期 key，和前端 buildHeatmap 保持一致
      const heatmap = {};
      (heatRes.data || []).forEach(x => {
        const cst = new Date(new Date(x.createdAt).getTime() + 8 * 3600 * 1000);
        const key = cst.getUTCFullYear() + '-' + (cst.getUTCMonth() + 1) + '-' + cst.getUTCDate();
        heatmap[key] = (heatmap[key] || 0) + 1;
      });

      return {
        success: true,
        flowers: m.flowers || 0,
        earned,
        badge: badgeOf(earned),
        logs: logsRes.data || [],
        logTotal: cnt.total || 0,
        me: OPENID, memberNames,
        heatmap, days,
        rewards,
        defaults: DEFAULT_REWARDS,
        limit: REWARD_LIMIT,
        isAdmin: ['owner', 'admin'].includes(m.role),
        orders: orders.data || []
      };
    }

    // ---- 我在某空间的小红花余额 + 最近流水 ----
    if (action === 'balance') {
      const m = await getMemberDoc(event.spaceId, OPENID);
      const flowers = m ? (m.flowers || 0) : 0;
      const earned = m ? await getEarnedTotal(event.spaceId, m) : 0;
      const limit = Math.min(50, Math.max(1, parseInt(event.limit, 10) || 30));
      // 与 vipOverview 一致：明细显示全家流水（带「谁做的」）
      const [logs, cnt, memRes] = await Promise.all([
        db.collection('flowerLogs').where({ spaceId: event.spaceId })
          .orderBy('createdAt', 'desc').limit(limit).get(),
        db.collection('flowerLogs').where({ spaceId: event.spaceId }).count(),
        db.collection('members').where({ spaceId: event.spaceId }).limit(100).get().catch(() => ({ data: [] }))
      ]);
      const memberNames = {};
      (memRes.data || []).forEach(x => { if (x && x.openid) memberNames[x.openid] = x.nickName || '家人'; });
      return {
        success: true, flowers, earned, badge: badgeOf(earned),
        logs: logs.data, logTotal: cnt.total, me: OPENID, memberNames
      };
    }

    // ---- 小红花流水（分页）：默认只给最近一周，点「显示更多」再往后翻 ----
    if (action === 'logs') {
      const m = await getMemberDoc(event.spaceId, OPENID);
      if (!m) return { success: false, errMsg: '你还不是该空间的成员' };
      const limit = Math.min(50, Math.max(1, parseInt(event.limit, 10) || 30));
      const skip = Math.max(0, parseInt(event.skip, 10) || 0);
      // 与 vipOverview 保持一致：明细是「全家流水」，翻页也要按全家算，否则条数和内容对不上
      const [cnt, r, memRes] = await Promise.all([
        db.collection('flowerLogs').where({ spaceId: event.spaceId }).count(),
        db.collection('flowerLogs').where({ spaceId: event.spaceId })
          .orderBy('createdAt', 'desc').skip(skip).limit(limit).get(),
        db.collection('members').where({ spaceId: event.spaceId }).limit(100).get().catch(() => ({ data: [] }))
      ]);
      const memberNames = {};
      (memRes.data || []).forEach(x => { if (x && x.openid) memberNames[x.openid] = x.nickName || '家人'; });
      return { success: true, total: cnt.total, skip, limit, list: r.data || [], me: OPENID, memberNames };
    }

    // ---- 点菜下单：按菜品定价扣小红花 ----
    // 前端只传 dishId + qty，花数以服务端 dishes.flowers 为准（默认 1），防前端篡改。
    if (action === 'orderPay') {
      const { spaceId, items } = event || {};
      if (!spaceId) return { success: false, errMsg: '缺少 spaceId' };
      // 云函数间调用（带内部口令）时可指定付款人；普通调用一律用调用者自己的身份，防伪造
      const payer = (event._token === INTERNAL_SECRET && event.openid) ? event.openid : OPENID;
      const list = (items || []).filter(x => x && (x.name || x.dishId));
      if (!list.length) return { success: true, cost: 0 };

      // 服务端查菜品定价
      const ids = list.map(x => x.dishId).filter(Boolean);
      const price = {};
      if (ids.length) {
        const r = await db.collection('dishes').where({ _id: _.in(ids) }).limit(100).get();
        (r.data || []).forEach(d => { price[d._id] = Math.max(0, parseInt(d.flowers, 10) || 0); });
      }

      let cost = 0;
      const parts = [];
      for (const it of list) {
        const unit = (it.dishId && price[it.dishId] != null) ? price[it.dishId] : 1;
        const qty = Math.max(1, parseInt(it.qty, 10) || 1);
        cost += unit * qty;
        parts.push((it.name || '菜') + '×' + qty);
      }
      if (cost <= 0) return { success: true, cost: 0 };

      const r = await spendFlowers(spaceId, payer, cost, 'order_pay', '点菜：' + parts.join('、').slice(0, 40));
      if (!r.ok) return { success: false, errMsg: r.errMsg, need: cost };

      // 「点菜得花」顺带在这里发：调用方(content)因此省掉「每道菜一次云调用」，
      // 冷启动开销从 N+1 次降到 1 次。refId 用唯一值（与旧版每单一个 refId 的去重等价）。
      let earned = 0;
      if (event.earnPerDish) {
        const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        for (let i = 0; i < list.length; i++) {
          const er = await earnFlower(spaceId, payer, 'order_add', 'ord_' + stamp + '_' + i, '点了 ' + (list[i].name || '菜'));
          if (er && er.ok) earned += er.delta || 0;
        }
      }
      return { success: true, cost, balance: r.balance, earned };
    }

    // ---- 空间内小红花排行榜 ----
    if (action === 'rank') {
      const me = await getMemberDoc(event.spaceId, OPENID);
      if (!me) return { success: false, errMsg: '无权访问该空间' };
      const ms = await db.collection('members').where({ spaceId: event.spaceId }).limit(100).get();
      const ids = ms.data.map(x => x.openid);
      let users = [];
      if (ids.length) {
        const u = await db.collection('users').where({ _id: _.in(ids) }).get();
        users = u.data;
      }
      const list = ms.data.map(x => {
        const u = users.find(y => y._id === x.openid) || {};
        return {
          openid: x.openid,
          nickName: x.nickName || u.nickName || '成员',
          avatarUrl: x.avatarUrl || u.avatarUrl || '',
          role: x.role || 'member',
          flowers: x.flowers || 0,
          earnedTotal: x.earnedTotal || 0,
          badge: badgeOf(x.earnedTotal || 0),
          joinAt: x.joinAt || null
        };
      }).sort((a, b) => b.flowers - a.flowers);
      const idx = list.findIndex(x => x.openid === OPENID);
      // 成员头像也是云存储文件：服务端换链接，否则家人互相看不到头像
      return { success: true, list: await avatarUrlsOf(list), myIndex: idx, myFlowers: idx >= 0 ? list[idx].flowers : 0 };
    }

    // ---- 兑换码 ----
    // 支持多次使用（maxUses）、有效期（expiresAt）、用量查询（listCodes）。
    // 兑换类型：flower = 小红花（主推） / bg = 自定义背景永久解锁
    if (action === 'redeem') {
      const code = normCode(event.code);
      if (!code) return { success: false, errMsg: '请输入兑换码' };
      const c = await db.collection('codes').where({ code }).limit(1).get();
      if (!c.data.length) return { success: false, errMsg: '兑换码无效，请核对后重试' };
      const doc = c.data[0];
      if (doc.revoked) return { success: false, errMsg: '这个兑换码已作废' };

      // 过期检查
      if (doc.expiresAt && new Date(doc.expiresAt).getTime() < Date.now()) {
        return { success: false, errMsg: '这个兑换码已过期' };
      }

      // 使用次数检查
      const maxUses = Math.max(1, doc.maxUses || 1);
      const uses = doc.uses || [];
      if (doc.usedBy && uses.length === 0) uses.push({ openid: doc.usedBy, at: doc.usedAt });
      if (uses.length >= maxUses) {
        return { success: false, errMsg: '这个兑换码已达到最大使用次数' };
      }

      // 同一用户不能用同一个码两次
      if (uses.some(u => u.openid === OPENID)) {
        return { success: false, errMsg: '你已经用过这个兑换码了' };
      }

      const type = doc.type || 'member';
      // 兑换码现在只用于延长会员：历史的小红花/背景码一律停用
      // （如仍需处理老码，可在后台「可用」列表里左滑作废）
      if (type !== 'member') {
        return { success: false, errMsg: '该兑换码已停用（现在仅支持会员兑换码）' };
      }
      const burn = () => db.collection('codes').doc(doc._id).update({
        data: { uses: _.push({ openid: OPENID, at: db.serverDate() }), usedCount: uses.length + 1 }
      });

      // 会员：延长小程序使用期限（可按天或按月，1 个月按 30 天计）
      await burn();
      const months = Math.max(0, Math.round(Number(doc.months) || 0));
      const days = Math.max(0, Math.round(Number(doc.days) || 0));
      // 优先用「天」；没有天就用「月」折算；都没有则兜底 30 天
      const addDays = days > 0 ? days : (months > 0 ? months * 30 : 30);
      const u = await getUserDoc(OPENID);
      const base = (u && u.memberUntil && u.memberUntil > Date.now()) ? u.memberUntil : Date.now();
      const until = base + addDays * 86400000;
      await upsertUser(OPENID, { memberUntil: until });
      return { success: true, type: 'member', months, days, unit: days > 0 ? 'day' : 'month' };
    }

    // ---- 批量生成兑换码（仅管理员，需 adminKey）----
    if (action === 'genCodes') {
      if (event.adminKey !== ADMIN_KEY) return { success: false, errMsg: '无权操作' };
      const count = Math.min(100, Math.max(1, Math.round(Number(event.count) || 10)));
      // 兑换内容：现在只生成「会员码」（可按天或按月）
      const type = 'member';
      const value = 0;
      const duration = 0;
      let months = Math.max(0, Math.round(Number(event.months) || 0));
      const days = Math.max(0, Math.round(Number(event.days) || 0));
      if (!months && !days) months = 1;   // 都没传时兜底 1 个月

      const maxUses = Math.max(1, Math.min(9999, Math.round(Number(event.maxUses) || 1)));
      const expiresDays = Math.max(0, Math.round(Number(event.expiresDays) || 0));
      const customCodes = (event.customCodes || '').split(/[\s,，;；]+/).map(normCode).filter(Boolean);
      const note = String(event.note || '').slice(0, 40);
      const batch = 'B' + Date.now().toString(36).toUpperCase();
      const codes = [];
      const expiresAt = expiresDays > 0 ? new Date(Date.now() + expiresDays * 86400000) : null;

      for (const cc of customCodes) {
        if (cc.length < 4 || cc.length > 8) continue;
        const exists = await db.collection('codes').where({ code: cc }).count();
        if (exists.total > 0) continue;
        const data = {
          code: cc, show: fmtCode(cc), type, value, duration, months, days, maxUses, batch, note,
          uses: [], usedCount: 0,
          createdBy: OPENID, createdAt: db.serverDate()
        };
        if (expiresAt) data.expiresAt = expiresAt;
        await db.collection('codes').add({ data });
        codes.push(data.show);
      }

      const remain = Math.max(0, count - customCodes.length);
      for (let i = 0; i < remain; i++) {
        let code, tries = 0;
        do {
          code = normCode(randCode());
          const dup = await db.collection('codes').where({ code }).count();
          if (dup.total === 0) break;
          tries++;
        } while (tries < 5);
        const data = {
          code, show: fmtCode(code), type, value, duration, months, days, maxUses, batch, note,
          uses: [], usedCount: 0,
          createdBy: OPENID, createdAt: db.serverDate()
        };
        if (expiresAt) data.expiresAt = expiresAt;
        await db.collection('codes').add({ data });
        codes.push(data.show);
      }

      return { success: true, batch, count: codes.length, codes };
    }

    // ---- 我生成过的兑换码（仅管理员，需 adminKey）----
    if (action === 'listCodes') {
      if (event.adminKey !== ADMIN_KEY) return { success: false, errMsg: '无权操作' };
      const r = await db.collection('codes').where({ createdBy: OPENID })
        .orderBy('createdAt', 'desc').limit(100).get();
      const now = Date.now();
      const list = (r.data || []).map(x => {
        const uses = x.uses || (x.usedBy ? [{ openid: x.usedBy, at: x.usedAt }] : []);
        const usedCount = x.usedCount || uses.length;
        const maxUses = x.maxUses || 1;
        const revoked = !!x.revoked;
        const expired = !!(x.expiresAt && new Date(x.expiresAt).getTime() < now);
        const status = revoked ? 'revoked' : (expired ? 'expired' : (usedCount >= maxUses ? 'usedup' : 'available'));
        return {
          _id: x._id, show: x.show || fmtCode(x.code), type: x.type || 'flower',
          value: x.value || x.days || 0,
          duration: x.duration || 0,
          months: x.months || 0,
          days: x.days || 0,
          maxUses, usedCount, uses, expired, revoked, status,
          expiresAt: x.expiresAt || null,
          batch: x.batch || '', note: x.note || '', createdAt: x.createdAt
        };
      });
      return { success: true, list };
    }

    // ---- 作废兑换码（仅管理员，需 adminKey）----
    if (action === 'revokeCode') {
      if (event.adminKey !== ADMIN_KEY) return { success: false, errMsg: '无权操作' };
      const id = event.id;
      if (!id) return { success: false, errMsg: '缺少 id' };
      const d = await db.collection('codes').doc(id).get().catch(() => null);
      if (!d || !d.data) return { success: false, errMsg: '兑换码不存在' };
      if (d.data.createdBy && d.data.createdBy !== OPENID) return { success: false, errMsg: '只能作废自己生成的码' };
      await db.collection('codes').doc(id).update({
        data: { revoked: true, revokedAt: db.serverDate() }
      });
      return { success: true };
    }

    // ---- 一键备份全部数据（仅开发者本人，需 adminKey）----
    // 为什么走开发者密钥而不是「家庭户主」：这是跨空间、全库级别的运维操作，
    // 不该让任何一个家庭的户主就能导出整个数据库。
    if (action === 'backup') {
      if (event.adminKey !== ADMIN_KEY) return { success: false, errMsg: '无权操作' };
      return await runBackup();
    }

    // ---- 户主手动给成员加/减小红花 ----
    if (action === 'adjust') {
      const me = await getMemberDoc(event.spaceId, OPENID);
      if (!me || !['owner', 'admin'].includes(me.role)) return { success: false, errMsg: '仅户主可调整小红花' };
      const target = await getMemberDoc(event.spaceId, event.targetOpenid);
      if (!target) return { success: false, errMsg: '成员不存在' };
      const amount = Math.round(Number(event.amount) || 0);
      if (!amount) return { success: false, errMsg: '请输入数量' };
      if (amount < 0 && (target.flowers || 0) + amount < 0) return { success: false, errMsg: '不能扣成负数' };
      if (amount > 0 && typeof target.earnedTotal !== 'number') {
        await getEarnedTotal(event.spaceId, target);
      }
      const patch = { flowers: _.inc(amount) };
      if (amount > 0) patch.earnedTotal = _.inc(amount);
      await db.collection('members').doc(target._id).update({ data: patch });
      await db.collection('flowerLogs').add({
        data: { spaceId: event.spaceId, openid: event.targetOpenid, byName: target.nickName || '', delta: amount, reason: 'manual', label: '管理员调整', createdAt: db.serverDate() }
      });
      return { success: true };
    }

    // ================= 家庭自定义兑换项 =================

    // ---- 列出本空间的兑换项（含默认项模板） ----
    if (action === 'rewards') {
      const me = await getMemberDoc(event.spaceId, OPENID);
      if (!me) return { success: false, errMsg: '你还不是该空间的成员' };
      const list = await listRewards(event.spaceId);
      return { success: true, list, defaults: DEFAULT_REWARDS, limit: REWARD_LIMIT, isAdmin: ['owner', 'admin'].includes(me.role) };
    }

    // ---- 新增 / 修改兑换项（成员都能加，户主可改别人的） ----
    if (action === 'saveReward') {
      const me = await getMemberDoc(event.spaceId, OPENID);
      if (!me) return { success: false, errMsg: '你还不是该空间的成员' };
      const name = String(event.name || '').trim().slice(0, REWARD_LIMIT.maxNameLen);
      const cost = Math.round(Number(event.cost) || 0);
      if (!name) return { success: false, errMsg: '给这个奖励起个名字吧' };
      if (cost < REWARD_LIMIT.minCost || cost > REWARD_LIMIT.maxCost) {
        return { success: false, errMsg: `花朵数要在 ${REWARD_LIMIT.minCost}~${REWARD_LIMIT.maxCost} 之间` };
      }

      // 数量上限，防止塞满
      const all = await db.collection('rewards').where({ spaceId: event.spaceId, enabled: true }).count();

      if (event._id) {
        const old = await db.collection('rewards').doc(event._id).get().catch(() => null);
        if (!old || !old.data) return { success: false, errMsg: '兑换项不存在' };
        if (old.data.createdBy !== OPENID && !['owner', 'admin'].includes(me.role)) {
          return { success: false, errMsg: '只能修改自己添加的奖励' };
        }
        await db.collection('rewards').doc(event._id).update({
          data: { name, cost, emoji: String(event.emoji || '🎁').slice(0, 4), updatedAt: db.serverDate() }
        });
        return { success: true, _id: event._id };
      }

      if (all.total >= REWARD_LIMIT.maxCount) return { success: false, errMsg: `最多添加 ${REWARD_LIMIT.maxCount} 个奖励` };
      const add = await db.collection('rewards').add({
        data: {
          spaceId: event.spaceId, name, cost,
          emoji: String(event.emoji || '🎁').slice(0, 4),
          enabled: true,
          createdBy: OPENID,
          createdByName: me.nickName || '',
          createdAt: db.serverDate(), updatedAt: db.serverDate()
        }
      });
      return { success: true, _id: add._id };
    }

    // ---- 删除兑换项（软删除） ----
    if (action === 'delReward') {
      const me = await getMemberDoc(event.spaceId, OPENID);
      if (!me) return { success: false, errMsg: '你还不是该空间的成员' };
      const doc = await db.collection('rewards').doc(event._id).get().catch(() => null);
      if (!doc || !doc.data) return { success: false, errMsg: '兑换项不存在' };
      if (doc.data.createdBy !== OPENID && !['owner', 'admin'].includes(me.role)) {
        return { success: false, errMsg: '只能删除自己添加的奖励' };
      }
      await db.collection('rewards').doc(event._id).update({ data: { enabled: false, updatedAt: db.serverDate() } });
      return { success: true };
    }

    // ---- 兑换某个自定义奖励 ----
    if (action === 'redeemReward') {
      const me = await getMemberDoc(event.spaceId, OPENID);
      if (!me) return { success: false, errMsg: '你还不是该空间的成员' };
      const doc = await db.collection('rewards').doc(event._id).get().catch(() => null);
      if (!doc || !doc.data || !doc.data.enabled) return { success: false, errMsg: '这个奖励已经下架了' };
      const rw = doc.data;
      const r = await spendFlowers(event.spaceId, OPENID, rw.cost, 'reward_redeem', '兑换：' + rw.name);
      if (!r.ok) return { success: false, errMsg: r.errMsg };
      // 记一笔待兑现：家人可以看到谁兑换了什么，线下兑现后由对方确认
      await db.collection('rewardOrders').add({
        data: {
          spaceId: event.spaceId, openid: OPENID,
          nickName: me.nickName || '', avatarUrl: me.avatarUrl || '',
          rewardId: rw._id, name: rw.name, emoji: rw.emoji || '🎁', cost: rw.cost,
          status: 'pending', createdAt: db.serverDate()
        }
      });
      return { success: true, name: rw.name, emoji: rw.emoji, cost: rw.cost, balance: r.balance };
    }

    // ---- 待兑现列表（谁兑了什么，还没兑现） ----
    if (action === 'rewardOrders') {
      const me = await getMemberDoc(event.spaceId, OPENID);
      if (!me) return { success: false, errMsg: '你还不是该空间的成员' };
      const r = await db.collection('rewardOrders')
        .where({ spaceId: event.spaceId, status: 'pending' })
        .orderBy('createdAt', 'desc').limit(50).get();
      return { success: true, list: r.data || [], isAdmin: ['owner', 'admin'].includes(me.role) };
    }

    // ---- 标记已兑现（户主 / 管理员 / 本人 可操作） ----
    if (action === 'finishRewardOrder') {
      const me = await getMemberDoc(event.spaceId, OPENID);
      if (!me) return { success: false, errMsg: '你还不是该空间的成员' };
      const doc = await db.collection('rewardOrders').doc(event._id).get().catch(() => null);
      if (!doc || !doc.data) return { success: false, errMsg: '记录不存在' };
      if (doc.data.openid !== OPENID && !['owner', 'admin'].includes(me.role)) {
        return { success: false, errMsg: '没有操作权限' };
      }
      await db.collection('rewardOrders').doc(event._id).update({
        data: { status: 'done', doneBy: OPENID, doneAt: db.serverDate() }
      });
      return { success: true };
    }

    // ---- 家庭活跃热力图：最近 N 天每天的互动次数 ----
    if (action === 'heatmap') {
      const me = await getMemberDoc(event.spaceId, OPENID);
      if (!me) return { success: false, errMsg: '你还不是该空间的成员' };
      const days = Math.min(90, Math.max(7, parseInt(event.days, 10) || 35));
      const since = new Date(Date.now() - days * 24 * 3600 * 1000);
      const r = await db.collection('flowerLogs')
        .where({ spaceId: event.spaceId, createdAt: _.gte(since) })
        .field({ createdAt: true })
        .limit(5000)
        .get();
      const map = {};
      (r.data || []).forEach(x => {
        // ⚠️ 腾讯云 SCF 默认 UTC 时区，直接用 getDate() 会把北京时间当天的互动算到前一天。
        //    统一按东八区（北京时间）算日期 key，和前端 buildHeatmap 保持一致。
        const d = new Date(x.createdAt);
        const cst = new Date(d.getTime() + 8 * 3600 * 1000);
        const key = cst.getUTCFullYear() + '-' + (cst.getUTCMonth() + 1) + '-' + cst.getUTCDate();
        map[key] = (map[key] || 0) + 1;
      });
      return { success: true, heatmap: map, days };
    }

    return { success: false, errMsg: '未知操作' };
  } catch (e) {
    return { success: false, errCode: (e && e.errCode) || 0, errMsg: (e && (e.errMsg || e.message)) || String(e) };
  }
};
