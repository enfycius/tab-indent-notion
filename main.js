'use strict';
const obsidian = require('obsidian');

/*
 * Tab Indent (Notion-style)
 *  - 일반 텍스트: 줄 앞 ZWSP(U+200B)+NBSP(U+00A0) 로 들여쓰기 (코드블록 안 됨, 실제 저장됨)
 *  - 리스트/체크박스: 줄 끝에 숨김 마커 <!--ti:N--> 로 "레벨"만 저장하고, 편집기에서
 *    CM6 데코레이션으로 시각적으로만 들여쓴다. 마커는 줄 끝이라 `- [ ]` 마커가 안 깨져
 *    체크박스가 정상 렌더된다. (부모 없는 단독 체크박스도 자유롭게 들여쓰기 가능 = Notion식)
 *
 *  Tab / Shift+Tab : 한 단계 들여쓰기 / 해제
 *  Enter           : 일반 텍스트는 같은 들여쓰기 유지 (리스트는 Obsidian 기본)
 *  Backspace       : 일반 텍스트 들여쓰기 한 단계 삭제
 */
const ZWSP = String.fromCharCode(0x200B);
const NBSP = String.fromCharCode(0x00A0);
const LEVEL = 4;
const INDENT_EM = 1.7;                                            // 리스트 시각 들여쓰기: 레벨당 em
const RE_INDENT = new RegExp('^(' + ZWSP + NBSP + '+)');          // ZWSP + NBSP들 (일반 텍스트 들여쓰기)
const RE_SPLIT = new RegExp('^(' + ZWSP + ')(' + NBSP + '*)');    // (ZWSP)(NBSP들)
const RE_LISTLINE = new RegExp('^[\\s' + ZWSP + NBSP + ']*(?:[-*+]|\\d+[.)])\\s'); // 리스트/체크박스
const RE_MARK = /\s*<!--ti:(\d+)-->\s*$/;                         // 리스트 시각 들여쓰기 마커
const RE_LEADING = new RegExp('^[\\s' + ZWSP + NBSP + ']+');      // 줄 앞 공백/ZWSP/NBSP

function markLevel(text) { const m = text.match(RE_MARK); return m ? parseInt(m[1], 10) : 0; }
function listBody(text) { return text.replace(RE_MARK, '').replace(RE_LEADING, ''); } // 마커·앞들여쓰기 제거한 순수 리스트 텍스트

// ── CM6: 감긴 줄(일반 텍스트) 행잉 인덴트 + 리스트 마커 시각 들여쓰기/숨김 ──
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
        const t = ln.text;
        const mi = t.match(RE_INDENT);
        const mk = t.match(RE_MARK);
        if (mi) {
          // 일반 텍스트 ZWSP+NBSP 들여쓰기 → 행잉 인덴트(감긴 줄 정렬)
          const px = Math.round((mi[1].length - 1) * (NBSP_PX || 6));
          b.add(ln.from, ln.from, Decoration.line({
            attributes: { style: 'text-indent:-' + px + 'px;padding-inline-start:' + px + 'px;' }
          }));
        } else if (mk) {
          // 리스트/체크박스 마커 → 레벨만큼 시각 들여쓰기 + 마커 숨김
          const lvl = parseInt(mk[1], 10);
          b.add(ln.from, ln.from, Decoration.line({
            attributes: { style: 'padding-inline-start:' + (lvl * INDENT_EM) + 'em;' }
          }));
          b.add(ln.from + mk.index, ln.from + t.length, Decoration.replace({}));
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
    if (evt.metaKey || evt.ctrlKey || evt.altKey) return;

    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view || view.getMode() !== 'source') return;
    const editor = view.editor;
    if (!editor || !editor.hasFocus()) return;

    const from = editor.getCursor('from');
    const to = editor.getCursor('to');
    const line = editor.getLine(from.line);

    // ===== Enter: 일반 텍스트만 같은 들여쓰기 유지 (리스트는 Obsidian 기본) =====
    if (key === 'Enter') {
      if (evt.shiftKey || from.line !== to.line || from.ch !== to.ch) return;
      if (evt.isComposing) return;
      if (RE_LISTLINE.test(line)) return;                         // 리스트/체크박스 → Obsidian 기본(자동 이어쓰기)
      const m = line.match(RE_INDENT);
      if (!m) return;
      const indent = m[1];
      evt.preventDefault(); evt.stopPropagation();
      editor.replaceRange('\n' + indent, from, from);
      editor.setCursor({ line: from.line + 1, ch: indent.length });
      return;
    }

    if (evt.isComposing) return;                                  // Tab/Backspace 는 한글 조합 중 비간섭

    // ===== Tab / Shift+Tab =====
    if (key === 'Tab') {
      if (from.line !== to.line) return;                          // 여러 줄 선택 → 기본

      // 리스트/체크박스: 줄 끝 마커로 레벨 조정 (시각 들여쓰기). 마커가 줄끝이라 체크박스 안 깨짐.
      if (RE_LISTLINE.test(line)) {
        evt.preventDefault(); evt.stopPropagation();
        const level = markLevel(line);
        const leadLen = (line.match(RE_LEADING) || [''])[0].length;
        const body = listBody(line);
        const newLevel = evt.shiftKey ? Math.max(0, level - 1) : level + 1;
        const marker = newLevel > 0 ? (' <!--ti:' + newLevel + '-->') : '';
        const newLine = body + marker;
        editor.replaceRange(newLine, { line: from.line, ch: 0 }, { line: from.line, ch: line.length });
        const bodyEnd = newLine.length - marker.length;
        let nc = from.ch - leadLen; if (nc < 0) nc = 0; if (nc > bodyEnd) nc = bodyEnd;
        editor.setCursor({ line: from.line, ch: nc });
        return;
      }

      // ↓ 일반 텍스트: ZWSP+NBSP 들여쓰기
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

    // ===== Backspace: 일반 텍스트 들여쓰기 한 단계 삭제 =====
    if (key === 'Backspace') {
      if (evt.shiftKey) return;
      if (from.line !== to.line || from.ch !== to.ch) return;
      const m = line.match(RE_SPLIT);
      if (!m || m[2].length === 0) return;
      const indentEnd = 1 + m[2].length;
      if (from.ch < 1 || from.ch > indentEnd) return;
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
