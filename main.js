'use strict';
const obsidian = require('obsidian');

/*
 * Tab Indent (Notion-style) — ZWSP+NBSP 방식
 * 줄 맨 앞 ZWSP(폭0, U+200B) 1개 + NBSP(U+00A0) 들여쓰기. ZWSP가 맨 앞이라
 * "공백으로 시작"하지 않아 Obsidian/블로그 모두 코드블록으로 보지 않는다.
 *
 *  - Tab / Shift+Tab : 한 단계 들여쓰기 / 해제
 *  - Enter           : 다음 줄에 같은 들여쓰기 유지 (원자적, IME 안전)
 *  - Backspace       : 들여쓰기 한 단계 삭제
 */
const ZWSP = String.fromCharCode(0x200B);
const NBSP = String.fromCharCode(0x00A0);
const LEVEL = 4;
const RE_INDENT = new RegExp('^(' + ZWSP + NBSP + '+)');          // ZWSP + NBSP들 (전체 들여쓰기)
const RE_SPLIT = new RegExp('^(' + ZWSP + ')(' + NBSP + '*)');    // (ZWSP)(NBSP들)

// ── 감긴 줄(soft-wrap) 도 들여쓰기 유지: CM6 라인 데코레이션(행잉 인덴트) ──
// text-indent(-W) + padding-inline-start(W). W = 앞쪽 NBSP 실제 픽셀 폭.
// @codemirror 모듈이 없으면 조용히 비활성(로드는 안 깨짐).
let cmExt = null;
try {
  const cmView = require('@codemirror/view');
  const cmState = require('@codemirror/state');
  const ViewPlugin = cmView.ViewPlugin, Decoration = cmView.Decoration;
  const RangeSetBuilder = cmState.RangeSetBuilder;
  let NBSP_PX = 0;
  const measure = (view) => {
    try {
      const cs = getComputedStyle(view.contentDOM);
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;top:-9999px;left:-9999px;';
      span.style.fontFamily = cs.fontFamily; span.style.fontSize = cs.fontSize;
      span.style.fontWeight = cs.fontWeight; span.style.letterSpacing = cs.letterSpacing;
      span.textContent = NBSP.repeat(20);
      document.body.appendChild(span);
      const w = span.getBoundingClientRect().width / 20;
      span.remove();
      if (w > 0) NBSP_PX = w;
    } catch (e) {}
  };
  const build = (view) => {
    if (!NBSP_PX) measure(view);
    const b = new RangeSetBuilder();
    for (const rng of view.visibleRanges) {
      let pos = rng.from;
      while (pos <= rng.to) {
        const ln = view.state.doc.lineAt(pos);
        const m = ln.text.match(RE_INDENT);
        if (m) {
          const px = Math.round((m[1].length - 1) * (NBSP_PX || 6));
          b.add(ln.from, ln.from, Decoration.line({
            attributes: { style: 'text-indent:-' + px + 'px;padding-inline-start:' + px + 'px;' }
          }));
        }
        pos = ln.to + 1;
      }
    }
    return b.finish();
  };
  cmExt = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = build(view); }
    update(u) {
      if (u.geometryChanged) NBSP_PX = 0;
      if (u.docChanged || u.viewportChanged || u.geometryChanged) this.decorations = build(u.view);
    }
  }, { decorations: v => v.decorations });
} catch (e) { cmExt = null; }

module.exports = class TabIndentNotion extends obsidian.Plugin {
  onload() {
    this.registerDomEvent(document, 'keydown', this.onKeyDown.bind(this), { capture: true });
    if (cmExt) { try { this.registerEditorExtension(cmExt); } catch (e) {} }
  }

  onKeyDown(evt) {
    const key = evt.key;
    if (key !== 'Tab' && key !== 'Enter' && key !== 'Backspace') return;
    if (evt.metaKey || evt.ctrlKey || evt.altKey) return;         // 조합키는 건드리지 않음

    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view || view.getMode() !== 'source') return;
    const editor = view.editor;
    if (!editor || !editor.hasFocus()) return;

    const from = editor.getCursor('from');
    const to = editor.getCursor('to');
    const line = editor.getLine(from.line);

    // ===== Enter: 다음 줄에 같은 들여쓰기 유지 (IME 안전) =====
    if (key === 'Enter') {
      if (evt.shiftKey || from.line !== to.line || from.ch !== to.ch) return;
      if (evt.isComposing) return;                                // 한글 조합 중엔 건드리지 않음
      const m = line.match(RE_INDENT);
      if (!m) return;
      const indent = m[1];
      // 새 줄 + 같은 들여쓰기를 '한 번에' 삽입 → race 없음(들여쓰기 유실 방지).
      evt.preventDefault(); evt.stopPropagation();
      editor.replaceRange('\n' + indent, from, from);
      editor.setCursor({ line: from.line + 1, ch: indent.length });
      return;
    }

    // ↓ Tab / Backspace 는 한글 조합 중엔 비간섭
    if (evt.isComposing) return;

    // ===== Tab / Shift+Tab =====
    if (key === 'Tab') {
      if (from.line !== to.line) return;                          // 여러 줄 선택 → 기본
      if (/^[ \t]*([-*+]|\d+\.)\s/.test(line)) return;            // 진짜 리스트 → 기본

      if (evt.shiftKey) {
        const m = line.match(RE_SPLIT);
        if (m && m[2].length > 0) {
          evt.preventDefault(); evt.stopPropagation();
          const removeNbsp = Math.min(LEVEL, m[2].length);
          const removeStart = (m[2].length - removeNbsp === 0) ? 0 : 1;
          const removeEnd = 1 + removeNbsp;
          const removed = removeEnd - removeStart;
          editor.replaceRange('', { line: from.line, ch: removeStart }, { line: from.line, ch: removeEnd });
          editor.setCursor({ line: from.line, ch: Math.max(0, from.ch - removed) });
        }
        return;
      }

      evt.preventDefault(); evt.stopPropagation();
      const hasZ = line.charCodeAt(0) === 0x200B;
      const insert = hasZ ? NBSP.repeat(LEVEL) : (ZWSP + NBSP.repeat(LEVEL));
      const at = hasZ ? 1 : 0;
      editor.replaceRange(insert, { line: from.line, ch: at });
      const shift = (from.ch >= at) ? insert.length : 0;
      editor.setCursor({ line: from.line, ch: from.ch + shift });
      return;
    }

    // ===== Backspace: 들여쓰기 한 단계 한 번에 삭제 =====
    if (key === 'Backspace') {
      if (evt.shiftKey) return;
      if (from.line !== to.line || from.ch !== to.ch) return;     // 선택 있음 → 기본
      const m = line.match(RE_SPLIT);
      if (!m || m[2].length === 0) return;                        // 들여쓰기 없음 → 기본
      const indentEnd = 1 + m[2].length;
      if (from.ch < 1 || from.ch > indentEnd) return;             // 커서가 들여쓰기 밖 → 기본
      evt.preventDefault(); evt.stopPropagation();
      let removeStart, removeEnd;
      if (from.ch === 1) {
        const removeNbsp = Math.min(LEVEL, m[2].length);
        removeStart = 0; removeEnd = 1 + removeNbsp;
      } else {
        const removeNbsp = Math.min(LEVEL, from.ch - 1);
        removeStart = from.ch - removeNbsp;
        removeEnd = from.ch;
        if (m[2].length - removeNbsp === 0) removeStart = 0;
      }
      editor.replaceRange('', { line: from.line, ch: removeStart }, { line: from.line, ch: removeEnd });
      editor.setCursor({ line: from.line, ch: removeStart });
      return;
    }
  }
};
