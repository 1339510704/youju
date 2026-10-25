const { call, pickImage, uploadImage } = require('../../utils/cloud.js');
const flower = require('../../utils/flower.js');
const bg = require('../../utils/bg.js');

Page({
  data: {
    nickName: '', avatarUrl: '', uploading: false, saving: false,
    bg: { type: 'default', value: '' },
    bgStyle: '',
    member: null,
    space: null,
    spaceBg: { url: '', valid: false, daysLeft: 0 },
    spaceBgText: ''
  },

  onShow() {
    this.load();
    bg.apply(this);
  },

  async load() {
    const app = getApp();
    await app.ensureReady();
    const p = app.globalData.profile || {};
    const space = app.globalData.currentSpace || null;
    const spaceBg = flower.spaceBgInfo(space, p);
    this.setData({
      nickName: p.nickName || '',
      avatarUrl: p.avatarUrl || '',
      bg: p.bg || { type: 'default', value: '' },
      space, spaceBg,
      spaceBgText: this.bgText(spaceBg)
    });
    await bg.apply(this);   // 资料加载完再刷一次背景（含透明度）
  },

  fmtDate(ms) {
    const d = new Date(ms);
    const pad = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  },

  bgText(info) {
    if (info && info.mode === 'member') return '全家共用 · 传过就一直显示';
    return '传一张图，全家人都能看到';
  },

  // 微信头像：点了就拿到微信头像（微信规定必须用户主动点，不能后台自动读）
  async onChooseAvatar(e) {
    const tmp = e.detail && e.detail.avatarUrl;
    if (!tmp) return;
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中' });
    try {
      const fileID = await uploadImage(tmp, 'avatars');
      this.setData({ avatarUrl: fileID });
      await this.save(true);
    } catch (err) {
      wx.showToast({ title: '头像上传失败，请重试', icon: 'none' });
    }
    wx.hideLoading();
    this.setData({ uploading: false });
  },

  onNick(e) { this.setData({ nickName: e.detail.value }); },

  goBgSet() { wx.navigateTo({ url: '/pages/bg-set/bg-set' }); },

  // 家庭背景图：传到空间上，全家可见；没解锁就是 3 天试用
  async chooseSpaceBg() {
    const app = getApp();
    const space = app.globalData.currentSpace;
    if (!space) { wx.showToast({ title: '还没有加入空间', icon: 'none' }); return; }
    let paths;
    try { paths = await pickImage(1); } catch (e) { return; }
    if (!paths.length) return;
    wx.showLoading({ title: '上传中' });
    try {
      const fileID = await uploadImage(paths[0], 'backgrounds');
      await call('space', {
        action: 'setBg', spaceId: space._id, bgImage: fileID,
        byName: app.globalData.nickName || ''
      });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '上传失败，请重试', icon: 'none' });
      return;
    }
    wx.hideLoading();
    await app.refreshSpaces(space._id);
    wx.showToast({ title: '已设置', icon: 'none' });
    this.load();
  },

  async clearSpaceBg() {
    const app = getApp();
    const space = app.globalData.currentSpace;
    if (!space) return;
    const res = await new Promise(resolve => wx.showModal({
      title: '恢复默认背景', content: '把家里的背景图撤掉，全家人都会变回默认。',
      confirmText: '恢复', cancelText: '再想想', success: resolve
    }));
    if (!res.confirm) return;
    wx.showLoading({ title: '处理中' });
    await call('space', { action: 'setBg', spaceId: space._id, clear: true }).catch(() => {});
    wx.hideLoading();
    await app.refreshSpaces(space._id);
    this.load();
  },

  async save(silent) {
    if (this.data.saving) return;
    const space = getApp().globalData.currentSpace;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中' });
    try {
      await call('space', {
        action: 'updateProfile',
        nickName: this.data.nickName,
        avatarUrl: this.data.avatarUrl,
        bg: this.data.bg,
        spaceId: space ? space._id : ''
      });
    } catch (err) {
      wx.hideLoading();
      this.setData({ saving: false });
      wx.showToast({ title: String(err), icon: 'none' });
      return;
    }
    wx.hideLoading();
    this.setData({ saving: false });
    await getApp().loadProfile();
    if (!silent) wx.showToast({ title: '已保存', icon: 'success' });
  }
});
