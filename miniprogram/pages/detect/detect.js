const { call } = require('../../utils/cloud.js');
const bg = require('../../utils/bg.js');
const member = require('../../utils/member.js');

const POLL_MS = 2500;
// 云端拿不到类型时的兜底（和 detect/quiz.js 里的保持一致）
const FALLBACK_CATS = [
  { key: 'science', name: '科学' }, { key: 'history', name: '历史' },
  { key: 'geo', name: '地理' }, { key: 'animal', name: '动物' },
  { key: 'health', name: '健康' }, { key: 'life', name: '生活' }
];

// 云端房间 → 渲染用（选项高亮、判定文案、结果文案都在这里算，wxml 不写复杂表达式）
function decorate(room) {
  if (!room) return null;
  const revealed = room.phase === 'revealed' || room.status === 'done';
  const q = room.question || {};
  const mine = (room.myPick === null || room.myPick === undefined) ? null : room.myPick;
  const players = room.players || [];
  const me = players.find((p) => p.isMe) || {};
  const rival = players.find((p) => !p.isMe) || null;

  // 两个按钮的样式：on=我选的，right=正确答案，wrong=我选错的
  let c0 = '', c1 = '';
  if (mine === 0) c0 = 'on';
  if (mine === 1) c1 = 'on';
  if (revealed && q.answer === true) c0 = 'right';
  if (revealed && q.answer === false) c1 = 'right';
  if (revealed && mine === 0 && q.answer === false) c0 = 'wrong';
  if (revealed && mine === 1 && q.answer === true) c1 = 'wrong';

  const answered = mine !== null && mine !== undefined;
  const ok = revealed && answered && ((mine === 0) === !!q.answer);

  let verdictOk = false, verdictText = '', verdictSub = '';
  if (revealed) {
    verdictOk = ok;
    verdictText = q.answer ? '真的' : '假的';
    if (!answered) verdictSub = '这题你没选';
    else if (ok) verdictSub = '答对了 ✓';
    else verdictSub = '你选的是「' + (mine === 0 ? '真的' : '假的') + '」';
    if (room.mode === 'duo' && rival) {
      const rp = rival.pick;
      verdictSub += '；' + (rival.name || '对方') + (rp == null ? '没选' : ('选「' + (rp === 0 ? '真的' : '假的') + '」'));
    }
  }

  const myScore = me.score || 0;
  const rivalScore = rival ? (rival.score || 0) : 0;

  let resultTitle = '';
  let resultSub = '';
  if (room.status === 'done') {
    if (room.mode === 'solo') {
      resultTitle = '答对 ' + myScore + ' / ' + room.rounds;
      resultSub = room.winnerFlowers
        ? ('全对！+' + room.winnerFlowers + ' 朵小红花已到账')
        : (myScore === room.rounds
          ? '全对，但今天的得花次数用完了，明天再来拿'
          : '再看看每道题的证据，下次更准');
    } else if (room.isTie) {
      resultTitle = '平局';
      resultSub = '两边都答对 ' + myScore + ' 题，这局谁也没拿到小红花。';
    } else if (room.winner === me.openid) {
      resultTitle = '你赢了' + (room.winnerFlowers ? (' +' + room.winnerFlowers + ' 朵') : '');
      resultSub = '比分 ' + myScore + ' : ' + rivalScore
        + (room.winnerFlowers ? '，小红花已到账。' : '（今天拿花有点多，明天再来～）');
    } else {
      resultTitle = (room.winnerNames && room.winnerNames[0] ? room.winnerNames[0] : '对方') + ' 赢了';
      resultSub = '比分 ' + myScore + ' : ' + rivalScore + '，下次赢回来。';
    }
  }

  return Object.assign({}, room, {
    myScore, rivalScore,
    playerText: players.map((p) => (p.name || '家人') + (p.isMe ? '（我）' : '')).join(' vs ') || '还没有人',
    choiceCls0: c0, choiceCls1: c1,
    verdictOk, verdictText, verdictSub,
    resultTitle, resultSub
  });
}

Page({
  data: {
    bgStyle: '',
    tab: 'ask',

    // 提问
    q: '', asking: false, askResult: null, askErr: '',

    // 答题
    spaceId: '',
    categories: FALLBACK_CATS,
    catKey: 'science',
    topic: '',
    mode: 'solo',
    rounds: 5,
    roundOptions: [3, 5, 8],
    creating: false,
    joinCode: '',
    rooms: [],
    room: null,

    // 房间内
    myScore: 0, choiceCls0: '', choiceCls1: '',
    verdictOk: false, verdictText: '', verdictSub: '',
    resultTitle: '', resultSub: ''
  },

  onLoad() {
    const sp = getApp().globalData.currentSpace;
    this.setData({ spaceId: (sp && sp._id) || '' });
    bg.apply(this);
    this.loadCategories();
  },

  onShow() {
    if (!this.data.spaceId) {
      const sp = getApp().globalData.currentSpace;
      if (sp && sp._id) this.setData({ spaceId: sp._id });
    }
    // 首屏 onLoad 时资料可能还没回来，这里再算一次背景（和别的页面一致）
    bg.apply(this);
    if (this.data.room) this.startPoll();
    else if (this.data.tab === 'battle') this.loadRooms();
  },

  onHide() { this.stopPoll(); },
  onUnload() { this.stopPoll(); },

  async loadCategories() {
    const r = await call('detect', { action: 'categories' }).catch(() => null);
    if (r && r.success && (r.categories || []).length) this.setData({ categories: r.categories });
  },

  setTab(e) {
    const t = e.currentTarget.dataset.t;
    this.setData({ tab: t });
    if (t === 'battle') this.loadRooms();
    else this.stopPoll();
  },

  /* ================= 提问 ================= */
  onQ(e) { this.setData({ q: e.detail.value }); },

  async doAsk() {
    const q = (this.data.q || '').trim();
    if (!q) { wx.showToast({ title: '先写个问题', icon: 'none' }); return; }
    if (this.data.asking) return;
    this.setData({ asking: true, askErr: '', askResult: null });
    let r = null, err = '';
    try { r = await call('detect', { action: 'ask', q }); }
    catch (e) { err = (e && (e.errMsg || e.message)) || String(e); }
    this.setData({ asking: false });
    if (err || !r || !r.success) {
      this.setData({ askErr: (r && r.errMsg) || err || '提问失败，稍后再试' });
      return;
    }
    this.setData({ askResult: r });
  },

  copyUrl(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({
      data: url,
      success: () => wx.showToast({ title: '链接已复制，粘到浏览器打开', icon: 'none', duration: 2200 })
    });
  },

  /* ================= 开一场 ================= */
  pickCat(e) { this.setData({ catKey: e.currentTarget.dataset.key }); },
  onTopic(e) { this.setData({ topic: e.detail.value }); },
  setMode(e) { this.setData({ mode: e.currentTarget.dataset.m }); },
  setRounds(e) { this.setData({ rounds: Number(e.currentTarget.dataset.n) || 5 }); },

  async createRoom() {
    if (!this.data.spaceId) { wx.showToast({ title: '先加入一个家庭', icon: 'none' }); return; }
    if (member.guard('侦探社答题')) return;
    if (this.data.creating) return;
    this.setData({ creating: true });
    wx.showLoading({ title: '正在搜题', mask: true });
    let r = null, err = '';
    try {
      r = await call('detect', {
        action: 'createRoom', spaceId: this.data.spaceId,
        mode: this.data.mode, category: this.data.catKey,
        topic: (this.data.topic || '').trim(), rounds: this.data.rounds
      });
    } catch (e) { err = String(e); }
    wx.hideLoading();
    this.setData({ creating: false });
    if (err || !r || !r.success) {
      wx.showModal({
        title: '没开起来',
        content: (r && r.errMsg) || err || '出题失败',
        showCancel: false
      });
      return;
    }
    this.applyRoom(r.room);
    this.startPoll();
  },

  /* ================= 加入 / 最近 ================= */
  onJoinCode(e) { this.setData({ joinCode: e.detail.value }); },

  async joinRoom() {
    const code = String(this.data.joinCode || '').replace(/\D/g, '');
    if (code.length !== 4) { wx.showToast({ title: '输入 4 位房间号', icon: 'none' }); return; }
    if (!this.data.spaceId) { wx.showToast({ title: '先加入一个家庭', icon: 'none' }); return; }
    wx.showLoading({ title: '进入中' });
    let r = null, err = '';
    try {
      r = await call('detect', { action: 'joinRoom', spaceId: this.data.spaceId, code });
    } catch (e) { err = String(e); }
    wx.hideLoading();
    if (err || !r || !r.success) {
      wx.showToast({ title: (r && r.errMsg) || err || '加入失败', icon: 'none', duration: 2500 });
      return;
    }
    this.setData({ joinCode: '' });
    this.applyRoom(r.room);
    this.startPoll();
    this.loadRooms();
  },

  async enterRoom(e) {
    const id = e.currentTarget.dataset.id;
    wx.showLoading({ title: '进入中' });
    const r = await call('detect', { action: 'room', spaceId: this.data.spaceId, roomId: id }).catch(() => null);
    wx.hideLoading();
    if (!r || !r.success) { wx.showToast({ title: (r && r.errMsg) || '进不去这局', icon: 'none' }); return; }
    this.applyRoom(r.room);
    this.startPoll();
  },

  async loadRooms() {
    if (!this.data.spaceId) return;
    const r = await call('detect', { action: 'rooms', spaceId: this.data.spaceId }).catch(() => null);
    if (!r || !r.success) return;
    const list = (r.list || []).map((x) => Object.assign({}, x, {
      statusText: x.status === 'done' ? '已结束' : (x.status === 'playing' ? '进行中' : '等人来'),
      modeText: x.mode === 'solo' ? '一个人练' : '两人对战',
      playerText: (x.playerNames || []).join(' vs ') || '还没人'
    }));
    this.setData({ rooms: list });
  },

  /* ================= 答题 ================= */
  async answer(e) {
    const room = this.data.room;
    if (!room) return;
    if (room.phase === 'revealed' || room.status !== 'playing') return;
    if (room.myPick !== null && room.myPick !== undefined) return;
    const choice = Number(e.currentTarget.dataset.i);

    // 先本地点亮，避免点了没反应
    this.setData({
      'room.myPick': choice,
      choiceCls0: choice === 0 ? 'on' : '',
      choiceCls1: choice === 1 ? 'on' : ''
    });

    const r = await call('detect', {
      action: 'pick', spaceId: this.data.spaceId, roomId: room._id, choice
    }).catch(() => null);
    if (r && r.success) this.applyRoom(r.room);
    else if (r && r.errMsg) wx.showToast({ title: r.errMsg, icon: 'none' });
  },

  async nextQuestion() {
    const room = this.data.room;
    if (!room) return;
    wx.showLoading({ title: '加载中' });
    const r = await call('detect', { action: 'next', spaceId: this.data.spaceId, roomId: room._id }).catch(() => null);
    wx.hideLoading();
    if (!r || !r.success) { wx.showToast({ title: (r && r.errMsg) || '操作失败', icon: 'none' }); return; }
    this.applyRoom(r.room);
    if (r.done) {
      this.stopPoll();
      if (r.gained) getApp().globalData.flowerDirty = true;
    }
  },

  applyRoom(raw) {
    const room = decorate(raw);
    if (!room) return;
    this.setData({
      room,
      myScore: room.myScore || 0,
      choiceCls0: room.choiceCls0, choiceCls1: room.choiceCls1,
      verdictOk: room.verdictOk, verdictText: room.verdictText, verdictSub: room.verdictSub,
      resultTitle: room.resultTitle, resultSub: room.resultSub
    });
    if (room.status === 'done') this.stopPoll();
  },

  /* ================= 轮询 ================= */
  startPoll() {
    this.stopPoll();
    if (!this.data.room) return;
    // 单人模式没有"等对方"，不用轮询，省云调用
    if (this.data.room.mode === 'solo') return;
    this._timer = setInterval(async () => {
      const room = this.data.room;
      if (!room) { this.stopPoll(); return; }
      if (room.status === 'done') { this.stopPoll(); return; }
      const r = await call('detect', {
        action: 'room', spaceId: this.data.spaceId, roomId: room._id
      }).catch(() => null);
      if (!r || !r.success) return;
      this.applyRoom(r.room);
    }, POLL_MS);
  },

  stopPoll() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  /* ================= 退出 / 再来 ================= */
  async exitRoom() {
    const room = this.data.room;
    this.stopPoll();
    this.setData({ room: null, myScore: 0, choiceCls0: '', choiceCls1: '', resultTitle: '', resultSub: '' });
    if (room) {
      await call('detect', { action: 'closeRoom', spaceId: this.data.spaceId, roomId: room._id }).catch(() => {});
    }
    this.loadRooms();
  },

  again() {
    this.setData({ room: null });
    this.createRoom();
  }
});
