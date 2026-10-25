// ============================================================
// content 云函数 —— 通用数据读写 + 小红花联动
//
// 允许读写的集合：orders(点菜) / dishes(家庭菜单) / todos / festivals /
//                 reminders / finance / plans
// 所有读写都要校验"你是不是这个空间的成员"，实现空间级数据隔离。
// 业务动作成功后，按规则给用户发小红花（调用 flower 云函数，失败不影响主流程）。
// ============================================================
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLS = ['orders', 'dishes', 'todos', 'festivals', 'reminders', 'finance', 'plans'];
const collOf = (c) => (COLLS.includes(c) ? db.collection(c) : null);

// 前端传的提醒时间是「北京时间墙上时间串」（如 2026-09-22T09:00:00）。
// 云函数环境时区不保证是 +8，直接 new Date() 会差 8 小时，这里显式补上 +08:00。
function parseBJ(s) {
  const t = String(s).trim().replace(' ', 'T');
  const d = new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(t) ? t : t + '+08:00');
  return isNaN(d.getTime()) ? new Date(t) : d;
}

// 新增记录时对应发放的小红花规则（不在这里的表示新增不发花）
const ADD_EARN = {
  orders: 'order_add',
  festivals: 'festival_add',
  reminders: 'reminder_add',
  finance: 'finance_add',
  plans: 'plan_add'
};

// 内部调用 flower 的口令（与 flower/index.js 保持一致）
const INTERNAL_SECRET = 'hsmp-internal-flower-2026';

// 文本内容安全开关：上线前把这里改成 true（需小程序已在后台获得内容安全接口权限）
// 文本内容安全：用户输入展示前过一遍微信 msgSecCheck。
// 接口未开通时会抛错，但 textSafe 内部已 catch 并放行，不会卡死业务。
const ENABLE_TEXT_CHECK = true;

async function isMember(spaceId, openid) {
  const r = await db.collection('members').where({ spaceId, openid }).count();
  return r.total > 0;
}

// 会员是否有效：读 users.memberUntil（服务端为准），到期则拒绝一切写入类操作。
// 查不到用户时默认放行，避免新用户/缓存异常被误伤。
async function memberActive(openid) {
  try {
    const u = await db.collection('users').doc(openid).get();
    const until = (u && u.data && u.data.memberUntil) || 0;
    return until > Date.now();
  } catch (e) {
    return true;
  }
}

// ---- 云存储图片：服务端批量换成临时链接，随列表一起返回 ----
// 为什么放服务端：云存储权限默认「仅创建者可读写」，小程序端换"别人上传的图"的链接会失败，
// 表现就是家人看不到菜品图 / 背景图 / 头像；云函数（服务端）始终拥有全部文件读写权限。
// 放在 list 里一起返回 = 客户端不必再多打一次云函数（零额外往返）。
// 字段约定：原字段 image → 追加 imageUrl（前端 imgUrl 优先用它）。
async function withImgUrls(list, fields) {
  const arr = list || [];
  const fs = fields || ['image'];
  const ids = [];
  arr.forEach(x => fs.forEach(f => {
    const v = x && x[f];
    if (typeof v === 'string' && v.indexOf('cloud://') === 0 && ids.indexOf(v) < 0) ids.push(v);
  }));
  if (!ids.length) return arr;
  const map = {};
  for (let i = 0; i < ids.length; i += 50) {
    const r = await cloud.getTempFileURL({ fileList: ids.slice(i, i + 50) }).catch(() => null);
    ((r && r.fileList) || []).forEach(f => {
      if (f && f.fileID && f.tempFileURL) map[f.fileID] = f.tempFileURL;
    });
  }
  if (!Object.keys(map).length) return arr;
  return arr.map(x => {
    if (!x) return x;
    const patch = {};
    fs.forEach(f => { const v = x[f]; if (typeof v === 'string' && map[v]) patch[f + 'Url'] = map[v]; });
    return Object.keys(patch).length ? Object.assign({}, x, patch) : x;
  });
}

// 写入类操作前的会员校验；到期返回拒绝对象，调用方直接 return。
async function ensureMember(OPENID) {
  if (await memberActive(OPENID)) return null;
  return { success: false, code: 'MEMBER_EXPIRED', errMsg: '会员已到期，请续费后再操作' };
}

// 发小红花（走 flower 云函数，单点维护规则；失败只记日志，不影响业务动作）
// 返回：本次实际发到几朵（0 = 没发到，如撞上限/重复），供前端做暖心提示
async function grantFlower(spaceId, openid, rule, refId, label) {
  try {
    const r = await cloud.callFunction({
      name: 'flower',
      data: { _token: INTERNAL_SECRET, action: 'earn', openid, spaceId, rule, refId: refId || '', label: label || '' }
    });
    const res = (r && r.result) || {};
    return (res.success && res.delta) ? res.delta : 0;
  } catch (e) {
    console.warn('[grantFlower] 发花失败：', rule, e && e.message);
    return 0;
  }
}

// 我在该空间的小红花余额（操作后直接回给前端，省掉一次 balance 调用）
async function myFlowers(spaceId, openid) {
  try {
    const m = await db.collection('members').where({ spaceId, openid }).limit(1).get();
    return (m.data[0] && m.data[0].flowers) || 0;
  } catch (e) { return 0; }
}

// 文本内容安全检测（异步、失败放行，避免接口未开通时卡死业务）
async function textSafe(content, openid) {
  if (!ENABLE_TEXT_CHECK || !content) return true;
  try {
    const r = await cloud.openapi.security.msgSecCheck({
      version: 2, openid, scene: 2, content: String(content).slice(0, 2500)
    });
    return !(r.result && r.result.suggest === 'risky');
  } catch (e) {
    return true;
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action, coll } = event;
  // 少数动作不需要 coll 参数（首页聚合 homeSummary、批量下单 submitOrders），
  // 不能因为没传 coll 就在这里被误判成「非法集合」而挡回。
  const NO_COLL_ACTIONS = ['homeSummary', 'submitOrders'];
  const col = collOf(coll);
  if (!col && NO_COLL_ACTIONS.indexOf(action) < 0) return { success: false, errMsg: '非法集合' };

  try {
    // ---------------- 列表 ----------------
    if (action === 'list') {
      if (!(await isMember(event.spaceId, OPENID))) return { success: false, errMsg: '无权访问该空间' };
      const orderField = event.orderBy || 'createdAt';
      const orderDir = event.orderDir || 'desc';
      const res = await col.where({ spaceId: event.spaceId }).orderBy(orderField, orderDir).limit(200).get();
      // 图片链接随列表一起返回（客户端就不用再单独调一次 fileUrls 了）
      return { success: true, list: await withImgUrls(res.data) };
    }

    // ---------------- 云存储 fileID → 临时链接（服务端换取） ----------------
    // 为什么必须走服务端：云存储权限若设成「仅创建者可读写」（默认就是），
    // 小程序端 getTempFileURL 对"别人上传的图"会失败 —— 表现就是家人看不到菜品图/家庭背景图。
    // 而云函数（服务端）始终拥有全部文件读写权限，所以在这里换取链接再回传。
    if (action === 'fileUrls') {
      const ids = (event.ids || [])
        .filter(x => typeof x === 'string' && x.indexOf('cloud://') === 0)
        .slice(0, 50);
      if (!ids.length) return { success: true, urls: {} };
      const r = await cloud.getTempFileURL({ fileList: ids }).catch(() => null);
      const urls = {};
      ((r && r.fileList) || []).forEach(f => {
        if (f && f.fileID && f.tempFileURL) urls[f.fileID] = f.tempFileURL;
      });
      return { success: true, urls };
    }

    // ---------------- 公共菜单：跨家庭可见的公开菜（不加空间隔离） ----------------
    if (action === 'listPublic') {
      const res = await col.where({ public: true }).orderBy('createdAt', 'desc').limit(200).get();
      const list = (res.data || []).map(d => Object.assign({}, d, {
        // 当前用户是否已点赞过 + 点赞人数（用来控制「一个菜只能赞一次」）
        hasLiked: (d.likes || []).includes(OPENID),
        likeCount: (d.likes || []).length,
        // 公共菜单显示创建用户 + 标记「是不是我公开的」（用来决定显示「取消公开」还是「添加」）
        creatorName: d.creatorName || '',
        mine: d._openid === OPENID
      }));
      return { success: true, list: await withImgUrls(list) };
    }

    // ---------------- 公共菜单：点赞 / 点赞 1 朵小红花（每道菜每人限一次） ----------------
    if (action === 'likeDish') {
      const deny = await ensureMember(OPENID);
      if (deny) return deny;
      const doc = await col.doc(event._id).get();
      if (!doc.data) return { success: false, errMsg: '记录不存在' };
      if (!doc.data.public) return { success: false, errMsg: '这道菜已不在公共菜单' };
      const likes = doc.data.likes || [];
      if (likes.includes(OPENID)) return { success: true, already: true, likeCount: likes.length };
      const author = doc.data._openid;
      if (author === OPENID) return { success: false, errMsg: '不能给自己的菜点赞' };
      const mySpace = event.spaceId;
      if (!mySpace) return { success: false, errMsg: '请先进入一个空间' };
      // 点赞从「点赞者当前所在家庭」余额扣 1 朵
      const meM = await db.collection('members').where({ spaceId: mySpace, openid: OPENID }).limit(1).get();
      if (!meM.data.length) return { success: false, errMsg: '你还不是该空间的成员' };
      const meDoc = meM.data[0];
      if ((meDoc.flowers || 0) < 1) return { success: false, errMsg: '小红花不够，还差 1 朵' };
      await db.collection('members').doc(meDoc._id).update({ data: { flowers: _.inc(-1) } });
      await db.collection('flowerLogs').add({
        data: { spaceId: mySpace, openid: OPENID, delta: -1, reason: 'tip_out', label: '点赞：' + (doc.data.name || '菜'), createdAt: db.serverDate() }
      });
      // 给作者加 1 朵（累计获得同步 +1）
      const aM = await db.collection('members').where({ spaceId: doc.data.spaceId, openid: author }).limit(1).get();
      if (aM.data.length) {
        await db.collection('members').doc(aM.data[0]._id).update({ data: { flowers: _.inc(1), earnedTotal: _.inc(1) } });
        await db.collection('flowerLogs').add({
          data: { spaceId: doc.data.spaceId, openid: author, delta: 1, reason: 'dish_tip', label: '收到点赞：' + (doc.data.name || '菜'), createdAt: db.serverDate() }
        });
      }
      await col.doc(event._id).update({ data: { likes: _.push(OPENID) } });
      return { success: true, likeCount: likes.length + 1, hasLiked: true };
    }

    // ---------------- 新增 ----------------
    if (action === 'add') {
      const deny = await ensureMember(OPENID);
      if (deny) return deny;
      const data = event.data || {};
      if (!data.spaceId) return { success: false, errMsg: '缺少 spaceId' };
      if (!(await isMember(data.spaceId, OPENID))) return { success: false, errMsg: '无权访问该空间' };

      // 文本安全（帖子正文 / 菜品名）
      const textToCheck = data.content || data.text || data.name || '';
      if (!(await textSafe(textToCheck, OPENID))) return { success: false, errMsg: '内容包含违规信息，请修改后再发' };

      const doc = Object.assign({}, data, { _openid: OPENID, createdAt: db.serverDate() });
      // 提醒时间存为真实 Date，保证定时触发器可按时间比对。
      // ⚠️ 必须补 +08:00：前端传的是北京时间墙上时间（如 2026-09-22T09:00:00），
      //    云函数按 UTC 解析会整体差 8 小时，提醒会晚 8 小时才发。
      if (doc.notifyAt && typeof doc.notifyAt === 'string') doc.notifyAt = parseBJ(doc.notifyAt);
      // 公共菜单：初始化点赞名单（空），支撑「点赞 / 一个菜只能赞一次」
      if (coll === 'dishes') { doc.likes = []; }
      // 点菜初始化：待接单
      if (coll === 'orders') {
        doc.status = 'pending'; doc.taker = ''; doc.takerName = ''; doc.done = false;
      }
      const r = await col.add({ data: doc });

      const rule = ADD_EARN[coll];
      let earned = 0;
      if (rule) {
        // 明细里写具体内容（如「点了 番茄炒蛋」），比笼统的「点了一道菜」可追溯
        const nm = (data.name || data.content || '').toString().trim();
        const lb = coll === 'orders' ? ('点了 ' + nm) : nm;
        earned = await grantFlower(data.spaceId, OPENID, rule, r._id, lb);
      }

      // 通知家人统一由前端在下单成功后异步触发（这里不再重复通知，避免一条订单发两次）
      return { success: true, _id: r._id, earned };
    }

    // ---- 首页聚合：一次往返拿齐首页要的数据 ----
    // 原来前端要并发 6 次云调用（todos/festivals/finance/orders/dishes/花朵），
    // 网络往返叠加起来就是"进首页要等一下"的主因。改成一次调用在服务端内并行查。
    if (action === 'homeSummary') {
      const spaceId = event.spaceId;
      if (!spaceId) return { success: false, errMsg: '缺少 spaceId' };
      if (!(await isMember(spaceId, OPENID))) return { success: false, errMsg: '无权访问该空间' };

      const empty = { data: [] };
      const [todos, festivals, finance, orders, dishes, me] = await Promise.all([
        db.collection('todos').where({ spaceId }).limit(200).get().catch(() => empty),
        db.collection('festivals').where({ spaceId }).limit(200).get().catch(() => empty),
        db.collection('finance').where({ spaceId }).limit(200).get().catch(() => empty),
        db.collection('orders').where({ spaceId }).limit(200).get().catch(() => empty),
        db.collection('dishes').where({ spaceId }).limit(200).get().catch(() => empty),
        db.collection('members').where({ spaceId, openid: OPENID }).limit(1).get().catch(() => ({ data: [] }))
      ]);
      const m = (me.data && me.data[0]) || {};
      return {
        success: true,
        todos: todos.data || [],
        festivals: festivals.data || [],
        finance: finance.data || [],
        orders: orders.data || [],
        dishes: dishes.data || [],
        flowers: m.flowers || 0,
        earnedTotal: m.earnedTotal || 0
      };
    }

    // ---- 批量下单：一次调用完成「扣花 + 点菜得花 + 写订单」----
    // 性能要点（之前"下单慢/超时"的根因）：原本是「1 次扣花 + 每道菜 1 次发花 + 1 次通知家人」
    // 串起来要启动 3~5 次别的云函数，冷启动一个就要一两秒，必然超时。
    // 现在：① 会员校验并行；② 扣花与"点菜得花"合并成 1 次调用；③ 订单并行写入；④ 通知交给前端异步发。
    if (action === 'submitOrders') {
      const spaceId = event.spaceId;
      if (!spaceId) return { success: false, errMsg: '缺少 spaceId' };
      const list = (event.items || []).filter(x => x && (x.name || x.dishId));
      if (!list.length) return { success: true, cost: 0, count: 0, ids: [] };

      // 1) 会员校验：两次查询并行，省一个网络往返
      const [deny, member] = await Promise.all([
        ensureMember(OPENID),
        isMember(spaceId, OPENID)
      ]);
      if (deny) return deny;
      if (!member) return { success: false, errMsg: '无权访问该空间' };

      // 2) 扣花 + 点菜加花：合并成一次云调用（earnPerDish 让 flower 顺手把花发了）
      const pay = await cloud.callFunction({
        name: 'flower',
        data: { _token: INTERNAL_SECRET, action: 'orderPay', openid: OPENID, spaceId, items: list, earnPerDish: true }
      }).catch(() => null);
      const pr = (pay && pay.result) || {};
      if (!pr.success) return { success: false, errMsg: pr.errMsg || '小红花不够' };

      // 3) 写订单：并行写入，多道菜不再串行累加延迟
      const byName = (event.byName || '').slice(0, 24);
      const created = await Promise.all(list.map(it => db.collection('orders').add({
        data: {
          spaceId, name: it.name || '菜', qty: Math.max(1, parseInt(it.qty, 10) || 1),
          image: it.image || '', dishId: it.dishId || '', byName,
          // 下单时选的用餐日期（选填）：饭桌页会显示「用餐 明天」这类提示
          mealDate: event.mealDate || '',
          mealDateText: String(event.mealDateText || '').slice(0, 20),
          mealTime: String(event.mealTime || '').slice(0, 5),
          status: 'pending', _openid: OPENID, createdAt: db.serverDate()
        }
      }).catch(() => null)));
      const ids = created.filter(Boolean).map(r => r._id);

      // 4) 通知家人不在这里做（它要遍历成员逐个发订阅消息，是最慢的一步），
      //    改由前端下单成功后异步触发，不阻塞下单结果返回。
      return { success: true, cost: pr.cost || 0, count: ids.length, ids, earned: pr.earned || 0 };
    }

    // 以下动作都要先校验文档归属
    if (['update', 'toggle', 'remove', 'takeOrder', 'finishOrder'].includes(action)) {
      const deny = await ensureMember(OPENID);
      if (deny) return deny;
      const doc = await col.doc(event._id).get();
      if (!doc.data) return { success: false, errMsg: '记录不存在' };
      if (!(await isMember(doc.data.spaceId, OPENID))) return { success: false, errMsg: '无权操作' };

      if (action === 'update') {
        // 公开菜取消公开只能本人操作：防止别人把你的公开菜从公共菜单里摘掉
        // （别人已「加入家庭」的副本是独立文档，不受影响，所以「取消公开只对自己生效」）
        if (coll === 'dishes' && event.data && event.data.public === false && doc.data.public && doc.data._openid !== OPENID) {
          return { success: false, errMsg: '只能取消自己公开的菜' };
        }
        const patch = Object.assign({}, event.data);
        // 改了提醒时间或提醒对象 → 重置「已提醒」标记，否则改完永远不会再提醒
        if (coll === 'todos' && (patch.notifyAt || patch.notifyTo)) {
          if (typeof patch.notifyAt === 'string') patch.notifyAt = parseBJ(patch.notifyAt);
          patch.notified = false;
        }
        await col.doc(event._id).update({ data: patch });
        return { success: true };
      }

      if (action === 'toggle') {
        const field = event.field || 'done';
        const nextVal = !doc.data[field];
        await col.doc(event._id).update({ data: { [field]: nextVal } });
        // 待办完成 → 发小红花（逾期完成给的少）
        let earned = 0;
        if (coll === 'todos' && field === 'done' && nextVal) {
          const late = doc.data.dueAt && new Date(doc.data.dueAt).getTime() < Date.now();
          earned = await grantFlower(doc.data.spaceId, OPENID, late ? 'todo_late' : 'todo_done', event._id);
        }
        return { success: true, earned, done: nextVal };
      }

      if (action === 'remove') {
        await col.doc(event._id).remove();
        return { success: true };
      }

      // 家庭点菜：接单认领（谁去买 / 谁来做）
      if (action === 'takeOrder') {
        if (doc.data.taker) return { success: false, errMsg: '这道菜已经有人接啦' };
        await col.doc(event._id).update({
          data: { taker: OPENID, takerName: event.nickName || '', status: 'taken', takeAt: db.serverDate() }
        });
        const earned = await grantFlower(doc.data.spaceId, OPENID, 'order_take', event._id, '接了 ' + (doc.data.name || '菜'));
        // 顺带回最新余额：前端就不用再打一次 balance
        return { success: true, earned, flowers: await myFlowers(doc.data.spaceId, OPENID) };
      }

      // 家庭点菜：标记完成（奖励给接单人；没人接则给操作者）
      if (action === 'finishOrder') {
        if (doc.data.status === 'done') return { success: true, already: true };
        await col.doc(event._id).update({
          data: { status: 'done', done: true, doneAt: db.serverDate(), doneBy: OPENID }
        });
        const granted = await grantFlower(doc.data.spaceId, doc.data.taker || OPENID, 'order_done', event._id, '做完了 ' + (doc.data.name || '菜'));
        // 花发给「接单人」：接单人是别人时不提示，避免没给你加花却弹给你
        return {
          success: true,
          earned: (!doc.data.taker || doc.data.taker === OPENID) ? granted : 0,
          flowers: await myFlowers(doc.data.spaceId, OPENID)
        };
      }
    }

    return { success: false, errMsg: '未知操作' };
  } catch (e) {
    return { success: false, errCode: (e && e.errCode) || 0, errMsg: (e && (e.errMsg || e.message)) || String(e) };
  }
};
