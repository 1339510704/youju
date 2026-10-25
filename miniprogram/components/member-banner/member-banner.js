Component({
  data: { closed: false },
  methods: {
    // 去续费：进「我的资料」页，那里有微信支付 / 兑换码入口
    goRenew() {
      wx.navigateTo({ url: '/pages/profile/profile' });
    },
    // 关闭提示条（本次会话内不再打扰，仍可正常使用已加载的只读内容）
    close() {
      this.setData({ closed: true });
    }
  }
});
