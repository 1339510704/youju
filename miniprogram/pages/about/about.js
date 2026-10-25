const { ABOUT } = require('../../config.js');
const bg = require('../../utils/bg.js');

Page({
  data: {
    bio: ABOUT.bio || '',
    wechat: ABOUT.wechat || '',
    qr: ABOUT.qr || ''
  },

  onShow() { bg.apply(this); },

  goContact() { wx.navigateTo({ url: '/pages/contact/contact' }); }
});
