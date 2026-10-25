const { call } = require('../../utils/cloud.js');
const bg = require('../../utils/bg.js');
const swipe = require('../../utils/swipe.js');
const sheetSwipe = require('../../utils/sheet-swipe.js');

const { ensureSpace } = require('../../utils/guard.js');
const member = require('../../utils/member.js');

function pad(n) { return n < 10 ? '0' + n : '' + n; }

// 明细时间点：显示到「几点几分」（同年省略年份，跨年补上）
function fmtWhen(d) {
  if (!d) return '';
  const t = new Date(d);
  if (isNaN(t.getTime())) return '';
  const now = new Date();
  const day = (t.getFullYear() === now.getFullYear() ? '' : t.getFullYear() + '-') +
    pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  return day + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes());
}

function tsOf(d) { const t = new Date(d).getTime(); return isNaN(t) ? 0 : t; }

// 一条流水属于「北京时间的哪一天」——key 格式与热力图格子完全一致（2026-9-21），
// 这样点某格就能用它精确筛出那天的记录
function dayKeyOf(v) {
  const t = new Date(v);
  if (isNaN(t.getTime())) return '';
  const d = new Date(t.getTime() + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
}

// 云端一条流水 → 渲染用对象
// 「谁做的」：新流水带 byName；老流水没这个字段，用成员表(openid→昵称)兜底；自己显示「我」
function mapLog(x, ctx) {
  const c = ctx || {};
  const names = c.names || {};
  const mine = !!c.me && x.openid === c.me;
  return {
    _id: x._id, label: x.label, delta: x.delta,
    who: mine ? '我' : (x.byName || names[x.openid] || '家人'),
    mine,
    when: fmtWhen(x.createdAt), at: tsOf(x.createdAt),
    dayKey: dayKeyOf(x.createdAt)
  };
}

// 今天 0 点的时间戳（按北京时间，和家庭活跃热力图同一时区）
function startOfToday() {
  const bj = Date.now() + 8 * 3600 * 1000;
  const d = new Date(bj);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - 8 * 3600 * 1000;
}
const PAGE = 30;
const DAY = 24 * 3600 * 1000;
const DEFAULT_RANK_LABEL = '点这里看家庭排行';

Page({
  behaviors: [swipe, sheetSwipe],
  data: {
    space: null,
    flowers: 0,
    earned: 0,        // 累计获得（只增不减，用来算等级）
    badge: null,      // { key, name, icon, need, next, left, progress }
    logs: [],         // 当前展示的流水
    hasLogs: false,   // 历史上有过流水（哪怕最近一周一条都没有）
    showAll: false,   // 没有更早的记录了 = true
    revealedDays: 0,  // 已揭开的「更早天数」（默认只显示今天，每次点显示更多 +2 天）
    showMoreBtn: false,
    loadingMore: false,
    rankLabel: DEFAULT_RANK_LABEL,

    // 家庭自定义兑换
    rewards: [], orders: [], isAdmin: false,
    defaults: [], rwLimit: { minCost: 1, maxCost: 999 },
    showAdd: false, rwId: '', rwName: '', rwCost: 20,

    // 家庭活跃热力图（从 rank 页移来）
    heatCells: [],
    heatSel: '',        // 选中的格子（北京日期 key；'' = 未选，看默认范围）
    heatSelText: '',    // 选中格子的文案：今天 / 昨天 / 9月21日

    loading: true,        // 首次拉取中（防止空白/假死）
    _ready: false,        // 已加载过（用于从子页返回时跳过重拉）
    _swipeId: '', swipeOff: true
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    const ms = member.status();
    this.setData({ memberExpired: ms.expired, daysLeft: ms.daysLeft });
    // 别处点过菜 / 接过单 / 赚过花 → 强制刷一次，否则这里的余额和记录是旧的
    if (getApp().globalData.flowerDirty) {
      getApp().globalData.flowerDirty = false;
      this._dirty = true;
    }
    this.load(); bg.apply(this, 'vip');
  },

  // 一次往返拿齐红花页数据（余额 / 徽章 / 流水 / 热力图 / 兑换项 / 待兑现）。
  // 已加载过且空间没变时直接跳过 —— 从排行页、成员页返回时秒开，不再重拉。
  async load() {
    const app = getApp();
    // 缓存只保留 10 秒：短时间内来回切 Tab 仍然秒开；间隔久了就静默重拉，
    // 避免「别处点完菜回来还是旧记录」。（配合 onShow 里的 flowerDirty 强制刷新）
    const fresh = this._loadedAt && (Date.now() - this._loadedAt < 10000);
    if (this.data._ready && fresh && !this._dirty && this.data.space &&
        app.globalData.currentSpace && app.globalData.currentSpace._id === this.data.space._id) return;
    this._dirty = false;

    try {
      this.setData({ loading: true });
      await app.ensureReady();
      const space = app.globalData.currentSpace;
      this.loadRankLabel(space);
      if (!space) { this.setData({ space: null, loading: false }); ensureSpace(); return; }

      const r = await call('flower', { action: 'vipOverview', spaceId: space._id, limit: PAGE, days: 35 }).catch(() => null);
      if (!r || !r.success) return this.loadLegacy(space);
      this._loadedAt = Date.now();

      const ctx = { me: r.me || (getApp().globalData.openid || ''), names: r.memberNames || {} };
      this._logCtx = ctx;
      const logs = (r.logs || []).map(x => mapLog(x, ctx));
      this._allLogs = logs;
      this._logTotal = r.logTotal || logs.length;
      this.setData({
        space,
        flowers: r.flowers || 0,
        earned: r.earned || 0,
        badge: r.badge || null,
        hasLogs: this._logTotal > 0,
        loading: false,
        revealedDays: 0,
        heatCells: this.buildHeatmap(r.heatmap || {}),
        rewards: r.rewards || [],
        defaults: r.defaults || [],
        rwLimit: r.limit || { minCost: 1, maxCost: 999 },
        isAdmin: !!r.isAdmin,
        swipeOff: !r.isAdmin,
        orders: r.orders || [],
        _ready: true
      });
      this.applyLogView();
    } catch (e) {
      // 兜底：任何未捕获错误都至少把页面交出来，不能永久空白
      console.error('[vip] load error:', e);
      this.setData({ loading: false, space: (getApp().globalData.currentSpace) || null });
    }
  },

  // 兜底：flower 云函数还没部署 vipOverview 时，退回原来的多次调用
  async loadLegacy(space) {
    const _pa = await Promise.all([
      call('flower', { action: 'balance', spaceId: space._id, limit: PAGE })
        .catch(() => ({ flowers: 0, logs: [], earned: 0, badge: null, logTotal: 0 })),
      call('flower', { action: 'heatmap', spaceId: space._id, days: 35 })
        .catch(() => ({ heatmap: {} }))
    ]);
    const b = _pa[0], heat = _pa[1];
    this._loadedAt = Date.now();
    const ctx = { me: b.me || (getApp().globalData.openid || ''), names: b.memberNames || {} };
    this._logCtx = ctx;
    const logs = (b.logs || []).map(x => mapLog(x, ctx));

    this._allLogs = logs;
    this._logTotal = b.logTotal || logs.length;
    this.setData({
      space,
      flowers: b.flowers || 0,
      earned: b.earned || 0,
      badge: b.badge || null,
      hasLogs: this._logTotal > 0,
      loading: false,
      revealedDays: 0,
      heatCells: this.buildHeatmap(heat.heatmap || {}),
      _ready: true
    });
    this.applyLogView();
    this.loadRewards(space._id);
    this.loadOrders(space._id);
  },

  // 家庭活跃热力图：5周×7天格子，颜色深浅 = 当天互动次数
  buildHeatmap(map) {
    const cells = [];
    const totalDays = 35;
    const DAY = 24 * 3600 * 1000;
    // ⚠️ 按东八区（北京时间）算日期 key，和云端 heatmap 同一时区，否则「今天」会差一格
    const start = new Date(Date.now() - (totalDays - 1) * DAY + 8 * 3600 * 1000);
    for (let i = 0; i < totalDays; i++) {
      const d = new Date(start.getTime() + i * DAY);
      const key = d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
      const count = map[key] || 0;
      let lv = 0;
      if (count >= 8) lv = 4;
      else if (count >= 5) lv = 3;
      else if (count >= 3) lv = 2;
      else if (count >= 1) lv = 1;
      cells.push({ key, count, lv, day: d.getUTCDate() });   // day：格子里显示的日号
    }
    return cells;
  },

  // 记录：默认只显示今天；每次点「显示更多」多揭开 2 天（按日历天，不是按条数）
  // 点过热力图某格时 → 只显示那一天的记录
  applyLogView() {
    const all = this._allLogs || [];
    const sel = this.data.heatSel;
    const cut = startOfToday() - (this.data.revealedDays || 0) * DAY;
    // 显示从「今天 - 已揭开天数」起到现在的流水（含今天）；选了某天则只看那天
    const logs = sel ? all.filter(x => x.dayKey === sel) : all.filter(x => x.at >= cut);
    // 还有更早可看吗：服务端仍有没拉全的，或本地就存在 cutoff 之前的流水
    const hasOlder = (all.length < (this._logTotal || 0)) || (!sel && all.some(x => x.at < cut));
    this.setData({ logs, showMoreBtn: hasOlder, showAll: !hasOlder });
  },

  // 点热力图格子：只看那一天；再点同一格 = 取消（回到默认范围）
  tapHeat(e) {
    const key = e.currentTarget.dataset.k || '';
    if (!key) return;
    const same = this.data.heatSel === key;
    this.setData({
      heatSel: same ? '' : key,
      heatSelText: same ? '' : this.heatLabel(key)
    });
    this.applyLogView();
    // 选完顺手滚到「记录」区，不用自己往下找（等这一次渲染完成再滚，否则可能找不到节点）
    if (!same) setTimeout(() => wx.pageScrollTo({ selector: '#logSec', duration: 260 }), 80);
  },
  clearHeatSel() {
    this.setData({ heatSel: '', heatSelText: '' });
    this.applyLogView();
  },
  // 格子文案：今天 / 昨天 / 9月21日
  heatLabel(key) {
    const p = String(key || '').split('-');
    if (p.length < 3) return '';
    const t = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getTime();
    if (isNaN(t)) return '';
    const diff = Math.round((startOfToday() - t) / DAY);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    return Number(p[1]) + '月' + Number(p[2]) + '日';
  },

  async showMoreLogs() {
    if (this.data.loadingMore) return;
    const all = this._allLogs || [];
    // 本地还没拉全（服务端还有更早流水）→ 先把更早的一页拉下来
    if (all.length < (this._logTotal || 0)) {
      this.setData({ loadingMore: true });
      try {
        const r = await call('flower', {
          action: 'logs', spaceId: this.data.space._id, skip: all.length, limit: PAGE
        });
        if (r && r.success) {
          if (r.memberNames) {
            this._logCtx = Object.assign({}, this._logCtx, { names: r.memberNames, me: r.me || (this._logCtx || {}).me });
          }
          this._allLogs = all.concat((r.list || []).map(x => mapLog(x, this._logCtx || {})));
          if (r.total) this._logTotal = r.total;
        }
      } catch (e) {}
      this.setData({ loadingMore: false });
    }
    // 多揭开 2 天，再渲染
    this.setData({ revealedDays: (this.data.revealedDays || 0) + 2 });
    this.applyLogView();
    // 内容变多后，平滑滚到页面底部：新揭开的 2 天和「显示更多」都进视野
    wx.pageScrollTo({ scrollTop: 100000, duration: 280 });
  },

  /* ---------- 排行文案：点那朵花可自定义（藏起来的彩蛋，不给提示）---------- */
  labelKey(space) {
    return 'hsmp_rank_label_' + ((space && space._id) || 'default');
  },
  loadRankLabel(space) {
    let t = '';
    try { t = wx.getStorageSync(this.labelKey(space)) || ''; } catch (e) {}
    this.setData({ rankLabel: t || DEFAULT_RANK_LABEL });
  },
  editRankLabel() {
    const cur = this.data.rankLabel;
    wx.showModal({
      title: '改一句',
      editable: true,
      placeholderText: '写点你想说的',
      content: cur === DEFAULT_RANK_LABEL ? '' : cur,
      confirmText: '保存',
      success: r => {
        if (!r.confirm) return;
        const v = String(r.content || '').trim().slice(0, 20);
        try { wx.setStorageSync(this.labelKey(this.data.space), v); } catch (e) {}
        this.setData({ rankLabel: v || DEFAULT_RANK_LABEL });
      }
    });
  },

  // ---------- 家庭自定义兑换项 ----------
  async loadRewards(spaceId) {
    const r = await call('flower', { action: 'rewards', spaceId }).catch(() => null);
    if (!r || !r.success) return;
    const isAdmin = !!r.isAdmin;
    this.setData({
      rewards: r.list || [],
      defaults: r.defaults || [],
      rwLimit: r.limit || { minCost: 1, maxCost: 999 },
      isAdmin,
      swipeOff: !isAdmin // 非管理员禁用左滑，否则会滑出一个点不动的空白
    });
  },

  async loadOrders(spaceId) {
    const r = await call('flower', { action: 'rewardOrders', spaceId }).catch(() => null);
    if (r && r.success) this.setData({ orders: r.list || [] });
  },

  openAdd(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset.id;
    if (id) {
      const rw = this.data.rewards.find(x => x._id === id) || {};
      this.setData({ showAdd: true, rwId: id, rwName: rw.name || '', rwCost: rw.cost || 20 });
    } else {
      this.setData({ showAdd: true, rwId: '', rwName: '', rwCost: 20 });
    }
  },
  closeAdd() { this.setData({ showAdd: false }); },
  // 在「添加奖励」弹层上向右滑 = 取消（之前会误退小程序）
  onSheetSwipeClose() {
    if (this.data.showAdd) this.closeAdd();
  },
  noop() {},
  onRwName(e) { this.setData({ rwName: e.detail.value }); },
  onRwCost(e) { this.setData({ rwCost: e.detail.value }); },
  useDefault(e) {
    const i = Number(e.currentTarget.dataset.i);
    const d = this.data.defaults[i];
    if (d) this.setData({ rwName: d.name, rwCost: d.cost });
  },

  async saveReward() {
    if (member.guard('保存家庭奖励')) return;
    const { rwId, rwName, rwCost, space } = this.data;
    const name = String(rwName || '').trim();
    const cost = Number(rwCost);
    if (!name) { wx.showToast({ title: '给奖励起个名字', icon: 'none' }); return; }
    if (!cost || cost < 1 || cost > 999) { wx.showToast({ title: '花朵数填 1~999', icon: 'none' }); return; }
    wx.showLoading({ title: '保存中' });
    try {
      await call('flower', {
        action: 'saveReward',
        spaceId: space._id,
        _id: rwId || '', name, cost, emoji: ''
      });
    } catch (err) {
      wx.hideLoading(); wx.showToast({ title: String(err), icon: 'none' }); return;
    }
    wx.hideLoading();
    this.setData({ showAdd: false });
    this.loadRewards(space._id);
    wx.showToast({ title: '已保存', icon: 'success' });
  },

  async delReward(e) {
    if (member.guard('删除家庭奖励')) return;
    const id = e.currentTarget.dataset.id;
    const rw = this.data.rewards.find(x => x._id === id) || { name: '这个奖励' };
    const r = await new Promise(res => wx.showModal({
      title: '删除奖励', content: '确定删除「' + rw.name + '」吗？', success: res
    }));
    if (!r.confirm) return;
    try {
      await call('flower', { action: 'delReward', spaceId: this.data.space._id, _id: id });
    } catch (err) { wx.showToast({ title: String(err), icon: 'none' }); return; }
    this.loadRewards(this.data.space._id);
    wx.showToast({ title: '已删除', icon: 'success' });
  },

  async redeemReward(e) {
    const id = e.currentTarget.dataset.id;
    const rw = this.data.rewards.find(x => x._id === id);
    if (!rw) return;
    if (this.data.flowers < rw.cost) {
      wx.showToast({ title: '还差 ' + (rw.cost - this.data.flowers) + ' 朵', icon: 'none' });
      return;
    }
    const r = await new Promise(res => wx.showModal({
      title: '兑换', content: '用 ' + rw.cost + ' 朵小红花兑换「' + rw.name + '」？', success: res
    }));
    if (!r.confirm) return;
    try { wx.vibrateShort({ type: 'light' }); } catch (e) {}
    wx.showLoading({ title: '兑换中' });
    let out;
    try {
      out = await call('flower', { action: 'redeemReward', spaceId: this.data.space._id, _id: id });
    } catch (err) {
      wx.hideLoading(); wx.showToast({ title: String(err), icon: 'none' }); return;
    }
    wx.hideLoading();
    this._dirty = true;   // 兑换后余额变了，下次进页面要重拉
    this.load();
    wx.showModal({
      title: '兑换成功',
      content: '去找家人兑现「' + out.name + '」吧！',
      showCancel: false
    });
  },

  async finishOrder(e) {
    const id = e.currentTarget.dataset.id;
    try { wx.vibrateShort({ type: 'light' }); } catch (e) {}
    try {
      await call('flower', { action: 'finishRewardOrder', spaceId: this.data.space._id, _id: id });
    } catch (err) { wx.showToast({ title: String(err), icon: 'none' }); return; }
    this.loadOrders(this.data.space._id);
    wx.showToast({ title: '已兑现', icon: 'success' });
  },


  goRank() { wx.navigateTo({ url: '/pages/rank/rank' }); }
});
