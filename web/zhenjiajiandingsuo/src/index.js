import HTML from "./index.html";

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

/* ---------------- 真实来源分级（按域名特征判断，不是预设答案库） ----------------
   官方：gov.cn / 政府机构域
   学术：edu / ac.cn / 知名学术期刊域
   主流媒体：新华社、人民网、央视等公开可查的主流媒体域名
   垂直权威：行业权威站点（卫生健康委、统计局之外的专业机构）
   自媒体：知乎、微博、小红书、百家号等 UGC 平台
   营销/其他：剩下的，默认不给额外可信度 */
const OFFICIAL_SUFFIX = [".gov.cn", ".gov"];
const ACADEMIC_HINTS = [".edu.cn", ".edu", "ac.cn", "nature.com", "science.org", "pubmed", "ncbi.nlm.nih.gov", "jamanetwork.com", "thelancet.com", "nejm.org"];
// 用"品牌核心词"而不是整域名匹配，这样 health.people.cn / www.people.com.cn 都能命中 people
const MEDIA_BRANDS = ["xinhuanet", "people", "cctv", "chinadaily", "cnr", "bbc", "reuters", "apnews", "gmw", "cnbc", "cankaoxiaoxi", "thepaper"];
const SELFMEDIA_BRANDS = ["zhihu", "weibo", "xiaohongshu", "baijiahao", "toutiao", "bilibili", "douyin", "jianshu", "sohu", "sina.com.cn"];

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
}

function classifyTier(host) {
  const h = (host || "").toLowerCase();
  if (OFFICIAL_SUFFIX.some((s) => h.endsWith(s))) return "official";
  if (ACADEMIC_HINTS.some((s) => h.includes(s))) return "academic";
  if (MEDIA_BRANDS.some((s) => h.includes(s))) return "media";
  if (SELFMEDIA_BRANDS.some((s) => h.includes(s))) return "selfmedia";
  // 带明显营销/导购关键词的域名（真实检索里常见）
  if (/(buy|shop|mall|sale|promo|zhuanqian|daikuan)[-.]/.test(h) || /(buy|mall|shop)\.[a-z]+$/.test(h)) return "marketing";
  return "vertical"; // 默认归为垂直/行业站点，不特别加分也不特别扣分
}

/* ---------------- 元宝检索（与侦探社同款 MCP 调用） ---------------- */
async function wsaSearch(env, query, cnt, mode) {
  const VALID = [10, 20, 30, 40, 50];
  let n = parseInt(cnt, 10);
  if (!VALID.includes(n)) n = VALID.reduce((a, b) => Math.abs(b - (n || 20)) < Math.abs(a - (n || 20)) ? b : a, 10);
  const args = { Query: query, Cnt: String(n), Mode: Number(mode || 2) };

  const payload = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "SearchPro", arguments: args } };

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

  const items = (resp.Pages || []).map((p) => {
    let o = {};
    try { o = JSON.parse(p); } catch (e) { o = { passage: String(p) }; }
    const url = o.url || "";
    const host = hostOf(url);
    const site = o.site || host; // site 可能是"人民网"这种中文展示名，分级必须按真实域名判断
    return {
      title: (o.title || "").replace(/\s+/g, " ").trim(),
      url,
      site,
      date: o.date || "",
      passage: (o.passage || o.content || "").replace(/\s+/g, " ").trim(),
      score: o.score || 0,
      tier: classifyTier(host),
    };
  });

  return { ok: true, count: items.length, items };
}

/* ---------------- Jev 判分：这段证据对这个判断有多大支撑 ---------------- */
async function jevScore(env, claim, passage) {
  if (!env.BOCHA_JEV_API_KEY) return null;
  const body = {
    model: "bocha-jev-v1",
    state: String(passage || "").slice(0, 1200),
    questions: {
      stance: {
        type: "score",
        instructions: "这段材料对「" + String(claim).slice(0, 150) + "」这个说法的态度",
        criteria: ["明确反驳/否定", "中立/不相关", "明确支持/证实"],
      },
      quote: {
        type: "noul",
        instructions: "这段材料里是否有一句可以直接摘出来当证据引用的原句（而不是泛泛而谈）？",
      },
    },
  };
  try {
    const r = await fetch("https://jev.bocha.cn/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.BOCHA_JEV_API_KEY },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) return null;
    const a = j.answers || {};
    return {
      stance: a.stance ? a.stance.score : null, // 0=反驳 1=中立 2=支持（按 criteria 顺序映射）
      hasQuote: a.quote ? a.quote.noul : null,
    };
  } catch (e) {
    return null;
  }
}

/* ---------------- 入口 ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (p === "/api/health") {
        return json({ ok: true, key: !!env.WSA_API_KEY, jev: !!env.BOCHA_JEV_API_KEY });
      }

      if (p === "/api/search" && request.method === "GET") {
        if (!env.WSA_API_KEY) return json({ ok: false, error: "未配置 WSA_API_KEY" }, 400);
        const q = (url.searchParams.get("q") || "").trim();
        const cnt = url.searchParams.get("cnt") || "10";
        if (!q) return json({ ok: false, error: "缺少 q" }, 400);
        try {
          const out = await wsaSearch(env, q, cnt, 2);
          return json(out);
        } catch (e) {
          return json({ ok: false, error: String(e.message || e) }, 502);
        }
      }

      if (p === "/api/judge" && request.method === "POST") {
        if (!env.BOCHA_JEV_API_KEY) return json({ ok: false, error: "未配置 BOCHA_JEV_API_KEY" }, 400);
        const b = await request.json().catch(() => ({}));
        const claim = (b.claim || "").trim();
        const items = (b.items || []).slice(0, 12);
        if (!claim || !items.length) return json({ ok: false, error: "缺少 claim 或 items" }, 400);
        const results = await Promise.all(
          items.map(async (it, i) => {
            const s = await jevScore(env, claim, it.passage || it.title || "");
            return { i, ...s };
          })
        );
        return json({ ok: true, results });
      }

      if (p === "/" || p === "") {
        return new Response(HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
        });
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 500);
    }
  },
};
