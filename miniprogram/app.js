const config = require('./config.js');
const bg = require('./utils/bg.js');

// 「数据库集合是否已建好」只在首次装上/版本升级时校验一次，之后记在本地，避免每次冷启动都打云函数。
// 以后新增集合：把 COLLECTIONS_VER 加 1（老用户下次启动会自动补建）。
const INIT_DONE_KEY = 'hsmp_collections_ver';
const COLLECTIONS_VER = 'v1';

App({
  globalData: {
    openid: '',
    nickName: '',        // 我的昵称（来自微信授权 / 手动填写）
    profile: null,       // 我的全局资料 { nickName, avatarUrl, bg, bgUnlock }
    spaces: [],          // 我所在的全部空间（家庭 + 班级）
    currentSpace: null,  // 当前选中的空间 { _id, type, name, role, flowers, ... }

    // —— 云开发状态（页面用它决定显示正常界面还是"待配置"引导）——
    cloudInited: false,  // wx.cloud.init 是否成功执行过
    cloudReady: false,   // 云函数是否调得通
    dbReady: false,      // 数据库集合是否已建好
    cloudError: '',      // 不可用时的原因（人话，直接展示给用户）
    errorKind: '',       // 出错环节：config / sdk / fn / db / other
    hideAmount: false,   // 是否在首页 / 记账页隐藏金额（隐私开关，持久化到 storage）
    lastBgStyle: '',     // 上次算好的背景 CSS（冷启动先秒显，后台再刷新）
    lastFlowers: 0       // 上次的小红花余额（缓存用）
  },

  onLaunch() {
    // 隐私开关：是否隐藏金额（本地持久化，与云无关，不依赖云开发是否已配置）
    try { this.globalData.hideAmount = !!wx.getStorageSync('hsmp_hide_amount'); } catch (e) {}
    // 启动时只初始化 SDK，不发网络请求，避免首屏卡顿
    if (config.isCloudConfigured() && wx.cloud) {
      try {
        wx.cloud.init({ env: config.CLOUD_ENV, traceUser: true });
        this.globalData.cloudInited = true;
        // 启动后悄悄预热云开发探活：用户进首页/点菜时大概率已就绪，
        // 避免一进页面就卡在「加载中」（这是之前反应慢的主因之一）
        this.ensureReady().catch(() => {});
        // 背景图用的是云存储临时链接，有有效期；每 40 分钟清一次缓存并刷新当前页背景，
        // 避免"用着用着背景全没了"且一直不恢复。
        this._bgTimer = setInterval(() => bg.refreshCurrent().catch(() => {}), 40 * 60 * 1000);
      } catch (e) {
        this.globalData.errorKind = 'sdk';
        this.globalData.cloudError = '云开发初始化失败：' + this.errText(e);
      }
    }
  },

  // ---------- 错误信息翻译成人话 ----------
  errText(e) {
    if (!e) return '未知错误';
    return e.errMsg || e.message || String(e);
  },

  humanize(msg) {
    const m = msg || '';
    if (/FUNCTION_NOT_FOUND|-501000/i.test(m)) {
      return '云函数还没部署。请在开发者工具左侧找到 cloudfunctions 文件夹，展开后分别右键 space、content、ai、remind、init、flower、pay 这 7 个文件夹，选择「上传并部署：云端安装依赖」。';
    }
    if (this.looksLikeDbMissing(m)) {
      return '数据库集合还没建好。';
    }
    if (/Invalid env|env.*(invalid|not.*exist)|-601002|环境不存在/i.test(m)) {
      return '云开发环境 ID 不对。请核对 config.js 里的 CLOUD_ENV，是否和开发者工具「云开发」面板顶部显示的环境 ID 完全一致。';
    }
    if (/cloud.*not.*init|未初始化|cloud is not defined/i.test(m)) {
      return '云开发没能初始化，请检查 config.js 里的环境 ID。';
    }
    if (/timeout|超时/i.test(m)) {
      return '网络超时，请检查网络后重试。';
    }
    return m;
  },

  // 判断错误是不是"数据库集合不存在"（该建表了）
  // 云开发里这个错误码是 -502005；各家 SDK 的文案不一样，所以关键词 + 错误码一起兜
  looksLikeDbMissing(msg) {
    const m = msg || '';
    // 先排除"云函数不存在"，否则 "function not exist" 会被误判成该建表
    if (/FUNCTION_NOT_FOUND|-501000|function.*not.*exist/i.test(m)) return false;
    return /-502005|collection|Db or Table|not\s*exist|不存在|表不存在/i.test(m);
  },

  // ---------- 云端探活 ----------
  // space/list 能通，说明云函数已部署 + 数据库集合已建好
  async probeSpaceList() {
    try {
      const res = await wx.cloud.callFunction({ name: 'space', data: { action: 'list' } });
      const r = (res && res.result) || {};
      if (r.success) return { ok: true, openid: r.openid, spaces: r.spaces || [] };
      // 服务端可能只回了 errCode，也可能只回 errMsg，两个都拿来判
      const msg = [r.errMsg, r.errCode ? String(r.errCode) : ''].filter(Boolean).join(' | ');
      if (this.looksLikeDbMissing(msg)) return { ok: false, kind: 'db', msg };
      if (/FUNCTION_NOT_FOUND|-501000/i.test(msg)) return { ok: false, kind: 'fn', msg };
      return { ok: false, kind: 'other', msg: msg || '云函数执行失败' };
    } catch (e) {
      const msg = this.errText(e);
      if (this.looksLikeDbMissing(msg)) return { ok: false, kind: 'db', msg };
      if (/FUNCTION_NOT_FOUND|-501000/i.test(msg)) return { ok: false, kind: 'fn', msg };
      return { ok: false, kind: 'other', msg };
    }
  },

  // 带 10 秒超时的探活：云函数万一卡死（容器异常/网络抖动）也不会让所有页面无限转圈，
  // 超时后返回 kind:'timeout'，ensureReady 会把它当失败处理并展示「重试」引导。
  probeSpaceListT() {
    return Promise.race([
      this.probeSpaceList(),
      new Promise(res => setTimeout(() => res({ ok: false, kind: 'timeout', msg: '连接云函数超时（10 秒），请检查网络后点「重试」' }), 10000))
    ]);
  },

  // ---------- 加载我的全局资料（头像 / 昵称 / 背景 / 会员）----------
  async loadProfile() {
    try {
      const res = await wx.cloud.callFunction({ name: 'space', data: { action: 'me' } });
      const r = (res && res.result) || {};
      if (r.success) {
        this.globalData.profile = r.user || null;
        this.globalData.nickName = (r.user && r.user.nickName) || '';
      }
    } catch (e) {
      // 资料读不到不影响主流程（可能 users 集合还没建）
    }
    // 资料（含背景设置）可能变了 → 清掉背景样式缓存，让页面下次打开重新算
    bg.invalidate();
  },

  // 把上次成功拿到的最小快照存本地：下次冷启动先秒显、后台静默刷新（解决"每次都加载中"）
  saveCache() {
    const g = this.globalData;
    if ((!g.profile) && !(g.spaces && g.spaces.length)) return;
    try {
      wx.setStorageSync('hsmp_cache', {
        savedAt: Date.now(),
        profile: g.profile || null,
        spaces: (g.spaces || []).map(s => ({
          _id: s._id, type: s.type, name: s.name, inviteCode: s.inviteCode || '',
          role: s.role || 'member', flowers: s.flowers || 0,
          bgImage: s.bgImage || '', bgImageAt: s.bgImageAt || 0,
          bgImageBy: s.bgImageBy || '', bgUntil: s.bgUntil || 0
        })),
        currentSpaceId: g.currentSpace ? g.currentSpace._id : '',
        bgStyle: g.lastBgStyle || '',
        flowers: g.lastFlowers || 0
      });
    } catch (e) {}
  },

  // 冷启动时页面先读这份缓存秒显内容（不挡屏幕），网络回来再覆盖
  readCache() {
    try { return wx.getStorageSync('hsmp_cache') || null; } catch (e) { return null; }
  },

  // ---------- 确保数据库集合齐全（每个 App 生命周期只跑一次）----------
  // 项目后续新增了 users / flowerLogs / dishes / codes 等集合，
  // 老环境里可能只有最初那 9 个。init 是幂等的，启动时补一次，缺什么建什么。
  async ensureCollections() {
    if (this._collectionsChecked) return;
    this._collectionsChecked = true;
    // 集合只在「新装 / 版本升级」时可能缺。以前每次冷启动都打一次 init 云函数，
    // 那是实打实的一次云端冷启动延迟（首次打开慢的主因之一）。
    // 改成：同一版本只跑一次并记在本地；以后新增集合把 COLLECTIONS_VER 加 1 即可重新补建。
    try {
      if (wx.getStorageSync(INIT_DONE_KEY) === COLLECTIONS_VER) return;
    } catch (e) { /* 读不到就照常跑一次 */ }
    try {
      const r = await this.initDb();
      if (r.ok) {
        try { wx.setStorageSync(INIT_DONE_KEY, COLLECTIONS_VER); } catch (e) {}
        if (r.created && r.created.length) {
          console.log('[init] 本次新建集合：' + r.created.join('、'));
        }
      }
    } catch (e) {
      // 失败也不阻塞使用，用户仍可在「我的 → 系统状态」手动初始化
    }
  },

  // ---------- 新建全部数据库集合 ----------
  async initDb() {
    try {
      const res = await wx.cloud.callFunction({ name: 'init', data: {} });
      const r = (res && res.result) || {};
      if (r.success) return { ok: true, created: r.created || [] };
      return { ok: false, msg: r.errMsg || '初始化失败' };
    } catch (e) {
      return { ok: false, msg: this.humanize(this.errText(e)) };
    }
  },

  // ---------- 统一的"能不能用"检查，页面 await 这一个就够 ----------
  // 关键优化：
  //  1) 成功过一次就把结果缓存，再次调用直接秒回（Promise.resolve(true)），
  //     不再每次进页面都重新探活 —— 这是「点菜 / 返回首页都一直转圈」的根因。
  //  2) 用 _probing 复用同一次探活 Promise，避免并发重复打云函数。
  //  3) 配置/版本等确定性错误同步返回，不进探活流程。
  ensureReady() {
    const g = this.globalData;
    if (!config.isCloudConfigured()) {
      g.cloudReady = false; g.dbReady = false; g.errorKind = 'config';
      g.cloudError = '还没有填写云开发环境 ID。请打开项目根目录的 config.js，把 CLOUD_ENV 那一行换成你自己的云开发环境 ID。';
      return Promise.resolve(false);
    }
    if (!wx.cloud) {
      g.cloudReady = false; g.errorKind = 'sdk';
      g.cloudError = '当前微信版本过低，无法加载云服务。请升级到最新版微信后重新打开。';
      return Promise.resolve(false);
    }
    // 已经就绪过（且已选中空间）：直接秒回
    if (g.cloudReady && g.currentSpace) return Promise.resolve(true);
    // 正在探活中：复用同一个 Promise，别并发重复拉
    if (this._probing) return this._probing;
    this._probing = this._doEnsureReady();
    this._probing.then(() => { this._probing = null; }, () => { this._probing = null; });
    return this._probing;
  },

  async _doEnsureReady() {
    const g = this.globalData;

    // SDK 初始化（首次或重试时）
    if (!g.cloudInited) {
      try {
        wx.cloud.init({ env: config.CLOUD_ENV, traceUser: true });
        g.cloudInited = true;
        g.cloudError = '';
      } catch (e) {
        g.cloudReady = false; g.errorKind = 'sdk';
        g.cloudError = '云开发初始化失败：' + this.errText(e);
        return false;
      }
    }

    // 探活（带超时兜底，卡死也不会无限转圈）
    const p = await this.probeSpaceListT();
    if (p.ok) {
      g.cloudReady = true; g.dbReady = true; g.cloudError = ''; g.errorKind = '';
      this.applySpaces(p.openid, p.spaces);
      // 建集合 与 拉资料 互不依赖 → 并行，少一个云往返（首次打开能快一截）
      await Promise.all([this.ensureCollections(), this.loadProfile()]);
      this.saveCache();
      return true;
    }

    // 云函数通了、但集合没建 -> 自动创建，用户零操作
    if (p.kind === 'db') {
      g.cloudReady = true; g.errorKind = 'db';
      const r = await this.initDb();
      if (r.ok) {
        const p2 = await this.probeSpaceListT();
        if (p2.ok) {
          g.dbReady = true; g.cloudError = ''; g.errorKind = '';
          this.applySpaces(p2.openid, p2.spaces);
          await this.ensureCollections();
          await this.loadProfile();
          return true;
        }
      }
      g.dbReady = false; g.errorKind = 'db';
      g.cloudError = '数据库集合还没建好，自动创建也没成功：' + (r.msg || '未知原因') +
        '。请确认 init 云函数也已经上传部署，然后点「重新检测」。';
      return false;
    }

    // 其他失败
    g.cloudReady = false; g.dbReady = false; g.errorKind = p.kind;
    g.cloudError = this.humanize(p.msg);
    return false;
  },

  applySpaces(openid, spaces) {
    const g = this.globalData;
    if (openid) g.openid = openid;
    g.spaces = spaces || [];
    let cur = null;
    if (g.currentSpace) cur = g.spaces.find(s => s._id === g.currentSpace._id);
    if (!cur) cur = g.spaces[0] || null;
    g.currentSpace = cur;
  },

  // ---------- 重新拉取空间列表 ----------
  async refreshSpaces(preferId) {
    if (!this.globalData.cloudReady) return [];
    const p = await this.probeSpaceList();
    if (!p.ok) return [];
    this.applySpaces(p.openid, p.spaces);
    // 家庭背景图可能随空间切换变化 → 清缓存
    bg.invalidate();
    if (preferId) {
      const hit = this.globalData.spaces.find(s => s._id === preferId);
      if (hit) this.globalData.currentSpace = hit;
    }
    return this.globalData.spaces;
  },

  // ---------- 强制重来一次（配合「重新检测」按钮）----------
  async hardRetry() {
    const g = this.globalData;
    g.cloudInited = false;
    g.cloudReady = false;
    g.dbReady = false;
    g.cloudError = '';
    g.errorKind = '';
    return await this.ensureReady();
  },

  setCurrentSpace(space) {
    this.globalData.currentSpace = space;
  }
});
