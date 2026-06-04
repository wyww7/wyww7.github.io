// ===== TOC 滚动跟随展开 =====
(function() {
    var toc = document.getElementById('TableOfContents');
    if (!toc) return;

    function expandActive() {
        toc.querySelectorAll('.open').forEach(function(el) {
            el.classList.remove('open');
        });

        var currentLi = toc.querySelector('.active-class');
        if (!currentLi) return;

        var children = currentLi.children;
        for (var i = 1; i < children.length; i++) {
            if (children[i].tagName === 'UL' || children[i].tagName === 'OL') {
                children[i].classList.add('open');
            }
        }

        var ul = currentLi.parentElement;
        while (ul && (ul.tagName === 'UL' || ul.tagName === 'OL')) {
            ul.classList.add('open');
            ul = ul.parentElement.parentElement;
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

    toc.querySelectorAll('li').forEach(function(li) {
        observer.observe(li, { attributes: true, attributeFilter: ['class'] });
    });

    expandActive();
})();

// ===== 阅读进度条 =====
(function() {
    var bar = document.createElement('div');
    bar.id = 'reading-progress';
    document.body.prepend(bar);

    function update() {
        var scrollTop = window.scrollY || document.documentElement.scrollTop;
        var docHeight = document.documentElement.scrollHeight - window.innerHeight;
        if (docHeight > 0) {
            bar.style.width = Math.min((scrollTop / docHeight) * 100, 100) + '%';
        }
    }

    window.addEventListener('scroll', update, { passive: true });
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

// ===== 代码复制按钮移到代码框内部 + 反馈增强 =====
(function() {
    function moveButtons() {
        document.querySelectorAll('.highlight .copyCodeButton').forEach(function(btn) {
            var codeArea = btn.parentElement.querySelector('pre');
            if (codeArea && btn.parentElement !== codeArea) {
                codeArea.style.position = 'relative';
                codeArea.appendChild(btn);
            }
        });
    }

    // Stack 主题在 window.load 才创建按钮，需要延迟和观察
    if (document.readyState === 'complete') {
        setTimeout(moveButtons, 200);
    } else {
        window.addEventListener('load', function() { setTimeout(moveButtons, 200); });
    }

    // 观察后续 DOM 变化（PJAX 导航后按钮可能重新创建）
    new MutationObserver(function() {
        setTimeout(moveButtons, 100);
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
