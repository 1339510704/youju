const { call } = require('../../utils/cloud.js');
const bg = require('../../utils/bg.js');
const flower = require('../../utils/flower.js');
const { FEATURES, ABOUT, VIRTUAL_PAY, isVirtualPayConfigured } = require('../../config.js');

// 本次会话只做一次「补单」，避免每次进页面都查
let _reconciled = false;

// 把配置里的多档会员转成前端可渲染的列表
function buildProducts(VP) {
  const ps = (VP && VP.products) || {};
  return Object.keys(ps).map(id => {
    const p = ps[id];
    const suffix = p.permanent ? '永久'
      : (p.days ? (p.days + '天') : (p.months >= 12 ? (p.months / 12) + '年' : p.months + '月'));
    return { id, label: p.label, priceText: '¥' + (p.fen / 100) + '/' + suffix };
  });
}

Page({
  data: {
    openid: '', spaces: [], currentId: '', spaceCount: 0,
    me: null, meInitial: '', flowers: 0, bgStyle: '',
    showCreate: false, createType: 'family', createName: '',
    showJoin: false, joinCode: '', invited: false, inviteCode: '',
    showAbout: false,
    cloud: { ready: false, kind: '', msg: '' },
    diag: { sdk: false, fn: false, db: false },
    features: FEATURES,
    // 引流入口：config.js 里 ABOUT.bio 填了才显示，留空自动隐藏
    about: (ABOUT && ABOUT.bio) ? { bio: ABOUT.bio, wechat: ABOUT.wechat || '', qr: ABOUT.qr || '' } : null,
    // 会员使用期限
    memberExpired: true,
    daysLeft: 0,
    memberDate: '',
    products: buildProducts(VIRTUAL_PAY),
    selectedProduct: VIRTUAL_PAY.defaultProduct || 'vip_month',
    selectedPriceText: '',
    trialDays: VIRTUAL_PAY.trialDays || 30,
    payEnabled: false,
    showRedeem: false, redeemCode: '', redeeming: false,
    // 重命名空间弹层
    showRename: false, renameId: '', renameName: '',
    // 右滑退出：当前展开退出的空间 id
    _exitId: ''
  },

  // 点「关于我」卡片 → 弹层展示微信二维码（长按/点「复制」拿微信号）
  openAbout() { this.setData({ showAbout: true }); },
  closeAbout() { this.setData({ showAbout: false }); },

  // 从分享卡片进来：带 invite=邀请码，直接弹「加入」并预填
  onLoad(options) {
    wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage'] });
    const inv = options && options.invite;
    if (inv) {
      const code = String(inv).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      if (code) this.setData({ showJoin: true, joinCode: code, invited: true });
    }
  },

  onShow() { this.refresh(); this.reconcileDeliveries(); },

  // 分享卡片带邀请码；从某个空间卡上的「邀请」按钮点出去时，用那一个空间的码
  onShareAppMessage(res) {
    const ds = (res && res.target && res.target.dataset) || {};
    const code = ds.code || this.data.inviteCode || '';
    return {
      title: '来「黍离lite」和我一起管家：点菜、待办、攒小红花',
      path: '/pages/mine/mine?invite=' + code
    };
  },

  async refresh() {
    const app = getApp();
    // 冷启动先秒显上次缓存（遮罩立即消失），网络回来再静默覆盖
    this.applyCache();
    const ok = await app.ensureReady();
    const g = app.globalData;
    const me = g.profile || {};
    const cur = g.currentSpace;

    let flowers = 0;
    if (ok && cur) {
      const b = await call('flower', { action: 'balance', spaceId: cur._id }).catch(() => ({ flowers: 0 }));
      flowers = b.flowers || 0;
    }

    const bgStyle = await bg.styleOf(cur, me);
    this.setData({
      cloud: { ready: ok, kind: g.errorKind, msg: g.cloudError },
      diag: { sdk: !!g.cloudInited, fn: !!g.cloudReady, db: !!g.dbReady },
      openid: g.openid,
      spaces: g.spaces,
      currentId: cur ? cur._id : '',
      me,
      meInitial: (me.nickName || '我').slice(0, 1),
      flowers,
      spaceCount: (g.spaces || []).length,
      inviteCode: cur ? (cur.inviteCode || '') : '',
      bgStyle
    });
    getApp().globalData.lastBgStyle = bgStyle;
    getApp().globalData.lastFlowers = flowers;

    // 会员倒计时
    const memberUntil = me.memberUntil || 0;
    const now = Date.now();
    const expired = !memberUntil || memberUntil <= now;
    const daysLeft = expired ? 0 : Math.max(0, Math.ceil((memberUntil - now) / 86400000));
    // 买断（永久）会算成两万多天，这里单独标记，界面上显示「永久」而不是一个巨大数字
    const memberForever = !expired && memberUntil > Date.UTC(2090, 0, 1);
    // 到期前 3 天开始提醒（永久会员不提醒）
    const memberSoon = !expired && !memberForever && daysLeft <= 3;
    const cur2 = this.data.products.find(x => x.id === this.data.selectedProduct) || this.data.products[0];
    this.setData({
      memberExpired: expired,
      memberForever,
      memberSoon,
      daysLeft,
      memberDate: memberUntil ? this.fmtDate(memberUntil) : '',
      payEnabled: isVirtualPayConfigured(),
      selectedProduct: cur2 ? cur2.id : '',
      selectedPriceText: cur2 ? cur2.priceText : ''
    });
  },

  fmtDate(ms) {
    const d = new Date(ms);
    const pad = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  },

  // 冷启动先秒显上次缓存，避免"正在准备"全屏遮罩
  applyCache() {
    try {
      const c = getApp().readCache();
      if (!c) return;
      const cur = (c.spaces || []).find(s => s._id === c.currentSpaceId) || null;
      this.setData({
        cloud: { ready: true, kind: '', msg: '' },
        me: c.profile || null,
        spaces: c.spaces || [],
        currentId: c.currentSpaceId || '',
        bgStyle: c.bgStyle || '',
        flowers: c.flowers || 0,
        spaceCount: (c.spaces || []).length,
        inviteCode: cur ? (cur.inviteCode || '') : ''
      });
    } catch (e) {}
  },

  goProfile() { wx.navigateTo({ url: '/pages/profile/profile' }); },
  goVip() { wx.switchTab({ url: '/pages/vip/vip' }); },
  goRank() { wx.navigateTo({ url: '/pages/rank/rank' }); },
  goSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); },

  // 一键初始化数据库（幂等：已存在的集合会跳过，不会清空数据）
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
  },

  copyCode(e) {
    wx.setClipboardData({
      data: e.currentTarget.dataset.code,
      success: () => wx.showToast({ title: '邀请码已复制', icon: 'success' })
    });
  },

  // 引流：点一下复制我的微信号（站外纯展示，小程序内不收任何钱）
  copyWechat() {
    const id = (this.data.about && this.data.about.wechat) || '';
    if (!id) { wx.showToast({ title: '还没填微信号', icon: 'none' }); return; }
    wx.setClipboardData({
      data: id,
      success: () => wx.showToast({ title: '微信号已复制', icon: 'success' })
    });
  },

  openCreate(e) { this.setData({ showCreate: true, createType: e.currentTarget.dataset.t || 'family', createName: '' }); },
  closeCreate() { this.setData({ showCreate: false }); },
  noop() {},
  onName(e) { this.setData({ createName: e.detail.value }); },
  async doCreate() {
    const name = this.data.createName.trim();
    if (!name) { wx.showToast({ title: '请填写名称', icon: 'none' }); return; }
    wx.showLoading({ title: '创建中' });
    const me = this.data.me || {};
    const r = await call('space', {
      action: 'create', type: this.data.createType, name,
      nickName: me.nickName || '户主', avatarUrl: me.avatarUrl || ''
    }).catch(err => ({ err }));
    wx.hideLoading();
    if (r.err) { wx.showToast({ title: r.err, icon: 'none' }); return; }
    this.setData({ showCreate: false });
    const app = getApp();
    await app.refreshSpaces(r.spaceId);
    wx.showToast({ title: '已创建', icon: 'success' });
    this.refresh();
  },

  openJoin() { this.setData({ showJoin: true, joinCode: '', invited: false }); },
  closeJoin() { this.setData({ showJoin: false, invited: false }); },
  onCode(e) { this.setData({ joinCode: e.detail.value }); },
  async doJoin() {
    const code = this.data.joinCode.trim();
    if (!code) { wx.showToast({ title: '输入邀请码', icon: 'none' }); return; }
    wx.showLoading({ title: '加入中' });
    const me = this.data.me || {};
    const r = await call('space', {
      action: 'join', inviteCode: code,
      nickName: me.nickName || '成员', avatarUrl: me.avatarUrl || ''
    }).catch(err => ({ err }));
    wx.hideLoading();
    if (r.err) { wx.showToast({ title: r.err, icon: 'none' }); return; }
    this.setData({ showJoin: false, invited: false });
    const app = getApp();
    await app.refreshSpaces(r.spaceId);
    wx.showToast({ title: '已加入', icon: 'success' });
    this.refresh();
  },

  async enter(e) {
    const id = e.currentTarget.dataset.id;
    const app = getApp();
    const sp = app.globalData.spaces.find(s => s._id === id);
    app.setCurrentSpace(sp);
    this.setData({ currentId: id });
    wx.switchTab({ url: '/pages/home/home' });
  },

  goRankManage(e) {
    wx.navigateTo({ url: '/pages/rank/rank?spaceId=' + e.currentTarget.dataset.id });
  },

  // 左滑露出「退出」→ 确认后退出该空间
  onSpaceExit(e) {
    const { id, name } = e.currentTarget.dataset;
    if (!id) return;
    wx.showModal({
      title: '退出「' + (name || '该空间') + '」',
      content: '退出后你将不再看到该空间的数据。',
      confirmText: '退出',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ _exitId: '' });
        wx.showLoading({ title: '退出中' });
        const r = await call('space', { action: 'leave', spaceId: id }).catch(() => ({}));
        wx.hideLoading();
        // 服务端拒绝（如：户主需先转让、不在该空间等）要把原因告诉用户
        if (r && r.success === false) {
          wx.showModal({ title: '无法退出', content: r.errMsg || '请稍后再试', showCancel: false });
          return;
        }
        const app = getApp();
        await app.refreshSpaces();
        this.setData({ currentId: '' });
        this.refresh();
      }
    });
  },

  // ---------- 左滑手势：露出「退出」 ----------
  exitStart(e) {
    this._sx = e.touches[0].clientX;
    this._sy = e.touches[0].clientY;
  },
  exitMove(e) {
    const t = e.touches[0] || {};
    const dx = (t.clientX || 0) - (this._sx || 0);
    const dy = (t.clientY || 0) - (this._sy || 0);
    // 纵向滚动优先：上下滑动不触发，避免误开
    if (Math.abs(dy) > Math.abs(dx)) return;
    // 仅允许左滑露出「退出」；右滑不做处理
    if (dx < -6) this._exiting = true;
  },
  exitEnd(e) {
    const t = e.changedTouches[0] || {};
    const dx = (t.clientX || 0) - (this._sx || 0);
    const id = e.currentTarget.dataset.id || '';
    if (this._exitId === id) {
      // 已展开：向右滑回一点就收起
      if (dx > -20) this.setData({ _exitId: '' });
      return;
    }
    if (dx < -30) {
      this.setData({ _exitId: id });
      try { wx.vibrateShort({ type: 'light' }); } catch (err) {}
    } else {
      this.setData({ _exitId: '' });
    }
  },
  closeExit() {
    if (this._exitId) this.setData({ _exitId: '' });
  },

  // ---------- 重命名空间 ----------
  renameSpace(e) {
    const { id, name } = e.currentTarget.dataset;
    if (!id) return;
    this.setData({ showRename: true, renameId: id, renameName: name || '' });
  },
  closeRename() { this.setData({ showRename: false }); },
  onRenameInput(e) { this.setData({ renameName: e.detail.value }); },
  async doRename() {
    const name = (this.data.renameName || '').trim();
    if (!name) { wx.showToast({ title: '名称不能为空', icon: 'none' }); return; }
    if (!this.data.renameId) return;
    wx.showLoading({ title: '保存中' });
    const r = await call('space', { action: 'rename', spaceId: this.data.renameId, name }).catch(err => ({ err }));
    wx.hideLoading();
    if (r.err || (r && r.success === false)) {
      wx.showToast({ title: (r && r.errMsg) || String(r.err) || '改名失败', icon: 'none' });
      return;
    }
    this.setData({ showRename: false });
    const app = getApp();
    await app.refreshSpaces();
    wx.showToast({ title: '已改名', icon: 'success' });
    this.refresh();
  },

  // 激活兑换码（自带弹层）
  openRedeem() { this.setData({ showRedeem: true, redeemCode: '' }); },
  closeRedeem() { this.setData({ showRedeem: false }); },
  onRedeemCode(e) { this.setData({ redeemCode: e.detail.value }); },
  async doRedeem() {
    const code = String(this.data.redeemCode || '').trim();
    if (!code) { wx.showToast({ title: '请输入兑换码', icon: 'none' }); return; }
    if (this.data.redeeming) return;
    this.setData({ redeeming: true });
    wx.showLoading({ title: '兑换中' });
    let r;
    try {
      r = await call('flower', {
        action: 'redeem', code,
        spaceId: (getApp().globalData.currentSpace || {})._id || ''
      });
    } catch (err) {
      wx.hideLoading(); this.setData({ redeeming: false });
      wx.showToast({ title: String(err), icon: 'none' });
      return;
    }
    wx.hideLoading();
    this.setData({ redeeming: false });
    if (!r || !r.success) {
      wx.showToast({ title: (r && r.errMsg) || '兑换失败', icon: 'none' });
      return;
    }
    try { wx.vibrateShort({ type: 'light' }); } catch (e) {}
    this.setData({ showRedeem: false });
    let msg = '兑换成功！';
    if (r.type === 'flower') msg = '已到账 ' + (r.amount || 0) + ' 朵小红花。';
    else if (r.type === 'bg') msg = '已解锁自定义背景，去「我的资料」里换一张吧。';
    else if (r.type === 'member') msg = (r.unit === 'day')
      ? ('会员已延长 ' + (r.days || 0) + ' 天，去「我的」看倒计时。')
      : ('会员已延长 ' + (r.months || 1) + ' 个月，去「我的」看倒计时。');
    await getApp().loadProfile().catch(() => {});
    this.refresh(); // 立刻刷新会员天数（否则要切页面才更新）
    wx.showModal({ title: '兑换成功', content: msg, showCancel: false });
  },

  // 选档位
  selectProduct(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.products.find(x => x.id === id);
    if (item) this.setData({ selectedProduct: id, selectedPriceText: item.priceText });
  },

  // iOS 端需微信 ≥ 8.0.68 才支持虚拟支付
  checkIosVersion() {
    const sys = wx.getSystemInfoSync();
    if (sys.platform !== 'ios') return true;
    const cur = (sys.version || '').split('.').map(Number);
    const base = [8, 0, 68];
    for (let i = 0; i < 3; i++) {
      if ((cur[i] || 0) > base[i]) return true;
      if ((cur[i] || 0) < base[i]) break;
    }
    wx.showModal({ title: '提示', content: '请将微信更新至最新版后再进行支付', showCancel: false });
    return false;
  },

  // 微信虚拟支付：买会员（当前选中的档位）
  async buyMember() { return this.startPay(this.data.selectedProduct); },

  // 支付通用：按 productId 下单并拉起微信支付
  async startPay(productId) {
    if (!isVirtualPayConfigured()) {
      wx.showToast({ title: '支付尚未配置', icon: 'none' });
      return;
    }
    if (!this.checkIosVersion()) return;
    // 付款前明确告知：虚拟商品一经购买不支持退款（合规要求，也避免后续纠纷）
    const prod = (VIRTUAL_PAY.products && VIRTUAL_PAY.products[productId]) || null;
    const label = (prod && (prod.label || productId)) || '该商品';
    const confirmed = await new Promise(res => {
      wx.showModal({
        title: '确认购买',
        content: label + '：虚拟商品，购买后即时生效，不支持退款。确认购买吗？',
        confirmText: '确认购买', cancelText: '再想想',
        success: r => res(!!r.confirm),
        fail: () => res(false)
      });
    });
    if (!confirmed) return;
    wx.showLoading({ title: '准备支付' });
    let code = '';
    try { const lr = await wx.login(); code = lr.code; } catch (e) { wx.hideLoading(); return; }
    if (!code) { wx.hideLoading(); return; }

    let r;
    try {
      // 注意：call() 内部已把 res.result 剥出来返回，这里直接就是下单结果对象
      r = await call('pay', { action: 'order', code, productId });
    } catch (e) {
      wx.hideLoading();
      console.error('[buyMember] 支付下单失败：', e);
      wx.showModal({
        title: '下单失败',
        content: '下单接口调用失败：' + String((e && (e.errMsg || e.message)) || e) +
          '\n\n请确认 cloudfunctions/pay 已在开发者工具里【上传并部署：云端安装依赖】',
        showCancel: false
      });
      return;
    }
    if (!r || !r.success) {
      wx.hideLoading();
      wx.showModal({
        title: '下单被拒绝',
        content: (r && r.errMsg) || '支付失败（无返回信息）',
        showCancel: false
      });
      return;
    }
    wx.hideLoading();
    const payData = r.payData;
    const outTradeNo = (payData && payData.outTradeNo) || '';
    wx.requestVirtualPayment({
      ...payData,
      success: () => {
        wx.showToast({ title: '支付成功，权益到账中', icon: 'none' });
        // 主动查单补发货：即使微信的「发货推送」没配好或回调丢失，也能把会员加上
        this.claimDelivery(outTradeNo);
      },
      fail: (err) => {
        const msg = String((err && (err.errMsg || err.errCode)) || '未知');
        // 用户主动取消支付：不是错误，别吓人
        if (/cancel/i.test(msg)) {
          wx.showToast({ title: '已取消支付', icon: 'none' });
          return;
        }
        wx.showModal({
          title: '支付未完成',
          content: '原因：' + msg +
            '\n\n提示：微信虚拟支付需在真机上测试（扫码预览/体验版），电脑模拟器里点支付必然失败。',
          showCancel: false
        });
      }
    });
  },

  // 主动向 pay 云函数查单：查到已支付就补发会员（不依赖微信发货推送）
  async claimDelivery(outTradeNo) {
    if (outTradeNo) {
      try { await call('pay', { action: 'query', outTradeNo }); } catch (e) {}
    }
    this.pollMember();
  },

  // 支付成功回调可能丢失，这里多次刷新资料，等发货推送把会员延长
  pollMember() {
    const app = getApp();
    [2000, 5000, 10000].forEach(ms => {
      setTimeout(() => { app.loadProfile().then(() => this.refresh()).catch(() => {}); }, ms);
    });
  },

  // 进页面补一次单：把「已支付但没发货」的订单找回来（微信推送丢失时的兜底）
  async reconcileDeliveries() {
    if (_reconciled || !isVirtualPayConfigured()) return;
    _reconciled = true;
    try {
      const r = await call('pay', { action: 'reconcile' });
      if (r && r.delivered) this.refresh();
    } catch (e) {}
  },

  // 手动补单：把「已付款但没到账」的订单找回来，并把微信的查单结果直接显示出来
  async manualReconcile() {
    if (!isVirtualPayConfigured()) { wx.showToast({ title: '支付尚未配置', icon: 'none' }); return; }
    wx.showLoading({ title: '查单中' });
    let r = null, err = '';
    try { r = await call('pay', { action: 'reconcile' }); }
    catch (e) { err = String(e); }
    wx.hideLoading();
    if (err) {
      wx.showModal({
        title: '补单失败',
        content: err + '\n\n若是“未知操作”，说明 pay 云函数还没重新上传部署。',
        showCancel: false
      });
      return;
    }
    if (!r || !r.success) {
      wx.showModal({ title: '补单失败', content: (r && r.errMsg) || '未知错误', showCancel: false });
      return;
    }
    const ds = r.details || [];
    const paidOnes = ds.filter(d => d.paid);
    let msg = '检查 ' + (r.checked || 0) + ' 笔待支付订单，补发 ' + (r.delivered || 0) + ' 笔。';
    if (paidOnes.length) {
      msg += '\n\n已补发：\n' + paidOnes.slice(0, 8).map(d => d.no).join('\n');
    } else {
      msg += '\n\n没有「已付款但没到账」的订单。';
      const bad = ds.filter(d => d.errcode != null && d.errcode !== 0);
      if (bad.length) msg += '\n\n有 ' + bad.length + ' 笔查询异常，例如：' + bad[0].errcode + ' ' + (bad[0].errmsg || '');
    }
    await getApp().loadProfile().catch(() => {});
    this.refresh();
    wx.showModal({ title: '补单结果', content: msg, showCancel: false });
  }
});
