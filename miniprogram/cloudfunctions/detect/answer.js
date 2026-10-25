// ============================================================
// 答案提炼：把搜索结果压成「2～3 句最相关的原文」
//   问题：之前直接拼 2 段摘要 → 又长又乱（带标题、站点、目录、广告尾巴）
//   做法：剥掉标题前缀 → 切句 → 去噪 → 按与问题的相关度打分 → 每来源最多 1 句
// 纯函数，不依赖 wx-server-sdk，方便本地调试
// ============================================================
const QZ = require('./quiz.js');

// 句子层面的噪音（正文里常见）
const SENT_NOISE = /(点击|查看全文|版权|转载|责任编辑|扫码|关注|公众号|广告|登录|注册|下载APP|来源[:：]|原标题|编辑[:：]|上一篇|下一篇|本文|记者|摄影|供图|通讯员|视频|图\/|图片来源|姓名|单位[:：]|邮箱|验证码)/;
// 站名/标题尾部常见字样
const TAIL_NOISE = /(政府|办公室|门户网站|人民政府网|新闻网|官网|网站首页|首页)/;
// 问句：这类句子是"问题"不是"答案"，要压下去
const QUESTION_LIKE = /(吗|呢|？|\?|是否|怎么|如何|为什么|是什么|哪些|多少|哪种|靠谱|真的吗)/;
// 答案信号：出现这些词，往往就是在给结论/解释
const ANSWER_SIGNAL = /(并非|不是|而是|其实|实际上|取决于|指的是|指的|表示为|表示|表明|研究|实验|数据|说明|建议|应当|应该|需要|可以|不能|会导致|导致|造成|属于|等于|约为|达到|因为|由于|使得|形成|产生|原因)/;
// 铺垫性废话
const FILLER = /(有人|不少人|许多|眼下|近年|近日|随着|夏季高温|刚需|热门话题|消暑|众所周知|人人皆知)/;
// 元信息（日期、来源、公众号）
const META = /(来源[:：]|微信公众号|记者|采访|编辑|发布时间|\d{4}-\d{2}-\d{2})/;
// 目录序号：一、 1、 (1) 这类是标题，不是句子
const TOC_HEAD = /^([一二三四五六七八九十]+[、.．]|\d+[、.．]|（[一二三四五六七八九十\d]+）|\([一二三四五六七八九十\d]+\))/;

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// 摘要开头往往是「标题 + 站点名」，先剥掉
function stripPrefix(it) {
  let p = clean(it.passage);
  const t = clean(it.title);
  if (t && p.indexOf(t) === 0) p = p.slice(t.length);
  const site = clean(it.site);
  if (site) p = p.split(site).join(' ');
  return p.replace(/^[\s。，、:：\-—|·]+/, '');
}

// 切成 2～3 字的中文片段 + 英文/数字词，用来算"这句话跟问题有多相关"
function tokensOf(q) {
  const raw = String(q || '');
  const zh = raw.replace(/[^\u4e00-\u9fa5]/g, '');
  const set = {};
  for (let i = 0; i < zh.length - 1; i++) {
    const t = zh.slice(i, i + 2);
    if (t.length === 2) set[t] = 1;
  }
  (raw.match(/[a-zA-Z0-9]{2,}/g) || []).forEach((w) => { set[w.toLowerCase()] = 1; });
  return Object.keys(set);
}

// 「记者问：……给出解答：26℃并非最省电温度」→ 取冒号后面那半句才是答案
function afterColon(s) {
  const m = String(s).match(/[:：]/);
  if (!m) return s;
  const right = s.slice(m.index + 1).trim();
  return right.length >= 16 ? right : s;
}

function scoreSentence(s, toks, tier, q) {
  let hit = 0;
  for (const t of toks) if (s.indexOf(t) >= 0) hit++;
  let sc = hit * 2.5;

  if (QUESTION_LIKE.test(s)) sc -= 6;              // 这是问题，不是答案
  if (ANSWER_SIGNAL.test(s)) sc += 3;              // 有结论/解释信号
  if (FILLER.test(s)) sc -= 2;                     // 铺垫废话
  if (META.test(s)) sc -= 3;                       // 日期/来源/记者
  if (TAIL_NOISE.test(s)) sc -= 1.5;               // "xx人民政府"这类残留
  if (/\d/.test(s)) sc += 1;                       // 有数字信息量更大

  // 问题里的关键数字出现在句子里 → 很可能就是答案
  const nums = String(q || '').match(/\d+/g) || [];
  if (nums.length && nums.some((n) => s.indexOf(n) >= 0)) sc += 2;

  sc += QZ.tierRank(tier) * 0.6;                   // 来源越权威越靠前
  if (s.length > 55) sc -= (s.length - 55) / 30;    // 太长的略降权
  if (s.length < 20) sc -= 3;                       // 太短的多半是标题碎片
  if (s.length >= 25 && ANSWER_SIGNAL.test(s)) sc += 1;   // 完整解释句加分
  return sc;
}

// 和问题"太像"的句子（基本是复述问题）不算答案
function tooSimilar(s, toks) {
  if (!toks.length) return false;
  let hit = 0;
  for (const t of toks) if (s.indexOf(t) >= 0) hit++;
  return hit / toks.length > 0.62 && s.length < 40;
}

// 两句的 2-gram 重合度：用来去重（不同来源常把同一句意思换着说）
function gramSet(s) {
  const t = String(s).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const set = {};
  for (let i = 0; i < t.length - 1; i++) set[t.slice(i, i + 2)] = 1;
  return set;
}
function overlap(a, b) {
  const A = gramSet(a), B = gramSet(b);
  const keys = Object.keys(A);
  if (!keys.length) return 0;
  let hit = 0;
  for (const k of keys) if (B[k]) hit++;
  return hit / keys.length;
}

function trim(s, max) {
  const t = clean(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const dot = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf(','));
  return (dot > max * 0.5 ? cut.slice(0, dot) : cut) + '…';
}

/**
 * 从搜索结果里挑出最相关的几句话
 * @param {Array} items 搜索结果（含 title/site/url/passage/tier）
 * @param {string} q 用户的问题
 * @param {number} max 最多几句（默认 3）
 * @returns {{points:Array, answer:string}}
 */
function pickPoints(items, q, max) {
  const toks = tokensOf(q);
  const cands = [];
  (items || []).forEach((it) => {
    const body = stripPrefix(it);
    if (!body) return;
    QZ.splitSentences(body).forEach((raw) => {
      // 只剥掉行首的符号/圆点，别把 "26℃" 的 26 也剥了
      let s = String(raw).replace(/^[\s·•\-—、.。\[\]【】()（）]+/, '').trim();
      if (s.length < 10 || s.length > 120) return;
      if (!/[\u4e00-\u9fa5]/.test(s)) return;
      if (SENT_NOISE.test(s)) return;
      if (TOC_HEAD.test(s)) return;                 // "一、空调开26℃最省电" 这种标题
      s = afterColon(s);
      if (s.length < 16 || s.length > 120) return;  // 太短的片段不当作答案
      if (QUESTION_LIKE.test(s)) return;            // 问句不是答案，直接丢掉
      if (FILLER.test(s)) return;                   // 背景铺垫也不给
      if (tooSimilar(s, toks)) return;              // 复述问题的句子也不算
      cands.push({ s, it, score: scoreSentence(s, toks, it.tier, q) });
    });
  });

  cands.sort((a, b) => b.score - a.score);

  const points = [];
  const usedUrl = {};
  let totalLen = 0;
  for (const c of cands) {
    if (points.length >= (max || 3)) break;
    if (usedUrl[c.it.url]) continue;              // 同一来源只取一句，避免来回重复
    if (c.score <= 0) continue;                   // 跟问题完全不搭的不要
    const text = trim(c.s, 60);
    if (points.some((p) => overlap(p.text, text) > 0.45)) continue;   // 意思重复的句子只留一句
    if (totalLen + text.length > 120) continue;    // 总长度兜住（两句以内），别又变长
    usedUrl[c.it.url] = 1;
    totalLen += text.length;
    points.push({
      text,
      site: c.it.site || '',
      url: c.it.url || '',
      tier: c.it.tier || 'vertical',
      tierLabel: QZ.TIER_LABEL[c.it.tier] || ''
    });
  }

  // 兜底：一条合格的都没挑出来时，给最相关的那一句（保持短）
  if (!points.length && cands.length) {
    const c = cands[0];
    points.push({
      text: trim(c.s, 50), site: c.it.site || '', url: c.it.url || '',
      tier: c.it.tier || 'vertical', tierLabel: QZ.TIER_LABEL[c.it.tier] || ''
    });
  }

  return { points, answer: points.map((p) => p.text).join('；') };
}

module.exports = { pickPoints, stripPrefix, tokensOf, scoreSentence };
