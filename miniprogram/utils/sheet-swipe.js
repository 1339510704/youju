// ============================================================
// 弹层「右滑关闭」手势
// ------------------------------------------------------------
// 背景：Android 手势导航下，从屏幕左/右边缘往里滑 = 系统返回；在根页面
// （比如「红花」这个 Tab）会直接把小程序退出；iOS 的边缘右滑返回也一样。
// 系统手势在页面里拿不到，所以分两步缓解：
//   1) 页面 json 里 "disableSwipeBack": true（iOS 生效）→ 屏蔽边缘右滑返回；
//   2) 用本手势把「在弹层上向右滑」变成「关闭弹层」，符合直觉。
//
// 用法：
//   1) 页面 json：{ "disableSwipeBack": true }
//   2) 页面 js：const sheetSwipe = require('../../utils/sheet-swipe.js');
//               Page({ behaviors: [sheetSwipe], ... })
//               页面里提供 onSheetSwipeClose() { this.setData({ showXxx: false }); }
//   3) 弹层最外层 .sheet 上挂三个事件：
//        <view class="sheet" catchtap="noop"
//              bindtouchstart="panStart" bindtouchmove="panMove" bindtouchend="panEnd">
// ============================================================

module.exports = Behavior({
  methods: {
    panStart(e) {
      const t = (e.touches && e.touches[0]) || {};
      this._panX = t.clientX || 0;
      this._panY = t.clientY || 0;
      this._panOn = false;
    },

    panMove(e) {
      const t = (e.touches && e.touches[0]) || {};
      const dx = (t.clientX || 0) - (this._panX || 0);
      const dy = (t.clientY || 0) - (this._panY || 0);
      // 只认「明显向右」的横滑：上下滚动、向左滑都不触发
      if (Math.abs(dx) > Math.abs(dy) && dx > 12) this._panOn = true;
    },

    panEnd(e) {
      if (!this._panOn) return;
      const t = (e.changedTouches && e.changedTouches[0]) || {};
      const dx = (t.clientX || 0) - (this._panX || 0);
      this._panOn = false;
      if (dx > 90 && typeof this.onSheetSwipeClose === 'function') this.onSheetSwipeClose();
    }
  }
});
