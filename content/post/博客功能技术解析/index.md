---
title: 博客功能技术解析 — 从音乐播放器到动态背景
date: 2026-06-04
lastmod: 2026-06-04
description: 深度解析本博客的技术实现：APlayer 音乐播放器、PJAX 无刷新导航、particles.js 动态背景、自定义 LRC 歌词、暗色模式等功能的架构与修改指南，附完整代码片段和调试经验。
image: /img/River Flows in You.jpg
categories:
    - 笔记
    - Themes
tags:
    - Hugo
    - JavaScript
    - CSS
    - APlayer
    - PJAX
    - Particles.js
---

## 概览

本博客基于 Hugo 静态站点生成器 + Stack 主题构建，托管于 GitHub Pages。在主题基础上扩展了以下功能：

| 功能 | 实现方式 | 核心文件 |
|------|---------|---------|
| 音乐播放器 | APlayer + Hugo Data 模板 | `layouts/_partials/footer/custom.html` |
| 无刷新导航 | 自实现 PJAX (fetch + DOMParser) | `layouts/_partials/footer/custom.html` |
| 双重歌词 | 自定义 LRC 解析 + CSS 毛玻璃 | `layouts/_partials/footer/custom.html` + `assets/scss/custom.scss` |
| 动态粒子背景 | particles.js + 半透明 body 层 | `layouts/_partials/footer/custom.html` + `assets/background/particlesjs-config.json` |
| 暗色模式 | Stack 主题原生 + PJAX 持久化 + autofill 修复 | `layouts/_partials/footer/custom.html` + `assets/scss/custom.scss` |
| 语言切换 | i18n 下拉菜单 + Hugo 多语言 | `layouts/_partials/footer/custom.html` + `assets/scss/custom.scss` |
| 搜索框暗色适配 | CSS autofill 防护 | `assets/scss/custom.scss` |
| 归档双列布局 | 自定义模板 + CSS Grid | `layouts/archives.html` + `assets/scss/custom.scss` |

所有功能的核心代码集中在 **`layouts/_partials/footer/custom.html`**（约 560 行）和 **`assets/scss/custom.scss`**（约 1050 行）两个文件中，没有引入任何第三方 JS 框架。

---

## 一、音乐播放器

### 1.1 架构设计

```
data/music.toml ──→ Hugo 模板渲染 ──→ APlayer JS 初始化 ──→ DOM
       │                                        │
  歌曲元数据                             自定义歌词系统
  (URL/封面/LRC)                    (LRC fetch → parseLRC → tick loop)
```

三层分离：
- **数据层** `data/music.toml`：纯数据，修改歌曲不需要碰代码
- **模板层** `_partials/footer/custom.html`：Hugo 构建时将 TOML 数据注入 JS 变量
- **交互层** APlayer JS API + 自实现 LRC 系统

### 1.2 歌曲配置（`data/music.toml`）

每首歌一个 `[[music]]` 块，支持 5 个字段：

```toml
[[music]]
name   = "K歌之王"                    # 必填：歌曲名
artist = "陈奕迅"                     # 必填：艺术家
url    = "https://oss.example.com/xxx.mp3"  # 必填：音频 URL
cover  = "/img/K歌之王.jpg"          # 可选：封面图
lrc    = "/music/K歌之王.lrc"        # 可选：LRC 歌词文件路径
```

数据结构被 Hugo 的 `jsonify` 过滤器序列化后注入 JS：

```go
// 模板中的注入代码
var musicList = {{ $songs | jsonify | safeJS }};
```

注入后浏览器端收到的 JS 代码：
```js
var musicList = [
  {"name":"K歌之王","artist":"陈奕迅","url":"https://...","cover":"/img/...","lrc":"/music/..."},
  // ...更多歌曲
];
```

### 1.3 LRC 歌词系统实现

APlayer 默认的歌词功能有局限：无 LRC 的歌曲显示 "Not available" 文字，且样式不可控。因此项目自建了一套双行歌词系统。

#### LRC 解析算法

```js
function parseLRC(lrcText) {
    var lines = lrcText.split('\n');
    var result = [];
    var seenTimes = {};  // 同时间戳去重
    var tagRe = /\[(\d{2}):(\d{2})(?:[.:](\d{2,3}))?\]/;

    for (var i = 0; i < lines.length; i++) {
        var match = tagRe.exec(lines[i]);
        if (!match) continue;

        var min = parseInt(match[1], 10);
        var sec = parseInt(match[2], 10);
        var ms  = match[3] ? parseInt(match[3], 10) : 0;
        if (match[3] && match[3].length === 2) ms = ms * 10; // 兼容 [00:12.34] 和 [00:12.345]

        var time = min * 60 + sec + ms / 1000;
        var text = lines[i].replace(tagRe, '').replace(/^\s+/, '').trim();

        if (text.length > 0 && !seenTimes[time.toFixed(3)]) {
            seenTimes[time.toFixed(3)] = true;
            result.push({time: time, text: text});
        }
    }
    result.sort(function(a, b) { return a.time - b.time; });
    return result;
}
```

关键细节：
- 时间戳精确到毫秒（`toFixed(3)`），避免浮点误差
- `seenTimes` 去重：同一时间戳多行（原歌词 + 拼音/翻译）时保留第一行
- 兼容 `[00:12.34]` 和 `[00:12.345]` 两种 LRC 格式

#### 实时歌词匹配（`findCurrentAndNext`）

```js
function findCurrentAndNext(lyrics, currentTime) {
    if (!lyrics || lyrics.length === 0) return { current: null, next: null };
    var idx = 0;
    for (var i = 0; i < lyrics.length; i++) {
        if (currentTime >= lyrics[i].time) idx = i;
        else break;
    }
    var next = (idx + 1 < lyrics.length) ? lyrics[idx + 1] : null;
    return { current: lyrics[idx], next: next };
}
```

线性扫描 `O(n)`，但因 LRC 文件通常只有几十行，性能足够。

#### 渲染循环（`requestAnimationFrame`）

```js
function tick() {
    try {
        if (ap.audio && !ap.audio.paused && !lrcManuallyHidden) {
            var songName = getCurrentSongName();
            if (songName && lrcData[songName] && lrcData[songName].length > 0) {
                if (currentLrc !== lrcData[songName]) {
                    currentLrc = lrcData[songName];  // 自愈：自动关联当前歌曲
                }
                var lines = findCurrentAndNext(currentLrc, ap.audio.currentTime);
                if (lines.current && lines.current.text !== lastCurrentText) {
                    lastCurrentText = lines.current.text;
                    lrcLineEl.textContent = lines.current.text;
                    flashFade(lrcLineEl);
                }
                var nextText = lines.next ? lines.next.text : '';
                if (nextText !== lastNextText) {
                    lastNextText = nextText;
                    lrcNextEl.textContent = nextText;
                    if (nextText) flashFade(lrcNextEl);
                }
            }
        }
    } catch(e) {}
    requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```

每帧检查歌词变化，文本切换时触发 CSS `flashFade` 动画（`opacity: 0.4 → 1` 过渡）。

#### APlayer API 注意事项

**易错点**：`ap.audio` 是 HTML5 `<audio>` 元素，只有 `src`/`currentTime`/`paused` 等原生属性。歌曲元数据（`name`/`artist`/`cover`）存储在 `ap.list.audios[ap.list.index]` 中。

```js
// ✅ 正确：从播放列表获取歌曲名
function getCurrentSongName() {
    try {
        return ap.list.audios[ap.list.index].name;
    } catch(e) { return null; }
}

// ❌ 错误：ap.audio 没有 name 属性
function getCurrentSongName() {
    return ap.audio.name;  // undefined!
}
```

### 1.4 播放状态持久化

`localStorage` 键名 `aplayer_state_v2`，保存/恢复当前歌曲索引、播放进度、播放状态：

```js
function saveState() {
    var state = {
        index: ap.list.index,
        currentTime: ap.audio.currentTime,
        isPlaying: !ap.audio.paused
    };
    localStorage.setItem('aplayer_state_v2', JSON.stringify(state));
}
```

恢复时用 `ap.list.switch(saved.index)` 切到上次歌曲，通过 `loadedmetadata` + `canplay` 双事件 + 1.5s 兜底定时器确保进度恢复。

---

## 二、PJAX 无刷新导航

### 2.1 原理

不依赖任何 PJAX 库，纯 fetch + DOMParser 实现：

```
用户点击内部链接 → e.preventDefault()
     ↓
fetch(url) → response.text()
     ↓
new DOMParser().parseFromString(html, 'text/html')
     ↓
提取 doc.querySelector('main.main')
提取 doc.querySelector('aside.right-sidebar')
     ↓
替换 DOM 节点 → 同步 body.className / document.title
     ↓
history.pushState(url)
     ↓
window.Stack.init() 重新绑定主题功能
```

### 2.2 为什么不用 `innerHTML` 替换整个页面

只替换 `main.main` 和 `aside.right-sidebar` 两个区域，这样：
- **播放器 `<div id="aplayer">`** 和歌词 `<div id="custom-lrc">` 保持不变（在 main 外部）
- **particles.js 画布** `<div id="particles-js">` 保持不变
- **所有事件监听器** 保持在同一个 JS 运行环境中

### 2.3 暗色模式持久化

关键时序问题：`window.Stack.init()` 会读取 `localStorage` 中的 `StackColorScheme` 并设置 `data-scheme`，可能覆盖用户当前选择。因此 PJAX 必须在 `Stack.init()` 之后立即恢复：

```js
var savedScheme = document.documentElement.getAttribute('data-scheme');
setTimeout(function() {
    window.Stack.init();
    if (savedScheme) {
        document.documentElement.setAttribute('data-scheme', savedScheme);
    }
}, 100);
```

`setTimeout(100ms)` 是因为 Stack 主题初始化需要等待 DOM 更新完成。

### 2.4 排除规则

```js
function shouldIntercept(link) {
    if (!link.getAttribute('href').startsWith('/')) return false;  // 外链
    if (link.closest('.aplayer')) return false;                     // 播放器控件
    if (link.closest('#i18n-switch')) return false;                // 语言切换
    if (link.target || link.hasAttribute('download')) return false; // 新窗口/下载
    return true;
}
```

---

## 三、动态粒子背景

### 3.1 配置方式

`assets/background/particlesjs-config.json` 是 particles.js (Vincent Garreau, 2017) 的标准配置。Hugo 构建时 JSON 和 JS 库一同输出到 `public/background/`。

```json
{
  "particles": {
    "number": { "value": 80, "density": { "enable": true, "value_area": 800 } },
    "color": { "value": "#f4d2e2" },
    "opacity": { "value": 1, "random": false },
    "size": { "value": 4.5, "random": true },
    "line_linked": { "enable": true, "distance": 150, "color": "#f4d2e2", "opacity": 0.72, "width": 1 },
    "move": { "enable": true, "speed": 1.2, "direction": "none", "out_mode": "out" }
  },
  "interactivity": {
    "detect_on": "window",
    "events": { "onhover": { "enable": true, "mode": "grab" }, "onclick": { "enable": true, "mode": "repulse" } },
    "modes": { "grab": { "distance": 250, "line_linked": { "opacity": 1 } }, "repulse": { "distance": 285 } }
  },
  "retina_detect": true
}
```

**修改方法**：访问 [vincentgarreau.com/particles.js](https://vincentgarreau.com/particles.js/) 生成 JSON → 覆盖 `assets/background/particlesjs-config.json` → `hugo` 重新构建。

### 3.2 CSS 层叠上下文挑战

这是整个项目中最棘手的 CSS 问题。粒子画布（`<canvas>`）需要：
- 在页面内容**下面**（z-index 低）
- 在 body 背景**上面**（否则被 body 的不透明背景挡住）

解决方案：不让 body 完全不透明，而是用 85% 不透明度的半透明背景：

```css
body {
    background: rgba(245, 245, 250, 0.85) !important;
}
[data-scheme="dark"] body {
    background: rgba(48, 48, 48, 0.85) !important;
}
#particles-js {
    position: fixed;
    z-index: -1;  /* 在 body 背景下方，通过 body 半透明可见 */
    pointer-events: none;
}
```

`rgba(245,245,250,0.85)` 代表浅色模式下 15% 的透明度让粒子透出；卡片（`article`）有 100% 不透明背景色，内容完全不受影响。

### 3.3 加载时序

particles.js 在 `<script src="...">` 同步加载后立即调用 `particlesJS.load()`，不等待 DOMContentLoaded。

```html
<div id="particles-js"></div>
<script src="/background/particles.min.js"></script>
<script>
  particlesJS.load('particles-js', '/background/particlesjs-config.json', function() {
    console.log('particles.js loaded');
  });
</script>
```

---

## 四、暗色模式

### 4.1 CSS 变量机制

Stack 主题在 `<html>` 上设置 `data-scheme` 属性，通过 CSS 属性选择器切换变量：

```css
:root {
    --body-background: #f5f5fa;       /* 浅色 */
    --card-background: #fff;
    --body-text-color: #707070;
}
:root[data-scheme="dark"] {
    --body-background: #303030;       /* 深色 */
    --card-background: #424242;
    --body-text-color: rgba(255,255,255,0.7);
}
```

所有 UI 组件使用 `var(--body-background)` 等变量，自动适配明暗切换。

### 4.2 搜索框 Chrome autofill 修复

Chrome 在识别到 `<input name="keyword">` 后会注入 autofill 样式，覆盖自定义背景色。解决方案：

```scss
input[name="keyword"] {
    -webkit-text-fill-color: var(--card-text-color-main);

    &:-webkit-autofill,
    &:-webkit-autofill:hover,
    &:-webkit-autofill:focus,
    &:-webkit-autofill:active {
        -webkit-text-fill-color: var(--card-text-color-main) !important;
        -webkit-box-shadow: 0 0 0 1000px var(--card-background) inset !important;
        transition: background-color 5000s ease-in-out 0s;
    }
}
```

核心技巧：Chrome autofill 不认 `background` CSS 属性，但认 `-webkit-box-shadow: inset`。用 1000px 的内阴影模拟背景色填充整个输入框。`transition: 5000s` 阻止 autofill 的白色→主题色的过渡动画闪烁。

### 4.3 暗色模式按钮的 CSS 层级

```scss
#dark-mode-toggle {
    width: auto !important;
    align-self: flex-start !important;  // 阻止 flex 容器横向拉伸
}
```

`align-self: flex-start` 是因为主题 CSS 中 `#main-menu li { width: 100% }` 会导致按钮占满整行。

---

## 五、i18n 语言切换

### 5.1 下拉菜单实现

```scss
#i18n-switch {
    position: relative;
    z-index: 10;  // 关键：创建独立层叠上下文，防止暗色模式按钮穿透

    .i18n-menu {
        position: absolute;
        z-index: 100;
        opacity: 0;
        visibility: hidden;
        transform: translateY(10px) scale(0.95);
        transition: opacity 0.2s, visibility 0.2s, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .i18n-dropdown.open .i18n-menu {
        opacity: 1;
        visibility: visible;
        transform: translateY(0) scale(1);
    }
}
```

动画使用 `cubic-bezier(0.34, 1.56, 0.64, 1)` 产生弹性回弹效果。`opacity` + `visibility` 双属性控制是为了让隐藏状态下完全不可交互。

### 5.2 JS 控制

```js
var dropdown = document.querySelector('.i18n-dropdown');
var toggleBtn = dropdown.querySelector('[data-toggle]');
toggleBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    dropdown.classList.toggle('open');
});
// 点击外部或按 Escape 关闭
```

> ⚠️ 此处踩过一个坑：最初用 `document.getElementById('i18n-dropdown')` 获取元素，但 `.i18n-dropdown` 是 class 不是 id，导致 JS 完全无效。改为 `querySelector('.i18n-dropdown')` 解决。

---

## 六、项目结构速查

```
dev/
├── assets/
│   ├── background/
│   │   ├── particles.min.js               # particles.js 库 (23KB)
│   │   └── particlesjs-config.json        # 粒子配置 ← 修改粒子效果
│   └── scss/
│       └── custom.scss                    # 全部自定义样式 ← 修改 UI
├── config/_default/
│   ├── config.toml                        # Hugo 主配置
│   └── languages.toml                     # 多语言配置
├── content/post/                          # 博客文章 (.md)
├── data/
│   └── music.toml                         # 歌曲列表 ← 加歌/改歌
├── layouts/
│   ├── _partials/
│   │   ├── footer/custom.html             # ← 核心文件 (560行)
│   │   └── sidebar/left.html              # 侧边栏覆盖
│   ├── partials/
│   │   ├── head/custom.html               # APlayer CSS 引用
│   │   └── head/custom-font.html          # 系统字体栈 (替代 Google Fonts)
│   ├── archives.html                      # 归档页 (双列 Grid)
│   └── _default/terms.html                # 分类页
├── static/
│   ├── lib/aplayer/                       # APlayer v1.10.1 本地库
│   │   ├── APlayer.min.css
│   │   └── APlayer.min.js
│   ├── img/                               # 封面图等
│   └── music/                             # LRC 歌词文件
├── themes/hugo-theme-stack/               # 主题 (git submodule)
└── deploy.bat                             # 一键部署脚本
```

### 修改速查表

| 需求 | 文件 | 怎么改 |
|------|------|--------|
| 加一首歌 | `data/music.toml` | 追加 `[[music]]` 块 |
| 改粒子颜色/密度 | `assets/background/particlesjs-config.json` | 改 JSON 字段 |
| 调播放器样式 | `assets/scss/custom.scss` | APlayer 块 |
| 调歌词样式 | `assets/scss/custom.scss` | `#custom-lrc` 块 |
| 改 PJAX 行为 | `layouts/_partials/footer/custom.html` | PJAX 块 |
| 改粒子透明度 | `layouts/_partials/footer/custom.html` | `<style>` 中 body background rgba |
| 加新侧边栏功能 | `layouts/_partials/footer/custom.html` | 追加 `<script>` |
| 更换背景类型 | `layouts/_partials/footer/custom.html` | 替换 particles.js 部分 |
| 改搜索框样式 | `assets/scss/custom.scss` | `.search-form` 块 |

---

## 七、调试经验总结

1. **Hugo 模板路径**：Stack 主题使用 `_partials` 目录，自定义模板必须放在 `layouts/_partials/`（带下划线），不是 `layouts/partials/`
2. **Hugo 0.156+ 弃用**：`site.Data` 替换为 `hugo.Data`，避免构建警告
3. **APlayer API**：`ap.audio` 是 HTML5 Audio 元素（有 currentTime/paused/volume），歌曲元数据在 `ap.list.audios[index]`（有 name/artist/cover/lrc）
4. **CSS 层叠上下文**：`z-index: -1` 的 fixed 元素在 body 背景下方，需要 body 半透明才能看见
5. **Chrome autofill**：用 `-webkit-box-shadow: inset` 替代 `background` 设置输入框背景色
6. **所有功能集中在两个文件**——便于维护，但修改时要小心不要破坏其他功能

---

*本文由 Claude (Anthropic) 对博客项目进行全面审计与优化后撰写，记录项目的技术架构和实现细节。*

*2026 年 6 月 4 日*
