// ============================================================
// pay 云函数 —— 微信虚拟支付（个人主体 · 工具类目）
//
// 只做「道具直购」：用户买 1 个月会员（道具 priceFen 分）。
//   order  ：前端下单，服务端生成 outTradeNo + 两套签名，返回 payData
//   notify ：平台发货推送（xpay_goods_deliver_notify），验重后延长会员
//   query  ：兜底查单（推送丢失时前端主动查，查到已支付就补发货）
//
// 接入前请确认 config.js 的 VIRTUAL_PAY 已填好，并把 MP 后台的
// 「发货推送 URL」配到本函数的触发（开发者工具 Skills 可自动部署）。
// ============================================================
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const https = require('https');
const crypto = require('crypto');
const config = require('./config.js');
const VP = config.VIRTUAL_PAY || {};

const usersCol = db.collection('users');
const ordersCol = db.collection('payOrders');

// ---------------- 工具 ----------------
function hmacSha256(key, msg) {
  return crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');
}

function httpsPost(url, bodyObj, headers) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const u = new URL(url);
    const buf = Buffer.from(body);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': buf.length
      }, headers || {})
    }, res => {
      let s = '';
      res.on('data', c => { s += c; });
      res.on('end', () => resolve(s));
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET'
    }, res => {
      let s = '';
      res.on('data', c => { s += c; });
      res.on('end', () => resolve(s));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------- 小程序 access_token（查单等虚拟支付接口必须带）----------------
// 微信规定 xpay 的查询类接口除了 pay_sig，还必须在 URL 上带 access_token，
// 缺了就会返回 41001 access_token missing。
let _tk = { token: '', expireAt: 0 };
async function getAccessToken() {
  if (_tk.token && Date.now() < _tk.expireAt) return _tk.token;
  const url = 'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' +
    VP.appId + '&secret=' + VP.appSecret;
  const resp = await httpsGet(url).catch(() => '');
  let j = {};
  try { j = JSON.parse(resp); } catch (e) {}
  if (j && j.access_token) {
    _tk = { token: j.access_token, expireAt: Date.now() + ((j.expires_in || 7200) - 300) * 1000 };
    return j.access_token;
  }
  console.warn('[pay] 获取 access_token 失败：', resp);
  return '';
}

// 查一笔订单（现金单）：返回 { ok, paid, wxOrderId, status, errcode, errmsg }
// 订单状态：2=已支付待发货 3=发货中 4=已发货 → 都算“已支付，该发货了”
async function queryOrder(openid, outTradeNo) {
  const token = await getAccessToken();
  if (!token) return { ok: false, paid: false, errcode: -1, errmsg: 'access_token 获取失败（检查 appId/appSecret）' };
  const postBody = { openid, env: 0, order_id: outTradeNo };
  const postStr = JSON.stringify(postBody);
  // 注意：服务端接口参与签名的 uri 必须带开头的斜杠（官方示例为 /wxa/game/xxx）
  const paySig = hmacSha256(VP.appKey, '/xpay/query_order&' + postStr);
  const url = 'https://api.weixin.qq.com/xpay/query_order?access_token=' + token + '&pay_sig=' + paySig;
  const resp = await httpsPost(url, postBody).catch((e) => 'ERR:' + String(e));
  let info = {};
  try { info = JSON.parse(resp); } catch (e) { info = { errmsg: String(resp).slice(0, 160) }; }
  const o = info && info.order;
  const paid = !!(o && o.status >= 2 && o.status <= 4);
  return {
    ok: !!(info && info.errcode === 0),
    paid,
    wxOrderId: (o && o.wx_order_id) || '',
    status: o && o.status,
    errcode: info && info.errcode,
    errmsg: (info && info.errmsg) || ''
  };
}

// 买断有效期（永久会员）
const PERMANENT_UNTIL = Date.UTC(2099, 11, 31);

// 延长会员：从当前剩余时间往后叠加（不会缩短已有效期限）；permanent 直接给到 2099
// months 按月（每月 30 天计）、days 按天；两者都为 0 时兜底给 1 个月
async function extendMemberUntil(openid, months, days, permanent) {
  let mm = Math.max(0, Math.round(Number(months) || 0));
  const dd = Math.max(0, Math.round(Number(days) || 0));
  if (!permanent && !mm && !dd) mm = 1; // 兜底：老订单没写月/天时按 1 个月算
  const r = await usersCol.doc(openid).get().catch(() => null);
  const u = r && r.data ? r.data : null;
  const base = (u && u.memberUntil && u.memberUntil > Date.now()) ? u.memberUntil : Date.now();
  const until = permanent ? PERMANENT_UNTIL : base + mm * 30 * 86400000 + dd * 86400000;
  const exists = !!u;
  if (exists) {
    await usersCol.doc(openid).update({ data: { memberUntil: until, updatedAt: db.serverDate() } });
  } else {
    await usersCol.add({
      data: {
        _id: openid, openid, nickName: '', avatarUrl: '',
        bg: { type: 'default', value: '' }, bgUnlock: false,
        memberUntil: until, createdAt: db.serverDate(), updatedAt: db.serverDate()
      }
    });
  }
  return until;
}

// 发货（幂等：以平台单号 wxOrderId 去重）
async function deliver(openid, opts, outTradeNo, wxOrderId, source) {
  const months = (opts && opts.months) || 0;
  const days = (opts && opts.days) || 0;
  const permanent = !!(opts && opts.permanent);

  // 幂等保护：先按微信单号、再按业务单号找这笔订单；只要已发过货就直接返回，绝不重复加会员。
  // （微信推送 + 查单补发可能先后都来，这里两个单号任一命中都能拦住。）
  let existing = null;
  if (wxOrderId) {
    const a = await ordersCol.where({ wxOrderId }).limit(1).get().catch(() => ({ data: [] }));
    existing = (a.data && a.data[0]) || null;
  }
  if (!existing && outTradeNo) {
    const b = await ordersCol.where({ outTradeNo }).limit(1).get().catch(() => ({ data: [] }));
    existing = (b.data && b.data[0]) || null;
  }
  if (existing && existing.status === 'delivered') {
    return { delivered: true, already: true, until: existing.memberUntil };
  }

  const until = await extendMemberUntil(openid, months, days, permanent);
  console.log('[pay.deliver] 发货 openid=' + openid + ' months=' + months + ' days=' + days + ' permanent=' + permanent + ' until=' + until);
  const patch = { status: 'delivered', openid, months, days, permanent, deliveredAt: db.serverDate(), memberUntil: until };
  if (wxOrderId) patch.wxOrderId = wxOrderId;
  if (outTradeNo) patch.outTradeNo = outTradeNo;
  if (existing) {
    await ordersCol.doc(existing._id).update({ data: patch });
  } else {
    await ordersCol.add({ data: Object.assign({ createdAt: db.serverDate() }, patch) });
  }
  return { delivered: true, until, source };
}

// 从 XML 里 tolerant 提取字段
function pickXml(xml, tag) {
  const m = xml && xml.match(new RegExp('<' + tag + '>(.*?)</' + tag + '>', 's'));
  return m ? m[1].trim() : '';
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;
  try {
    // ---------------- 下单 ----------------
    if (action === 'order') {
      if (!config.isVirtualPayConfigured()) {
        return { success: false, errMsg: '虚拟支付尚未配置（config.js → VIRTUAL_PAY）' };
      }
      const productId = String(event.productId || VP.defaultProduct || '');
      const prod = config.getProduct ? config.getProduct(productId) : (VP.products && VP.products[productId]);
      if (!prod) return { success: false, errMsg: '未知商品' };
      const code = String(event.code || '').trim();
      if (!code) return { success: false, errMsg: '缺少登录 code' };

      // ① 用登录 code 换 session_key（用于用户态签名）
      const csUrl = 'https://api.weixin.qq.com/sns/jscode2session?appid=' +
        VP.appId + '&secret=' + VP.appSecret + '&js_code=' + code + '&grant_type=authorization_code';
      const csRes = await httpsGet(csUrl);
      let sessionKey = '';
      try { sessionKey = (JSON.parse(csRes).session_key) || ''; } catch (e) {}
      if (!sessionKey) return { success: false, errMsg: '登录态获取失败，请重试' };

      // ② 组装支付参数（与后台道具价格一致）
      const outTradeNo = 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const signDataObj = {
        offerId: VP.offerId,
        buyQuantity: 1,
        env: 0,
        currencyType: 'CNY',
        productId: productId,
        goodsPrice: prod.fen,             // 单价（分），与后台道具一致
        outTradeNo,
        attach: OPENID
      };
      const signData = JSON.stringify(signDataObj);

      // ③ 两套签名
      const paySig = hmacSha256(VP.appKey, 'requestVirtualPayment&' + signData);
      const signature = hmacSha256(sessionKey, signData);

      // ④ 落库（待支付），推失去重以 outTradeNo 为准
      await ordersCol.add({
        data: {
          outTradeNo, openid: OPENID, productId,
          months: prod.months || 0, days: prod.days || 0, permanent: !!prod.permanent,
          status: 'pending', createdAt: db.serverDate()
        }
      }).catch(() => {});

      // ⑤ 返回给前端拉起支付
      return {
        success: true,
        payData: Object.assign({}, signDataObj, {
          mode: 'short_series_goods',
          signData,
          paySig,
          signature
        })
      };
    }

    // ---------------- 发货推送（平台 POST） ----------------
    if (action === 'notify') {
      const xml = (typeof event === 'string') ? event
        : (event.body || event.rawBody || JSON.stringify(event));
      const eventType = pickXml(xml, 'Event');
      console.log('[pay.notify] 收到推送 Event=' + eventType + ' body=' + String(xml).slice(0, 300));
      if (eventType !== 'xpay_goods_deliver_notify') {
        return { success: false, errMsg: '未知推送类型' };
      }
      const openid = pickXml(xml, 'OpenId');
      const outTradeNo = pickXml(xml, 'OutTradeNo');
      const wxOrderId = pickXml(xml, 'MchOrderNo');
      console.log('[pay.notify] openid=' + openid + ' outTradeNo=' + outTradeNo + ' wxOrderId=' + wxOrderId);
      if (!openid) return { success: false, errMsg: '缺少 openid' };
      // 从订单找回该道具时长（permanent 买断）
      const ord = await ordersCol.where(wxOrderId ? { wxOrderId } : { outTradeNo }).limit(1).get().catch(() => ({ data: [] }));
      const o = ord.data && ord.data[0];
      const months = (o && o.months) || 0;
      const days = (o && o.days) || 0;
      const permanent = !!(o && o.permanent);
      await deliver(openid, { months, days, permanent }, outTradeNo, wxOrderId, 'notify');
      return '<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></xml>';
    }

    // ---------------- 兜底查单 ----------------
    if (action === 'query') {
      if (!config.isVirtualPayConfigured()) {
        return { success: false, errMsg: '虚拟支付尚未配置' };
      }
      const outTradeNo = String(event.outTradeNo || '').trim();
      if (!outTradeNo) return { success: false, errMsg: '缺少订单号' };
      const q = await queryOrder(OPENID, outTradeNo);
      if (q.paid) {
        const ord = await ordersCol.where({ outTradeNo }).limit(1).get().catch(() => ({ data: [] }));
        const o = ord.data && ord.data[0];
        const months = (o && o.months) || 0;
        const days = (o && o.days) || 0;
        const permanent = !!(o && o.permanent);
        const d = await deliver(OPENID, { months, days, permanent }, outTradeNo, q.wxOrderId, 'query');
        return { success: true, paid: true, delivered: d.delivered, memberUntil: d.until || null };
      }
      return { success: true, paid: false, raw: q };
    }

    // ---------------- 补单：把「已支付但没发货」的订单找回来 ----------------
    // 微信的「发货推送」若没配好或回调丢失，用户付了钱会员却没加。
    // 这里扫描自己的待支付订单，逐个向微信查单，查到已支付就补发货（幂等）。
    if (action === 'reconcile') {
      if (!config.isVirtualPayConfigured()) {
        return { success: false, errMsg: '虚拟支付尚未配置' };
      }
      // 只看最近 24 小时的待支付订单：微信订单过了支付有效期就永远查不到，
      // 把陈年老单（大多是点了支付又取消的测试单）排掉，避免越攒越多、每次都要查。
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const pend = await ordersCol.where({ openid: OPENID, status: 'pending', createdAt: _.gte(since) })
        .orderBy('createdAt', 'desc').limit(30).get().catch(() => ({ data: [] }));
      const list = (pend.data || []).filter(o => o && o.outTradeNo);
      let delivered = 0;
      const details = [];
      // 并发分批查单：原来一笔一笔串行查，十几笔必然超过云函数 3 秒超时。
      // 每批 10 笔同时查，既快又不会把微信查单接口打爆（避免频率限制）。
      const CHUNK = 10;
      for (let i = 0; i < list.length; i += CHUNK) {
        const batch = list.slice(i, i + CHUNK);
        const results = await Promise.all(batch.map(o =>
          queryOrder(OPENID, o.outTradeNo).catch(e => ({ ok: false, paid: false, errcode: -1, errmsg: String(e) }))
        ));
        for (let k = 0; k < batch.length; k++) {
          const o = batch[k], q = results[k] || {};
          details.push({
            no: o.outTradeNo, paid: !!q.paid,
            status: q.status, errcode: q.errcode, errmsg: q.errmsg || ''
          });
          if (q.paid) {
            await deliver(OPENID, { months: o.months, days: o.days, permanent: o.permanent }, o.outTradeNo, q.wxOrderId, 'reconcile');
            delivered++;
          }
        }
      }
      return { success: true, checked: list.length, delivered, details };
    }

    return { success: false, errMsg: '未知操作' };
  } catch (e) {
    return { success: false, errCode: (e && e.errCode) || 0, errMsg: (e && (e.errMsg || e.message)) || String(e) };
  }
};
