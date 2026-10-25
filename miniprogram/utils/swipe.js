// ============================================================
// 左滑删除 / 右滑完成 —— 微信/美团标准列表交互
// ------------------------------------------------------------
// 左滑：露出「删除」（红色）。右滑：露出「完成」（绿色），点它即标记完成。
// 右滑默认关闭（见 data.swipeRight），只有显式 swipeRight:true 的页面才会
// 响应右滑，避免影响只想左滑删除的页面（菜单/记账/节日/订单）。
//
// 用法：
//   1) 页面 js：const swipe = require('../../utils/swipe.js');
//               Page({ behaviors: [swipe], data: { swipeRight: true }, ... })
//   2) wxml：
//      <view class="swipe">
//        <view class="swipe-body"
//              style="transform:translateX({{_swipeRightId===item._id?'172rpx':(_swipeId===item._id?'-172rpx':'0')}})"
//              bindtouchstart="swipeStart" bindtouchmove="swipeMove" bindtouchend="swipeEnd"
//              data-id="{{item._id}}" bindtap="closeSwipe">
//          ...原来的行内容...
//        </view>
//        <view class="swipe-act swipe-act-left" catchtap="complete" data-id="{{item._id}}">完成</view>
//        <view class="swipe-act" catchtap="remove" data-id="{{item._id}}">删除</view>
//      </view>
//   3) 页面里保留 remove / complete 方法（读 e.currentTarget.dataset.id）。
//   4) swipeOff:true 整页禁用左滑；单行 e.currentTarget.dataset.none 禁用该行。
// ============================================================

const SWIPE_W = 172; // rpx，必须与 app.wxss 里 .swipe-act 的宽度一致

module.exports = Behavior({
  data: {
    _swipeId: '',      // 左滑展开的项 id
    _swipeRightId: '', // 右滑展开的项 id
    swipeOff: false,   // 整页禁用左滑
    swipeRight: false  // 是否启用右滑「完成」（默认关）
  },

  methods: {
    swipeStart(e) {
      this._sx = e.touches[0].clientX;
      this._sy = e.touches[0].clientY;
      this._swiping = false;
    },

    swipeMove(e) {
      if (this.data.swipeOff) return;
      if (e.currentTarget.dataset.none) return; // 单行禁用（如户主不可移除）
      const t = e.touches[0] || {};
      const dx = (t.clientX || 0) - (this._sx || 0);
      const dy = (t.clientY || 0) - (this._sy || 0);
      // 纵向滚动优先：手指主要在上下动时不触发滑动，避免误开
      if (Math.abs(dy) > Math.abs(dx)) return;
      if (dx < -6) this._swiping = true;
      else if (dx > 6) this._swiping = true;
    },

    swipeEnd(e) {
      if (this.data.swipeOff || e.currentTarget.dataset.none) return;
      const t = e.changedTouches[0] || {};
      const dx = (t.clientX || 0) - (this._sx || 0);
      const id = e.currentTarget.dataset.id || '';
      const wasLeft = this.data._swipeId === id;
      const wasRight = this.data._swipeRightId === id;

      if (!wasLeft && !wasRight) {
        // 都未展开：按滑动方向决定展开哪侧（右滑仅在开启 swipeRight 时生效）
        if (dx < -30) {
          this.setData({ _swipeId: id, _swipeRightId: '' });
          try { wx.vibrateShort({ type: 'light' }); } catch (err) {}
        } else if (dx > 30 && this.data.swipeRight) {
          this.setData({ _swipeRightId: id, _swipeId: '' });
          try { wx.vibrateShort({ type: 'light' }); } catch (err) {}
        } else {
          this.setData({ _swipeId: '', _swipeRightId: '' });
        }
      } else if (wasLeft) {
        // 左滑已展开：向右滑回（哪怕只回一点）就收起
        if (dx > -20) this.setData({ _swipeId: '' });
      } else if (wasRight) {
        // 右滑已展开：向左滑回就收起
        if (dx < 20) this.setData({ _swipeRightId: '' });
      }
      this._swiping = false;
    },

    // 点其它地方 / 点行本身 → 收起
    closeSwipe() {
      if (this.data._swipeId || this.data._swipeRightId) {
        this.setData({ _swipeId: '', _swipeRightId: '' });
      }
    }
  }
});

