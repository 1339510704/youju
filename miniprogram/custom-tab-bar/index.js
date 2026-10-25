// 自定义 tabBar：原生 tabBar 的图标/文字大小是系统固定的、调不了，
// 想让底部 3 个图标和文字更大，只能自己实现。
Component({
  data: {
    selected: 0,
    list: [
      {
        pagePath: '/pages/order/order', text: '饭桌',
        iconPath: '/images/ic/order.png', selectedIconPath: '/images/ic/order_on.png'
      },
      {
        pagePath: '/pages/vip/vip', text: '红花',
        iconPath: '/images/ic/flower.png', selectedIconPath: '/images/ic/flower_red.png'
      },
      {
        pagePath: '/pages/home/home', text: '家',
        iconPath: '/images/ic/home.png', selectedIconPath: '/images/ic/home_on.png'
      }
    ]
  },

  methods: {
    switchTab(e) {
      const { path, index } = e.currentTarget.dataset;
      if (this.data.selected === index) return;
      // 选中态由目标页的 onShow 统一设置，这里只负责跳转
      wx.switchTab({ url: path });
    }
  }
});
