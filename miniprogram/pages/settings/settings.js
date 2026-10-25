const { call } = require('../../utils/cloud.js');
const bg = require('../../utils/bg.js');
const { ORDER_TEMPLATE_ID, FEATURES } = require('../../config.js');

function pad(n) { return n < 10 ? '0' + n : '' + n; }
// 时间戳 → 09-22 14:05（备份时间提示用）
function fmtTime(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

Page({
  data: {
    version: '1.9.9',
    notifyOn: true,
    cloud: { ready: false, kind: '', msg: '' },
    diag: { sdk: false, fn: false, db: false },

    features: FEATURES,
    versionTaps: 0,
    showAdmin: false,
    adminKey: '',
    showAdminKeyInput: false,
    adminKeyInput: '',
    adminAuthed: false,

    codes: [], codesView: [], codeTab: 'available', availCount: 0, usedUpCount: 0, stoppedCount: 0, _revokeId: '',

    backupBusy: false, lastBackupText: '',
    showGen: false, genType: 'member', genUnit: 'day', genAmount: 7, genCount: 10, genMaxUses: 1, genExpiresDays: 0, genNote: '', genCustom: '', genList: [], genBusy: false,

    showCodeDetail: false, codeDetail: null
  },

  onShow() { this.refresh(); bg.apply(this); },

  async refresh() {
    const app = getApp();
    const ok = await app.ensureReady();
    const g = app.globalData;
    const me = g.profile || {};
    this.setData({
      cloud: { ready: ok, kind: g.errorKind, msg: g.cloudError },
      diag: { sdk: !!g.cloudInited, fn: !!g.cloudReady, db: !!g.dbReady },
      notifyOn: me.notifyOn !== false
    });
    this.refreshBackupText();
    if (this.data.adminAuthed) this.loadCodes();
  },

  // 上次备份时间：存在本地（只是个提示，真正的备份文件在云存储里）
  refreshBackupText() {
    let last = null;
    try { last = wx.getStorageSync('hsmp_last_backup') || null; } catch (e) { last = null; }
    if (!last || !last.at) { this.setData({ lastBackupText: '' }); return; }
    this.setData({
      lastBackupText: '上次备份 ' + fmtTime(last.at) + '（' + (last.total || 0) + ' 条）'
    });
  },

  /* ---------- 一键备份（仅管理员区可见） ---------- */
  doBackup() {
    if (this.data.backupBusy) return;
    wx.showModal({
      title: '备份全部数据',
      content: '会把全部 15 个集合的数据导成一个 JSON 文件，存到云存储 backup/ 目录，并给你一个下载链接。\n\n'
        + '⚠️ 环境一旦被释放，云存储也会一起消失，所以备份完请务必把文件下载到电脑。',
      confirmText: '开始备份', cancelText: '取消',
      success: (res) => { if (res.confirm) this.runBackupNow(); }
    });
  },

  async runBackupNow() {
    this.setData({ backupBusy: true });
    wx.showLoading({ title: '备份中', mask: true });
    let r = null, err = '';
    try { r = await call('flower', { action: 'backup', adminKey: this.data.adminKey }); }
    catch (e) { err = String(e); }
    wx.hideLoading();
    this.setData({ backupBusy: false });

    if (err || !r || !r.success) {
      wx.showModal({
        title: '备份失败',
        content: err || (r && r.errMsg) || '未知错误（若提示超时，把 flower 云函数超时时间调到 60 秒再试）',
        showCancel: false
      });
      return;
    }

    try {
      wx.setStorageSync('hsmp_last_backup', { at: Date.now(), total: r.total, sizeKB: r.sizeKB, fileID: r.fileID });
    } catch (e) { /* 存不上不影响备份本身 */ }
    this.refreshBackupText();

    const c = r.counts || {};
    const top = Object.keys(c).filter(k => c[k]).sort((a, b) => c[b] - c[a])
      .slice(0, 6).map(k => k + ' ' + c[k]).join('、');
    const lines = ['已导出 ' + (r.total || 0) + ' 条数据 · ' + (r.sizeKB || 0) + 'KB。'];
    if (top) lines.push('包含：' + top + (r.total > 0 ? ' 等' : ''));
    if ((r.errors || []).length) lines.push('⚠️ 有集合读取失败：' + r.errors.join('；'));
    lines.push('文件已存到云存储 backup/ 目录。');
    lines.push(r.url
      ? '点下面「复制下载链接」，在电脑浏览器里打开就能下载保存。'
      : '请到 云开发控制台 → 云存储 → backup/ 下载。');

    wx.showModal({
      title: '备份完成',
      content: lines.join('\n'),
      confirmText: r.url ? '复制下载链接' : '知道了',
      cancelText: r.url ? '知道了' : '',
      showCancel: !!r.url,
      success: (res) => {
        if (res.confirm && r.url) {
          wx.setClipboardData({ data: r.url });
        }
      }
    });
  },

  onVersionTap() {
    const taps = this.data.versionTaps + 1;
    this.setData({ versionTaps: taps });
    if (taps >= 5 && !this.data.showAdmin) {
      this.setData({ showAdmin: true, showAdminKeyInput: true });
    }
    if (taps >= 5) {
      this.setData({ versionTaps: 0 });
    }
  },

  /* ---------- 管理员密钥 ---------- */
  closeAdminKey() { this.setData({ showAdminKeyInput: false }); },
  onAdminKeyInput(e) { this.setData({ adminKeyInput: e.detail.value }); },
  async doAdminAuth() {
    const key = String(this.data.adminKeyInput || '').trim();
    if (!key) { wx.showToast({ title: '请输入密钥', icon: 'none' }); return; }
    const r = await call('flower', { action: 'listCodes', adminKey: key }).catch(() => null);
    if (!r || !r.success) {
      wx.showToast({ title: '密钥错误', icon: 'none' });
      return;
    }
    this.setData({
      adminKey: key, adminAuthed: true,
      showAdminKeyInput: false,
      codes: this.decorate(r.list || [])
    });
    this.applyCodeFilter();
  },

  // 按状态分三个 tab：可用 / 已用完 / 停用（过期 + 作废）
  // 「可用」包含：还能兑换的码（含多次兑换、次数没用完的）
  applyCodeFilter() {
    const all = this.data.codes || [];
    const tab = this.data.codeTab || 'available';
    const kind = (x) => x.status === 'available' ? 'available'
      : (x.status === 'usedup' ? 'usedup' : 'stopped');
    this.setData({
      codesView: all.filter(x => kind(x) === tab),
      availCount: all.filter(x => kind(x) === 'available').length,
      usedUpCount: all.filter(x => kind(x) === 'usedup').length,
      stoppedCount: all.filter(x => kind(x) === 'stopped').length
    });
  },
  setCodeTab(e) {
    this.setData({ codeTab: e.currentTarget.dataset.t, _revokeId: '' });
    this.applyCodeFilter();
  },

  /* ---------- 生成兑换码（仅管理员） ---------- */
  async loadCodes() {
    const r = await call('flower', { action: 'listCodes', adminKey: this.data.adminKey }).catch(() => null);
    if (r && r.success) { this.setData({ codes: this.decorate(r.list || []) }); this.applyCodeFilter(); }
  },
  decorate(list) {
    return list.map(x => {
      const statusText = x.status === 'revoked' ? '已作废' :
        (x.status === 'expired' ? '已过期' : (x.status === 'usedup' ? '已用完' : '可用'));
      const isMember = x.type === 'member';
      const isBg = x.type === 'bg';
      return Object.assign({}, x, {
        typeName: isMember ? '会员' : (isBg ? '自定义背景' : '小红花'),
        valueText: isMember ? ((x.days || 0) > 0 ? ('延长会员 ' + x.days + ' 天') : ('延长会员 ' + (x.months || 1) + ' 个月'))
          : (isBg ? '解锁自定义背景' : (x.value || 0) + ' 朵小红花'),
        usesText: (x.usedCount || 0) + '/' + (x.maxUses || 1),
        statusText
      });
    });
  },
  openGen() {
    this.setData({
      showGen: true, genType: 'member', genUnit: 'day', genAmount: 7, genCount: 10,
      genMaxUses: 1, genExpiresDays: 0, genNote: '', genCustom: '', genList: []
    });
  },
  closeGen() { this.setData({ showGen: false }); },
  noop() {},
  setGenUnit(e) { this.setData({ genUnit: e.currentTarget.dataset.u }); },
  onGenAmount(e) { this.setData({ genAmount: e.detail.value }); },
  onGenCount(e) { this.setData({ genCount: e.detail.value }); },
  onGenMaxUses(e) { this.setData({ genMaxUses: e.detail.value }); },
  onGenExpiresDays(e) { this.setData({ genExpiresDays: e.detail.value }); },
  onGenNote(e) { this.setData({ genNote: e.detail.value }); },
  onGenCustom(e) { this.setData({ genCustom: e.detail.value }); },
  async doGen() {
    if (this.data.genBusy) return;
    const count = Math.max(1, Math.min(100, parseInt(this.data.genCount, 10) || 10));
    // 兑换码现在只用于延长会员：可按月或按天
    const type = 'member';
    const unit = this.data.genUnit === 'day' ? 'day' : 'month';
    const amount = Math.max(1, parseInt(this.data.genAmount, 10) || 1);
    const months = unit === 'month' ? amount : 0;
    const days = unit === 'day' ? amount : 0;
    const maxUses = Math.max(1, parseInt(this.data.genMaxUses, 10) || 1);
    const expiresDays = Math.max(0, parseInt(this.data.genExpiresDays, 10) || 0);
    this.setData({ genBusy: true });
    wx.showLoading({ title: '生成中' });
    let r;
    try {
      r = await call('flower', {
        action: 'genCodes', adminKey: this.data.adminKey,
        type, months, days, count, maxUses, expiresDays,
        customCodes: this.data.genCustom,
        note: String(this.data.genNote || '')
      });
    } catch (err) {
      wx.hideLoading(); this.setData({ genBusy: false });
      wx.showToast({ title: String(err), icon: 'none' }); return;
    }
    wx.hideLoading();
    this.setData({ genBusy: false });
    if (!r || !r.success) { wx.showToast({ title: (r && r.errMsg) || '生成失败', icon: 'none' }); return; }
    this.setData({ genList: r.codes || [] });
    this.loadCodes();
  },
  // 长按单个兑换码 → 直接复制这一条
  copyOne(e) {
    const code = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.code) || '';
    if (code) wx.setClipboardData({ data: code });
  },
  copyCodes() {
    const list = this.data.genList || [];
    if (!list.length) return;
    wx.setClipboardData({
      data: list.join('\n'),
      success: () => wx.showToast({ title: '已复制 ' + list.length + ' 个', icon: 'success' })
    });
  },

  /* ---------- 兑换码使用详情 ---------- */
  openCodeDetail(e) {
    const id = e.currentTarget.dataset.id;
    const code = (this.data.codes || []).find(c => c._id === id);
    if (!code) return;
    const uses = (code.uses || []).map(u => ({
      openid: u.openid ? u.openid.slice(0, 8) + '…' : '—',
      at: u.at ? this.fmtTime(u.at) : '—'
    }));
    this.setData({
      showCodeDetail: true,
      codeDetail: {
        show: code.show,
        valueText: code.valueText,
        usesText: code.usesText,
        statusText: code.statusText,
        expiresAt: code.expiresAt ? this.fmtTime(code.expiresAt) : '永久有效',
        note: code.note || '',
        uses
      }
    });
  },
  closeCodeDetail() { this.setData({ showCodeDetail: false }); },

  // 点行：若正展开「作废」，先收起；否则打开详情
  onCodeRowTap(e) {
    if (this.data._revokeId) { this.setData({ _revokeId: '' }); return; }
    this.openCodeDetail(e);
  },

  // ---------- 左滑「作废」 ----------
  revokeStart(e) {
    this._sx = e.touches[0].clientX;
    this._sy = e.touches[0].clientY;
  },
  revokeMove(e) {
    const t = e.touches[0] || {};
    const dx = (t.clientX || 0) - (this._sx || 0);
    const dy = (t.clientY || 0) - (this._sy || 0);
    if (Math.abs(dy) > Math.abs(dx)) return; // 纵向滚动优先，避免误开
  },
  revokeEnd(e) {
    const t = e.changedTouches[0] || {};
    const dx = (t.clientX || 0) - (this._sx || 0);
    const id = e.currentTarget.dataset.id || '';
    if (this.data._revokeId === id) {
      if (dx > -20) this.setData({ _revokeId: '' }); // 已展开：向右滑回收起
      return;
    }
    if (dx < -30) {
      this.setData({ _revokeId: id });
      try { wx.vibrateShort({ type: 'light' }); } catch (err) {}
    } else {
      this.setData({ _revokeId: '' });
    }
  },
  revokeCode(e) {
    const id = e.currentTarget.dataset.id;
    const show = e.currentTarget.dataset.show || '';
    if (!id) return;
    wx.showModal({
      title: '作废兑换码',
      content: (show ? show + ' ' : '') + '作废后将无法再被兑换，确定吗？',
      confirmText: '作废', confirmColor: '#d93b30',
      success: async (res) => {
        if (!res.confirm) { this.setData({ _revokeId: '' }); return; }
        wx.showLoading({ title: '作废中' });
        const r = await call('flower', { action: 'revokeCode', adminKey: this.data.adminKey, id }).catch(() => null);
        wx.hideLoading();
        this.setData({ _revokeId: '' });
        if (!r || !r.success) { wx.showToast({ title: (r && r.errMsg) || '作废失败', icon: 'none' }); return; }
        wx.showToast({ title: '已作废', icon: 'success' });
        this.loadCodes();
      }
    });
  },
  fmtTime(t) {
    const d = new Date(t);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  },
  fmtDate(t) {
    const d = new Date(t);
    if (isNaN(d.getTime())) return '—';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  },

  goLegal() { wx.navigateTo({ url: '/pages/legal/legal' }); },
  goProfile() { wx.navigateTo({ url: '/pages/profile/profile' }); },
  goBgSet() { wx.navigateTo({ url: '/pages/bg-set/bg-set' }); },
  goAbout() { wx.navigateTo({ url: '/pages/about/about' }); },
  goContact() { wx.navigateTo({ url: '/pages/contact/contact' }); },

  async onNotifySwitch(e) {
    const on = e.detail.value;
    if (on) {
      const accepted = await this.requestNotifyAuth();
      if (!accepted) {
        this.setData({ notifyOn: false });
        wx.showToast({ title: '未获得通知权限，已保持关闭', icon: 'none' });
        return;
      }
    }
    const r = await call('space', { action: 'setNotify', on }).catch(() => ({ err: true }));
    if (r.err) {
      this.setData({ notifyOn: !on });
      wx.showToast({ title: '设置失败，请重试', icon: 'none' });
      return;
    }
    const app = getApp();
    app.globalData.profile = Object.assign({}, app.globalData.profile || {}, { notifyOn: on });
    this.setData({ notifyOn: on });
    wx.showToast({ title: on ? '已开启，有人点菜会通知你' : '已关闭通知', icon: 'none' });
  },

  requestNotifyAuth() {
    return new Promise(resolve => {
      if (!ORDER_TEMPLATE_ID || ORDER_TEMPLATE_ID.indexOf('请替换') === 0) {
        wx.showModal({
          title: '通知模板还没配置',
          content: '需要先在微信公众平台申请「订阅消息」模板，把模板 ID 填到 config.js 的 ORDER_TEMPLATE_ID，才能弹微信通知。现在开启只在小程序内显示。',
          showCancel: false
        });
        resolve(true);
        return;
      }
      wx.requestSubscribeMessage({
        tmplIds: [ORDER_TEMPLATE_ID],
        success: res => resolve(res[ORDER_TEMPLATE_ID] === 'accept'),
        fail: () => resolve(false)
      });
    });
  },

  deleteMyData() {
    const self = this;
    wx.showModal({
      title: '删除我的数据',
      content: '将永久删除你的昵称、头像、自定义背景和小红花记录，并把你从所有空间中移除。此操作不可恢复。',
      confirmText: '确认删除',
      confirmColor: '#d9534a',
      success(res) {
        if (!res.confirm) return;
        wx.showModal({
          title: '再次确认',
          content: '真的要删除吗？删除后无法找回。',
          confirmText: '确定删',
          confirmColor: '#d9534a',
          success: async (r2) => {
            if (!r2.confirm) return;
            wx.showLoading({ title: '删除中' });
            const r = await call('space', { action: 'deleteMyData' }).catch(err => ({ err: String((err && err.message) || err) }));
            wx.hideLoading();
            if (r.err) { wx.showModal({ title: '删除失败', content: r.err, showCancel: false }); return; }
            wx.showModal({
              title: '已删除',
              content: '你的个人资料与小红花记录已清除。',
              showCancel: false,
              success() {
                const app = getApp();
                app.globalData.profile = {};
                app.globalData.spaces = [];
                app.globalData.currentSpace = null;
                wx.switchTab({ url: '/pages/home/home' });
              }
            });
          }
        });
      }
    });
  },

  async doInitDb() {
    const app = getApp();
    wx.showLoading({ title: '检查中' });
    const r = await app.initDb();
    wx.hideLoading();
    if (!r.ok) {
      wx.showModal({ title: '检查失败', content: r.msg, showCancel: false });
      return;
    }
    const created = r.created || [];
    await this.refresh();
    wx.showModal({
      title: '数据库已就绪',
      content: created.length
        ? ('本次新建了 ' + created.length + ' 个集合：' + created.join('、'))
        : '集合都已在云端存在，无需新建。',
      showCancel: false
    });
  },

  async doRetry() {
    const app = getApp();
    wx.showLoading({ title: '检测中' });
    const ok = await app.hardRetry();
    wx.hideLoading();
    wx.showToast({ title: ok ? '连接正常' : '仍未就绪', icon: 'none' });
    this.refresh();
  }
});
