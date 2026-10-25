// 临时诊断：看元宝 SearchPro 返回的原始字段结构
const MCP_URL = "https://api.wsa.cloud.tencent.com/Mcp";
const KEY = process.env.WSA_KEY;

async function search(query, cnt) {
  const payload = {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "SearchPro", arguments: { Query: query, Cnt: String(cnt), Mode: 2 } },
  };
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer " + KEY,
    },
    body: JSON.stringify(payload),
  });
  let text = await r.text();
  if (text.trimStart().startsWith("data:") || text.includes("\ndata:")) {
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    text = lines.length ? lines[lines.length - 1].slice(5).trim() : "";
  }
  const rpc = JSON.parse(text);
  if (rpc.error) throw new Error(JSON.stringify(rpc.error));
  const content = (rpc.result || {}).content || [];
  const outer = JSON.parse(content.length ? content[0].text || "{}" : "{}");
  const resp = outer.Response || outer;
  if (resp.Error) throw new Error(JSON.stringify(resp.Error));
  return (resp.Pages || []).map((p) => {
    try { return JSON.parse(p); } catch (e) { return { _raw: String(p) }; }
  });
}

(async () => {
  const pages = await search("今天天气", 10);
  console.log("=== 返回条数:", pages.length);
  pages.forEach((o, i) => {
    console.log("\n--- 第", i + 1, "条 ---");
    console.log("所有字段:", Object.keys(o).join(", "));
    const show = {};
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (k === "passage" || k === "content") show[k] = String(v).slice(0, 60) + "...";
      else show[k] = v;
    }
    console.log(JSON.stringify(show, null, 2));
  });
})().catch((e) => console.log("错误:", e.message));
