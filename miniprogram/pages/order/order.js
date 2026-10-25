const { call, pickImage, uploadImage, fileUrls } = require('../../utils/cloud.js');
const { ensureSpace } = require('../../utils/guard.js');
const flower = require('../../utils/flower.js');
const bg = require('../../utils/bg.js');
const swipe = require('../../utils/swipe.js');
const member = require('../../utils/member.js');

Page({
  behaviors: [swipe],

  data: {
    space: null, openid: '', todo: [], items: [], left: 0, doneCount: 0,
    myFlowers: 0, rules: null,
    heroStyle: '', spaceInitial: '', uploading: false
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    const ms = member.status();
    this.setData({ memberExpired: ms.expired, daysLeft: ms.daysLeft });
    this.prepare(); bg.apply(this, 'orderBody');
  },

  async prepare() {
    const app = getApp();
    // 已就绪就复用全局空间，别每次进饭桌都重新探活（之前会空白等）
    const space = (app.globalData.cloudReady && app.globalData.currentSpace)
      ? app.globalData.currentSpace
      : await ensureSpace();
    if (!space) return;
    const rules = await flower.getRules();
    const patch = { space, openid: app.globalData.openid || '', rules };
    // 秒显上次缓存的清单，云端回来再静默覆盖（消除"已点"空白延迟）
    if (this._cache) {
      const c = this._cache;
      Object.assign(patch, {
        items: c.items, todo: c.todo, myFlowers: c.myFlowers,
        left: c.left, doneCount: c.doneCount, spaceInitial: c.spaceInitial
      });
      this.setData(patch);
    } else {
      this.setData(patch);
    }
    this.load();
  },

  async load() {
    const spaceId = this.data.space._id;
    const openid = getApp().globalData.openid || '';
    const _pa = await Promise.all([
      call('content', { action: 'list', coll: 'orders', spaceId }).catch(() => ({ list: [] })),
      call('flower', { action: 'balance', spaceId }).catch(() => ({ flowers: 0 }))
    ]);
    const o = _pa[0], b = _pa[1];
    const base = (o.list || []).map(x => Object.assign({}, x, {
      mine: x.taker === openid,
      takerLabel: x.taker === openid ? '我' : (x.takerName || '家人')
    }));
    // 菜品图 fileID → https（走云函数换取，绕开「仅创建者可读写」，家人才能看到图）
    const imgIds = base.filter(x => x.image && !x.imgUrl && String(x.image).indexOf('cloud://') === 0)
      .map(x => x.image);
    let items = base;
    if (imgIds.length) {
      const map = await fileUrls(imgIds);
      if (Object.keys(map).length) {
        items = base.map(x => (x.image && map[x.image])
          ? Object.assign({}, x, { imgUrl: map[x.image] }) : x);
      }
    }
    // 清单里只留没做完的；做完的自动成为历史订单
    const todo = items.filter(i => i.status !== 'done');
    this.setData({
      items, todo,
      myFlowers: b.flowers || 0,
      left: todo.length,
      doneCount: items.length - todo.length,
      spaceInitial: (this.data.space.name || '家').slice(0, 1),
      _swipeId: ''
    });
    // 记下这次结果，下次进页面先秒显
    this._cache = { items, todo, myFlowers: b.flowers || 0, left: todo.length, doneCount: items.length - todo.length, spaceInitial: (this.data.space.name || '家').slice(0, 1) };
    this.applyHero();
  },

  // 头图（饭桌顶部）：用「orderTop」位置的配置；关掉则该位置回落默认头图
  async applyHero() {
    const app = getApp();
    const me = app.globalData.profile || {};
    const space = this.data.space || app.globalData.currentSpace || null;
    const heroStyle = bg.placeOn(me, 'orderTop') ? (await bg.styleOf(space, me, 'orderTop')) : '';
    this.setData({ heroStyle: heroStyle || '' });
  },

  // 换背景：与「我的资料 → 家庭背景图」同一套，传到空间上全家可见
  async chooseBg() {
    if (member.guard('换饭桌背景')) return;
    const app = getApp();
    const space = app.globalData.currentSpace;
    if (!space) { wx.showToast({ title: '还没有加入空间', icon: 'none' }); return; }
    let paths;
    try { paths = await pickImage(1); } catch (e) { return; }
    if (!paths.length) return;
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中' });
    try {
      const fileID = await uploadImage(paths[0], 'backgrounds');
      await call('space', {
        action: 'setBg', spaceId: space._id, bgImage: fileID,
        byName: app.globalData.nickName || ''
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ uploading: false });
      wx.showToast({ title: '上传失败，请重试', icon: 'none' });
      return;
    }
    wx.hideLoading();
    this.setData({ uploading: false });
    await app.refreshSpaces(space._id);
    this.setData({ space: app.globalData.currentSpace });
    await this.applyHero();
    await bg.apply(this, 'orderBody');
  },

  goMenu() { wx.navigateTo({ url: '/pages/menu/menu' }); },
  goRoulette() { wx.navigateTo({ url: '/pages/roulette/roulette' }); },
  goOrder() { wx.navigateTo({ url: '/pages/menu/menu?mode=order' }); },
  goRank() { wx.navigateTo({ url: '/pages/rank/rank' }); },
  goHistory() { wx.navigateTo({ url: '/pages/history/history' }); },

  // 接单认领：一次调用，本地更新清单（不再整页 reload）
  async take(e) {
    if (member.guard('接单')) return;
    const id = e.currentTarget.dataset.id;
    const before = this.data.myFlowers;
    try { wx.vibrateShort({ type: 'light' }); } catch (e) {}
    wx.showLoading({ title: '接单中' });
    let r;
    try {
      r = await call('content', {
        action: 'takeOrder', coll: 'orders', _id: id,
        nickName: getApp().globalData.nickName || ''
      });
    } catch (err) {
      wx.hideLoading(); wx.showToast({ title: err, icon: 'none' }); return;
    }
    this.patchOrder(id, { status: 'taken', mine: true, takerLabel: '我' });
    if (r && r.flowers != null) this.setData({ myFlowers: r.flowers });
    wx.hideLoading();
    this.toastGain(before, '接单成功');
  },

  // 标记完成 → 本地移出清单（做完的自动进历史订单）
  async finish(e) {
    if (member.guard('完成点菜')) return;
    const id = e.currentTarget.dataset.id;
    const before = this.data.myFlowers;
    try { wx.vibrateShort({ type: 'light' }); } catch (e) {}
    wx.showLoading({ title: '完成中' });
    let r;
    try {
      r = await call('content', { action: 'finishOrder', coll: 'orders', _id: id });
    } catch (err) {
      wx.hideLoading(); wx.showToast({ title: err, icon: 'none' }); return;
    }
    this.patchOrder(id, { status: 'done', done: true });
    if (r && r.flowers != null) this.setData({ myFlowers: r.flowers });
    wx.hideLoading();
    this.toastGain(before, '完成啦，已进历史');
  },

  // 局部更新一条点菜并同步「待做」列表：省掉一次拉全量清单 + 一次查余额
  patchOrder(id, patch) {
    // 接单 / 完成都会变小红花 → 标记红花页下次进来要刷新
    getApp().globalData.flowerDirty = true;
    const openid = getApp().globalData.openid || '';
    const items = this.data.items.map(x => {
      if (x._id !== id) return x;
      return Object.assign({}, x, patch, { taker: patch.status === 'taken' ? openid : x.taker });
    });
    const todo = items.filter(i => i.status !== 'done');
    this.setData({
      items, todo,
      left: todo.length,
      doneCount: items.length - todo.length,
      _swipeId: ''
    });
    getApp().globalData.homeDirty = true;   // 首页下次进来刷新
  },

  toastGain(before, prefix) {
    const diff = this.data.myFlowers - before;
    wx.showToast({ title: diff > 0 ? (prefix + '  +' + diff + ' 朵小红花') : prefix, icon: 'none' });
  },

  // 左滑后点红色「删除」→ 二次确认，避免手滑删掉家人点的菜
  async remove(e) {
    if (member.guard('删除点菜')) return;
    const id = e.currentTarget.dataset.id;
    const item = this.data.items.find(i => i._id === id) || {};
    const res = await new Promise(resolve => wx.showModal({
      title: '删除这一条？',
      content: '「' + (item.name || '这条点菜') + '」将从清单里移除，删掉就找不回来了。',
      confirmText: '删除', confirmColor: '#d93b30', cancelText: '再想想',
      success: resolve
    }));
    this.setData({ _swipeId: '' });
    if (!res.confirm) return;
    await call('content', { action: 'remove', coll: 'orders', _id: id }).catch(() => {});
    // 本地移除，不再重拉整页
    const items = this.data.items.filter(x => x._id !== id);
    const todo = items.filter(i => i.status !== 'done');
    this.setData({
      items, todo,
      left: todo.length,
      doneCount: items.length - todo.length
    });
    getApp().globalData.homeDirty = true;
  }
});
