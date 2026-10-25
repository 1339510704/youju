const bg = require('../../utils/bg.js');

Page({
  data: {
    tab: 'privacy',
    updated: '2026-09-17',
    appName: '黍离lite',
    diag: { sdk: false, db: false }
  },

  onShow() {
    const g = (getApp() || {}).globalData || {};
    this.setData({ diag: { sdk: !!g.cloudInited, db: !!g.dbReady } });
    bg.apply(this);
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.t });
    wx.pageScrollTo({ scrollTop: 0, duration: 120 });
  }
});
