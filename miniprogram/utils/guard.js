// 空间守卫：确保已选中空间；没有则跳到「我的」页让用户创建/加入
// 顺便触发一次云开发就绪检查（如果数据库还没建，会自动建好）
async function ensureSpace() {
  const app = getApp();

  // 顺带做一次就绪检查，用户直接从某个 tab 进来也能自动初始化
  await app.ensureReady();

  const space = app.globalData.currentSpace;
  if (!space) {
    // 回「家」页（首页有「创建家庭 / 用邀请码加入」的完整引导）。
    // 用 navigateTo 的话，饭桌/红花这类 tab 页会被反复压栈，最后只剩一个「加载中…」的死页面。
    wx.switchTab({ url: '/pages/home/home', fail: () => wx.navigateTo({ url: '/pages/mine/mine' }) });
    return null;
  }
  return space;
}

module.exports = { ensureSpace };
