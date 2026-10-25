const { call } = require('../../utils/cloud.js');
const bg = require('../../utils/bg.js');
const { ensureSpace } = require('../../utils/guard.js');
const swipe = require('../../utils/swipe.js');
const config = require('../../config.js');
const date = require('../../utils/date.js');
const flower = require('../../utils/flower.js');
const member = require('../../utils/member.js');

// 待办 + 定时提醒合并成一件事：一条待办可以带一个提醒时间
Page({
  behaviors: [swipe],
  data: {
    space: null, list: [], left: 0, remCount: 0, doneCount: 0,
    showAdd: false, content: '', dueDate: '', remDate: '', remTime: '',
    _editId: '',
    hasTemplateId: false, subOk: false,
    _swipeId: '', _swipeRightId: '',
    swipeRight: true,   // 待办支持右滑「完成」
    // 合体日期+时间选择器
    showRem: false, remDatePick: '',
    // 提醒对象：全家人 / 仅我自己 / 指定成员
    notifyTo: 'all', toIdx: 0, toOptions: ['全家人', '仅我自己', '指定成员'],
    notifyOpenids: [], members: [],
    memberView: []   // 渲染用：[{openid,nickName,on}] —— 模板不能调 indexOf，选中态在这里算
  },

  onShow() {
    const ms = member.status();
    this.setData({ memberExpired: ms.expired, daysLeft: ms.daysLeft });
    this.prepare(); bg.apply(this);
  },

  onLoad(options) {
    // 从首页待办卡点「文字」进来时带上 id，加载完直接打开这条的详情
    if (options && options.id) this._openId = options.id;
  },

  async prepare() {
    const space = await ensureSpace();
    if (!space) return;
    // 微信订阅消息是「一次性授权」(个人主体无长期订阅)，配了模板才显示授权入口
    const hasTemplateId = !!(config.REMINDER_TEMPLATE_ID && config.REMINDER_TEMPLATE_ID.indexOf('请替换') !== 0);
    // 授权过就换一种显示（一直挂着「开通知」会让人以为没生效）
    let subOk = false;
    try { subOk = !!wx.getStorageSync('hsmp_sub_ok'); } catch (e) {}
    this.setData({ space, hasTemplateId, subOk });
    this.load();
  },

  markSubOk() {
    try { wx.setStorageSync('hsmp_sub_ok', 1); } catch (e) {}
    this.setData({ subOk: true });
  },
  clearSubOk() {
    try { wx.removeStorageSync('hsmp_sub_ok'); } catch (e) {}
    this.setData({ subOk: false });
  },

  // 渲染：把原始数据算出派生字段（逾期 / 倒计时 / 提醒文案）+ 排序，再 setData
  // 抽出来后，新建/完成/删除都可以「本地合并」直接刷新，不用每次重拉整个数据库
  renderList(raw) {
    const today = date.today();
    const list = (raw || []).map(t => Object.assign({}, t, {
      overdue: t.dueDate && !t.done && t.dueDate < today,
      dueText: date.friendlyDue(t.dueDate),
      notifyText: t.notifyAt ? ('提醒 ' + date.fmtTime(t.notifyAt).replace(/:/g, ' ')) : '',
      notifyWho: t.notifyAt ? this.whoText(t.notifyTo) : '',
      createdText: date.fmtCreated(t.createdAt)
    }));
    // 未完成在前，再按截止日期
    list.sort((a, b) => (a.done === b.done ? (a.dueDate || '9').localeCompare(b.dueDate || '9') : (a.done ? 1 : -1)));
    this.setData({
      list,
      left: list.filter(t => !t.done).length,
      doneCount: list.filter(t => t.done).length,
      remCount: list.filter(t => !t.done && t.notifyAt).length
    });
  },

  async load() {
    const r = await call('content', { action: 'list', coll: 'todos', spaceId: this.data.space._id }).catch(() => ({ list: [] }));
    this._raw = r.list || [];
    this.renderList(this._raw);
    // 同步到全局缓存：回到首页时待办卡直接读它，秒出、不依赖云库最终一致
    getApp().globalData.todoList = this._raw;
    getApp().globalData.todoListSpace = this.data.space._id;
    // 从首页待办卡点文字进来：加载完直接打开这条详情
    if (this._openId) {
      const it = this._raw.find(t => t._id === this._openId);
      this._openId = '';
      if (it) this.editItem(it);
    }
  },

  // 提醒对象的显示文案
  whoText(nt) {
    if (nt === 'me') return '仅我';
    if (Array.isArray(nt) && nt.length) return nt.length + ' 人';
    return '全家';
  },
  // 拉一次空间成员（选「指定成员」时用），同一空间只拉一次
  async ensureMembers() {
    const spaceId = this.data.space && this.data.space._id;
    if (!spaceId) return;
    if (this._membersFor !== spaceId) {
      const r = await call('space', { action: 'members', spaceId }).catch(() => null);
      if (r && r.success) {
        this._membersFor = spaceId;
        this.setData({
          members: (r.members || []).map(m => ({ openid: m.openid, nickName: m.nickName || '成员' }))
        });
      }
    }
    // 不管是否新拉，都把「选中标记」刷新一遍（新建/编辑时 notifyOpenids 会变）
    this.setData({ memberView: this.memberViewOf() });
  },

  // 渲染用：给成员附上「是否选中」（模板里不用 indexOf）
  memberViewOf() {
    const sel = this.data.notifyOpenids || [];
    return (this.data.members || []).map(m => ({
      openid: m.openid, nickName: m.nickName, on: sel.indexOf(m.openid) >= 0
    }));
  },
  onNotifyTo(e) {
    const idx = parseInt(e.detail.value, 10) || 0;
    const notifyTo = ['all', 'me', 'some'][idx] || 'all';
    this.setData({ toIdx: idx, notifyTo });
    if (notifyTo === 'some') this.ensureMembers();
  },
  toggleMember(e) {
    const o = e.currentTarget.dataset.o;
    const list = (this.data.notifyOpenids || []).slice();
    const i = list.indexOf(o);
    if (i >= 0) list.splice(i, 1); else list.push(o);
    this.setData({ notifyOpenids: list });
    this.setData({ memberView: this.memberViewOf() });
  },

  // 由「点文字」或首页跳转打开某条待办的编辑/详情（同一套逻辑）
  editItem(item) {
    let remDate = '', remTime = '';
    // 提醒时间回填：notifyAt 云端返回的多是 ISO(UTC) 字符串（如 2026-09-20T17:50:00.000Z），
    // 直接按 'T' 切会拿到 UTC 时间 → 「设的 01:50」会变成「前一天 17:50」。
    // 统一交给 Date + 本地(北京时间)格式化，Date 和字符串两种存法都对。
    const nd = item.notifyAt ? new Date(item.notifyAt) : null;
    if (nd && !isNaN(nd.getTime())) {
      remDate = nd.getFullYear() + '-' + date.pad(nd.getMonth() + 1) + '-' + date.pad(nd.getDate());
      remTime = date.pad(nd.getHours()) + ':' + date.pad(nd.getMinutes());
    } else if (item.notifyAt && String(item.notifyAt).indexOf('T') > 0) {
      const parts = String(item.notifyAt).split('T');
      remDate = parts[0];
      remTime = (parts[1] || '09:00:00').slice(0, 5);
    }
    const nt = item.notifyTo;
    const notifyTo = nt === 'me' ? 'me' : (Array.isArray(nt) && nt.length ? 'some' : 'all');
    const toIdx = notifyTo === 'me' ? 1 : (notifyTo === 'some' ? 2 : 0);
    this._editItem = item;
    this.setData({
      showAdd: true, _editId: item._id,
      content: item.content || '', dueDate: item.dueDate || '',
      remDate, remTime,
      notifyTo, toIdx, notifyOpenids: notifyTo === 'some' ? nt.slice() : []
    });
    if (notifyTo === 'some') this.ensureMembers();
  },

  // 授权接收微信提醒（一次性授权，点一次管一次）
  subscribe() {
    wx.requestSubscribeMessage({
      tmplIds: [config.REMINDER_TEMPLATE_ID],
      success: (res) => {
        const v = res && res[config.REMINDER_TEMPLATE_ID];
        if (v === 'accept') {
          this.markSubOk();
          wx.showToast({ title: '已开启微信提醒', icon: 'success' });
        } else {
          // 拒绝了就把标记撤掉，页面显示与实际保持一致，并说明去哪儿改
          this.clearSubOk();
          wx.showModal({
            title: '这次没允许',
            content: '微信规定：一次授权只能收到一条提醒。\n\n'
              + '如果授权框不再弹出，说明之前勾过「总是保持以上选择」，微信会按记忆自动应答。\n'
              + '可以这样恢复：\n'
              + '① 小程序右上角「···」→ 设置 → 通知管理，把「待办任务开始提醒」设为「接收」；\n'
              + '② 或把小程序从微信「最近使用」里删除，重新打开后再点一次授权。',
            showCancel: false,
            confirmText: '知道了'
          });
        }
      },
      fail: () => {
        this.clearSubOk();
        wx.showToast({ title: '授权弹窗没弹出来，请再点一次', icon: 'none' });
      }
    });
  },

  openAdd() {
    this.setData({
      showAdd: true, _editId: '', content: '', dueDate: '', remDate: '', remTime: '',
      // 提醒对象默认「仅我自己」
      notifyTo: 'me', toIdx: 1, notifyOpenids: []
    });
    this.ensureMembers();
  },

  // 收不到提醒时的自检：让云端立刻给自己发一条，把微信的原始结果弹出来
  async testPush() {
    wx.showLoading({ title: '发送中' });
    let r = null, err = '', diag = null;
    try {
      r = await call('remind', { action: 'testPush' });
      // 顺带自检：定时任务到底有没有在跑（看有没有「到点却没推送」的积压提醒）
      diag = await call('remind', { action: 'diag' }).catch(() => null);
    } catch (e) { err = String(e); }
    wx.hideLoading();
    if (err) {
      wx.showModal({
        title: '测试失败',
        content: err + '\n\n若是「未知操作」，说明 remind 云函数还没重新上传部署。',
        showCancel: false
      });
      return;
    }
    if (r && r.success) {
      // 自检结论：有积压的到点提醒 = 定时任务没跑（这是"收不到提醒"最常见的原因）
      let extra = '';
      const overdue = (diag && diag.overduePending) || [];
      const pending = (diag && diag.pending) || [];
      if (overdue.length) {
        extra = '\n\n⚠️ 自检：有 ' + overdue.length + ' 条「已到点但没推送」的提醒（如：'
          + overdue[0].content + ' ' + overdue[0].at + '）。\n'
          + '说明每分钟的定时任务没在执行。请到 云开发控制台 → 云函数 → remind → 「触发器」，'
          + '确认有一条 remindTick（Cron：0 0/1 * * * * *）；\n'
          + '没有就右键 remind「上传并部署：云端安装依赖」，触发器会一起创建。';
      } else if (pending.length) {
        extra = '\n\n自检：定时任务正常，还有 ' + pending.length + ' 条待推送（最近：'
          + pending[0].content + ' ' + pending[0].at + '）。';
      } else if (diag) {
        extra = '\n\n自检：当前没有待推送的提醒。';
      }
      wx.showModal({
        title: '已发出',
        content: '微信已受理（errcode=' + (r.errCode || 0) + '）。\n请到微信「服务通知」里看有没有这条「测试提醒」。' + extra,
        showCancel: false
      });
      return;
    }
    wx.showModal({
      title: '发送被拒绝',
      content: '错误码：' + ((r && r.errCode) || '') + '\n' + ((r && r.errMsg) || '') +
        '\n\n43101=用户未授权/额度用完；47003=模板字段不匹配；40003=openid 错误。',
      showCancel: false
    });
  },
  // 点待办行（文字）→ 编辑/详情（先收起左滑，不拦点击）
  onItemTap(e) {
    const id = e.currentTarget.dataset.id;
    this.closeSwipe();
    // 兜底：若列表里还有未落库的临时记录，点它会报「记录不存在」，这里直接重载
    if (String(id).indexOf('_tmp_') === 0) {
      wx.showToast({ title: '正在同步，请稍后再点', icon: 'none' });
      this.load();
      return;
    }
    const item = (this.data.list || []).find(t => t._id === id);
    if (!item) return;
    this.editItem(item);
  },
  closeAdd() { this.setData({ showAdd: false }); },
  noop() {},
  onContent(e) { this.setData({ content: e.detail.value }); },
  onDate(e) { this.setData({ dueDate: e.detail.value }); },

  // 日期 + 时间：一行两个选择器
  // 没设过提醒时，默认给「当前时间往后 5 分钟」，省得每次都从头选
  openRem() {
    if (this.data.remDate) {
      this.setData({ showRem: true, remDatePick: this.data.remDate });
      return;
    }
    const t = new Date(Date.now() + 5 * 60 * 1000);
    const hh = t.getHours() < 10 ? '0' + t.getHours() : '' + t.getHours();
    const mm = t.getMinutes() < 10 ? '0' + t.getMinutes() : '' + t.getMinutes();
    this.setData({
      showRem: true,
      remDatePick: date.fmt(t),
      remTime: hh + ':' + mm
    });
  },
  onRemDate(e) {
    this.setData({ remDatePick: e.detail.value || '' });
  },
  onRemTime(e) {
    this.setData({ remTime: e.detail.value || '09:00' });
  },
  confirmRem() {
    const d = this.data.remDatePick || date.fmt(new Date());
    const t = this.data.remTime || '09:00';
    this.setData({ remDate: d, remTime: t, showRem: false });
  },
  clearRem() { this.setData({ remDate: '', remTime: '', showRem: false }); },
  closeRem() { this.setData({ showRem: false }); },

  // 点保存：若设了提醒，必须【在点击的当下】同步弹订阅授权。
  // 等 await 网络请求之后再弹会脱离点击手势，微信直接判 fail（用户明明没拒绝也提示"未授权"）
  save() {
    if (member.guard('保存待办')) return;
    const content = this.data.content.trim();
    if (!content) { wx.showToast({ title: '写点啥吧', icon: 'none' }); return; }
    const { remDate, remTime } = this.data;
    const notifyAt = remDate ? (remDate + 'T' + (remTime || '09:00') + ':00') : '';
    if (notifyAt && this.data.hasTemplateId) {
      wx.requestSubscribeMessage({
        tmplIds: [config.REMINDER_TEMPLATE_ID],
        success: res => {
          const v = res && res[config.REMINDER_TEMPLATE_ID];
          if (v === 'accept') {
            this.markSubOk();
          } else if (v === 'reject') {
            // 这次没允许：页面状态同步退回「未开启」，别让顶部显示和实际相反
            this.clearSubOk();
            wx.showToast({ title: '这次未允许，微信提醒不会发', icon: 'none', duration: 2500 });
          }
        },
        complete: () => this.doSave(notifyAt)   // 无论允许/拒绝，都继续保存
      });
    } else {
      this.doSave(notifyAt);
    }
  },

  async doSave(notifyAt) {
    const content = this.data.content.trim();
    // setData 会【同步】清空 _editId，先存下来，后面合并列表要用它定位原记录
    const editId = this.data._editId;
    const isEdit = !!editId;
    // 提醒对象：'all' 全家人 / 'me' 仅自己 / [openid...] 指定成员
    let notifyTo = 'all';
    if (this.data.notifyTo === 'me') notifyTo = 'me';
    else if (this.data.notifyTo === 'some') {
      const ids = (this.data.notifyOpenids || []).slice();
      if (!ids.length) { wx.showToast({ title: '先选要提醒谁', icon: 'none' }); return; }
      notifyTo = ids;
    }
    const base = {
      spaceId: this.data.space._id, content, dueDate: this.data.dueDate || '', notifyAt, notifyTo
    };
    wx.showLoading({ title: isEdit ? '保存中' : '创建中' });
    let newId = '';
    try {
      if (isEdit) {
        await call('content', { action: 'update', coll: 'todos', _id: editId, data: base });
      } else {
        const res = await call('content', { action: 'add', coll: 'todos', data: Object.assign({ notified: false, done: false }, base) });
        newId = (res && res._id) || '';
      }
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: String(err), icon: 'none' });
      return;
    }
    wx.hideLoading();
    this.setData({ showAdd: false, _editId: '' });
    // 本地合并，不重拉整个数据库，新建后秒出
    const raw = (this._raw || []).slice();
    if (isEdit) {
      // 编辑：替换原记录（_editId 已被清空，用事先存好的 editId）
      const idx = raw.findIndex(t => t._id === editId);
      if (idx >= 0) raw[idx] = Object.assign({}, raw[idx], base, { _id: editId });
    } else if (newId) {
      raw.unshift(Object.assign({}, base, { _id: newId, done: false, notified: false, createdAt: new Date().toISOString() }));
    } else {
      // 没拿到真实 _id：重载，避免列表里留下点不动的临时记录
      this.load();
      return;
    }
    this._raw = raw;
    this.renderList(raw);
    getApp().globalData.homeDirty = true;
    getApp().globalData.todoList = raw;
    getApp().globalData.todoListSpace = this.data.space._id;
  },

  async toggle(e) {
    if (member.guard('完成待办')) return;
    const id = e.currentTarget.dataset.id;
    // 只在点左边圆圈(O)时触发；点文字进编辑，不会到这里
    const r = await call('content', { action: 'toggle', coll: 'todos', _id: id, field: 'done' }).catch(() => ({}));
    if (r && r.earned) { flower.toastEarn(r.earned); getApp().globalData.flowerDirty = true; }
    const raw = (this._raw || []).slice();
    const idx = raw.findIndex(t => t._id === id);
    if (idx >= 0) { raw[idx] = Object.assign({}, raw[idx], { done: !raw[idx].done }); this._raw = raw; this.renderList(raw); }
    getApp().globalData.homeDirty = true;
    getApp().globalData.todoList = raw;
    getApp().globalData.todoListSpace = this.data.space._id;
  },

  // 左滑露出「删除」，点删除即真删（删前二次确认，没有撤销）
  async remove(e) {
    if (member.guard('删除待办')) return;
    const id = e.currentTarget.dataset.id;
    const res = await new Promise(resolve => wx.showModal({
      title: '删除任务？',
      content: '删除后不可恢复。',
      confirmText: '删除',
      confirmColor: '#d93b30',
      cancelText: '取消',
      success: resolve
    }));
    if (!res.confirm) return;
    wx.showLoading({ title: '删除中' });
    try {
      await call('content', { action: 'remove', coll: 'todos', _id: id });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: String(err), icon: 'none' });
      return;
    }
    wx.hideLoading();
    this.setData({ _swipeId: '' });
    this._raw = (this._raw || []).filter(t => t._id !== id);
    this.renderList(this._raw);
    getApp().globalData.homeDirty = true;
    getApp().globalData.todoList = this._raw;
    getApp().globalData.todoListSpace = this.data.space._id;
  }

});
