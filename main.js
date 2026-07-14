'use strict';
const obsidian = require('obsidian');

/*
 * Tab Indent (Notion-style)
 *  - 일반 텍스트: 줄 앞 ZWSP(U+200B)+NBSP(U+00A0) 로 들여쓰기 (코드블록 안 됨, 실제 저장됨)
 *  - 리스트/체크박스: 손대지 않고 Obsidian 내장 들여쓰기를 그대로 사용 (부드럽고 일정함,
 *    읽기뷰에서도 정상 중첩). 단독 최상위 체크박스는 마크다운 특성상 들여쓰기 불가.
 *  - 정리: 리스트 줄에 예전 마커(<!--ti:N-->)나 ZWSP/NBSP 가짜 들여쓰기가 남아 있으면
 *    그 줄에서 Tab 한 번으로 제거한다.
 *
 *  Tab / Shift+Tab : 일반 텍스트 들여쓰기 / 해제 (리스트는 Obsidian 기본)
 *  Enter           : 일반 텍스트는 같은 들여쓰기 유지 (리스트는 Obsidian 기본)
 *  Backspace       : 일반 텍스트 들여쓰기 한 단계 삭제
 */
const ZWSP = String.fromCharCode(0x200B);
const NBSP = String.fromCharCode(0x00A0);
const LEVEL = 4;
const RE_INDENT = new RegExp('^(' + ZWSP + NBSP + '+)');          // ZWSP + NBSP들 (일반 텍스트 들여쓰기)
const RE_SPLIT = new RegExp('^(' + ZWSP + ')(' + NBSP + '*)');    // (ZWSP)(NBSP들)
const RE_LISTLINE = new RegExp('^[\\s' + ZWSP + NBSP + ']*(?:[-*+]|\\d+[.)])\\s'); // 리스트/체크박스
// 리스트/체크박스 "마커" 전체(앞 들여쓰기 + 불릿/번호 + 공백 + 선택적 [ ]/[x] + 공백)
const RE_LISTMARKER = new RegExp('^([\\s' + ZWSP + NBSP + ']*(?:[-*+]|\\d+[.)])[ \\t](?:\\[.\\][ \\t])?)');
const RE_FAKELEAD = new RegExp('^[' + ZWSP + NBSP + ']+');        // 줄 앞 ZWSP/NBSP (가짜 들여쓰기)
const RE_MARK = /\s*<!--ti:(\d+)-->\s*$/;                         // 예전 버전이 남긴 시각 들여쓰기 마커

// 줄 앞 공백의 "칸수"(탭=tabSize) 계산 → 들여쓰기 레벨 산출용
function leadCols(str, tabSize) {
  let cols = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\t') cols += tabSize;
    else if (c === ' ') cols += 1;
    else break;
  }
  return cols;
}

// ── CM6: 감긴 줄(일반 텍스트 ZWSP 들여쓰기) 행잉 인덴트 ──
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
    // 예전 1.1.0 버전이 남긴 <!--ti:N--> 마커를 볼트 전체에서 한 번에 제거하는 명령
    this.addCommand({
      id: 'strip-ti-markers',
      name: 'Notion 들여쓰기 마커(<!--ti:N-->) 전체 제거',
      callback: () => this.stripTiMarkers(),
    });
  }

  async stripTiMarkers() {
    const files = this.app.vault.getMarkdownFiles();
    let changed = 0;
    for (const f of files) {
      try {
        const c = await this.app.vault.read(f);
        const nc = c.replace(/[ \t]*<!--ti:\d+-->/g, '');
        if (nc !== c) { await this.app.vault.modify(f, nc); changed++; }
      } catch (e) {}
    }
    new obsidian.Notice('ti 마커 제거 완료: ' + changed + '개 파일 정리');
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
      if (RE_LISTLINE.test(line)) {
        // 들여쓴 리스트/체크박스: Enter 시 같은 들여쓰기로 이어쓰기 (Obsidian이 단독 항목엔 안 이어주는 문제 보완)
        const lead = (line.match(/^[ \t]+/) || [''])[0];
        if (!lead) return;                                        // 최상위(들여쓰기 없음) → Obsidian 기본
        const cb = line.match(/^[ \t]*([-*+]) \[.\] (.*)$/);      // 체크박스
        let prefix, body;
        if (cb) { prefix = lead + cb[1] + ' [ ] '; body = cb[2]; }
        else {
          const bu = line.match(/^[ \t]*([-*+]) (.*)$/);          // 불릿
          if (!bu) return;                                        // 번호리스트 등 → Obsidian 기본
          prefix = lead + bu[1] + ' '; body = bu[2];
        }
        if (body.trim() === '') return;                          // 빈 항목 → Obsidian 기본(리스트 빠져나가기)
        evt.preventDefault(); evt.stopPropagation();
        editor.replaceRange('\n' + prefix, from, from);
        editor.setCursor({ line: from.line + 1, ch: prefix.length });
        return;
      }
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

      // 리스트/체크박스: Obsidian 기본 들여쓰기 사용. 단, 예전 마커/가짜 들여쓰기가 남아 있으면 제거(정리).
      if (RE_LISTLINE.test(line)) {
        const hasMark = RE_MARK.test(line);
        const leadLen = (line.match(RE_FAKELEAD) || [''])[0].length;
        if (hasMark || leadLen) {
          evt.preventDefault(); evt.stopPropagation();
          let newLine = line.replace(RE_MARK, '');
          newLine = newLine.slice((newLine.match(RE_FAKELEAD) || [''])[0].length);
          editor.replaceRange(newLine, { line: from.line, ch: 0 }, { line: from.line, ch: line.length });
          editor.setCursor({ line: from.line, ch: Math.max(0, from.ch - leadLen) });
          return;
        }
        // 과도한 들여쓰기(바로 윗줄보다 2단계 이상 깊게) 차단 → 코드블록으로 깨지는 것 방지
        if (!evt.shiftKey) {
          let tabSize = 4;
          try { tabSize = this.app.vault.getConfig('tabSize') || 4; } catch (e) {}
          const curLevel = Math.floor(leadCols(line, tabSize) / tabSize);
          let p = from.line - 1;
          while (p >= 0 && editor.getLine(p).trim() === '') p--;
          let prevLevel = -1;
          if (p >= 0 && RE_LISTLINE.test(editor.getLine(p))) {
            prevLevel = Math.floor(leadCols(editor.getLine(p), tabSize) / tabSize);
          }
          if (curLevel >= prevLevel + 1) { evt.preventDefault(); evt.stopPropagation(); return; }
        }
        return;                                                   // 유효 범위 → Obsidian 기본 Tab
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
      // 리스트/체크박스: 커서가 마커 바로 뒤면 '- [ ] ' 마커 전체를 한 번에 삭제 (한 글자씩 지울 필요 X)
      if (RE_LISTLINE.test(line)) {
        const mm = line.match(RE_LISTMARKER);
        if (mm && from.ch === mm[1].length) {
          evt.preventDefault(); evt.stopPropagation();
          editor.replaceRange('', { line: from.line, ch: 0 }, { line: from.line, ch: mm[1].length });
          editor.setCursor({ line: from.line, ch: 0 });
        }
        return;                                                   // 그 외 위치 → Obsidian 기본
      }
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
