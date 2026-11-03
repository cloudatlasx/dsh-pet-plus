# dsh-pet-plus 🐾

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-DeepSeek%20Harness%20Web-8A2BE2">
  <img alt="base" src="https://img.shields.io/badge/based%20on-PC2005--cloud%2Fdsh--pet-5C6BC0">
  <img alt="license" src="https://img.shields.io/badge/license-MIT%20(code)-orange">
</p>

**dsh-pet-plus** 是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的增强分支：还是那只住在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里的蓝色大肥鱼，但加上了「到点提醒、审批/提问直接在宠物身上处理、多屏跟随、存储目录可配置」这些日常更顺手的能力。

> 本仓库基于 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（MIT）二次开发，动画素材、提示词与形象版权归原作者，详见文末「许可与致谢」。

---

## 相比上游多了什么

| 能力 | 说明 |
| --- | --- |
| **定时提醒** | 读取 DSH 的 `schedule` 服务，任务到点后由宠物弹出提醒气泡（20 秒自动收起），点一下可以直接处理；不再依赖插件自己维护的待办计时器。 |
| **审批 / 提问气泡** | DSH 请求审批或向你提问时，宠物身上直接出现可交互气泡：审批可选「允许一次 / 拒绝」，提问可选选项或填自定义答案，结果原路回传给 DSH；原有的内置面板会被临时接管，不操作则自动超时放行。 |
| **拍一拍音效** | 点击宠物播放 `click-duck.wav`；定时提醒到达时连响两声，提醒感更强。 |
| **多屏跟随定位** | 宠物默认落在 **DSH 窗口所在那块屏幕的右下角**（多屏时以浏览器上报的屏幕为准，桌面模式用主进程 `displayNearestPoint` 换算），换屏后自动跟随；角落与边距仍可在设置页调整。 |
| **存储目录可配置** | 数据根目录可在设置页「落盘位置」里改到任意绝对路径（也可用环境变量 `DSH_PET_HOME` 固定）。切换时会把现有配置/记忆/日志整体搬过去，目标非空则不覆盖；默认根只留一个 `home.json` 指针。 |
| **桌面模式同步** | 桌面模式（Electron 透明置顶窗）与 Web 模式共用同一套提醒/审批/提问逻辑，气泡与音效行为一致。 |

除此之外的行为与上游 0.4.x 一致：100+ 段透明动画、多开与宠物种类、拖拽甩抛物理、碎碎念与对话、语音说/听、余额展示、工作状态联动、待办、睡觉、系统通知、右键菜单等。功能细节见上游文档 [FEATURES.md](FEATURES.md)、[CONFIG.md](CONFIG.md)、[API.md](API.md)。

## 安装

### 方式一：从源码（推荐，改完即用）

```bash
git clone https://github.com/cloudatlasx/dsh-pet-plus.git
cd dsh-pet-plus/dsh-pet
pnpm install
pnpm build          # 生成 lib/ 与桌面运行壳
```

然后在 DSH 里把插件装进目标 profile（`dsh web` 用 `web`，桌面应用用 `desktop`）：

```bash
dsh plugin --profile desktop add E:\path\to\dsh-pet-plus\dsh-pet
```

装完**重开 DSH**，宠物默认出现在界面右下角。宿主半侧改动需要重开 DSH，浏览器半侧刷新页面即可。

### 方式二：已有构建产物

仓库的 Release 会附上 `dsh-pet-plus.zip`（含 `lib/`、`runtime/`、`assets/`、`cordis.patch.yml`），解压后按方式一最后一步 `dsh plugin add <解压目录>` 安装。

## 设置

- 「插件管理 → dsh-pet-plus → 设置」：
  - **审批/提问气泡**：关闭后请求交回 DSH 内置面板。
  - **定时提醒**：关闭后不再跟随 `schedule` 服务弹提醒。
  - **落盘位置**：查看并修改数据根目录（需重启 DSH 生效）。
- 位置与大小：`position.corner`（默认 `bottom-right`）、`marginX` / `marginY`；桌面模式跟随 DSH 窗口所在屏幕，浏览器模式自动上报当前屏。

## 与上游的兼容说明

为了复用已有的配置、历史数据与他人脚本，本分支**只改了分发标识**（npm 包名、Cordis patch id、仓库链接），内部运行标识保持与上游一致：

- HTTP 路由前缀仍是 `/dsh-pet-7340`
- CSS 类名仍是 `dsh-pet-*`
- 默认数据目录仍是 `$DSH_HOME/dsh-pet`（可用 `DSH_PET_HOME` 或 `home.json` 指针覆盖）
- 桌面模式 bridge scheme 仍是 `dsh-pet-bridge`

因此 `dsh-pet` 与 `dsh-pet-plus` **不要同时装**：两者会抢同一套路由与数据目录。从上游迁移时，直接把数据目录继续指向原路径即可。

## 从上游同步更新

```bash
git remote add upstream https://github.com/PC2005-cloud/dsh-pet.git   # 仅首次
git fetch upstream
git merge upstream/main        # 冲突多集中在 README / package.json / patch
pnpm --dir dsh-pet build
```

## 开发

```bash
cd dsh-pet
pnpm typecheck      # tsc
pnpm test           # node --test（2340 个用例）
pnpm build          # 构建完整产物
```

改完安装目录后，可用插件管理的「重新加载」或 `plugin_manager` 关闭再开启 `dsh-pet-plus` 生效。

## 许可与致谢

- 代码：MIT（本分支新增代码同样 MIT）
- 上游：[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)，署名见 [LICENSE](LICENSE)
- 素材（动画/提示词/源视频）：允许开源使用、**禁止商用**；二创作品须在公开渠道附上原作者地址 <https://github.com/PC2005-cloud/dsh-pet>
- 形象出处：社区二创的 DeepSeek「大肥鱼」（鲸鱼娘），非官方形象；原型「溟月」出自 B 站 [@上善无形](https://space.bilibili.com/4456176)，DeepSeek 版设计出自 [@ZipZipPipe](https://space.bilibili.com/4168597)；形象授权 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans)
