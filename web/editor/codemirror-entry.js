import { basicSetup, EditorView } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { redo, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { yamlFrontmatter } from '@codemirror/lang-yaml';
import { openSearchPanel } from '@codemirror/search';
import { keymap, placeholder } from '@codemirror/view';
import { GFM } from '@lezer/markdown';
import { applyMarkdownCommand, extractMarkdownOutline } from './markdown-formatting.js';

const editorTheme = EditorView.theme({
  '&': { height: '100%', color: '#28342f', backgroundColor: '#fffdf8' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace', fontSize: '13px', lineHeight: '1.75' },
  '.cm-content': { minHeight: '100%', padding: '18px 12px 80px' },
  '.cm-line': { padding: '0 8px' },
  '.cm-gutters': { color: '#9c9789', backgroundColor: '#f3efe5', borderRight: '1px solid #ded7c7' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'rgba(132, 155, 118, .09)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(132, 155, 118, .25) !important' },
  '.cm-cursor': { borderLeftColor: '#31594d', borderLeftWidth: '2px' },
  '.cm-search': { color: '#27352f', backgroundColor: '#eee8da', borderTop: '1px solid #d4ccb9', fontFamily: 'system-ui, sans-serif' },
  '.cm-search input': { color: '#27352f', backgroundColor: '#fffdf8', border: '1px solid #cfc6b2', borderRadius: '3px' },
  '.cm-search button': { color: '#27352f', backgroundColor: '#faf7ef', border: '1px solid #cfc6b2', borderRadius: '3px' },
}, { dark: false });

function applyFormat(view, command) {
  const selection = view.state.selection.main;
  const result = applyMarkdownCommand(view.state.doc.toString(), selection.from, selection.to, command);
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: result.text },
    selection: { anchor: result.from, head: result.to },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

const formattingKeys = [
  { key: 'Mod-b', run: view => applyFormat(view, 'bold') },
  { key: 'Mod-i', run: view => applyFormat(view, 'italic') },
  { key: 'Mod-Alt-1', run: view => applyFormat(view, 'heading-1') },
  { key: 'Mod-Alt-2', run: view => applyFormat(view, 'heading-2') },
  { key: 'Mod-Alt-3', run: view => applyFormat(view, 'heading-3') },
  { key: 'Mod-Shift-k', run: view => applyFormat(view, 'link') },
];

export function createMarkdownEditor({ parent, value = '', onChange, onOutlineChange, onPasteImage } = {}) {
  if (!parent) throw new Error('Markdown editor parent is required');
  let uploadingImage = false;
  const language = yamlFrontmatter({ content: markdown({ extensions: [GFM] }) });
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: String(value),
      extensions: [
        basicSetup,
        language,
        EditorState.phrases.of({
          Find: '查找', Replace: '替换', next: '下一个', previous: '上一个', all: '全部',
          'match case': '区分大小写', regexp: '正则表达式', 'by word': '全词匹配', replace: '替换', 'replace all': '全部替换', close: '关闭',
        }),
        EditorView.lineWrapping,
        editorTheme,
        placeholder('使用 Markdown 写下内容，可直接粘贴图片…'),
        keymap.of(formattingKeys),
        EditorView.contentAttributes.of({ spellcheck: 'true', 'aria-label': 'Markdown 笔记正文' }),
        EditorView.updateListener.of(update => {
          if (!update.docChanged) return;
          const content = update.state.doc.toString();
          onChange?.(content);
          onOutlineChange?.(extractMarkdownOutline(content));
        }),
        EditorView.domEventHandlers({
          paste(event, currentView) {
            const file = [...(event.clipboardData?.items || [])].find(item => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
            if (!file || !onPasteImage || uploadingImage) return false;
            event.preventDefault();
            uploadingImage = true;
            Promise.resolve(onPasteImage(file)).then(markdownSource => {
              if (!markdownSource) return;
              const selection = currentView.state.selection.main;
              const previous = selection.from ? currentView.state.doc.sliceString(selection.from - 1, selection.from) : '';
              const insertion = `${previous && previous !== '\n' ? '\n' : ''}${markdownSource}\n`;
              currentView.dispatch({ changes: { from: selection.from, to: selection.to, insert: insertion }, selection: { anchor: selection.from + insertion.length }, scrollIntoView: true });
            }).finally(() => { uploadingImage = false; });
            return true;
          },
        }),
      ],
    }),
  });
  onOutlineChange?.(extractMarkdownOutline(String(value)));

  return {
    getValue: () => view.state.doc.toString(),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
    run(command) {
      if (command === 'undo') return undo(view);
      if (command === 'redo') return redo(view);
      if (command === 'search') return openSearchPanel(view);
      return applyFormat(view, command);
    },
    goToOffset(offset) {
      const position = Math.max(0, Math.min(Number(offset) || 0, view.state.doc.length));
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
      view.focus();
    },
  };
}
