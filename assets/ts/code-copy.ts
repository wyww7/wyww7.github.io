import * as params from '@params';

export function setupCodeCopy() {
    /**
     * Add copy button to code block
     */
    const highlights = document.querySelectorAll('.article-content div.highlight');
    const copyText = params.codeblock.copy,
        copiedText = params.codeblock.copied;

    if (!navigator.clipboard) {
        /// Clipboard API is only supported in secure contexts (HTTPS)
        console.warn('Clipboard API not supported, copy button will not work.');
        return;
    }

    highlights.forEach(highlight => {
        const copyButton = document.createElement('button');
        copyButton.innerHTML = copyText;
        copyButton.classList.add('copyCodeButton');
        // 按钮放在 .highlight 上（<pre> 滚动容器的父级），避免水平滚动时被带走
        highlight.appendChild(copyButton);

        const codeBlock = highlight.querySelector('code[data-lang]');
        if (!codeBlock) return;

        copyButton.addEventListener('click', () => {
            // 只取 .cl（代码内容）中的文本，排除 .ln（行号），确保复制时不含行号
            const codeLines = codeBlock.querySelectorAll('.cl');
            const codeText = Array.from(codeLines, el => el.textContent).join('').trimEnd();

            navigator.clipboard.writeText(codeText)
                .then(() => {
                    copyButton.textContent = copiedText;

                    setTimeout(() => {
                        copyButton.textContent = copyText;
                    }, 1000);
                })
                .catch(err => {
                    alert(err);
                    console.log('Something went wrong', err);
                });
        });
    });
};
