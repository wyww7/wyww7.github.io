// ===== TOC 滚动跟随展开 =====
// PJAX 兼容：init() 暴露在 window.__TOC__ 上，PJAX 导航后调用即可重新绑定新 DOM
//
// 修复说明：
// scrollspy 只在 scroll/resize 事件时设置 active-class，页面首次加载时 scrollY=0，
// 所有 heading 的 offsetTop 都大于 scrollY，所以 scrollspy 不会设置任何 active-class。
// 嵌套 OL 默认 display:none，子目录不展开。
//
// 修复方案：
// 1. 初始加载时展开根 OL 下所有顶层 li 的直接子 OL
// 2. window.__TOC__ 必须在 init() 之前赋值（首页无 TOC 时 init() 会提前 return）
(function() {
    function init() {
        var toc = document.getElementById('TableOfContents');
        if (!toc) return;

        function expandActive() {
            var currentLi = toc.querySelector('.active-class');
            if (!currentLi) return;

            var allOpen = toc.querySelectorAll('.open');
            for (var j = 0; j < allOpen.length; j++) {
                allOpen[j].classList.remove('open');
            }

            var children = currentLi.children;
            for (var i = 0; i < children.length; i++) {
                var child = children[i];
                if (child.tagName === 'UL' || child.tagName === 'OL') {
                    child.classList.add('open');
                }
            }

            var el = currentLi.parentElement;
            while (el && el !== toc) {
                if (el.tagName === 'UL' || el.tagName === 'OL') {
                    el.classList.add('open');
                }
                el = el.parentElement;
            }
        }

        function expandInitial() {
            var rootOl = toc.querySelector(':scope > ol');
            if (!rootOl) return;

            var topLis = rootOl.children;
            for (var i = 0; i < topLis.length; i++) {
                var li = topLis[i];
                if (li.tagName !== 'LI') continue;
                var liChildren = li.children;
                for (var j = 0; j < liChildren.length; j++) {
                    var child = liChildren[j];
                    if (child.tagName === 'UL' || child.tagName === 'OL') {
                        child.classList.add('open');
                    }
                }
            }
        }

        var observer = new MutationObserver(function(mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var m = mutations[i];
                if (m.attributeName === 'class' && m.target.classList.contains('active-class')) {
                    expandActive();
                    break;
                }
            }
        });

        var allLis = toc.querySelectorAll('li');
        for (var k = 0; k < allLis.length; k++) {
            observer.observe(allLis[k], { attributes: true, attributeFilter: ['class'] });
        }

        expandInitial();
    }

    window.__TOC__ = { init: init };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { init(); });
    } else {
        init();
    }
})();

// ===== 阅读进度条 =====
// 滚动时显示，停止后 1.5s 淡出。暗色模式使用蓝紫色渐变。
// Width 使用 CSS transition + bar.style.width (不使用 !important，避免与 CSS transition 冲突)
(function() {
    var bar = document.getElementById('reading-progress');
    if (bar) return;

    bar = document.createElement('div');
    bar.id = 'reading-progress';
    document.body.prepend(bar);

    var hideTimer = null;

    function update() {
        var scrollTop = window.scrollY || document.documentElement.scrollTop;
        var docHeight = document.documentElement.scrollHeight - window.innerHeight;
        if (docHeight > 0) {
            bar.style.width = Math.min((scrollTop / docHeight) * 100, 100) + '%';
        }
    }

    function show() {
        bar.classList.add('visible');
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(function() {
            bar.classList.remove('visible');
        }, 1500);
    }

    window.addEventListener('scroll', function() {
        update();
        show();
    }, { passive: true });

    update();
})();

// ===== 回到顶部按钮 =====
(function() {
    var btn = document.createElement('div');
    btn.id = 'back-to-top';
    btn.title = '回到顶部';
    document.body.appendChild(btn);

    function update() {
        if (window.scrollY > 400 || document.documentElement.scrollTop > 400) {
            btn.classList.add('visible');
        } else {
            btn.classList.remove('visible');
        }
    }

    document.addEventListener('scroll', update, { passive: true });
    window.addEventListener('scroll', update, { passive: true });

    btn.addEventListener('click', function() {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    update();
})();

// ===== 代码复制按钮保持在 .highlight 上（pre 的外面），避免水平滚动时被带走 =====
(function() {
    function keepButtonOnHighlight() {
        document.querySelectorAll('.highlight .copyCodeButton').forEach(function(btn) {
            var highlight = btn.closest('.highlight');
            if (highlight && btn.parentElement !== highlight) {
                highlight.appendChild(btn);
            }
        });
    }

    if (document.readyState === 'complete') {
        setTimeout(keepButtonOnHighlight, 200);
    } else {
        window.addEventListener('load', function() { setTimeout(keepButtonOnHighlight, 200); });
    }

    new MutationObserver(function() {
        setTimeout(keepButtonOnHighlight, 100);
    }).observe(document.body, { childList: true, subtree: true });

    document.addEventListener('click', function(e) {
        var btn = e.target.closest('.copyCodeButton');
        if (!btn) return;

        btn.classList.add('copied');

        function revert() {
            btn.classList.remove('copied');
            btn.removeEventListener('mouseleave', revert);
        }
        btn.addEventListener('mouseleave', revert, { once: true });
    });
})();
