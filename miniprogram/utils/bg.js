// ============================================================
// 全局页面背景（按「位置」分别控制）
// ------------------------------------------------------------
// 用法（两步）：
//   1. 页面 wxml 的 .page 里第一行放：<view class="bg-layer" style="{{bgStyle}}"></view>
//   2. 页面 js 的 onShow 里调一句：bg.apply(this, '位置key')
//      位置 key：home(家) / orderTop(饭桌顶部) / orderBody(饭桌非顶部) / vip(小红花)
//      不传 place = 沿用全局（users.bg.alpha） —— 老页面兼容用。
//
// 背景来源沿用 flower.pickBgStyle：优先「家庭背景图」，没有才回落个人背景色。
// 每个位置可单独：开/关（on）+ 透明度（alpha，0~1，越小越淡）。
// 配置存在 users.bgPlaces = { 位置: { on, alpha } }；没配过的位置默认开启、用全局透明度。
// ============================================================
const flower = require('./flower.js');

// 默认透明度 0.35：背景太实会压住正文，默认给一个偏淡的值
const DEFAULT_ALPHA = 0.35;

// 支持的位置
const PLACES = ['home', 'orderTop', 'orderBody', 'vip'];
// 位置的展示名（bg-set 页用）
const PLACE_NAMES = {
  home: '家',
  orderTop: '饭桌顶部',
  orderBody: '饭桌非顶部',
  vip: '小红花'
};

function alphaOf(me) {
  const bg = (me && me.bg) || {};
  const a = Number(bg.alpha);
  if (isNaN(a)) return DEFAULT_ALPHA;
  return Math.min(1, Math.max(0, a));
}

// 取某位置的配置；没配过 → 默认开启 + 全局透明度
function placeCfg(me, place) {
  const places = (me && me.bgPlaces) || {};
  const c = places[place];
  if (!c) return { on: true, alpha: alphaOf(me) };
  return { on: c.on !== false, alpha: (typeof c.alpha === 'number' ? c.alpha : alphaOf(me)) };
}

// 背景样式内存缓存：按「位置 + 空间 + 个人背景」做 key。
// 不加的话，每次打开页面都要 wx.cloud.getTempFileURL 转一次图片链接（一次云往返），
// 弱网下切几个页面就明显顿一下。加了之后首次算好就复用，切页瞬时、家页补图也即时。
// ⚠️ 同样带 TTL：临时图片链接过期后必须重新生成，否则会复用旧（已失效）链接导致背景消失。
const _styleCache = {};
const _styleLast = {};   // key → 最近一次算出的非空样式：同一套设置下算空了就沿用它，避免背景抽风消失
const STYLE_TTL = 45 * 60 * 1000;   // 与 cloud.fileUrl 的 URL_TTL 对齐
function invalidate() { for (const k in _styleCache) delete _styleCache[k]; }

// 生成背景串（含透明度）。place 为空 = 全局（users.bg.alpha）
async function styleOf(space, me, place) {
  const spaceId = (space && space._id) || '';
  // 缓存 key 必须覆盖所有会影响结果的输入：
  //   位置 + 空间 + 家庭背景图状态(bgImage/bgImageAt/bgUntil) + 个人背景 + 各位置开关/透明度
  // 漏掉任何一项，改完设置其他页面还会命中旧缓存，表现为「改了背景但没反应」。
  const bgSig = (me && me.bg) ? JSON.stringify(me.bg) : '';
  const placeSig = (me && me.bgPlaces) ? JSON.stringify(me.bgPlaces) : '';
  const spSig = space ? [space.bgImage || '', space.bgImageAt || 0, space.bgUntil || 0].join('|') : '';
  // 会员状态也要进 key：家庭背景图是否可用由会员到期时间决定，
  // 不算进去的话，会员到期/续费后缓存最长 45 分钟才更新。
  const memSig = (me && me.memberUntil) || 0;
  const key = (place || '') + '|' + spaceId + '|' + spSig + '|' + bgSig + '|' + placeSig + '|' + memSig;
  const c = _styleCache[key];
  if (c && Date.now() - c.ts < STYLE_TTL) return c.out;
  const s = await flower.pickBgStyle(space, me);
  if (!s) {
    // key 里已经包含「空间背景图 + 个人背景设置 + 会员期限」，
    // 所以只有「设置没变、重算却算空了」（多是临时链接换取失败）才会走到这里 ——
    // 这种情况沿用上一次的样式，避免背景毫无预兆地消失；设置真改了 key 就变了，不会误留。
    return _styleLast[key] || '';
  }
  const alpha = place ? placeCfg(me, place).alpha : alphaOf(me);
  const out = s + 'opacity:' + alpha + ';';
  _styleCache[key] = { out, ts: Date.now() };
  _styleLast[key] = out;
  return out;
}

// 某位置是否开启背景（bg-set / order hero 判断用）
function placeOn(me, place) {
  return placeCfg(me, place).on;
}

// 把背景应用到当前页面实例（按位置）
async function apply(page, place) {
  try {
    if (!page) return;
    // 记下本页用的位置，后台定时刷新(getApp().bg.refreshCurrent)时能找回
    page.__bgPlace = place || null;
    const app = getApp();
    const me = (app.globalData && app.globalData.profile) || {};
    const space = (app.globalData && app.globalData.currentSpace) || null;
    const style = place ? await styleOf(space, me, place) : await styleOf(space, me);
    page.setData({ bgStyle: style });
    // 首屏时 profile / 空间可能还没回来，算出来是空的 —— 稍等再补一次，避免"背景时有时无"
    if (!style && !page.__bgRetried) {
      page.__bgRetried = true;
      setTimeout(() => { try { apply(page, place); } catch (e) {} }, 900);
    }
  } catch (e) { /* 背景失败不影响页面 */ }
}

// 后台定时刷新：清掉临时链接与样式缓存，对当前最上层页面重新算背景。
// 解决"长时间停留在一个页面不切走，临时链接过期后背景悄悄消失且不再恢复"。
async function refreshCurrent() {
  try {
    invalidate();
    const { invalidateUrlCache } = require('./cloud.js');
    if (invalidateUrlCache) invalidateUrlCache();
    const pages = getCurrentPages() || [];
    const p = pages[pages.length - 1];
    if (p && p.route) apply(p, p.__bgPlace || null);
  } catch (e) { /* 忽略 */ }
}

module.exports = { apply, styleOf, invalidate, refreshCurrent, alphaOf, DEFAULT_ALPHA, PLACES, PLACE_NAMES, placeCfg, placeOn };
