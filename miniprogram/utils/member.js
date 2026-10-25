// 会员状态工具：到期判断 + 写入拦截
// 会员期限存在 users.memberUntil（服务端在 extendMember / 虚拟支付发货 / 兑换码时更新）。
// 这里只做前端判断与拦截——真正的"到期"以服务端 memberUntil 为准，本工具只读全局 profile 快照。

// 拿全局 profile（冷启动前可能还没加载，此时按"未到期"放行，避免误伤）
function getProfile() {
  try { return getApp().globalData.profile || {}; } catch (e) { return {}; }
}

// 返回会员状态：{ expired, daysLeft, until }
function status() {
  const p = getProfile();
  const until = (p && p.memberUntil) || 0;   // 0 = 还没加载到
  const now = Date.now();
  // 没加载到（until 为 0）一律当「有效」：避免冷启动 profile 还没回来就误弹到期。
  // 真正过期的账号 memberUntil 是一个「过去的时间戳」( > 0 但 <= now )，不会被误判成有效。
  const expired = until ? until <= now : false;
  const daysLeft = until ? Math.max(0, Math.ceil((until - now) / 86400000)) : 0;
  return { expired, daysLeft, until };
}

// 会员是否有效（未到期）
function isActive() {
  return !status().expired;
}

// 写入类动作开头调用：
//   - 会员有效 → 返回 false，调用方继续正常执行；
//   - 已到期   → 弹续费引导，返回 true，调用方应直接 return 中断本次写入。
// actionLabel 比如 "点菜"、"记一笔"、"加待办"，用于提示文案更贴心。
function guard(actionLabel) {
  if (isActive()) return false;
  const label = actionLabel ? '「' + actionLabel + '」' : '';
  wx.showModal({
    title: '会员已到期',
    content: '免费试用已结束，' + label + '等功能需续费后使用。',
    confirmText: '去续费',
    cancelText: '用兑换码',
    success(res) {
      if (res.confirm) {
        wx.navigateTo({ url: '/pages/profile/profile' });
      } else if (res.cancel) {
        wx.navigateTo({ url: '/pages/settings/settings' });
      }
    }
  });
  return true;
}

module.exports = { status, isActive, guard };
