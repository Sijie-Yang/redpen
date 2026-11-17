/* Redpen front end.
   The file under review is shown in an iframe (an HTML deck or page as it is; images and PDFs through /viewer).
   This script puts an annotation layer inside that iframe, over the current slide or page, and keeps the notes in
   the sidebar. Notes are saved through the local server next to the reviewed file. See AGENTS.md for the data format. */
(async function () {
'use strict';
const NS = 'http://www.w3.org/2000/svg';
const $ = s => document.querySelector(s);
const frame = $('#rv-frame'), top = $('#rv-top'), side = $('#rv-side'), body = $('#rv-body'), tabs = $('.rv-tabs'), fileIn = $('#rv-file'), help = $('#rv-help');
const statusEl = $('#rv-status');
const setStatus = (t, c) => { statusEl.textContent = t; statusEl.className = c || ''; };
/* Interface language. Chinese is the source text; english() at the end of this file holds the translations.
   The choice is kept in a cookie, which every review page on this computer shares, whatever its port. */
const MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
let LANG = null;
try { LANG = (document.cookie.match(/(?:^|;\s*)rvlang=(en|zh)\b/) || [])[1] || localStorage.getItem('rv-lang'); } catch (_) {}
const LANG_SET = LANG === 'en' || LANG === 'zh';
if (!LANG_SET) LANG = [...(navigator.languages || []), navigator.language || ''].some(l => /^zh\b/i.test(l)) ? 'zh' : 'en';
let EN = LANG === 'en' ? english() : {};
function L(s, v) {   /* L('已保存 {n} 条', { n: 3 }); a "|context" suffix tells two uses of the same Chinese word apart */
  let o = LANG === 'en' && EN[s] != null ? EN[s] : s.replace(/\|\w+$/, '');
  if (v) o = o.replace(/\{(\w+)\}/g, (m, k) => (k === 's' && v.s == null ? (v.n === 1 ? '' : 's') : v[k] != null ? v[k] : m));
  return MAC ? o : o.replace(/⇧⌘Z/g, 'Ctrl+Shift+Z').replace(/⌘(?=[A-Z])/g, 'Ctrl+');
}
const pairs = a => a.map(([k, v]) => [k, L(v)]);
const dict = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, L(v)]));
const lists = o => Object.fromEntries(Object.entries(o).map(([k, a]) => [k, a.map(x => L(x))]));
const shortLab = t => (LANG === 'en' ? t.replace(/^Page /, '').replace(/^Backup /, 'B') : t.replace('第 ', '').replace(' 页', ''));
let INFO;
try { INFO = await (await fetch('api/info', { cache: 'no-store' })).json(); } catch (_) { setStatus(L('连不上本地服务'), 'err'); return; }
if (!LANG_SET && (INFO.lang === 'en' || INFO.lang === 'zh') && INFO.lang !== LANG) { LANG = INFO.lang; EN = LANG === 'en' ? english() : {}; }
document.documentElement.lang = LANG;
document.title = L('标注|brand') + ' · ' + INFO.name;
const HTML = INFO.kind === 'html', TEXT = !!INFO.textLayer;

const KINDS = pairs([['comment', '评论'], ['text', '改文字'], ['image', '加图 / 换图'], ['layout', '版式'], ['remove', '删掉'], ['other', '其他']]);
const TYPES = dict({ pin: '点评', box: '框选', el: '选中元素', text: '选中文字', edit: '直接改字', image: '加图', pen: '手绘', arrow: '箭头', slide: '整页意见', 'new': '新增一页', del: '删除此页', move: '移动此页', notes: '修改讲稿', op: '整页操作', ink: '手写批注' });
const KIND0 = { edit: 'text', image: 'image', arrow: 'layout' };
const OPS = dict({ keep: '这页不要动', split: '拆成两页', merge: '和下一页合并', backup: '移到备用页', optional: '短版本里跳过', dup: '复制这一页再改' });
const LAYOUTS = pairs([['auto', '由 AI 决定'], ['fig', '标题 + 一张大图'], ['figtext', '左图右文'], ['bullets', '标题 + 要点'], ['table', '表格'], ['compare', '左右对比'], ['full', '整页一张图'], ['copy', '照本页的版式']]);
const IMGMODES = pairs([['add', '放在这个位置'], ['replace', '替换下面这张图'], ['ref', '只是参考，不放进去']]);
const IMGLAB = dict({ add: '放这里', replace: '替换', ref: '参考' });
const TOOLS = [
  ['browse', '浏览', 'V', '选中文字可以评论；截图直接 ⌘V 粘贴，图片可以拖进来；用手写笔可以直接画'],
  ['pin', '点评', 'C', '点任意位置，留下一条意见'],
  ['box', '框选', 'R', '拖一个矩形，圈出要讨论的区域'],
  ['sent', '选句', 'T', '点一句话就选中整句，可以连续点；Esc 退出'],
  ['el', '选元素', 'E', '点一张图、一个表格或一段文字，选中整个元素；Esc 退出'],
  ['edit', '改字', 'W', '点一段文字直接修改，回车完成，Esc 放弃；改动会记录成一条标注'],
  ['pen', '画笔', 'P', '随手画，连续几笔算一条；Esc 退出'],
  ['arrow', '箭头', 'A', '从一处拖到另一处，表示“移到这里”或“这两处有关”'],
  ['laser', '激光笔', 'L', '红点跟着鼠标走；按住拖动可以画圈，几秒后自动消失。不会记成标注，翻页照常用方向键；Esc 退出']].map(t => [t[0], L(t[1]), t[2], L(t[3])]);
const OFF = { sent: !TEXT && L('这种文件里没有可以选的文字，请用点评、框选或画笔'), el: !HTML && !TEXT && L('图片里没有元素可选，请用框选'), edit: !HTML && L('只有 HTML 能直接改字。PDF 和图片请选中文字后写“改成…”') };
const MODAL = ['sent', 'el', 'edit'], DRAW = ['pin', 'box', 'pen', 'arrow'], SCOPED = ['pin', 'box', 'el', 'text', 'slide', 'pen'];
const CHIPS = lists({
  text: ['删掉这句', '太长，缩短', '换个说法', '看不懂，说清楚', '加粗强调'],
  img: ['放大', '缩小', '换一张图', '裁掉留白', '删掉', '加图注'],
  gen: ['放大', '缩小', '删掉', '字太小', '太挤', '对齐'],
  slide: ['内容太多', '太空', '字太小', '换个版式', '加一张图', '这页很好'],
  arrow: ['移到箭头指的位置', '两处对调', '这两处要对应起来'],
  image: ['放大一点', '缩小一点', '只要图的一部分', '配一句图注'],
  'new': ['从论文里找图', '用表格', '只放一句话和一张图'] });

/* ---------- styles and elements that live inside the reviewed document ---------- */
const IN_CSS = `
rv-layer{position:fixed;left:0;top:0;transform-origin:0 0;z-index:2147483000;pointer-events:none;display:block;--u:1;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;line-height:1.2;text-align:left;letter-spacing:0}
html.rv-draw rv-layer{pointer-events:auto;cursor:crosshair;touch-action:none}
html.rv-t-sent *,html.rv-t-el *{cursor:pointer!important} html.rv-t-edit *{cursor:text!important}
html.rv-present rv-marks,html.rv-present rv-hov,html.rv-present rv-layer>svg{display:none!important}
html.rv-t-laser,html.rv-t-laser *{cursor:none!important;user-select:none!important;-webkit-user-select:none!important}
rv-laser{position:absolute;left:0;top:0;width:100%;height:100%;display:none;pointer-events:none}
html.rv-t-laser rv-laser{display:block}
rv-laser svg{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}
rv-laser svg line{stroke:#FF2D2D;stroke-linecap:round;stroke-width:calc(var(--u)*5px);filter:drop-shadow(0 0 calc(var(--u)*3px) rgba(255,45,45,.9))}
rv-laser i{position:absolute;display:none;width:calc(var(--u)*16px);height:calc(var(--u)*16px);margin:calc(var(--u)*-8px) 0 0 calc(var(--u)*-8px);border-radius:50%;background:radial-gradient(circle,#fff 0 20%,#FF3B30 46%,#FF2D2D 72%);box-shadow:0 0 calc(var(--u)*6px) calc(var(--u)*3px) rgba(255,45,45,.75),0 0 calc(var(--u)*20px) calc(var(--u)*9px) rgba(255,45,45,.3)}
html.rv-dropping rv-layer{outline:calc(var(--u)*4px) dashed #6B3FD4;outline-offset:calc(var(--u)*-4px);background:rgba(107,63,212,.07)}
rv-layer svg{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible}
rv-marks,rv-hov{position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none}
rv-layer .rv-stroke{fill:none;stroke:#6B3FD4;stroke-width:calc(var(--u)*3.5px);stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
rv-layer .rv-stroke.sel,rv-layer .rv-stroke.hot{stroke:#E8590C}
rv-layer .rv-hit{fill:none;stroke:transparent;stroke-width:calc(var(--u)*18px);pointer-events:stroke;cursor:pointer}
rv-layer .rv-mark{position:absolute;pointer-events:auto;cursor:pointer;box-sizing:border-box;display:block;color:#fff;margin:0;padding:0}
rv-layer .rv-mv{cursor:move}
rv-layer .rv-dot{width:calc(var(--u)*24px);height:calc(var(--u)*24px);margin:calc(var(--u)*-12px) 0 0 calc(var(--u)*-12px);border-radius:50% 50% 50% 12%;background:#6B3FD4;font-weight:700;font-size:calc(var(--u)*12px);line-height:calc(var(--u)*21px);text-align:center;box-shadow:0 calc(var(--u)*1.5px) calc(var(--u)*5px) rgba(0,0,0,.35);border:calc(var(--u)*1.5px) solid #fff}
rv-layer .rv-tagn{width:calc(var(--u)*20px);height:calc(var(--u)*20px);margin:calc(var(--u)*-10px) 0 0 calc(var(--u)*-10px);border-radius:50%;background:#6B3FD4;font-weight:700;font-size:calc(var(--u)*11px);line-height:calc(var(--u)*20px);text-align:center}
rv-layer .rv-rect{border:calc(var(--u)*2px) dashed #6B3FD4;background:rgba(107,63,212,.08);border-radius:calc(var(--u)*3px)}
rv-layer .rv-ink{border:calc(var(--u)*2px) solid #D9480F;background:rgba(217,72,15,.06);border-radius:calc(var(--u)*3px)}
rv-layer .rv-elr{border:calc(var(--u)*2px) solid #6B3FD4;border-radius:calc(var(--u)*3px);pointer-events:none}
rv-layer .rv-edr{border:calc(var(--u)*1.5px) dashed #2E7D4F;border-radius:calc(var(--u)*3px);pointer-events:none}
rv-layer .rv-elr i,rv-layer .rv-edr i{pointer-events:auto;cursor:pointer}
rv-layer .rv-mark>i{position:absolute;left:calc(var(--u)*-2px);top:calc(var(--u)*-20px);font-weight:700;font-style:normal;font-size:calc(var(--u)*11px);line-height:calc(var(--u)*17px);background:#6B3FD4;color:#fff;border-radius:calc(var(--u)*3px);padding:0 calc(var(--u)*5px);white-space:nowrap}
rv-layer .rv-edr>i{background:#2E7D4F} rv-layer .rv-ink>i{background:#D9480F}
rv-layer .rv-hl{background:rgba(255,214,10,.42);border-bottom:calc(var(--u)*1.5px) solid #C89B00}
rv-layer .rv-img{border:calc(var(--u)*2px) dashed #6B3FD4;border-radius:calc(var(--u)*3px);background:rgba(255,255,255,.85);display:flex;align-items:center;justify-content:center;box-shadow:0 calc(var(--u)*3px) calc(var(--u)*12px) rgba(0,0,0,.25)}
rv-layer .rv-img img{width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:.93;display:block;max-width:none}
rv-layer .rv-img b{font-weight:700;font-size:calc(var(--u)*15px);color:#6B3FD4}
rv-layer .rv-rs{position:absolute;right:calc(var(--u)*-7px);bottom:calc(var(--u)*-7px);width:calc(var(--u)*14px);height:calc(var(--u)*14px);border-radius:50%;background:#fff;border:calc(var(--u)*2px) solid #6B3FD4;cursor:nwse-resize;box-sizing:border-box}
rv-layer .rv-mark.sel.rv-dot,rv-layer .rv-mark.hot.rv-dot,rv-layer .rv-mark.sel.rv-tagn,rv-layer .rv-mark.hot.rv-tagn{background:#E8590C}
rv-layer .rv-mark.sel.rv-rect,rv-layer .rv-mark.hot.rv-rect,rv-layer .rv-mark.sel.rv-img,rv-layer .rv-mark.hot.rv-img,rv-layer .rv-mark.sel.rv-elr,rv-layer .rv-mark.hot.rv-elr{border-color:#E8590C}
rv-layer .rv-mark.sel.rv-hl,rv-layer .rv-mark.hot.rv-hl{background:rgba(232,89,12,.35)}
rv-layer .rv-ops{position:absolute;right:calc(var(--u)*13px);top:calc(var(--u)*38px);display:flex;flex-direction:column;gap:calc(var(--u)*4px);align-items:flex-end}
rv-layer .rv-op{position:static;font-weight:600;font-size:calc(var(--u)*11.5px);line-height:1.3;background:#6B3FD4;color:#fff;border-radius:calc(var(--u)*4px);padding:calc(var(--u)*3px) calc(var(--u)*7px);box-shadow:0 calc(var(--u)*1.5px) calc(var(--u)*5px) rgba(0,0,0,.25);max-width:calc(var(--u)*380px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
rv-layer .rv-op.sel,rv-layer .rv-op.hot{background:#E8590C}
rv-layer .rv-draft{position:absolute;pointer-events:none}
rv-layer .rv-hov{position:absolute;pointer-events:none;background:rgba(107,63,212,.16);outline:calc(var(--u)*1.5px) solid rgba(107,63,212,.7);border-radius:calc(var(--u)*2px)}
.rv-editing{outline:3px solid #2E7D4F!important;outline-offset:4px;background:rgba(46,125,79,.07);cursor:text}
.rv-edited{text-decoration:underline dotted #2E7D4F;text-decoration-thickness:.08em;text-underline-offset:.2em}
rv-pop{position:fixed;display:none;z-index:2147483001;background:#161C28;border-radius:9px;padding:4px;box-shadow:0 4px 14px rgba(0,0,0,.3);gap:3px}
rv-pop button{all:unset;color:#fff;border-radius:6px;padding:7px 10px;font:600 13px -apple-system,"Helvetica Neue",Arial,sans-serif;cursor:pointer;white-space:nowrap}
rv-pop button:hover{background:#6B3FD4}
@media print{rv-layer,rv-pop{display:none!important}}
`;

/* ---------- state ---------- */
const blank = () => ({ tool: 'Redpen', lang: LANG, file: INFO.path, kind: INFO.kind, build: INFO.build, updated: null, general: '', items: [] });
let S = blank(), LAST = null, rev = '0', tool = 'browse', selId = null, tab = 'slide', saveT = null, dirty = false, drag = null;
let penId = null, editing = null, editCancel = false, pre = null, noClick = 0, newBuild = false;
let fd = null, fw = null, A = null, layer, svg, marks, hov, pop, G = null, curEl = null, adaptUntil = 0;
const NOTES_PIN = 'rv-notes-pinned';
let notesPinned = false, notesOpen = false;
try { notesPinned = localStorage.getItem(NOTES_PIN) === 'true'; } catch (_) {}
notesOpen = notesPinned;
function setNotesPinned(value) {
  notesPinned = value;
  try { localStorage.setItem(NOTES_PIN, String(value)); } catch (_) {}
  const control = body.querySelector('[data-notes-pin]');
  if (control) control.checked = value;
  const panel = body.querySelector('.rv-notes');
  if (panel) panel.classList.toggle('pinned', value);
}
const hist = [], fut = [], origHtml = new Map();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const r1 = v => Math.round(v);
const act = () => (A ? A.current() : null);
const nOf = el => A.slides().indexOf(el) + 1;
const byId = id => S.items.find(i => i.id === id);
const itemsOf = n => S.items.filter(i => i.slide && i.slide.n === n);
const stale = () => S.items.length > 0 && S.build && INFO.build && S.build !== INFO.build;
const typeName = it => it.type === 'op' ? (OPS[it.op] || L('整页操作')) : it.type === 'new' ? (it.where === 'before' ? L('前面加一页') : L('后面加一页')) : (TYPES[it.type] || it.type);
const opLabel = it => typeName(it) + (it.type === 'new' && it.title ? L('：') + it.title : '') + (it.type === 'move' && it.ref ? ' → ' + L(it.pos === 'before' ? '{page}之前' : '{page}之后', { page: it.refPage || '' }) : '');
const imgUrl = m => m.url ? '/' + String(m.url).replace(/^\//, '') : (m.dataUrl || '');
const U = () => (G ? G.W / G.width : 1) / zk;   /* document pixels per screen pixel */

/* ---------- chrome ---------- */
top.innerHTML = '<b>' + L('标注|brand') + '</b><span class="rv-grp">' + TOOLS.map(t => '<button data-tool="' + t[0] + '" title="' + esc(OFF[t[0]] || t[3]) + '"' + (OFF[t[0]] ? ' disabled' : '') + '>' + t[1] + '<small>' + t[2] + '</small></button>').join('') + '</span>'
  + '<span class="rv-grp"><button data-do="img" title="' + L('选一张图片放到这一页') + '">' + L('加图') + '<small>I</small></button><button data-do="paste" title="' + L('把剪贴板里的截图放到这一页，也可以直接按 ⌘V') + '">' + L('贴截图') + '<small>' + L('⌘V') + '</small></button></span>'
  + '<span class="rv-grp"><button data-do="undo" title="' + L('撤销 ⌘Z') + '">↶</button><button data-do="redo" title="' + L('重做 ⇧⌘Z') + '">↷</button></span>'
  + '<span class="rv-grp" id="rv-zoom"><button data-do="zout" title="' + L('缩小|zoom') + '">−</button><button data-do="zfit" title="' + L('整页宽度适应窗口') + '">' + L('适应') + '</button><button data-do="zin" title="' + L('放大|zoom') + '">＋</button></span>'
  + '<span class="rv-grp"><button data-nav="-1">‹</button><span id="rv-page"></span><button data-nav="1">›</button></span>'
  + '<button data-do="present" title="' + L('全屏演示：隐藏工具栏、侧栏和标注，只留幻灯片和激光笔') + '">' + L('演示') + '<small>F</small></button><button data-do="side" title="' + L('收起或展开右侧栏') + '">' + L('侧栏') + '</button><button data-do="help">' + L('帮助') + '</button>'
  + '<button data-do="lang" title="' + (LANG === 'en' ? '切换到中文界面' : 'Switch the interface to English') + '">' + (LANG === 'en' ? '中文' : 'EN') + '</button><span id="rv-hint"></span>';
[['prompt', '复制给 AI 的指令', '复制一条指令，粘贴给 AI 就会按标注改'], ['copy', '复制标注文字', '把标注复制成纯文字'], ['clear', '归档并清空', '不经过 AI，直接结束这一轮；标注保存在 archive/ 里']]
  .forEach(([k, t, tip]) => { const b = document.querySelector('#rv-foot [data-do=' + k + ']'); if (b) { b.textContent = L(t); b.title = L(tip); } });
help.innerHTML = '<div><h3>' + L('怎么标注') + '</h3><table>' + [
  ['评论一句话', '按 <kbd>T</kbd> 后点那句话；或者直接选中文字，在弹出的小条里点“评论 / 改写 / 缩短 / 删掉”'],
  ['直接改字', '按 <kbd>W</kbd> 后点一段文字，就地修改，回车完成（只对 HTML）'],
  ['评论图或一块内容', '<kbd>E</kbd> 点它选中整个元素；<kbd>C</kbd> 在任意位置放一个点；<kbd>R</kbd> 拖一个框'],
  ['加外部截图', '截图后按 <kbd>⌘V</kbd>，图会出现在这一页上，拖动调整位置和大小。也可以把图片文件拖进来，或点“加图”。拖到已有的图上表示替换它'],
  ['给某条意见配图', '先点进那条意见的输入框再粘贴，或把图片拖到那张卡片上'],
  ['画和箭头', '<kbd>P</kbd> 随手画，<kbd>A</kbd> 从一处拖到另一处。用 Apple Pencil 时不用选工具，直接画'],
  ['全屏演示', '点“演示”或按 <kbd>F</kbd>：全屏，只留幻灯片和激光笔，工具栏、侧栏和标注都隐藏。<kbd>←</kbd> <kbd>→</kbd> 或空格翻页，<kbd>V</kbd> 换回普通鼠标，<kbd>Esc</kbd> 或 <kbd>F</kbd> 退出'],
  ['激光笔', '按 <kbd>L</kbd>，红点跟着鼠标走；按住拖动可以画圈，几秒后自动消失。只用来指给别人看，不会记成标注。讲的时候可以点“侧栏”把右边收起来'],
  ['加页、删页、挪页', '右侧“前面加一页 / 后面加一页 / 移动 / 删除”，“更多”里有拆页、合并、移到备用页、这页不要动'],
  ['持续查看讲稿', '勾选右侧“讲稿始终展开”，翻页和刷新后都会保持展开。取消勾选可恢复按页手动展开。'],
  ['其他', '★ 标为重要；“所有页”表示每一页都照这条改；<kbd>⌘Z</kbd> 撤销；<kbd>Esc</kbd> 回到浏览；<kbd>←</kbd> <kbd>→</kbd> 翻页'],
  ['交给 AI', '点右下角“复制给 AI 的指令”，粘贴给 Claude 或 Codex。它改完后，这里的“上一轮”会显示每条的处理结果'],
  ['换语言', '点工具栏最右边的 EN 换成英文界面，再点“中文”换回来。复制给 AI 的指令和标注清单会跟着换']
].map(r => '<tr><td>' + L(r[0]) + '</td><td>' + L(r[1]) + '</td></tr>').join('')
  + '<tr><td>' + L('在 iPad 上用') + '</td><td>' + (INFO.lan ? L('在 iPad 的 Safari 里打开：') + '<code>' + esc(INFO.lan) + '</code>' : L('启动时加 <code>--lan</code>，终端会给出 iPad 用的链接（同一个 Wi-Fi 或 Tailscale）')) + L('。<br>离线：在 iPad 上用任何 App 手写批注 PDF，把批注件传回来，让 AI 运行 <code>review.py import 原件 批注件</code>') + '</td></tr>'
  + '</table><p style="margin:12px 0 0;color:#6B7688;font-size:13px">' + L('标注保存在 <code>{dir}</code>。点空白处关闭。', { dir: esc(INFO.review) }) + '</p></div>';

/* ---------- persistence and undo ---------- */
const READY = () => L('自动保存在 {dir}/。标完后点“复制给 AI 的指令”，粘贴给 Claude 或 Codex。', { dir: INFO.review.split('/').slice(-1)[0] });
async function loadNotes() {
  try {
    const r = await fetch('api/annotations', { cache: 'no-store' }), j = await r.json();
    S = j && Array.isArray(j.items) ? Object.assign(blank(), j) : blank();
    const l = await (await fetch('api/last', { cache: 'no-store' })).json(); LAST = l && Array.isArray(l.items) && l.items.length ? l : null;
    rev = (await (await fetch('api/info', { cache: 'no-store' })).json()).rev;
  } catch (_) { setStatus(L('读取标注失败：本地服务没有响应'), 'err'); return; }
  hist.length = 0; fut.length = 0; selId = null; penId = null; dirty = false;
  if (tab === 'last' && !LAST) tab = 'slide';
  setStatus(READY(), 'ok');
  try {   /* notes a previous visit could not save */
    const d = JSON.parse(localStorage.getItem(DRAFT) || 'null');
    if (d && d.S && Array.isArray(d.S.items)) { const n = mergeIn(d.S); if (n) { save(); setStatus(L('找回了上次没存上的 {n} 条标注', { n }), 'ok'); } else localStorage.removeItem(DRAFT); }
  } catch (_) {}
  if (fd) { syncEdits(); render(); }
}
/* Unsaved notes are mirrored in the browser, so a stopped server or a reload cannot lose them. */
const DRAFT = 'rv-draft:' + INFO.path, gone = new Set();
function mirror() { try { localStorage.setItem(DRAFT, JSON.stringify({ t: Date.now(), S })); } catch (_) {} }
function mergeIn(other) {   /* add notes this page does not have (saved by another page); returns how many */
  const have = new Set(S.items.map(i => i.id)); let n = 0;
  (other.items || []).forEach(i => { if (i && i.id && !have.has(i.id) && !gone.has(i.id)) { S.items.push(i); n++; } });
  if (!S.general && other.general) S.general = other.general;
  return n;
}
function save() { dirty = true; mirror(); setStatus(L('保存中…')); clearTimeout(saveT); saveT = setTimeout(flush, 350); }
async function flush() {
  clearTimeout(saveT); S.updated = new Date().toISOString(); S.lang = LANG;
  if (!S.items.length) S.build = INFO.build;
  try {
    const post = () => fetch('api/annotations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, S, { _base: rev }), null, 1) });
    let r = await post();
    if (r.status === 409) {   /* another page saved in between: keep both */
      const j = await r.json(), n = mergeIn(j.current || {}); rev = j.rev; r = await post();
      if (n && fd) { syncEdits(); render(); }
    }
    if (!r.ok) throw new Error(r.status);
    rev = (await r.json()).rev; dirty = false; try { localStorage.removeItem(DRAFT); } catch (_) {}
    setStatus(L('已保存 {n} 条。标完后点“复制给 AI 的指令”，粘贴给 Claude 或 Codex。', { n: S.items.length }), 'ok');
  } catch (_) {
    setStatus(L('没存上：本地服务没有响应。标注还在这个页面里，浏览器里也留了备份；服务恢复后会自动补存，先不要关这个页面。'), 'err');
    clearTimeout(saveT); saveT = setTimeout(flush, 3000);
  }
}
addEventListener('beforeunload', e => { if (dirty) { mirror(); e.preventDefault(); e.returnValue = ''; } });
function updUndo() { top.querySelector('[data-do=undo]').disabled = !hist.length; top.querySelector('[data-do=redo]').disabled = !fut.length; }
function snap() { hist.push(JSON.stringify(S)); if (hist.length > 80) hist.shift(); fut.length = 0; pre = null; updUndo(); }
function restore(j) { S = Object.assign(blank(), JSON.parse(j)); if (!byId(selId)) selId = null; penId = null; syncEdits(); save(); render(); }
function undo() { if (!hist.length) { setStatus(L('没有可以撤销的操作')); return; } fut.push(JSON.stringify(S)); restore(hist.pop()); }
function redo() { if (!fut.length) return; hist.push(JSON.stringify(S)); restore(fut.pop()); }
setInterval(async () => {   /* the file was rebuilt, or an agent archived the notes */
  if (document.hidden) return;
  try {
    const j = await (await fetch('api/info', { cache: 'no-store' })).json();
    if (j.build !== INFO.build) { INFO.build = j.build; newBuild = true; renderSide(); }
    if (j.rev !== rev && !dirty && !drag && !editing) {
      if (j.rev === '0') await loadNotes();   /* archived by the agent: start the next round */
      else { const cur = await (await fetch('api/annotations', { cache: 'no-store' })).json(); rev = j.rev; if (mergeIn(cur) && fd) { syncEdits(); render(); } }
    }
  } catch (_) {}
}, 4000);

/* ---------- which part of the document is "a page" ---------- */
function makeAdapter() {
  const cfg = INFO.config || {}, w = fw;
  const base = {
    page: false,
    title: el => el.dataset.title || norm((el.querySelector(cfg.title || 'h1,h2,h3,.title') || {}).textContent).slice(0, 120) || el.getAttribute('aria-label') || '',
    notes: el => el.querySelector(cfg.notes || 'aside.notes,.notes,.speaker-notes'),
    label(el) { const all = this.slides(), main = all.filter(s => !s.hasAttribute('data-backup')), k = main.indexOf(el); return k >= 0 ? L('第 {n} 页', { n: k + 1 }) : L('备用页 {n}', { n: all.filter(s => s.hasAttribute('data-backup')).indexOf(el) + 1 }); },
    count() { return this.slides().filter(s => !s.hasAttribute('data-backup')).length; } };
  if (cfg.mode !== 'page') {
    if (!cfg.slides && w.__deck && w.__deck.all && w.__deck.all.length)
      return Object.assign(base, { kind: 'deck', slides: () => w.__deck.all, current: () => w.__deck.current(), go: el => w.__deck.goTo(el), step: d => w.__deck.step(d) });
    if (!cfg.slides && w.Reveal && w.Reveal.getSlides && w.Reveal.getCurrentSlide)
      return Object.assign(base, { kind: 'reveal', slides: () => w.Reveal.getSlides(), current: () => w.Reveal.getCurrentSlide(), go: el => { const i = w.Reveal.getIndices(el); w.Reveal.slide(i.h, i.v); }, step: d => (d > 0 ? w.Reveal.next() : w.Reveal.prev()) });
    const vis = e => { const r = e.getBoundingClientRect(), cs = w.getComputedStyle(e); if (!r.width || !r.height || cs.visibility === 'hidden' || +cs.opacity < 0.05) return 0; const ix = Math.min(r.right, w.innerWidth) - Math.max(r.left, 0), iy = Math.min(r.bottom, w.innerHeight) - Math.max(r.top, 0); return ix > 0 && iy > 0 ? ix * iy : 0; };
    for (const sel of (cfg.slides ? [cfg.slides] : ['.slide', '.reveal .slides > section', '.remark-slide-container', '.step', '[data-slide]', 'body > section', 'main > section'])) {
      let list; try { list = [...fd.querySelectorAll(sel)]; } catch (_) { continue; }
      list = list.filter(e => !list.some(o => o !== e && o.contains(e)));
      if (!(cfg.slides ? list.length : list.length >= 2)) continue;
      /* a deck shows one slide at a time; several whole candidates on screen means a page (poster, report) */
      if (!cfg.slides && list.filter(e => { const r = e.getBoundingClientRect(); return vis(e) > 0.6 * r.width * r.height; }).length >= 2) continue;
      const current = () => list.find(e => /(^|\s)(active|current|present|is-active|selected|visible)(\s|$)/.test(e.className) && e.getClientRects().length) || list.map(e => [vis(e), e]).sort((a, b) => b[0] - a[0])[0][1];
      const key = d => { const k = d > 0 ? 'ArrowRight' : 'ArrowLeft', ev = new w.KeyboardEvent('keydown', { key: k, code: k, bubbles: true, cancelable: true }); Object.defineProperty(ev, 'keyCode', { get: () => (d > 0 ? 39 : 37) }); Object.defineProperty(ev, 'which', { get: () => (d > 0 ? 39 : 37) }); (fd.body || fd).dispatchEvent(ev); };
      const step = d => { const before = current(); key(d); setTimeout(() => { if (current() === before) { const t = list[list.indexOf(before) + d]; if (t) t.scrollIntoView({ block: 'start' }); } }, 160); };
      const go = async el => { for (let k = 0; k < list.length + 2; k++) { const c = list.indexOf(current()), t = list.indexOf(el); if (c === t) return; key(t > c ? 1 : -1); await new Promise(r => setTimeout(r, 70)); if (list.indexOf(current()) === c) { el.scrollIntoView({ block: 'start' }); return; } } };
      return Object.assign(base, { kind: 'slides', slides: () => list, current, go, step });
    }
  }
  const de = fd.documentElement;
  return Object.assign(base, { kind: 'page', page: true, slides: () => [de], current: () => de, go() {}, step: d => w.scrollBy({ top: d * w.innerHeight * 0.85 }), title: () => fd.title || INFO.name, label: () => L('整页'), count: () => 1, notes: () => null });
}

/* ---------- geometry and targets ---------- */
function geom() {
  const el = act(); if (!el) return null;
  if (A.page) { const de = fd.documentElement, b = fd.body, w = Math.max(de.scrollWidth, b ? b.scrollWidth : 0), h = Math.max(de.scrollHeight, b ? b.scrollHeight : 0); return { W: w, H: h, left: -fw.scrollX, top: -fw.scrollY, width: w, height: h }; }
  const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null;
  return { W: el.offsetWidth || r.width, H: el.offsetHeight || r.height, left: r.left, top: r.top, width: r.width, height: r.height };
}
function placeLayer() {   /* keep the layer exactly over the current page; true when the page size changed */
  const g = geom(); if (!g || !layer) return false;
  if (G && ['W', 'H', 'left', 'top', 'width', 'height'].every(k => Math.abs(G[k] - g[k]) < 0.25)) return false;
  const resized = !G || G.W !== g.W || G.H !== g.H; G = g;
  layer.style.width = g.W + 'px'; layer.style.height = g.H + 'px';
  layer.style.transform = 'translate(' + g.left + 'px,' + g.top + 'px) scale(' + g.width / g.W + ',' + g.height / g.H + ')';
  layer.style.setProperty('--u', String(g.W / g.width / zk)); svg.setAttribute('viewBox', '0 0 ' + g.W + ' ' + g.H); if (lsvg) lsvg.setAttribute('viewBox', '0 0 ' + g.W + ' ' + g.H);
  return resized;
}
function xy(cx, cy) { placeLayer(); return G ? [(cx - G.left) / G.width * G.W, (cy - G.top) / G.height * G.H] : [0, 0]; }
function client(x, y) { placeLayer(); return [G.left + x / G.W * G.width, G.top + y / G.H * G.height]; }
function inUnit(cx, cy) { placeLayer(); return !!G && cx >= G.left && cx <= G.left + G.width && cy >= G.top && cy <= G.top + G.height; }
function under(cx, cy) { return fd.elementsFromPoint(cx, cy).find(e => !layer.contains(e) && e !== layer && !pop.contains(e) && e !== pop) || null; }
function boundsOf(el) { const r = el.getBoundingClientRect(), a = xy(r.left, r.top), b = xy(r.right, r.bottom); return { x: r1(a[0]), y: r1(a[1]), w: r1(b[0] - a[0]), h: r1(b[1] - a[1]) }; }
function rectsOf(rg) { return [...rg.getClientRects()].filter(r => r.width > 1 && r.height > 1).slice(0, 40).map(r => { const a = xy(r.left, r.top), b = xy(r.right, r.bottom); return { x: r1(a[0]), y: r1(a[1]), w: r1(b[0] - a[0]), h: r1(b[1] - a[1]) }; }); }
function cssPath(el, root) {
  const p = [];
  while (el && el !== root) {
    let s = el.tagName.toLowerCase(); const par = el.parentElement;
    if (par) { const sib = [...par.children].filter(c => c.tagName === el.tagName); if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')'; }
    p.unshift(s); el = par;
  }
  return p.join(' > ');
}
function findByPath(root, path) { try { return root && path ? root.querySelector(':scope > ' + path) : null; } catch (_) { return null; } }
function describe(el, root) {
  if (!el || !root || !root.contains(el) || el === root) return { tag: A.page ? 'page' : 'slide' };
  const imgs = el.tagName === 'IMG' ? [el] : [...el.querySelectorAll('img')];
  const img = el.tagName === 'IMG' ? el : (imgs.length === 1 && norm(el.innerText).length < 80 ? imgs[0] : null);
  const t = { tag: el.tagName.toLowerCase(), path: cssPath(el, root), text: norm(el.innerText || el.textContent).slice(0, 260) };
  const cls = typeof el.className === 'string' ? el.className.replace(/\s*rv-[\w-]+/g, '').trim() : ''; if (cls) t.cls = cls;
  if (el.id) t.id = el.id;
  if (img) { t.asset = img.dataset.asset || ''; t.alt = img.alt || ''; const src = img.getAttribute('src') || ''; if (src && !/^data:/.test(src)) t.src = src.slice(0, 300); }
  return t;
}
const targetLine = t => !t || t.tag === 'slide' || t.tag === 'page' ? '' : (t.asset != null ? L('图片') + (t.asset || t.src ? L('：') + (t.asset || t.src.split('/').pop()) : '') + (t.alt ? L('（') + t.alt.slice(0, 40) + L('）') : '') : (t.text ? '“' + t.text.slice(0, 70) + (t.text.length > 70 ? '…' : '') + '”' : '<' + t.tag + '>'));
function blockOf(el, root) {   /* the thing a click refers to: an image, a marked text block, or the nearest non-inline box */
  if (!el || !root || !root.contains(el) || el === root) return null;
  const m = el.closest('[data-rv-block]'); if (m && root.contains(m) && m !== root) return m;
  if (el.ownerSVGElement) el = el.ownerSVGElement;
  while (el && el !== root && el.tagName !== 'IMG' && el.tagName.toLowerCase() !== 'svg' && fw.getComputedStyle(el).display === 'inline') el = el.parentElement;
  if (!el || el === root || el === fd.body) return null;
  if (el.tagName !== 'IMG' && G) { const r = el.getBoundingClientRect(); if (r.width * r.height > 0.85 * G.width * G.height) return null; }
  return el;
}
function caretAt(cx, cy) {
  let n = null, o = 0;
  if (fd.caretRangeFromPoint) { const r = fd.caretRangeFromPoint(cx, cy); if (r) { n = r.startContainer; o = r.startOffset; } }
  else if (fd.caretPositionFromPoint) { const p = fd.caretPositionFromPoint(cx, cy); if (p) { n = p.offsetNode; o = p.offset; } }
  return n && n.nodeType === 3 ? { node: n, off: o } : null;
}
const nearRects = (rs, cx, cy, pad) => rs.some(r => cx >= r.left - pad && cx <= r.right + pad && cy >= r.top - pad && cy <= r.bottom + pad);
function textNodes(el) { const tw = fd.createTreeWalker(el, 4), out = []; let n, pos = 0; while ((n = tw.nextNode())) { out.push([n, pos]); pos += n.data.length; } return out; }
function offsetIn(el, node, off) { if (node.nodeType !== 3) return -1; for (const [n, p] of textNodes(el)) if (n === node) return p + off; return -1; }
function rangeIn(el, a, b) {
  const ns = textNodes(el); if (!ns.length) return null;
  const at = (k, end) => { let j = 0; for (let i = 0; i < ns.length; i++) if (end ? ns[i][1] < k : ns[i][1] <= k) j = i; return [ns[j][0], Math.max(0, Math.min(ns[j][0].data.length, k - ns[j][1]))]; };
  const rg = fd.createRange(); rg.setStart(...at(a, false)); rg.setEnd(...at(b, true)); return rg;
}
function textBlockAt(cx, cy) {
  const root = act(), c = caretAt(cx, cy); if (!root || !c || !root.contains(c.node) || layer.contains(c.node)) return null;
  const blk = blockOf(c.node.parentElement, root); if (!blk || blk.tagName === 'IMG' || blk.tagName.toLowerCase() === 'svg' || !norm(blk.textContent)) return null;
  return nearRects([blk.getBoundingClientRect()], cx, cy, 6) ? { blk, c } : null;
}
function sentenceAt(cx, cy) {
  const hit = textBlockAt(cx, cy); if (!hit) return null;
  const ns = textNodes(hit.blk); let full = '', pos = -1;
  ns.forEach(([n, p]) => { if (n === hit.c.node) pos = p + hit.c.off; full += n.data; });
  if (pos < 0) return null;
  const isEnd = i => {
    const ch = full[i]; if ('。！？；'.includes(ch)) return true; if (!'.!?;'.includes(ch)) return false;
    const nx = full[i + 1]; if (nx !== undefined && !/\s/.test(nx)) return false;
    if (ch === '.' && /\b(e\.g|i\.e|et al|Fig|Eq|vs|cf|Sec|Tab|No)$/.test(full.slice(Math.max(0, i - 6), i))) return false;
    const rest = full.slice(i + 1).replace(/^\s+/, ''); return !rest || !/^[a-z]/.test(rest);
  };
  let a = 0, b = full.length;
  for (let i = Math.min(pos, full.length) - 1; i >= 0; i--) if (isEnd(i)) { a = i + 1; break; }
  for (let i = Math.max(pos, a); i < full.length; i++) if (isEnd(i)) { b = i + 1; break; }
  while (a < b && /\s/.test(full[a])) a++; while (b > a && /\s/.test(full[b - 1])) b--;
  if (a >= b) return null;
  const rg = rangeIn(hit.blk, a, b);
  return rg && nearRects([...rg.getClientRects()], cx, cy, 14) ? { range: rg, text: full.slice(a, b), blk: hit.blk, span: [a, b] } : null;
}
function clean(html) {
  const t = document.createElement('template'); t.innerHTML = String(html || '');
  t.content.querySelectorAll('script,iframe,object,embed,style,link,meta').forEach(n => n.remove());
  t.content.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => { if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name); }));
  return t.innerHTML;
}
/* on a scrolling page the layout can reflow, so marks follow their element instead of fixed coordinates */
function anchorOf(b, tg) {
  if (!A.page || !tg || !tg.path) return undefined;
  const el = findByPath(act(), tg.path); if (!el) return undefined; const e = boundsOf(el); if (!e.w || !e.h) return undefined;
  return { fx: (b.x - e.x) / e.w, fy: (b.y - e.y) / e.h, fw: b.w != null ? b.w / e.w : null, fh: b.h != null ? b.h / e.h : null };
}
function posOf(it) {
  if (it.type === 'el') { const el = findByPath(act(), it.target && it.target.path); if (el) return boundsOf(el); }
  if (!A.page || !it.anchor || !it.target) return it;
  const el = findByPath(act(), it.target.path); if (!el) return it; const e = boundsOf(el), a = it.anchor, o = { x: r1(e.x + a.fx * e.w), y: r1(e.y + a.fy * e.h) };
  if (it.w != null && a.fw != null) { o.w = r1(a.fw * e.w); o.h = r1(a.fh * e.h); } return o;
}

/* ---------- items ---------- */
function sinfo(sl) { placeLayer(); return { n: nOf(sl), page: A.label(sl), title: A.title(sl), w: G ? r1(G.W) : null, h: G ? r1(G.H) : null }; }
function add(type, extra, opt) {
  const sl = act(); if (!sl) return null; opt = opt || {};
  if (!opt.nosnap) snap();
  if (!S.items.length) S.build = INFO.build;
  const it = Object.assign({ id: uid(), type, kind: KIND0[type] || 'comment', slide: sinfo(sl), text: '', images: [], created: new Date().toISOString() }, extra || {});
  if (it.x != null && it.target && !it.anchor) { const an = anchorOf(it, it.target); if (an) it.anchor = an; }
  S.items.push(it); selId = it.id; tab = 'slide'; save(); render(); focusCard(it.id, opt.focus); return it;
}
function single(type, extra, match) {
  const ex = itemsOf(nOf(act())).find(i => i.type === type && (!match || match(i)));
  if (ex) { selId = ex.id; tab = 'slide'; render(); focusCard(ex.id); return ex; }
  return add(type, extra);
}
function remove(id) { const it = byId(id); if (!it) return; snap(); gone.add(id); S.items = S.items.filter(i => i.id !== id); if (selId === id) selId = null; if (penId === id) penId = null; if (it.type === 'edit') syncEdits(); save(); render(); setStatus(L('已删除这条，⌘Z 可以撤销')); }
function markSel() { if (layer) layer.querySelectorAll('[data-id]').forEach(m => m.classList.toggle('sel', m.dataset.id === selId)); body.querySelectorAll('.rv-card').forEach(c => c.classList.toggle('sel', c.dataset.id === selId)); }
function select(id) {
  selId = id; if (tab !== 'slide') { tab = 'slide'; renderSide(); }
  markSel(); const c = body.querySelector('.rv-card[data-id="' + id + '"]'); if (c) c.scrollIntoView({ block: 'nearest' });
}
function focusCard(id, sel) {
  const c = body.querySelector('.rv-card[data-id="' + id + '"]'); if (!c) return; c.scrollIntoView({ block: 'nearest' });
  if (sel === false) return;
  const f = c.querySelector(sel || (c.querySelector('[data-f=title]') ? '[data-f=title]' : 'textarea')); if (f) f.focus({ preventScroll: true });
}
/* ---------- laser pointer: shows where you point, and records nothing ---------- */
let lz = null, lsvg = null, ldot = null, lpts = [], lraf = 0, ldown = false;
function laserMove(e) {
  if (!ldot) return;
  if (!inUnit(e.clientX, e.clientY)) { ldot.style.display = 'none'; return; }
  const [x, y] = xy(e.clientX, e.clientY);
  ldot.style.display = 'block'; ldot.style.left = x + 'px'; ldot.style.top = y + 'px';
  lpts.push([x, y, performance.now(), ldown ? 1100 : 90, ldown]); if (lpts.length > 800) lpts.shift();   /* a short tail; held down, the stroke stays about a second */
  if (!lraf) lraf = requestAnimationFrame(laserDraw);
}
function laserDraw() {
  lraf = 0; if (!lsvg) return;
  const now = performance.now(); lpts = lpts.filter(p => now - p[2] < p[3]);
  /* when the button is not held, the tail is also capped in length, so a fast move does not draw a line */
  for (let i = lpts.length - 1, len = 0, cap = 28 * U(); i > 0; i--) {
    if (lpts[i][4]) break;
    len += Math.hypot(lpts[i][0] - lpts[i - 1][0], lpts[i][1] - lpts[i - 1][1]);
    if (len > cap) { lpts = lpts.filter((p, k) => p[4] || k >= i); break; }
  }
  let h = '';
  for (let i = 1; i < lpts.length; i++) {
    const a = lpts[i - 1], b = lpts[i]; if (b[2] - a[2] > 140 || a[4] !== b[4]) continue;
    h += '<line x1="' + a[0].toFixed(1) + '" y1="' + a[1].toFixed(1) + '" x2="' + b[0].toFixed(1) + '" y2="' + b[1].toFixed(1) + '" opacity="' + Math.max(0, 1 - (now - b[2]) / b[3]).toFixed(2) + '"/>';
  }
  lsvg.innerHTML = h;
  if (lpts.length && tool === 'laser') lraf = requestAnimationFrame(laserDraw);
}
function laserOff() { lpts = []; ldown = false; if (lsvg) lsvg.innerHTML = ''; if (ldot) ldot.style.display = 'none'; }

/* ---------- presentation mode: full screen, only the slides and the laser pointer ---------- */
let prevTool = null, toastT = null;
const toastEl = document.createElement('div'); toastEl.id = 'rv-toast'; document.body.appendChild(toastEl);
function toast(t) { toastEl.textContent = t; toastEl.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => { toastEl.style.display = 'none'; }, 4500); }
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
function present(on) {
  const cur = document.body.classList.contains('present'); if (on === undefined) on = !cur; if (on === cur) return;
  document.body.classList.toggle('present', on);
  if (fd) fd.documentElement.classList.toggle('rv-present', on);
  if (on) {
    prevTool = tool; setTool('laser');
    const el = document.documentElement, rq = el.requestFullscreen || el.webkitRequestFullscreen;
    if (rq) { try { const p = rq.call(el); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
    toast(L('演示模式 · ← → 或空格翻页 · L 激光笔 · V 普通鼠标 · Esc 或 F 退出'));
  } else {
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (fsEl() && ex) { try { const p = ex.call(document); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
    setTool(prevTool && prevTool !== 'laser' ? prevTool : 'browse'); toastEl.style.display = 'none';
  }
  setTimeout(tick, 150); setTimeout(tick, 700);
}
['fullscreenchange', 'webkitfullscreenchange'].forEach(t => document.addEventListener(t, () => { if (!fsEl() && document.body.classList.contains('present')) present(false); setTimeout(tick, 150); }));

function setTool(t) {
  if (editing) editing.el.blur();
  if (OFF[t]) { setStatus(OFF[t]); t = 'browse'; }
  tool = t; penId = null; if (t !== 'laser') laserOff();
  top.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  $('#rv-hint').textContent = (TOOLS.find(x => x[0] === t) || TOOLS[0])[3];
  if (!fd) return;
  hov.innerHTML = ''; pop.style.display = 'none';
  const de = fd.documentElement; TOOLS.forEach(x => de.classList.toggle('rv-t-' + x[0], x[0] === t)); de.classList.toggle('rv-draw', DRAW.includes(t));
}

/* ---------- in-place text edits (HTML only) ---------- */
function syncEdits() {
  origHtml.forEach((h, el) => { el.innerHTML = h; el.classList.remove('rv-edited'); }); origHtml.clear();
  if (!HTML || !A) return;
  const all = A.slides();
  S.items.filter(i => i.type === 'edit').forEach(it => {
    const el = findByPath(all[it.slide.n - 1], it.target && it.target.path);
    if (!el || norm(el.textContent) !== it.original) return;
    origHtml.set(el, el.innerHTML); el.innerHTML = clean(it.newHtml || esc(it.replacement)); el.classList.add('rv-edited');
  });
}
function startEdit(blk, cx, cy) {
  if (editing) editing.el.blur();
  if (!origHtml.has(blk)) origHtml.set(blk, blk.innerHTML);
  editing = { el: blk, sl: act(), before: blk.innerHTML }; editCancel = false;
  blk.setAttribute('contenteditable', 'plaintext-only'); if (blk.contentEditable !== 'plaintext-only') blk.setAttribute('contenteditable', 'true');
  blk.classList.add('rv-editing'); blk.classList.remove('rv-edited'); blk.focus();
  const c = caretAt(cx, cy); if (c && blk.contains(c.node)) fw.getSelection().collapse(c.node, c.off);
  blk.addEventListener('blur', endEdit, { once: true }); hov.innerHTML = '';
}
function endEdit() {
  if (!editing) return; const { el, sl, before } = editing; editing = null;
  el.removeAttribute('contenteditable'); el.classList.remove('rv-editing');
  if (editCancel) el.innerHTML = before;
  const tmp = document.createElement('div'); tmp.innerHTML = origHtml.get(el);
  const o = norm(tmp.textContent), now = norm(el.textContent), n = nOf(sl), path = cssPath(el, sl);
  const it = S.items.find(i => i.type === 'edit' && i.slide.n === n && i.target && i.target.path === path);
  if (now === o) {
    el.innerHTML = origHtml.get(el); origHtml.delete(el);
    if (it) { snap(); S.items = S.items.filter(x => x !== it); save(); }
    render(); return;
  }
  el.classList.add('rv-edited');
  const f = { original: o, replacement: now, newHtml: clean(el.innerHTML) };
  if (it) { if (it.replacement !== now) { snap(); Object.assign(it, f); selId = it.id; save(); } render(); }
  else { const tg = describe(el, sl); tg.text = o.slice(0, 260); add('edit', Object.assign(f, { target: tg }), { focus: false }); }
  setStatus(L('已记下这处改字。可以在右侧补一句原因'), 'ok');
}

/* ---------- drawing ---------- */
const boxOf = (a, b) => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) });
const place = (el, b) => { el.style.left = b.x + 'px'; el.style.top = b.y + 'px'; el.style.width = b.w + 'px'; el.style.height = b.h + 'px'; };
const sv = (tag, at) => { const e = fd.createElementNS(NS, tag); for (const k in at) e.setAttribute(k, at[k]); svg.appendChild(e); return e; };
const penD = p => { let d = 'M' + p[0] + ',' + p[1]; for (let i = 2; i < p.length; i += 2) d += 'L' + p[i] + ',' + p[i + 1]; return p.length === 2 ? d + 'l0.1,0' : d; };
function arrowD(x, y, x2, y2) {
  const a = Math.atan2(y2 - y, x2 - x), L = 17 * U(), p = s => (x2 - L * Math.cos(a + s)).toFixed(1) + ',' + (y2 - L * Math.sin(a + s)).toFixed(1);
  return 'M' + x + ',' + y + 'L' + x2 + ',' + y2 + 'M' + p(0.45) + 'L' + x2 + ',' + y2 + 'L' + p(-0.45);
}
function penBox(strokes) { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; strokes.forEach(p => { for (let i = 0; i < p.length; i += 2) { a = Math.min(a, p[i]); c = Math.max(c, p[i]); b = Math.min(b, p[i + 1]); d = Math.max(d, p[i + 1]); } }); return { x: a, y: b, w: c - a, h: d - b }; }
const targetAt = (cx, cy) => describe(blockOf(under(cx, cy), act()), act());
const centreTarget = b => targetAt(...client(b.x + (b.w || 0) / 2, b.y + (b.h || 0) / 2));
function onDown(e) {
  if (e.button || !A || pop.contains(e.target)) return;
  if (tool === 'laser') { ldown = true; laserMove(e); return; }
  const inLayer = layer.contains(e.target), mk = inLayer && e.target.closest('[data-id]');
  const [x, y] = xy(e.clientX, e.clientY);
  if (mk) {
    const it = byId(mk.dataset.id); e.stopPropagation(); if (!it) return; select(it.id);
    if (!mk.classList.contains('rv-mv')) return;
    const p = posOf(it); drag = { mode: e.target.closest('.rv-rs') ? 'resize' : 'move', it, x0: x, y0: y, o: { x: p.x, y: p.y, w: p.w, h: p.h }, moved: false };
  } else {
    const mode = DRAW.includes(tool) ? tool : (tool === 'browse' && e.pointerType === 'pen' ? 'pen' : null);
    if (!mode || !inUnit(e.clientX, e.clientY)) return;
    e.stopPropagation();
    if (mode === 'pin') { e.preventDefault(); add('pin', { x: r1(x), y: r1(y), target: targetAt(e.clientX, e.clientY) }); setTool('browse'); noClick = Date.now() + 300; return; }
    if (mode === 'box') { drag = { mode, x0: x, y0: y, el: fd.createElement('div') }; drag.el.className = 'rv-rect rv-draft'; layer.appendChild(drag.el); }
    else if (mode === 'pen') { drag = { mode, pts: [r1(x), r1(y)] }; drag.el = sv('path', { class: 'rv-stroke', d: penD(drag.pts) }); }
    else { drag = { mode, x0: r1(x), y0: r1(y), el: sv('path', { class: 'rv-stroke', d: '' }) }; }
  }
  e.preventDefault(); try { layer.setPointerCapture(e.pointerId); } catch (_) {}
}
function onMove(e) {
  if (tool === 'laser') { laserMove(e); return; }
  if (!drag) { hoverAt(e); return; }
  e.preventDefault(); e.stopPropagation(); const [x, y] = xy(e.clientX, e.clientY);
  if (drag.mode === 'box') place(drag.el, boxOf([drag.x0, drag.y0], [x, y]));
  else if (drag.mode === 'pen') { const p = drag.pts, n = p.length; if (Math.hypot(x - p[n - 2], y - p[n - 1]) >= 2.5 * U()) { p.push(r1(x), r1(y)); drag.el.setAttribute('d', penD(p)); } }
  else if (drag.mode === 'arrow') drag.el.setAttribute('d', arrowD(drag.x0, drag.y0, r1(x), r1(y)));
  else {
    const dx = x - drag.x0, dy = y - drag.y0, it = drag.it, o = drag.o;
    if (!drag.moved) { if (Math.hypot(dx, dy) < 2 * U()) return; snap(); drag.moved = true; delete it.anchor; }
    if (drag.mode === 'move') { it.x = r1(o.x + dx); it.y = r1(o.y + dy); if (o.w != null) { it.w = o.w; it.h = o.h; } }
    else { let w = Math.max(30 * U(), o.w + dx), h = Math.max(20 * U(), o.h + dy); if (it.type === 'image') h = w * o.h / o.w; it.x = o.x; it.y = o.y; it.w = r1(w); it.h = r1(h); }
    const m = marks.querySelector('[data-id="' + it.id + '"]'); if (m) { m.style.left = it.x + 'px'; m.style.top = it.y + 'px'; if (it.w != null) { m.style.width = it.w + 'px'; m.style.height = it.h + 'px'; } }
  }
}
function onUp(e) {
  if (tool === 'laser') { ldown = false; return; }
  if (!drag) return; const d = drag; drag = null; e.stopPropagation(); noClick = Date.now() + 300;
  try { layer.releasePointerCapture(e.pointerId); } catch (_) {}
  const [x, y] = xy(e.clientX, e.clientY);
  if (d.mode === 'box') {
    const b = boxOf([d.x0, d.y0], [x, y]); d.el.remove(); if (b.w < 8 * U() || b.h < 8 * U()) return;
    const bb = { x: r1(b.x), y: r1(b.y), w: r1(b.w), h: r1(b.h) }; add('box', Object.assign(bb, { target: centreTarget(bb) })); setTool('browse');
  } else if (d.mode === 'pen') {
    d.el.remove(); const cur = byId(penId);
    if (cur && cur.slide.n === nOf(act())) { snap(); cur.strokes.push(d.pts); Object.assign(cur, penBox(cur.strokes)); save(); selId = cur.id; renderMarks(); markSel(); }
    else { const b = penBox([d.pts]); const it = add('pen', Object.assign({ strokes: [d.pts], target: centreTarget(b) }, b), { focus: e.pointerType === 'pen' ? false : undefined }); penId = it.id; }
  } else if (d.mode === 'arrow') {
    d.el.remove(); if (Math.hypot(x - d.x0, y - d.y0) < 15 * U()) return;
    add('arrow', { x: d.x0, y: d.y0, x2: r1(x), y2: r1(y), target: targetAt(...client(d.x0, d.y0)), target2: targetAt(e.clientX, e.clientY) }); setTool('browse');
  } else if (d.moved) {
    const it = d.it; if (it.type === 'pin' || it.type === 'box') it.target = centreTarget(it);
    const an = anchorOf(it, it.target); if (an) it.anchor = an;
    save(); renderSide(); renderMarks();
  }
}
let hovT = 0;
function hover(rects) { hov.innerHTML = ''; rects.forEach(r => { const d = fd.createElement('div'); d.className = 'rv-hov'; place(d, r); hov.appendChild(d); }); }
function hoverAt(e) {
  if (!MODAL.includes(tool) || hovT) return;
  hovT = requestAnimationFrame(() => {
    hovT = 0; const root = act();
    if (!root || editing || !MODAL.includes(tool)) { hov.innerHTML = ''; return; }
    if (tool === 'sent') { const s = sentenceAt(e.clientX, e.clientY); hover(s ? rectsOf(s.range) : []); }
    else if (tool === 'edit') { const h = textBlockAt(e.clientX, e.clientY); hover(h ? [boundsOf(h.blk)] : []); }
    else { const el = blockOf(under(e.clientX, e.clientY), root); hover(el ? [boundsOf(el)] : []); }
  });
}
function onClick(e) {   /* capture phase, inside the document */
  const t = e.target;
  if (layer.contains(t) || pop.contains(t)) { if (layer.contains(t)) e.stopPropagation(); return; }
  if (Date.now() < noClick) { e.preventDefault(); e.stopPropagation(); return; }
  if (editing && editing.el.contains(t)) { e.stopPropagation(); return; }
  if (!MODAL.includes(tool)) return;
  const root = act(); if (!root || !root.contains(t)) return;
  e.preventDefault(); e.stopPropagation(); hov.innerHTML = '';
  if (tool === 'sent') { const s = sentenceAt(e.clientX, e.clientY); if (s) addText(s.range, s.text, 'comment', s.blk, s.span); else setStatus(L('这里没有文字。评论图片或空白处请用“选元素”或“点评”')); }
  else if (tool === 'el') { const el = blockOf(t, root); if (el) add('el', Object.assign({ target: describe(el, root) }, boundsOf(el))); else setStatus(L('这里选不到单独的元素，请用“框选”')); }
  else { const h = textBlockAt(e.clientX, e.clientY); if (h) startEdit(h.blk, e.clientX, e.clientY); else setStatus(L('这里没有可以改的文字')); }
}
function shield(e) {   /* keep the document's own handlers quiet while a tool is working on its content */
  if (layer.contains(e.target)) { e.stopPropagation(); return; }
  if (pop.contains(e.target)) return;
  if ((MODAL.includes(tool) || editing) && act() && act().contains(e.target)) e.stopPropagation();
}

/* comment on selected text */
function addText(rg, text, op, host, span) {
  const root = act(); let anc = rg.commonAncestorContainer; if (anc.nodeType !== 1) anc = anc.parentElement;
  host = host || blockOf(anc, root) || anc; if (!host.contains(anc)) host = anc;
  if (!span) { const a = offsetIn(host, rg.startContainer, rg.startOffset), b = offsetIn(host, rg.endContainer, rg.endOffset); if (a >= 0 && b > a) span = [a, b]; }
  const ex = { quote: norm(text || rg.toString()).slice(0, 1200), replacement: '', rects: rectsOf(rg), target: describe(host, root) };
  if (span) ex.span = span;
  if (op === 'delete') { ex.kind = 'remove'; ex.text = L('删掉这句'); } else if (op === 'short') { ex.kind = 'text'; ex.text = L('太长，缩短'); } else if (op === 'rewrite') ex.kind = 'text';
  add('text', ex, { focus: op === 'rewrite' ? '[data-f=replacement]' : undefined });
}
function checkSel() {
  if (!fd) return; const s = fw.getSelection(), root = act();
  if (tool !== 'browse' || editing || drag || !s || s.isCollapsed || !root || !root.contains(s.anchorNode) || layer.contains(s.anchorNode) || !s.toString().trim()) { pop.style.display = 'none'; return; }
  const r = s.getRangeAt(0).getBoundingClientRect();
  pop.style.display = 'flex';
  pop.style.left = Math.max(8, Math.min(fw.innerWidth - Math.max(250, pop.offsetWidth + 8), r.left)) + 'px';
  pop.style.top = Math.min(fw.innerHeight - 48, r.bottom + 8) + 'px';
}
let selT = null;

function renderMarks() {
  if (!layer) return; marks.innerHTML = ''; svg.innerHTML = '';
  const sl = act(); if (!sl) return; placeLayer(); const ops = [];
  itemsOf(nOf(sl)).forEach((it, k) => {
    const num = String(k + 1), sel = it.id === selId ? ' sel' : '', tag = '<i>' + num + '</i>', p = posOf(it);
    const mk = (cls, b, html) => { const m = fd.createElement('div'); m.className = 'rv-mark ' + cls + sel; m.dataset.id = it.id; m.style.left = b.x + 'px'; m.style.top = b.y + 'px'; if (b.w != null) { m.style.width = b.w + 'px'; m.style.height = b.h + 'px'; } if (html) m.innerHTML = html; marks.appendChild(m); };
    const path = d => { sv('path', { d, class: 'rv-hit', 'data-id': it.id }); sv('path', { d, class: 'rv-stroke' + sel, 'data-id': it.id }); };
    if (it.type === 'pin') mk('rv-dot rv-mv', { x: p.x, y: p.y }, num);
    else if (it.type === 'box') mk('rv-rect rv-mv', p, tag + '<span class="rv-rs"></span>');
    else if (it.type === 'ink') mk('rv-ink', it, '<i>' + num + ' ' + L('手写') + '</i>');
    else if (it.type === 'el') mk('rv-elr', p, tag);
    else if (it.type === 'text') {
      let rs = it.rects || [];
      if (it.span && it.target && it.target.path) { const el = findByPath(sl, it.target.path), rg = el && rangeIn(el, it.span[0], it.span[1]); if (rg && norm(rg.toString()) === it.quote) { const live = rectsOf(rg); if (live.length) rs = live; } }
      rs.forEach((r, j) => mk('rv-hl', r, j ? '' : tag));
    }
    else if (it.type === 'edit') { const el = findByPath(sl, it.target && it.target.path); if (el) mk('rv-edr', boundsOf(el), '<i>' + num + ' ' + L('已改字') + '</i>'); }
    else if (it.type === 'image') {
      const m0 = (it.images || [])[0], inner = !m0 ? '<b>' + L('图片') + '</b>' : /\.pdf$/i.test(m0.name) ? '<b>PDF</b>' : '<img src="' + esc(imgUrl(m0)) + '" alt="" draggable="false">';
      mk('rv-img rv-mv', p, inner + '<i>' + num + ' ' + IMGLAB[it.mode || 'add'] + '</i><span class="rv-rs"></span>');
    }
    else if (it.type === 'pen') { (it.strokes || []).forEach(s => path(penD(s))); mk('rv-tagn', { x: it.x, y: it.y }, num); }
    else if (it.type === 'arrow') { path(arrowD(it.x, it.y, it.x2, it.y2)); mk('rv-tagn', { x: it.x, y: it.y }, num); }
    else if (['new', 'del', 'move', 'op'].includes(it.type)) ops.push('<span class="rv-mark rv-op' + sel + '" data-id="' + it.id + '">' + num + ' · ' + esc(opLabel(it)) + '</span>');
  });
  if (ops.length) { const o = fd.createElement('div'); o.className = 'rv-ops'; o.innerHTML = ops.join(''); marks.appendChild(o); }
}

/* ---------- sidebar ---------- */
const opts = (list, cur) => list.map(([v, l]) => '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>').join('');
function chipsFor(it) {
  if (it.type === 'text') return CHIPS.text; if (it.type === 'image') return CHIPS.image; if (it.type === 'arrow') return CHIPS.arrow;
  if (it.type === 'slide') return CHIPS.slide; if (it.type === 'new') return CHIPS['new'];
  if (['pin', 'box', 'el', 'pen'].includes(it.type)) return it.target && it.target.asset != null ? CHIPS.img : CHIPS.gen;
  return [];
}
function card(it, k) {
  const hasKind = ['pin', 'box', 'el', 'text', 'slide', 'pen', 'arrow'].includes(it.type);
  let h = '<div class="rv-card' + (it.id === selId ? ' sel' : '') + '" data-id="' + it.id + '"><div class="rv-h"><span class="rv-num">' + (k + 1) + '</span><span class="rv-type">' + esc(typeName(it)) + '</span>'
    + (hasKind ? '<select data-f="kind">' + opts(KINDS, it.kind) + '</select>' : '')
    + '<button class="rv-star' + (it.pri ? ' on' : '') + '" data-pri title="' + L('标为重要') + '">★</button><button class="rv-x" data-del title="' + L('删除这条') + '">' + L('删除') + '</button></div>';
  if (it.type === 'text') h += '<div class="rv-q">' + esc(it.quote) + '</div><label class="rv-l">' + L('改成（可留空，只写意见）') + '</label><input type="text" data-f="replacement" value="' + esc(it.replacement) + '">';
  else if (it.type === 'edit') h += '<label class="rv-l">' + L('原文') + '</label><div class="rv-q">' + esc(it.original) + '</div><label class="rv-l">' + L('改成') + '</label><input type="text" data-f="replacement" value="' + esc(it.replacement) + '">';
  else if (it.type === 'arrow') h += '<div class="rv-t">' + L('从 {a} → 到 {b}', { a: esc(targetLine(it.target) || L('空白处')), b: esc(targetLine(it.target2) || L('空白处')) }) + '</div>';
  else if (it.target && targetLine(it.target)) h += '<div class="rv-t" title="' + esc(targetLine(it.target)) + '">' + esc(targetLine(it.target)) + '</div>';
  if (it.tex) h += '<div class="rv-t" title="SyncTeX">TeX' + L('：') + esc(it.tex.file.split('/').pop() + ':' + it.tex.line) + '</div>';
  if (it.type === 'image') h += '<div class="rv-row"><select data-f="mode">' + opts(IMGMODES, it.mode || 'add') + '</select></div>';
  if (it.type === 'new') h += '<div class="rv-row"><select data-f="where">' + opts(pairs([['before', '加在这页前面'], ['after', '加在这页后面']]), it.where || 'after') + '</select><select data-f="layout">' + opts(LAYOUTS, it.layout || 'auto') + '</select></div>'
    + '<label class="rv-l">' + L('新页标题') + '</label><input type="text" data-f="title" value="' + esc(it.title) + '" placeholder="' + L('这一页的结论句') + '">';
  if (it.type === 'move') h += '<div class="rv-row">' + L('移到') + '<select data-f="ref"' + (LANG === 'en' ? ' style="order:1"' : '') + '><option value="">' + L('选一页…') + '</option>' + opts(A.slides().map((s, i) => [i + 1, A.label(s) + L('｜') + A.title(s)]), it.ref || '') + '</select><select data-f="pos" style="flex:none">' + opts(pairs([['before', '之前'], ['after', '之后']]), it.pos || 'after') + '</select></div>';
  const ch = chipsFor(it); if (ch.length) h += '<div class="rv-chips">' + ch.map(c => '<button data-chip="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div>';
  const ph = { 'new': '这一页讲什么、放什么内容和图（图片可以直接粘贴在这里）', del: '原因（可不填）', move: '说明（可不填）', notes: '', slide: '对整页的意见', op: '说明（可不填）', edit: '为什么这么改（可不填）', image: '这张图怎么用：放多大、配什么文字（可不填）', arrow: '说明（可不填）', text: '意见（可不填）', ink: '手写内容在图里。想补充或打字说明可以写在这里', pen: '画的是什么意思（可不填，AI 会看笔迹的位置）' }[it.type];
  h += '<textarea data-f="text" rows="' + (it.type === 'notes' ? 9 : it.type === 'new' ? 4 : 3) + '" placeholder="' + (ph == null ? L('写下意见…') : ph && L(ph)) + '">' + esc(it.text) + '</textarea>';
  h += '<div class="rv-imgs">' + (it.images || []).map((m, j) => '<span class="rv-thumb' + (it.type === 'ink' ? ' big' : '') + '" title="' + esc(m.name) + '">' + (/\.pdf$/i.test(m.name) ? 'PDF' : '<img src="' + esc(imgUrl(m)) + '" alt="">') + (it.type === 'ink' ? '' : '<button data-rmimg="' + j + '">×</button>') + '</span>').join('')
    + '<label class="rv-add">' + L('＋ 图片') + '<input type="file" accept="image/*,.pdf" multiple></label>'
    + (SCOPED.includes(it.type) && !A.page ? '<button class="rv-tog' + (it.all ? ' on' : '') + '" data-all title="' + L('每一页都照这条处理') + '">' + L('所有页') + '</button>' : '')
    + (it.type === 'el' ? '<button class="rv-tog" data-up title="' + L('改为选中外面一层') + '">' + L('选大一层') + '</button>' : '') + '</div></div>';
  return h;
}
function renderSide() {
  const sl = act(); if (!sl) return;
  const info = sinfo(sl), list = itemsOf(info.n), multi = !A.page;
  tabs.innerHTML = '<button data-tab="slide" class="' + (tab === 'slide' ? 'on' : '') + '">' + (multi ? L('本页') : L('标注')) + ' (' + list.length + ')</button>'
    + (multi ? '<button data-tab="all" class="' + (tab === 'all' ? 'on' : '') + '">' + L('全部') + ' (' + S.items.length + ')</button>' : '<button data-tab="all" class="' + (tab === 'all' ? 'on' : '') + '">' + L('总体意见|tab') + '</button>')
    + (LAST ? '<button data-tab="last" class="' + (tab === 'last' ? 'on' : '') + '">' + L('上一轮') + '</button>' : '');
  let h = (newBuild ? '<div class="rv-banner">' + L('文件已经更新。<a data-reload>点这里刷新</a>看新版本。') + '</div>' : '')
    + (stale() ? '<div class="rv-banner">' + L('这些标注是针对旧版文件写的，位置可能已经对不上。处理完后请点“归档并清空”。') + '</div>' : '');
  if (tab === 'slide') {
    const nt = A.notes(sl), ntx = nt ? nt.textContent.trim() : '';
    h += '<div class="rv-slidehead"><b>' + esc(info.page) + '</b>' + esc(info.title) + '</div><div class="rv-acts"><button data-act="slide">' + L('整页意见') + '</button>'
      + (multi ? '<button data-act="before">' + L('前面加一页') + '</button><button data-act="after">' + L('后面加一页') + '</button>' + (HTML ? '<button data-act="notes">' + L('改讲稿') + '</button>' : '') + '<button data-act="move">' + L('移动') + '</button><button data-act="del">' + L('删除') + '</button><select data-more><option value="">' + L('更多…') + '</option>' + opts(Object.entries(OPS), '') + '</select>' : '') + '</div>'
      + (ntx ? '<label class="rv-notes-setting" title="' + L('翻页和刷新后保持展开；取消后可手动展开本页讲稿') + '"><input type="checkbox" data-notes-pin' + (notesPinned ? ' checked' : '') + '>' + L('讲稿始终展开') + '</label><details class="rv-notes' + (notesPinned ? ' pinned' : '') + '"' + (notesOpen || notesPinned ? ' open' : '') + '><summary>' + L('本页讲稿 · {n} 词', { n: ntx.split(/\s+/).length }) + (sl.dataset.time ? L(' · 计划 {t} 秒', { t: esc(sl.dataset.time) }) : '') + '</summary><div>' + esc(ntx) + '</div></details>' : '')
      + (list.length ? list.map(card).join('') : '<div class="rv-empty">' + L('这里还没有标注。') + '<br>' + (TEXT ? L('· <b>选句 T</b>：点一句话就能评论；也可以直接选中文字') + '<br>' : '') + (HTML ? L('· <b>改字 W</b>：点一段文字直接改') + '<br>' : '') + '· <b>' + L('点评') + ' C</b> / <b>' + L('框选') + ' R</b>' + (HTML || TEXT ? ' / <b>' + L('选元素') + ' E</b>' : '') + L('：评论一个位置或一块区域') + '<br>' + L('· <b>截图</b>：截图后按 ⌘V，或把图片拖进来') + '<br>' + L('· <b>画笔 P</b> / <b>箭头 A</b>：随手画、指位置') + (multi ? '<br>' + L('· 上面的按钮：在前面或后面加页、移动、删除') : '') + '</div>');
  } else if (tab === 'all') {
    h += '<label class="rv-l">' + L('总体意见') + '</label><textarea id="rv-general" rows="4" placeholder="' + L('对整个文件的意见') + '">' + esc(S.general) + '</textarea>';
    if (multi) {
      h += '<ul class="rv-out">';
      const ghost = x => '<li class="ghost"><span class="n">＋</span><span class="ti">' + L('新增：') + esc(x.title || L('（未命名）')) + '</span></li>';
      A.slides().forEach((s, i) => {
        const l = itemsOf(i + 1), gone = l.some(x => x.type === 'del'), flags = (gone ? '<span class="rv-flag">' + L('删') + '</span>' : '') + (l.some(x => x.type === 'move') ? '<span class="rv-flag">' + L('移') + '</span>' : '') + (l.some(x => x.pri) ? '<span class="rv-flag">★</span>' : '');
        l.filter(x => x.type === 'new' && x.where === 'before').forEach(x => { h += ghost(x); });
        h += '<li data-goto="' + i + '" class="' + (s === sl ? 'cur ' : '') + (gone ? 'gone' : '') + '"><span class="n">' + esc(shortLab(A.label(s))) + '</span><span class="ti">' + esc(A.title(s)) + '</span>' + flags + (l.length ? '<span class="c">' + l.length + '</span>' : '') + '</li>';
        l.filter(x => x.type === 'new' && x.where !== 'before').forEach(x => { h += ghost(x); });
      });
      h += '</ul>';
    }
  } else if (LAST) {
    h += '<div class="rv-empty" style="padding:0 2px 10px">' + L('上一轮的 {n} 条标注和处理结果。', { n: LAST.items.length }) + '</div>' + (LAST.summary ? '<div class="rv-last"><div class="w">' + L('修改说明') + '</div>' + esc(LAST.summary) + '</div>' : '');
    LAST.items.forEach(it => {
      const lab = dict({ done: '已改', partial: '部分已改', skipped: '没有改' })[it.status] || '', s = it.slide || {};
      h += '<div class="rv-last"><div class="w">' + esc((s.page || '') + (s.title ? L('｜') + s.title : '')) + ' · ' + esc(typeName(it)) + '</div>'
        + esc(it.quote ? '“' + it.quote.slice(0, 120) + '” ' : it.original ? '“' + it.original.slice(0, 80) + '” → “' + (it.replacement || '').slice(0, 80) + '” ' : '') + esc(it.title ? it.title + L('：') : '') + esc(it.text || '')
        + '<div class="rv-reply' + (it.status === 'skipped' ? ' no' : it.reply || lab ? '' : ' none') + '">' + esc((lab ? lab + (it.reply ? L('：') : '') : '') + (it.reply || (lab ? '' : L('没有记录处理结果')))) + '</div></div>';
    });
  }
  body.innerHTML = h;
}
function render() {
  const sl = act(); if (!sl) return;
  $('#rv-page').textContent = A.page ? L('整页') : L('{label} · 共 {n} 页', { label: A.label(sl), n: A.count() });
  renderSide(); renderMarks(); updUndo();
}
const itemOf = el => { const c = el.closest('.rv-card'); return c ? byId(c.dataset.id) : null; };

body.addEventListener('toggle', e => {
  if (!e.target.matches('.rv-notes') || !body.contains(e.target)) return;
  notesOpen = e.target.open;
  if (!notesOpen && notesPinned) setNotesPinned(false);
}, true);
tabs.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; renderSide(); } });
body.addEventListener('click', e => {
  if (e.target.closest('[data-reload]')) { newBuild = false; fw.location.reload(); return; }
  const a = e.target.closest('[data-act]'), sl = act(); if (!sl) return;
  if (a) {
    const t = a.dataset.act, n = nOf(sl);
    if (t === 'slide') add('slide');
    else if (t === 'before' || t === 'after') add('new', { title: '', where: t, layout: 'auto', after: t === 'after' ? n : n - 1 });
    else if (t === 'del') single('del');
    else if (t === 'move') single('move', { ref: '', pos: 'after' });
    else if (t === 'notes') { const nn = A.notes(sl), cur = nn ? nn.textContent.trim() : ''; single('notes', { text: cur, original: cur }); }
    return;
  }
  const it = itemOf(e.target);
  if (e.target.closest('[data-del]')) { if (it) remove(it.id); return; }
  if (e.target.closest('[data-pri]')) { if (it) { snap(); it.pri = !it.pri; e.target.closest('[data-pri]').classList.toggle('on', it.pri); save(); } return; }
  if (e.target.closest('[data-all]')) { if (it) { snap(); it.all = !it.all; e.target.closest('[data-all]').classList.toggle('on', it.all); save(); } return; }
  if (e.target.closest('[data-up]')) {
    const el = it && findByPath(sl, it.target && it.target.path), p = el && el.parentElement;
    if (p && p !== sl && sl.contains(p) && p !== fd.body) { snap(); it.target = describe(p, sl); Object.assign(it, boundsOf(p)); save(); render(); } else setStatus(L('已经是最外面一层了'));
    return;
  }
  const chip = e.target.closest('[data-chip]');
  if (chip && it) { const ta = chip.closest('.rv-card').querySelector('[data-f=text]'), c = chip.dataset.chip; if (!(it.text || '').includes(c)) { snap(); it.text = (it.text ? it.text.replace(/[；;\s]+$/, '') + L('；') : '') + c; ta.value = it.text; save(); } ta.focus(); return; }
  const rm = e.target.closest('[data-rmimg]'); if (rm) { if (it) { snap(); it.images.splice(+rm.dataset.rmimg, 1); save(); render(); } return; }
  const g = e.target.closest('[data-goto]'); if (g) { tab = 'slide'; A.go(A.slides()[+g.dataset.goto]); setTimeout(onSlide, 120); return; }
  const c = e.target.closest('.rv-card'); if (c && c.dataset.id !== selId && !e.target.closest('input,textarea,select,label,button')) select(c.dataset.id);
});
body.addEventListener('change', e => {
  if (e.target.matches('[data-notes-pin]')) {
    setNotesPinned(e.target.checked); notesOpen = notesPinned;
    const panel = body.querySelector('.rv-notes'); if (panel) panel.open = notesOpen;
    return;
  }
  if (e.target.matches('[data-more]')) { const op = e.target.value; e.target.value = ''; if (op) single('op', { op }, i => i.op === op); return; }
  if (e.target.type === 'file') { const it = itemOf(e.target); if (it) attach(it, [...e.target.files]); }
});
body.addEventListener('input', e => {
  if (e.target.matches('[data-more],[data-notes-pin]') || e.target.type === 'file') return;
  if (pre) { hist.push(pre); if (hist.length > 80) hist.shift(); fut.length = 0; pre = null; updUndo(); }
  if (e.target.id === 'rv-general') { S.general = e.target.value; save(); return; }
  const it = itemOf(e.target), f = e.target.dataset.f; if (!it || !f) return;
  it[f] = e.target.value;
  if (f === 'ref') { it.ref = +it.ref || ''; const s = A.slides()[it.ref - 1]; it.refTitle = s ? A.title(s) : ''; it.refPage = s ? A.label(s) : ''; }
  if (f === 'where') it.after = it.where === 'after' ? it.slide.n : it.slide.n - 1;
  if (it.type === 'edit' && f === 'replacement') { const el = findByPath(A.slides()[it.slide.n - 1], it.target && it.target.path); if (el) { el.textContent = it.replacement; it.newHtml = esc(it.replacement); } }
  if (e.target.tagName === 'SELECT' || it.type === 'edit' || f === 'title') { renderMarks(); const tn = e.target.closest('.rv-card').querySelector('.rv-type'); if (tn) tn.textContent = typeName(it); }
  save();
});
body.addEventListener('focusin', e => {
  if (e.target.matches('[data-notes-pin]')) return;
  if (e.target.matches('input,textarea')) pre = JSON.stringify(S);
  const it = itemOf(e.target); if (it && it.id !== selId) { selId = it.id; markSel(); }
});
body.addEventListener('mouseover', e => { const c = e.target.closest('.rv-card'); if (layer) layer.querySelectorAll('[data-id]').forEach(m => m.classList.toggle('hot', !!c && m.dataset.id === c.dataset.id)); });

/* ---------- images: choose, drop or paste ---------- */
const okFile = f => /^image\//.test(f.type) || /\.pdf$/i.test(f.name);
async function attach(it, files, nosnap) {
  files = files.filter(okFile); if (!files.length) return;
  if (!nosnap) snap();
  for (const f of files) {
    try {
      const name = f.name || 'screenshot.' + ((f.type.split('/')[1] || 'png').replace('jpeg', 'jpg'));
      const r = await fetch('api/upload?name=' + encodeURIComponent(name), { method: 'POST', body: f });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json(); it.images.push({ name, path: j.path, url: j.url });
    } catch (_) { setStatus(L('图片上传失败（支持 png、jpg、gif、webp、pdf）'), 'err'); }
  }
  save(); render();
}
async function imgSize(f) { if (!/^image\//.test(f.type) || !window.createImageBitmap) return [480, 320]; try { const b = await createImageBitmap(f), s = [b.width, b.height]; if (b.close) b.close(); return s; } catch (_) { return [480, 320]; } }
async function addImage(files, cx, cy) {   /* put an image on the current page, at a point of the document if one is given */
  files = files.filter(okFile); const sl = act(); if (!files.length || !sl) return;
  placeLayer(); const u = U(); let tg = { tag: A.page ? 'page' : 'slide' }, x, y;
  if (cx != null && inUnit(cx, cy)) { [x, y] = xy(cx, cy); tg = targetAt(cx, cy); }
  else [x, y] = xy(fw.innerWidth / 2, fw.innerHeight / 2);
  const [nw, nh] = await imgSize(files[0]); let w = Math.min(380 * u, Math.max(130 * u, nw)), h = w * nh / nw; if (h > 310 * u) { h = 310 * u; w = h * nw / nh; }
  let b = { x: r1(Math.max(0, Math.min(G.W - w, x - w / 2))), y: r1(Math.max(0, Math.min(G.H - h, y - h / 2))), w: r1(w), h: r1(h) }, mode = 'add';
  if (HTML && tg.asset != null) { const el = findByPath(sl, tg.path); if (el) { b = boundsOf(el); mode = 'replace'; } }
  const it = add('image', Object.assign({ mode, target: tg }, b), { focus: false });
  await attach(it, files, true);
  setStatus(L(mode === 'replace' ? '已标记：用这张图替换原图。右侧可以改成“放在这个位置”' : '图已放到这一页，拖动调整位置，拖右下角调整大小'), 'ok');
}
async function pasteClip() {
  try {
    const fs = [];
    for (const ci of await navigator.clipboard.read()) { const t = ci.types.find(x => x.startsWith('image/')); if (t) fs.push(new File([await ci.getType(t)], 'screenshot.' + t.split('/')[1].replace('jpeg', 'jpg'), { type: t })); }
    if (fs.length) addImage(fs); else setStatus(L('剪贴板里没有图片。先截图到剪贴板（⌃⇧⌘4），再按 ⌘V'), 'err');
  } catch (_) { setStatus(L('浏览器不让直接读剪贴板，请直接按 ⌘V 粘贴')); }
}
function onPaste(e) {
  if (e.defaultPrevented) return;
  const fs = [...(e.clipboardData ? e.clipboardData.files : [])].filter(okFile); if (!fs.length) return;
  e.preventDefault(); addImage(fs);
}
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
fileIn.addEventListener('change', () => { const fs = [...fileIn.files]; fileIn.value = ''; addImage(fs); });
body.addEventListener('paste', e => { const it = itemOf(e.target), fs = [...(e.clipboardData ? e.clipboardData.files : [])].filter(okFile); if (it && fs.length) { e.preventDefault(); attach(it, fs); } });
document.addEventListener('paste', onPaste);
body.addEventListener('dragover', e => { const c = e.target.closest('.rv-card'); if (c && hasFiles(e)) { e.preventDefault(); c.classList.add('drop'); } });
body.addEventListener('dragleave', e => { const c = e.target.closest('.rv-card'); if (c) c.classList.remove('drop'); });
body.addEventListener('drop', e => { const c = e.target.closest('.rv-card'); if (!c || !hasFiles(e)) return; e.preventDefault(); c.classList.remove('drop'); const it = byId(c.dataset.id); if (it) attach(it, [...e.dataTransfer.files]); });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', e => { if (!hasFiles(e) || e.defaultPrevented) return; e.preventDefault(); addImage([...e.dataTransfer.files]); });

/* ---------- toolbar, export, keys ---------- */
async function copyFrom(url, msg) {
  await flush(); let t = '';
  try { t = await (await fetch(url, { cache: 'no-store' })).text(); } catch (_) { setStatus(L('本地服务没有响应'), 'err'); return; }
  try { await navigator.clipboard.writeText(t); }
  catch (_) { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  setStatus(msg, 'ok');
}
async function clearAll() {
  if (!S.items.length && !S.general) return;
  if (!confirm(L('把当前 {n} 条标注归档并清空？（归档后还能在 archive/ 里找到）', { n: S.items.length }))) return;
  try { await flush(); await fetch('api/archive', { method: 'POST' }); } catch (_) {}
  await loadNotes(); setStatus(L('已归档并清空'), 'ok');
}
top.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || !A) return; const d = b.dataset.do;
  if (b.dataset.tool) setTool(b.dataset.tool);
  else if (b.dataset.nav) { A.step(+b.dataset.nav); setTimeout(tick, 120); }
  else if (d === 'img') fileIn.click();
  else if (d === 'paste') pasteClip();
  else if (d === 'undo') undo();
  else if (d === 'redo') redo();
  else if (d === 'zin' || d === 'zout') {
    if (!HTML && fw.__deck && fw.__deck.zoom) fw.__deck.zoom(d === 'zin' ? 1 : -1); else { zfit = false; setZoom(zk * (d === 'zin' ? 1.2 : 1 / 1.2)); }
    setTimeout(tick, 50);
  }
  else if (d === 'zfit') { if (!HTML && fw.__deck && fw.__deck.zoom) fw.__deck.zoom(0); else fitWidth(); setTimeout(tick, 50); }
  else if (d === 'present') present();
  else if (d === 'side') document.body.classList.toggle('noside');
  else if (d === 'help') help.style.display = 'flex'; else if (d === 'lang') switchLang();
});
help.addEventListener('click', e => { if (e.target === help) help.style.display = 'none'; });
$('#rv-foot').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.do === 'prompt') copyFrom('api/prompt?lang=' + LANG, L('指令已复制。粘贴给 Claude 或 Codex 就会按标注改'));
  else if (b.dataset.do === 'copy') copyFrom('api/text?lang=' + LANG, L('标注文字已复制'));
  else if (b.dataset.do === 'clear') clearAll();
});
function onKey(e) {
  const inFrame = fd && e.target && e.target.ownerDocument === fd;
  const field = e.target && e.target.closest && e.target.closest('input,textarea,select,[contenteditable]');
  if (editing) {
    if (e.type === 'keydown') { if (e.key === 'Escape') { editCancel = true; editing.el.blur(); } else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); editing.el.blur(); } }
    e.stopPropagation(); return;
  }
  if (e.type !== 'keydown') return;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'z' || e.key === 'Z') && !field) { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) redo(); else undo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape' && document.body.classList.contains('present')) { present(false); return; }
  if (e.key === 'Escape') { help.style.display = 'none'; setTool('browse'); if (document.activeElement && document.activeElement !== frame && document.activeElement.blur) document.activeElement.blur(); return; }
  if (field) return;
  const k = e.key.toLowerCase(), t = TOOLS.find(x => x[2].toLowerCase() === k);
  if (t) { e.preventDefault(); e.stopPropagation(); setTool(t[0]); return; }
  if (k === 'i') { e.preventDefault(); e.stopPropagation(); fileIn.click(); return; }
  if (k === 'f') { e.preventDefault(); e.stopPropagation(); present(); return; }
  if (!inFrame && A && e.key === ' ' && document.body.classList.contains('present')) { e.preventDefault(); A.step(1); setTimeout(tick, 120); return; }
  if (!inFrame && A) {
    if (['ArrowRight', 'PageDown'].includes(e.key)) { e.preventDefault(); A.step(1); setTimeout(tick, 120); }
    else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); A.step(-1); setTimeout(tick, 120); }
  }
}
document.addEventListener('keydown', onKey);

/* ---------- attach to the document in the iframe ---------- */
function onSlide() {
  const next = act(), changed = next !== curEl;
  if (changed) notesOpen = notesPinned;
  curEl = next; if (editing) editing.el.blur(); pop.style.display = 'none'; hov.innerHTML = ''; penId = null; G = null;
  placeLayer(); render();
  if (changed && notesPinned && tab === 'slide') body.scrollTop = 0;
}
/* ---------- zoom for pages wider than the window (posters, reports): the frame itself is scaled ---------- */
let zk = 1, zfit = false;
function setZoom(k) {
  zk = Math.max(0.12, Math.min(3, k));
  frame.style.width = (100 / zk) + '%'; frame.style.height = (100 / zk) + '%';
  frame.style.transformOrigin = '0 0'; frame.style.transform = Math.abs(zk - 1) < 0.001 ? '' : 'scale(' + zk + ')';
  G = null; setTimeout(() => { if (fd && layer && A) { placeLayer(); renderMarks(); } }, 60);   /* marks keep their size on screen */
}
function fitWidth() {   /* show the whole width of the page */
  if (!fd) return; zfit = true;
  const stage = frame.parentElement.clientWidth, de = fd.documentElement;
  frame.style.width = '100%'; frame.style.transform = '';
  const w = Math.max(de.scrollWidth, fd.body ? fd.body.scrollWidth : 0);
  setZoom(w > stage + 2 ? stage / w : 1);
}
addEventListener('resize', () => { if (zfit) fitWidth(); });

function tick() {
  if (!fd || fd !== frame.contentDocument || !A || !layer || !layer.isConnected) return;
  if (Date.now() < adaptUntil) { const B = makeAdapter(); if (B.kind !== A.kind || B.slides().length !== A.slides().length) { A = B; syncEdits(); onSlide(); return; } }
  if (act() !== curEl) { onSlide(); return; }
  if (placeLayer() && !drag) renderMarks();
}
function attachFrame() {
  try { fd = frame.contentDocument; fw = frame.contentWindow; } catch (_) { fd = null; }
  if (!fd || !fd.body) { setStatus(L('打不开这个文件'), 'err'); return; }
  origHtml.clear(); editing = null; drag = null; G = null; curEl = null;
  const st = fd.createElement('style'); st.textContent = IN_CSS; (fd.head || fd.documentElement).appendChild(st);
  layer = fd.createElement('rv-layer'); svg = fd.createElementNS(NS, 'svg'); marks = fd.createElement('rv-marks'); hov = fd.createElement('rv-hov');
  lz = fd.createElement('rv-laser'); lsvg = fd.createElementNS(NS, 'svg'); ldot = fd.createElement('i'); lz.append(lsvg, ldot); lpts = [];
  layer.append(svg, marks, hov, lz);
  fd.documentElement.classList.toggle('rv-present', document.body.classList.contains('present'));
  fd.documentElement.addEventListener('mouseleave', () => { if (ldot) ldot.style.display = 'none'; });
  pop = fd.createElement('rv-pop'); pop.innerHTML = '<button data-sel="comment">' + L('评论') + '</button><button data-sel="rewrite">' + L('改写') + '</button><button data-sel="short">' + L('缩短') + '</button><button data-sel="delete">' + L('删掉') + '</button>';
  fd.body.append(layer, pop);
  A = makeAdapter(); adaptUntil = Date.now() + 3000;
  fd.addEventListener('pointerdown', onDown, true); fd.addEventListener('pointermove', onMove, true);
  fd.addEventListener('pointerup', onUp, true); fd.addEventListener('pointercancel', onUp, true);
  fd.addEventListener('click', onClick, true);
  ['mousedown', 'mouseup', 'dblclick', 'touchend'].forEach(t => fd.addEventListener(t, shield, true));
  fd.addEventListener('touchstart', e => {   /* a stylus draws, a finger scrolls */
    shield(e);
    if ((tool === 'browse' || DRAW.includes(tool)) && [...e.changedTouches].some(t => t.touchType === 'stylus') && !pop.contains(e.target) && e.cancelable) e.preventDefault();
  }, { capture: true, passive: false });
  fd.addEventListener('keydown', onKey, true); fd.addEventListener('keyup', onKey, true); fd.addEventListener('keypress', onKey, true);
  fd.addEventListener('mouseup', e => { if (!pop.contains(e.target)) setTimeout(checkSel, 0); });
  fd.addEventListener('selectionchange', () => { clearTimeout(selT); selT = setTimeout(checkSel, 250); });
  fd.addEventListener('paste', onPaste);
  fd.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); fd.documentElement.classList.add('rv-dropping'); } });
  fd.addEventListener('dragleave', e => { if (!e.relatedTarget) fd.documentElement.classList.remove('rv-dropping'); });
  fd.addEventListener('drop', e => { fd.documentElement.classList.remove('rv-dropping'); if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); addImage([...e.dataTransfer.files], e.clientX, e.clientY); });
  fd.addEventListener('slidechange', () => setTimeout(tick, 0));
  fw.addEventListener('resize', tick); fw.addEventListener('scroll', tick, true);
  pop.addEventListener('mousedown', e => e.preventDefault());
  pop.addEventListener('click', e => {
    const b = e.target.closest('[data-sel]'), s = fw.getSelection(); if (!b || !s || s.isCollapsed) return;
    addText(s.getRangeAt(0), s.toString(), b.dataset.sel); s.removeAllRanges(); pop.style.display = 'none';
  });
  syncEdits(); setTool(tool); onSlide();
  const zg = $('#rv-zoom'); if (zg) zg.style.display = (!HTML || A.page) ? '' : 'none';
  if (HTML && A.page) fitWidth(); else if (HTML) { zfit = false; setZoom(1); }
}
setInterval(tick, 200);
frame.addEventListener('load', attachFrame);
await loadNotes();
frame.src = INFO.frame + (INFO.frame === '/viewer' ? '?lang=' + LANG : '') + (location.hash || '');
window.__review = { state: () => S, info: () => INFO, adapter: () => A, undo, redo, probe: { sentenceAt, textBlockAt, blockOf, caretAt, geom: () => G } };

/* ---------- language ---------- */
async function switchLang() {   /* the page is rebuilt in the other language; notes are saved first */
  const to = LANG === 'en' ? 'zh' : 'en';
  try { document.cookie = 'rvlang=' + to + '; path=/; max-age=31536000; SameSite=Lax'; localStorage.setItem('rv-lang', to); } catch (_) {}
  if (dirty) await flush();
  location.reload();
}
function english() {
  return {
    '标注|brand': 'Redpen', '标注': 'Notes', '连不上本地服务': 'Cannot reach the local server',
    /* categories, note types, page operations, layouts */
    '评论': 'Comment', '改文字': 'Change text', '加图 / 换图': 'Add / replace image', '版式': 'Layout', '删掉': 'Delete', '其他': 'Other',
    '点评': 'Pin', '框选': 'Box', '选中元素': 'Element', '选中文字': 'Selected text', '直接改字': 'Edited text', '加图': 'Image', '手绘': 'Drawing', '箭头': 'Arrow',
    '整页意见': 'Page comment', '新增一页': 'New page', '删除此页': 'Delete this page', '移动此页': 'Move this page', '修改讲稿': 'Speaker notes', '整页操作': 'Page operation', '手写批注': 'Handwriting',
    '这页不要动': 'Do not touch this page', '拆成两页': 'Split into two pages', '和下一页合并': 'Merge with the next page', '移到备用页': 'Move to backup', '短版本里跳过': 'Skip in the short version', '复制这一页再改': 'Duplicate this page and change the copy',
    '由 AI 决定': 'Let the AI decide', '标题 + 一张大图': 'Title + one large figure', '左图右文': 'Figure left, text right', '标题 + 要点': 'Title + bullets', '表格': 'Table', '左右对比': 'Side-by-side comparison', '整页一张图': 'One full-page image', '照本页的版式': 'Same layout as this page',
    '放在这个位置': 'Place it here', '替换下面这张图': 'Replace the image underneath', '只是参考，不放进去': 'Only a reference, do not insert it',
    '放这里': 'place here', '替换': 'replace', '参考': 'reference',
    /* tools */
    '浏览': 'Browse', '选句': 'Sentence', '选元素': 'Element', '改字': 'Edit', '画笔': 'Pen', '激光笔': 'Laser',
    '选中文字可以评论；截图直接 ⌘V 粘贴，图片可以拖进来；用手写笔可以直接画': 'Select text to comment on it. Paste a screenshot with ⌘V or drop an image file on the page. A stylus draws directly',
    '点任意位置，留下一条意见': 'Click anywhere to leave a comment at that point',
    '拖一个矩形，圈出要讨论的区域': 'Drag a rectangle around the region you mean',
    '点一句话就选中整句，可以连续点；Esc 退出': 'Click a sentence to select all of it; keep clicking for more. Esc to stop',
    '点一张图、一个表格或一段文字，选中整个元素；Esc 退出': 'Click a figure, a table or a paragraph to select the whole element. Esc to stop',
    '点一段文字直接修改，回车完成，Esc 放弃；改动会记录成一条标注': 'Click a piece of text and retype it. Enter to finish, Esc to discard. The change is recorded as a note',
    '随手画，连续几笔算一条；Esc 退出': 'Draw freehand; strokes made close together count as one note. Esc to stop',
    '从一处拖到另一处，表示“移到这里”或“这两处有关”': 'Drag from one place to another: “move this there” or “these belong together”',
    '红点跟着鼠标走；按住拖动可以画圈，几秒后自动消失。不会记成标注，翻页照常用方向键；Esc 退出': 'A red dot follows the pointer. Hold and drag to draw a circle that fades after a moment. Nothing is recorded, and the arrow keys still turn pages. Esc to stop',
    '这种文件里没有可以选的文字，请用点评、框选或画笔': 'This kind of file has no selectable text. Use Pin, Box or Pen',
    '图片里没有元素可选，请用框选': 'An image has no elements to select. Use Box',
    '只有 HTML 能直接改字。PDF 和图片请选中文字后写“改成…”': 'Only HTML can be retyped in place. In a PDF or an image, select the text and fill in “Change to”',
    /* one-click comments */
    '删掉这句': 'Delete this sentence', '太长，缩短': 'Too long, shorten', '换个说法': 'Rephrase', '看不懂，说清楚': 'Unclear, explain', '加粗强调': 'Make it bold',
    '放大': 'Bigger', '缩小': 'Smaller', '换一张图': 'Use a different image', '裁掉留白': 'Crop the white space', '加图注': 'Add a caption',
    '字太小': 'Text too small', '太挤': 'Too crowded', '对齐': 'Align',
    '内容太多': 'Too much content', '太空': 'Too empty', '换个版式': 'Change the layout', '加一张图': 'Add an image', '这页很好': 'This page is good',
    '移到箭头指的位置': 'Move to where the arrow points', '两处对调': 'Swap these two', '这两处要对应起来': 'These two should match',
    '放大一点': 'A bit bigger', '缩小一点': 'A bit smaller', '只要图的一部分': 'Use only part of the image', '配一句图注': 'Add a one-line caption',
    '从论文里找图': 'Take a figure from the paper', '用表格': 'Use a table', '只放一句话和一张图': 'Just one sentence and one image',
    /* punctuation and page labels */
    '：': ': ', '；': '; ', '｜': ' | ', '（': ' (', '）': ')',
    '第 {n} 页': 'Page {n}', '备用页 {n}': 'Backup {n}', '整页': 'Whole page', '{label} · 共 {n} 页': '{label} · {n} page{s}',
    '前面加一页': 'Add page before', '后面加一页': 'Add page after', '{page}之前': 'before {page}', '{page}之后': 'after {page}',
    /* toolbar */
    '选一张图片放到这一页': 'Choose an image file to put on this page',
    '把剪贴板里的截图放到这一页，也可以直接按 ⌘V': 'Put the screenshot from the clipboard on this page. You can also just press ⌘V',
    '贴截图': 'Paste', '撤销 ⌘Z': 'Undo ⌘Z', '重做 ⇧⌘Z': 'Redo ⇧⌘Z',
    '缩小|zoom': 'Zoom out', '放大|zoom': 'Zoom in', '整页宽度适应窗口': 'Fit the page width to the window', '适应': 'Fit',
    '全屏演示：隐藏工具栏、侧栏和标注，只留幻灯片和激光笔': 'Present full screen: hides the toolbar, the sidebar and the notes, leaving the slides and the laser pointer',
    '演示': 'Present', '收起或展开右侧栏': 'Hide or show the sidebar', '侧栏': 'Sidebar', '帮助': 'Help',
    '复制给 AI 的指令': 'Copy for AI', '复制标注文字': 'Copy notes', '归档并清空': 'Archive',
    '复制一条指令，粘贴给 AI 就会按标注改': 'Copy an instruction. Paste it to your AI agent and it applies the notes',
    '把标注复制成纯文字': 'Copy the notes as plain text',
    '不经过 AI，直接结束这一轮；标注保存在 archive/ 里': 'Close this round without an agent. The notes are kept in archive/',
    /* help */
    '怎么标注': 'How to mark up',
    '评论一句话': 'Comment on a sentence',
    '按 <kbd>T</kbd> 后点那句话；或者直接选中文字，在弹出的小条里点“评论 / 改写 / 缩短 / 删掉”': 'Press <kbd>T</kbd> and click the sentence. Or select any text and choose Comment, Rewrite, Shorten or Delete from the small bar',
    '直接改字': 'Retype text',
    '按 <kbd>W</kbd> 后点一段文字，就地修改，回车完成（只对 HTML）': 'Press <kbd>W</kbd>, click the text, edit it in place and press Enter (HTML only)',
    '评论图或一块内容': 'Comment on a figure or a block',
    '<kbd>E</kbd> 点它选中整个元素；<kbd>C</kbd> 在任意位置放一个点；<kbd>R</kbd> 拖一个框': '<kbd>E</kbd> and a click select a whole element; <kbd>C</kbd> drops a pin anywhere; <kbd>R</kbd> drags a box',
    '加外部截图': 'Add a screenshot',
    '截图后按 <kbd>⌘V</kbd>，图会出现在这一页上，拖动调整位置和大小。也可以把图片文件拖进来，或点“加图”。拖到已有的图上表示替换它': 'Take a screenshot and press <kbd>⌘V</kbd>. It lands on this page; drag it to move or resize. You can also drop an image file on the page, or click Image. Dropping it on an existing image means “replace this one”',
    '给某条意见配图': 'Attach a picture to a note',
    '先点进那条意见的输入框再粘贴，或把图片拖到那张卡片上': 'Click into the text box of that note and paste, or drop the image on its card',
    '画和箭头': 'Draw, arrows',
    '<kbd>P</kbd> 随手画，<kbd>A</kbd> 从一处拖到另一处。用 Apple Pencil 时不用选工具，直接画': '<kbd>P</kbd> draws freehand, <kbd>A</kbd> drags an arrow from one place to another. With an Apple Pencil you do not pick a tool: just draw',
    '全屏演示': 'Present',
    '点“演示”或按 <kbd>F</kbd>：全屏，只留幻灯片和激光笔，工具栏、侧栏和标注都隐藏。<kbd>←</kbd> <kbd>→</kbd> 或空格翻页，<kbd>V</kbd> 换回普通鼠标，<kbd>Esc</kbd> 或 <kbd>F</kbd> 退出': 'Click Present or press <kbd>F</kbd>: full screen with only the slides and the laser pointer; the toolbar, the sidebar and the notes are hidden. <kbd>←</kbd> <kbd>→</kbd> or Space turn pages, <kbd>V</kbd> gives the normal pointer back, <kbd>Esc</kbd> or <kbd>F</kbd> leaves',
    '按 <kbd>L</kbd>，红点跟着鼠标走；按住拖动可以画圈，几秒后自动消失。只用来指给别人看，不会记成标注。讲的时候可以点“侧栏”把右边收起来': 'Press <kbd>L</kbd>: a red dot follows the pointer. Hold and drag to draw a circle that fades after a moment. It only shows people where to look and records nothing. While talking, click Sidebar to hide the right-hand side',
    '加页、删页、挪页': 'Add, delete, move pages',
    '右侧“前面加一页 / 后面加一页 / 移动 / 删除”，“更多”里有拆页、合并、移到备用页、这页不要动': 'In the sidebar: Add page before, Add page after, Move, Delete. More… has split, merge, move to backup and “do not touch this page”',
    '持续查看讲稿': 'Keep speaker notes open',
    '勾选右侧“讲稿始终展开”，翻页和刷新后都会保持展开。取消勾选可恢复按页手动展开。': 'Tick “Keep speaker notes open” in the sidebar and they stay open across pages and reloads. Untick it to open them by hand on each page.',
    '★ 标为重要；“所有页”表示每一页都照这条改；<kbd>⌘Z</kbd> 撤销；<kbd>Esc</kbd> 回到浏览；<kbd>←</kbd> <kbd>→</kbd> 翻页': '★ marks a note as important; “All pages” means: do this on every page; <kbd>⌘Z</kbd> undoes; <kbd>Esc</kbd> returns to browsing; <kbd>←</kbd> <kbd>→</kbd> turn pages',
    '交给 AI': 'Hand over to the AI',
    '点右下角“复制给 AI 的指令”，粘贴给 Claude 或 Codex。它改完后，这里的“上一轮”会显示每条的处理结果': 'Click “Copy for AI” at the bottom right and paste it to Claude, Codex or another agent. When it is done, the tab “Previous round” shows what happened to each note',
    '换语言': 'Language',
    '点工具栏最右边的 EN 换成英文界面，再点“中文”换回来。复制给 AI 的指令和标注清单会跟着换': 'Click 中文 at the right end of the toolbar for the Chinese interface, and EN there to come back. The instruction for the AI and the list of notes follow the language',
    '在 iPad 上用': 'On an iPad',
    '在 iPad 的 Safari 里打开：': 'Open this in Safari on the iPad: ',
    '启动时加 <code>--lan</code>，终端会给出 iPad 用的链接（同一个 Wi-Fi 或 Tailscale）': 'Start with <code>--lan</code> and the terminal prints a link for the iPad (same Wi-Fi or Tailscale)',
    '。<br>离线：在 iPad 上用任何 App 手写批注 PDF，把批注件传回来，让 AI 运行 <code>review.py import 原件 批注件</code>': '.<br>Offline: annotate the PDF by hand in any iPad app, send the annotated copy back and have the agent run <code>review.py import ORIGINAL ANNOTATED</code>',
    '标注保存在 <code>{dir}</code>。点空白处关闭。': 'Notes are saved in <code>{dir}</code>. Click outside this box to close it.',
    /* status line */
    '自动保存在 {dir}/。标完后点“复制给 AI 的指令”，粘贴给 Claude 或 Codex。': 'Saved automatically in {dir}/. When you are done, click “Copy for AI” and paste it to your agent.',
    '读取标注失败：本地服务没有响应': 'Could not load the notes: the local server is not responding',
    '找回了上次没存上的 {n} 条标注': 'Recovered {n} note{s} that could not be saved last time',
    '保存中…': 'Saving…',
    '已保存 {n} 条。标完后点“复制给 AI 的指令”，粘贴给 Claude 或 Codex。': 'Saved {n} note{s}. When you are done, click “Copy for AI” and paste it to your agent.',
    '没存上：本地服务没有响应。标注还在这个页面里，浏览器里也留了备份；服务恢复后会自动补存，先不要关这个页面。': 'Not saved: the local server is not responding. Your notes are still on this page and backed up in the browser. They are saved as soon as the server is back, so keep this page open.',
    '没有可以撤销的操作': 'Nothing to undo',
    '已删除这条，⌘Z 可以撤销': 'Note deleted. ⌘Z brings it back',
    '演示模式 · ← → 或空格翻页 · L 激光笔 · V 普通鼠标 · Esc 或 F 退出': 'Presenting · ← → or Space turn pages · L laser · V normal pointer · Esc or F to leave',
    '已记下这处改字。可以在右侧补一句原因': 'Edit recorded. You can add the reason on the right',
    '这里没有文字。评论图片或空白处请用“选元素”或“点评”': 'There is no text here. To comment on an image or an empty spot, use Element or Pin',
    '这里选不到单独的元素，请用“框选”': 'No single element can be selected here. Use Box',
    '这里没有可以改的文字': 'There is no text to edit here',
    '已经是最外面一层了': 'This is already the outermost element',
    '图片上传失败（支持 png、jpg、gif、webp、pdf）': 'Upload failed (png, jpg, gif, webp and pdf are supported)',
    '已标记：用这张图替换原图。右侧可以改成“放在这个位置”': 'Marked: replace the original image with this one. You can change that to “Place it here” on the right',
    '图已放到这一页，拖动调整位置，拖右下角调整大小': 'The image is on this page. Drag it to move it; drag its bottom-right corner to resize',
    '剪贴板里没有图片。先截图到剪贴板（⌃⇧⌘4），再按 ⌘V': 'No image on the clipboard. Copy a screenshot first (on a Mac: ⌃⇧⌘4), then press ⌘V',
    '浏览器不让直接读剪贴板，请直接按 ⌘V 粘贴': 'The browser does not allow reading the clipboard here. Press ⌘V to paste instead',
    '本地服务没有响应': 'The local server is not responding',
    '把当前 {n} 条标注归档并清空？（归档后还能在 archive/ 里找到）': 'Archive the current {n} note{s} and start clean? (They stay available in archive/.)',
    '已归档并清空': 'Archived. Ready for a new round',
    '指令已复制。粘贴给 Claude 或 Codex 就会按标注改': 'Instruction copied. Paste it to Claude, Codex or another agent and it applies your notes',
    '标注文字已复制': 'Notes copied as text',
    '打不开这个文件': 'Cannot open this file',
    /* marks on the page */
    '图片': 'Image', '手写': 'handwriting', '已改字': 'edited', '改写': 'Rewrite', '缩短': 'Shorten',
    /* cards */
    '标为重要': 'Mark as important', '删除这条': 'Delete this note', '删除': 'Delete',
    '改成（可留空，只写意见）': 'Change to (optional; a comment alone is fine)', '原文': 'Original', '改成': 'Change to',
    '从 {a} → 到 {b}': 'From {a} → to {b}', '空白处': 'empty space',
    '加在这页前面': 'Add before this page', '加在这页后面': 'Add after this page',
    '新页标题': 'Title of the new page', '这一页的结论句': 'The takeaway of this page, in one sentence',
    '移到': 'Move', '选一页…': 'choose a page…', '之前': 'before', '之后': 'after',
    '这一页讲什么、放什么内容和图（图片可以直接粘贴在这里）': 'What this page says, and which content and figures go on it (you can paste images right here)',
    '原因（可不填）': 'Reason (optional)', '说明（可不填）': 'Explanation (optional)', '对整页的意见': 'Your comment on the whole page',
    '为什么这么改（可不填）': 'Why this change (optional)', '这张图怎么用：放多大、配什么文字（可不填）': 'How to use this image: how large, with what text (optional)',
    '意见（可不填）': 'Comment (optional)', '手写内容在图里。想补充或打字说明可以写在这里': 'The handwriting is in the image. Add to it or type an explanation here if you like',
    '画的是什么意思（可不填，AI 会看笔迹的位置）': 'What the drawing means (optional; the AI sees where the strokes are)', '写下意见…': 'Write your comment…',
    '＋ 图片': '＋ Image', '每一页都照这条处理': 'Apply this note to every page', '所有页': 'All pages', '改为选中外面一层': 'Select the enclosing element instead', '选大一层': 'Select parent',
    /* sidebar */
    '本页': 'This page', '全部': 'All', '总体意见|tab': 'General', '总体意见': 'General comments', '上一轮': 'Previous round',
    '文件已经更新。<a data-reload>点这里刷新</a>看新版本。': 'The file has changed. <a data-reload>Reload it</a> to see the new version.',
    '这些标注是针对旧版文件写的，位置可能已经对不上。处理完后请点“归档并清空”。': 'These notes were made on an older version of the file, so their positions may no longer match. Once they are dealt with, click “Archive”.',
    '改讲稿': 'Speaker notes', '移动': 'Move', '更多…': 'More…',
    '翻页和刷新后保持展开；取消后可手动展开本页讲稿': 'Stays open across pages and reloads. Untick to open the notes of each page by hand',
    '讲稿始终展开': 'Keep speaker notes open', '本页讲稿 · {n} 词': 'Speaker notes · {n} word{s}', ' · 计划 {t} 秒': ' · planned {t} s',
    '这里还没有标注。': 'No notes here yet.',
    '· <b>选句 T</b>：点一句话就能评论；也可以直接选中文字': '· <b>Sentence T</b>: click a sentence to comment on it, or just select some text',
    '· <b>改字 W</b>：点一段文字直接改': '· <b>Edit W</b>: click a piece of text and retype it',
    '：评论一个位置或一块区域': ': comment on a point or a region',
    '· <b>截图</b>：截图后按 ⌘V，或把图片拖进来': '· <b>Screenshot</b>: take one and press ⌘V, or drop an image file here',
    '· <b>画笔 P</b> / <b>箭头 A</b>：随手画、指位置': '· <b>Pen P</b> / <b>Arrow A</b>: draw freehand, point from one place to another',
    '· 上面的按钮：在前面或后面加页、移动、删除': '· The buttons above: add a page before or after, move, delete',
    '对整个文件的意见': 'Comments on the file as a whole', '新增：': 'New: ', '（未命名）': '(untitled)', '删': 'del', '移': 'move',
    '上一轮的 {n} 条标注和处理结果。': 'The previous round: {n} note{s} and what was done about each.', '修改说明': 'Summary',
    '已改': 'Done', '部分已改': 'Partly done', '没有改': 'Not done', '没有记录处理结果': 'No result was recorded'
  };
}
})();
