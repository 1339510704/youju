const { call, pickImage, uploadImage, fileUrls } = require('../../utils/cloud.js');
const bg = require('../../utils/bg.js');
const { ensureSpace } = require('../../utils/guard.js');
const member = require('../../utils/member.js');
const config = require('../../config.js');
const sheetSwipe = require('../../utils/sheet-swipe.js');

const DEFAULT_CATS = ['家常', '荤菜', '素菜', '汤', '主食', '水果', '零食', '其他'];

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function todayStr() { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
// 用餐日期的口语化文案：今天 / 明天 / 后天 / 9月22日
function mealText(ds) {
  if (!ds) return '';
  const t = new Date(ds + 'T00:00:00');
  if (isNaN(t.getTime())) return ds;
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const diff = Math.round((t.getTime() - now.getTime()) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  const md = (t.getMonth() + 1) + '月' + t.getDate() + '日';
  return t.getFullYear() === now.getFullYear() ? md : (t.getFullYear() + '年' + md);
}

// 点菜模式按空间缓存菜单 + 余额：进页面先秒显，云端回来再静默覆盖（消除"查看已点"空白延迟）
const _menuCache = {};

Page({
  behaviors: [sheetSwipe],   // 弹层里向右滑 = 取消关闭（page json 里已 disableSwipeBack）
  data: {
    // mode: manage=管理（可编辑） / order=点菜（选购下单）
    mode: 'manage', isOrder: false, noSpace: false,
    space: null, dishes: [], shown: [],
    cats: DEFAULT_CATS.slice(), filters: ['全部'].concat(DEFAULT_CATS), filter: '全部',
    cart: {}, total: 0, totalFlowers: 0, myFlowers: 0,
    showEdit: false, editId: '', name: '', category: '家常',
    flowers: '1', image: '', notes: '', uploading: false,
    // 公共菜单（家庭 / 公共切换）+ 加菜公开开关 + 已点明细弹层
    tab: 'family', publicDishes: [], isPublicDish: false, showCart: false,
    // 下单计划：用餐日期 + 用餐时间 + 到点提醒 + 提醒谁
    mealDate: '', mealDateText: '', mealTime: '18:00',
    remDate: '', remTime: '',
    toOptions: ['仅我自己', '全家人'], toIdx: 0
  },

  onLoad(options) {
    const isOrder = !!(options && options.mode === 'order');
    this.setData({ mode: isOrder ? 'order' : 'manage', isOrder });
  },

  onShow() {
    const ms = member.status();
    this.setData({ memberExpired: ms.expired, daysLeft: ms.daysLeft });
    this.prepare(); bg.apply(this);
  },

  async prepare() {
    const app = getApp();
    // 已经确认过空间就直接复用，别每次进点菜页都重新探活（之前会卡在「加载中」）
    let space = (app.globalData.cloudReady && app.globalData.currentSpace)
      ? app.globalData.currentSpace
      : await ensureSpace();
    if (!space) {
      // 没有空间：交给「家」页引导，这里别卡成「加载中」
      this.setData({ noSpace: true });
      return;
    }
    this.setData({ space, noSpace: false });
    if (space.type !== 'family') return;
    // 点菜模式：有缓存就先秒显菜单 + 余额（已点清单的朵数也立刻有），云端回来再覆盖
    if (this.data.isOrder) {
      const cached = _menuCache[space._id];
      if (cached) {
        this.setData({ dishes: cached.dishes, myFlowers: cached.myFlowers });
        this.applyFilter();
      }
    }
    this.load();
  },

  // 菜品图 fileID → 可直接显示的 https 链接。
  // 为什么必须换：云存储权限默认「仅创建者可读写」，小程序端直接渲染 cloud:// 时，
  // 别人（家人）那边加载不出来 —— 由云函数换取链接后，谁都能看。一次批量调用 + 内存缓存。
  async fillImgUrls(key) {
    const k = key || 'dishes';
    const list = this.data[k] || [];
    // 服务端已在列表里带了 imgUrl 就不用再单独换一次（省一次云调用）
    const ids = list.filter(d => d.image && !d.imgUrl && String(d.image).indexOf('cloud://') === 0)
      .map(d => d.image);
    if (!ids.length) return;
    const map = await fileUrls(ids);
    if (!Object.keys(map).length) return;
    const patch = {};
    patch[k] = list.map(d => (d.image && map[d.image]) ? Object.assign({}, d, { imgUrl: map[d.image] }) : d);
    this.setData(patch);
    if (k === 'dishes') this.applyFilter();
  },

  async load() {
    const spaceId = this.data.space._id;

    // 点菜模式：只加载家庭菜单（供选购）
    if (this.data.isOrder) {
      const _pa1 = await Promise.all([
        call('content', { action: 'list', coll: 'dishes', spaceId }).catch(() => ({ list: [] })),
        call('flower', { action: 'balance', spaceId }).catch(() => ({ flowers: 0 }))
      ]);
      const r = _pa1[0], b = _pa1[1];
      this.setData({ dishes: r.list || [], myFlowers: b.flowers || 0 });
      this.applyFilter();
      _menuCache[spaceId] = { dishes: r.list || [], myFlowers: b.flowers || 0 };
      this.fillImgUrls();
      return;
    }

    // 公共菜单：跨家庭公开菜（自家公开的也显示，带「取消公开」；mySpace 不再过滤，避免自己误以为没公开成功）
    if (this.data.tab === 'public') {
      try {
        const r = await call('content', { action: 'listPublic', coll: 'dishes' });
        this.setData({ publicDishes: r.list || [] });
        this.fillImgUrls('publicDishes');   // 公共菜单都是别人上传的图，更要换链接
      } catch (err) {
        // 把失败原因转成可操作的中文提示，避免用户只看得到空列表却不知所以
        const msg = String(err || '');
        let tip = '公共菜单打开失败，稍后重试';
        if (/未知操作|非法集合|not found|undefined/.test(msg)) {
          tip = '公共菜单打开失败：content 云函数未部署最新，请在开发者工具右键 cloudfunctions/content 上传并部署';
        } else if (/index|索引|502005|missing/i.test(msg)) {
          tip = '公共菜单打开失败：dishes 集合缺 public 索引，请到云控制台给 public 字段建单字段索引(升序)';
        }
        this.setData({ publicDishes: [] });
        wx.showToast({ title: tip, icon: 'none' });
      }
      return;
    }

    // 家庭菜单：本家庭的菜
    const _pa2 = await Promise.all([
      call('content', { action: 'list', coll: 'dishes', spaceId }).catch(() => ({ list: [] })),
      call('flower', { action: 'balance', spaceId }).catch(() => ({ flowers: 0 }))
    ]);
    const r = _pa2[0], b = _pa2[1];
    this.setData({ dishes: r.list || [], myFlowers: b.flowers || 0 });
    this.applyFilter();
    this.fillImgUrls();
  },

  // 家庭菜单 / 公共菜单 切换
  setTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab });
    this.load();
  },

  // 把购物车数量并进展示数据，同时算好这一单要花多少朵小红花
  applyFilter() {
    const f = this.data.filter;
    const cart = this.data.cart || {};
    const list = f === '全部'
      ? this.data.dishes
      : this.data.dishes.filter(d => (d.category || '其他') === f);
    const shown = list.map(d => Object.assign({}, d, { _qty: cart[d._id] || 0 }));
    let total = 0, totalFlowers = 0;
    Object.keys(cart).forEach(k => {
      const n = cart[k];
      total += n;
      const d = this.data.dishes.find(x => x._id === k) || {};
      totalFlowers += (parseInt(d.flowers, 10) || 1) * n;
    });
    this.setData({ shown, total, totalFlowers });
    this.computeCats();
  },

  // 分类 = 默认分类 ∪ 用户自定义（本地存） ∪ 菜品里已有的分类，去重
  computeCats() {
    const spaceId = this.data.space && this.data.space._id;
    let stored = [];
    try { stored = spaceId ? (wx.getStorageSync('dishCats_' + spaceId) || []) : []; } catch (e) {}
    const fromDishes = (this.data.dishes || []).map(d => d.category || '其他');
    const set = {};
    DEFAULT_CATS.concat(stored, fromDishes).forEach(c => { if (c) set[c] = 1; });
    const cats = Object.keys(set);
    // 自定义分类 = 出现在列表里、但不在默认分类常量中的（用于长按编辑/删除的判定）
    const customCats = cats.filter(c => DEFAULT_CATS.indexOf(c) < 0);
    this.setData({ cats, filters: ['全部'].concat(cats), customCats });
  },

  // 加菜弹层里「＋」新增分类：输入名字，加入分类并选为当前菜的分类
  addCat() {
    wx.showModal({
      title: '新增分类', editable: true, placeholderText: '如：川菜 / 减脂餐',
      success: (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name) return;
        const spaceId = this.data.space && this.data.space._id;
        const cur = this.data.cats.slice();
        if (cur.indexOf(name) >= 0) {
          this.setData({ category: name });
          wx.showToast({ title: '分类已存在', icon: 'none' });
          return;
        }
        const cats = cur.concat([name]);
        const stored = this.getStoredCats(spaceId).filter(c => c !== name).concat([name]);
        this.saveStoredCats(spaceId, stored);
        this.setData({ cats, filters: ['全部'].concat(cats), category: name });
      }
    });
  },
  getStoredCats(spaceId) {
    try { return spaceId ? (wx.getStorageSync('dishCats_' + spaceId) || []) : []; } catch (e) { return []; }
  },
  saveStoredCats(spaceId, arr) {
    try { if (spaceId) wx.setStorageSync('dishCats_' + spaceId, arr); } catch (e) {}
  },

  /* ---------- 分类：长按重命名 / 删除（仅自定义分类，默认分类不可动） ---------- */
  onCatLongPress(e) {
    const name = e.currentTarget.dataset.c;
    if (!name || name === '全部') return;
    if (DEFAULT_CATS.indexOf(name) >= 0) {
      wx.showToast({ title: '默认分类不可编辑', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: ['重命名分类', '删除分类'],
      success: (res) => {
        if (res.tapIndex === 0) this.renameCat(name);
        else if (res.tapIndex === 1) this.deleteCat(name);
      }
    });
  },

  async renameCat(old) {
    if (member.guard('编辑分类')) return;
    wx.showModal({
      title: '重命名分类', editable: true, placeholderText: old, content: old,
      success: async (res) => {
        if (!res.confirm) return;
        const name = (res.content || '').trim();
        if (!name || name === old) return;
        if (name === '全部') { wx.showToast({ title: '这个名字不能用', icon: 'none' }); return; }
        const spaceId = this.data.space && this.data.space._id;
        // 本地自定义分类名整体替换
        const stored = this.getStoredCats(spaceId)
          .map(c => (c === old ? name : c))
          .filter(c => c !== old);
        if (stored.indexOf(name) < 0) stored.push(name);
        this.saveStoredCats(spaceId, stored);
        // 同步把该分类下的菜改名
        wx.showLoading({ title: '更新中' });
        try {
          const list = this.data.dishes.filter(d => (d.category || '其他') === old);
          for (const d of list) {
            await call('content', { action: 'update', coll: 'dishes', _id: d._id, data: { category: name } }).catch(() => {});
          }
        } finally { wx.hideLoading(); }
        this.load();
        wx.showToast({ title: '已重命名', icon: 'success' });
      }
    });
  },

  async deleteCat(old) {
    if (member.guard('删除分类')) return;
    const spaceId = this.data.space && this.data.space._id;
    const list = this.data.dishes.filter(d => (d.category || '其他') === old);
    const stored = this.getStoredCats(spaceId).filter(c => c !== old);
    const doDelete = async () => {
      this.saveStoredCats(spaceId, stored);
      wx.showLoading({ title: '删除中' });
      try {
        // 该分类下的菜移到「其他」，避免变成没有分类的孤儿
        for (const d of list) {
          await call('content', { action: 'update', coll: 'dishes', _id: d._id, data: { category: '其他' } }).catch(() => {});
        }
      } finally { wx.hideLoading(); }
      if (this.data.filter === old) this.setData({ filter: '全部' });
      this.load();
      wx.showToast({ title: '已删除', icon: 'success' });
    };
    if (list.length) {
      wx.showModal({
        title: '删除分类「' + old + '」',
        content: '该分类下有 ' + list.length + ' 道菜，将一起移到「其他」分类，确定删除？',
        confirmText: '删除', confirmColor: '#d93b30', cancelText: '再想想',
        success: (res) => { if (res.confirm) doDelete(); }
      });
    } else {
      wx.showModal({
        title: '删除分类「' + old + '」', content: '确定删除这个分类？',
        confirmText: '删除', confirmColor: '#d93b30', cancelText: '再想想',
        success: (res) => { if (res.confirm) doDelete(); }
      });
    }
  },

  setFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.c });
    this.applyFilter();
  },

  /* ---------- 卡片点击：点菜模式加一份，管理模式编辑（公共菜不编辑） ---------- */
  onCardTap(e) {
    if (this.data.isOrder) return this.incDish(e);
    if (this.data.tab === 'public') return;
    return this.openEdit(e);
  },

  buzz() { try { wx.vibrateShort({ type: 'light' }); } catch (e) {} },

  incDish(e) {
    const id = e.currentTarget.dataset.id;
    const cart = Object.assign({}, this.data.cart);
    cart[id] = (cart[id] || 0) + 1;
    this.buzz();
    this.setData({ cart });
    this.applyFilter();
  },

  decDish(e) {
    const id = e.currentTarget.dataset.id;
    const cart = Object.assign({}, this.data.cart);
    if (!cart[id]) return;
    cart[id] -= 1;
    if (cart[id] <= 0) delete cart[id];
    this.buzz();
    this.setData({ cart });
    this.applyFilter();
  },

  clearCart() {
    if (!this.data.total) return;
    wx.showModal({
      title: '清空已选', content: '把选好的菜都取消掉？',
      confirmText: '清空', confirmColor: '#d93b30', cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ cart: {}, showCart: false });
        this.applyFilter();
      }
    });
  },

  /* ---------- 已点明细弹层（同时是「确认下单」的地方）---------- */
  openCart() {
    const patch = { showCart: true };
    // 用餐日期默认今天、时间默认 18:00，省得每次选
    if (!this.data.mealDate) { const t = todayStr(); patch.mealDate = t; patch.mealDateText = mealText(t); }
    if (!this.data.mealTime) patch.mealTime = '18:00';
    this.setData(patch);
  },
  closeCart() { this.setData({ showCart: false }); },
  // 在弹层上向右滑 = 取消（原来是"退出小程序"，很反直觉）
  onSheetSwipeClose() {
    if (this.data.showEdit) { this.closeEdit(); return; }
    if (this.data.showCart) { this.closeCart(); }
  },
  // ---- 用餐日期 / 用餐时间 / 到点提醒 / 提醒谁 ----
  onMealDate(e) { const v = e.detail.value; this.setData({ mealDate: v, mealDateText: mealText(v) }); },
  onMealTime(e) { this.setData({ mealTime: e.detail.value }); },
  // 设提醒时默认沿用「用餐时间」，省一步（吃饭时间就是该提醒的时间）
  onRemDate(e) {
    this.setData({ remDate: e.detail.value, remTime: this.data.remTime || this.data.mealTime || '18:00' });
  },
  onRemTime(e) { this.setData({ remTime: e.detail.value }); },
  clearRemind() { this.setData({ remDate: '', remTime: '' }); },
  onTo(e) { this.setData({ toIdx: Number(e.detail.value) || 0 }); },
  hasRemindTemplate() {
    const t = config.REMINDER_TEMPLATE_ID || '';
    return !!t && t.indexOf('请替换') !== 0;
  },
  removeFromCart(e) {
    const id = e.currentTarget.dataset.id;
    const cart = Object.assign({}, this.data.cart);
    delete cart[id];
    this.setData({ cart });
    this.applyFilter();
  },

  // 长按下单：从家庭菜单随机搭配 3~5 道进已点
  randomFill() {
    const dishes = this.data.dishes || [];
    if (!dishes.length) { wx.showToast({ title: '菜单还是空的', icon: 'none' }); return; }
    const n = 3 + Math.floor(Math.random() * 3); // 3~5 道
    const pool = dishes.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const pick = pool.slice(0, Math.min(n, pool.length));
    const cart = Object.assign({}, this.data.cart);
    pick.forEach(d => { cart[d._id] = (cart[d._id] || 0) + 1; });
    this.buzz();
    this.setData({ cart });
    this.applyFilter();
    wx.showToast({ title: '已为你随机搭配 ' + pick.length + ' 道菜', icon: 'none' });
  },

  // 底部「下单」= 打开确认弹层（在弹层里选用餐日期 / 提醒，再真正下单）
  confirmSubmit() {
    if (!this.data.total) { wx.showToast({ title: '先点几道菜', icon: 'none' }); return; }
    this.openCart();
  },

  // 点弹层里的「下单」：设了提醒的话，订阅授权必须在【这一刻】同步弹出
  // （等 await 网络请求之后再弹，微信会判定"不是点击手势"直接失败）
  submit() {
    if (member.guard('点菜下单')) return;
    if (!this.data.total) { wx.showToast({ title: '先点几道菜', icon: 'none' }); return; }
    const notifyAt = this.data.remDate
      ? (this.data.remDate + 'T' + (this.data.remTime || '18:00') + ':00') : '';
    if (notifyAt && this.hasRemindTemplate()) {
      wx.requestSubscribeMessage({
        tmplIds: [config.REMINDER_TEMPLATE_ID],
        complete: () => this.doSubmit(notifyAt)   // 允许/拒绝都继续下单
      });
    } else {
      this.doSubmit(notifyAt);
    }
  },

  // 下单：一次调用完成「扣小红花 + 批量写订单 + 通知家人」，并顺手建一条吃饭提醒
  // 原来是 1 次扣花 + 每道菜 1 次写订单（点 5 道 = 6 次串行云调用），现在只往返一次
  async doSubmit(notifyAt) {
    const cart = this.data.cart || {};
    const ids = Object.keys(cart);
    if (!ids.length) { wx.showToast({ title: '先点几道菜', icon: 'none' }); return; }

    const spaceId = this.data.space._id;
    const byName = getApp().globalData.nickName || '';
    const payItems = ids.map(id => {
      const d = this.data.dishes.find(x => x._id === id) || {};
      return { dishId: id, name: d.name || '菜', qty: cart[id], image: d.image || '' };
    });
    const dishNames = payItems.map(x => x.name || '菜').join('、');
    const mealDate = this.data.mealDate || '';
    const mealDateText = this.data.mealDateText || '';
    const mealTime = this.data.mealTime || '18:00';
    // 弹窗文案要用的值先存下来（下面 setData 会清空提醒设置）
    const remAtText = this.data.remDate ? (this.data.remDate + ' ' + (this.data.remTime || '18:00')) : '';
    const toText = this.data.toOptions[this.data.toIdx] || '仅我自己';

    wx.showLoading({ title: '下单中' });
    let r;
    try {
      r = await call('content', {
        action: 'submitOrders', spaceId, items: payItems, byName, mealDate, mealDateText, mealTime
      });
    } catch (err) {
      // 不吞异常：把云函数调用的真实原因带出来，便于定位
      r = { success: false, errMsg: '云函数调用失败：' + String((err && (err.errMsg || err.message)) || err) };
    }
    // content 云函数还是旧版（没有 submitOrders）时，自动退回老的逐步下单，保证功能不断
    if (r && !r.success && /未知操作|非法集合/.test(String(r.errMsg || ''))) {
      r = await this.submitLegacy(spaceId, payItems, byName);
    }
    wx.hideLoading();

    if (!r || !r.success) {
      const msg = (r && r.errMsg) || '下单失败，请重试';
      if (/不够|余额/.test(msg)) {
        wx.showModal({
          title: '小红花不够',
          content: msg + '。接单、完成做菜都能赚小红花。',
          showCancel: false, confirmText: '知道了'
        });
      } else {
        // 用弹窗显示完整原因（toast 太短容易看不全，不利于排查）
        wx.showModal({ title: '下单失败', content: msg, showCancel: false, confirmText: '知道了' });
      }
      return;
    }

    // 设了提醒 → 顺手建一条「吃饭提醒」待办，交给已有的提醒流水线到点推微信通知
    let remindFail = false;
    if (notifyAt) {
      try {
        await call('content', {
          action: 'add', coll: 'todos',
          data: {
            // 一次下单只建 1 条提醒 → 家人只会收到 1 条消息（不是每道菜一条）。
            // 微信模板的 thing 字段上限 20 字符，所以这里精简成「吃饭：菜1、菜2」，
            // 时间交给模板的时间字段显示，尽量把菜名留全。
            spaceId, content: '吃饭：' + dishNames.slice(0, 17),
            dueDate: mealDate, notifyAt,
            notifyTo: this.data.toIdx === 1 ? 'all' : 'me',
            notified: false, done: false
          }
        });
        // 清掉待办缓存：首页/待办页会重新拉，立刻能看到这条「吃饭提醒」
        getApp().globalData.todoList = null;
      } catch (e) { remindFail = true; }
    }

    this.buzz();
    this.setData({ cart: {}, showCart: false, remDate: '', remTime: '' });
    this.applyFilter();
    getApp().globalData.homeDirty = true;
    getApp().globalData.flowerDirty = true;   // 点菜改了小红花 → 红花页下次进来要刷新

    // 通知家人：交给前端异步发，不阻塞下单（它是最慢的一步，不再拖慢返回）
    call('remind', {
      action: 'orderNotify', spaceId,
      dish: dishNames.slice(0, 40), byName
    }).catch(() => {});

    // 下单成功提示：点了什么 / 用餐日期 / 提醒时间，一次说清楚
    const count = r.count || payItems.length;
    const cost = r.cost || 0;
    const lines = ['已点 ' + count + ' 道' + (cost ? '，花 ' + cost + ' 朵小红花' : '') + '。'];
    if (mealDateText) lines.push('用餐时间：' + mealDateText + ' ' + mealTime);
    if (remAtText) {
      lines.push('到点提醒：' + remAtText + '（' + toText + '）');
      if (remindFail) lines.push('提醒没能建上，请到「待办提醒」里手动加一条。');
    }
    wx.showModal({
      title: '下单成功',
      content: lines.join('\n'),
      showCancel: false,
      confirmText: '知道了',
      success: () => {
        // 看完提示再回饭桌页看清单
        const pages = getCurrentPages();
        if (pages.length > 1) wx.navigateBack();
        else wx.switchTab({ url: '/pages/order/order' });
      }
    });
  },

  // 兜底：云函数未部署 submitOrders 时的老的逐步下单（慢，但不会下单失败）
  async submitLegacy(spaceId, items, byName) {
    let pay;
    try {
      pay = await call('flower', { action: 'orderPay', spaceId, items, earnPerDish: true });
    } catch (err) {
      return { success: false, errMsg: String(err) };
    }
    if (!pay.success) return { success: false, errMsg: pay.errMsg || '小红花不够' };

    for (const it of items) {
      await call('content', {
        action: 'add', coll: 'orders',
        data: {
          spaceId, name: it.name || '菜', qty: it.qty || 1,
          image: it.image || '', dishId: it.dishId || '', byName, status: 'pending',
          mealDate: this.data.mealDate || '', mealDateText: this.data.mealDateText || '',
          mealTime: this.data.mealTime || ''
        }
      }).catch(() => {});
    }
    return { success: true, cost: pay.cost || 0, count: items.length };
  },

  /* ---------- 管理模式：编辑菜品 ---------- */
  openEdit(e) {
    const id = (e && e.currentTarget && e.currentTarget.dataset.id) || '';
    const d = this.data.dishes.find(x => x._id === id);
    this.setData({
      showEdit: true, editId: id,
      name: d ? d.name : '',
      category: d ? (d.category || '家常') : '家常',
      flowers: d ? String(d.flowers == null ? 1 : d.flowers) : '1',
      image: d ? (d.image || '') : '',
      notes: d ? (d.notes || '') : '',
      isPublicDish: d ? (!!d.public) : false
    });
  },
  closeEdit() { this.setData({ showEdit: false }); },
  noop() {},
  onName(e) { this.setData({ name: e.detail.value }); },
  onNotes(e) { this.setData({ notes: e.detail.value }); },
  onFlowers(e) { this.setData({ flowers: e.detail.value }); },
  incFlower() { let n = parseInt(this.data.flowers, 10) || 1; this.setData({ flowers: String(Math.min(99, n + 1)) }); },
  decFlower() { let n = parseInt(this.data.flowers, 10) || 1; this.setData({ flowers: String(Math.max(1, n - 1)) }); },
  onPublic(e) { this.setData({ isPublicDish: e.detail.value }); },
  pickCat(e) { this.setData({ category: e.currentTarget.dataset.c }); },

  async chooseImage() {
    let paths;
    try { paths = await pickImage(1); } catch (e) { return; }
    if (!paths.length) return;
    this.setData({ uploading: true });
    wx.showLoading({ title: '上传中' });
    try {
      const fileID = await uploadImage(paths[0], 'dishes');
      this.setData({ image: fileID });
    } catch (e) {
      wx.showToast({ title: '图片上传失败，请重试', icon: 'none' });
    }
    wx.hideLoading();
    this.setData({ uploading: false });
  },
  clearImage() { this.setData({ image: '' }); },

  async save() {
    if (member.guard('保存菜品')) return;
    const name = this.data.name.trim();
    if (!name) { wx.showToast({ title: '写上菜名', icon: 'none' }); return; }
    let flowers = parseInt(this.data.flowers, 10);
    if (isNaN(flowers) || flowers < 0) flowers = 1;
    if (flowers > 99) flowers = 99;
    const app = getApp();
    const payload = {
      name, category: this.data.category, image: this.data.image,
      flowers, notes: this.data.notes,
      public: this.data.isPublicDish,
      // 公开菜带上创建者昵称，公共菜单里展示「by 谁」
      creatorName: app.globalData.nickName || ''
    };
    wx.showLoading({ title: '保存中' });
    let added = null;
    try {
      if (this.data.editId) {
        await call('content', { action: 'update', coll: 'dishes', _id: this.data.editId, data: payload });
      } else {
        added = await call('content', { action: 'add', coll: 'dishes', data: Object.assign({ spaceId: this.data.space._id }, payload) });
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: String(err), icon: 'none' });
      return;
    }
    wx.hideLoading();
    this.setData({ showEdit: false });
    // 本地合并：新菜 / 改菜即时出现，不再等一次全量重载
    const dishes = this.data.dishes.slice();
    if (this.data.editId) {
      const i = dishes.findIndex(d => d._id === this.data.editId);
      if (i >= 0) dishes[i] = Object.assign({}, dishes[i], payload, { _id: this.data.editId });
    } else if (added) {
      dishes.unshift(Object.assign({ _id: added._id || ('_tmp_' + Date.now()) }, payload, { spaceId: this.data.space._id }));
    }
    this.setData({ dishes });
    this.applyFilter();
    if (this.data.isPublicDish) wx.showToast({ title: '已公开到公共菜单', icon: 'success' });
  },

  del() {
    if (member.guard('删除菜品')) return;
    const id = this.data.editId;
    if (!id) return;
    wx.showModal({
      title: '删除菜品', content: '确定从菜单里删掉吗？',
      confirmText: '删除', confirmColor: '#d93b30', cancelText: '再想想',
      success: async (res) => {
        if (!res.confirm) return;
        await call('content', { action: 'remove', coll: 'dishes', _id: id }).catch(() => {});
        this.setData({ showEdit: false });
        // 本地移除，即时消失
        this.setData({ dishes: this.data.dishes.filter(d => d._id !== id) });
        this.applyFilter();
      }
    });
  },

  // 公共菜单：一键添加到我的家庭菜单（复制一份，公开关掉）
  async addPublic(e) {
    if (member.guard('加入公共菜单')) return;
    const id = e.currentTarget.dataset.id;
    const d = this.data.publicDishes.find(x => x._id === id);
    if (!d) return;
    wx.showLoading({ title: '添加中' });
    try {
      await call('content', {
        action: 'add', coll: 'dishes', data: {
          spaceId: this.data.space._id,
          name: d.name, category: d.category || '其他',
          image: d.image || '', flowers: d.flowers || 1,
          notes: d.notes || '', public: false
        }
      });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: String(err), icon: 'none' });
      return;
    }
    wx.hideLoading();
    this.buzz();
    wx.showToast({ title: '已添加到家庭菜单', icon: 'none' });
  },

  // 公共菜单：点赞 1 朵小红花（一个菜每人限一次，赞过就反馈「已点赞」）
  async likeDish(e) {
    if (member.guard('点赞菜品')) return;
    const id = e.currentTarget.dataset.id;
    const d = this.data.publicDishes.find(x => x._id === id);
    if (!d) return;
    if (d.hasLiked) { wx.showToast({ title: '已经点赞过啦', icon: 'none' }); return; }
    wx.showLoading({ title: '点赞中' });
    try {
      const r = await call('content', { action: 'likeDish', coll: 'dishes', _id: id, spaceId: this.data.space._id });
      wx.hideLoading();
      if (r.already) {
        const list = this.data.publicDishes.map(x => x._id === id ? Object.assign({}, x, { hasLiked: true }) : x);
        this.setData({ publicDishes: list });
        wx.showToast({ title: '已经点赞过啦', icon: 'none' });
        return;
      }
      if (!r.success) { wx.showToast({ title: r.errMsg || '点赞失败', icon: 'none' }); return; }
      const list = this.data.publicDishes.map(x => x._id === id
        ? Object.assign({}, x, { hasLiked: true, likeCount: (r.likeCount != null ? r.likeCount : (x.likeCount || 0) + 1) })
        : x);
      this.setData({ publicDishes: list });
      wx.showToast({ title: '已点赞 1 朵小红花', icon: 'none' });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: String(err), icon: 'none' });
    }
  },

  // 公共菜单：取消自己的公开（只把菜从公共列表移除；别人已「加入家庭」的副本是独立文档，不受影响）
  async cancelPublic(e) {
    if (member.guard('取消公开')) return;
    const id = e.currentTarget.dataset.id;
    const d = this.data.publicDishes.find(x => x._id === id);
    if (!d) return;
    if (!d.mine) { wx.showToast({ title: '只能取消自己公开的菜', icon: 'none' }); return; }
    wx.showModal({
      title: '取消公开',
      content: '从公共菜单移除，但别人已经加入家庭的菜不受影响。',
      confirmText: '取消公开', confirmColor: '#d93b30', cancelText: '再想想',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中' });
        try {
          await call('content', { action: 'update', coll: 'dishes', _id: id, data: { public: false } });
        } catch (err) {
          wx.hideLoading();
          wx.showToast({ title: String(err), icon: 'none' });
          return;
        }
        wx.hideLoading();
        this.setData({ publicDishes: this.data.publicDishes.filter(x => x._id !== id) });
        wx.showToast({ title: '已取消公开', icon: 'none' });
      }
    });
  },

  goOrder() { wx.switchTab({ url: '/pages/order/order' }); }
});
