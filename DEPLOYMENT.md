# EdgeGate 部署到 Cloudflare Workers

本指南适用于本仓库的 React + HeroUI 管理界面和 Worker API。二者部署为**一个 Cloudflare Worker**，前端由 Workers Static Assets 提供，业务配置保存在 D1，管理员会话保存在 KV。自定义服务商的推理经过 Cloudflare AI Gateway，日志与分析也从 Cloudflare 读取。

## 1. 选择部署方式

| 方式 | 适合场景 | 首次需要做什么 |
| --- | --- | --- |
| GitHub → Workers Builds | 自己持续维护，公开或已授权的私有仓库 | 连接仓库，配置 D1 / KV、构建命令和 Secrets |
| Deploy to Cloudflare 按钮 | 从公开 GitHub 仓库快速创建一套应用 | 按引导创建资源，填写 AI Gateway 配置和 Secrets |
| 本地 Wrangler | 从本地发布，便于观察首次部署过程 | 登录 Cloudflare，创建资源，运行部署命令 |

**可以从 GitHub 部署。** 自用推荐直接连接仓库；如果希望提供“一键部署”，可以使用 Cloudflare 官方按钮。按钮流程可以创建 D1 / KV，并更新新仓库里的资源 ID。AI Gateway 和 Cloudflare Token 仍需按下文准备；供应商密钥由程序加密存入 D1，无需 Secrets Store。[Cloudflare 部署按钮说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

以下三种部署方式选择一种即可；第 2 节的配置和第 6 节的验收通用。仅提交到本地 Git 不会出现在 GitHub，需要你之后自行将仓库上传到 GitHub，才可连接在线构建。

## 2. 准备运行配置

### 2.1 Cloudflare 资源

使用有权限管理目标账户的 Cloudflare 账号，准备以下资源：

| 资源 | 本项目配置名 | 用途 |
| --- | --- | --- |
| Worker | `name`，默认 `edgegate` | 管理界面和 `/api/*`、`/v1/*` API |
| D1 数据库 | 绑定名 `DB` | 渠道、加密供应商密钥、模型、应用密钥哈希、标签及配额 |
| KV 命名空间 | 绑定名 `KV` | 管理员会话、分析 Schema 缓存 |
| AI Gateway | `vars.AI_GATEWAY_ID` | 转发推理、保存日志、提供分析 |

在 Cloudflare 控制台进入 **AI Gateway**，创建或选择一个网关，记下它的 ID；建议首次先明确创建和检查网关。Cloudflare 也支持首次认证请求自动创建 `default` 网关，但自定义服务商 / BYOK 配置前仍应确认网关存在及其设置。[网关管理说明](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/)

打开网关认证，并检查日志采集、请求 / 响应正文保留等设置。供应商密钥默认由 EdgeGate 使用 `ENCRYPTION_KEY` 加密保存，不需要创建 Secrets Store。已经配置好的 Cloudflare BYOK 别名也可以继续使用。

### 2.2 普通变量

普通变量保存在根目录 `wrangler.jsonc` 的 `vars` 中：

| 名称 | 填写内容 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | AI Gateway 所属账户的 32 位 Account ID；不是 Zone ID |
| `AI_GATEWAY_ID` | 网关的 ID，例如 `default` 或 `edgegate`；不是完整 URL |

新版不使用 `SECRETS_STORE_ID`。如果一键部署页面仍显示它，说明 GitHub 源仓库尚未更新到新版；先更新仓库再重新进入部署向导。已有部署中的同名变量可删除。

**后续修改这些变量应同步修改 `wrangler.jsonc` 并重新构建部署。** 只在控制台改普通变量，下次从仓库部署时可能被文件中的值覆盖。D1 / KV 绑定也以该文件为准。

### 2.3 运行时 Secrets

这些值添加到 **Worker → Settings → Variables & Secrets**，类型选择 **Secret**，也可按第 5 节使用 Wrangler 上传。不要把真实值写进 Git 文件、前端 `VITE_*` 变量或公开文档。

| 名称 | 是否需要 | 内容 / 权限 |
| --- | --- | --- |
| `ADMIN_TOKEN` | 必需 | 控制台登录令牌，至少 32 字符 |
| `ENCRYPTION_KEY` | 必需 | 32 字节随机数据的 Base64 编码，用于加密 D1 中的供应商 API Key、渠道 Token 覆盖值 |
| `CF_API_TOKEN` | 自定义服务商管理及日志分析需要 | 目标账户的 AI Gateway Read / Edit、Account Analytics Read |
| `CF_AIG_TOKEN` | 可选 | 独立推理 Token，要求 AI Gateway Run；留空时推理使用 `CF_API_TOKEN`，后者必须额外具备 Run |
| `CF_AI_TOKEN` | 可选 | 仅 Cloudflare AI REST / 统一计费渠道需要，要求 Workers AI Read；只用自定义服务商可不填 |

第一次使用，给 `CF_API_TOKEN` 配齐 **AI Gateway Read / Edit / Run、Account Analytics Read**，即可不填写两个可选 Token。无需 Secrets Store 权限。

这里的 Cloudflare Token 和供应商 API Key 是两种凭据：前者访问 Cloudflare，后者在控制台添加渠道时填写，由程序加密存入 D1。自定义服务商的网关认证使用 `cf-aig-authorization`；AI Gateway 的 Run 权限用于推理认证。[网关认证说明](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)

在本机分别生成管理员令牌和加密密钥，并保存到密码管理器：

```bash
# 第一条输出用作 ADMIN_TOKEN
openssl rand -hex 32

# 第二条输出用作 ENCRYPTION_KEY
openssl rand -base64 32
```

`ADMIN_TOKEN` 用于管理员登录。客户端调用模型使用的是登录后创建的 `eg_...` 应用 API Key。

### 2.4 部署凭据与程序凭据分开设置

| 凭据 | 配置位置 | 作用 |
| --- | --- | --- |
| Workers Builds 的部署 API Token | Worker 的 Build 设置 | 发布脚本、静态资源，执行 D1 迁移 |
| `CLOUDFLARE_API_TOKEN` | 自行使用 CI 时的构建环境 Secret | Wrangler 的非交互认证；本地也可用 `wrangler login` |
| `CF_API_TOKEN` 等上述 Secrets | Worker 的运行时 Variables & Secrets | 程序运行后管理 AI Gateway、查询日志和推理 |

Workers Builds 可生成或选择部署 Token。**请给部署 Token 增加目标账户的 D1 Edit 权限**，本项目的部署脚本需要执行远程迁移。它还应具有发布 Worker、访问 KV 等部署所需权限。不要只配置 AI Gateway 权限后拿它发布 Worker。

**Build variables and secrets 只在构建时可见，不会自动变成 Worker 运行时 Secrets。** 将 `ADMIN_TOKEN` 只填在 Build 页面，线上仍会提示未配置。[Workers Builds 配置与 Token 权限](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)

## 3. 方式一：连接自己的 GitHub 仓库

### 3.1 创建 D1 和 KV

普通仓库导入按以下步骤显式准备资源；如果选择第 4 节的按钮流程，可以由该流程创建，不必重复创建。

可以在 Cloudflare 控制台创建，也可以在仓库根目录运行：

```bash
npm ci
npx wrangler login
npx wrangler whoami
npx wrangler d1 create edgegate
npx wrangler kv namespace create KV
```

记录 D1 返回的 `database_id` 和 KV 返回的 `id`。编辑 `wrangler.jsonc` 中已有条目，填写真实 ID，不要追加重复绑定：

```jsonc
"d1_databases": [{
  "binding": "DB",
  "database_name": "edgegate",
  "database_id": "替换为实际 D1 UUID",
  "migrations_dir": "migrations"
}],
"kv_namespaces": [{
  "binding": "KV",
  "id": "替换为实际 KV ID"
}]
```

这是配置片段，需要保留原文件其余字段。数据库名称可以更改，`database_name` 应对应实际资源，**绑定名保持 `DB` 和 `KV`**。仓库初始配置中的全零 ID 是模板占位值，普通部署前必须替换。

按第 2 节填写 `vars`，将配置提交到你将要连接的 GitHub 仓库。Account ID、D1 / KV ID 属于资源标识；API Token、管理员令牌和加密密钥始终通过 Secrets 配置。

### 3.2 连接 Workers Builds

1. 进入 Cloudflare 控制台的 **Workers & Pages**，创建应用并选择导入 Git 仓库 / 连接 GitHub。
2. 授权访问目标仓库，选择这个项目。已有 Worker 可从 **Settings → Build** 连接仓库。
3. Worker 名称与 `wrangler.jsonc` 的 `name` 保持一致，默认 `edgegate`。
4. 按下表配置，然后开始部署。

| 构建项 | 本项目填写值 |
| --- | --- |
| Production branch | `main`，或你实际使用的生产分支 |
| Root directory | 仓库根目录，保持默认 |
| Build command | `npm run build` |
| Deploy command | `npm run deploy:ci` |
| Node.js | `24`，仓库已提供 `.node-version` |
| 部署 Token | 确认具有 D1 Edit 权限及 Worker / KV 部署权限 |

不需要填写 Pages 的 Build output directory，也不用单独上传 `dist/client`。Cloudflare Vite 插件生成前端和 Worker 构建产物，Wrangler 会使用生成的部署配置。

Workers Builds 连接后会随生产分支的推送自动构建部署；仓库里的 GitHub Actions 工作流仅运行检查，不负责部署。[Git 集成说明](https://developers.cloudflare.com/workers/ci-cd/builds/)

Node.js 版本可通过 `.node-version` 或 Build 环境变量 `NODE_VERSION=24` 指定；若已有冲突的环境变量，应同步调整。[构建环境说明](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)

### 3.3 配置运行时 Secrets

首次部署完成后，进入 **Worker → Settings → Variables & Secrets**，按第 2.3 节添加 Secrets 并部署保存。未设置有效 `ADMIN_TOKEN` 时，程序会拒绝管理员登录。

不要在 Workers Builds 执行 `npm run setup`：它只生成本地密钥并迁移本地 D1。生产数据库已经由 `deploy:ci` 初始化。

## 4. 方式二：GitHub 一键部署按钮

README 顶部已提供一键部署按钮，也可以直接点击这里，使用本项目的公开 GitHub 仓库进入 Cloudflare 部署向导：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/doitcan-oiu/cloudflare-workers-models-gateway)

按钮使用的 Markdown 如下；如果你维护的是自己的 Fork，可将其中的 GitHub 地址换为自己的公开仓库地址：

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/doitcan-oiu/cloudflare-workers-models-gateway)
```

公开模板建议保留初始资源占位 ID 和空的账户变量，部署者在流程里填写自己的配置。按钮读取 GitHub 上的代码；本地修改提交后，需要推送到 GitHub，线上 README 和后续部署才会使用更新后的内容。

点击按钮后的流程：

1. 登录 Cloudflare，选择账户，并授权 GitHub。
2. 将源代码复制到自己账号下的新仓库，选择 Worker / 资源名称。
3. 确认创建 D1 和 KV。Cloudflare 会将新资源 ID 写入新仓库的 Wrangler 配置。
4. 填写 Account ID、Gateway ID，以及 `ADMIN_TOKEN`、`ENCRYPTION_KEY`、`CF_API_TOKEN`。
5. 检查构建命令为 `npm run build`，部署命令为 `npm run deploy:ci`；确认部署 Token 有 D1 Edit 权限。
6. 完成部署，再按第 6 节登录并添加自定义服务商。

仓库已提供 `.dev.vars.example` 声明核心 Secrets，以及 `package.json` 的 `cloudflare.bindings` 字段说明。可选的 `CF_AIG_TOKEN` / `CF_AI_TOKEN` 按需在 Worker 运行时 Secrets 中添加。

一键流程负责部署应用、创建 D1 / KV；它不会根据本仓库的字符串变量创建你指定的 AI Gateway，也不会替你生成模型服务商的凭据。因此应先完成第 2 节的准备。使用私有仓库自用部署时，走第 3 节的 GitHub 连接方式。[按钮的资源配置与公开仓库要求](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

## 5. 方式三：本地命令行部署

需要 Node.js 24、npm 和可登录 Cloudflare 的浏览器。所有命令在仓库根目录执行。

### 5.1 安装与配置

按第 3.1 节安装依赖、登录 Wrangler、创建 D1 / KV，并填写 `wrangler.jsonc` 的真实资源 ID 和 `vars`。按第 2 节准备 AI Gateway 和 Secrets。

如果账号属于多个 Cloudflare 账户，可在当前终端设置 `CLOUDFLARE_ACCOUNT_ID` 环境变量为本次部署的账户，避免资源创建到错误账户。该环境变量用于 Wrangler；仍需填写 `vars.CLOUDFLARE_ACCOUNT_ID` 供 Worker 运行时使用。

### 5.2 检查并发布

```bash
npm run check
npm run deploy
```

`npm run deploy` 按顺序执行：

1. TypeScript 检查并用 Vite 构建管理界面与 Worker。
2. 对 `DB` 对应的远程 D1 执行 `migrations/` 中尚未应用的 SQL。
3. 发布 Worker 和静态资源，输出访问地址。

任一步失败都会停止后续操作。迁移成功后若发布失败，已执行的数据库变更仍然存在；修复后可重新运行部署。

如果只想检查构建与打包，不发布，可执行：

```bash
npm run build
npx wrangler deploy --dry-run
```

`--dry-run` 不执行远程 D1 迁移，也不能验证生产 Token 权限或上游连接。

### 5.3 上传生产 Secrets

Worker 首次发布后，依次运行以下命令，在交互提示中粘贴第 2 节准备的值：

```bash
npx wrangler secret put ADMIN_TOKEN --config wrangler.jsonc
npx wrangler secret put ENCRYPTION_KEY --config wrangler.jsonc
npx wrangler secret put CF_API_TOKEN --config wrangler.jsonc

# 仅在需要独立推理 Token 时执行
npx wrangler secret put CF_AIG_TOKEN --config wrangler.jsonc

# 仅在需要 Cloudflare AI REST / 统一计费渠道时执行
npx wrangler secret put CF_AI_TOKEN --config wrangler.jsonc
```

`secret put` 会发布包含 Secret 更新的新版本，无需为了上传 Secret 再运行一次完整构建。也可在控制台添加 Secret 并部署保存。[Workers Secrets 配置](https://developers.cloudflare.com/workers/configuration/secrets/)

本地 `.dev.vars` 不会自动上传；不要把它整体作为生产凭据使用。此时打开 Wrangler 输出的 `workers.dev` 地址，使用生产 `ADMIN_TOKEN` 登录。

## 6. 部署后验收

### 6.1 检查程序与登录

将下面地址改为你的 Worker 地址：

```bash
export EDGEGATE_URL='https://edgegate.YOUR-SUBDOMAIN.workers.dev'
curl -fsS "$EDGEGATE_URL/api/health"
```

有效管理员令牌配置完成后，预期结果：

```json
{"status":"ok","service":"edgegate","setup_required":false}
```

这个接口只检查程序响应及管理员令牌是否就绪，**不验证 D1、KV 或模型服务商连接**。继续登录控制台，查看渠道和模型列表，确认数据库与会话可用。

### 6.2 添加自定义服务商

1. 在「渠道管理」添加渠道，选择「自定义服务商 · AI Gateway」。
2. 创建或关联 Cloudflare 服务商，选择 OpenAI Chat Completions 或 Anthropic Messages 协议。
3. 默认选择「程序加密存储」，填写供应商 API Key，设置 Base URL 和请求路径；无需 Secrets Store。已有 BYOK 配置可选择别名模式继续使用。
4. 填写服务商标签与实际支持的模型清单，保存并启用。
5. 在「API 密钥」创建应用密钥，选择需要允许的标签，保存生成的 `eg_...` 密钥。

例如供应商地址为 `https://api.example.com/v1/messages`，可填 Base URL `https://api.example.com` 和路径 `v1/messages`；Base URL 已含 `/v1` 时路径应为 `messages`。协议应与供应商实际接口一致，由 Worker 完成客户端 OpenAI / Anthropic 格式转换。[Cloudflare 自定义服务商路径规则](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)

初始化数据库包含示例 Cloudflare 渠道和模型，并不代表账户已经具备调用权限。主要使用自定义服务商时，可停用不用的示例渠道和路由。

### 6.3 检查标签下的模型集合

将新建应用密钥设置到本地终端的 `EDGEGATE_API_KEY` 环境变量，然后运行：

```bash
curl -fsS "$EDGEGATE_URL/v1/models" \
  -H "Authorization: Bearer $EDGEGATE_API_KEY"
```

验收例子：给 A、B 服务商都添加 `team` 标签，A 的模型清单包含 `claude-sonnet-4-5`，B 包含 `claude-opus-4-6`。应用密钥选择 `team` 后，在相关渠道、模型与路由都启用、且没有额外模型白名单排除它们的情况下，返回的 `data` 应同时包含两个模型。

### 6.4 验证推理、日志与分析

以下例子使用前一步确实已经配置且供应商支持的模型名，可替换为其他模型：

```bash
# OpenAI Chat Completions
curl -sS "$EDGEGATE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $EDGEGATE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"你好"}],"max_tokens":64}'

# Anthropic Messages
curl -sS "$EDGEGATE_URL/v1/messages" \
  -H "x-api-key: $EDGEGATE_API_KEY" \
  -H 'anthropic-version: 2023-06-01' \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'
```

随后查看 EdgeGate「请求日志」和「总览」，或对应 Cloudflare AI Gateway 控制台。分析数据可能延迟或采样，部分自定义模型的 Token / 费用信息取决于 Cloudflare 支持与定价配置；程序不会在 D1 中另存一份推理日志或补算费用。

## 7. 更新、域名和数据

- **GitHub 更新**：推送到已连接的生产分支，Workers Builds 自动执行构建、远程迁移和发布。
- **本地更新**：依赖变化后执行 `npm ci`，检查通过后执行 `npm run deploy`。
- **数据库升级**：新增编号递增的 SQL 迁移，不修改已经执行的旧迁移；迁移记录保存在 D1，重复部署只执行未应用的文件。[D1 迁移说明](https://developers.cloudflare.com/d1/reference/migrations/)
- **备份与回滚**：涉及数据变更前备份 D1 或确认可用的恢复点。Worker 代码回滚不会撤销已经执行的 D1 迁移。
- **保留凭据**：后续部署保持原 `ENCRYPTION_KEY`。直接换值会导致已保存的供应商 API Key 和渠道 Token 无法解密；应先完成凭据重新配置。备份恢复 D1 时同样需要对应的加密主密钥。更换 `ADMIN_TOKEN` 会使已有管理会话失效。
- **旧 BYOK 渠道**：升级后继续使用原别名。改为程序存储时，在编辑渠道中选择「程序加密存储」并重新输入供应商 API Key；原 Cloudflare BYOK 不会被删除。本次变更复用已有数据库字段，无需新增迁移。
- **自定义域名**：在 Worker 的 Settings → Domains & Routes 添加 Custom Domain，按控制台引导配置；保留同域的前端与 API 访问方式。
- **本地数据**：本地 D1 / KV 与线上独立，本地渠道和应用密钥不会随代码发布。若指向相同 Cloudflare Account / Gateway，云端服务商、BYOK 和日志仍是共享资源。
- **分支预览**：先使用生产分支构建即可。若启用其他分支预览，不要直接套用生产 `deploy:ci`；为测试环境单独配置 Worker、D1 / KV 和网关。默认版本预览不会自动隔离本项目的数据绑定。

## 8. 常见问题

| 现象 | 排查位置 |
| --- | --- |
| 构建提示 Node 版本不支持 | 使用 Node.js 24，检查 Build 环境变量是否覆盖 `.node-version` |
| D1 / KV ID 不存在 | 普通部署仍使用全零占位 ID，或资源不在部署账户；替换真实 ID 后重新构建 |
| 部署迁移返回权限错误 | 检查 Workers Builds 的部署 Token 是否有目标账户 D1 Edit；不是检查运行时 `CF_API_TOKEN` |
| `no such table` / 登录时报 D1 错误 | 确认部署命令为 `npm run deploy:ci`；必要时手动执行 `npm run db:migrate:remote` 后重试 |
| 登录提示 `setup_required` | 在 Worker 运行时 Secrets 设置至少 32 字符 `ADMIN_TOKEN` 并部署保存 |
| 已在 Build 页面填 Token，程序仍提示缺少配置 | 将程序需要的值配置到 Worker 运行时 Variables & Secrets |
| Cloudflare 服务商 / 日志 / 分析返回 401 或 403 | 检查运行时 `CF_API_TOKEN`、账户范围和相应 AI Gateway / Analytics 权限 |
| 保存供应商密钥提示 `encryption_setup_required` | 检查运行时 `ENCRYPTION_KEY` 是否为 32 字节随机数据的 Base64 编码，并已部署生效 |
| 编辑渠道要求重新输入密钥 | 更换服务商或请求地址时必须重新填写；普通编辑留空会保留原来的密钥 |
| 推理被 Cloudflare 拒绝 | 检查 `CF_AIG_TOKEN` 或回退的 `CF_API_TOKEN` 是否具备 AI Gateway Run，以及网关认证配置 |
| 供应商返回认证失败 | 检查渠道 API Key 和服务商协议；已有 BYOK 模式检查相应别名配置 |
| `/v1/models` 为空或少模型 | 检查应用密钥的标签和模型白名单，以及渠道、模型、路由的启用状态 |
| 上游返回 404 | 检查 Base URL 与路径是否重复 `/v1`，及模型名是否为供应商实际支持的 ID |
| 页面白屏或 API 返回 HTML | 确认部署的是完整 Worker 构建；保留 `assets.run_worker_first` 中的 `/api/*`、`/v1/*`；检查浏览器控制台与 Worker 日志 |

排查 Worker 自身异常可运行 `npx wrangler tail --config wrangler.jsonc`。它用于查看 Worker 运行日志；推理请求的日志与分析仍在 AI Gateway。
