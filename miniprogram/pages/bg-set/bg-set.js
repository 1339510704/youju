const { call, pickImage, uploadImage, fileUrl } = require('../../utils/cloud.js');
const flower = require('../../utils/flower.js');
const bg = require('../../utils/bg.js');

const PLACES = bg.PLACES;

Page({
  data: {
    places: [],
    srcText: '',
    space: null,
    spaceBg: { url: '', valid: false, mode: '' },
    spaceBgText: '',
    presets: flower.BG_PRESETS,   // 纯色背景可选色
    bgColor: '',                  // 当前选中的纯色
    masterPct: 55   // 统一透明度（一键应用到全部位置）
  },

  onShow() {
    this.load();
    bg.apply(this);   // 本页用全局背景预览
  },

  async load() {
    const app = getApp();
    await app.ensureReady();
    const me = app.globalData.profile || {};
    const space = app.globalData.currentSpace || null;
    const bgPlaces = me.bgPlaces || {};
    const places = PLACES.map(k => {
      const c = bgPlaces[k] || {};
      return {
        key: k,
        name: bg.PLACE_NAMES[k],
        on: c.on !== false,
        alphaPct: Math.round((typeof c.alpha === 'number' ? c.alpha : bg.alphaOf(me)) * 100)
      };
    });
    const spaceBg = flower.spaceBgInfo(space, me);
    const b = me.bg || {};
    this.setData({
      places,
      space,
      spaceBg,
      spaceBgText: this.bgText(spaceBg),
      srcText: this.srcTextOf(me, spaceBg),
      bgColor: (b.type === 'color') ? (b.value || '') : '',
      masterPct: places.length ? places[0].alphaPct : 55
    });
  },

  srcTextOf(me, spaceBg) {
    if (spaceBg && spaceBg.valid) return '家庭背景图（全家人可见）';
    const b = me.bg || {};
    if (b.type === 'image') return '你上传的个人背景图';
    if (b.type === 'color') return '系统背景色';
    return '默认背景';
  },

  bgText(info) {
    if (info && info.mode === 'member') return '全家共用 · 传过就一直显示';
    return '传一张图，全家人都能看到';
  },

  // 背景自检：把「背景怎么来的」这条链逐环打出来，一眼看出断在哪
  async bgDiag() {
    const app = getApp();
    const space = (app.globalData && app.globalData.currentSpace) || {};
    const me = (app.globalData && app.globalData.profile) || {};
    const L = [];

    L.push('① 当前空间：' + (space.name || '（无）') + (space._id ? '' : ' ← 没进空间，背景必然空'));
    const raw = space.bgImage || '';
    L.push('② 家庭背景图：' + (raw ? (String(raw).slice(0, 34) + (raw.length > 34 ? '…' : '')) : '未设置'));
    if (raw && raw.indexOf('cloud://') !== 0) {
      L.push('   ⚠️ 存的不是 cloud:// 而是 http 链接，链接过期就会白屏');
    }
    L.push('③ 设置时间：' + (space.bgImageAt ? new Date(space.bgImageAt).toLocaleString() : '—'));
    const b = me.bg || {};
    L.push('④ 个人背景：' + (b.type ? (b.type + (b.value ? ' / ' + String(b.value).slice(0, 26) : '')) : '未设置'));
    L.push('⑤ 会员到期：' + (me.memberUntil ? new Date(me.memberUntil).toLocaleDateString() : '—'));

    let u = '';
    if (raw) { try { u = await fileUrl(raw); } catch (e) { u = ''; } }
    L.push('⑥ 换临时链接：' + (raw ? (u ? ('成功（' + u.length + ' 字符）') : '失败 ← content 云函数没更新到带 fileUrls 的版本，或云存储读不到') : '无需'));
    L.push('⑦ 本页背景样式：' + (this.data.bgStyle ? '有' : '空'));

    wx.showModal({
      title: '背景自检',
      content: L.join('\n'),
      showCancel: false,
      confirmText: '知道了'
    });
  },

  // 开关某位置：开/关后即时保存
  onToggle(e) {
    const key = e.currentTarget.dataset.k;
    const places = this.data.places.map(p => p.key === key ? Object.assign({}, p, { on: !p.on }) : p);
    this.setData({ places });
    this.save();
  },

  // 拖动只本地预览
  onAlphaPreview(e) {
    const key = e.currentTarget.dataset.k;
    const v = Number(e.detail.value) || 0;
    const places = this.data.places.map(p => p.key === key ? Object.assign({}, p, { alphaPct: v }) : p);
    this.setData({ places });
  },

  // 松手保存
  async onAlphaSave(e) {
    const key = e.currentTarget.dataset.k;
    const v = Number(e.detail.value) || 0;
    const places = this.data.places.map(p => p.key === key ? Object.assign({}, p, { alphaPct: v }) : p);
    this.setData({ places });
    await this.save();
  },

  // 一键：用当前这张图铺满全部位置（全部打开）
  applyAll() {
    const places = this.data.places.map(p => Object.assign({}, p, { on: true }));
    this.setData({ places });
    this.save();
  },

  // 统一透明度：拖动只本地预览
  onMasterAlphaPreview(e) {
    const v = Number(e.detail.value) || 0;
    const places = this.data.places.map(p => Object.assign({}, p, { alphaPct: v }));
    this.setData({ places, masterPct: v });
  },

  // 松手：四个位置一起保存
  async onMasterAlphaSave(e) {
    const v = Number(e.detail.value) || 0;
    const places = this.data.places.map(p => Object.assign({}, p, { alphaPct: v }));
    this.setData({ places, masterPct: v });
    await this.save();
  },

  async save() {
    const app = getApp();
    const me = app.globalData.profile || {};
    const bgPlaces = {};
    this.data.places.forEach(p => { bgPlaces[p.key] = { on: p.on, alpha: (p.alphaPct || 0) / 100 }; });
    app.globalData.profile = Object.assign({}, me, { bgPlaces });
    wx.showLoading({ title: '保存中' });
    try {
      await call('space', {
        action: 'updateProfile',
        bgPlaces,
        spaceId: (app.globalData.currentSpace || {})._id || ''
      });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: String(err), icon: 'none' });
      return;
    }
    wx.hideLoading();
    bg.invalidate();   // 清掉旧缓存，其他页面立刻按新配置渲染
    await app.loadProfile().catch(() => {});
  },

  // 选纯色背景（没有家庭背景图时，整页就显示这个颜色）
  async pickColor(e) {
    const v = e.currentTarget.dataset.v || '';
    const app = getApp();
    const me = app.globalData.profile || {};
    const nextBg = v ? { type: 'color', value: v } : { type: 'default', value: '' };
    app.globalData.profile = Object.assign({}, me, { bg: nextBg });
    this.setData({ bgColor: v });
    wx.showLoading({ title: '保存中' });
    try {
      await call('space', {
        action: 'updateProfile', bg: nextBg,
        spaceId: (app.globalData.currentSpace || {})._id || ''
      });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: String(err), icon: 'none' });
      return;
    }
    wx.hideLoading();
    bg.invalidate();   // 清掉旧缓存，其它页面立刻按新颜色渲染
    await app.loadProfile().catch(() => {});
    bg.apply(this);
  },

  // 家庭背景图上传（与「我的资料」同一套，全家可见）
  async chooseSpaceBg() {
    const app = getApp();
    const space = app.globalData.currentSpace;
    if (!space) { wx.showToast({ title: '还没有加入空间', icon: 'none' }); return; }
    let paths;
    try { paths = await pickImage(1); } catch (e) { return; }
    if (!paths.length) return;
    wx.showLoading({ title: '上传中' });
    try {
      const fileID = await uploadImage(paths[0], 'backgrounds');
      await call('space', { action: 'setBg', spaceId: space._id, bgImage: fileID, byName: app.globalData.nickName || '' });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '上传失败，请重试', icon: 'none' });
      return;
    }
    wx.hideLoading();
    await app.refreshSpaces(space._id);
    wx.showToast({ title: '已设置', icon: 'none' });
    this.applyAll();   // 选好图默认铺满全部位置，之后可逐个微调
    this.load();
  },

  async clearSpaceBg() {
    const app = getApp();
    const space = app.globalData.currentSpace;
    if (!space) return;
    const res = await new Promise(resolve => wx.showModal({
      title: '恢复默认背景', content: '把家里的背景图撤掉，全家人都会变回默认。',
      confirmText: '恢复', cancelText: '再想想', success: resolve
    }));
    if (!res.confirm) return;
    wx.showLoading({ title: '处理中' });
    await call('space', { action: 'setBg', spaceId: space._id, clear: true }).catch(() => {});
    wx.hideLoading();
    await app.refreshSpaces(space._id);
    this.load();
  }
});
