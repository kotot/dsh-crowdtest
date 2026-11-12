# dsh-crowdtest

CrowdTest 众测插件：参与者在 DeepSeek Harness 桌面端领取众测任务，由插件配置测试模型、准备工作区并自动上传会话备份。插件跟随官方桌面端升级，不需要 fork 桌面端。

## 参与者使用

1. 打开 DeepSeek Harness 桌面端。首次启动可在欢迎页选择「稍后配置」。
2. 登录获授权的 GitHub 账号，从[项目 Releases](https://github.com/kotot/dsh-crowdtest/releases/latest) 下载 `dsh-crowdtest.tgz`，在 DSH「插件」页添加本地安装包并启用。
3. 在 CrowdTest 评测页点击「在本机运行」，复制平台生成的完整命令 `/crowdtest <领取口令> <平台地址>` 并在任意会话中发送。旧平台只生成短口令时，需要管理员提供地址或预先配置 `serverBaseUrl`。
4. 插件在 `~/CrowdTest` 下创建运行专用工作区，下载附件，注册测试模型并在新会话中发送首轮任务。已绑定运行保留原工作区。
5. 输入框上方显示当前任务与运行的会话备份状态。每轮结束后自动上传，也可点击**立即同步**或发送 `/crowdtest-upload`。同步栏显示最近一次成功同步确认的相对时间，例如「上次同步 · 2m 10s 前」，每秒更新。手动与自动同步成功都会更新时间，内容相同而跳过上传时也会更新；定时检查不会更新时间。确认时间保存在本机，重启后保留；鼠标悬停可分别查看同步确认时间与服务端备份上传时间。旧记录尚无确认时间时显示「尚无同步确认记录」，完成一次同步后开始计时；尚无备份或确认记录且有内容待同步时，状态显示「尚未同步」；已有备份或确认记录后，新增内容使状态显示「有新内容待同步」，同时保留最近一次成功同步确认的计时。切换会话后，状态和时间随当前会话变化；普通会话不显示该栏。

## 更新插件

0.2.15 需要 DSH 0.2.2-rc.1 或更新的受支持版本。首次安装含更新功能的包后，插件所有者可在详情页点击「检查更新」，保存仅能读取 `kotot/dsh-crowdtest` 仓库 Contents 的 GitHub 令牌。保存后会立即检查，之后每次打开已启用的插件详情页都会检查一次。有新版时，标题旁显示「可更新」，点击右上角「更新到 x.y.z」即可安装。展开「GitHub 访问令牌」可以替换或移除保存在 DSH 凭据服务中的令牌。

更新器读取 GitHub 最新正式 Release，核对版本标签、资产 ID、带版本号的文件名、大小和 SHA-256 摘要。安装前验证包内容、DSH 版本和操作系统，并将备份包与当前安装目录逐文件比对。若原包丢失，可从当前版本的 GitHub 标签获取备份。手动重装后若已删除下载文件，点击「检查更新」会通过该版本的标签和本机文件重新验证。详情页关闭后，已接受的更新仍会继续。安装完成后请完全退出并重新打开 DSH，加载新版本。

更新期间请等操作结束后再卸载、切换启用状态或从其他窗口操作同一插件。更新器在调用 DSH 安装接口前会再次核对当前安装和启用状态。DSH 在接口内部获取安装锁，也允许其他客户端使用该接口，因此在最后一次核对与取得安装锁之间仍有竞争窗口。

当前配置目录的 `.crowdtest-updater/receipt.json` 保存更新记录。每次更新保留的目标和原版本安装包可能仍被 DSH 的本地文件依赖引用。安装失败且原版本完好时可重新检查并重试。若安装器已经替换了包，更新器仅在确认目标由本次更新写入且启用状态仍一致时尝试还原。若需要手动恢复，核对当前安装后可按详情页提示添加 `previous-*.tgz` 并重启 DSH。运行绑定和任务工作区仍保存在各自的原有目录。

## 工作方式

| 步骤 | 实现 |
| --- | --- |
| 领取 | `/crowdtest` 命令用一次性口令调用 BFF `POST /api/crowdtest/local-runs/dsh/ticket/exchange` 换取本次运行的 Router Token，再以 Token 拉取 `GET /dsh/manifest`（协议 `crowdtest-dsh/v1`）。显式地址优先于插件配置。兼容 `S-` 和 `B-` 领取口令前缀，地址始终取自完整命令或配置。口令不写入会话日志（`recordInput: false`）。 |
| 模型 | Token 存入 Harness 凭证存储。新运行的凭证引用、模型路由和工作区名称包含完整平台地址、项目、任务、运行与会话 ID 的组合摘要。模型配置只记录凭证引用。会话固定选择该路由与平台推理档位；`agent/request` 监听器拒绝该会话改用其他模型。 |
| 会话 | 会话 ID 等于平台为该运行生成的 sessionId，会话日志中写入 `plugin:dsh-crowdtest/binding` 记录。绑定关系保存在 `$DSH_HOME/crowdtest/runs.json`。 |
| 状态 | `GET /api/crowdtest/local-runs/session/status` 返回实际平台备份的 SHA-256、大小、格式和时间。可见会话默认每 5 秒检查一次；重新打开、窗口获得焦点或连接恢复时立即检查。只有本地确定性归档与当前服务端元数据一致时显示**已同步**。认证、网络或元数据异常显示**无法确认**，上传失败显示**同步失败**。历史上传摘要和同步确认时间不作为同步依据。 |
| 上传 | `turn/end` 后防抖 3 秒，读取持久化日志，将原生 `<sessionId>/session.v4.jsonl.zstd` 的原文件名及压缩字节原样放入确定性的 tar.gz，按 `dsh-session-tree-tar-gzip` 格式走 `session/upload-url` → TOS → `session/verify`。发现当前运行的凭据时，插件拒绝上传。 |

## 开发

```sh
npm ci
npm run typecheck && npm test
npm run check:source  # 检查 Git 源码文件与受限内容
npm run check:package # 构建并检查实际安装包文件
npm run pack:tarball  # 自动构建并检查，生成可安装 tarball
```

本地联调使用模拟平台（BFF、LLM Router、TOS）：

```sh
node scripts/mock-crowdtest.mjs 8790
DSH_HOME=/tmp/dsh-ct-home "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile web add "file:$PWD/dsh-crowdtest-0.2.15.tgz"
DSH_HOME=/tmp/dsh-ct-home "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" --profile web --port 8791
# 在 Web 界面分别领取两个独立任务：
# /crowdtest ABCD-EFGH http://127.0.0.1:8790
# /crowdtest IJKL-MNOP http://127.0.0.1:8790
```

模拟服务仅监听回环地址，使用测试 Token。`POST /__control` 接受 `runId`（31 或 32）、`statusCode`、`statusDelayMs`、`uploadDelayMs`、`failUploads`，以及 `backup: null`。例如 `{"runId":31,"statusCode":503}` 可让任务 21 的状态查询失败。将 `statusCode` 改回 200 后恢复。归档摘要由实际接收的文件计算，未上传和摘要不符时 verify 返回 409。`MOCK_OUTPUT_ROOT` 可将归档输出到临时目录。

0.2.3 需要服务端提供上述只读状态接口。旧服务端返回 404 时显示**无法确认**，不会跳过服务端确认而宣称同步成功。Host 对同一会话的检查与上传排序，重复手动点击合并；不同会话独立处理。上传中新增内容会保留**有新内容待同步**，新完成的一轮会触发后续同步。归档缓存按持久化事件修订失效。

插件按结构化接口调用 Host 服务（见 `src/dsh.ts`），运行时通过可选 peer 复用 Harness 的 Cordis、Typert Protocol、兼容性检查与原子文件操作。`engines.dsh` 声明 `>=0.2.2-rc.1 <1.0.0`。DSH 升级改动这些接口时，需要按新版本核对 `src/dsh.ts`。

## 发布到 GitHub Releases

在 GitHub Actions 打开「Release plugin」，点击「Run workflow」并选择 `main`。检查通过后，工作流按 `package.json` 的版本创建 Release，并上传安装包。已有同名标签时，只能从该标签对应的提交重新发布。

为通过检查的提交添加与 `package.json` 对应的版本标签（如 `v0.2.15`）并推送，或在 GitHub 发布该标签的 Release。发布工作流运行类型检查、测试、源码检查和 `npm pack`，将两份同内容的安装包上传到该标签的 GitHub Release。仓库访问权限决定谁可以下载。包声明 `private: true`，防止意外发布到 npm。

安装包仅包含 `package.json`、`README.md`、`cordis.patch.yml`、`icon.png`、`usage-guide.png`、`lib/index.js` 和 `lib/client.js`。源码及安装包检查会拒绝具体的私有网关域名和常见凭据格式。

0.2.13 逐帧校验原生会话备份。遇到可跳过帧或不完整的帧时，插件会停止上传。

0.2.11 需要平台生成带地址的完整领取命令，或在插件配置中指定平台地址。历史运行可在原工作区续领。若旧绑定共用凭证或模型路由，各运行需分别重新领取。绑定冲突期间，模型请求和备份均暂停。若多个已存在会话共用工作区，请在平台重新创建本机运行。若多个运行记录占用同一会话标识，请联系管理员核对归属。

新建会话前先把领取记录写入本机。DSH 返回平台分配的会话 ID 后，插件在原生日志写入这次领取的标识，再固定模型并激活绑定。中断后用新口令重试时，插件只接续带匹配标识的会话。

0.2.8 将已有同步历史后新增内容的状态改为「有新内容待同步」；首次同步前显示「尚未同步」，最近一次成功同步确认的计时保持不变。

0.2.9 为插件页添加 CrowdTest 图标。

## 已知限制

- 输入框顶部同步栏使用 DSH 的 `conversation.input.dock` 插槽、composer 宽度变量及相邻 `conversation.composer.bar` 的 `data-composer-card` 标记拼接外观，不移动输入框。已核对本机安装的 DSH 0.2.2-rc.1 提供这些标记；其他版本若更改结构，需要重新核验拼接外观。

- Token 存在 Harness 凭证文件中，Agent 的 Bash 与之同属一个 OS 用户，仍可读取；模型请求由 Host 进程发出，Token 不进入工具进程环境变量。
- DSH 的会话标题生成会用会话当前模型（即测试模型）额外发起请求，计入本次运行的模型调用。
- 暂不安装项目 Skills，也不接入共享工具代理（vision / seedream / web-search）。

0.2.10 保留原生 `session.v4.jsonl.zstd` 的文件名与压缩字节进行会话备份。自定义 DSH 会话存储根目录时，插件配置 `nativeSessionRoot` 应与 DSH persistence 的 root 一致。先部署支持原生归档的 BFF，再升级插件。
