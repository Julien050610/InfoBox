# Personal InfoBox 后端

本地知识收件箱。把 PDF、图片或网址放入收件箱，手动启动一次处理；本次任务全部完成后程序自动退出。处理过程会提取内容、生成摘要与标签、分类命名，并保存到本地知识库。视频只使用标题和简介；不会转写或声称分析了完整视频。手写内容识别不可靠时会进入 `needs-review/`。

## 启动

需要 Node.js 24 或更新版本。

```powershell
npm install
Copy-Item .env.example .env
```

编辑 `.env`，填入 `DEEPSEEK_API_KEY`。默认由 `deepseek-flash` 处理文字和图片。如果把 `DEEPSEEK_MODEL` 改为只处理文字的模型，图片仍由 `DEEPSEEK_VISION_MODEL=deepseek-flash` 处理。也可将 `AI_PROVIDER` 改为 `openai` 并设置 `OPENAI_API_KEY`，保留原来的提供方。密钥只放在本机 `.env`，不要提交到版本库。

Jev 是可选决策层。配置 `JEV_API_KEY` 后，它会从现有分类和生成模型提出的候选标签中作判断，并给出概率；后端按置信度决定直接入库还是送待检查。Jev 不生成摘要，也不执行文件操作。未配置 Jev 时，DeepSeek 会看到当前文件夹路径和既有标签词汇，优先复用最具体的合适分类和同义标签，再把分类与标签建议用于入库流程。

日常使用：先把文件放进 `inbox/`，把网址写入 `.url` 文件，再双击项目根目录的 `InfoBox-运行一次.cmd`。处理结束后，程序和窗口自动退出；结果保存在 `data/last-run.txt`。下次有新资料，再双击一次。也可在终端运行 `npm run run:once`。

浏览知识库：双击项目根目录的 `InfoBox-打开工作台.cmd`，浏览器会打开本地工作台。左侧目录树把 Library 显示为可操作的零级根文件夹，所有一级分类都是它的直接子文件夹。Library 和普通文件夹一样可以单击进入、折叠或展开；整栏也可收起。鼠标移到任意文件夹上时，其右侧会出现 `＋`，点击后才在该位置展开新建子文件夹输入框；目录树平时不显示重复的创建行。人工目录允许任意深度。单击 Library 或某个文件夹后，中间先列出该位置的直接子文件夹和文件，文件夹排在前面。单击文件才会展开下方预览，并可继续开启阅读模式。

顶部的“重构”和“回退”放在同一组。点击“重构”后，左侧文件树会高亮并显示选择提示，零级 Library 和它下面的每个文件夹都会出现复选框；可同时选择多个分支，选中 Library 即重构整个知识库，选中其他父文件夹则包含它的全部后代。再次点击“执行重构”会直接让 Agent 重新分类。每次重构或文件夹移动前都会保存轻量结构快照，只记录目录、资料位置和筛选视图，不复制原件；“回退”可恢复当时已有资料的位置，而快照之后新增的资料保持在当前位置。资料关系使用资料 ID 保存，因此文件夹移动、重构和回退都不会断开关联，知识图谱也会自动刷新。

文件和文件夹的“移动”按钮位于中间列表的对应卡片上。目标选择器只显示文件夹，并可逐级悬停展开；任意层级都能直接作为目的地。右侧“编辑资料”用于修改标题、摘要和标签、人工评分及删除，不再重复提供所在文件夹选项。文件可拖入左侧收件箱暂存，只有点击“执行收件箱分类”后才会调用模型、分类并归档。“待检查”入口集中显示需要复查的资料，可填写校正正文、重新分析或直接批准入库。开启阅读模式后，资料列表会收起，右侧变成便签栏。点击“新建便签”后再点击 PDF 或正文位置，即可创建与文章位置相连的本地便签。

工作台支持标题、摘要、标签和正文全文检索；“筛选”面板可组合文件类型、多个标签（全部/任一）、入库状态、阅读状态、收藏、最低评分、发表日期、收件日期和排序方式，并可把当前搜索范围与筛选条件保存为左栏的“筛选视图”。筛选视图只是一个可重复使用的查询入口，不会复制或移动资料。右栏可切换收藏和未读/阅读中/已读状态，也能建立“相关、引用、支持、反驳、后续研究”关系。

“知识图谱”是工作台主页，采用从左到右的固定分层排列，按知识库文件夹绘制实线层级。一级文件夹使用不同分支颜色，其下的次级文件夹、文件节点和结构线继承相同颜色；颜色数量用尽后可以循环使用。人工关联使用强调线，跨文件夹且拥有相同标签的资料使用虚线连接。文件节点默认只显示标题前几个字，鼠标悬停后显示较长标题。图谱支持滚轮或按钮缩放、拖动画布平移。单击节点会保留该节点及其所有次级节点，并灰化其他内容；单击总节点恢复完整图谱。双击总节点进入 Library 列表，双击文件夹节点进入对应文件夹的资料列表；单击文件节点会在右栏显示资料，双击文件节点进入文件阅读界面。右栏普通资料页只展示已经建立的关联；进入“编辑资料”后，可用紧凑的级联菜单按一级分类、次级分类、具体资料查找目标。顶部前进和后退按钮记录图谱聚焦、资料列表和文件阅读页面，后退的最早位置固定为知识图谱主页。关闭启动窗口即可停止工作台。

首次运行会创建：

```text
inbox/          待处理文件；也可手动放入 .url 文本文件
library/        已入库的原件、摘要 .md、元数据 .json、提取文本 .txt
needs-review/   需要人工检查的内容与原因
data/jobs/      后台任务状态
data/notes/     阅读便签
data/saved-views.json  保存的筛选视图
data/relations.json   人工建立的资料关系
data/folders.json     手动创建并需要保留的空文件夹
data/restructure-history.json  最近的目录调整与撤销状态
```

链接可保存为 `.url` 文件，内容为单行网址，或 Windows 快捷方式格式 `URL=https://...`。一次性运行只处理启动时收件箱里已有的资料；处理过程中新增的文件留到下次运行。

也可在终端运行 `npm run workbench` 启动工作台；默认监听 `http://127.0.0.1:3000`。双击启动器时，如果旧版工作台仍占用 3000 端口，新版会自动选择下一个空闲端口并打开正确页面。

## 接口

以下接口仅在工作台运行时可用。文件上传加 `defer=1` 时只暂存；调用分类接口后返回后台任务，可用任务接口查询结果。上传文件的请求体是文件原始字节，不是 multipart 表单。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/health` | 服务状态 |
| `POST` | `/api/inbox/urls` | 接收 `{"url":"https://..."}` |
| `GET` | `/api/inbox` | 查看当前待分类文件 |
| `POST` | `/api/inbox/files?defer=1&filename=paper.pdf` | 暂存 PDF、图片、URL 或 WEBLOC，最大 32 MB |
| `DELETE` | `/api/inbox/files?filename=paper.pdf` | 删除一个尚未开始分类的收件箱文件 |
| `POST` | `/api/inbox/process` | 开始分类当前收件箱中的全部支持文件 |
| `GET` | `/api/jobs/{id}` | 查询任务状态 |
| `GET` | `/api/items` | 列出知识库与待检查内容；可加 `?status=review` |
| `GET` | `/api/items/{id}` | 查看一条内容 |
| `DELETE` | `/api/items/{id}` | 永久删除资料、原件、摘要、正文缓存和便签 |
| `GET` | `/api/library/tree` | 获取 Library 分类树与资料数量 |
| `POST` | `/api/library/folders` | 在任意层级创建文件夹，提交 `name` 和可选 `parent` |
| `PATCH` | `/api/library/folders` | 更名或移动任意层级文件夹，提交 `source`、`name` 和可选 `parent` |
| `POST` | `/api/restructure/run` | 直接重构所选目录，提交 `scopes` 数组；空字符串表示整个 Library |
| `POST` | `/api/restructure/preview` | 兼容接口：生成一个目录调整草案 |
| `POST` | `/api/restructure/apply` | 兼容接口：应用目录调整草案 |
| `GET` | `/api/restructure/history` | 获取最近的结构调整记录 |
| `POST` | `/api/restructure/{id}/undo` | 撤销一次仍可安全回退的结构调整 |
| `GET` | `/api/search?q=关键词` | 搜索标题、摘要、分类、标签与提取正文 |
| `GET/POST` | `/api/views` | 读取或保存筛选视图 |
| `DELETE` | `/api/views/{id}` | 删除筛选视图 |
| `GET/POST` | `/api/relations` | 读取或建立资料关系 |
| `DELETE` | `/api/relations/{id}` | 删除资料关系 |
| `GET` | `/api/items/{id}/asset` | 预览原始文件 |
| `GET` | `/api/items/{id}/markdown` | 获取知识笔记 Markdown |
| `GET` | `/api/items/{id}/text` | 获取提取后的正文 |
| `GET` | `/api/items/{id}/notes` | 获取资料的锚定便签 |
| `POST` | `/api/items/{id}/notes` | 在文章位置新建便签 |
| `PATCH` | `/api/items/{id}/notes/{noteId}` | 保存便签内容 |
| `DELETE` | `/api/items/{id}/notes/{noteId}` | 删除便签 |
| `PATCH` | `/api/items/{id}` | 修改标题、人工质量分、摘要、标签、分类位置、收藏和阅读状态；分类位置由列表中的移动操作调用；待检查项还可修改发表日期和校正文本 |
| `POST` | `/api/items/{id}/reanalyze` | 用 `corrected_text` 重新分析待检查项；判断通过后入库 |
| `POST` | `/api/items/{id}/approve` | 人工确认待检查项并入库，需已有摘要 |

例如提交链接：

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/inbox/urls' -ContentType 'application/json' -Body '{"url":"https://example.com/article"}'
```

例如上传文件：

```powershell
curl.exe -X POST 'http://127.0.0.1:3000/api/inbox/files?defer=1&filename=paper.pdf' -H 'Content-Type: application/octet-stream' --data-binary '@D:\Documents\paper.pdf'
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/inbox/process'
```

## 内部正文提取

系统仍会从资料中读取正文，供模型生成摘要和分类，但工作台不再提供单独的“提取文本”阅读标签。PDF 取文字层，网页取清理后的正文，图片保存模型识别到的可见文字；视频只使用标题和简介，不转写音频。

人工评分与手写校正分别提交：

```json
{"quality_score":4}
```

```json
{"corrected_text":"这里填写校正后的笔记正文。"}
```

校正后调用 `/api/items/{id}/reanalyze`。如果还需要自己修改摘要、标题或标签，可先 `PATCH`，再调用 `/api/items/{id}/approve`。

## 入库规则

- Library 固定为零级根文件夹，不写入资料的分类路径。自动分类优先在 Library 下保持 2–4 层，例如 `Computer Science/AI/Agent/Harness/`；必要时可以复用更深或更浅的现有目录。人工创建和移动目录不限制为 2–4 层。
- 文件名前缀优先使用明确的发表年月，否则使用收件年月。未知发表日期保持为空。
- 每条资料保留原件（网页为 HTML 快照，视频为 `.url`）、人可读摘要 `.md` 和结构化元数据 `.json`。
- `quality_score` 默认为 `null`，只由人工填写。
- 扫描版 PDF 暂无自动 OCR，会进入待检查。网页若无法获取足够正文也会进入待检查。
- DeepSeek 负责图片识别、摘要、标题、候选分类和候选标签；Jev 仅判断分类、候选标签和资料是否充分。Jev 置信度低的内容进入待检查。
- 模型调用会把必要的正文片段或图片发送到已配置的服务；知识库文件保存在本地。

## Jev 如何接入

1. 在 TypeSafe 获取 Jev API 密钥，写入 `.env` 的 `JEV_API_KEY`。
2. 后端把资料类型、标题、摘录、摘要和候选项发送到 Jev 的 System One API。
3. Jev 对主分类作 `Choice` 判断，对每个候选标签及资料是否充分作 `Noul` 判断。
4. 后端读取结果和置信度。分类置信度低于当前阈值 `0.65`、没有合适分类，或资料不足时，内容进入 `needs-review/`。

Jev 是独立服务，使用它会把上述必要片段发送到 TypeSafe。当前阈值是首版保守设置，之后应根据实际资料和人工纠错结果调整。

## 验证

```powershell
npm test
```

测试使用模拟模型响应，不调用付费 API。首次实际处理前请确认 `.env` 中的密钥有效。
