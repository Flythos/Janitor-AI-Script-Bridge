// Janitor AI Script Bridge — lightweight syntax-highlighted code editor.
//
// No bundled highlighter exists in SillyTavern, so this rolls its own: a small
// single-pass regex tokenizer (highlightJavaScript — pure, Node-testable) and
// the classic overlay editor (createCodeEditor — a transparent <textarea>
// layered over a <pre> that renders the same text highlighted; the textarea
// keeps native editing/selection/undo, the <pre> is display-only). Both layers
// share identical font metrics and no soft-wrap, so line N aligns everywhere.
// Used by the script editor and the paste-import dialogs.

// --- tokenizer ---

const KEYWORDS = new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
    'do', 'switch', 'case', 'break', 'continue', 'new', 'class', 'extends',
    'super', 'import', 'export', 'from', 'default', 'try', 'catch', 'finally',
    'throw', 'typeof', 'instanceof', 'in', 'of', 'await', 'async', 'yield',
    'delete', 'void', 'debugger', 'static',
]);
// 'get'/'set' are intentionally not keywords: as method names (.get(/.set() they
// vastly outnumber accessor declarations in user scripts.

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this']);

// Order matters: comments → template strings → strings → numbers → words →
// whitespace → everything else. Each alternative consumes ≥1 char, so a scan
// never stalls. Trailing terminators are optional ('`?', "/*…$/") so
// half-typed code highlights instead of running to the end of the file.
const TOKEN_RE = new RegExp([
    '(?<blockComment>/\\*[\\s\\S]*?(?:\\*/|$))',
    '(?<lineComment>//[^\\n]*)',
    '(?<template>`(?:\\\\[\\s\\S]|[^`\\\\])*`?)',
    '(?<string>\'(?:\\\\.|[^\'\\\\\\n])*\'?|"(?:\\\\.|[^"\\\\\\n])*"?)',
    '(?<number>\\b0[xXoObB][\\da-fA-F_]+n?\\b|\\b\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d+)?n?\\b)',
    '(?<word>[A-Za-z_$][\\w$]*)',
    '(?<space>\\s+)',
    '(?<punct>[^\\s\\w$])',
].join('|'), 'g');

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderToken(match, re, source) {
    const g = match.groups;
    if (g.blockComment || g.lineComment) {
        return `<span class="jai-tok-comment">${escapeHtml(match[0])}</span>`;
    }
    if (g.template) {
        // Highlight ${...} interpolations inside the string token. The token is
        // already HTML-escaped here and '${' survives escaping untouched.
        const escaped = escapeHtml(match[0]);
        return `<span class="jai-tok-string">${escaped.replace(/\$\{[^{}]*\}/g, e => `<span class="jai-tok-embed">${e}</span>`)}</span>`;
    }
    if (g.string) {
        return `<span class="jai-tok-string">${escapeHtml(match[0])}</span>`;
    }
    if (g.number) {
        return `<span class="jai-tok-number">${escapeHtml(match[0])}</span>`;
    }
    if (g.word) {
        const word = match[0];
        if (KEYWORDS.has(word)) {
            return `<span class="jai-tok-keyword">${escapeHtml(word)}</span>`;
        }
        if (LITERALS.has(word)) {
            return `<span class="jai-tok-literal">${escapeHtml(word)}</span>`;
        }
        // Identifier directly followed by '(' — color it as a call.
        if (/^\s*\(/.test(source.slice(re.lastIndex))) {
            return `<span class="jai-tok-function">${escapeHtml(word)}</span>`;
        }
        return escapeHtml(word);
    }
    return escapeHtml(match[0]); // whitespace & punctuation
}

/**
 * Highlights JavaScript (and JSON — strings/numbers/keywords cover it) into
 * HTML. Whitespace is preserved verbatim; all input is HTML-escaped.
 *
 * @param {string} source
 * @returns {string} HTML
 */
export function highlightJavaScript(source) {
    const text = String(source ?? '');
    const re = new RegExp(TOKEN_RE.source, 'g'); // fresh lastIndex per call
    let html = '';
    let consumed = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
        if (match.index > consumed) {
            html += escapeHtml(text.slice(consumed, match.index));
        }
        html += renderToken(match, re, text);
        consumed = re.lastIndex;
        if (match[0].length === 0) { // paranoia: never stall on a zero-width match
            re.lastIndex++;
            consumed = re.lastIndex;
        }
    }
    if (consumed < text.length) {
        html += escapeHtml(text.slice(consumed));
    }
    return html;
}

// --- editor widget (browser-only) ---

/**
 * Builds the editor. Returns plain DOM nodes so this module stays
 * jQuery-free; callers wrap the root in $() themselves.
 *
 * @param {object} [options]
 * @param {string} [options.value] Initial code
 * @param {number} [options.height] Initial height in px (user-resizable vertically)
 * @param {string} [options.placeholder]
 * @param {string} [options.ariaLabel]
 * @param {(value: string) => void} [options.onChange] Fired after every edit
 * @returns {{ root: HTMLElement, getValue: () => string, setValue: (v: string) => void, focus: () => void }}
 */
export function createCodeEditor({ value = '', height = 340, placeholder = '', ariaLabel = 'Code editor', onChange = null } = {}) {
    if (typeof document === 'undefined') {
        throw new Error('createCodeEditor requires a DOM');
    }

    const root = document.createElement('div');
    root.className = 'jai-code-editor';
    root.style.height = `${Math.max(160, Math.round(height))}px`;

    const gutter = document.createElement('div');
    gutter.className = 'jai-ce-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    const gutterLines = document.createElement('div');
    gutterLines.className = 'jai-ce-gutter-lines';
    gutter.appendChild(gutterLines);

    const surface = document.createElement('div');
    surface.className = 'jai-ce-surface';
    const pre = document.createElement('pre');
    pre.className = 'jai-ce-layer jai-ce-highlight';
    pre.setAttribute('aria-hidden', 'true');
    const code = document.createElement('code');
    code.className = 'jai-ce-code';
    pre.appendChild(code);
    const textarea = document.createElement('textarea');
    textarea.className = 'jai-ce-layer jai-ce-input';
    textarea.spellcheck = false;
    textarea.wrap = 'off';
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('aria-label', ariaLabel);
    if (placeholder) {
        textarea.placeholder = placeholder;
    }
    surface.append(pre, textarea);
    root.append(gutter, surface);

    function render() {
        // Trailing newline: the <pre> must carry one more line than the text
        // ends with, or the last line's highlight box collapses.
        code.innerHTML = highlightJavaScript(textarea.value) + '\n';
        const lineCount = textarea.value.split('\n').length;
        let numbers = '';
        for (let i = 1; i <= lineCount; i++) {
            numbers += `${i}\n`;
        }
        gutterLines.textContent = numbers;
        syncScroll();
    }

    function syncScroll() {
        pre.scrollTop = textarea.scrollTop;
        pre.scrollLeft = textarea.scrollLeft;
        gutterLines.style.transform = `translateY(${-textarea.scrollTop}px)`;
    }

    /** Inserts text at the selection, keeping the native undo stack. */
    function insertText(text) {
        textarea.focus();
        let ok = false;
        try {
            ok = document.execCommand('insertText', false, text);
        } catch {
            ok = false;
        }
        if (!ok) {
            const start = textarea.selectionStart;
            textarea.setRangeText(text, start, textarea.selectionEnd, 'end');
        }
    }

    textarea.addEventListener('input', () => {
        render();
        if (onChange) {
            onChange(textarea.value);
        }
    });
    textarea.addEventListener('scroll', syncScroll);

    textarea.addEventListener('keydown', event => {
        // Tab inserts an indent; Shift+Tab outdents the caret's line.
        if (event.key === 'Tab' && !event.ctrlKey && !event.altKey) {
            event.preventDefault();
            if (event.shiftKey) {
                const start = textarea.selectionStart;
                const lineStart = textarea.value.lastIndexOf('\n', start - 1) + 1;
                const leading = /^[ \t]{1,4}/.exec(textarea.value.slice(lineStart, start));
                if (leading) {
                    textarea.setSelectionRange(lineStart, lineStart + leading[0].length);
                    insertText('');
                } else {
                    textarea.focus();
                }
            } else {
                insertText('    ');
            }
            return;
        }
        // Enter keeps the current line's indentation (plus one level inside an
        // open block; a lone closing brace gets its own line back at the
        // parent's level).
        if (event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.shiftKey
            && textarea.selectionStart === textarea.selectionEnd) {
            const caret = textarea.selectionStart;
            const lineStart = textarea.value.lastIndexOf('\n', caret - 1) + 1;
            const beforeCaret = textarea.value.slice(lineStart, caret);
            const indent = /^[ \t]*/.exec(beforeCaret)[0];
            const opensBlock = /\{\s*$/.test(beforeCaret);
            const closesNow = opensBlock && textarea.value.slice(caret, caret + 1) === '}';
            if (indent || opensBlock) {
                event.preventDefault();
                const insertion = `\n${indent}${opensBlock ? '    ' : ''}${closesNow ? `\n${indent}` : ''}`;
                const caretAfter = caret + insertion.length - (closesNow ? indent.length + 1 : 0);
                insertText(insertion);
                textarea.setSelectionRange(caretAfter, caretAfter);
            }
        }
    });

    function getValue() {
        return textarea.value;
    }

    function setValue(next) {
        textarea.value = String(next ?? '');
        render();
    }

    function focus() {
        textarea.focus();
    }

    setValue(value);

    return { root, getValue, setValue, focus };
}
