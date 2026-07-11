'use strict';
const obsidian = require('obsidian');

/*
 * Tab Indent (Notion-style) — ZWSP+NBSP 방식
 * 줄 맨 앞 ZWSP(폭0, U+200B) 1개 + NBSP(U+00A0) 들여쓰기. ZWSP가 맨 앞이라
 * "공백으로 시작"하지 않아 Obsidian/블로그 모두 코드블록으로 보지 않는다.
 *
 *  - Tab        : 한 단계 들여쓰기 (일반/빈 줄). 진짜 리스트는 기본 동작.
 *  - Shift+Tab  : 한 단계 해제 (마지막 단계면 ZWSP까지).
 *  - Enter      : 다음 줄에 같은 들여쓰기 유지 (IME 안전 + 새 줄 생성 재시도).
 *  - Backspace  : 들여쓰기 영역에선 한 단계(NBSP 4개, 마지막이면 ZWSP까지) 한 번에 삭제.
 */
const ZWSP = String.fromCharCode(0x200B);
const NBSP = String.fromCharCode(0x00A0);
const LEVEL = 4;
const RE_INDENT = new RegExp('^(' + ZWSP + NBSP + '+)');          // ZWSP + NBSP들 (전체 들여쓰기)
const RE_SPLIT = new RegExp('^(' + ZWSP + ')(' + NBSP + '*)');    // (ZWSP)(NBSP들)

module.exports = class TabIndentNotion extends obsidian.Plugin {
  onload() {
    this.registerDomEvent(document, 'keydown', this.onKeyDown.bind(this), { capture: true });
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
    // preventDefault 하지 않고, 기본 Enter가 새 줄을 "실제로 만든 뒤"에 들여쓰기를 붙인다.
    // setTimeout(0) 한 번은 Obsidian이 새 줄을 만들기 전에 실행될 수 있어(타이밍),
    // 새 줄이 생길 때까지 몇 번 재시도한다.
    if (key === 'Enter') {
      if (evt.shiftKey || from.line !== to.line || from.ch !== to.ch) return;
      if (evt.isComposing) return;                                // 한글 조합 중엔 건드리지 않음 (IME 안전)
      const m = line.match(RE_INDENT);
      if (!m) return;
      const indent = m[1];
      // 새 줄 + 같은 들여쓰기를 '한 번에' 삽입 → 비동기 race 없음(들여쓰기 유실 방지).
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
      if (from.ch === 1) {                                        // ZWSP 바로 뒤
        const removeNbsp = Math.min(LEVEL, m[2].length);
        removeStart = 0; removeEnd = 1 + removeNbsp;
      } else {
        const removeNbsp = Math.min(LEVEL, from.ch - 1);
        removeStart = from.ch - removeNbsp;
        removeEnd = from.ch;
        if (m[2].length - removeNbsp === 0) removeStart = 0;      // 마지막 단계 → ZWSP까지
      }
      editor.replaceRange('', { line: from.line, ch: removeStart }, { line: from.line, ch: removeEnd });
      editor.setCursor({ line: from.line, ch: removeStart });
      return;
    }
  }
};
