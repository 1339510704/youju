// ============================================================
// 出题器：不预设题库，靠「元宝搜索结果」现场造真假判断题
//   - 只从 official / academic / media 三类来源摘句子（避免自媒体的错知识）
//   - 真句 = 原句；假句 = 改数字 / 加否定词（谣言最常见的两种形态）
// 纯函数，不依赖 wx-server-sdk，方便本地单测（见 tools/quiz-selftest.js）
// ============================================================

const CATEGORIES = [
  { key: 'science', name: '科学', words: '科学 常识 事实' },
  { key: 'history', name: '历史', words: '历史 史实 朝代' },
  { key: 'geo', name: '地理', words: '地理 世界之最 事实' },
  { key: 'animal', name: '动物', words: '动物 习性 科普' },
  { key: 'health', name: '健康', words: '健康 常识 科普' },
  { key: 'life', name: '生活', words: '生活常识 科普' }
];

const TIER_LABEL = {
  official: '官方', academic: '学术', media: '主流媒体',
  vertical: '行业站', selfmedia: '自媒体', marketing: '营销'
};
const DEFAULT_TIERS = ['official', 'academic', 'media'];

function tierRank(t) {
  return { official: 4, academic: 3, media: 2, vertical: 1, selfmedia: 0, marketing: 0 }[t] || 0;
}

function isTrusted(item, allowed) {
  const list = allowed || DEFAULT_TIERS;
  return !!item && list.indexOf(item.tier) >= 0;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

const NOISE = /(点击|查看全文|版权|转载|责任编辑|扫码|关注我们|广告|登录|下载APP|来源：|原标题|编辑：|上一篇|下一篇|政府|办公室|门户网站|新闻网$)/;

// 极性词：能让"真→假"改得自然（最大→最小…），也是好题的特征
const POLARITY_WORDS = ['最大', '最小', '最高', '最低', '最长', '最短', '最多', '最少',
  '第一', '最早', '最晚', '最重', '主要', '属于', '位于', '包括', '可以', '能够', '大于', '高于'];

function splitSentences(text) {
  return String(text || '').split(/[。！？；!?;\n]/).map((s) => s.trim()).filter(Boolean);
}

// 摘要开头往往是「标题 + 站点名」，先剥掉，否则摘出来全是标题碎片
function bodyOf(it) {
  let p = String(it.passage || '');
  const t = String(it.title || '').trim();
  if (t && p.indexOf(t) === 0) p = p.slice(t.length);
  const s = String(it.site || '').trim();
  if (s) p = p.split(s).join(' ');
  return p.replace(/\s+/g, ' ').trim();
}

// 问句、目录式片段、依赖上下文的残句都不适合当判断题
const QUESTION = /(哪些|什么|怎么|如何|怎样|多少|是否|可否|吗|呢|？|\?$)/;
const TOC = /^(\d+[、.．]|[一二三四五六七八九十]+[、.]|第[一二三四五六七八九十]+点)/;
const INDEX_NOISE = /(\s\d+[、.．]|\d+、|（\d+）|\(\d+\))/;          // "日常生活 1、三类人…"
const FRAGMENT_START = /^(但|而|这时|此时|更|所以|因此|不过|然而|例如|另外|同时|其中|如果|因为|由于|于是|此外|还有|接着|然后|最后|反之|对此)/;
const BYLINE = /(记者|摄影|供图|摄于|通讯员)/;

// 只留"像事实"的句子：含数字（可改数字造错）或含极性词（可改极性造错）
function usable(t) {
  const s = String(t || '');
  if (s.length < 14 || s.length > 60) return false;
  if (!/[\u4e00-\u9fa5]/.test(s)) return false;
  if (NOISE.test(s)) return false;
  if (QUESTION.test(s)) return false;
  if (TOC.test(s)) return false;
  if (INDEX_NOISE.test(s)) return false;
  if (FRAGMENT_START.test(s)) return false;
  if (BYLINE.test(s)) return false;
  if (/\d/.test(s)) return true;
  return POLARITY_WORDS.some((w) => s.indexOf(w) >= 0);
}

// 每条来源最多摘 1 句，保证题目来源多样
function harvestClaims(items, allowed) {
  const out = [];
  const used = {};
  for (const it of items || []) {
    if (!isTrusted(it, allowed)) continue;
    const body = bodyOf(it);
    if (!body) continue;
    const parts = splitSentences(body);
    // 摘要被长度截断时，最后一段可能只有半句，直接丢掉
    if (parts.length > 1 && !/[。！？!?]$/.test(body)) parts.pop();
    let got = null;
    for (const s of parts) {
      const t = s.replace(/^[\s·•\-\d.、\[\]【】()（）]+/, '').trim();
      if (!usable(t)) continue;
      if (used[t]) continue;
      got = t;
      break;
    }
    if (got) { used[got] = 1; out.push({ text: got, src: it }); }
  }
  return out;
}

// 把真话改成"看起来很真"的假话；改不动就返回 ''（这题不造假，改出真题）
const POLARITY = [
  ['最大', '最小'], ['最小', '最大'], ['最高', '最低'], ['最低', '最高'],
  ['最长', '最短'], ['最短', '最长'], ['最多', '最少'], ['最少', '最多'],
  ['第一', '第二'], ['最早', '最晚'], ['最晚', '最早'], ['最重', '最轻'],
  ['主要', '次要'], ['增加', '减少'], ['上升', '下降'], ['包括', '不包括'],
  ['可以', '不能'], ['能够', '无法'], ['属于', '不属于'], ['位于', '不在'],
  ['大于', '小于'], ['高于', '低于']
];

function falsify(text) {
  const s = String(text || '');
  if (!s) return '';
  if (/不是|没有|不能|不会|不属|不在|无法/.test(s)) return '';   // 否定句别再叠一层

  const m = s.match(/\d+(?:\.\d+)?/);
  if (m) {
    const raw = m[0];
    let nv;
    if (raw.indexOf('.') > 0) {
      const v = Number(raw);
      nv = String(Math.max(1, Math.round(v * 2 * 10) / 10));
    } else {
      const v = parseInt(raw, 10);
      nv = String(v >= 1000 ? v + 100 : (v >= 100 ? v + 100 : (v >= 10 ? v + 10 : v + 3)));
    }
    if (nv !== raw) return s.replace(raw, nv);
  }
  for (const p of POLARITY) {
    if (s.indexOf(p[0]) >= 0) return s.replace(p[0], p[1]);
  }
  return '';
}

function makeItem(claim, answer, src, origin) {
  return {
    claim,
    answer: !!answer,          // true = 这句话是对的
    origin: origin || '',      // 假题保留原句，揭晓时对照着看
    evidence: [{
      title: src.title, site: src.site, url: src.url, date: src.date,
      quote: origin || claim,
      tier: src.tier, tierLabel: TIER_LABEL[src.tier] || ''
    }]
  };
}

/**
 * 现场出题
 * @param {(q:string, cnt:number)=>Promise<Array>} search 搜索函数（由云函数注入）
 * @param {string} topic 主题 / 类型关键词
 * @param {number} n 题数
 * @param {string[]} allowed 允许的来源分级
 */
async function buildQuiz(search, topic, n, allowed) {
  const items = await search(String(topic || '') + ' 事实 科普', 30);
  const trusted = (items || []).filter((x) => isTrusted(x, allowed))
    .sort((a, b) => tierRank(b.tier) - tierRank(a.tier));
  const claims = harvestClaims(trusted.length ? trusted : items, allowed);
  if (claims.length < 2) throw new Error('这个主题没搜到足够的可靠资料，换个说法或换个类型试试');

  const want = Math.max(2, Math.min(8, n || 5));
  // 含数字的句子更适合做判断题（可以精确改错），优先选
  const ordered = claims.slice().sort((a, b) => {
    const da = /\d/.test(a.text) ? 1 : 0;
    const db2 = /\d/.test(b.text) ? 1 : 0;
    return db2 - da;
  });
  const half = Math.min(ordered.length, want * 2);   // 在"好题"里随机抽，避免每次一样
  const picked = shuffle(ordered.slice(0, half)).slice(0, Math.min(want, ordered.length));
  const fakeCount = Math.min(picked.length - 1, Math.max(1, Math.round(picked.length * 0.4)));

  const out = [];
  picked.forEach((p, i) => {
    if (i < fakeCount) {
      const fake = falsify(p.text);
      if (fake) { out.push(makeItem(fake, false, p.src, p.text)); return; }
    }
    out.push(makeItem(p.text, true, p.src));
  });
  return shuffle(out);
}

module.exports = {
  CATEGORIES, TIER_LABEL, DEFAULT_TIERS,
  tierRank, isTrusted, harvestClaims, falsify, buildQuiz, splitSentences
};
