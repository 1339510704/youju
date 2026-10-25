const { call } = require('../../utils/cloud.js');
const bg = require('../../utils/bg.js');
const { ensureSpace } = require('../../utils/guard.js');
const swipe = require('../../utils/swipe.js');
const date = require('../../utils/date.js');
const flower = require('../../utils/flower.js');
const member = require('../../utils/member.js');

const CATS = {
  expense: ['餐饮', '交通', '购物', '教育', '医疗', '居住', '娱乐', '其他'],
  income: ['工资', '兼职', '理财收益', '红包', '其他']
};

// 各分类对应的小色点（让明细一眼可辨）
const CAT_DOT = {
  餐饮: '#FF6B3D', 交通: '#5B8DEF', 购物: '#E0921F', 教育: '#4F9E3F',
  医疗: '#D8392B', 居住: '#8A6FD6', 娱乐: '#FF8FB3', 其他: '#9A8C7A',
  工资: '#2E9E4F', 兼职: '#4F9E3F', 理财收益: '#E0921F', 红包: '#FF6B3D'
};

const round2 = n => Math.round((+n || 0) * 100) / 100;

Page({
  behaviors: [swipe],
  data: {
    space: null, list: [], income: 0, expense: 0, monthExpense: 0, monthIncome: 0, balance: 0, groups: [], _editId: '', _editPlanId: '',
    showAdd: false, type: 'expense', amount: '', note: '',
    categories: CATS.expense, catIndex: 0,
    // 记一笔时可关联理财目标（0 = 不关联，其余对应 plans 的下标 +1）
    planOptions: ['不关联'], planIndex: 0,
    // 理财目标（原「理财规划」页合并进本页）
    plans: [], showPlan: false, planTitle: '', planTarget: '', planCurrent: '', planDeadline: '',
    hideAmount: false,
    _swipeId: ''
  },

  onShow() {
    const ms = member.status();
    this.setData({ memberExpired: ms.expired, daysLeft: ms.daysLeft });
    this.prepare(); bg.apply(this);
  },

  async prepare() {
    const space = await ensureSpace();
    if (!space) return;
    this.setData({ space, hideAmount: getApp().globalData.hideAmount });
    this.load();
  },

  async load() {
    const _pa = await Promise.all([
      call('content', { action: 'list', coll: 'finance', spaceId: this.data.space._id }).catch(() => ({ list: [] })),
      call('content', { action: 'list', coll: 'plans', spaceId: this.data.space._id }).catch(() => ({ list: [] }))
    ]);
    this.renderList(_pa[0].list || [], _pa[1].list || []);
  },

  // 列出/汇总/分组 统一入口：列表页与本地乐观更新都走它，避免重复逻辑 + 全量重载
  renderList(rList, pList) {
    const app = getApp();
    const myOpenid = app.globalData.openid || '';
    const myName = app.globalData.nickName || '';
    const list = (rList || []).sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .map(f => {
        // 显示"谁创建的"：新记账带 creatorName，老数据没有就按 openid 回退（我 / 家人）
        let creatorName = f.creatorName || '';
        if (!creatorName) creatorName = (f._openid === myOpenid && myName) ? myName : '家人';
        // 时间只显示一次：有创建时间就显示「3月5日 14:20」（同年省略年），
        // 没有才回退记账日期，避免同一天重复出现两遍
        const whenText = date.fmtCreated(f.createdAt) || f.date || '';
        return Object.assign({}, f, { creatorName, whenText, catDot: CAT_DOT[f.category] || '#9A8C7A' });
      });
    const income = list.filter(f => f.type === 'income').reduce((s, f) => s + (+f.amount || 0), 0);
    const expense = list.filter(f => f.type === 'expense').reduce((s, f) => s + (+f.amount || 0), 0);
    // 本月支出 / 收入：页头只显示当前月，比累计更有用
    const month = (date.today() || '').slice(0, 7);
    const monthExpense = list
      .filter(f => f.type === 'expense' && (f.date || '').slice(0, 7) === month)
      .reduce((s, f) => s + (+f.amount || 0), 0);
    const monthIncome = list
      .filter(f => f.type === 'income' && (f.date || '').slice(0, 7) === month)
      .reduce((s, f) => s + (+f.amount || 0), 0);
    // 按月分组，方便「逐月看账」
    const groups = [];
    const gmap = {};
    list.forEach(f => {
      const m = (f.date || '').slice(0, 7) || '未知';
      if (!gmap[m]) { gmap[m] = []; groups.push({ month: m, items: gmap[m] }); }
      gmap[m].push(f);
    });
    groups.forEach(g => {
      g.income = round2(g.items.filter(x => x.type === 'income').reduce((s, x) => s + (+x.amount || 0), 0));
      g.expense = round2(g.items.filter(x => x.type === 'expense').reduce((s, x) => s + (+x.amount || 0), 0));
      const mo = (+g.month.split('-')[1]) || 0;
      g.label = (g.month === month) ? '本月' : (mo + '月');
    });
    const plans = (pList || []).map(x => {
      const target = +x.targetAmount || 0;
      const cur = +x.currentAmount || 0;
      return Object.assign({}, x, { percent: target > 0 ? Math.min(100, Math.round(cur / target * 100)) : 0 });
    });
    // 记账弹层里的「算进哪个理财目标」选项
    const planOptions = ['不关联'].concat(plans.map(x => x.title));
    this.setData({
      list, income: round2(income), expense: round2(expense),
      monthExpense: round2(monthExpense), monthIncome: round2(monthIncome),
      balance: round2(income - expense),
      groups, plans, planOptions,
      planIndex: Math.min(this.data.planIndex, planOptions.length - 1)
    });
  },

  openAdd() {
    this.setData({ showAdd: true, _editId: '', type: 'expense', amount: '', note: '', categories: CATS.expense, catIndex: 0, planIndex: 0 });
  },
  // 点流水行 → 编辑（左滑展开时先收起，不进编辑）
  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data._swipeId) { this.closeSwipe(); return; }
    // 兜底：若列表里还有未落库的临时记录，点它会报「记录不存在」，这里直接重载
    if (String(id).indexOf('_tmp_') === 0) {
      wx.showToast({ title: '正在同步，请稍后再点', icon: 'none' });
      this.load();
      return;
    }
    const item = (this.data.list || []).find(f => f._id === id);
    if (!item) return;
    const cats = CATS[item.type] || CATS.expense;
    const catIndex = Math.max(0, cats.indexOf(item.category));
    const planIndex = item.planId ? (this.data.plans.findIndex(p => p._id === item.planId) + 1) : 0;
    this._editItem = item;
    this._editDate = item.date;
    this.setData({
      showAdd: true, _editId: item._id, type: item.type,
      amount: String(item.amount), note: item.note || '',
      categories: cats, catIndex, planIndex: Math.max(0, planIndex)
    });
  },
  closeAdd() { this.setData({ showAdd: false }); },
  noop() {},
  setType(e) {
    const t = e.currentTarget.dataset.t;
    this.setData({ type: t, categories: CATS[t], catIndex: 0 });
  },
  onAmount(e) { this.setData({ amount: e.detail.value }); },
  onNote(e) { this.setData({ note: e.detail.value }); },
  onCat(e) { this.setData({ catIndex: +e.detail.value }); },
  onCatTap(e) { this.setData({ catIndex: +e.currentTarget.dataset.i }); },
  onPlanPick(e) { this.setData({ planIndex: +e.detail.value }); },

  // 编辑流水后，把关联目标金额回算正确（撤销旧关联影响、应用新关联影响）
  async recomputePlan(old, newPlan, newAmount, newType) {
    const step = async (planId, delta) => {
      if (!planId) return;
      const p = (this.data.plans || []).find(x => x._id === planId);
      if (!p) return;
      const cur = +p.currentAmount || 0;
      await call('content', {
        action: 'update', coll: 'plans', _id: planId,
        data: { currentAmount: round2(Math.max(0, cur + delta)) }
      }).catch(() => {});
    };
    // 撤销旧的：收入记 "-金额"，支出记 "+金额"（把当初算进/扣出的部分还原）
    if (old && old.planId) {
      const oldDelta = old.type === 'income' ? -(+old.amount || 0) : (+old.amount || 0);
      await step(old.planId, oldDelta);
    }
    // 应用新的
    if (newPlan) {
      const newDelta = newType === 'income' ? (+newAmount || 0) : -(+newAmount || 0);
      await step(newPlan._id, newDelta);
    }
  },

  async save() {
    if (member.guard('记一笔')) return;
    const amount = parseFloat(this.data.amount);
    if (!(amount > 0)) { wx.showToast({ title: '金额不正确', icon: 'none' }); return; }
    const idx = this.data.planIndex;
    const plan = idx > 0 ? this.data.plans[idx - 1] : null;
    // setData 会【同步】清空 _editId，先存下来，后面合并列表要用它定位原记录
    const editId = this.data._editId;
    const isEdit = !!editId;
    const old = this._editItem || null;
    let added = null;
    wx.showLoading({ title: isEdit ? '保存中' : '保存中' });
    try {
      if (isEdit) {
        await call('content', {
          action: 'update', coll: 'finance', _id: editId,
          data: {
            type: this.data.type,
            category: this.data.categories[this.data.catIndex],
            amount: round2(amount), note: this.data.note, date: this._editDate,
            planId: plan ? plan._id : '', planTitle: plan ? plan.title : ''
          }
        });
        await this.recomputePlan(old, plan, amount, this.data.type);
      } else {
        added = await call('content', {
          action: 'add', coll: 'finance',
          data: {
            spaceId: this.data.space._id,
            type: this.data.type,
            category: this.data.categories[this.data.catIndex],
            amount: round2(amount),
            note: this.data.note, date: date.today(),
            creatorName: getApp().globalData.nickName || '我',
            planId: plan ? plan._id : '', planTitle: plan ? plan.title : ''
          }
        });
        if (plan) {
          const cur = +plan.currentAmount || 0;
          const next = this.data.type === 'income' ? (cur + amount) : (cur - amount);
          await call('content', {
            action: 'update', coll: 'plans', _id: plan._id,
            data: { currentAmount: round2(Math.max(0, next)) }
          }).catch(() => {});
        }
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: String(err), icon: 'none' });
      return;
    }
    wx.hideLoading();
    this.setData({ showAdd: false, _editId: '' });
    // 本地乐观合并：新记账即时入账，不等全量重载
    const d = this.data;
    const newItem = Object.assign({}, payload, {
      _id: editId || (added && added._id) || '',
      whenText: date.fmtCreated(new Date().toISOString()) || d._editDate || date.today(),
      catDot: CAT_DOT[payload.category] || '#9A8C7A',
      createdAt: new Date().toISOString(),
      date: payload.date || d._editDate
    });
    const list = d.list.slice();
    if (editId) {
      // 编辑：替换原记录（_editId 已被清空，用事先存好的 editId）
      const i = list.findIndex(f => f._id === editId);
      if (i >= 0) list[i] = Object.assign({}, list[i], newItem, { _id: editId });
    } else if (newItem._id) {
      list.push(newItem);
    } else {
      // 没拿到真实 _id：重载，避免列表里留下点不动的临时记录
      this.load();
      return;
    }
    // 本地同步理财目标进度
    let plans = d.plans;
    if (plan) {
      const next = (+plan.currentAmount || 0) + (this.data.type === 'income' ? amount : -amount);
      const safe = Math.max(0, next);
      plans = plans.map(x => x._id === plan._id
        ? Object.assign({}, x, {
            currentAmount: round2(safe),
            percent: (+x.targetAmount || 0) > 0 ? Math.min(100, Math.round(safe / (+x.targetAmount || 0) * 100)) : 0
          })
        : x);
    }
    this.renderList(list, plans);
    if (added && added.earned) flower.toastEarn(added.earned);
    else if (plan) wx.showToast({ title: '已计入「' + plan.title + '」', icon: 'none' });
  },

  /* ---------- 理财目标 ---------- */
  openPlan() { this.setData({ showPlan: true, _editPlanId: '', planTitle: '', planTarget: '', planCurrent: '', planDeadline: '' }); },
  // 点目标行 → 编辑（左滑展开时先收起，不进编辑）
  onPlanTap(e) {
    const id = e.currentTarget.dataset.id;
    if (this.data._swipeId) { this.closeSwipe(); return; }
    const item = (this.data.plans || []).find(p => p._id === id);
    if (!item) return;
    this.setData({
      showPlan: true, _editPlanId: item._id,
      planTitle: item.title || '', planTarget: String(item.targetAmount),
      planCurrent: String(item.currentAmount), planDeadline: item.deadline || ''
    });
  },
  closePlan() { this.setData({ showPlan: false }); },
  onPlanTitle(e) { this.setData({ planTitle: e.detail.value }); },
  onPlanTarget(e) { this.setData({ planTarget: e.detail.value }); },
  onPlanCurrent(e) { this.setData({ planCurrent: e.detail.value }); },
  onPlanDate(e) { this.setData({ planDeadline: e.detail.value }); },

  async savePlan() {
    if (member.guard('保存理财目标')) return;
    const title = this.data.planTitle.trim();
    const target = parseFloat(this.data.planTarget);
    if (!title || !(target > 0)) { wx.showToast({ title: '名称和金额必填', icon: 'none' }); return; }
    const isEdit = !!this.data._editPlanId;
    const data = {
      spaceId: this.data.space._id, title,
      targetAmount: round2(target),
      currentAmount: round2(parseFloat(this.data.planCurrent) || 0),
      deadline: this.data.planDeadline, note: ''
    };
    let savedPlan = null;
    wx.showLoading({ title: isEdit ? '保存中' : '创建中' });
    try {
      if (isEdit) savedPlan = await call('content', { action: 'update', coll: 'plans', _id: this.data._editPlanId, data });
      else savedPlan = await call('content', { action: 'add', coll: 'plans', data });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: String(err), icon: 'none' });
      return;
    }
    wx.hideLoading();
    this.setData({ showPlan: false, _editPlanId: '' });
    // 本地乐观合并：目标即时出现 / 更新，不等重载
    const cur = parseFloat(this.data.planCurrent) || 0;
    const plans = this.data.plans.slice();
    if (this.data._editPlanId) {
      const i = plans.findIndex(p => p._id === this.data._editPlanId);
      if (i >= 0) plans[i] = Object.assign({}, plans[i], data, {
        _id: this.data._editPlanId,
        percent: target > 0 ? Math.min(100, Math.round(cur / target * 100)) : 0
      });
    } else if (savedPlan && savedPlan._id) {
      plans.push(Object.assign({}, data, {
        _id: savedPlan._id,
        percent: target > 0 ? Math.min(100, Math.round(cur / target * 100)) : 0
      }));
    }
    this.renderList(this.data.list, plans);
    if (savedPlan && savedPlan.earned) flower.toastEarn(savedPlan.earned);
  },

  async removePlan(e) {
    if (member.guard('删除理财目标')) return;
    const id = e.currentTarget.dataset.id;
    const res = await new Promise(resolve => wx.showModal({
      title: '删除这个目标？', content: '删掉就找不回来了。',
      confirmText: '删除', confirmColor: '#d93b30', cancelText: '再想想', success: resolve
    }));
    if (!res.confirm) return;
    wx.showLoading({ title: '删除中' });
    await call('content', { action: 'remove', coll: 'plans', _id: id }).catch(() => {});
    wx.hideLoading();
    this.setData({ _swipeId: '' });
    this.renderList(this.data.list, this.data.plans.filter(p => p._id !== id));
  },

  async remove(e) {
    if (member.guard('删除记账')) return;
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
    await call('content', { action: 'remove', coll: 'finance', _id: id }).catch(() => {});
    wx.hideLoading();
    this.setData({ _swipeId: '' });
    // 本地移除，即时消失
    this.renderList(this.data.list.filter(f => f._id !== id), this.data.plans);
  },

  // 隐私开关：隐藏 / 显示所有金额（累计结余、本月收支、明细行、首页记账入口 badge）
  toggleHide() {
    const hide = !getApp().globalData.hideAmount;
    getApp().globalData.hideAmount = hide;
    try { wx.setStorageSync('hsmp_hide_amount', hide); } catch (e) {}
    this.setData({ hideAmount: hide });
    getApp().globalData.homeDirty = true; // 返回首页时让记账入口 badge 同步隐藏 / 显示金额
  }

});
