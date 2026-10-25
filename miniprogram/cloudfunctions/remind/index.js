const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 模板 ID 来源（优先顺序）：云函数环境变量 > 同目录 localConfig.js
// 直接填 cloudfunctions/remind/localConfig.js 就不用去云开发控制台配环境变量了
let local = {};
try { local = require('./localConfig.js'); } catch (e) { local = {}; }

// 定时提醒模板 ID
const TEMPLATE_ID = process.env.REMINDER_TEMPLATE_ID || local.REMINDER_TEMPLATE_ID || '';
// 点菜通知模板 ID
const ORDER_TEMPLATE_ID = process.env.ORDER_TEMPLATE_ID || local.ORDER_TEMPLATE_ID || '';

function pad(n) { return n < 10 ? '0' + n : '' + n; }
// 统一按北京时间（UTC+8）格式化，避免云函数时区不是 +8 时显示错时间
function fmt(d) {
  const t = new Date(new Date(d).getTime() + 8 * 3600 * 1000);
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()) + ' ' +
    pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes());
}
// 对应的北京时间「串」形式（'YYYY-MM-DDTHH:mm:00'），用于兼容早期把 notifyAt 存成字符串的老数据
function fmtLocal(d) {
  const t = new Date(new Date(d).getTime() + 8 * 3600 * 1000);
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate()) + 'T' +
    pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes()) + ':00';
}
// 展示用：Date 走 fmt；字符串（老数据）直接截取，避免再被时区加工一次
function atText(v) {
  if (typeof v === 'string') return v.slice(0, 16).replace('T', ' ');
  return fmt(new Date(v));
}
// 查「到点且还没推送」的记录：
// 关键点 —— notifyAt 现在存的是 Date 对象，用字符串去比会永远匹配不到（提醒一条都发不出）。
// 这里 Date 和字符串两种存法都查一遍，再按 _id 去重，兼顾老数据。
async function queryDue(coll, nowDate, nowStr) {
  const [a, b] = await Promise.all([
    db.collection(coll).where({ notifyAt: _.lte(nowDate), notified: _.neq(true) }).limit(100).get().catch(() => ({ data: [] })),
    db.collection(coll).where({ notifyAt: _.lte(nowStr), notified: _.neq(true) }).limit(100).get().catch(() => ({ data: [] }))
  ]);
  const seen = {};
  const out = [];
  [...(a.data || []), ...(b.data || [])].forEach(r => {
    if (r && r._id && !seen[r._id]) { seen[r._id] = 1; out.push(r); }
  });
  return out.filter(x => x.notifyAt);
}

// 有些订阅消息模板的字段名跟默认的 thing1/thing2/time3 不一样（例如还必须有 thing4/thing5）。
// 微信的报错会明确说是哪个字段为空，这里解析出来自动补上。
// ⚠️ 只记住「模板需要哪些字段」，值每次按当前这条提醒重新生成 ——
//    否则第二条提醒会沿用第一条的发起人 / 菜品名（之前那 4 行全显示「待办提醒」就是旧兜底写死的）。
const _extraKeysByTpl = {};
// 模板里多出来的字段：按报错顺序给最合适的含义（顺序基本等于模板字段顺序），
// 例如「重复类型 / 待办发起人 / 待办类型 / 菜品名称」这套模板就能各就各位。
function fillValue(name, ctx, idx) {
  const k = String(name || '').toLowerCase();
  const c = ctx || {};
  const time = c.time || fmt(new Date());
  if (k.indexOf('time') === 0) return time;
  if (k.indexOf('date') === 0) return time.slice(0, 10);
  if (k.indexOf('number') === 0) return '1';
  if (k.indexOf('amount') === 0) return '0.00';
  if (k.indexOf('phrase') === 0) return idx <= 0 ? '一次性' : (c.type || '待办提醒');
  if (k.indexOf('thing') === 0 || k.indexOf('character_string') === 0) {
    if (idx === 0) return '一次性';        // 常见第 1 个额外字段：重复类型
    if (idx === 1) return c.from || '家人'; // 第 2 个：发起人
    if (idx === 2) return c.type || '待办提醒'; // 第 3 个：类型
    return c.detail || c.content || '见待办事项'; // 之后：补充信息（如菜品名）
  }
  return c.type || '待办提醒';
}
async function sendOne(openid, data, page, ctx, templateId) {
  const tpl = templateId || TEMPLATE_ID;
  const d = Object.assign({}, data);
  const known = _extraKeysByTpl[tpl] || [];
  known.forEach((k, i) => { if (d[k] === undefined) d[k] = { value: fillValue(k, ctx, i) }; });
  for (let i = 0; i < 6; i++) {
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: openid, templateId: tpl, page, data: d
      });
      return true;
    } catch (e) {
      const msg = (e && (e.errMsg || e.message)) || '';
      const m = msg.match(/data\.([A-Za-z0-9_]+)\.value is empty/);
      if (!m) throw e;
      const key = m[1];
      const list = _extraKeysByTpl[tpl] || (_extraKeysByTpl[tpl] = []);
      if (list.indexOf(key) < 0) list.push(key);
      d[key] = { value: fillValue(key, ctx, list.indexOf(key)) };
    }
  }
  throw new Error('订阅消息模板字段自动补全失败');
}

// 取成员在本空间的昵称（模板里的「发起人」这类字段用）
async function nameOf(spaceId, openid) {
  if (!spaceId || !openid) return '家人';
  try {
    const r = await db.collection('members').where({ spaceId, openid }).limit(1).get();
    const m = (r.data || [])[0];
    return (m && m.nickName) || '家人';
  } catch (e) { return '家人'; }
}

// 给某空间的成员推一条提醒（未授权模板的人会被跳过，不阻断）
// onlyOpenids：不传 = 发给全家人；传数组 = 只发给数组里的成员（空数组表示谁都不发）
async function notifySpace(spaceId, data, page, onlyOpenids, ctx) {
  if (!spaceId) return 0;
  const members = await db.collection('members').where({ spaceId }).limit(200).get();
  let targets = members.data.filter(m => m.openid);
  if (Array.isArray(onlyOpenids)) {
    targets = targets.filter(m => onlyOpenids.indexOf(m.openid) >= 0);
  }
  let n = 0;
  for (const m of targets) {
    try {
      await sendOne(m.openid, data, page, ctx);
      n++;
    } catch (e) {
      // 未授权 / 一次性额度用完 / 模板字段不匹配，都会静默失败 —— 打日志，好在控制台排查
      console.warn('[remind] 推送失败 openid=' + m.openid,
        (e && e.errCode) || '', (e && (e.errMsg || e.message)) || e);
    }
  }
  return n;
}

// ============================================================
// 动作：有人点菜后，通知同空间的其他家人
// ------------------------------------------------------------
// 字段名 thing1 / thing2 / time3 必须与你在 mp 后台选用的模板一致。
// 若你选的模板字段名不同（如 thing1/name2/date3），改这里的键名即可，
// 对照「订阅消息 -> 我的模板 -> 详情」里列出的字段名。
// ============================================================
async function orderNotify(event) {
  if (!ORDER_TEMPLATE_ID) return { success: true, skipped: true, reason: '未配置点菜通知模板ID' };
  const { spaceId, dish, byName } = event || {};
  if (!spaceId) return { success: false, errMsg: '缺少 spaceId' };
  // 现在由前端直接调用本函数（不再经 content 中转），下单人身份从调用上下文取，避免通知自己
  const byOpenid = (event && event.byOpenid) || (cloud.getWXContext && cloud.getWXContext().OPENID) || '';

  const members = await db.collection('members').where({ spaceId }).limit(200).get();
  const openids = members.data.map(m => m.openid).filter(o => o && o !== byOpenid);  // 不通知下单人自己
  if (!openids.length) return { success: true, sent: 0, skipped: 0 };

  // 读取这些成员的「接收家庭通知」偏好（存在 users 里，默认开启）
  const off = new Set();
  try {
    const us = await db.collection('users').where({ _id: _.in(openids) }).limit(200).get();
    us.data.forEach(u => { if (u.notifyOn === false) off.add(u._id); });
  } catch (e) { /* users 还没有记录时忽略，视为默认开启 */ }

  let sent = 0, skipped = 0;
  for (const oid of openids) {
    if (off.has(oid)) { skipped++; continue; }
    try {
      await sendOne(oid, {
        thing1: { value: String(dish || '有新点菜').slice(0, 20) },
        thing2: { value: String(byName || '家人').slice(0, 20) },
        time3: { value: fmt(new Date()) }
      }, 'pages/order/order', {
        content: String(dish || '有新点菜').slice(0, 20),
        time: fmt(new Date()),
        from: String(byName || '家人').slice(0, 20),
        type: '点菜提醒',
        detail: String(dish || '').slice(0, 20)
      }, ORDER_TEMPLATE_ID);
      sent++;
    } catch (e) {
      skipped++;   // 未授权该模板 / 一次性额度已用完 → 跳过，不影响主流程
      console.warn('[remind] 点菜通知推送失败 openid=' + oid,
        (e && e.errCode) || '', (e && (e.errMsg || e.message)) || e);
    }
  }
  return { success: true, sent, skipped };
}

// 入口：定时触发器不带 action（走扫描提醒）；其他云函数调用时带 action
exports.main = async (event = {}) => {
  if (event.action === 'orderNotify') {
    try { return await orderNotify(event); }
    catch (e) { return { success: false, errMsg: e.message }; }
  }

  // 测试推送：给调用者本人立刻发一条，把微信的原始结果带回来，方便定位「为什么收不到」
  if (event.action === 'testPush') {
    if (!TEMPLATE_ID) return { success: false, errMsg: '未配置提醒模板 ID（remind/localConfig.js）' };
    const openid = (cloud.getWXContext() || {}).OPENID;
    if (!openid) return { success: false, errMsg: '拿不到 openid' };
    try {
      await sendOne(openid, {
        thing1: { value: '测试提醒' },
        thing2: { value: '收到说明通道正常' },
        time3: { value: fmt(new Date()) }
      }, 'pages/todo/todo', {
        content: '测试提醒', time: fmt(new Date()),
        from: '我', type: '测试提醒', detail: '收到说明通道正常'
      });
      return { success: true, errCode: 0, errMsg: 'ok' };
    } catch (e) {
      return {
        success: false,
        errCode: (e && e.errCode) || 0,
        errMsg: (e && (e.errMsg || e.message)) || String(e)
      };
    }
  }

  // 自检：报告「已到点却还没推送」的提醒。
  // 判断依据：定时任务只要跑过，就会把推过的记录标成 notified=true；
  // 所以若存在「到点但 notified 仍为 false」的记录 → 每分钟的定时触发没在执行。
  if (event.action === 'diag') {
    const openid = (cloud.getWXContext() || {}).OPENID || '';
    const now = new Date();
    const nowStr = fmtLocal(now);
    const [dueAll, mineRes] = await Promise.all([
      queryDue('todos', now, nowStr),
      db.collection('todos').where({ _openid: openid }).limit(50)
        .get().catch(() => ({ data: [] }))
    ]);
    const overduePending = (dueAll || [])
      .filter(x => x._openid === openid)
      .map(x => ({ content: x.content || '待办', at: atText(x.notifyAt) }));
    const pending = (mineRes.data || [])
      .filter(x => x.notifyAt && !x.notified)
      .map(x => ({ content: x.content || '待办', at: atText(x.notifyAt) }))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return {
      success: true,
      nowBj: fmt(now),
      templateOk: !!TEMPLATE_ID,
      overduePending,   // 已到点但没推送 → 定时任务没跑（或推送失败）
      pending
    };
  }

  // 每分钟触发：扫描到期且未推送的提醒，向空间成员发送订阅消息（成员需曾授权该模板）
  if (!TEMPLATE_ID) return { success: true, skipped: true, reason: '未配置模板ID' };
  try {
    const nowDate = new Date();
    const nowStr = fmtLocal(nowDate);
    let sent = 0, checked = 0;

    // 1) 待办上的提醒（「定时提醒」已合并进「待办」，提醒时间存在 todos.notifyAt）
    for (const r of await queryDue('todos', nowDate, nowStr)) {
      checked++;
      // 超过 24 小时的旧提醒不再补推（比如定时器积压了一整天），
      // 直接标记已处理，避免"一修好就一次性轰炸一堆过期提醒"。
      const at = r.notifyAt ? new Date(r.notifyAt).getTime() : 0;
      if (at && nowDate.getTime() - at > 24 * 3600 * 1000) {
        await db.collection('todos').doc(r._id).update({ data: { notified: true } }).catch(() => {});
        continue;
      }
      // 提醒对象：'me' 只提醒创建者；数组 = 指定成员；其它（老数据 / 'all'）= 全家人
      let targets;
      if (r.notifyTo === 'me') targets = [r._openid].filter(Boolean);
      else if (Array.isArray(r.notifyTo) && r.notifyTo.length) targets = r.notifyTo;
      // 推送内容：待办正文 + 模板额外字段的含义（发起人 / 类型 / 菜品名等）
      const content = r.content || '待办';
      const dish = content.indexOf('：') > 0 ? content.split('：').pop() : '';
      const fromName = await nameOf(r.spaceId, r._openid);
      try {
        sent += await notifySpace(r.spaceId, {
          thing1: { value: content.slice(0, 20) },
          thing2: { value: '家里的待办提醒' },
          time3: { value: atText(r.notifyAt) }
        }, 'pages/todo/todo', targets, {
          content: content.slice(0, 20),
          time: atText(r.notifyAt),
          from: fromName,
          type: content.indexOf('吃饭') >= 0 ? '点菜提醒' : '待办提醒',
          detail: (dish || content).slice(0, 20)
        });
        await db.collection('todos').doc(r._id).update({ data: { notified: true } });
      } catch (e) {
        // 单条失败（未授权 / 一次性额度用完等）不再中断整轮扫描，其它提醒照发；
        // 不标记 notified，下一分钟还能再试一次。
        console.warn('[remind] 待办提醒推送失败 id=' + r._id,
          (e && (e.errCode || e.errMsg)) || e);
      }
    }

    // 2) 老数据兼容：早期单独建的 reminders 记录继续推（合并前的历史提醒不丢）
    try {
      for (const r of await queryDue('reminders', nowDate, nowStr)) {
        checked++;
        sent += await notifySpace(r.spaceId, {
          thing1: { value: (r.title || '提醒').slice(0, 20) },
          thing2: { value: (r.note || '家里的提醒').slice(0, 20) },
          time3: { value: atText(r.notifyAt) }
        }, 'pages/todo/todo', null, {
          content: (r.title || '提醒').slice(0, 20),
          time: atText(r.notifyAt),
          from: await nameOf(r.spaceId, r._openid),
          type: '待办提醒',
          detail: (r.note || '').slice(0, 20)
        });
        await db.collection('reminders').doc(r._id).update({ data: { notified: true } });
      }
    } catch (e) { /* reminders 集合可能已被清理，忽略 */ }

    // 3) 重要日子（节日）提醒：到点推微信通知；公历节日顺便把 notifyAt 顺延到下一年
    try {
      for (const r of await queryDue('festivals', nowDate, nowStr)) {
        checked++;
        // 提醒谁：'me' 只提醒创建者；数组 = 指定成员；没有这个字段（老数据）= 全家人
        let fTargets = null;
        if (r.notifyTo === 'me' && r._openid) fTargets = [r._openid];
        else if (Array.isArray(r.notifyTo) && r.notifyTo.length) fTargets = r.notifyTo;
        sent += await notifySpace(r.spaceId, {
          thing1: { value: (r.name || '节日').slice(0, 20) },
          thing2: { value: '家里的节日提醒' },
          time3: { value: atText(r.notifyAt) }
        }, 'pages/festival/festival', fTargets, {
          content: (r.name || '节日').slice(0, 20),
          time: atText(r.notifyAt),
          from: await nameOf(r.spaceId, r._openid),
          type: '节日提醒',
          detail: (r.note || '').slice(0, 20)
        });
        let next = null;
        if (!r.isLunar && r.date) {
          // 明确按 +08:00 算「明年这一天的 09:00」，避免云函数时区不同导致顺延偏移
          const bj = new Date(new Date(r.date + 'T09:00:00+08:00').getTime() + 8 * 3600 * 1000);
          const nextStr = (bj.getUTCFullYear() + 1) + '-' + pad(bj.getUTCMonth() + 1) + '-' +
            pad(bj.getUTCDate()) + 'T09:00:00+08:00';
          next = new Date(new Date(nextStr).getTime() - (r.leadDays || 0) * 86400000);
        }
        await db.collection('festivals').doc(r._id).update({ data: next ? { notified: false, notifyAt: next } : { notified: true } });
      }
    } catch (e) { /* festivals 集合异常时忽略，不影响其它提醒 */ }

    if (checked) console.log('[remind] 本分钟到点提醒 checked=' + checked + ' sent=' + sent);
    return { success: true, checked, sent };
  } catch (e) {
    return { success: false, errMsg: e.message };
  }
};
