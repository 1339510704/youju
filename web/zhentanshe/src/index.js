import HTML from "./index.html";
import WATCH_HTML from "./watch.html";
import SOURCES_HTML from "./sources.html";

const MCP_URL = "https://api.wsa.cloud.tencent.com/Mcp";

/* ---------------- 工具 ---------------- */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function html(body) {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

async function sha(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str || ""));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/* ---------------- 来路与时效 ----------------
   两个实测出来的坑：
   1) 元宝的 VR 条目（天气/百科等结构化卡）url 经常是空字符串，
      但正文里写着「# 转跳地址：https://...」——来路必须从正文里捞回来，否则点不开原文。
   2) 结果只按 score 排，date 完全不参与，所以问「今天天气」会混进两天前的旧闻。
      这里给每条算清 ageDays，并在有时效意图的查询里把过期的沉底。 */
function pickUrl(o) {
  const u = String(o.url || "").trim();
  if (/^https?:\/\//i.test(u)) return { url: u, from: "api" };
  const body = String(o.passage || "") + " " + String(o.content || "");
  const m = body.match(/https?:\/\/[^\s"'<>）)，,。；;]+/);
  if (m) return { url: m[0].replace(/[.,;:)\]）】]+$/, ""), from: "body" };
  return { url: "", from: "none" };
}

function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
  return isNaN(d.getTime()) ? null : d;
}

function daysAgo(d) {
  if (!d) return null;
  const now = new Date();
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((a - b) / 86400000);
}

function ageLabel(age, raw) {
  if (age === null || age === undefined) return raw || "时间未知";
  if (age <= 0) return "今天";
  if (age === 1) return "昨天";
  if (age < 7) return age + " 天前";
  if (age < 30) return Math.floor(age / 7) + " 周前";
  if (age < 365) return Math.floor(age / 30) + " 个月前";
  return Math.floor(age / 365) + " 年前";
}

// 查询里带"当下"意图才做时效压权重排，避免把「历史事件」类查询也强行按今天过滤
const FRESH_RE = /(今天|今日|现在|目前|实时|最新|刚刚|今早|今晚|昨天|昨日|本周|这周|本周|当前|此刻|天气)/;
// 常见地名，用来判断"问天气但没说城市"
const CITY_RE = /(北京|上海|广州|深圳|杭州|成都|武汉|西安|南京|天津|重庆|苏州|郑州|长沙|青岛|沈阳|大连|厦门|福州|合肥|昆明|济南|哈尔滨|长春|石家庄|太原|南昌|贵阳|南宁|兰州|西宁|银川|乌鲁木齐|拉萨|海口|呼和浩特|香港|澳门|台北|无锡|宁波|佛山|东莞|温州|常州|徐州|烟台|洛阳|珠海|中山|惠州|江门|汕头|湛江|保定|唐山|廊坊|秦皇岛|淄博|潍坊|临沂|济宁|泰安|威海|日照|绍兴|嘉兴|金华|台州|湖州|扬州|镇江|盐城|淮安|连云港|宿迁|泰州|芜湖|蚌埠|安庆|九江|赣州|宜昌|襄阳|荆州|株洲|湘潭|衡阳|岳阳|常德|柳州|桂林|遵义|曲靖|大理|绵阳|德阳|宜宾|泸州|南充|天水|宝鸡|咸阳|榆林|大同|阳泉|长治|晋城|包头|鄂尔多斯|齐齐哈尔|大庆|吉林|鞍山|抚顺|本溪|丹东|锦州|营口|盘锦|葫芦岛)/;

function freshnessIntent(q) { return FRESH_RE.test(q); }

/* ---------------- 元宝检索 ---------------- */
async function wsaSearch(env, query, cnt, mode, industry, site) {
  // Cnt 只接受 10/20/30/40/50，其他值会被 WSA 拒绝（illegal Cnt）
  const VALID = [10, 20, 30, 40, 50];
  let n = parseInt(cnt, 10);
  if (!VALID.includes(n)) n = VALID.reduce((a, b) => Math.abs(b - (n || 20)) < Math.abs(a - (n || 20)) ? b : a, 10);
  const args = { Query: query, Cnt: String(n), Mode: Number(mode || 2) };
  if (industry) args.Industry = industry;
  if (site) args.Site = site;

  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "SearchPro", arguments: args },
  };

  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer " + env.WSA_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  let text = await r.text();
  if (text.trimStart().startsWith("data:") || text.includes("\ndata:")) {
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    text = lines.length ? lines[lines.length - 1].slice(5).trim() : "";
  }

  const rpc = JSON.parse(text);
  if (rpc.error) throw new Error(rpc.error.message || "RPC error");

  const res = rpc.result || {};
  const content = res.content || [];
  const t = content.length ? content[0].text || "{}" : "{}";
  const outer = JSON.parse(t);
  const resp = outer.Response || outer;
  if (resp.Error) throw new Error(resp.Error.Message || "search error");

  const now = new Date();
  const todayStr = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");

  const items = (resp.Pages || []).map((p) => {
    let o = {};
    try {
      o = JSON.parse(p);
    } catch (e) {
      o = { passage: String(p) };
    }
    const picked = pickUrl(o);
    const passageText = o.passage || o.content || "";
    let age = daysAgo(parseDate(o.date));
    // VR 天气卡的 date 是"抓取时间"，不是内容时效；改用正文里有没有今天的日期来判断
    if (o.vr && (o.vr_category || "") === "weather" && String(passageText).includes(todayStr)) age = 0;
    return {
      title: o.title || "",
      url: picked.url,
      urlFrom: picked.from,
      site: o.site || "",
      date: o.date || "",
      ageDays: age,
      ageLabel: ageLabel(age, o.date || ""),
      freshNow: age !== null && age <= 1,
      stale: age !== null && age > 1,
      passage: passageText,
      content: o.content || "",
      score: o.score || 0,
      vr: !!o.vr,
      vrCategory: o.vr_category || "",
    };
  });

  // 有时效意图时：今天的排前，过期的沉底（同档内仍按相关度）
  if (freshnessIntent(query)) {
    items.sort((a, b) => {
      const sa = a.freshNow ? 0 : (a.ageDays === null ? 1 : 2);
      const sb = b.freshNow ? 0 : (b.ageDays === null ? 1 : 2);
      if (sa !== sb) return sa - sb;
      return (b.score || 0) - (a.score || 0);
    });
  }

  // 问天气但没说城市：元宝会返回随机城市（实测给了西班牙、屏东），必须提醒
  let notice = "";
  if (/天气|气温|温度|下雨|降雨|空气质量|台风/.test(query) && !CITY_RE.test(query)) {
    notice = "没指定城市——元宝返回的是不同地区的天气，不一定是你所在地。建议带上城市名重问，例如「北京今天天气」。";
  }

  return {
    ok: true, query, count: items.length, items,
    freshMode: freshnessIntent(query),
    notice,
    todayStr,
  };
}

/* ---------------- 博查搜索（第二引擎，多引擎召回） ---------------- */
async function bochaSearch(env, query, count) {
  const r = await fetch("https://api.bochaai.com/v1/web-search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + env.BOCHA_SEARCH_API_KEY,
    },
    body: JSON.stringify({ query, count: Number(count || 10), summary: false }),
  });
  const j = await r.json();
  const rows = (j && j.data && j.data.webPages && j.data.webPages.value) || [];
  const items = rows.map((x) => {
    const u = x.url || "";
    let host = "";
    try { host = new URL(u).hostname; } catch (e) { host = (x.displayUrl || "").split("/")[0] || ""; }
    return {
      title: x.name || "",
      url: u,
      site: host,
      date: x.datePublished || x.dateLastCrawled || "",
      passage: x.snippet || x.summary || "",
      score: 0,
      vr: false,
      vrCategory: "",
      engine: "bocha",
    };
  });
  return { ok: true, query, count: items.length, items };
}

/* ---------------- 监测：跑一次 + 对比快照 ---------------- */
async function runWatch(env, w) {
  const r = await wsaSearch(env, w.query, "20", 2, w.industry || "");
  const items = (r.items || []).filter((i) => i.url);

  const snap = [];
  for (const it of items.slice(0, 20)) {
    snap.push({
      url: it.url,
      title: it.title,
      site: it.site,
      date: it.date,
      hash: await sha((it.passage || it.title || "").slice(0, 1200)),
    });
  }

  const prev = w.snapshot || [];
  const prevMap = new Map(prev.map((x) => [x.url, x]));
  const nextMap = new Map(snap.map((x) => [x.url, x]));

  const added = snap.filter((x) => !prevMap.has(x.url));
  const removed = prev.filter((x) => !nextMap.has(x.url));
  const changed = snap.filter((x) => prevMap.has(x.url) && prevMap.get(x.url).hash !== x.hash);

  // 首次运行只建基线，不算变更
  const first = !w.lastRun;
  const diff = first
    ? { added: 0, removed: 0, changed: 0 }
    : { added: added.length, removed: removed.length, changed: changed.length };

  w.snapshot = snap;
  w.lastRun = new Date().toISOString();
  w.lastCount = snap.length;
  w.lastDiff = Object.assign({ at: w.lastRun }, diff);

  if (!first && (added.length || removed.length || changed.length)) {
    const hist = (w.history || []).slice(0, 19);
    hist.unshift({
      at: w.lastRun,
      added: added.slice(0, 10).map((x) => ({ title: x.title, url: x.url, site: x.site })),
      removed: removed.slice(0, 10).map((x) => ({ title: x.title, url: x.url, site: x.site })),
      changed: changed.slice(0, 10).map((x) => ({ title: x.title, url: x.url, site: x.site })),
    });
    w.history = hist;
  }

  return w;
}

/* ---------- 来源场景信誉档案（KV 飞轮） ----------
   ⚠️ KV 免费额度只有【1000 次写 / 天】。原来的存法是「一个域名一个 key」：
      每次查证要把 20～60 个域名各读一次写一次 —— 几十次查证就把当天写额度烧光。
      现在把全部域名收进一个 key（rep:agg）：一次查证 = 1 读 + 1 写。
      代价是多人同时查证可能互相覆盖统计（信誉本来就是估算值，可接受）。 */
const REP_ALL = "rep:agg";
const REP_MAX_HOSTS = 800;

async function loadRepAll(env) {
  const agg = await env.WATCH_KV.get(REP_ALL, "json");
  if (agg) return agg;

  // 老数据一次性搬家（rep:index + rep:<host>），搬完只留 agg
  const idx = (await env.WATCH_KV.get("rep:index", "json")) || [];
  if (!idx.length) return {};
  const out = {};
  for (const h of idx) {
    const r = await env.WATCH_KV.get("rep:" + h, "json");
    if (r) out[h] = r;
  }
  if (Object.keys(out).length) {
    await env.WATCH_KV.put(REP_ALL, JSON.stringify(out));
  }
  return out;
}

function mergeRep(cur, verdict, sample, now) {
  const c = cur || { n: 0, ok: 0, warn: 0, no: 0 };
  c.n = (c.n || 0) + 1;
  if (verdict === "采信") c.ok = (c.ok || 0) + 1;
  else if (verdict === "降级") c.warn = (c.warn || 0) + 1;
  else c.no = (c.no || 0) + 1;
  c.score = ((c.ok || 0) * 1 + (c.warn || 0) * 0.4) / Math.max(1, c.n);
  c.updated = now;
  // 留一条样本链接，供来源战绩页展示「这个域名到底给了什么」
  if (sample && sample.url && verdict !== "采信") {
    c.sample = {
      url: String(sample.url).slice(0, 500),
      title: String(sample.title || "").slice(0, 160),
      at: now,
    };
  }
  return c;
}

// 批量更新：一次读 + 一次写，无论这次上报多少条
async function bumpRepBatch(env, rows) {
  const list = (rows || []).filter((r) => r && r.host).slice(0, 60);
  if (!list.length) return 0;
  const all = await loadRepAll(env);
  const now = new Date().toISOString();
  list.forEach((r) => { all[r.host] = mergeRep(all[r.host], r.verdict, r.sample, now); });

  // 只保留最常出现的域名，别让这个 key 无限长大
  const keys = Object.keys(all);
  if (keys.length > REP_MAX_HOSTS) {
    keys.sort((a, b) => (all[b].n || 0) - (all[a].n || 0));
    keys.slice(REP_MAX_HOSTS).forEach((k) => { delete all[k]; });
  }
  await env.WATCH_KV.put(REP_ALL, JSON.stringify(all));
  return list.length;
}

async function bumpRep(env, host, verdict, sample) {
  return bumpRepBatch(env, [{ host, verdict, sample }]);
}

async function listRep(env) {
  return await loadRepAll(env);
}

/* ---------- 用户自建权威域名库（可信来源白名单） ---------- */
function normHost(h) {
  let s = String(h || "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^\/\//, "").split("/")[0].split("?")[0].split(":")[0];
  s = s.replace(/^www\./, "");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return "";
  return s;
}

async function listTrust(env) {
  const idx = (await env.WATCH_KV.get("trust:index", "json")) || [];
  const out = [];
  for (const h of idx) {
    const v = await env.WATCH_KV.get("trust:" + h, "json");
    if (v) out.push(v);
  }
  out.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  return out;
}

async function addTrust(env, host, note) {
  const h = normHost(host);
  if (!h) throw new Error("域名格式不对，例如 gov.cn 或 stats.gov.cn");
  const cur = {
    host: h,
    note: String(note || "").slice(0, 100),
    addedAt: new Date().toISOString(),
  };
  await env.WATCH_KV.put("trust:" + h, JSON.stringify(cur));
  const idx = (await env.WATCH_KV.get("trust:index", "json")) || [];
  if (!idx.includes(h)) {
    idx.push(h);
    await env.WATCH_KV.put("trust:index", JSON.stringify(idx.slice(0, 100)));
  }
  return cur;
}

async function delTrust(env, host) {
  const h = normHost(host);
  if (!h) return false;
  await env.WATCH_KV.delete("trust:" + h);
  const idx = (await env.WATCH_KV.get("trust:index", "json")) || [];
  await env.WATCH_KV.put("trust:index", JSON.stringify(idx.filter((x) => x !== h)));
  return true;
}

/* ---------- 公开提问墙（"其他人在问什么"）----------
   只存问题文本本身，不存查证结果/证据。基础关键词黑名单过滤违法/色情/人身攻击类内容。 */
const PUBQ_BLOCK = [
  "色情", "裸", "约炮", "嫖", "赌博", "博彩", "枪支", "毒品", "贩毒", "制毒", "炸药", "爆炸物",
  "自杀方法", "自残方法", "杀人", "強奸", "强奸", "乱伦", "儿童色情", "恋童",
  "滚你", "去死", "贱货", "婊子", "操你", "傻逼", "蠢猪", "废物东西",
];
function pubqIsSafe(text) {
  const t = String(text || "");
  return !PUBQ_BLOCK.some((w) => t.includes(w));
}

async function loadPubqAll(env) {
  const arr = await env.WATCH_KV.get("pubq:all", "json");
  if (arr) return arr;
  // 老数据一次性搬家（pubq:index + pubq:<id>）
  const idx = (await env.WATCH_KV.get("pubq:index", "json")) || [];
  if (!idx.length) return [];
  const out = [];
  for (const id of idx) {
    const v = await env.WATCH_KV.get("pubq:" + id, "json");
    if (v) out.push(v);
  }
  if (out.length) await env.WATCH_KV.put("pubq:all", JSON.stringify(out));
  return out;
}

async function addPubQuestion(env, text) {
  const q = String(text || "").trim().slice(0, 200);
  if (q.length < 4) throw new Error("问题太短");
  if (!pubqIsSafe(q)) throw new Error("内容不符合规范，换个说法试试");
  const id = (await sha(q + Date.now() + Math.random())).slice(0, 12);
  const cur = { id, q, at: new Date().toISOString() };
  const all = await loadPubqAll(env);
  all.unshift(cur);
  await env.WATCH_KV.put("pubq:all", JSON.stringify(all.slice(0, 200))); // 只留最近 200 条
  return cur;
}

async function listPubQuestions(env, limit) {
  const all = await loadPubqAll(env);
  const n = Math.max(1, Math.min(50, parseInt(limit, 10) || 20));
  return all.slice(0, n);
}

async function listWatches(env) {
  const idx = (await env.WATCH_KV.get("watch:index", "json")) || [];
  const out = [];
  for (const id of idx) {
    const w = await env.WATCH_KV.get("watch:" + id, "json");
    if (w) out.push(w);
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

async function saveWatch(env, w) {
  await env.WATCH_KV.put("watch:" + w.id, JSON.stringify(w));
  const idx = (await env.WATCH_KV.get("watch:index", "json")) || [];
  if (!idx.includes(w.id)) {
    idx.push(w.id);
    await env.WATCH_KV.put("watch:index", JSON.stringify(idx));
  }
}

async function deleteWatch(env, id) {
  await env.WATCH_KV.delete("watch:" + id);
  let idx = (await env.WATCH_KV.get("watch:index", "json")) || [];
  idx = idx.filter((x) => x !== id);
  await env.WATCH_KV.put("watch:index", JSON.stringify(idx));
}

/* ---------------- 入口 ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (p === "/api/health") {
        return json({ ok: true, key: !!env.WSA_API_KEY, watch: !!env.WATCH_KV });
      }

      if (p === "/api/bocha") {
        if (!env.BOCHA_SEARCH_API_KEY) return json({ ok: false, error: "未配置 BOCHA_SEARCH_API_KEY" }, 400);
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json({ ok: false, error: "缺少 q" }, 400);
        try {
          const out = await bochaSearch(env, q, url.searchParams.get("count"));
          return json(out);
        } catch (e) {
          return json({ ok: false, error: String(e && e.message ? e.message : e) });
        }
      }

      if (p === "/api/search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json({ ok: false, error: "缺少参数 q" }, 400);
        const out = await wsaSearch(
          env, q,
          url.searchParams.get("cnt"),
          url.searchParams.get("mode"),
          url.searchParams.get("industry"),
          url.searchParams.get("site")
        );

        /* 用户自建权威域名：对每个域名做定向检索，合并进主结果。
           实测 Site 参数对纯根域（如 gov.cn）经常搜不到，带 www. 前缀的变体命中率明显更高，
           所以两种形式都试一次，谁有结果用谁。 */
        try {
          const trust = await listTrust(env);
          if (trust.length && out && out.items) {
            const want = trust.slice(0, 3);
            const variants = want.flatMap((t) => [
              { host: t.host, note: t.note, site: t.host },
              { host: t.host, note: t.note, site: "www." + t.host },
            ]);
            const extra = await Promise.all(
              variants.map((v) => wsaSearch(env, q, 10, 2, "", v.site).catch(() => null))
            );
            const seen = new Set(out.items.map((x) => x.url));
            extra.forEach((r, k) => {
              if (!r || !r.ok) return;
              (r.items || []).forEach((it) => {
                if (!it.url || seen.has(it.url)) return;
                seen.add(it.url);
                it.trusted = true;
                it.trustNote = variants[k].note || "";
                out.items.push(it);
              });
            });
            out.trustHit = out.items.filter((x) => x.trusted).length;
            out.count = out.items.length;
          }
        } catch (e) { /* 自建域名检索失败不影响主检索 */ }

        return json(out);
      }

      /* --- Bocha Jev 决策代理（配置了 Key 才可用） --- */
      if (p === "/api/jev/health") {
        return json({ ok: true, configured: !!env.BOCHA_JEV_API_KEY });
      }

      if (p === "/api/jev/judge" && request.method === "POST") {
        if (!env.BOCHA_JEV_API_KEY) {
          return json({ ok: false, error: "未配置 BOCHA_JEV_API_KEY" }, 400);
        }
        const b = await request.json().catch(() => ({}));
        const query = (b.query || "").trim();
        const mats = (b.materials || []).slice(0, 6);
        if (!query || !mats.length) return json({ ok: false, error: "缺少 query 或 materials" }, 400);

        const out = [];
        for (let i = 0; i < mats.length; i++) {
          const m = mats[i];
          const body = {
            model: "bocha-jev-v1",
            state: String(m.text || "").slice(0, 1200),
            questions: {
              direct: {
                type: "noul",
                instructions: "这段材料是否包含对下面这个问题的直接、事实性回答？只答是否，不考虑它写得好不好。问题：" + query.slice(0, 120),
              },
              rel: {
                type: "score",
                instructions: "与问题的相关程度",
                criteria: ["无关", "间接相关", "直接相关"],
              },
            },
          };
          try {
            const r = await fetch("https://jev.bocha.cn/v1/systemone", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + env.BOCHA_JEV_API_KEY,
              },
              body: JSON.stringify(body),
            });
            const t = await r.text();
            let j = null;
            try { j = JSON.parse(t); } catch (e) {}
            if (!r.ok) {
              out.push({ i, ok: false, error: "Jev HTTP " + r.status });
            } else {
              const a = (j && j.answers) || {};
              out.push({
                i, ok: true,
                direct: a.direct ? a.direct.noul : null,
                rel: a.rel ? a.rel.score : null,
                relConf: a.rel ? a.rel.confidence : null,
              });
            }
          } catch (e) {
            out.push({ i, ok: false, error: String(e) });
          }
        }
        return json({ ok: true, results: out });
      }

      /* --- 来源信誉 --- */
      if (p === "/api/reputation" && request.method === "GET") {
        return json({ ok: true, rep: await listRep(env) });
      }

      if (p === "/api/reputation" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const rows = b.items || [];
        // 一次读写搞定，不再「一个域名一次 put」
        let n = 0;
        try { n = await bumpRepBatch(env, rows); } catch (e) { /* 写失败不影响查证 */ }
        return json({ ok: true, count: n });
      }

      /* --- 用户自建权威域名库 --- */
      if (p === "/api/trust" && request.method === "GET") {
        return json({ ok: true, trust: await listTrust(env) });
      }

      if (p === "/api/trust" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        try {
          const t = await addTrust(env, b.host, b.note);
          return json({ ok: true, trust: t });
        } catch (e) {
          return json({ ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      }

      if (p === "/api/trust" && request.method === "DELETE") {
        const h = url.searchParams.get("host") || "";
        await delTrust(env, h);
        return json({ ok: true });
      }

      /* --- 公开提问墙（其他人在问什么） --- */
      if (p === "/api/pubq" && request.method === "GET") {
        const n = url.searchParams.get("n") || "20";
        return json({ ok: true, items: await listPubQuestions(env, n) });
      }

      if (p === "/api/pubq" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        try {
          const item = await addPubQuestion(env, b.q);
          return json({ ok: true, item });
        } catch (e) {
          return json({ ok: false, error: String(e && e.message ? e.message : e) }, 400);
        }
      }

      /* --- 监测 API --- */
      if ((p === "/api/watch" || p === "/api/watch/list") && request.method === "GET") {
        return json({ ok: true, watches: await listWatches(env) });
      }

      if (p === "/api/watch" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const query = (b.query || "").trim();
        if (!query) return json({ ok: false, error: "缺少 query" }, 400);
        const w = {
          id: (await sha(query + Date.now())).slice(0, 10),
          query,
          industry: b.industry || "",
          createdAt: new Date().toISOString(),
          lastRun: null,
          lastCount: 0,
          snapshot: [],
          history: [],
        };
        await saveWatch(env, w);
        return json({ ok: true, watch: w });
      }

      if (p === "/api/watch" && request.method === "DELETE") {
        const id = url.searchParams.get("id") || "";
        if (!id) return json({ ok: false, error: "缺少 id" }, 400);
        await deleteWatch(env, id);
        return json({ ok: true });
      }

      if (p === "/api/watch/run" && request.method === "POST") {
        const id = url.searchParams.get("id") || "";
        const all = await listWatches(env);
        const targets = id ? all.filter((w) => w.id === id) : all;
        const results = [];
        for (const w of targets) {
          try {
            const nw = await runWatch(env, w);
            await saveWatch(env, nw);
            results.push({ id: nw.id, ok: true, diff: nw.lastDiff });
          } catch (e) {
            results.push({ id: w.id, ok: false, error: String(e && e.message ? e.message : e) });
          }
        }
        return json({ ok: true, results });
      }

      if (p === "/api/watch/clear") {
        const all = await listWatches(env);
        for (const w of all) await deleteWatch(env, w.id);
        return json({ ok: true });
      }

      /* --- 页面 --- */
      if (p === "/watch") return html(WATCH_HTML);
      if (p === "/sources") return html(SOURCES_HTML);
      return html(HTML);
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  },

  /* --- 定时任务：每 6 小时 --- */
  async scheduled(event, env, ctx) {
    const all = await listWatches(env);
    for (const w of all) {
      try {
        const nw = await runWatch(env, w);
        await saveWatch(env, nw);
      } catch (e) {
        /* 单条失败不影响其他 */
      }
    }
  },
};
