# Personal InfoBox 后端

> 当前版本：**v0.1.2**。本版本聚焦架构与可靠性：核心工作流保持不变，补充了安全写入、稳定错误响应、本地请求保护和关键回归测试。仍建议保留资料备份并反馈异常情况。

本地知识收件箱。把 PDF、图片、文字文档、音频、ZIP 压缩包或网址放入收件箱，手动启动一次处理；本次任务全部完成后程序自动退出。处理过程会提取内容、生成摘要与标签、分类命名，并保存到本地知识库。视频只使用标题和简介；不会转写或声称分析了完整视频。音频只读取元数据并进入待检查，不会自动转写或调用模型。手写内容识别不可靠时也会进入 `needs-review/`。

测试版已知限制：部分代理、VPN 或 Fake IP DNS 模式会把公网域名解析为虚拟内网地址，当前网址安全检查会将这类结果视为本地网络并拒绝抓取。此限制用于避免网页跳转访问路由器、NAS 或本机服务，后续版本会补充兼容代理 DNS 的安全处理。

v0.1.2 会在抓取时固定已经校验过的公网 DNS 地址，并在每次跳转后重新校验目标，降低 DNS 重绑定访问本地网络的风险。JSON、Markdown 和正文缓存改为同目录临时文件加可恢复备份的安全替换；程序启动时会恢复中断的替换操作。JSON/TXT 原件使用 `.source.json` / `.source.txt` 后缀，与系统元数据和正文缓存分开保存。

当前开发版开始引入 Obsidian 兼容的 Markdown Vault。直接在具体文件夹新建、且没有绑定原资料的普通笔记，以 `vault/notes/<stable-id>.md` 作为唯一真源；图片位于 `vault/attachments/<stable-id>/` 并使用相对路径。IB 保存前会检查文件修订值，检测到 Obsidian 等外部程序已修改时返回冲突并要求重新载入，不会静默覆盖。临时笔记、绑定笔记和已有 JSON 笔记暂时保持兼容读取。完整字段与迁移规则见 [`docs/MARKDOWN_VAULT.md`](docs/MARKDOWN_VAULT.md)。

笔记工作区使用本地打包的 CodeMirror 6 编辑器，支持 Markdown/GFM、YAML frontmatter、撤销重做、查找替换、标题大纲和常用格式快捷键。工具栏可以插入标题、粗体、斜体、链接、任务列表、表格、代码块和数学公式；右侧预览支持 GFM 表格、任务列表及 KaTeX 公式。编辑器和公式资源随项目本地提供，不需要连接 CDN。修改编辑器源码后可运行 `npm run build:editor` 重新生成浏览器包。

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

顶部的“重构”和“回退”放在同一组。点击“重构”后，左侧文件树会高亮并显示选择提示，零级 Library 和它下面的每个文件夹都会出现复选框；可同时选择多个分支，选中 Library 即重构整个知识库，选中其他父文件夹则包含它的全部后代。再次点击“执行重构”后，Agent 会为所选分支中的每一项资料重新规划目录，资料可以进入 Library 中任意合适的新旧分类；只有全部决策完成后才统一移动，并清理所选旧目录树。标题、摘要、标签、评分、笔记和资料关联保持不变。每次重构或文件夹移动前都会保存轻量结构快照，只记录目录、资料位置和筛选视图，不复制原件；“回退”可恢复当时已有资料的位置，而快照之后新增的资料保持在当前位置。资料关系使用资料 ID 保存，因此文件夹移动、重构和回退都不会断开关联，知识图谱也会自动刷新。

文件和文件夹的“移动”按钮位于中间列表的对应卡片上。目标选择器只显示文件夹，并可逐级悬停展开；任意层级都能直接作为目的地。Library 根文件夹的“＋”菜单可选择新建文件夹或导入网址；网址支持每行一个批量粘贴，加入后先保留在收件箱，只有点击“执行收件箱分类”才会抓取和调用模型。视频只根据可访问的标题和简介生成资料，文章提取正文，无法可靠抓取或分类的内容进入待检查。右侧“编辑资料”用于修改标题、摘要和标签、人工评分及删除，不再重复提供所在文件夹选项。文件可拖入左侧收件箱暂存，只有点击“执行收件箱分类”后才会调用模型、分类并归档。“待检查”入口集中显示需要复查的资料，可填写校正正文、重新分析或直接批准入库。开启阅读模式后，资料列表会收起，右侧变成阅读工具栏。点击“新建便签”后再点击 PDF 或正文位置，即可创建与文章位置相连的本地便签；打开“书签”菜单可把当前阅读位置命名保存，之后点击书签即可返回对应 PDF 页或正文位置。

左侧“临时笔记”是独立草稿区。Library 根目录新建的普通笔记先进入这里，只有点击“送入收件箱”后才参与 Agent 分类；空白笔记不会提交。任意具体文件夹右侧的笔形按钮可直接在该文件夹中新建笔记，跳过分类。笔记支持 Markdown 实时预览和直接粘贴图片，图片保存在笔记自己的本地资料包中；可导出包含 `.md` 与图片的 ZIP 资料包，或打开打印版并使用浏览器保存为 PDF。

阅读模式中的“笔记”按钮在悬停或点击后展开笔记栏，列出当前资料已有的所属笔记，并提供预览、编辑和新建入口。完整笔记不记录阅读页码或滚动位置；新建时通过明确的“属于”关系与当前资料双向连接，并保存在同一文件夹。进入编辑后，左侧直接复用当前阅读器并保留现有页码和滚动位置，右侧编辑笔记；“预览笔记”会暂时把左栏切换为渲染结果，返回原资料时位置不变。PDF 会持久记录页码与页内位置，其他正文记录滚动比例和当前视图。临时笔记和普通文件夹笔记使用“左侧编辑、右侧预览”的双栏布局。所属笔记随主资料移动和重构；删除主资料时解除归属，笔记回到收件箱。阅读便签仍可锚定文章位置并通过“转为笔记”升级为完整笔记。

工作台支持标题、摘要、标签和正文全文检索；“筛选”面板可先通过与移动操作一致的级联目录选择器选择 Library 或任意文件夹，再组合文件类型、多个标签（全部/任一）、入库状态、阅读状态、收藏、最低评分、发表日期、收件日期和排序方式。应用条件后主标题显示“筛选结果”，副标题显示筛选文件夹。当前搜索范围与筛选条件可保存为左栏的“筛选视图”。右栏可管理统一的双向连接：资料、笔记和文件夹均可作为端点并允许跨目录，类型包括“属于、相关、引用、支持、反驳、后续研究”。文件夹还具有稳定 ID、简介和标签，明确移动或更名后资料卡与连接继续保留。

“知识图谱”是工作台主页，采用从左到右的固定分层排列，按知识库文件夹绘制实线层级。一级文件夹使用不同分支颜色，其下的次级文件夹、文件节点和结构线继承相同颜色。普通连接位于灰色次级图层并统一显示双向箭头；属于某资料的笔记作为资料的子节点显示，跨文件夹且拥有相同标签的资料使用虚线连接。文件节点默认只显示标题前几个字，鼠标悬停后显示较长标题。图谱支持滚轮或按钮缩放、拖动画布平移。单击文件夹聚焦其结构分支；单击资料或笔记会高亮其直接连接的节点和连线，其余内容灰化；单击 Library 恢复完整图谱。双击总节点进入 Library 列表，双击文件夹进入对应资料列表；单击资料或文件夹节点会在右栏显示资料卡，双击资料进入阅读界面。顶部前进和后退按钮记录图谱聚焦、资料列表和文件阅读页面，后退的最早位置固定为知识图谱主页。

首次运行会创建：

```text
inbox/          待处理文件；也可手动放入 .url 文本文件
library/        已入库的原件、摘要 .md、元数据 .json、提取文本 .txt
needs-review/   需要人工检查的内容与原因
data/jobs/      后台任务状态
data/notes/     阅读便签
data/temporary-notes/  临时笔记与待分类笔记资料包
data/bookmarks/ 阅读书签
data/saved-views.json  保存的筛选视图
data/relations.json   资料、笔记和文件夹的统一连接
data/folders.json     手动创建并需要保留的空文件夹
data/folder-metadata.json  文件夹稳定 ID、简介和标签
data/restructure-history.json  最近的目录调整与撤销状态
vault/notes/     以稳定 ID 命名的长期 Markdown 笔记
vault/attachments/  按笔记稳定 ID 保存的附件
vault/templates/    Obsidian 兼容模板预留目录
```

链接可保存为 `.url` 文件，内容为单行网址，或 Windows 快捷方式格式 `URL=https://...`。一次性运行只处理启动时收件箱里已有的资料；处理过程中新增的文件留到下次运行。

也可在终端运行 `npm run workbench` 启动工作台；默认监听 `http://127.0.0.1:3000`。双击启动器时，如果旧版工作台仍占用 3000 端口，新版会自动选择下一个空闲端口并打开正确页面。

## 接口

以下接口仅在工作台运行时可用。文件上传加 `defer=1` 时只暂存；调用分类接口后返回后台任务，可用任务接口查询结果。上传文件的请求体是文件原始字节，不是 multipart 表单。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/health` | 服务状态 |
| `POST` | `/api/inbox/urls` | 接收单个 `url`，或通过 `urls` 数组批量接收；添加 `?defer=1` 时只放入收件箱 |
| `GET` | `/api/inbox` | 查看当前待分类文件 |
| `POST` | `/api/inbox/files?defer=1&filename=paper.pdf` | 暂存受支持的文档、图片、音频、ZIP、URL 或 WEBLOC，最大 32 MB |
| `DELETE` | `/api/inbox/files?filename=paper.pdf` | 删除一个尚未开始分类的收件箱文件 |
| `POST` | `/api/inbox/process` | 开始分类当前收件箱中的全部支持文件 |
| `GET` | `/api/jobs/{id}` | 查询任务状态 |
| `GET` | `/api/items` | 列出知识库与待检查内容；可加 `?status=review` |
| `GET` | `/api/items/{id}` | 查看一条内容 |
| `DELETE` | `/api/items/{id}` | 将资料、原件、摘要、正文缓存和便签移入本地回收站 |
| `GET` | `/api/library/tree` | 获取 Library 分类树与资料数量 |
| `GET` | `/api/library/folder-records` | 获取文件夹稳定 ID、简介和标签 |
| `PATCH` | `/api/library/folder-records/{id}` | 修改文件夹简介和标签 |
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
| `GET/POST` | `/api/relations` | 读取或建立资料、笔记、文件夹之间的统一连接 |
| `DELETE` | `/api/relations/{id}` | 删除连接；删除“属于”关系时同步解除笔记归属 |
| `GET` | `/api/items/{id}/asset` | 预览原始文件 |
| `GET` | `/api/items/{id}/markdown` | 获取知识笔记 Markdown |
| `GET` | `/api/items/{id}/text` | 获取提取后的正文 |
| `GET` | `/api/items/{id}/notes` | 获取资料的锚定便签 |
| `POST` | `/api/items/{id}/notes` | 在文章位置新建便签 |
| `PATCH` | `/api/items/{id}/notes/{noteId}` | 保存便签内容 |
| `DELETE` | `/api/items/{id}/notes/{noteId}` | 删除便签 |
| `POST` | `/api/items/{id}/notes/{noteId}/convert` | 把阅读便签转换为绑定笔记 |
| `GET/POST` | `/api/items/{id}/bookmarks` | 获取书签或为当前阅读位置创建命名书签 |
| `DELETE` | `/api/items/{id}/bookmarks/{bookmarkId}` | 删除书签 |
| `PATCH` | `/api/items/{id}` | 修改标题、人工质量分、摘要、标签、分类位置、收藏和阅读状态；分类位置由列表中的移动操作调用；待检查项还可修改发表日期和校正文本 |
| `POST` | `/api/items/{id}/reanalyze` | 用 `corrected_text` 重新分析待检查项；判断通过后入库 |
| `POST` | `/api/items/{id}/approve` | 人工确认待检查项并入库，需已有摘要 |
| `GET/POST` | `/api/notebook/temporary` | 列出或新建临时笔记 |
| `POST` | `/api/notebook/notes` | 在指定文件夹或当前资料旁新建笔记 |
| `GET/PATCH/DELETE` | `/api/notebook/notes/{id}` | 读取、保存或删除笔记 |
| `POST` | `/api/notebook/notes/{id}/submit` | 将临时笔记送入收件箱 |
| `POST` | `/api/notebook/notes/{id}/assets` | 保存粘贴到笔记中的图片 |
| `GET` | `/api/notebook/notes/{id}/export/markdown` | 导出 Markdown 与图片 ZIP 资料包 |
| `GET` | `/api/notebook/notes/{id}/export/pdf` | 打开适合保存为 PDF 的打印页面 |

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

系统仍会从资料中读取正文，供模型生成摘要和分类，但工作台不再提供单独的“提取文本”阅读标签。

- PDF 读取文字层，网页和本地 HTML 读取清理后的正文，图片保存模型识别到的可见文字。
- Markdown、TXT 和代码文件按文字处理，代码不会编译或执行。文本优先按 UTF-8 读取，也兼容 UTF-16 和常见中文 GB18030 文本。
- DOCX 读取正文、页眉、页脚及脚注；PPTX 读取幻灯片和演讲者备注；XLSX 读取工作表单元格；EPUB 按书脊顺序读取章节正文。
- 视频网址只使用标题和简介，不转写音频。
- MP3、M4A、AAC、WAV、FLAC、OGG、OPUS 和 WMA 只读取标题、作者、专辑、时长及格式等元数据，随后直接进入待检查，不调用 DeepSeek。可播放原件并填写内容校正，再执行重新分析。
- ZIP 只读取内部文件名，不解压保存内部文件，也不读取文件正文。文件名足够明确时由 Agent 分类；无法可靠判断时进入待检查。RAR 和 7Z 当前尚未支持。
- EML 邮件不在当前处理范围内。

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
- 每条资料保留原件（网页为 HTML 快照，视频为 `.url`）、人可读摘要 `.summary.md` 和结构化元数据 `.json`。笔记正文使用 `.md`，避免与系统摘要互相覆盖。
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

当前 39 项自动化测试还覆盖并发 JSON 更新、中断写入恢复、JSON/TXT 原件防冲突、资料更名失败回滚、全部支持格式的一次性处理、跨来源写请求拦截、DNS 固定与跳转复查、文件夹稳定资料、跨类型连接和笔记所属关系。
