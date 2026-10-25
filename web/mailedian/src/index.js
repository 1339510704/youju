import HTML from "./index.html";

const MCP_URL = "https://mcp.mcd.cn/";

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

/* ---------- 调麦当劳 MCP ---------- */
async function mcpCall(env, tool, args) {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  };

  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer " + env.MCD_MCP_TOKEN,
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
  if (res.isError) {
    const t = (res.content || []).map((c) => c.text || "").join("");
    throw new Error(t.slice(0, 200) || "tool error");
  }

  if (res.structuredContent) {
    const sc = res.structuredContent;
    return sc.data !== undefined ? sc.data : sc;
  }

  const raw = (res.content || []).map((c) => c.text || "").join("");
  // 从尾部往前找可解析的 JSON
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i] !== "{") continue;
    try {
      return JSON.parse(raw.slice(i));
    } catch (e) {
      /* continue */
    }
  }
  return {};
}

/* ---------- 归一化 ---------- */
function normStore(d) {
  return {
    storeCode: d.storeCode || "",
    beCode: d.beCode || "",
    storeName: d.storeName || "",
    address: d.address || "",
    distance: d.distance || "",
    businessStatus: d.businessStatus !== false,
    businessStartTime: d.businessStartTime || "",
    businessEndTime: d.businessEndTime || "",
    reservation: !!d.reservation,
  };
}

function normMenu(data) {
  const cats = data.categories || [];
  const table = data.meals || {};
  const out = [];
  for (const c of cats) {
    const items = [];
    for (const m of c.meals || []) {
      const code = m.code;
      const d = table[code] || {};
      const price = d.currentPrice;
      if (price === undefined || price === null) continue;
      items.push({
        code,
        name: d.name || m.name || "",
        currentPrice: String(price),
        originalPrice: String(d.originalPrice || price),
        image: d.image || "",
        discountType: d.discountType || "",
        tags: m.tags || d.tags || [],
      });
    }
    if (items.length) out.push({ name: c.name || "", items });
  }
  return { categories: out, itemCount: out.reduce((a, c) => a + c.items.length, 0) };
}

function normCoupons(data) {
  const rows = Array.isArray(data) ? data : (data && data.coupons) || [];
  return {
    coupons: rows.map((c) => ({
      couponId: c.couponId || c.id || "",
      couponCode: c.couponCode || c.code || "",
      title: c.title || c.name || c.couponName || "",
      products: c.products || [],
    })),
  };
}

function normQuote(data) {
  return {
    quote: {
      productPrice: data.productPrice || 0,
      deliveryPrice: data.deliveryPrice || 0,
      discount: data.discount || 0,
      price: data.price || 0,
      productList: data.productList || [],
      takeWayList: data.takeWayList || [],
    },
  };
}

function normOrder(data) {
  const d = data.orderDetail || data.order || data;
  return {
    order: {
      orderId: d.orderId || data.orderId || "",
      payH5Url: data.payH5Url || d.payH5Url || "",
      orderStatus: d.orderStatus || "",
      storeName: d.storeName || "",
      storeAddress: d.storeAddress || "",
      products: d.orderProductList || d.products || [],
      totalAmount: d.totalAmount || "0",
      pickupCode: d.pickupCode || d.takeMealCode || "",
      takeWay: d.takeWay || "",
    },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (p === "/api/health") {
        return json({ ok: true, token: !!env.MCD_MCP_TOKEN, service: "麦乐点 · 麦当劳 MCP" });
      }

      if (request.method === "POST") {
        let body = {};
        try {
          body = await request.json();
        } catch (e) {
          body = {};
        }

        if (p === "/api/quote") {
          const data = await mcpCall(env, "calculate-price", {
            storeCode: body.storeCode || "",
            orderType: Number(body.orderType || 1),
            beType: Number(body.beType || 1),
            items: body.items || [],
          });
          return json({ ok: true, ...normQuote(data) });
        }

        if (p === "/api/order") {
          const data = await mcpCall(env, "create-order", {
            storeCode: body.storeCode || "",
            orderType: Number(body.orderType || 1),
            beType: Number(body.beType || 1),
            takeWayCode: body.takeWayCode || "",
            items: body.items || [],
          });
          return json({ ok: true, ...normOrder(data) });
        }

        if (p === "/api/cancel") {
          await mcpCall(env, "cancel-order", {
            orderId: body.orderId || "",
            cancelReasonCode: Number(body.cancelReasonCode || 1),
          });
          return json({ ok: true });
        }
      }

      if (p === "/api/stores") {
        const beType = Number(url.searchParams.get("beType") || 1);
        const data = await mcpCall(env, "query-nearby-stores", {
          searchType: 2,
          beType,
          city: url.searchParams.get("city") || "北京市",
          keyword: url.searchParams.get("keyword") || "中关村",
        });
        const rows = Array.isArray(data) ? data : (data && data.data) || [];
        return json({ ok: true, stores: rows.map(normStore) });
      }

      if (p === "/api/menu") {
        const data = await mcpCall(env, "query-meals", {
          storeCode: url.searchParams.get("storeCode") || "",
          orderType: Number(url.searchParams.get("orderType") || 1),
          beType: Number(url.searchParams.get("beType") || 1),
        });
        const md = data && data.data ? data.data : data;
        return json({ ok: true, ...normMenu(md) });
      }

      if (p === "/api/coupons") {
        const data = await mcpCall(env, "query-store-coupons", {
          storeCode: url.searchParams.get("storeCode") || "",
          orderType: Number(url.searchParams.get("orderType") || 1),
          beType: Number(url.searchParams.get("beType") || 1),
        });
        const cd = data && data.data ? data.data : data;
        return json({ ok: true, ...normCoupons(cd) });
      }

      if (p === "/api/order") {
        const data = await mcpCall(env, "query-order", {
          orderId: url.searchParams.get("orderId") || "",
        });
        const od = data && data.data ? data.data : data;
        return json({ ok: true, ...normOrder(od) });
      }
    } catch (e) {
      return json({ ok: false, error: String(e && e.message ? e.message : e) });
    }

    return new Response(HTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  },
};
