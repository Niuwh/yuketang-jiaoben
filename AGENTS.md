# AGENTS.md

## 项目概况

- 雨课堂（yuketang.cn 及各院校域名）自动刷课的 Tampermonkey 油猴脚本，单文件 `yuketang.js`，IIFE 结构，无构建与测试体系；改动后导入油猴即可生效。
- 注释、日志与提交信息使用简体中文。
- 版本号在 `Config.version`，发布时同步更新 `releaseLog.md` 与 `README.md`。

## 代码结构

IIFE 内按依赖顺序组织：`Config` → `Utils` → `Store`/`Session` → `createPanel`（UI）→ `RateUnlock`/`PauseGuard`/`PageRestore`（页面修改与还原）→ `Player` → `AiWorkspace` → `preventScreenCheck` → `Solver` → 三个 Runner → `start`/`stopBrushing`/`boot`。
UI 面板实例 `panel` 为全局单例，各模块直接引用，不逐层传参。

## 主要功能与实现

### UI 面板（createPanel）

- 悬浮 iframe 面板：日志输出（log/warn/error）、拖动与最小化、底部按钮（脚本设置/清除课程进度缓存/开始刷课/停止刷课/重新加载）。
- 脚本设置四组配置：AI 接入（URL/Key/Model/接口格式/鉴权方式）、功能开关（AI 答题/OCR/自动评论）、视频倍速（目标倍速与各修改点开关）、刷课流程（自动切换任务点、停止后还原修改）；保存经 `Store.set*Conf` 持久化到 localStorage。

### 配置与会话（Config、Store、Session）

- `Config`：版本号、默认倍速、PPT 翻页间隔、localStorage 键名。
- `Store`：刷课进度缓存（`getProgress`/`setProgress`/`removeProgress`）、AI/功能/倍速/流程配置读写、跨页自动续跑标记（`setPendingAutoStart`/`getPendingAutoStart`/`clearPendingAutoStart`）、pro/lms 集数计数。
- `Session`：停止状态持久化（`isStopped`/`begin`/`stop`），重新加载或其它标签页不自动恢复刷课。

### 视频倍速（Player.applySpeed、RateUnlock、AiWorkspace.keepAlive）

- `Player.applySpeed(media, autoplay)`：接管媒体并设速——按钮路径改写 xt 播放器速度按钮（`data-speed`/`keyt` + 模拟 mousemove + click）或直设 `playbackRate`；`autoplay` 为真时先启动播放并静音。
- `RateUnlock.ensure`：包装媒体元素的 `playbackRate` setter，拦截低于目标倍速的非手动回写（雨课堂 xt 播放器限速定时器的回写）；`isUserGesture` 放行用户手动调速；`uninstallAll` 还原。
- `AiWorkspace.keepAlive`：播放期间定时维持静音与倍速（倍速保活），媒体更换时迁移暂停拦截与倍速拦截。

### 防暂停与防切屏（Player.blockPause、PauseGuard、preventScreenCheck）

- `PauseGuard.install`：把媒体的 `pause` 替换为空方法，刷课期间吞掉页面的暂停动作，避免"页面暂停→脚本恢复"互相打架；放行判定（停止刷课/视频结束/临近结尾/任务完成）随任务安装，`uninstall`/`uninstallAll` 还原。
- `Player.blockPause`：安装暂停拦截并一次性启动播放（仅在 `play()` 被拒时重试），返回清理函数。
- `preventScreenCheck`：拦截 `visibilitychange`/`blur`/`pagehide` 监听并伪造页面前台状态，阻断切屏引发的惩罚性暂停；还原入口登记在 `PageRestore.screenCheckUndo`。

### 页面修改还原（PageRestore）

- `snapshotMedia`/`snapshotNode` 记录倍速/音量/静音与速度按钮 DOM 的原值；`restoreAll` 统一还原媒体状态、按钮 DOM、倍速/暂停拦截包装（`RateUnlock.uninstallAll`、`PauseGuard.uninstallAll`）与防切屏包装，由停止刷课流程调用，受"停止刷课后还原修改"开关控制。

### AI 答题（Solver）

- `resolveAnswerMode`：按 OCR 开关选择 ocr（截图经 Tesseract 识别）或 vision（截图直传多模态）路径。
- `capture`/`recognize`/`toImagePayload`/`prepareQuestion`：html2canvas 截图、OCR 识别、截图压缩为 JPEG 负载、按模式产出题目输入。
- `buildTextPrompt`/`buildVisionPrompt`：两种答题提示词。
- `askAI`：`GM_xmlhttpRequest` 调用 OpenAI/Anthropic 格式接口（bearer/x-api-key 鉴权）。
- `autoSelectAndSubmit`：解析"正确答案："格式的响应并勾选、提交。

### 页面流程（三个 Runner）

- `V2Runner`（*/v2/web/*）：目录列表逐项处理——视频（`handleVideo`）、批量区（`handleBatch` → `playMediaItem`/`autoCommentItem`/`handleHomework`）、课堂（`handleClassroom`）、课件与 PPT（`handleCourseware` + `waitCoursewareVideo`）；`checkCompletionStatus` 判完成，`updateProgress` 维护进度缓存。
- `ProNewRunner` / `ProOldRunner`（*/pro/lms/*）：逐集播放（视频/图文/讨论/作业分流），ProOld 仅点击条目转发到新标签页。
- `AiWorkspaceRunner`（*/ai-workspace/lms-graph/*）：按 `AiWorkspace.getRoute` 路由处理视频/音频（`handleMedia`）与作业（`handleExercise` → `solveExerciseQuestion`/`advanceExerciseQuestion`）；`autoSelect`/`handleNext` 推进任务点，`returnToSource` 返回课程目录窗口继续。
- `haltIfNoAutoSwitch`：受"自动切换下一个任务点/切换界面"开关控制，关闭时停在当前页面并清除跨页续跑标记。

### 公共工具

- `Utils`：`sleep`/`poll`/`safeJSONParse`/`isProgressDone`/`getCurrentClassroomId`/`returnUrl`/`isSupportedLearningPage`/`waitForMountTarget`/`getDDL`/`dismissPopups`。
- `AiWorkspace`：路由解析（`getRoute`）、媒体选取（`getMedia`）、播放完成判定（`isPlayerDone`）、作业定位（`getExerciseContainer`/`getExerciseQuestionBody`/`getExerciseQuestionTabs`/`isExerciseAnswered`/`getExerciseActionButton`）、可见性与文本规范化（`isVisibleElement`/`normalizeText`）。
- `Player`：`isNearEnd`/`mute`/`waitForEnd`。

### 启动与会话控制（boot、start、stopBrushing）

- `boot`：iframe 防护、挂载面板、按 `Store.getPendingAutoStart` 与课堂 ID 判定跨页自动续跑。
- `start`：记录续跑标记，按页面类型创建对应 Runner 启动。
- `stopBrushing`：停止会话、清除续跑标记，并按开关还原页面修改。
