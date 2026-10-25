const { ABOUT } = require('../../config.js');
const bg = require('../../utils/bg.js');

Page({
  data: {
    bio: ABOUT.bio || '',
    wechat: ABOUT.wechat || '',
    qr: ABOUT.qr || ''
  },

  onShow() { bg.apply(this); },

  copyWechat() {
    if (!this.data.wechat) { wx.showToast({ title: '还没配置微信号', icon: 'none' }); return; }
    wx.setClipboardData({
      data: this.data.wechat,
      success: () => wx.showToast({ title: '微信号已复制', icon: 'success' })
    });
  },

  previewQr() {
    if (!this.data.qr) return;
    wx.previewImage({ urls: [this.data.qr], current: this.data.qr });
  }
});
