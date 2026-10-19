# InfoBox Markdown Vault 数据契约

本文定义阶段一使用的 Obsidian 兼容 Markdown Vault。Vault 是长期笔记的权威数据源；SQLite 或其他索引只能由这些文件重建。

## 目录结构

```text
vault/
  notes/
    <stable-id>.md
  attachments/
    <stable-id>/
      image.png
  templates/
```

- 笔记文件名使用稳定 ID，不依赖标题和分类。修改标题或目录不会改变文件路径。
- 笔记中的附件路径写成 `../attachments/<stable-id>/<filename>`，以 Markdown 文件为基准解析。
- `VAULT_DIR` 可以指定其他 Vault 根目录；未配置时使用项目数据根目录下的 `vault/`。
- `vault/` 是用户资料，默认不纳入 Git。

## 正文链接与嵌入

- 跨笔记链接推荐写成 `[[<stable-id>|显示名称]]`，章节链接写成 `[[<stable-id>#章节标题|显示名称]]`。稳定 ID 与文件名一致，标题或分类变化后仍能定位；IB 改名时会把旧标题加入 `aliases`。
- IB 也识别指向受管理笔记的相对 `.md` 链接。`![[<stable-id>]]` 在工作台预览中展示目标笔记内容，`![[图片名.png]]` 解析为当前笔记的相对附件。嵌入只展开一层，避免循环嵌入。
- 出链和反链在读取时由 Markdown 正文推导，知识图谱显示对应连接；外部编辑后可刷新资料重新读取。原有“建立连接”仍保存在稳定 ID 关系记录中；目录移动和重构不会改写正文链接。
- 标题跳转支持常见 Markdown 标题。重复标题、特殊标点与 Obsidian 的锚点规则可能有差异，复杂文档宜使用稳定 ID 链接并检查跳转结果。

## Frontmatter 字段

每份受管理笔记必须以 YAML frontmatter 开头，正文紧随其后。

| 字段 | 规则 |
| --- | --- |
| `id` | 必填、稳定、与文件名一致。不能由标题推导。 |
| `type` | 笔记类型；阶段一的新建普通笔记使用 `note`。 |
| `title` | 用户可修改的显示标题。 |
| `manual_tags` | 用户维护。Agent 不得删除或覆盖。 |
| `zotero_tags` | Zotero 来源标签；阶段一保留为空。 |
| `agent_tags` | Agent 可重新生成的标签。 |
| `tags` | 上述三组标签按顺序去重后的合集，供 IB 与 Obsidian 查询。 |
| `category` | 逻辑分类路径，例如 `Computer Science/AI/Agent`。 |
| `status` | Vault 中使用 `processed` 或 `review`；工作台会把 `processed` 映射为现有的 `ready` 状态。 |
| `created_at` / `updated_at` | ISO 时间。 |
| `received_at` | `YYYY-MM-DD` 收件日期。 |

`summary`、`quality_score`、`published_at`、`favorite`、`reading_status`、`reading_position`、`bound_item_id` 和 `anchor` 等现有字段可继续写入 frontmatter。后续 Zotero 阶段可以增加 `zotero_key`、`citekey`、`doi`、`authors` 与 `year`。

笔记编辑区的“笔记属性”面板可修改简单文本、数值、布尔值和字符串列表；未知嵌套字段会保留在 YAML 中并以只读形式显示。受保护的 ID、类型、标题、分类和合并后的 `tags` 通过对应的工作台操作维护。Zotero 文献笔记增加 `type: literature` 和 `zotero_key`，仍是标准 Markdown 文件。

IB 修改已存在的 Markdown 时只更新目标字段。未知字段、嵌套值、字段顺序和 YAML 注释由解析文档保留，不会通过固定 schema 重新生成整份元数据。

## 标签写入规则

```text
tags = unique(manual_tags + zotero_tags + agent_tags)
```

- 用户通过当前“编辑资料”界面保存标签时，这些标签写入 `manual_tags`。
- Agent 后续只能替换 `agent_tags`，然后重新计算 `tags`。
- 从外部编辑器读取时，IB 每次重新解析文件，不使用 JSON 副本覆盖 Markdown。
- Obsidian 等编辑器只在 `tags` 中新增的标签，如果不属于现有 Zotero 或 Agent 标签，会被视为人工标签；IB 下次保存时补入 `manual_tags`，避免重新分析后丢失。删除人工标签应修改 `manual_tags`（或使用 IB 的人工标签编辑），仅删除合并后的 `tags` 不会抹掉来源字段。

## 并发与外部修改

读取笔记时，`VaultRepository` 返回文件内容的 SHA-256 修订值。保存必须携带读取时的修订值；如果 Obsidian 或其他程序已修改文件，IB 返回 `VAULT_WRITE_CONFLICT`（HTTP 409），并保留磁盘上的外部版本。重新载入后才可再次保存。

写入仍使用同目录临时文件、刷盘、备份与原子替换。Vault 监听器用于报告外部 `.md` 变化；仓储读取不依赖缓存，因此重新打开笔记即可获得外部正文和 frontmatter 修改。

## 渐进迁移与回退

阶段一只把“直接在具体文件夹新建、且未绑定资料”的普通笔记切换到 Vault。以下内容暂时保持旧格式：

- 临时笔记及送入收件箱的笔记。
- 与原资料绑定并随资料移动的笔记。
- 已存在的 JSON sidecar 笔记。

旧笔记迁移采用复制切换：

1. `previewNoteMigration(id)` 返回精确源路径、目标路径和回退说明。
2. `migrateNoteToVault(id)` 创建 Vault Markdown，复制附件并记录迁移清单，不移动或删除旧文件。
3. 同一稳定 ID 同时存在时，读取优先使用 Vault 版本，旧版本仍作为可回退源。
4. `rollbackNoteMigration(id)` 删除生成的 Vault 副本，旧 JSON 与 Markdown 立即恢复为可读版本。

迁移测试只使用系统临时目录中的夹具。阶段一没有自动扫描或批量改写真实 `library/`。
