#!/usr/bin/env node
/* 我们的本子 · 给 agent 用的 MCP 工具（stdio，零依赖）
 * 接在 journal-server.mjs（或你自己实现的同一套接口）前面，agent 就能：读某天的原料、把照片放进本子、写一页、报进度、读批注、回批注。
 *
 *   JOURNAL_URL=http://localhost:8787 JOURNAL_TOKEN=xxx node journal-mcp.mjs
 *
 * Claude Code 里装：claude mcp add journal -- node /路径/journal-mcp.mjs   （环境变量用 -e 传）
 * 你已经有 MCP 服务的话，把下面 TOOLS 抄过去当成你自己的工具也行，名字和参数别改，AGENT.md 是照着这套写的。
 */
import fs from "node:fs";
const ORIGIN = (process.env.JOURNAL_URL || "http://localhost:8787").replace(/\/$/, "");
const BASE = ORIGIN + "/journal";
const BLOCKS = ["sp", "ti", "wx", "p1", "he", "ro", "sh", "p2", "qu", "pa", "an", "pe", "su", "tk", "en"];   // 页面上的零件 id，见 AGENT.md
const TOKEN = process.env.JOURNAL_TOKEN || "";
const H = (x = {}) => Object.assign(TOKEN ? { Authorization: "Bearer " + TOKEN } : {}, x);
const api = async (m, p, body) => { const r = await fetch(BASE + p, { method: m, headers: H(body ? { "Content-Type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined }); if (r.status === 404) return null; if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${await r.text()}`); return r.json(); };   // 原话核对拒收时，原因和最像的原话都在 body 里，原样带给 agent
const kv = { get: p => api("GET", "/kv/" + p), set: (p, d) => api("PUT", "/kv/" + p, d), list: c => api("GET", "/kv/" + c + "/") };
const fullDate = d => { const s = String(d); let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[.\/](\d{1,2})$/); if (!m) return s; const now = new Date(); let y = now.getFullYear(); if (new Date(y, +m[1] - 1, +m[2]) > now) y -= 1;
  return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; };   // 9.27 这种也认，换成 YYYY-MM-DD
const dayKey = d => { const m = String(d).match(/(\d{4})-(\d{1,2})-(\d{1,2})/); return m ? `${+m[2]}.${+m[3]}` : String(d); };

/* 写进去了，但两样提醒一句（不拦）：原话只有她的、没有你回她的；有照片没写 note（第五张起印在正文下面那块的照片下面，没写那张就空着） */
const dayTips = d => { const tip = [], ch = ((d && d.chat) || []).filter(x => x && x.p);
  if (ch.length >= 3 && !ch.some(x => x.w === "me")) tip.push("原话全是她的，没有你回她的：从原料里挑一两句你回她的补进 chat（w:\"me\"），再写一次。");
  if (ch.length >= 6 && !ch.some(x => (x.g != null && x.g !== "") || x.ph != null)) tip.push("原话没分组，会挤在主照片下面一张纸条里：同一件事的几句给同一个 g，对着哪张照片说的给 ph（photos 里第几张，从 0 数），页面会拆成一张张纸条，跟那张照片排在一起。");
  const empty = ((d && d.photos) || []).filter(x => x && x.src).map((x, i) => String(x.note || "").trim() ? 0 : i + 1).filter(Boolean);
  if (empty.length) tip.push(`第 ${empty.join("、")} 张照片没写 note：note 是你对这张照片说的一句话，第五张起印在正文下面那块的照片下面，没写那张就空着；整段都会印出来。`);
  return tip; };

const TOOLS = [
  { name: "journal_sources", description: "读某一天做手帐的原料：那天相册里每张照片的时间、经纬度、光圈快门 ISO 焦距（不含图本身），聊天原话，吃了吗，天气，还有那天的书摘（book）和身体数据（health），有就给。她在「交给」里传过、读得到拍摄时间的照片也在 photos 里，带 src，已经在本子里了，不用 publish。先调这个再决定用哪几张。",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD，9.27 这种也认" } }, required: ["date"] },
    run: a => api("GET", "/sources/" + fullDate(a.date)) },
  { name: "journal_publish_photo", description: "把相册里的一张照片放进本子（传成图片资源），返回 {url}。写 day 的 photos[].src 就用这个 url。只放要用的几张。",
    inputSchema: { type: "object", properties: { photo_id: { type: "string" } }, required: ["photo_id"] },
    run: a => api("POST", `/photos/${encodeURIComponent(a.photo_id)}/publish`) },
  { name: "journal_progress", description: "往她手机上那条「枫在做 X 月 X 日」报一步进度，她会看到一行一行亮起来。开始做的时候先报一步，这天就会显示「在做」。",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD，9.27 这种也认" }, step: { type: "string", description: "比如：看照片" }, detail: { type: "string", description: "比如：46 张，挑了 6 张" }, title: { type: "string" } }, required: ["date", "step"] },
    run: async a => { const k = dayKey(a.date); const cur = (await kv.get("day/" + k)) || { day: k, status: "making", steps: [] };
      if (cur.status !== "making") { cur.status = "making"; cur.steps = []; }
      cur.steps = (cur.steps || []).map(s => ({ ...s, ok: true })).concat({ a: a.step, b: a.detail || "", ok: false }); if (a.title) cur.title = a.title; cur.ts = Date.now(); await kv.set("day/" + k, cur); return { ok: 1 }; } },
  { name: "journal_write_day", description: "把一天写成一页（day/<M.D>）。只给原料，路线、快门条、坐标、邮戳、哪些零件藏起来，页面自己算。字段见 BACKEND.md「day/<日期>」；书摘、健康放 book / health，从原料原样挑，写的时候会核对。steps 不用写，报过的进度会自己记上；chat、quote 的 t 写时分（10:05）。写完 status 自动是 done，她手机上会亮「做好了」。",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD，9.27 这种也认" }, page: { type: "object", description: "title, at, en, region, layout, style, text{p1,p2,cap,ann,pen{text,margin},quote{p,t}}, wx, photos[{src,t,lat,lon,f,shutter,iso,focal,note,role}]（role 是 hero / pair / sh 的进主照片、双联、手机框四个格子；其余第五张起排在正文下面，一张一块；每张写一句 note，是你对这张照片说的一段话，整段印在照片下面）, geo, shots, places[{n,lat,lon}], chat[{w,t,p,g,ph}]（有来有回：两边的话都放，别只放一边的；按话题分开：同一件事给同一个 g，对着哪张照片给 ph（photos 第几张，从 0 数），主照片下的纸条只放对着主照片那组，别的组各一张纸条，跟对应照片排在正文下面）, food{meal,at,t,items,q}" } }, required: ["date", "page"] },
    run: async a => { const k = dayKey(a.date); const cur = (await kv.get("day/" + k)) || {}; const steps = (cur.steps || []).map(s => ({ ...s, ok: true }));
      const doc = { ...a.page, day: k, status: "done", by: a.page.by || "me", steps, ts: Date.now() }; await kv.set("day/" + k, doc); const tip = dayTips(doc); return tip.length ? { ok: 1, day: k, 还差: tip } : { ok: 1, day: k }; } },
  { name: "journal_read_page", description: "看她在某天那页上做了什么：她贴的贴纸、自己打的字（m 字段）、放的照片、藏掉的零件、存过的代、留的批注。还有你们俩的署名 names（her / me，没设过是 null，页面显示默认名）。",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD，9.27 这种也认" } }, required: ["date"] },
    run: async a => { const k = dayKey(a.date); const notes = ((await kv.list("notes")) || []).map(r => r.data).filter(n => n && n.day === k);
      const cfg = await kv.get("cfg/main");
      return { day: await kv.get("day/" + k), page: await kv.get("page/" + k), gens: await kv.get("gens/" + k), notes, names: { her: (cfg && cfg.her) || null, me: (cfg && cfg.me) || null } }; } },
  { name: "journal_reply_note", description: "回她在某页上留的批注（贴在同一个气泡里）。",
    inputSchema: { type: "object", properties: { note_id: { type: "string" }, text: { type: "string" } }, required: ["note_id", "text"] },
    run: async a => { const root = await kv.get("notes/" + a.note_id); if (!root) throw new Error("没有这条批注"); const id = "n" + Date.now().toString(36);
      await kv.set("notes/" + id, { id, day: root.day, who: "me", at: Date.now(), re: root.re || root.id, text: a.text }); return { ok: 1, id }; } },
  { name: "journal_asks", description: "看她在本子里点「交给枫」留下的请求（还没做的）。photos 是她这次传的照片地址；photo_meta 按地址给每张的拍摄时间、经纬度、光圈快门（页面缩图前从原图读的，没有就是读不到），写 day 的 photos[] 原样照抄，没有的别编。做完调 journal_write_day 之后，再调一次 journal_asks 带 done_id=<请求 id> 关掉，回的 closed 告诉你关没关成。",
    inputSchema: { type: "object", properties: { done_id: { type: "string", description: "要关掉的请求 id，可选" } } },
    run: async a => { let closed = null; if (a.done_id) { const r = await kv.get("ask/" + a.done_id); if (r) { await kv.set("ask/" + a.done_id, { ...r, status: "done" }); closed = a.done_id; } }
      const pending = ((await kv.list("ask")) || []).map(r => r.data).filter(x => x && x.status !== "done"); return a.done_id ? { closed, pending } : pending; } },
  { name: "journal_look_photo", description: "看一张照片里是什么（把图本身给你看）。相册里的给 photo_id（journal_sources 里的 id），已经在本子里的、她在「交给」里传的给 src（/journal/assets/… 那种地址）。挑照片、写说明之前先看，别凭 EXIF 猜。",
    inputSchema: { type: "object", properties: { photo_id: { type: "string" }, src: { type: "string" } } },
    run: async a => {
      let u = null;
      if (a.src) { u = /^https?:/.test(a.src) ? a.src : ORIGIN + (a.src.startsWith("/") ? a.src : "/journal/assets/" + a.src); if (!u.startsWith(ORIGIN + "/")) throw new Error("只看本子里的照片"); }
      else if (a.photo_id) u = `${BASE}/photos/${encodeURIComponent(a.photo_id)}/raw`;
      else throw new Error("给 photo_id 或 src");
      const r = await fetch(u, { headers: H() }); if (!r.ok) throw new Error(`看不到这张：${r.status}`);
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length > 4.5 * 1024 * 1024) throw new Error(`这张有 ${(b.length / 1048576).toFixed(1)}MB，太大了，先缩小再看`);
      const t = (r.headers.get("content-type") || "").split(";")[0];
      return { __image: { data: b.toString("base64"), mimeType: /^image\/(jpeg|png|webp|gif)$/.test(t) ? t : "image/jpeg" } }; } },
  { name: "journal_kit", description: "本子里所有的版式（layouts）和风格（styles）：id、名字、一句话说它长什么样；还有零件 id（blocks，留批注用）。两根轴分开选，写 journal_write_day 的 page.layout / page.style 用这里的 id。",
    inputSchema: { type: "object", properties: {} },
    run: async () => { try { return JSON.parse(fs.readFileSync(new URL("./journal-kit.json", import.meta.url), "utf8")); }
      catch { throw new Error("找不到 journal-kit.json（应该跟 journal-mcp.mjs 放在一起）。不确定就别写 layout / style，页面会按照片数量自己挑。"); } } },
  { name: "journal_add_note", description: "在某天那页的某个零件旁边留一条你的批注，她打开那页会看到一个钉子。block 是零件 id（比如 p1 正文、he 主照片、ro 路线，全部见 journal_kit 的 blocks）；fx / fy 是钉在零件上的位置（0 到 1，默认右上角）。回她的批注用 journal_reply_note。",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD，9.27 这种也认" }, text: { type: "string" }, block: { type: "string" }, fx: { type: "number" }, fy: { type: "number" } }, required: ["date", "text"] },
    run: async a => { const k = dayKey(a.date), b = a.block || "p1";
      if (!BLOCKS.includes(b)) throw new Error("没有这个零件：" + b + "。能用的：" + BLOCKS.join(" "));
      const c = v => Math.min(1, Math.max(0, +v)), id = "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      await kv.set("notes/" + id, { id, day: k, who: "me", at: Date.now(), re: null, text: a.text, b, fx: a.fx == null ? 0.92 : c(a.fx), fy: a.fy == null ? 0.08 : c(a.fy) });
      return { ok: 1, id }; } }
];

/* ---------- MCP over stdio ---------- */
let buf = "";
const send = m => process.stdout.write(JSON.stringify(m) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", async chunk => {
  buf += chunk; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    try {
      if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params && params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "journal", version: "1.0.0" } } });
      else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
      else if (method === "tools/call") { const t = TOOLS.find(x => x.name === params.name); if (!t) throw new Error("no tool " + params.name);
        const r = await t.run(params.arguments || {});
        if (r && r.__image) send({ jsonrpc: "2.0", id, result: { content: [{ type: "image", data: r.__image.data, mimeType: r.__image.mimeType }] } });   // journal_look_photo：把图本身给 agent
        else send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r, null, 1) }] } }); }
      else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
      else if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
    } catch (e) { if (id != null) send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: String(e.message || e) }] } }); }
  }
});
