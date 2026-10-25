// ============================================================
// init 云函数：一键创建本小程序需要的全部数据库集合
//
// 为什么需要它：
//   云开发新建环境后，数据库里是空的，一个集合都没有。
//   而小程序启动时第一个请求就会去查 members 集合，集合不存在会直接报错，
//   表现就是"页面一片空白 / 一直报错"。
//   有了这个云函数，小程序首次打开会自动调用它把集合建好，
//   你就不用去云开发控制台一个一个手工建了。
//
// 特点：可重复执行，已存在的集合会跳过，不会清空任何数据。
// ============================================================
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 整个项目用到的集合
const COLLECTIONS = [
  'spaces',      // 空间（家庭）
  'members',     // 空间成员（含小红花数）
  'users',       // 用户全局资料（微信头像/昵称/背景/会员）——主键 = openid
  'flowerLogs',  // 小红花流水（赚 / 花 / 兑换记录）
  'codes',       // 会员兑换码
  'dishes',      // 家庭菜单（自定义菜品库）
  'orders',      // 家庭点菜 / 接单
  'todos',       // 日常代办
  'festivals',   // 重要节日
  'reminders',   // 定时提醒
  'finance',     // 理财记事（收支流水）
  'plans',       // 理财规划（目标）
  'rewards',     // 家庭自定义兑换项（如「亲亲一次 20 朵」）
  'rewardOrders',// 兑换记录（谁兑了什么、是否已兑现）
  'payOrders',   // 虚拟支付订单（outTradeNo / wxOrderId / 发货状态，幂等去重）
  'detectRooms', // 侦探社答题房间（题目、双方选择、得分、证据快照）
  'detectQuizCache' // 侦探社题库缓存（同一主题 6 小时内复用，省一次搜索）
];

// 判定"集合已存在"这类不需要报错的错误
function isExistsErr(msg) {
  return /already exist|CollectionAlreadyExist|-501001/i.test(msg || '');
}

// 创建一个集合；已存在返回 'existed'，新建成功返回 'created'，失败返回 { error }
async function ensureCollection(name) {
  const col = db.collection(name);

  // 方式一：服务端官方接口（推荐路径）
  if (typeof db.createCollection === 'function') {
    try {
      await db.createCollection(name);
      return 'created';
    } catch (e) {
      const msg = (e && (e.errMsg || e.message)) || String(e);
      if (isExistsErr(msg)) return 'existed';
      // 不是"已存在"，继续尝试方式二
      const byCreateErr = msg;
      const byFallback = await createByWrite(col, name);
      if (byFallback === 'created' || byFallback === 'existed') return byFallback;
      return { error: byCreateErr + ' / 兜底也失败: ' + byFallback.error };
    }
  }

  // 方式二：兜底 —— 云函数里向不存在的集合写入数据会触发集合自动创建，
  // 写一条标记文档后立刻删掉，保证不留垃圾数据。
  return await createByWrite(col, name);
}

async function createByWrite(col, name) {
  try {
    const r = await col.add({ data: { __init: true, createdAt: db.serverDate() } });
    try { await col.doc(r._id).remove(); } catch (e) { /* 删不掉也不影响使用 */ }
    return 'created';
  } catch (e) {
    const msg = (e && (e.errMsg || e.message)) || String(e);
    if (isExistsErr(msg)) return 'existed';
    return { error: msg };
  }
}

exports.main = async () => {
  const created = [];
  const existed = [];
  const failed = [];

  for (const name of COLLECTIONS) {
    const r = await ensureCollection(name);
    if (r === 'created') created.push(name);
    else if (r === 'existed') existed.push(name);
    else failed.push(name + '：' + r.error);
  }

  return {
    success: failed.length === 0,
    total: COLLECTIONS.length,
    created,
    existed,
    failed,
    errMsg: failed.length
      ? ('以下集合创建失败 -> ' + failed.join(' | ') +
         '（若提示权限问题，请在云开发控制台手动新建这些集合：' + COLLECTIONS.join('、') + '）')
      : ''
  };
};
