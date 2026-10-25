const { call, fileUrls } = require('../../utils/cloud.js');
const bg = require('../../utils/bg.js');
const { ensureSpace } = require('../../utils/guard.js');
const member = require('../../utils/member.js');

const DEFAULT_CATS = ['家常', '荤菜', '素菜', '汤', '主食', '水果', '零食', '其他'];
const PALETTE = ['#ff9f68', '#ffd166', '#06d6a0', '#4cc9f0', '#b794f6', '#ff7aa2',
  '#ffb4a2', '#9bf6a0', '#a0c4ff', '#fdffb6', '#9bf6ff', '#ffc6ff'];

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

Page({
  data: {
    cats: DEFAULT_CATS.slice(),
    selCats: DEFAULT_CATS.slice(),   // 默认全选：不选类型就全随机
    catsView: [],                     // 渲染用：[{name,on}] —— 模板不能调 indexOf，选中态在这里算
    candCount: 15,                    // 候选菜数量（转盘上的候选，默认 15；实际按所选类型自动取 min）
    maxCount: 52,                     // 候选数上限
    _candManual: false,               // 用户是否手动调过候选数（调过就不再自动回到 15）
    pickCount: 1,                     // 每次选几道（分次随机记录）
    dishes: [], pool: [], candActual: 0,
    wheelLabels: [], wheelColors: [], wheelBg: '',   // 转盘扇区文字/颜色/动态背景
    wheelDeg: 0, spinning: false,
    results: [],                      // 逐次累积的结果
    space: null, noSpace: false, notFamily: false,
    memberExpired: false, daysLeft: 0
  },

  onShow() {
    const ms = member.status();
    this.setData({ memberExpired: ms.expired, daysLeft: ms.daysLeft });
    this.load();
  },

  async load() {
    const space = await ensureSpace();
    if (!space) { this.setData({ noSpace: true }); return; }
    if (space.type !== 'family') { this.setData({ notFamily: true }); return; }
    this.setData({ space, openid: getApp().globalData.openid || '' });
    const _pa = await Promise.all([
      call('content', { action: 'list', coll: 'dishes', spaceId: space._id }).catch(() => ({ list: [] })),
      call('flower', { action: 'balance', spaceId: space._id }).catch(() => ({ flowers: 0 }))
    ]);
    const dishes = _pa[0].list || [];
    // 分类 = 默认 ∪ 菜品里已有的
    const set = {};
    DEFAULT_CATS.concat(dishes.map(d => d.category || '其他')).forEach(c => { if (c) set[c] = 1; });
    const cats = Object.keys(set);
    const selCats = this.data.selCats.filter(c => set[c]);
    const finalSel = selCats.length ? selCats : cats.slice();
    this.setData({
      dishes, myFlowers: _pa[1].flowers || 0, cats,
      selCats: finalSel,
      catsView: this.catsViewOf(cats, finalSel)
    });
    this.computePool();
    bg.apply(this);
  },

  // 按所选类型筛出候选菜：随机挑 candCount 个（不重复）；菜不够就全部显示
  computePool() {
    const sel = this.data.selCats;
    const avail = this.data.dishes.filter(d => sel.indexOf(d.category || '其他') >= 0);
    // 候选数自动跟随所选类型：
    //   没手动调过 → 目标 15；类型里的菜不够 15 就自动降到实际数量，够 15 就保持 15
    //   手动调过   → 用用户设的数；若超过该类型实际菜数，同样按实际数量兜住
    const base = this.data._candManual ? this.data.candCount : 15;
    const candCount = avail.length ? Math.max(1, Math.min(base, avail.length)) : this.data.candCount;
    shuffle(avail);
    const n = Math.min(candCount, avail.length);
    const pool = avail.slice(0, n).map((d, i) => Object.assign({}, d, { _color: PALETTE[i % PALETTE.length] }));
    const colors = pool.map(d => d._color);
    // 选中数不能超过候选数
    let pickCount = this.data.pickCount;
    if (pool.length === 0) pickCount = 1;
    else if (pickCount > pool.length) pickCount = pool.length;
    // 转盘展示：有菜用真实候选；没菜用占位扇区（让转盘转起来看得见，并提示去加菜）
    let labels, bgColors, bg;
    if (pool.length > 0) {
      labels = pool.map(d => d.name);
      bgColors = colors;
      bg = this.makeWheelBg(pool.length, colors);
    } else {
      labels = DEFAULT_CATS.slice(0, 6);
      bgColors = labels.map((_, i) => PALETTE[i % PALETTE.length]);
      bg = this.makeWheelBg(labels.length, bgColors);
    }
    this.setData({
      candCount, pool, candActual: pool.length, wheelLabels: labels, wheelColors: bgColors,
      wheelBg: bg, pickCount
    });
  },

  // 转盘背景：按候选数等分扇区，每道菜一个颜色
  makeWheelBg(n, colors) {
    if (n <= 0) return '';
    if (n === 1) return colors[0];
    const step = 360 / n;
    const segs = [];
    for (let i = 0; i < n; i++) {
      const a = (i * step).toFixed(2), b = ((i + 1) * step).toFixed(2);
      segs.push(colors[i] + ' ' + a + 'deg ' + b + 'deg');
    }
    return 'conic-gradient(' + segs.join(',') + ')';
  },

  // 渲染用：给每个类型附上「是否选中」（模板里不用 indexOf）
  catsViewOf(cats, sel) {
    const s = sel || [];
    return (cats || []).map(name => ({ name, on: s.indexOf(name) >= 0 }));
  },

  // 切换某个类型是否参与随机（至少留一个）
  toggleCat(e) {
    const c = e.currentTarget.dataset.c;
    const sel = this.data.selCats.slice();
    const i = sel.indexOf(c);
    if (i >= 0) sel.splice(i, 1); else sel.push(c);
    if (!sel.length) { wx.showToast({ title: '至少选一个类型', icon: 'none' }); return; }
    this.setData({ selCats: sel, catsView: this.catsViewOf(this.data.cats, sel), results: [] });
    this.computePool();
  },

  // 候选数加减（封顶 52，且不超过所选类型下的菜数）
  incCand() {
    const avail = this.availCount();
    if (this.data.candCount >= avail) {
      wx.showModal({
        title: '候选数到顶了', showCancel: false, confirmText: '知道了',
        content: '所选类型最多 ' + avail + ' 道菜。到「家庭菜单」多加几道菜，或加个新分类，就能选更多啦。'
      });
      return;
    }
    this.setData({ candCount: Math.min(this.data.candCount + 1, this.data.maxCount), _candManual: true });
    this.computePool();
  },
  decCand() {
    this.setData({ candCount: Math.max(this.data.candCount - 1, 1), _candManual: true });
    this.computePool();
  },

  // 选中数（每次选几道）加减，封顶候选数
  incPick() {
    const max = Math.max(1, Math.min(this.data.candActual, 20));
    this.setData({ pickCount: Math.min(this.data.pickCount + 1, max) });
  },
  decPick() {
    this.setData({ pickCount: Math.max(this.data.pickCount - 1, 1) });
  },

  availCount() {
    const sel = this.data.selCats;
    return this.data.dishes.filter(d => sel.indexOf(d.category || '其他') >= 0).length;
  },

  buzz() { try { wx.vibrateShort({ type: 'light' }); } catch (e) {} },

  // 开始转盘：用 wx.createAnimation 驱动旋转（官方动画，稳定触发），停在哪就选哪道
  start() {
    if (this.data.spinning) return;
    const pool = this.data.pool;
    // 多转几圈 + 随机落点；缓出（开始快、后来慢），时长与 4200ms 对齐
    const turns = 6 + Math.floor(Math.random() * 3);   // 6~8 圈
    const extra = Math.floor(Math.random() * 360);
    const target = (this._spinBase || 0) + turns * 360 + extra;
    this._spinBase = target;   // 累计旋转角度，保证每次都往前转、不会回弹
    // 只改角度即可：.wheel 上有 CSS 过渡（4.2s），改了角度就会平滑转过去
    this.setData({ spinning: true, wheelDeg: target });
    setTimeout(() => {
      this.buzz();
      if (!pool.length) {
        this.setData({ spinning: false });
        wx.showToast({ title: '先到「家庭菜单」加几道菜', icon: 'none' });
        return;
      }
      // 指针在正上方（本地 0°），转盘顺时针转了 target° 后，指针所指的本地角度：
      const n = pool.length;
      const step = 360 / n;
      const local = (((-target) % 360) + 360) % 360;   // 落点对应的本地角度
      const idx = Math.floor(local / step) % n;        // 该扇区里的菜
      const pick = Math.min(this.data.pickCount, n);
      const chosen = [pool[idx]];
      // 一次选多道时，其余从池里随机补（不与落点重复），保持「每次选几道」
      if (pick > 1) {
        const rest = pool.filter((_, i) => i !== idx);
        shuffle(rest);
        for (let k = 0; k < pick - 1 && k < rest.length; k++) chosen.push(rest[k]);
      }
      // 逐次记录：每条隔一点时间加进结果列表
      let i = 0;
      const addOne = () => {
        if (i >= chosen.length) { this.setData({ spinning: false }); this.fillImgUrls(); return; }
        const d = chosen[i++];
        this.setData({
          results: this.data.results.concat([Object.assign({}, d, { _rid: Date.now() + '_' + Math.random() })])
        });
        setTimeout(addOne, 280);
      };
      addOne();
    }, 4200);
  },

  clearResults() { this.setData({ results: [] }); },

  // 结果里的菜品图 fileID → https（云端换取：家人也能看到图片）
  async fillImgUrls() {
    const list = this.data.results || [];
    const ids = list.filter(d => d.image && !d.imgUrl && String(d.image).indexOf('cloud://') === 0)
      .map(d => d.image);
    if (!ids.length) return;
    const map = await fileUrls(ids);
    if (!Object.keys(map).length) return;
    this.setData({
      results: list.map(d => (d.image && map[d.image]) ? Object.assign({}, d, { imgUrl: map[d.image] }) : d)
    });
  },

  // 确认下单：把累积的结果全部写进点菜清单
  async confirmOrder() {
    const results = this.data.results;
    if (!results || !results.length) { wx.showToast({ title: '先转几次选出菜', icon: 'none' }); return; }
    if (member.guard('点菜下单')) return;
    const space = this.data.space;
    if (!space) { wx.showToast({ title: '还没加入家庭空间', icon: 'none' }); return; }
    const byName = getApp().globalData.nickName || '';
    const items = results.map(d => ({ dishId: d._id, name: d.name || '菜', qty: 1, image: d.image || '' }));
    wx.showLoading({ title: '下单中' });
    let r = await call('content', {
      action: 'submitOrders', spaceId: space._id, items, byName
    }).catch(() => null);
    if (r && !r.success && /未知操作|非法集合/.test(String(r.errMsg || ''))) {
      r = await this.submitLegacy(space._id, items, byName);
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
        wx.showModal({ title: '下单失败', content: msg, showCancel: false, confirmText: '知道了' });
      }
      return;
    }
    this.buzz();
    const count = r.count || items.length;
    wx.showToast({ title: '已下单 ' + count + ' 道', icon: 'none' });
    getApp().globalData.homeDirty = true;
    getApp().globalData.flowerDirty = true;   // 转盘点菜也扣/发小红花 → 红花页要刷新
    // 通知家人：前端异步发，不阻塞
    call('remind', {
      action: 'orderNotify', spaceId: space._id,
      dish: items.map(x => x.name || '菜').join('、').slice(0, 40), byName
    }).catch(() => {});
    setTimeout(() => wx.switchTab({ url: '/pages/order/order' }), 900);
  },

  async submitLegacy(spaceId, items, byName) {
    let pay;
    try { pay = await call('flower', { action: 'orderPay', spaceId, items, earnPerDish: true }); }
    catch (err) { return { success: false, errMsg: String(err) }; }
    if (!pay.success) return { success: false, errMsg: pay.errMsg || '小红花不够' };
    for (const it of items) {
      await call('content', {
        action: 'add', coll: 'orders',
        data: { spaceId, name: it.name || '菜', qty: it.qty || 1, image: it.image || '', dishId: it.dishId || '', byName, status: 'pending' }
      }).catch(() => {});
    }
    return { success: true, count: items.length };
  }
});
