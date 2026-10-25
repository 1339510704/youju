// ============================================================
// stats 云函数 —— 一次性数据聚合（只读，不改任何数据）
//
// 用途：让开发者/运营拿到小程序真实使用数据的汇总指标，
//       用于找流失点、增长机会。在云开发控制台「测试」里跑一次即可。
// 注意：本函数不做任何写操作，可放心反复运行。
// ============================================================
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const DAY = 86400000;
const ago = n => new Date(Date.now() - n * DAY);

async function cnt(name, where) {
  const r = await db.collection(name).where(where || {}).count();
  return r.total;
}

exports.main = async () => {
  const out = { generatedAt: new Date().toISOString() };

  // 家庭空间
  out.spaces = {
    total: await cnt('spaces'),
    last7d: await cnt('spaces', { _createTime: _.gte(ago(7)) }),
    last30d: await cnt('spaces', { _createTime: _.gte(ago(30)) })
  };

  // 成员 / 用户
  out.members = { total: await cnt('members') };
  out.users = { total: await cnt('users') };
  out.newMembers30d = await cnt('members', { _createTime: _.gte(ago(30)) });

  // 小红花日志 = 活跃行为原始流水
  out.flowerLogs = {
    total: await cnt('flowerLogs'),
    last7d: await cnt('flowerLogs', { _createTime: _.gte(ago(7)) }),
    last30d: await cnt('flowerLogs', { _createTime: _.gte(ago(30)) })
  };
  // 近30天活跃独立用户（按 openid 去重）
  try {
    const active = await db.collection('flowerLogs')
      .aggregate().match({ _createTime: _.gte(ago(30)) })
      .group({ _id: '$openid' }).end();
    out.activeUsers30d = active.list.length;
  } catch (e) { out.activeUsers30d = '聚合失败:' + e.message; }

  // 待办完成率
  const todoTotal = await cnt('todos');
  const todoDone = await cnt('todos', { status: 'done' });
  out.todos = {
    total: todoTotal,
    done: todoDone,
    rate: todoTotal ? +(todoDone / todoTotal * 100).toFixed(1) : 0
  };

  // 点菜订单
  out.orders = {
    total: await cnt('orders'),
    last30d: await cnt('orders', { _createTime: _.gte(ago(30)) })
  };

  // 兑换码
  out.codes = {
    total: await cnt('codes'),
    used: await cnt('codes', { usedCount: _.gte(1) }),
    expired: await cnt('codes', { expiresAt: _.lt(new Date()) })
  };

  // 背景解锁人数
  out.bgUnlocked = await cnt('users', { bgUnlock: true });

  return { success: true, stats: out };
};
