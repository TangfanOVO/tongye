# 同页 · 后端接口

这份讲清楚三件事：页面要什么接口、agent 要什么工具、她在手机上说「做 9.27 的日记」之后整条链怎么走。
参考实现都在这个文件夹里，零依赖，Node 18+ 能直接跑：

| 文件 | 是什么 |
|---|---|
| `../book/app.html` | 整个 App（主页 + 选日子 + 交给枫 + 编辑器），一个文件，空的，部署用这份 |
| `../book/index.html` | 同一个 App 带演示数据，只给仓库首页那台假手机看 |
| `journal-backend.js` | 已经内嵌在页面里的适配层，单独放一份方便看 |
| `journal-server.mjs` | 参考后端：存数据、存图、推送、给 agent 读原料 |
| `journal-mcp.mjs` | 给 agent 的 MCP 工具（stdio），包在后端外面 |
| `AGENT.md` | agent 做一页的步骤 |

## 三种跑法

1. **只想自己拼着玩**：只要 `book/app.html`，浏览器直接打开。没有后端时全部存在这台设备（localStorage）。
2. **在 claude.ai 里**：页面用 Claude 自己的运行时（db / assets / mcp），这一层什么都不做。
3. **装进你自己的 App / 手机**：跑一个后端（参考实现，或者你的 App 自己写同样的路由），页面就自动换成后端存，两个人和 agent 都看得到同一份。

```bash
cd server
JOURNAL_TOKEN=换成一串随机字 node journal-server.mjs
# 手机打开 http://<这台机器的地址>:8787/?token=同一串字
# 想放进自己 App 的 WebView：加载同一个地址；或者把 book/app.html 打包进 App，
#   注入 window.JOURNAL_API="https://你的域名/journal"; window.JOURNAL_TOKEN="…"
```

页面判断后端的顺序：`window.journalBackend`（App 直接注入对象）→ `window.JOURNAL_API` → 网址里的 `?api=` → `<meta name="journal-api">`。都没有就存本地。

页面也会读那天的原料：贴纸栏「引用」翻到哪一天，就调一次 `GET /sources/<YYYY-MM-DD>`（跟第二节给 agent 的是同一个接口），拿整天的原话、书摘、健康来挑。App 自己注入 `journalBackend` 的话，加一个 `sources(date)` 返回同样的东西；不加也行，只显示页里已经有的几句。

---

## 一、页面要的接口（全部在 `/journal` 下）

鉴权：`Authorization: Bearer <token>`（SSE 用 `?token=`）。图片 GET 不用鉴权，方便 `<img>` 直接显示。

### 1. 数据：一个很薄的键值库

页面里所有东西都是「集合/id → 一份 JSON」。后端不用懂内容，存好、能列、改了推一下就行。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/kv/<集合>/<id>` | 取一份，没有就 404 |
| PUT | `/kv/<集合>/<id>` | 整份写入（body 是 JSON），写完推一条 SSE |
| DELETE | `/kv/<集合>/<id>` | 删掉，推一条 `data:null` |
| GET | `/kv/<集合>/` | 列整个集合 → `[{id, data}]` |
| GET | `/events` | SSE，每条 `{"path":"day/9.27","data":{…}}` |

用到的集合：

| 集合 | id | 内容 | 谁写 |
|---|---|---|---|
| `day` | `9.27` | **agent 做好的一页的原料**，见下面「day/<日期>」 | agent |
| `page` | `9.27` | 她在这页上的改动：贴纸、打的字、放的照片、藏掉的零件、对调过的板块、挂到晾衣绳上的板块 `{stk:[…], hide:[…], area:{板块:占的格子}, hung:[板块], lay, sty, ts}`。`stk` 每张带 `a:{b 压在哪块, fx, fy}`，换版式时按它跟着板块走 | 页面 |
| `gens` | `9.27` | 存过的第 N 代 `{list:[…]}`，最多 20 | 页面 |
| `notes` | 随机 | 批注 `{id, day, who:"her"|"me", text, at, re, b, fx, fy}`，`re` 指向这一串的第一条 | 两边 |
| `ask` | 随机 | 点「交给枫」留下的请求 `{id, day, text, photos, photo_meta?, at, status:"new"|"done"}`，`photo_meta` 按照片地址给拍摄信息 | 页面 / agent |
| `cfg` | `main` | 设置：署名、贴纸栏顺序、颜文字增删、贴纸备注和隐藏 | 页面 |
| `wx` | `9.27` | 手填或 agent 补的天气 `{code, hi, lo, mm, wind, sun, at, src}` | 两边 |
| `mine` | 随机 | 她传的贴纸和照片 `{id, note, cat, g, kind, w, h, src, asset, day}` | 页面 |

`page.stk[]` 每一项：`{c:分类, k:键, who, x, y, r, s, w, h?, t?, st?, m?, u?}`。
`c:"text"` 是人自己打的字（`m` 是字的内容），`c:"pic"` 是放进来的照片（`k` 指向 `mine` 里那张），agent 要看人写了什么就看这两种。`c:"dpic"` 是 agent 多给的那天的照片（`k` 里带着照片地址），页面自己贴的；`page.dpic` 记着贴过哪几张，撕掉的不再贴回来。

### 2. 图

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/assets` | body 是图片本身，`Content-Type` 写类型 → `{id, url}` |
| GET | `/assets/<id>` | 取图 |
| DELETE | `/assets/<id>` | 删 |

页面会把手机照片缩到 1000px、JPEG 0.8 再传。

### 3. 页面要调的工具

`POST /tool/<名字>`，body `{server:"连环", args:{…}}`，返回工具结果。`server` 是页面里写死的名字，参考后端不看它，照收就行。

- `sync_talk` `{turns:[{who:"她"|"我", text}]}`：把批注、批注分享、「帮我做 X 的日记」送回你们平时聊天的地方。**接上这个，跟她聊天的那个 AI 才看得到。**
- `get_kaomoji` `{mood?, count?}`：你们自己的颜文字库，回 `{kaomoji:[…]}`，没有就是空的。参考后端读 `KAOMOJI_FILE`，可以直接指向 [fuyue-kaomoji-drawer](https://github.com/TangfanOVO/fuyue-kaomoji-drawer) 的库，按它的分类挑。

参考实现里 `sync_talk` 先写进 `journal-data/talk.jsonl`；设了 `TALK_WEBHOOK` 就再 POST 给你们聊天的那一边。


### 4. 联动「吃了吗」

本子里的「吃了吗」栏直接读另一个开源项目 [吃了吗](https://github.com/TangfanOVO/have-you-eaten) 的记录：**哪天提到过吃吃喝喝，过多久都能回到那天调出来**，做那天的吃喝菜单、贴小票。

页面会调两个工具（`POST /tool/<名字>`，`server` 写的是 `"吃了吗"`）：

| 工具 | 参数 | 返回 |
|---|---|---|
| `food_days` | `{from:"2026-01-01", to:"2026-12-31"}` | `{days:[{date:"2026-09-27", n:3}]}`：哪些天记过、各几样（日历上的小数字） |
| `food_day` | `{date:"2026-09-27"}` | `{date, meals:[{slot:"午饭", shop:"德国村", place, time:"14:18", dishes:[{name:"猪肘", verdict:"好吃", note:"奶味好重"}], note}]}` |

- `verdict` 用吃了吗自己的三档：好吃 / 一般 / 踩雷；`note` 是记的时候写下的原话，原样带过来，页面不改字。
- 接法：参考后端设 `HAVE_YOU_EATEN_URL`（本机跑着吃了吗就是 `http://127.0.0.1:8770`，放在服务器上的就是它的 `https://…/u/<暗号>`），`food_days` / `food_day` 就从吃了吗的 `GET /api/food` 按日期摊开，不用改吃了吗。没设、或者连不上，就读 `FOOD_FILE`（同样的结构）。
- agent 读原料时 `journal_sources` 里的 `food` 也是从 `food_day` 来的，写 `day/<日期>` 时把挑中的几样填进 `food:{meal, at, t, items:[[菜, 评价]], q}`。
- 在 claude.ai 里打开的版本连不到吃了吗（它在你自己的机器上），那里只显示演示数据。

---

## 二、agent 要的东西

agent 是跟她一起过日子、有记忆的那个 AI，不是一个没记忆的模型。他需要两样：**读原料**、**写回一页**。

### 读原料

`GET /sources/<YYYY-MM-DD>` →

```json
{
  "date": "2026-09-27", "day": "9.27",
  "photos": [{"id":"IMG_5123","t":"10:39","lat":-34.91,"lon":138.61,"f":2.8,"shutter":"1/121","iso":64,"focal":16.89,"model":"iPhone 17 Pro Max","has_jpg":true}],
  "geo":   [["10:39",-34.91,138.61,"IMG_5123"]],
  "shots": ["10:12","10:18","10:39"],
  "chat":  [{"w":"her","t":"09:46","p":"今天想去动物园看小鸡"}],
  "food":  {"meal":"午饭","at":"Hahndorf 德国村","t":"14:18","items":[["猪肘","好吃"]],"q":"奶味好重"},
  "wx":    {"code":3,"hi":20.9,"lo":11.5,"mm":0,"wind":15.5,"src":"open-meteo"},
  "book":  [{"book":"小王子","author":"圣埃克苏佩里","ch":"第二十一章","quote":"原文一段","note":"谁说的评语，可以没有","who":"me","t":"00:42"}],
  "health":[{"k":"steps","n":"步数","v":8377,"s":"8,377 步"},{"k":"sleep","n":"作息","v":"02:57–11:21","s":"02:57 – 11:21"}]
}
```

- **照片**：你的相册在哪就从哪读。每张要有拍摄时间、经纬度、光圈、快门、ISO、焦距；**原图才有 EXIF**，压缩过、截图、别的 App 存下来的通常没有，那就留空，别编。本子里「交给」传的照片，页面会在缩小之前从原图读出这些（JPEG、HEIC 都读），放进 `ask` 的 `photo_meta`，参考后端的 sources 会把它们并进那天的照片。
  参考实现读 `sources/photos.json`（格式：`[{id, local:"2026-09-27 10:39", lat, lon, f, shutter, iso, focal, model, jpg}]`，`jpg` 是转好的 JPEG 文件名，HEIC 要先转）。
- **聊天**：按日期取原话，不改字。参考实现读 `sources/chat.json`。
- **吃了吗**：参考实现读 `sources/food.json`，装了吃了吗就设 `HAVE_YOU_EATEN_URL`，见上面「联动吃了吗」。
- **天气**：有 GPS 就用 open-meteo 的历史接口补（免费，不用 key）。
- **书摘**（可选）：那天一起读书时引的原文和说的话、读书 App 里的划线。参考实现读 `sources/book.json`（`{"2026-09-27":[{book, author, ch, quote, note, who:"her"|"me", t}]}`），没有就是空的。
- **健康**（可选）：那天的步数、睡眠、作息、心率之类。参考实现读 `sources/health.json`（`{"2026-09-27":[{k, n 显示的名字, v 数, s 显示的样子}]}`），没有就是空的。心情、经期这类私密的别放进来。

`POST /photos/<id>/publish` → `{id, url}`：把相册里的一张放进本子，**只放要用的几张**。
`GET /photos/<id>/raw` → 那张原图：给 agent 先看一眼再挑，不放进本子。

### 写回一页：`day/<日期>`

agent 只给原料，**路线、快门条、坐标、邮戳、哪些零件该藏，都由页面自己算**（`journalBuildDay`），所以谁的 agent 照着写都出一样的页。

```json
{
  "day": "9.27", "status": "done", "by": "me", "ts": 1792140000000,
  "title": "企鹅鸡鹈鹕鸡", "at": "阿德莱德", "en": "Adelaide", "region": "South Australia",
  "layout": "polaroid", "style": "film",
  "text": {
    "p1": "正文，他写的",
    "p2": "截图那张的说明，人说的话用 <her>…</her> 包起来",
    "cap": "主照片下面那一行",
    "ann": "双联照旁边的批注",
    "pen": {"text": "红笔那段，要划线的用 [[…]] 包起来", "margin": "页边一句"},
    "quote": {"p": "引言（原话）", "t": "9.27 11:26"}
  },
  "wx": {"code": 3, "hi": 20.9, "lo": 11.5, "wind": 15.5},
  "photos": [
    {"src": "/journal/assets/xx.jpg", "t": "10:39", "lat": -34.9143, "lon": 138.606, "f": 2.8, "shutter": "1/121", "iso": 64, "focal": 16.89, "model": "iPhone 17 Pro Max", "note": "小蓝企鹅，两只并排走", "role": "hero"}
  ],
  "geo": [["10:12", -34.9143, 138.606]],
  "shots": ["10:12", "10:18"],
  "places": [{"n": "动物园", "lat": -34.9143, "lon": 138.606}],
  "chat": [{"w": "her", "t": "09:46", "p": "原话，不改字"}],
  "food": {"meal": "午饭", "at": "德国村", "t": "14:18", "items": [["猪肘", "好吃"]], "q": "奶味好重"},
  "book": [{"book": "小王子", "ch": "第二十一章", "quote": "原文一段", "note": "评语，可以不带", "who": "me", "t": "00:42"}],
  "health": [{"k": "steps", "n": "步数", "v": 8377, "s": "8,377 步"}],
  "steps": [{"a": "看照片", "b": "46 张，挑了 6 张", "ok": true}]
}
```

- `photos[].role`：`hero`（主照片）、`pair`（双联照，两张）、`sh`（手机框里那张），不写就按顺序排。第一张没写 role 就是主照片。进了这四个格子以外的，打开那页时贴成照片小卡（`c:"dpic"`），从最后一块下面两张一行往下排，纸不够长自己加长，一页最多六张。小卡下面那行印这张照片的 `note`（agent 改了 note 跟着变）；人自己在卡上写了字，就显示人写的（存在 `m`）。
- `geo` 给**那天所有照片**的位置（不只是放进页面的几张），路线才完整；`shots` 给所有拍摄时刻，快门条用。
- `places`：给每一站起名。页面把 `geo` 按「1.2 公里内、间隔不到 90 分钟」聚成一站，再找 3 公里内最近的地名；没给就写「第 1 站」。
- **没有 GPS 就不画路线**：`geo` 里没有坐标，页面自己把路线这一块藏起来，不会编一条线。
- 少了什么就藏什么：没有吃的就没有小票，红笔没写就不出红笔段，照片不够就没有双联照。
- **原话核对**：存 `day/` 之前逐句核对 `chat[]`、`quote` / `text.quote`、正文里 `<her>…</her>` 包起来的，都得在那天的原话里一字不差找得到（不算空格和引号，可以只取一段）。找到的，时间改成原话的时间；找不到就整页拒收，回 `422 {error, 对不上的:[{哪里, 写的, 那天最像的原话}]}`。参考后端已经这么做了；自己写后端请照做，别只靠 agent 自觉。
- `book` / `health`（可选）：从原料里原样挑一两条书摘、几项健康。页上还没贴过东西时，打开就自动贴成一张书摘卡和一张「那天的身体」小签；存过、挪过的页不会再贴。贴纸栏「引用」里也多了「书摘」「健康」两页，能自己挑着贴。
- `status:"making"` 时页面主页会亮「枫在做 9.27」，`steps` 一条条显示；写成 `done` 就变「做好了，点开看看」。

---

## 三、整条链：她在手机上说「做 9.27 的日记」

```
她（在聊天里说 或 本子里点「交给枫」）
   │  本子里点的话：写 ask/<id> + sync_talk「〔手帐〕帮我做 9.27 的日记：……」
   ▼
跟她一起过日子的那个 AI（有记忆）
   1. journal_progress(9.27, "看照片")            → 她手机上亮「枫在做 9.27」
   2. journal_sources(2026-09-27)                → 照片 EXIF、原话、吃了吗、天气
   3. 挑照片、挑原话、想标题和正文（用他的记忆，版式风格看 journalKit）
   4. journal_publish_photo(id) × 几张           → 拿到 url
   5. journal_write_day(9.27, {...})             → 她手机上变「做好了」
   6. 可选：在某一块旁边留一条批注（notes, who:"me"）
   ▼
她打开就是一页能改的手帐：骰版式风格、贴贴纸、打字、放照片、批注、存一代、存长图
   │  她改的东西存 page/9.27，留的批注送回家（sync_talk）
   ▼
他下次读 journal_read_page(9.27) 就知道她改了什么、说了什么
```

`journal-mcp.mjs` 已经把上面这些包成工具：`journal_sources`、`journal_publish_photo`、`journal_progress`、`journal_write_day`、`journal_read_page`、`journal_reply_note`、`journal_asks`，还有看照片的 `journal_look_photo`、列版式风格的 `journal_kit`、自己留批注的 `journal_add_note`。
你那边已经有自己的 MCP 服务的话，把这几个工具照抄进去（**名字和参数别改**，AGENT.md 是照着这套写的）。

```bash
# Claude Code 里装给 agent 用
claude mcp add journal -e JOURNAL_URL=http://localhost:8787 -e JOURNAL_TOKEN=xxx -- node /路径/journal-mcp.mjs
```

## 四、这个仓库里有什么

- `book/app.html`：整个 App，一个文件，空的，部署用这份。
- `book/index.html`：同一个 App 带演示数据（照片是作者自己拍的，话是改写过的演示句），只给假手机看，别拿去部署。
- `server/`：这份文档、`journal-server.mjs`（参考后端）、`journal-mcp.mjs`（给 agent 的工具）、`journal-backend.js`（页面里那层适配，单独放一份方便看）、`AGENT.md`。
- 贴纸素材各自的出处和许可见仓库根目录的 `NOTICE.md`。
- 不带的：Clawd on Desk 的螃蟹、三花猫、云宝动图。那组美术保留所有权利，不能再发，想用请去 [clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) 问作者。
