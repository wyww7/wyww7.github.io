# Hugo Blog Project — AI Onboarding Guide

> 写给下一个 Claude 会话的快速上手指南。每次重大修改后请更新本文档的 `lastmod` 字段。

**项目路径**: `C:\software\other\hugo\hugo_extended_withdeploy_0.161.1_windows-amd64\dev`
**Hugo 版本**: extended 0.161.1
**主题**: hugo-theme-stack (v4.0.2)
**部署**: GitHub Pages → `https://wyww7.github.io`
**lastmod**: 2026-06-04

---

## 一、快速启动

```powershell
# 开发服务器
cd C:\software\other\hugo\hugo_extended_withdeploy_0.161.1_windows-amd64\dev
..\hugo.exe server --noHTTPCache --port 1313
# → http://localhost:1313/

# 生产构建 + 部署
.\deploy.bat
```

---

## 二、核心文件地图

```
dev/
├── CLAUDE.md                              ← 你正在读的文件
├── deploy.bat                             # 一键部署脚本
├── assets/
│   ├── scss/custom.scss                   # 所有自定义 CSS (1050行)
│   └── background/
│       ├── particles.min.js               # 粒子库 (23KB, Vincent Garreau 2017)
│       └── particlesjs-config.json        # 粒子配置 (在线生成器可改)
├── data/music.toml                        # 歌曲列表 (添加歌曲只改这个)
├── layouts/
│   ├── _partials/footer/custom.html       # 核心文件 (560行)
│   │   # 包含: particles.js、PJAX、i18n、APlayer、LRC歌词、状态持久化、暗色模式
│   ├── _partials/sidebar/left.html        # 侧边栏覆盖
│   ├── partials/head/
│   │   ├── custom.html                    # APlayer CSS 引用
│   │   └── custom-font.html              # 系统字体栈 (替代 Google Fonts)
│   ├── archives.html                      # 归档页 (双列 Grid)
│   └── _default/terms.html                # 分类页
├── static/
│   ├── lib/aplayer/                       # APlayer v1.10.1 (本地化)
│   ├── img/                               # 封面图等
│   └── music/                             # LRC 歌词文件
├── content/post/                          # 博客文章
└── themes/hugo-theme-stack/               # 主题 (不要直接改)
```

---

## 三、关键功能实现

### 3.1 APlayer 音乐播放器 (`_partials/footer/custom.html` L204-559)

**数据流**: `data/music.toml` → Hugo `jsonify` → JS `musicList` → `new APlayer()`

**APlayer API 重点**:
- `ap.audio` = HTML5 `<audio>` 元素 — 只有 `currentTime`/`paused`/`src`/`volume`
- `ap.list.audios[ap.list.index]` = 当前歌曲元数据 — 有 `name`/`artist`/`cover`/`lrc`
- ⚠️ **曾踩坑**: 误以为 `ap.audio.name` 能获取歌名，实际上 `ap.audio` 没有 `name` 属性

**LRC 歌词系统**:
- `parseLRC()`: 正则 `/\[(\d{2}):(\d{2})(?:[.:](\d{2,3}))?\]/` 解析时间标签
- 同时间戳去重: `seenTimes` 对象，保留首次出现的文本
- `requestAnimationFrame(tick)` 每帧轮询 `ap.audio.currentTime` 匹配歌词
- 双行显示: `#custom-lrc-line` (当前行，bold) + `#custom-lrc-next` (下一行，faded)
- 歌词按钮劫持: `bindLrcButton()` 监听 `.aplayer-icon-lrc` 点击

**状态持久化**:
- localStorage key: `aplayer_state_v2`
- 保存: `play`/`pause`/`ended`/`listswitch`/`seeked` 事件 + 3s 定时 + 页面卸载
- 恢复: `loadedmetadata` + `canplay` 双事件 + 1.5s 兜底

### 3.2 PJAX 无刷新导航 (`_partials/footer/custom.html` L32-172)

**原理**: fetch + DOMParser → 替换 `main.main` + `aside.right-sidebar` → history.pushState

**为什么只替换两个区域**:
- 播放器 `<div id="aplayer">` 在 main 外部 → 不受 PJAX 影响
- 粒子 `<div id="particles-js">` 在页面底部 → 保持不变
- 所有 JS 运行环境不变 → 无需重新初始化播放器

**暗色模式持久化问题**:
- `window.Stack.init()` 会读取 localStorage 覆盖 `data-scheme`
- 必须在 `init()` 后 `setTimeout(100ms)` 恢复保存的值

**排除规则**: `#i18n-switch`、`.aplayer`、外链、hash 链接

### 3.3 动态粒子背景 (`_partials/footer/custom.html` L1-30)

**CSS 层叠上下文** (整个项目最复杂的 CSS 问题):
- `#particles-js { z-index: -1 }` → 在 body 背景下方
- `body { background: rgba(245,245,250,0.85) !important }` → 浅色 85% 不透明
- `[data-scheme="dark"] body { background: rgba(48,48,48,0.85) !important }` → 暗色 85%
- 15% 透明度让粒子隐约透出，卡片 (article) 100% 不透明不受影响

**曾踩坑**:
- `height: 100%` vs `100vh` → `position: fixed` 用 `100%` 即视口高度，不需改
- `z-index: 0` 会让粒子浮在卡片上方 → 最终用 `-1`
- `html, body { background: transparent !important }` → 彻底破坏暗色模式 → 回滚
- `resources.Get` 的 `.Permalink` 生成绝对 URL → 本地 localhost 404 → 改用 `.RelPermalink`
- `safeJS` 过滤器会去掉引号 → JSON 路径变正则表达式 → 直接手写引号 `'{{ ... }}'`

### 3.4 暗色模式

**机制**: `<html data-scheme="light|dark">` → CSS `[data-scheme="dark"]` 选择器切换变量

**Chrome autofill 修复** (在 `custom.scss` 搜索框块):
- Chrome 的 `:-webkit-autofill` 不接受 `background` 属性
- 用 `-webkit-box-shadow: 0 0 0 1000px var(--card-background) inset !important` 替代
- `transition: 5000s` 阻止 autofill 动画闪烁

**暗色模式按钮宽度问题**:
- 主题 `#main-menu li { width: 100% }` 让按钮占满整行
- 用 `align-self: flex-start !important` 限制到内容宽度

### 3.5 i18n 语言切换 (`_partials/footer/custom.html` L175-201)

**曾踩坑**:
- HTML 中是 `class="i18n-dropdown"` 不是 `id="i18n-dropdown"`
- 所以 `getElementById('i18n-dropdown')` 返回 null → 死代码
- 修复: `querySelector('.i18n-dropdown')`

**下拉菜单穿透问题**:
- 暗色模式按钮和语言切换是相邻 `<li>`
- `z-index: 100` 的下拉菜单被后一个 `<li>` 穿透
- 修复: `#i18n-switch { position: relative; z-index: 10 }` 创建独立层叠上下文

---

## 四、修改速查表

| 需求 | 文件 | 怎么改 |
|------|------|--------|
| 加一首歌 | `data/music.toml` | 追加 `[[music]]` 块 |
| 改粒子颜色/密度 | `assets/background/particlesjs-config.json` | 改 JSON (可用在线生成器) |
| 调播放器样式 | `assets/scss/custom.scss` | 搜索 "APlayer" 块 |
| 调歌词样式 | `assets/scss/custom.scss` | 搜索 `#custom-lrc` |
| 改 PJAX 行为 | `layouts/_partials/footer/custom.html` | 搜索 "PJAX" |
| 改粒子透明度 | `layouts/_partials/footer/custom.html` | 搜索 "rgba" 在 `<style>` 中 |
| 加新侧边栏功能 | `layouts/_partials/footer/custom.html` | 末尾追加 `<script>` |
| 更换背景类型 | `layouts/_partials/footer/custom.html` | 替换 particles.js 块 |
| 改搜索框样式 | `assets/scss/custom.scss` | 搜索 `.search-form` |

---

## 五、曾踩过的坑 (Lessons Learned)

1. **Hugo `_partials` vs `partials`**: Stack 主题用 `_partials` (下划线)，用户模板也必须用 `layouts/_partials/` 覆盖。放 `layouts/partials/` 不会被 Hugo 读取。

2. **`ap.audio` 不是歌曲对象**: 它是 `<audio>` 元素。歌曲名/歌手/LRC 路径在 `ap.list.audios[ap.list.index]` 中。

3. **Hugo `resources.Get` + `.Permalink`**: 本地 dev 时生成生产域名 URL (`https://wyww7.github.io/...`)，导致文件 404。改用 `.RelPermalink`。

4. **`safeJS` 过滤器**: 会去掉字符串引号。`{{ .RelPermalink | safeJS }}` 输出 `/path` (无引号，JS 报错)。正确: `'{{ .RelPermalink }}'`。

5. **CSS `z-index: -1` + body 背景**: `z-index: -1` 的 fixed 元素在 body 背景下方。想让元素可见，body 必须半透明。

6. **`!important` 破坏暗色模式**: 不要用 `background: transparent !important` 覆盖 body，会导致 `data-scheme` 颜色变量失效。

7. **Chrome autofill 只能用 box-shadow**: `background` 属性对 `:-webkit-autofill` 无效。

8. **Hugo `hugo.Data` 替换 `site.Data`**: Hugo 0.156+ 弃用 `site.Data`/`.Site.Data`。

---

## 六、构建与部署

```powershell
# 开发 (热重载)
..\hugo.exe server --noHTTPCache --port 1313

# 生产
rm -r public resources
..\hugo.exe --gc

# 一键部署
.\deploy.bat
# 步骤: git push source → hugo build → git push gh-pages
```

构建警告 `Failed to fetch remote resource: encrypted-tbn0.gstatic.com` 是部分旧文章引用了 Google 图片链接导致的网络超时，不影响构建结果，可忽略。

---

*本文档由 Claude (Anthropic) 在 2026-06-04 项目审计后生成，用于后续会话快速接手。*
