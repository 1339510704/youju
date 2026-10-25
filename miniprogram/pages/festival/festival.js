const { call } = require('../../utils/cloud.js');
const bg = require('../../utils/bg.js');
const { ensureSpace } = require('../../utils/guard.js');
const swipe = require('../../utils/swipe.js');
const date = require('../../utils/date.js');
const lunar = require('../../utils/lunar.js');
const flower = require('../../utils/flower.js');
const member = require('../../utils/member.js');
const config = require('../../config.js');

const LUNAR_MONTHS = lunar.MONTHS;
const LUNAR_DAYS = lunar.DAYS;

// ---------- 提醒时间计算（与 remind 云函数同格式：YYYY-MM-DDTHH:mm:00）----------
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function fmtLocal(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00';
}
// 算出「下一次过节」的提醒时刻（提前 leadDays 天，上午 9 点）
function computeNotifyAt(f) {
  let d = null;
  if (f.isLunar && f.lMonth) {
    try { const nx = lunar.lunarNextSolar(f.lMonth, f.lDay, !!f.lLeap); d = new Date(nx.dateStr + 'T09:00:00'); }
    catch (e) { d = null; }
  } else if (f.date) {
    d = new Date(f.date + 'T09:00:00');
    if (!isNaN(d) && d < new Date()) d = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate(), 9, 0, 0);
  }
  if (!d || isNaN(d)) return '';
  return fmtLocal(new Date(d.getTime() - (f.leadDays || 0) * 86400000));
}

Page({
  behaviors: [swipe],
  data: {
    space: null, list: [], showAdd: false, name: '', date: '', note: '', _swipeId: '', _editId: '',
    // 公历 / 农历（切换农历时按所选日期自动换算，不用再选月日）
    isLunar: false, lMonth: 1, lDay: 1, lLeap: false, lText: '',
    // 天数显示方式：倒计时（还有 N 天）/ 累计（已 N 天）
    dayModeIdx: 1, dayMode: 'left', dayModeText: '只看倒计时',
    dayOptions: ['只看倒计时', '只看累计', '两个都显示'], dayValues: ['left', 'since', 'both'],
    // 提前提醒（微信订阅消息，一次授权 = 一条）
    leadIdx: 1, leadDays: 1,
    leadOptions: ['当天', '提前 1 天', '提前 3 天', '提前 7 天'], leadValues: [0, 1, 3, 7],
    // 提醒谁：全家人 / 仅我自己（默认全家，老数据没这个字段也按全家）
    toOptions: ['全家人', '仅我自己'], toIdx: 0
  },

  onShow() {
    const ms = member.status();
    this.setData({ memberExpired: ms.expired, daysLeft: ms.daysLeft });
    this.prepare(); bg.apply(this);
  },

  async prepare() {
    const space = await ensureSpace();
    if (!space) return;
    this.setData({ space });
    this.load();
  },

  async load() {
    const r = await call('content', { action: 'list', coll: 'festivals', spaceId: this.data.space._id }).catch(() => ({ list: [] }));
    this.renderList(r.list || []);
  },

  // 单条装饰：算出展示用的下一次日期 / 倒计时 / 农历文案
  decorate(f) {
    let dateStr = '', lunarText = '', sinceDays = null, days = null;
    if (f.isLunar && f.lMonth) {
      try {
        const nx = lunar.lunarNextSolar(f.lMonth, f.lDay, !!f.lLeap);
        dateStr = nx.dateStr;          // 农历只存月日，所以显示「下一次的公历日期」是对的
        days = date.daysUntil(dateStr);
        lunarText = lunar.lunarText(f.lMonth, f.lDay, !!f.lLeap);
      } catch (e) { dateStr = ''; }
      // 农历累计：需要「起始年」才能定位第一次的公历日期
      if (f.sinceYear) {
        try {
          const s = lunar.lunarToSolar(f.sinceYear, f.lMonth, f.lDay, !!f.lLeap);
          const sd = s.y + '-' + date.pad(s.m) + '-' + date.pad(s.d);
          // 起始日在未来时是负数 → 按 0 天算，否则「两个都显示」会被下面的 >=0 过滤掉
          sinceDays = Math.max(0, -date.daysUntil(sd));
        } catch (e) { sinceDays = null; }
      }
    } else if (f.date) {
      // 公历：显示「你填的那一天」，不再偷偷顺延到明年
      // （之前填 2026-02-01、列表却显示 2027-02-01，就是这个顺延干的）
      dateStr = f.date;
      // 累计 = 从填的那天到今天（未来则按 0 天，避免被 >=0 过滤掉，选了「两个都显示」也会只显示一个）
      sinceDays = Math.max(0, -date.daysUntil(f.date));
      // 倒计时按「下一次」算：这天已经过去就顺延到明年同一天
      let next = new Date(f.date + 'T00:00:00');
      const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      if (next < t0) next = new Date(next.getFullYear() + 1, next.getMonth(), next.getDate());
      days = date.daysUntil(date.fmt(next));
    }
    // 按用户选择决定显示「还剩」「已过」还是两者都显示（没选过的老数据默认两个都显示）
    const mode = f.dayMode === 'since' ? 'since' : (f.dayMode === 'left' ? 'left' : 'both');
    const showLeft = mode !== 'since';
    const showSince = mode !== 'left';
    // 直接算好「要显示哪几个」：两个都显示时是两个标签，不能再用 if/elif 串（那样只会命中一个）
    const chips = [];
    if (showSince && sinceDays != null && sinceDays >= 0) {
      chips.push({ text: '已 ' + sinceDays + ' 天', cls: 'days-since' });
    }
    if (showLeft) {
      if (days === 0) chips.push({ text: '就是今天', cls: 'days-warn' });
      else if (days != null && days > 0) chips.push({ text: '还有 ' + days + ' 天', cls: 'days-soon' });
    }
    if (!chips.length) chips.push({ text: '—', cls: 'days-mute' });
    return Object.assign({}, f, {
      date: dateStr, lunarText, days, sinceDays, showLeft, showSince, dayChips: chips
    });
  },

  // 渲染列表：装饰 + 按倒计时排序（列表页与本地乐观更新共用）
  renderList(raw) {
    const list = (raw || []).map(f => this.decorate(f))
      .sort((a, b) => (a.days == null ? 1e9 : a.days) - (b.days == null ? 1e9 : b.days));
    this.setData({ list });
  },

  openAdd() {
    const today = date.fmt(new Date());
    const L = this.lunarOf(today);
    this.setData({
      showAdd: true, _editId: '', name: '', date: today, note: '',
      isLunar: false, lMonth: L ? L.month : 1, lDay: L ? L.day : 1, lLeap: L ? L.isLeap : false,
      lText: L ? L.text : '',
      dayModeIdx: 1, dayMode: 'left', dayModeText: '只看倒计时',
      leadIdx: 1, leadDays: 1,
      toIdx: 0
    });
  },

  // 由所选公历日期推算出农历（切换农历时自动带出，不用再单独选月/日）
  lunarOf(ds) {
    const s = ds || date.fmt(new Date());
    const y = parseInt(s.slice(0, 4), 10), m = parseInt(s.slice(5, 7), 10), d = parseInt(s.slice(8, 10), 10);
    let r = null;
    try { r = lunar.solarToLunar(y, m, d); } catch (e) { r = null; }
    if (!r) return null;
    return {
      year: r.lunarYear, month: r.lunarMonth, day: r.lunarDay, isLeap: !!r.isLeap,
      text: lunar.cnMonth(r.lunarMonth, r.isLeap) + lunar.cnDay(r.lunarDay)
    };
  },

  // 公历 / 农历 切换（一排两个小按钮）
  switchType(e) {
    const isLunar = e.currentTarget.dataset.t === 'lunar';
    if (!isLunar) { this.setData({ isLunar: false }); return; }
    const L = this.lunarOf(this.data.date);
    this.setData({
      isLunar: true,
      lMonth: L ? L.month : 1, lDay: L ? L.day : 1, lLeap: L ? L.isLeap : false,
      lText: L ? L.text : ''
    });
  },

  // 天数显示方式：只看倒计时 / 只看累计 / 两个都显示
  onMode(e) {
    const idx = parseInt(e.detail.value, 10) || 0;
    this.setData({ dayModeIdx: idx, dayMode: this.data.dayValues[idx], dayModeText: this.data.dayOptions[idx] });
  },
  onLead(e) {
    const idx = e.detail.value;
    this.setData({ leadIdx: idx, leadDays: this.data.leadValues[idx] });
  },
  // 提醒谁：0 = 全家人 / 1 = 仅我自己
  onTo(e) { this.setData({ toIdx: parseInt(e.detail.value, 10) || 0 }); },
  // 点节日行 → 编辑（左滑展开时先收起，不进编辑）
  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data._swipeId) { this.closeSwipe(); return; }
    // 兜底：若列表里还有未落库的临时记录，点它会报「记录不存在」，这里直接重载换成真实记录
    if (String(id).indexOf('_tmp_') === 0) {
      wx.showToast({ title: '正在同步，请稍后再点', icon: 'none' });
      this.load();
      return;
    }
    const item = (this.data.list || []).find(f => f._id === id);
    if (!item) return;
    // 农历节日：用「起始年（农历年）+ 月日」还原出当年那天，日期选到原日期上，
    // 这样再点农历能换算出同样的月日，累计天数也不会漂移。
    let ds = item.date || date.fmt(new Date());
    if (item.isLunar && item.lMonth) {
      try {
        if (item.sinceYear) {
          const s = lunar.lunarToSolar(item.sinceYear, item.lMonth, item.lDay, !!item.lLeap);
          ds = s.y + '-' + date.pad(s.m) + '-' + date.pad(s.d);
        }
      } catch (err) { /* 还原失败就用下一次的日期 */ }
    }
    const L = this.lunarOf(ds);
    const mode = item.dayMode === 'since' ? 'since' : (item.dayMode === 'left' ? 'left' : 'both');
    const modeIdx = Math.max(0, this.data.dayValues.indexOf(mode));
    const leadDays = (item.leadDays == null ? 1 : item.leadDays);
    this.setData({
      showAdd: true, _editId: item._id, name: item.name || '', note: item.note || '',
      date: ds,
      isLunar: !!item.isLunar,
      lMonth: L ? L.month : (item.lMonth || 1), lDay: L ? L.day : (item.lDay || 1),
      lLeap: L ? L.isLeap : !!item.lLeap, lText: L ? L.text : '',
      dayModeIdx: modeIdx, dayMode: mode, dayModeText: this.data.dayOptions[modeIdx],
      leadDays, leadIdx: Math.max(0, this.data.leadValues.indexOf(leadDays)),
      toIdx: item.notifyTo === 'me' ? 1 : 0
    });
  },
  closeAdd() { this.setData({ showAdd: false }); },
  noop() {},
  onName(e) { this.setData({ name: e.detail.value }); },
  onNote(e) { this.setData({ note: e.detail.value }); },
  // 选日期：农历模式下顺手把农历换算出来
  onDate(e) {
    const ds = e.detail.value;
    if (!this.data.isLunar) { this.setData({ date: ds }); return; }
    const L = this.lunarOf(ds);
    this.setData({
      date: ds,
      lMonth: L ? L.month : 1, lDay: L ? L.day : 1, lLeap: L ? L.isLeap : false,
      lText: L ? L.text : ''
    });
  },

  async save() {
    if (member.guard('保存节日')) return;
    const name = this.data.name.trim();
    if (!name) { wx.showToast({ title: '写个名字吧', icon: 'none' }); return; }
    // setData 会【同步】清空 _editId，所以必须在清空前先存下来，后面合并列表还要用它定位原记录
    const editId = this.data._editId;
    const isEdit = !!editId;
    let data;
    if (this.data.isLunar) {
      // 农历月日由所选日期自动换算，不用手选
      const L = this.lunarOf(this.data.date);
      if (!L) { wx.showToast({ title: '选好日期', icon: 'none' }); return; }
      data = {
        spaceId: this.data.space._id, name, note: this.data.note,
        isLunar: true, lMonth: L.month, lDay: L.day, lLeap: L.isLeap, date: '',
        sinceYear: L.year   // 累计天数从「所选日期」所在的农历年开始算，不用用户再填
      };
    } else {
      if (!this.data.date) { wx.showToast({ title: '选好日期', icon: 'none' }); return; }
      data = {
        spaceId: this.data.space._id, name, note: this.data.note,
        isLunar: false, lMonth: 0, lDay: 0, lLeap: false, date: this.data.date
      };
    }
    data.dayMode = this.data.dayMode || 'left';   // 天数显示方式
    // 提醒谁：'all' 全家人 / 'me' 仅我自己（到点微信推送只发给选中的人）
    data.notifyTo = this.data.toIdx === 1 ? 'me' : 'all';
    // 提醒：算出下一次过节提前 N 天的时刻（微信订阅消息到点推送）
    const leadDays = this.data.leadDays || 0;
    const notifyAt = computeNotifyAt(Object.assign({}, data, { leadDays }));
    data.leadDays = leadDays;
    data.notifyAt = notifyAt;
    data.notified = false;
    // ⚠️ 订阅授权必须在「点击的当下」同步弹出。之前放在 await 云函数之后，
    //    微信判定不是用户点击手势 → 直接 fail（就是你看到的"授权弹窗没弹出来"）。
    this.askSubscribe(!!notifyAt);
    wx.showLoading({ title: isEdit ? '保存中' : '创建中' });
    let saved = null;
    try {
      if (isEdit) saved = await call('content', { action: 'update', coll: 'festivals', _id: editId, data });
      else saved = await call('content', { action: 'add', coll: 'festivals', data });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: String(err), icon: 'none' });
      return;
    }
    wx.hideLoading();
    this.setData({ showAdd: false, _editId: '' });
    // 本地乐观合并：新节日即时出现在列表，不等重载
    const realId = (saved && saved._id) || '';
    const list = this.data.list.slice();
    if (editId) {
      // 编辑：必须替换原记录。之前 _editId 被 setData 清空后才读，永远走"新增"分支，
      // 列表里会多出一条一模一样的（看着就像"日期算错/重复"），点它还报"记录不存在"。
      const i = list.findIndex(f => f._id === editId);
      if (i >= 0) list[i] = this.decorate(Object.assign({}, list[i], data, { _id: editId }));
      this.renderList(list);
    } else if (realId) {
      list.push(this.decorate(Object.assign({}, data, { _id: realId })));
      this.renderList(list);
    } else {
      // 没拿到真实 _id：重载，避免列表里留下点不动的临时记录
      this.load();
    }
    if (saved && saved.earned) flower.toastEarn(saved.earned);
  },

  // 需要提醒时，在【同步阶段】（点保存的那一刻）弹一次订阅授权：一次授权 = 一条推送
  askSubscribe(need) {
    if (!need) return;
    const tid = config.REMINDER_TEMPLATE_ID;
    if (!tid || tid.indexOf('请替换') === 0) return;
    wx.requestSubscribeMessage({
      tmplIds: [tid],
      success: (res) => {
        if (!res || res[tid] !== 'accept') {
          wx.showToast({ title: '这次未允许，微信提醒不会发', icon: 'none', duration: 2500 });
        }
      },
      fail: () => wx.showToast({ title: '授权弹窗没弹出来，请再点一次保存', icon: 'none' })
    });
  },

  // 删除是敏感操作：先二次确认，避免误触
  async remove(e) {
    if (member.guard('删除节日')) return;
    const id = e.currentTarget.dataset.id;
    const res = await new Promise(resolve => wx.showModal({
      title: '确认删除？',
      content: '删掉就找不回来了。',
      confirmText: '删除',
      confirmColor: '#d93b30',
      cancelText: '再想想',
      success: resolve
    }));
    if (!res.confirm) return;
    wx.showLoading({ title: '删除中' });
    await call('content', { action: 'remove', coll: 'festivals', _id: id }).catch(() => {});
    wx.hideLoading();
    this.setData({ _swipeId: '' });
    // 本地移除，即时消失
    this.renderList(this.data.list.filter(f => f._id !== id));
  }
});
