const { call, fileUrls } = require('../../utils/cloud.js');
const bg = require('../../utils/bg.js');
const { ensureSpace } = require('../../utils/guard.js');
const flower = require('../../utils/flower.js');

Page({
  data: { space: null, list: [], myIndex: -1, myFlowers: 0, myEarned: 0, myBadge: null, canManage: false },

  onLoad(options) {
    this._spaceId = (options && options.spaceId) || '';
  },

  onShow() { this.load(); bg.apply(this); },

  async load() {
    const app = getApp();
    await app.ensureReady();
    const g = app.globalData;
    let space = g.currentSpace;
    if (this._spaceId) {
      const sp = (g.spaces || []).find(s => s._id === this._spaceId) || null;
      if (sp) space = sp;
    }
    if (!space) { ensureSpace(); return; }
    const myOpenid = g.openid || '';
    const myRole = space.role;
    const canManage = myRole === 'owner' || myRole === 'admin';
    const r = await call('flower', { action: 'rank', spaceId: space._id }).catch(() => null);
    if (!r) { wx.showToast({ title: '加载失败', icon: 'none' }); return; }
    const list = (r.list || []).map((x, i) => Object.assign({}, x, {
      no: i + 1,
      initial: (x.nickName || '成').slice(0, 1),
      roleName: flower.roleName(x.role),
      isMe: x.openid === myOpenid
    }));
    // 成员头像也是云存储文件：走云函数换链接，否则家人互相看不到头像
    const avIds = list.map(x => x.avatarUrl).filter(x => x && String(x).indexOf('cloud://') === 0);
    let shown = list;
    if (avIds.length) {
      const map = await fileUrls(avIds);
      if (Object.keys(map).length) {
        shown = list.map(x => (x.avatarUrl && map[x.avatarUrl])
          ? Object.assign({}, x, { avatarUrl: map[x.avatarUrl] }) : x);
      }
    }
    const myEarned = (r.myIndex >= 0 && list[r.myIndex]) ? (list[r.myIndex].earnedTotal || 0) : 0;
    const myBadge = flower.badgeOf(myEarned);
    this.setData({
      space, list: shown, myIndex: r.myIndex, myFlowers: r.myFlowers, myBadge, myEarned,
      canManage
    });
  },

  goVip() { wx.switchTab({ url: '/pages/vip/vip' }); },

  // 升管理 / 降成员（仅户主 / 管理员可见）
  async mToggleRole(e) {
    const { openid, role } = e.currentTarget.dataset;
    wx.showLoading({ title: '处理中' });
    await call('space', {
      action: 'setRole', spaceId: this.data.space._id,
      targetOpenid: openid, role: role === 'admin' ? 'member' : 'admin'
    }).catch(() => {});
    wx.hideLoading();
    this.load();
  },

  // 移除成员（仅户主 / 管理员可见）
  async mKick(e) {
    const openid = e.currentTarget.dataset.openid;
    wx.showModal({
      title: '移除成员', content: '确定移出该成员？',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '移除中' });
        await call('space', {
          action: 'removeMember', spaceId: this.data.space._id, targetOpenid: openid
        }).catch(() => {});
        wx.hideLoading();
        this.load();
      }
    });
  }
});
