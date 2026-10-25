// ============================================================
// 全局配置 —— 整个项目只需要改下面这一个地方
// ============================================================

// 【必填】云开发环境 ID
// 怎么拿：微信开发者工具顶部点「云开发」-> 开通（选免费基础版）-> 左上角环境名下方就是环境 ID
// 形如：home-space-1g2h3i4j5k6l7m
const CLOUD_ENV = 'cloud1-8g11v2qv6b340bea';

// 【可选】订阅消息模板 ID（「待办提醒」到点要弹微信通知时用）
// 怎么拿：小程序管理后台 mp.weixin.qq.com -> 功能 -> 订阅消息 -> 我的模板 -> 模板 ID
// 不填也完全能用，只是提醒只显示在 App 内部的列表里，不会弹微信服务通知
//
// ⚠️ 这里刻意【复用点菜通知的同一个模板 ID】：
//    1. 微信订阅消息是「一次授权 = 一条」，共用一个模板，用户只需授权一次
//    2. 云函数 remind/index.js 里两种通知的 data 已统一为 thing1 / thing2 / time3
//    3. 若你后面单独申请了「提醒」专用模板，把它的 ID 填这里，
//       并同步改 remind/index.js 里 notifySpace 的字段名为 thing1 / time2 / thing3
const REMINDER_TEMPLATE_ID = 'N0wvYQF2KyvdiSKtPO8t6bsJzw5ls32oWRsqCXyzp_0';

// 【可选】订阅消息模板 ID（「有人点菜后通知家人」要用）
// 怎么拿：mp 后台 -> 功能 -> 订阅消息 -> 公共模板库 -> 搜索「订单」「待办」「任务」类模板 -> 选用
// 选用后复制「模板 ID」填在这里。不填则点菜不弹微信通知（App 内仍正常显示）。
// ⚠️ 前端也要用这个 ID 去申请用户授权，所以它同时被页面和云函数读取。
const ORDER_TEMPLATE_ID = 'N0wvYQF2KyvdiSKtPO8t6bsJzw5ls32oWRsqCXyzp_0';

// ============================================================
// 【功能开关】动手前先读完这段
// ------------------------------------------------------------
// ⚠️ 改这里 = 改代码包 = 上线必须重新提审。
//    所以「提审时关掉 → 过审后再打开」是死循环，不要再这么干：
//      1. 打开就要重新提审；
//      2. 重提审时该功能照样要过类目 / 资质这一关，一样会被拒；
//      3. 微信明令禁止「先过审再偷偷开启」规避审核，查到会警告甚至下架。
//    开关唯一合法的用法：体验版 / 开发版不走审核，可以开着内测；
//    线上发布版必须与该主体、该类目实际允许的范围一致。
// ============================================================
const FEATURES = {
  redeemCode: true    // 兑换码：延长会员时长 / 解锁背景。管理员在「设置」里生成（连点版本号 5 次进入）。
                      // 合规底线：钱一律站外收，小程序内绝不出现「购买 / 价格 / 付费 / ¥」等字样。
                      // 因此它本身不违规，保持 true 即可 —— 别为提审临时关，关了再开等于重新提审。
};

// ============================================================
// 【引流入口】「我的」页底部展示的一句简介 + 联系方式（站外，纯展示不收钱）
// ------------------------------------------------------------
// 想用这个小工具当"信任招牌"引流到你的主业时，把下面两行填好：
//   bio    ：一句话你是谁、能帮人做什么（熟人看了更信任你）
//   wechat ：你的微信号（点「复制」直接复制，方便熟人加你）
// 都留空则这一栏自动隐藏，不影响任何其他功能。
// ============================================================
const ABOUT = {
  bio: '我帮个人和小团队开发「专属个性化小程序」——点菜管家、会员卡、预约、小工具都能做。扫码加我，聊聊你的需求。',
  wechat: 'zkl12051007', // ← 你的微信号
  qr: '/images/contact/qr.png'   // 微信二维码图片（已放好）。想换图直接替换 images/contact/qr.png 这个文件
};

// ============================================================
// 【微信虚拟支付】个人主体 · 工具类目 · 延长小程序使用期限
// ------------------------------------------------------------
// 开通步骤（MP 后台）：支付与交易 → 虚拟支付 → 开通，拿到下面 4 个值。
// 并在「道具管理」里创建商品（道具 ID），单价填 520（分 = 5.2 元 / 月）。
// 把发货推送 URL 配到这个 pay 云函数的触发（开发者工具 Skills 可自动部署）。
// 注意：appSecret 属于敏感信息，仅用于服务端 code2Session 换取 session_key，
//       切勿提交到公开仓库；填好后把 enabled 改成 true。
// ============================================================
const VIRTUAL_PAY = {
  enabled: true,         // 已开启（服务端 appKey/appSecret 在 cloudfunctions/pay/config.js 填好了）
  appId: 'wxa355fe96a761e38a',  // 小程序 AppID（MP 后台 → 设置）
  offerId: '1450654640', // 虚拟支付商户号 OfferID（虚拟支付 → 基本配置）
  appKey: '',            // 前端不需要：appKey 只在服务端用，绝不打进前端包
  appSecret: '',         // 故意留空：AppSecret 只放 cloudfunctions/pay/config.js，绝不打进前端包
  trialDays: 30,         // 新用户免费试用天数
  // 多档会员：道具 ID 必须与 MP 后台「道具管理」里创建的一致（月/季/年/永久）
  // fen=单价(分)；months=延长月数（permanent 时忽略）；permanent=true 表示买断
  products: {
    vip_day:     { fen: 20,    days: 1,   label: '体验卡' },
    vip_month:   { fen: 520,   months: 1,  label: '月卡' },
    vip_quarter: { fen: 1520,  months: 3,  label: '季卡' },
    vip_year:    { fen: 5213,  months: 12, label: '年卡' },
    vip_forever: { fen: 52000, months: 0,  permanent: true, label: '永久' }
  },
  defaultProduct: 'vip_month'
};

// ------------------------------------------------------------
// 以下内容不用动
// ------------------------------------------------------------
function filled(v) {
  return typeof v === 'string' && v.trim() !== '' && v.indexOf('请替换') === -1;
}

module.exports = {
  CLOUD_ENV,
  REMINDER_TEMPLATE_ID,
  ORDER_TEMPLATE_ID,
  FEATURES,
  ABOUT,
  VIRTUAL_PAY,

  getProduct(id) {
    return (VIRTUAL_PAY.products && VIRTUAL_PAY.products[id]) || null;
  },

  // 前端只判「能不能拉起支付」。appSecret 只在服务端用，不进前端判断
  isVirtualPayConfigured() {
    return VIRTUAL_PAY.enabled &&
      filled(VIRTUAL_PAY.offerId) &&
      filled(VIRTUAL_PAY.appId) &&
      VIRTUAL_PAY.products && Object.keys(VIRTUAL_PAY.products).length > 0;
  },

  // 云环境 ID 是否已经填好
  isCloudConfigured() {
    return filled(CLOUD_ENV);
  },

  // 订阅消息模板是否已经填好
  isReminderConfigured() {
    return filled(REMINDER_TEMPLATE_ID);
  },

  // 点菜通知模板是否已经填好
  isOrderNotifyConfigured() {
    return filled(ORDER_TEMPLATE_ID);
  }
};
