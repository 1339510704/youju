const { call } = require('../../utils/cloud.js');
const bg = require('../../utils/bg.js');
const date = require('../../utils/date.js');
const lunar = require('../../utils/lunar.js');
const flower = require('../../utils/flower.js');
const member = require('../../utils/member.js');
const swipe = require('../../utils/swipe.js');

// 提醒时间的紧凑显示：09-21 01:57（同年省略年份），供首页待办行使用
function fmtRemind(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  const p = n => (n < 10 ? '0' + n : '' + n);
  const now = new Date();
  return (d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '-') +
    p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  behaviors: [swipe],
  data: {
    space: null,          // 当前空间
    spaces: [],           // 我所在的全部空间（顶部胶囊切换）
    setup: null,          // 非 null 时显示「待配置」引导
    todos: [],            // 「今天」卡：最多 3 条未完成待办
    todoLeft: 0,          // 未完成总数
    grid: [],             // 功能列表（带实时状态摘要）
    greeting: '',         // 按时段问候（早上好/下午好…）
    dateText: '',         // 今天日期（9月15日 周二）
    myFlowers: 0,         // 我在当前空间的小红花
    myBadge: null,        // 我的等级（小红花/大红花/红心/心连心/小屋）
    signedToday: false,   // 今天是否已签到（本地记忆，服务端还会再判一次）
    _signing: false,      // 签到请求进行中，防连点
    bgStyle: '',          // 自定义背景
    me: null,             // 我的全局资料
    _ready: false,        // 是否已完成首次加载（用来区分"加载中"和"真的没数据"）
    swipeRight: true,     // 首页待办卡支持右滑「完成」
    _swipeId: '', _swipeRightId: ''

  },
  onLoad() {
    // 允许右上角「…」转发：家人点开分享卡片就落到「加入」弹层
    // 注：不开启「分享到朋友圈」——该能力需认证小程序，个人主体未认证会弹系统提示
    wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage'] });
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 });
    }
    const ms = member.status();
    this.setData({ memberExpired: ms.expired, daysLeft: ms.daysLeft });
    const app = getApp();
    // 冷启动先秒显上次缓存（不挡屏幕），网络回来 prepare 会静默覆盖
    this.applyCache();
    // 背景：每次 onShow 都补一次（有内存缓存，几乎零成本）。
    // 关键修复：家页背景之前只在首次 prepare 里调，_ready 后从子页返回会跳过，
    // 一旦首次 prepare 时 profile 还没就绪，家页背景就永远为空、再也不补。
    bg.apply(this, 'home');
    // 已经加载过、且当前选中的空间没变：直接跳过。否则每次从子页面返回首页都会
    // 重新探活 + 并发 8 个云函数 + 整页重渲染，弱网下会明显卡一下。
    if (this.data._ready && app.globalData.cloudReady && this.data.space &&
        app.globalData.currentSpace && app.globalData.currentSpace._id === this.data.space._id) {
      // 子页面改过数据（新建/完成/删除待办等）时，返回首页轻量刷新当前空间；
      // 平时不刷新，保留弱网下少并发一次云函数的性能优化
      if (app.globalData.homeDirty) {
        app.globalData.homeDirty = false;
        this.load(this.data.space);
      }
      return;
    }
    this.prepare();
  },

  // 冷启动先秒显上次缓存，避免"加载中"全屏遮罩；网络回来 prepare 会静默覆盖
  applyCache() {
    try {
      const c = getApp().readCache();
      if (!c || !c.spaces || !c.spaces.length) return;
      const space = c.spaces.find(s => s._id === c.currentSpaceId) || c.spaces[0];
      this.setData({
        spaces: c.spaces,
        space,
        me: c.profile || null,
        bgStyle: c.bgStyle || '',
        setup: null,
        _ready: true
      });
    } catch (e) {}
  },

  // 分享出去的卡片带着当前家庭的邀请码
  inviteQuery() {
    const sp = this.data.space || {};
    return sp.inviteCode || '';
  },
onShareAppMessage() {
    return {
      title: '来「黍离lite」和我一起管家：点菜、待办、攒小红花',
      path: '/pages/mine/mine?invite=' + this.inviteQuery()
    };
  },
  onShareTimeline() {
    return {
      title: '来「黍离lite」和我一起管家里的事儿',
      query: 'invite=' + this.inviteQuery()
    };
  },


  // 时段问候 + 今天日期（顶部暖心一句）
  warmHello() {
    const d = new Date();
    const h = d.getHours();
    const greeting = h < 5 ? '夜深了' : h < 11 ? '早上好' : h < 13 ? '中午好' : h < 18 ? '下午好' : '晚上好';
    const wk = '日一二三四五六'[d.getDay()];
    return { greeting, dateText: (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + wk };
  },

  // 背景：优先用「家庭背景图」（未过期），没有才回落个人背景色
  // 返回 Promise —— 图片背景需要先把 cloud:// 换成 https 才能被 CSS 加载
  pickBgStyle(app, me) {
    return flower.pickBgStyle(app.globalData.currentSpace, me);
  },

  async prepare() {
    try {
      const app = getApp();
      const ok = await app.ensureReady();
      const me = app.globalData.profile || {};
      const hello = this.warmHello();
      // profile 此时已就绪，用最新会员期限重算一次（首屏 onShow 时可能还没加载到）
      const ms = member.status();
      this.setData(Object.assign({ me }, hello, { memberExpired: ms.expired, daysLeft: ms.daysLeft }));
      // 背景统一走 utils/bg.js：家庭背景图优先 → 个人背景色，并带上用户设的透明度
      bg.apply(this, 'home');

      if (!ok) {
        this.setData({
          setup: {
            title: '还差最后一步配置',
            msg: app.globalData.cloudError,
            canInit: app.globalData.errorKind === 'db' || app.globalData.errorKind === 'other',
            canRetry: app.globalData.errorKind !== 'config'
          },
          space: null, spaces: [], grid: [], todos: [], todoLeft: 0, myFlowers: 0, myBadge: null,
          _ready: true
        });
        return;
      }

      this.setData({ setup: null });

      // 提审精简版：班级空间整体隐藏（UGC 超出「工具」类目）
      const all = app.globalData.spaces || [];
      // 班级空间已下线：老数据里若还有 class 类型，一律不显示
      const spaces = all.filter(s => s.type !== 'class');
      let space = app.globalData.currentSpace;
      if (space && space.type === 'class') space = null;

      if (!space) {
        this.setData({ space: null, spaces, grid: [], todos: [], todoLeft: 0, myFlowers: 0, myBadge: null, _ready: true });
        return;
      }
      // ⚠️ 正常有空间分支必须置 _ready:true，否则 wxml 的「加载中」判断永不翻转
      this.setData({ space, spaces, _ready: true });
      this.load(space);
    } catch (e) {
      // 兜底：任何未捕获错误都至少让页面显示出来，不能白屏
      console.error('[home] prepare error:', e);
      this.setData({ _ready: true, setup: { title: '加载出错', msg: (e && e.message) || '未知错误', canRetry: true, canInit: false } });
    }
  },

  // 一次并行拉齐各模块数据，用来算功能行的状态摘要
  // 一次往返拿齐首页数据：云函数内部并行查 6 个集合，
  // 比前端并发 6 次云调用少 5 次网络往返，弱网下是"秒进"的关键
  async load(space) {
    const sum = await call('content', { action: 'homeSummary', spaceId: space._id }).catch(() => null);
    if (!sum || !sum.success) return this.loadLegacy(space);

    // 待办优先用全局缓存（待办页刚改过），秒出、不受云库最终一致延迟影响
    const app = getApp();
    let tAll = sum.todos || [];
    if (app.globalData.todoListSpace === space._id && app.globalData.todoList) tAll = app.globalData.todoList;
    const left = tAll.filter(t => !t.done);
    left.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));

    const fin = sum.finance || [];
    const income = fin.filter(f => f.type === 'income').reduce((s, f) => s + (+f.amount || 0), 0);
    const expense = fin.filter(f => f.type === 'expense').reduce((s, f) => s + (+f.amount || 0), 0);
    const balance = Math.round((income - expense) * 100) / 100;

    const oAll = sum.orders || [];
    const fest = sum.festivals || [];
    const stat = {
      todoLeft: left.length,
      balance,
      orderCount: oAll.length,
      orderLeft: oAll.filter(o => o.status !== 'done').length,
      orderTakeable: oAll.filter(o => o.status === 'pending').length,
      dishCount: (sum.dishes || []).length,
      festivalCount: fest.length,
      // 农历节日没有公历 date，先换算成「下一个公历日期」再算倒计时
      nextFestival: date.nextFestival(fest.map(f => {
        if (f.isLunar && f.lMonth) {
          try { return Object.assign({}, f, { date: lunar.lunarNextSolar(f.lMonth, f.lDay, !!f.lLeap).dateStr }); } catch (e) { return f; }
        }
        return f;
      }))
    };

    const t0 = date.today();
    // 首页待办改为「可上下滑动查看」，所以全部未完成的都带上（上限 80 条，防极端数据）
    const shown = left.slice(0, 80).map(t => Object.assign({}, t, {
      dueText: date.friendlyDue(t.dueDate),
      overdue: t.dueDate && t.dueDate < t0,
      // 首页这行也要有「时间」信息：有截止日期显示截止，没设截止但设了提醒就显示提醒时间
      timeText: [date.friendlyDue(t.dueDate), t.notifyAt ? ('提醒 ' + fmtRemind(t.notifyAt)) : '']
        .filter(Boolean).join(' · ')
    }));

    this.setData({
      todos: shown,
      todoLeft: left.length,
      myFlowers: sum.flowers || 0,
      myBadge: flower.badgeOf(sum.earnedTotal || 0),
      grid: this.buildGrid(space, stat)
    });
    getApp().globalData.lastFlowers = sum.flowers || 0;
  },

  // 兜底：content 云函数还没部署 homeSummary 时，退回原来的并发拉取
  async loadLegacy(space) {
    const spaceId = space._id;
    const empty = { list: [] };
    const jobs = [
      call('content', { action: 'list', coll: 'todos', spaceId }).catch(() => empty),
      call('content', { action: 'list', coll: 'festivals', spaceId }).catch(() => empty),
      call('content', { action: 'list', coll: 'finance', spaceId }).catch(() => empty),
      call('content', { action: 'list', coll: 'orders', spaceId }).catch(() => empty),
      call('content', { action: 'list', coll: 'dishes', spaceId }).catch(() => empty),
      call('flower', { action: 'balance', spaceId }).catch(() => ({ flowers: 0 }))
    ];
    const _pa = await Promise.all(jobs);
    const todos = _pa[0], festivals = _pa[1], finance = _pa[2], orders = _pa[3], dishes = _pa[4], bal = _pa[5];

    // 待办优先用全局缓存（与 load 一致），兜底页面也秒出
    const _app = getApp();
    let tAll = todos.list || [];
    if (_app.globalData.todoListSpace === space._id && _app.globalData.todoList) tAll = _app.globalData.todoList;
    const left = tAll.filter(t => !t.done);
    left.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));

    const fin = finance.list || [];
    const income = fin.filter(f => f.type === 'income').reduce((s, f) => s + (+f.amount || 0), 0);
    const expense = fin.filter(f => f.type === 'expense').reduce((s, f) => s + (+f.amount || 0), 0);
    const balance = Math.round((income - expense) * 100) / 100;

    const oAll = orders.list || [];
    const stat = {
      todoLeft: left.length,
      balance,
      orderCount: oAll.length,
      orderLeft: oAll.filter(o => o.status !== 'done').length,
      orderTakeable: oAll.filter(o => o.status === 'pending').length,
      dishCount: (dishes.list || []).length,
      festivalCount: (festivals.list || []).length,
      nextFestival: date.nextFestival((festivals.list || []).map(f => {
        if (f.isLunar && f.lMonth) {
          try { return Object.assign({}, f, { date: lunar.lunarNextSolar(f.lMonth, f.lDay, !!f.lLeap).dateStr }); } catch (e) { return f; }
        }
        return f;
      }))
    };

    const t0 = date.today();
    const shown = left.slice(0, 80).map(t => Object.assign({}, t, {
      dueText: date.friendlyDue(t.dueDate),
      overdue: t.dueDate && t.dueDate < t0,
      // 首页这行也要有「时间」信息：有截止日期显示截止，没设截止但设了提醒就显示提醒时间
      timeText: [date.friendlyDue(t.dueDate), t.notifyAt ? ('提醒 ' + fmtRemind(t.notifyAt)) : '']
        .filter(Boolean).join(' · ')
    }));

    this.setData({
      todos: shown,
      todoLeft: left.length,
      myFlowers: bal.flowers || 0,
      myBadge: bal.badge || null,
      grid: this.buildGrid(space, stat)
    });
    getApp().globalData.lastFlowers = bal.flowers || 0;
  },

  // tone = 图标底色分类（coral/gold/sky/sage/lilac），交错排列避免一片同色
  // 每个入口带一句暖心副标题；数字状态收进图标右上角的小红点（参考家庭风设计）
  buildGrid(space, s) {
    const hideAmount = getApp().globalData.hideAmount;
    const common = [
      { key: 'todo', icon: 'todo', name: '待办提醒', page: '/pages/todo/todo', tone: 'sky',
        sub: '有条不紊', dot: s.todoLeft || null },
      { key: 'festival', icon: 'festival', name: '重要节日', page: '/pages/festival/festival', tone: 'coral',
        sub: '记录特别日子', dot: s.nextFestival ? s.nextFestival.days : null }
    ];

    if (space.type === 'family') {
      return [
        { key: 'menu', icon: 'menu_dock', name: '家庭菜单', page: '/pages/menu/menu', tone: 'gold',
          sub: '营养又健康', dot: s.dishCount || null },
        { key: 'todo', icon: 'todo_dock', name: '待办提醒', page: '/pages/todo/todo', tone: 'sky',
          sub: '有条不紊', dot: s.todoLeft || null },
        { key: 'finance', icon: 'finance_dock', name: '记账理财', page: '/pages/finance/finance', tone: 'sage',
          sub: hideAmount ? '***' : (s.balance != null ? ('¥' + s.balance) : '家庭小金库') },
        { key: 'festival', icon: 'festival_dock', name: '重要节日', page: '/pages/festival/festival', tone: 'coral',
          sub: '记录特别日子', dot: s.nextFestival ? s.nextFestival.days : null },
        // 侦探社：直接提问（元宝搜索给答案+证据）/ 两人开一场答题
        { key: 'detect', icon: 'ai', name: '侦探社', page: '/pages/detect/detect', tone: 'lilac',
          sub: '问一句，找证据' }
      ];
    }
    return common;
  },

  // 顶部胶囊：一次点击直接切空间，不用弹层
  selectSpace(e) {
    const id = e.currentTarget.dataset.id;
    const app = getApp();
    const sp = (app.globalData.spaces || []).find(s => s._id === id);
    if (!sp) return;
    if (this.data.space && sp._id === this.data.space._id) return;
    app.setCurrentSpace(sp);
    const me = app.globalData.profile || {};
    this.setData({ space: sp, todos: [], todoLeft: 0, grid: [], myFlowers: 0, myBadge: null });
    bg.apply(this);
    this.load(sp);
  },

  // 「今天」卡里直接勾选完成，0 跳转
  async toggleTodo(e) {
    if (member.guard('完成待办')) return;
    const id = e.currentTarget.dataset.id;
    const todos = this.data.todos.filter(t => t._id !== id);
    const n = Math.max(0, this.data.todoLeft - 1);
    const grid = this.data.grid.map(g => g.key === 'todo'
      ? Object.assign({}, g, { dot: n || null })
      : g);
    this.setData({ todos, todoLeft: n, grid });
    // 同步全局缓存：去待办详情页时状态一致，不依赖回翻
    const app = getApp();
    if (app.globalData.todoList) app.globalData.todoList = app.globalData.todoList.filter(t => t._id !== id);
    const r = await call('content', { action: 'toggle', coll: 'todos', _id: id, field: 'done' }).catch(() => ({}));
    if (r && r.earned) { flower.toastEarn(r.earned); getApp().globalData.flowerDirty = true; }
  },

  // 点待办文字 → 去待办详情页打开这条（不再误当完成）
  openTodoDetail(e) {
    const id = e.currentTarget.dataset.id;
    this.closeSwipe();
    wx.navigateTo({ url: '/pages/todo/todo?id=' + id });
  },

  // 首页待办左滑删除（确认后删除，乐观更新）
  async removeTodo(e) {
    if (member.guard('删除待办')) return;
    const id = e.currentTarget.dataset.id;
    const item = (this.data.todos || []).find(t => t._id === id);
    const res = await new Promise(resolve => wx.showModal({
      title: '删除任务？', content: '删除后不可恢复。',
      confirmText: '删除', confirmColor: '#d93b30', cancelText: '取消', success: resolve
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
    const todos = this.data.todos.filter(t => t._id !== id);
    const n = Math.max(0, this.data.todoLeft - 1);
    const grid = this.data.grid.map(g => g.key === 'todo'
      ? Object.assign({}, g, { dot: n || null })
      : g);
    this.setData({ todos, todoLeft: n, grid, _swipeId: '', _swipeRightId: '' });
    const app = getApp();
    if (app.globalData.todoList) app.globalData.todoList = app.globalData.todoList.filter(t => t._id !== id);
    app.globalData.homeDirty = true;
  },

  // 点顶部「家」签到：每个账号每天一次 +2 朵。
  // 不给任何提示/弹窗/文案，签到成功只体现为右上角花朵数自己变多。
  async onSignIn() {
    if (member.guard('签到')) return;
    if (this.data._signing || this.data.signedToday || !this.data.space) return;
    this.setData({ _signing: true });
    try {
      const r = await call('flower', { action: 'checkin', spaceId: this.data.space._id });
      if (r && r.success) {
        this.setData({
          signedToday: true,
          myFlowers: (r.flowers != null ? r.flowers : this.data.myFlowers)
        });
        flower.toastEarn(r.earned || r.delta);
      }
    } catch (e) {}
    this.setData({ _signing: false });
  },

  async doInitDb() {
    const app = getApp();
    wx.showLoading({ title: '创建中' });
    const r = await app.initDb();
    wx.hideLoading();
    if (r.ok) {
      wx.showToast({ title: '数据库就绪', icon: 'success' });
      this.prepare();
    } else {
      wx.showModal({ title: '创建失败', content: r.msg, showCancel: false });
    }
  },

  async doRetry() {
    const app = getApp();
    wx.showLoading({ title: '检测中' });
    const ok = await app.hardRetry();
    wx.hideLoading();
    wx.showToast({ title: ok ? '连接正常' : '仍未就绪', icon: 'none' });
    this.prepare();
  },

  goManage() { wx.navigateTo({ url: '/pages/mine/mine' }); },
  goTodo() { wx.navigateTo({ url: '/pages/todo/todo' }); },
  goRank() { wx.navigateTo({ url: '/pages/rank/rank' }); },
  // 「我的」入口：右上角头像（宫格里已去掉重复的「我的」卡）
  goMine() { wx.navigateTo({ url: '/pages/mine/mine' }); },
  goProfile() { wx.navigateTo({ url: '/pages/profile/profile' }); },
  goPage(e) { wx.navigateTo({ url: e.currentTarget.dataset.page }); }
});
