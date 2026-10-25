// 小红花工具：规则缓存、角色名、头像兜底、背景主题预设
const { call, fileUrl } = require('./cloud.js');

let RULES = null;

// 拉取一次规则表并缓存（规则表在服务端 flower 云函数里维护）
async function getRules() {
  if (RULES) return RULES;
  try {
    const r = await call('flower', { action: 'rules' });
    RULES = r;
  } catch (e) {
    RULES = { earn: {} };
  }
  return RULES;
}

// 家庭背景图：没用小红花解锁时，免费试用 3 天，到期自动恢复默认背景
const BG_TRIAL_MS = 3 * 24 * 60 * 60 * 1000;

// 自定义背景预设（免费档）
const BG_PRESETS = [
  { key: 'default', name: '默认', type: 'color', value: '#f6f6f8' },
  { key: 'mint',    name: '薄荷', type: 'color', value: '#eef6f1' },
  { key: 'sky',     name: '晴空', type: 'color', value: '#eef3fb' },
  { key: 'sakura',  name: '樱花', type: 'color', value: '#fdf1f4' },
  { key: 'sand',    name: '暖沙', type: 'color', value: '#faf5ec' },
  { key: 'ink',     name: '石墨', type: 'color', value: '#eff0f2' }
];

// 把用户存的背景转成 style 字符串
// ⚠️ 图片背景必须先转 https：<image> 认 cloud://，但 CSS 的 background-image 不认，
//    直接用会静默加载失败 —— 表现就是「上传成功了但背景没变」。
async function bgStyle(bg) {
  if (!bg || bg.type === 'default' || !bg.value) return '';
  if (bg.type === 'image') {
    const u = await fileUrl(bg.value);
    if (!u) return '';
    return 'background-image:url(' + u + ');background-size:cover;background-position:center top;';
  }
  return 'background-color:' + bg.value + ';';
}

// 家庭背景图状态：
//   mode:
//     'none'     没传图
//     'member'   有图 → 一直可用（全家共用）
// ⚠️ 之前是按「看这张图的人自己是不是会员」来决定显示与否，导致家人自己会员一过期
//    就看不到家里的背景图（很反直觉）。家庭背景图是空间级的、全家共用，
//    所以改成：只要传过图就一直显示。
function spaceBgInfo(space) {
  const s = space || {};
  const url = s.bgImage || '';
  const at = s.bgImageAt || 0;
  if (!url || !at) return { url: '', valid: false, daysLeft: 0, expired: false, timed: false, mode: 'none' };
  return { url, valid: true, expired: false, timed: false, mode: 'member', daysLeft: 0 };
}

// 家庭背景图转成 style（无效/到期返回空串，自动回落到默认背景）
async function spaceBgStyle(space, me) {
  const i = spaceBgInfo(space, me);
  if (!i.valid) return '';
  const u = await fileUrl(i.url);
  if (!u) return '';
  return 'background-image:url(' + u + ');background-size:cover;background-position:center top;';
}

// 等级徽章：按「累计获得的小红花」升级（花掉不掉级）。门槛与云端 BADGES 保持一致。
const BADGES = [
  { key: 'flower', name: '小红花', icon: 'flower_red', need: 0 },
  { key: 'big',    name: '大红花', icon: 'flower_big', need: 50 },
  { key: 'heart',  name: '红心',   icon: 'heart',      need: 150 },
  { key: 'hearts', name: '心连心', icon: 'hearts',     need: 350 },
  { key: 'house',  name: '一个家', icon: 'house',      need: 700 }
];

function badgeOf(earned) {
  const e = Math.max(0, Number(earned) || 0);
  let cur = BADGES[0], next = null;
  for (let i = 0; i < BADGES.length; i++) {
    if (e >= BADGES[i].need) cur = BADGES[i];
    else { next = BADGES[i]; break; }
  }
  const span = next ? (next.need - cur.need) : 1;
  return {
    key: cur.key, name: cur.name, icon: cur.icon, need: cur.need, earned: e,
    next: next ? { key: next.key, name: next.name, icon: next.icon, need: next.need } : null,
    left: next ? (next.need - e) : 0,
    progress: next ? Math.max(0, Math.min(100, Math.round((e - cur.need) / span * 100))) : 100
  };
}

// 页面该用哪张背景：优先「家庭背景图」（全家共用一张，是否可用由 spaceBgInfo 按会员判定），没有才回落个人背景色。
// ⚠️ 必须 await（图片背景要把 cloud:// 换成 https），直接塞进 setData 会变成个空对象。
async function pickBgStyle(space, me) {
  const m = me || {};
  const s = await spaceBgStyle(space, m);
  if (s) return s;
  return await bgStyle(m.bg);
}

function roleName(role) {
  if (role === 'owner') return '户主';
  if (role === 'admin') return '管理员';
  return '成员';
}

// 昵称首字（没有头像时显示的文字）
function initial(name) {
  return (name || '成').trim().slice(0, 1) || '成';
}

// 暖心提示：赚到小红花时统一弹一句「获得 N 朵小红花」。
// 只在真发到花时才弹；发到 0 朵（撞每日上限 / 重复操作）就安静跳过，不打扰。
function toastEarn(n) {
  const delta = Math.max(0, Number(n) || 0);
  if (!delta) return false;
  wx.showToast({ title: '获得 ' + delta + ' 朵小红花', icon: 'none', duration: 1800 });
  return true;
}

// 花数友好的展示
function flowers(n) {
  n = n || 0;
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

module.exports = {
  getRules, BG_PRESETS, BG_TRIAL_MS,
  bgStyle, spaceBgInfo, spaceBgStyle,
  roleName, initial, flowers, toastEarn,
  BADGES, badgeOf, pickBgStyle
};
