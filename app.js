// ===== 状態管理 =====
const state = {
  slides: [],          // スライドデータの配列
  currentSlide: 0,     // 現在のスライドインデックス
  selectedElement: null,
  selectedElements: new Set(), // 複数選択中の要素IDセット
  activeTool: 'select',
  slideWidth: 960,
  slideHeight: 540,
  scale: 1,
  isDragging: false,
  isResizing: false,
  dragOffset: { x: 0, y: 0 },
  resizeDir: '',
  resizeStart: {},
  lockAspect: false,
  manualScale: null,
  clipboard: null,        // コピー/切り取りしたスライドデータ
  elementClipboard: null, // コピー/切り取りした要素データ（配列）
  editingGroupId: null,   // グループ内要素を個別選択中のグループID
  showGrid: false,
  showGuide: false,
  selectedTableCell: null,   // { row, col } — 選択中のセル位置
  selectedTableCells: [],    // [{ row, col }, ...] — 複数選択（結合用）
};

function clearSelection() {
  state.selectedElement = null;
  state.selectedElements = new Set();
  state.editingGroupId = null;
  state.selectedTableCell = null;
  state.selectedTableCells = [];
}

// ===== ファイル管理 =====
let currentFileHandle = null; // File System Access API ハンドル（上書き保存に使用）
let lastDirHandle = null;     // 最後に使ったフォルダ（ピッカーの初期フォルダ）
let isDirty = false;

// IndexedDB にファイルハンドルを保存・復元してフォルダを跨いで記憶する
function _idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('slidemate_prefs', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}
async function _saveLastHandle(handle) {
  try {
    const db = await _idbOpen();
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, 'lastFile');
    await new Promise(r => { tx.oncomplete = r; });
    db.close();
  } catch (_) {}
}
async function _loadLastHandle() {
  try {
    const db = await _idbOpen();
    const tx = db.transaction('handles', 'readonly');
    const result = await new Promise(r => {
      const req = tx.objectStore('handles').get('lastFile');
      req.onsuccess = () => r(req.result || null);
      req.onerror = () => r(null);
    });
    db.close();
    return result;
  } catch (_) { return null; }
}
// 起動時に前回のフォルダを復元
(async () => { lastDirHandle = await _loadLastHandle(); })();

function _startIn() { return lastDirHandle || 'documents'; }
async function _rememberHandle(handle) {
  lastDirHandle = handle;
  await _saveLastHandle(handle);
}

function markDirty() { isDirty = true; }
function markClean() { isDirty = false; }

// ===== アプリ設定 =====
const appSettings = (() => {
  const KEY = 'orca_app_settings';
  const defaults = { recordingFps: 30, pointerColor: '#ff2020', pointerShape: 'circle', pointerImageUrl: '' };
  let cfg;
  try { cfg = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { cfg = { ...defaults }; }
  return {
    get: k => cfg[k],
    set: (k, v) => { cfg[k] = v; try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch {} },
  };
})();

let editingElementId = null;
let drawingState = null;
let _editingTableCell = null;
let _tblDblClick = { tableId: null, row: -1, col: -1, time: 0 };

// ===== 履歴管理（Undo/Redo）=====
const MAX_HISTORY = 60;
const historyStack = [];
const redoStack = [];

function _historySnapshot() {
  return JSON.parse(JSON.stringify({ slides: state.slides, currentSlide: state.currentSlide }));
}

function pushHistory() {
  historyStack.push(_historySnapshot());
  if (historyStack.length > MAX_HISTORY) historyStack.shift();
  redoStack.length = 0;
  markDirty();
}

function undo() {
  if (historyStack.length === 0) return;
  redoStack.push(_historySnapshot());
  if (redoStack.length > MAX_HISTORY) redoStack.shift();
  const prev = historyStack.pop();
  state.slides = prev.slides;
  state.currentSlide = Math.min(prev.currentSlide, state.slides.length - 1);
  clearSelection();
  renderAll();
}

function redo() {
  if (redoStack.length === 0) return;
  historyStack.push(_historySnapshot());
  const next = redoStack.pop();
  state.slides = next.slides;
  state.currentSlide = Math.min(next.currentSlide, state.slides.length - 1);
  clearSelection();
  renderAll();
}

// ===== DOM参照 =====
const canvas = document.getElementById('slide-canvas');
const canvasWrapper = document.getElementById('canvas-wrapper');
const thumbnailContainer = document.getElementById('thumbnail-container');
const slideCounter = document.getElementById('slide-counter');

// ===== ユーティリティ =====
function generateId() {
  return 'el_' + Math.random().toString(36).slice(2, 9);
}

function getCurrentSlideData() {
  return state.slides[state.currentSlide];
}

function flattenSlideElements(elements) {
  const flat = [];
  elements.forEach(el => {
    if (el.type === 'group') {
      const gx = el.x, gy = el.y, gOp = el.opacity / 100;
      (el.elements || []).forEach(child => {
        const abs = JSON.parse(JSON.stringify(child));
        abs.x += gx; abs.y += gy;
        abs.opacity = Math.round(abs.opacity * gOp);
        flat.push(abs);
      });
    } else {
      flat.push(el);
    }
  });
  return flat;
}

function groupSelectedElements() {
  if (state.selectedElements.size < 2) return;
  const slide = getCurrentSlideData();
  const ids = Array.from(state.selectedElements);
  const items = ids.map(id => slide.elements.find(e => e.id === id)).filter(Boolean);
  if (items.length < 2) return;
  pushHistory();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  items.forEach(d => {
    if (d.x < minX) minX = d.x;
    if (d.y < minY) minY = d.y;
    if (d.x + d.w > maxX) maxX = d.x + d.w;
    if (d.y + d.h > maxY) maxY = d.y + d.h;
  });
  const children = items.map(d => {
    const c = JSON.parse(JSON.stringify(d));
    c.x -= minX; c.y -= minY;
    return c;
  });
  const groupData = {
    type: 'group', id: generateId(),
    x: minX, y: minY, w: maxX - minX, h: maxY - minY,
    rotate: 0, flipH: false, flipV: false, opacity: 100,
    zIndex: Math.max(...items.map(d => d.zIndex || 1)),
    elements: children,
  };
  slide.elements = slide.elements.filter(e => !state.selectedElements.has(e.id));
  slide.elements.push(groupData);
  state.selectedElements = new Set([groupData.id]);
  state.selectedElement = groupData.id;
  renderAll();
}

function ungroupElement() {
  if (!state.selectedElement) return;
  const slide = getCurrentSlideData();
  const grp = slide.elements.find(e => e.id === state.selectedElement);
  if (!grp || grp.type !== 'group') return;
  pushHistory();
  const ungrouped = (grp.elements || []).map(child => {
    const abs = JSON.parse(JSON.stringify(child));
    abs.id = generateId();
    abs.x += grp.x; abs.y += grp.y;
    abs.zIndex = grp.zIndex;
    return abs;
  });
  slide.elements = slide.elements.filter(e => e.id !== grp.id);
  slide.elements.push(...ungrouped);
  state.selectedElements = new Set(ungrouped.map(e => e.id));
  state.selectedElement = ungrouped.length ? ungrouped[ungrouped.length - 1].id : null;
  renderAll();
}

// ===== スライド管理 =====
function createSlideData(bgColor = '#ffffff') {
  return { bgColor, elements: [], autoHeight: false, notes: '', animations: [] };
}

function addSlide() {
  pushHistory();
  state.slides.push(createSlideData());
  state.currentSlide = state.slides.length - 1;
  clearSelection();
  renderAll();
}

function deleteSlide() {
  if (state.slides.length <= 1) return;
  pushHistory();
  state.slides.splice(state.currentSlide, 1);
  state.currentSlide = Math.min(state.currentSlide, state.slides.length - 1);
  clearSelection();
  renderAll();
}

function switchSlide(index) {
  clearSelection();
  state.currentSlide = index;
  renderAll();
}

function computeSlideHeight(slide) {
  if (!slide || !slide.autoHeight) return state.slideHeight;
  let maxBottom = 400;
  (slide.elements || []).forEach(d => {
    const b = (d.y || 0) + (d.h || 0);
    if (b > maxBottom) maxBottom = b;
  });
  return maxBottom + 120;
}

// ===== スケール計算 =====
function updateScale() {
  const slide = getCurrentSlideData();
  const effectiveH = computeSlideHeight(slide);
  let autoS;
  if (state.manualScale !== null) {
    autoS = state.manualScale;
  } else {
    const area = document.getElementById('canvas-area');
    const areaW = area.clientWidth - 48;
    const areaH = area.clientHeight - 48;
    autoS = Math.min(areaW / state.slideWidth, areaH / effectiveH, 1);
  }
  state.scale = autoS;

  canvas.style.width = state.slideWidth + 'px';
  canvas.style.height = effectiveH + 'px';
  canvas.style.transform = `scale(${state.scale})`;
  canvasWrapper.style.width = (state.slideWidth * state.scale) + 'px';
  canvasWrapper.style.height = (effectiveH * state.scale) + 'px';
}

// ===== スライドを描画 =====
function renderCanvas() {
  const slide = getCurrentSlideData();
  canvas.style.background = slide.bgColor;
  const _bgPrev = document.getElementById('bg-color-preview');
  if (_bgPrev) _bgPrev.style.background = slide.bgColor;

  // 既存の要素をクリア
  canvas.querySelectorAll('.slide-element').forEach(el => el.remove());

  slide.elements.forEach(data => {
    const el = buildElement(data);
    canvas.appendChild(el);
  });

  // メモパネルをスライドに同期
  const notesTA = document.getElementById('notes-textarea');
  if (notesTA) notesTA.value = slide.notes || '';

  updateCounter();
  renderAnimBadges();
}

// ===== サムネイル描画 =====
function renderThumbnails() {
  thumbnailContainer.innerHTML = '';
  state.slides.forEach((slide, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'thumbnail'
      + (i === state.currentSlide ? ' active' : '')
      + (slide.hidden ? ' hidden-slide' : '');
    thumb.style.background = slide.bgColor;
    thumb.style.aspectRatio = `${state.slideWidth} / ${computeSlideHeight(slide)}`;

    const inner = document.createElement('div');
    inner.style.cssText = `position:relative;width:100%;height:100%;overflow:hidden;`;
    const thumbScale = 144 / state.slideWidth;
    flattenSlideElements(slide.elements).forEach(data => {
      const mini = document.createElement('div');
      mini.style.cssText = `
        position:absolute;
        left:${data.x * thumbScale}px;
        top:${data.y * thumbScale}px;
        width:${data.w * thumbScale}px;
        height:${data.h * thumbScale}px;
        opacity:${data.opacity / 100};
        box-sizing:border-box;
        overflow:hidden;
      `;
      if (data.type === 'text') {
        mini.style.background = data.fillNone ? 'transparent' : data.fill;
        mini.style.border = data.strokeNone ? 'none' : `${data.strokeWidth * thumbScale}px solid ${data.stroke}`;
        mini.style.color = data.color;
        mini.style.fontSize = data.fontSize * thumbScale + 'px';
        mini.style.display = 'flex';
        mini.style.alignItems = 'center';
        mini.style.justifyContent = 'center';
        mini.style.padding = '1px 2px';
        mini.textContent = formatListText(data.text, data.listStyle);
      } else if (data.type === 'image') {
        const img = document.createElement('img');
        img.src = data.src || '';
        img.style.cssText = 'width:100%;height:100%;object-fit:fill;display:block;';
        mini.appendChild(img);
      } else if (data.type === 'chart') {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 400 280');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.style.cssText = 'width:100%;height:100%;display:block;';
        if (data.chartData) svg.innerHTML = buildChartSVGContent(data.chartData);
        mini.appendChild(svg);
      } else if (data.type === 'table') {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.style.cssText = 'width:100%;height:100%;display:block;';
        svg.innerHTML = buildTableThumbnailSVG(data);
        mini.appendChild(svg);
      } else {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.style.cssText = 'width:100%;height:100%;overflow:visible;';
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.innerHTML = shapeInnerSVGStyled(data);
        mini.appendChild(svg);
      }
      inner.appendChild(mini);
    });
    thumb.appendChild(inner);

    const label = document.createElement('div');
    label.className = 'thumbnail-label';
    label.textContent = i + 1;
    thumb.appendChild(label);

    if (slide.hidden) {
      const badge = document.createElement('div');
      badge.className = 'thumbnail-hidden-badge';
      badge.textContent = '非表示';
      thumb.appendChild(badge);
    }

    thumb.addEventListener('click', () => switchSlide(i));
    thumb.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, i);
    });
    thumbnailContainer.appendChild(thumb);
  });
}

function renderAll() {
  finishTableCellEdit();
  updateScale();
  renderCanvas();
  renderThumbnails();
  updatePropertiesPanel();
}

function updateCounter() {
  slideCounter.textContent = `スライド ${state.currentSlide + 1} / ${state.slides.length}`;
}

// ===== 図形SVGユーティリティ =====
function regularPolygonPoints(n, cx, cy, r, startAngle) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = startAngle + (2 * Math.PI * i) / n;
    pts.push((cx + r * Math.cos(a)).toFixed(2) + ',' + (cy + r * Math.sin(a)).toFixed(2));
  }
  return pts.join(' ');
}

function starPoints(n, cx, cy, outerR, innerR) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (Math.PI * i) / n - Math.PI / 2;
    pts.push((cx + r * Math.cos(a)).toFixed(2) + ',' + (cy + r * Math.sin(a)).toFixed(2));
  }
  return pts.join(' ');
}

// vector-effect属性をすべてのSVG図形要素に適用するため各要素に直接付与
const VE = 'vector-effect="non-scaling-stroke"';

function shapeInnerSVG(type, adj = 0.5) {
  switch (type) {
    case 'rect':         return `<rect x="2" y="2" width="96" height="96" ${VE}/>`;
    case 'roundrect': { const rx = Math.round(2 + adj * 46); return `<rect x="2" y="2" width="96" height="96" rx="${rx}" ry="${rx}" ${VE}/>`; }
    case 'circle':       return `<ellipse cx="50" cy="50" rx="48" ry="48" ${VE}/>`;
    case 'triangle':     return `<polygon points="50,2 98,98 2,98" ${VE}/>`;
    case 'rtriangle':    return `<polygon points="2,2 98,98 2,98" ${VE}/>`;
    case 'diamond':      return `<polygon points="50,2 98,50 50,98 2,50" ${VE}/>`;
    case 'parallelogram': { const o = Math.round(4 + adj * 44); return `<polygon points="${o},2 98,2 ${100-o},98 2,98" ${VE}/>`; }
    case 'trapezoid': { const to = Math.round(4 + (1-adj) * 44); return `<polygon points="${to},2 ${100-to},2 98,98 2,98" ${VE}/>`; }
    case 'pentagon':     return `<polygon points="${regularPolygonPoints(5,50,50,48,-Math.PI/2)}" ${VE}/>`;
    case 'hexagon':      return `<polygon points="${regularPolygonPoints(6,50,50,48,0)}" ${VE}/>`;
    case 'octagon':      return `<polygon points="${regularPolygonPoints(8,50,50,48,Math.PI/8)}" ${VE}/>`;
    case 'cross':        return `<polygon points="35,2 65,2 65,35 98,35 98,65 65,65 65,98 35,98 35,65 2,65 2,35 35,35" ${VE}/>`;
    case 'arrow-r': { const b = Math.round(20 + adj*30), n = Math.round(50 + adj*25); return `<polygon points="2,${b} ${n},${b} ${n},${b-18} 98,50 ${n},${100-b+18} ${n},${100-b} 2,${100-b}" ${VE}/>`; }
    case 'arrow-l': { const b = Math.round(20 + adj*30), n = Math.round(50 - adj*25); return `<polygon points="98,${b} ${n},${b} ${n},${b-18} 2,50 ${n},${100-b+18} ${n},${100-b} 98,${100-b}" ${VE}/>`; }
    case 'arrow-u': { const b = Math.round(20 + adj*30), n = Math.round(50 + adj*25); return `<polygon points="${b},98 ${b},${n} ${b-18},${n} 50,2 ${100-b+18},${n} ${100-b},${n} ${100-b},98" ${VE}/>`; }
    case 'arrow-d': { const b = Math.round(20 + adj*30), n = Math.round(50 - adj*25); return `<polygon points="${b},2 ${b},${n} ${b-18},${n} 50,98 ${100-b+18},${n} ${100-b},${n} ${100-b},2" ${VE}/>`; }
    case 'arrow-h':      return `<polygon points="2,50 22,22 22,40 78,40 78,22 98,50 78,78 78,60 22,60 22,78" ${VE}/>`;
    case 'chevron': { const d = Math.round(2 + adj * 46); return `<polygon points="2,2 ${100-d},2 98,50 ${100-d},98 2,98 ${d},50" ${VE}/>`; }
    case 'star3':        return `<polygon points="${starPoints(3,50,50,48,20)}" ${VE}/>`;
    case 'star4':        return `<polygon points="${starPoints(4,50,50,48,20)}" ${VE}/>`;
    case 'star5':        return `<polygon points="${starPoints(5,50,50,48,18)}" ${VE}/>`;
    case 'star6':        return `<polygon points="${starPoints(6,50,50,48,24)}" ${VE}/>`;
    case 'star8':        return `<polygon points="${starPoints(8,50,50,48,20)}" ${VE}/>`;
    case 'star10':       return `<polygon points="${starPoints(10,50,50,48,20)}" ${VE}/>`;
    case 'star12':       return `<polygon points="${starPoints(12,50,50,48,22)}" ${VE}/>`;
    case 'callout': { const tc = Math.round(15 + adj*65), bl = tc-7, br = tc+7; return `<path d="M2,2 H98 V72 H${br} L${tc},98 L${bl},72 H2 Z" ${VE}/>`; }
    case 'callout-oval': { const tc = Math.round(20 + adj*55); return `<polygon points="${tc-10},70 ${tc},96 ${tc+10},70" ${VE}/><ellipse cx="50" cy="40" rx="47" ry="33" ${VE}/>`; }
    case 'callout-r': { const ty = Math.round(20 + adj*55); return `<path d="M2,2 H98 V${ty-7} L${Math.min(110,104)},${ty} L98,${ty+7} V98 H2 Z" ${VE}/>`; }
    case 'cylinder':     return `<path d="M4,18 L4,82 A46,12 0 0 0 96,82 L96,18 Z" ${VE}/><ellipse cx="50" cy="18" rx="46" ry="12" ${VE}/>`;
    case 'cloud':        return `<path d="M22,75 Q4,75 4,58 Q4,42 18,40 Q16,22 34,20 Q44,4 58,14 Q70,8 76,22 Q92,22 94,40 Q98,56 86,64 Q94,76 80,80 Q70,92 56,86 Q50,94 38,86 Q24,90 22,75 Z" ${VE}/>`;
    case 'heart':        return `<path d="M50,86 C50,86 6,60 6,30 C6,14 18,4 30,8 C38,10 45,18 50,28 C55,18 62,10 70,8 C82,4 94,14 94,30 C94,60 50,86 50,86 Z" ${VE}/>`;
    case 'moon':         return `<path d="M74,10 A38,38 0 1 0 74,90 A26,26 0 1 1 74,10 Z" ${VE}/>`;
    case 'lightning':    return `<polygon points="60,2 28,52 50,52 40,98 72,48 50,48" ${VE}/>`;
    case 'ribbon':       return `<path d="M2,22 L30,22 L50,2 L70,22 L98,22 L98,78 L70,78 L50,98 L30,78 L2,78 Z" ${VE}/>`;
    case 'line':         return `<line x1="0" y1="50" x2="100" y2="50" ${VE}/>`;
    case 'arrow-line':   return `<line x1="2" y1="50" x2="82" y2="50" ${VE}/><polygon points="82,36 98,50 82,64" ${VE}/>`;
    case 'freehand': case 'polyline': case 'curve':
      return `<line x1="0" y1="50" x2="100" y2="50" ${VE}/>`;
    default:             return `<rect x="2" y="2" width="96" height="96" ${VE}/>`;
  }
}

function getStrokeDashSVG(style) {
  switch (style) {
    case 'dashed':   return '10 6';
    case 'dotted':   return '2 5';
    case 'dash-dot': return '10 4 2 4';
    default:         return '';
  }
}

function getStrokeDashCanvas(style, sw) {
  const s = sw || 2;
  switch (style) {
    case 'dashed':   return [s * 4, s * 2.5];
    case 'dotted':   return [s * 0.5, s * 2];
    case 'dash-dot': return [s * 4, s * 2, s * 0.5, s * 2];
    default:         return [];
  }
}

function shapeInnerSVGStyled(data) {
  const fill   = data.fillNone   ? 'none' : (data.fill   || '#4a90d9');
  const stroke = data.strokeNone ? 'none' : (data.stroke || '#000000');
  const sw     = data.strokeNone ? 0 : (data.strokeWidth || 2);
  const dash   = getStrokeDashSVG(data.strokeStyle);
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
  const fo = (!data.fillNone && (data.fillOpacity ?? 100) < 100) ? ` fill-opacity="${(data.fillOpacity/100).toFixed(3)}"` : '';
  const so = (!data.strokeNone && (data.strokeOpacity ?? 100) < 100) ? ` stroke-opacity="${(data.strokeOpacity/100).toFixed(3)}"` : '';
  return `<g fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dashAttr}${fo}${so}>${shapeInnerSVG(data.type, data.adj ?? 0.5)}</g>`;
}

// ===== テキスト効果スタイル生成 =====
function buildTextEffectStyle(data) {
  const shadows = [];
  if (data.text3D) {
    const depth = data.text3DDepth !== undefined ? data.text3DDepth : 4;
    const col = data.text3DColor || '#888888';
    for (let i = depth; i >= 1; i--) shadows.push(`${i}px ${i}px 0 ${col}`);
  }
  if (data.textShadow) {
    const x = data.textShadowX !== undefined ? data.textShadowX : 2;
    const y = data.textShadowY !== undefined ? data.textShadowY : 2;
    const blur = data.textShadowBlur !== undefined ? data.textShadowBlur : 4;
    shadows.push(`${x}px ${y}px ${blur}px ${data.textShadowColor || '#000000'}`);
  }
  if (data.textStroke) {
    const w = data.textStrokeWidth !== undefined ? data.textStrokeWidth : 2;
    const col = data.textStrokeColor || '#000000';
    const steps = Math.max(32, w * 8);
    for (let i = 0; i < steps; i++) {
      const a = (2 * Math.PI * i) / steps;
      shadows.push(`${(Math.cos(a) * w).toFixed(2)}px ${(Math.sin(a) * w).toFixed(2)}px 0 ${col}`);
    }
  }
  if (data.textStroke2) {
    const w = data.textStroke2Width !== undefined ? data.textStroke2Width : 4;
    const col = data.textStroke2Color || '#ffffff';
    const steps = Math.max(32, w * 8);
    for (let i = 0; i < steps; i++) {
      const a = (2 * Math.PI * i) / steps;
      shadows.push(`${(Math.cos(a) * w).toFixed(2)}px ${(Math.sin(a) * w).toFixed(2)}px 0 ${col}`);
    }
  }
  return {
    textShadow: shadows.length ? shadows.join(', ') : 'none',
    opacity: (data.textOpacity !== undefined ? data.textOpacity : 100) / 100,
  };
}

// ===== フォントユーティリティ =====
function underlineCSS(ul) {
  switch (ul) {
    case 'single': return 'underline';
    case 'double': return 'underline double';
    case 'dotted': return 'underline dotted';
    case 'dashed': return 'underline dashed';
    default:       return 'none';
  }
}

function formatListText(text, listStyle) {
  if (!listStyle || !text) return text || '';
  const lines = text.split('\n');
  if (listStyle === 'bullet') return lines.map(l => '• ' + l).join('\n');
  if (listStyle === 'numbered') return lines.map((l, i) => (i + 1) + '. ' + l).join('\n');
  return text;
}

function makeTextInner(data, extra) {
  const align = data.textAlign || 'center';
  let jc, taCSS, talCSS;
  if (align === 'justify') {
    jc = 'flex-start'; taCSS = 'justify'; talCSS = 'left';
  } else if (align === 'distributeCenter') {
    jc = 'flex-start'; taCSS = 'justify'; talCSS = 'justify';
  } else if (align === 'left') {
    jc = 'flex-start'; taCSS = 'left'; talCSS = 'auto';
  } else if (align === 'right') {
    jc = 'flex-end'; taCSS = 'right'; talCSS = 'auto';
  } else {
    jc = 'center'; taCSS = 'center'; talCSS = 'auto';
  }
  const inner = document.createElement('div');
  inner.className = 'element-inner';
  inner.style.cssText = `
    ${extra || ''}
    width:100%;height:100%;
    display:flex;align-items:center;
    justify-content:${jc};
    text-align:${taCSS};
    text-align-last:${talCSS};
    font-size:${data.fontSize}px;
    font-family:${data.fontFamily};
    color:${data.color};
    font-weight:${data.fontWeight || 'normal'};
    font-style:${data.fontStyle || 'normal'};
    text-decoration:${underlineCSS(data.underline)};
    white-space:pre-wrap;
    word-break:break-word;
    padding:4px 8px;
    overflow:hidden;
  `;
  const fx = buildTextEffectStyle(data);
  inner.style.textShadow = fx.textShadow;
  inner.style.opacity = fx.opacity;
  const displayText = formatListText(data.text || '', data.listStyle);
  if (data.highlightColor) {
    const span = document.createElement('span');
    span.style.backgroundColor = data.highlightColor;
    span.style.borderRadius = '2px';
    span.textContent = displayText;
    inner.appendChild(span);
  } else {
    inner.textContent = displayText;
  }
  return inner;
}

// ===== 要素DOM構築 =====
function buildElement(data, { asGroupChild = false } = {}) {
  const el = document.createElement('div');
  el.className = `slide-element type-${data.type}`;
  el.dataset.id = data.id;
  applyElementStyle(el, data);

  if (data.type === 'group') {
    const inEditMode = state.editingGroupId === data.id;
    if (inEditMode) el.classList.add('group-editing');
    (data.elements || []).forEach(childData => {
      el.appendChild(buildElement(childData, { asGroupChild: !inEditMode }));
    });
  } else if (data.type === 'text') {
    el.appendChild(makeTextInner(data, ''));
  } else if (data.type === 'chart') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;';
    svg.setAttribute('viewBox','0 0 400 280');
    svg.setAttribute('preserveAspectRatio','xMidYMid meet');
    svg.innerHTML = buildChartSVGContent(data.chartData);
    el.appendChild(svg);
  } else if (data.type === 'table') {
    el.appendChild(buildTableElement(data));
  } else if (data.type === 'image') {
    const img = document.createElement('img');
    img.src = data.src || '';
    img.draggable = false;
    img.style.cssText = 'width:100%;height:100%;object-fit:fill;display:block;pointer-events:none;';
    el.appendChild(img);
  } else {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;';
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = LINE_TYPES.has(data.type) && data.points
      ? buildFreehandSVG(data)
      : shapeInnerSVGStyled(data);
    el.appendChild(svg);
    if (!LINE_TYPES.has(data.type)) {
      el.appendChild(makeTextInner(data, 'position:absolute;top:0;left:0;pointer-events:none;'));
    }
  }

  if (asGroupChild) {
    el.style.pointerEvents = 'none';
    return el;
  }

  if (state.selectedElements.has(data.id)) {
    el.classList.add('selected');
    if (state.selectedElement === data.id) {
      addResizeHandles(el);
      addRotateHandle(el, data);
      if (ADJ_SHAPES.has(data.type)) addAdjHandle(el, data);
    }
  }

  el.addEventListener('mousedown', onElementMouseDown);
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!state.selectedElements.has(data.id)) {
      state.selectedElements = new Set([data.id]);
      state.selectedElement = data.id;
      renderAll();
    }
    updatePropertiesPanel();
    showElContextMenu(e.clientX, e.clientY);
  });

  if (data.type === 'chart') {
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openChartEditor(data.id);
    });
  }

  return el;
}

function applyElementStyle(el, data) {
  el.style.left    = data.x + 'px';
  el.style.top     = data.y + 'px';
  el.style.width   = data.w + 'px';
  el.style.height  = data.h + 'px';
  el.style.opacity = data.opacity / 100;
  el.style.zIndex  = data.zIndex || 1;
  const tf = [];
  if (data.rotate) tf.push(`rotate(${data.rotate}deg)`);
  if (data.flipH)  tf.push('scaleX(-1)');
  if (data.flipV)  tf.push('scaleY(-1)');
  el.style.transform = tf.join(' ');
  el.style.transformOrigin = 'center center';
  if (data.type === 'text') {
    if (data.fillNone) {
      el.style.background = 'transparent';
    } else {
      const fc = data.fill || '#4a90d9';
      const fo = (data.fillOpacity ?? 100) / 100;
      if (fo < 1 && /^#[0-9a-fA-F]{6}$/.test(fc)) {
        const r = parseInt(fc.slice(1,3),16), g = parseInt(fc.slice(3,5),16), b = parseInt(fc.slice(5,7),16);
        el.style.background = `rgba(${r},${g},${b},${fo})`;
      } else {
        el.style.background = fc;
      }
    }
    const bStyle = data.strokeStyle === 'dotted' ? 'dotted'
                 : (data.strokeStyle === 'dashed' || data.strokeStyle === 'dash-dot') ? 'dashed'
                 : 'solid';
    if (data.strokeNone) {
      el.style.border = 'none';
    } else {
      const sc = data.stroke || '#000000';
      const so = (data.strokeOpacity ?? 100) / 100;
      let strokeColor = sc;
      if (so < 1 && /^#[0-9a-fA-F]{6}$/.test(sc)) {
        const r = parseInt(sc.slice(1,3),16), g = parseInt(sc.slice(3,5),16), b = parseInt(sc.slice(5,7),16);
        strokeColor = `rgba(${r},${g},${b},${so})`;
      }
      el.style.border = `${data.strokeWidth}px ${bStyle} ${strokeColor}`;
    }
  } else {
    el.style.background = 'transparent';
    el.style.border = 'none';
  }
}

function addResizeHandles(el) {
  ['nw','n','ne','w','e','sw','s','se'].forEach(dir => {
    const h = document.createElement('div');
    h.className = `resize-handle ${dir}`;
    h.dataset.dir = dir;
    h.addEventListener('mousedown', onResizeMouseDown);
    el.appendChild(h);
  });
}

function getAdjHandlePos(data) {
  const adj = data.adj ?? 0.5;
  switch (data.type) {
    case 'roundrect':    return { x: (2 + adj*46), y: 2 };
    case 'parallelogram':return { x: (4 + adj*44), y: 2 };
    case 'trapezoid':    return { x: (4 + (1-adj)*44), y: 2 };
    case 'callout':      return { x: 15 + adj*65, y: 73 };
    case 'callout-oval': return { x: 20 + adj*55, y: 72 };
    case 'callout-r':    return { x: 98, y: 20 + adj*55 };
    case 'chevron':      return { x: 2 + adj*46, y: 50 };
    case 'arrow-r':      return { x: 50 + adj*25, y: 2 };
    case 'arrow-l':      return { x: 50 - adj*25, y: 2 };
    case 'arrow-u':      return { x: 2, y: 50 + adj*25 };
    case 'arrow-d':      return { x: 2, y: 50 - adj*25 };
    default:             return { x: 50, y: 2 };
  }
}

function addAdjHandle(el, data) {
  const h = document.createElement('div');
  h.className = 'adj-handle';
  const pos = getAdjHandlePos(data);
  h.style.left = pos.x + '%';
  h.style.top  = pos.y + '%';
  h.addEventListener('mousedown', (e) => onAdjHandleMouseDown(e, data));
  el.appendChild(h);
}

function onAdjHandleMouseDown(e, data) {
  e.preventDefault();
  e.stopPropagation();
  pushHistory();
  const startX = e.clientX, startY = e.clientY;
  const startAdj = data.adj ?? 0.5;
  const onMove = (ev) => {
    const dx = (ev.clientX - startX) / (data.w * state.scale);
    const dy = (ev.clientY - startY) / (data.h * state.scale);
    let delta;
    switch (data.type) {
      case 'roundrect': case 'parallelogram': case 'callout': case 'callout-oval':
      case 'chevron': case 'arrow-r': delta = dx; break;
      case 'trapezoid': delta = -dx; break;
      case 'arrow-l': delta = -dx; break;
      case 'callout-r': case 'arrow-u': case 'arrow-d': delta = dy; break;
      default: delta = dx;
    }
    data.adj = Math.max(0, Math.min(1, startAdj + delta));
    const elDom = canvas.querySelector(`[data-id="${data.id}"]`);
    if (elDom) {
      const svg = elDom.querySelector('svg');
      if (svg) svg.innerHTML = shapeInnerSVGStyled(data);
      const adjH = elDom.querySelector('.adj-handle');
      if (adjH) {
        const pos = getAdjHandlePos(data);
        adjH.style.left = pos.x + '%';
        adjH.style.top  = pos.y + '%';
      }
    }
    renderThumbnails();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    renderAll();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function addRotateHandle(el, data) {
  const h = document.createElement('div');
  h.className = 'rotate-handle';
  // Small rotation arrow SVG inside the circle
  h.innerHTML = `<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="#89b4fa" stroke-width="1.5" stroke-linecap="round"><path d="M2,6 A4,4 0 1 1 6,10"/><polyline points="2,3.5 2,6 4.5,6"/></svg>`;
  h.addEventListener('mousedown', (e) => onRotateHandleMouseDown(e, data, el));
  el.appendChild(h);
}

function onRotateHandleMouseDown(e, data, el) {
  e.preventDefault();
  e.stopPropagation();
  pushHistory();
  const elRect = el.getBoundingClientRect();
  const cx = elRect.left + elRect.width / 2;
  const cy = elRect.top + elRect.height / 2;
  const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx);
  const startRotate = (data.rotate || 0) * (Math.PI / 180);
  const onMove = (ev) => {
    const cur = Math.atan2(ev.clientY - cy, ev.clientX - cx);
    const delta = (cur - startAngle) * (180 / Math.PI);
    data.rotate = ((startRotate * (180 / Math.PI) + delta) % 360 + 360) % 360;
    data.rotate = Math.round(data.rotate * 10) / 10;
    const propRotate = document.getElementById('prop-rotate');
    if (propRotate) propRotate.value = Math.round(data.rotate);
    applyElementStyle(el, data);
    renderThumbnails();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    renderAll();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function buildFreehandSVG(data) {
  const pts = data.points;
  if (!pts || pts.length < 2) return `<line x1="0" y1="50" x2="100" y2="50" stroke="${data.stroke||'#000'}" stroke-width="${data.strokeWidth||3}" fill="none"/>`;
  const stroke = data.strokeNone ? 'none' : (data.stroke || '#000000');
  const sw = data.strokeNone ? 0 : (data.strokeWidth || 3);
  const fillColor = data.fillNone ? 'none' : (data.fill || 'none');
  const fo = (!data.fillNone && (data.fillOpacity ?? 100) < 100) ? ` fill-opacity="${(data.fillOpacity/100).toFixed(3)}"` : '';
  const so = (!data.strokeNone && (data.strokeOpacity ?? 100) < 100) ? ` stroke-opacity="${(data.strokeOpacity/100).toFixed(3)}"` : '';
  const d = data.type === 'curve' ? catmullRomPath(pts)
    : pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  return `<path d="${d}" fill="${fillColor}" stroke="${stroke}" stroke-width="${sw}" vector-effect="non-scaling-stroke"${fo}${so}/>`;
}

function catmullRomPath(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i-1)], p1 = pts[i], p2 = pts[i+1], p3 = pts[Math.min(pts.length-1, i+2)];
    const t = 0.5;
    const cp1x = p1.x + (p2.x-p0.x)*t/3, cp1y = p1.y + (p2.y-p0.y)*t/3;
    const cp2x = p2.x - (p3.x-p1.x)*t/3, cp2y = p2.y - (p3.y-p1.y)*t/3;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

// ===== 要素データ作成 =====
const LINE_TYPES = new Set(['line', 'arrow-line', 'freehand', 'polyline', 'curve']);
const ADJ_SHAPES = new Set(['roundrect','parallelogram','trapezoid','callout','callout-oval','callout-r','chevron','arrow-r','arrow-l','arrow-u','arrow-d']);

// ===== グラフ =====
const CHART_PALETTES = {
  default: ['#89b4fa','#a6e3a1','#fab387','#f38ba8','#cba6f7','#94e2d5','#f9e2af','#eba0ac'],
  warm:    ['#f38ba8','#fab387','#f9e2af','#eba0ac','#dd7878','#e64553','#df8e1d','#fe640b'],
  cool:    ['#89b4fa','#74c7ec','#cba6f7','#94e2d5','#89dceb','#b4befe','#7287fd','#04a5e5'],
  vivid:   ['#e64553','#fe640b','#df8e1d','#40a02b','#04a5e5','#7287fd','#ea76cb','#dd7878'],
  pastel:  ['#f2cdcd','#f5c2e7','#cba6f7','#89dceb','#a6e3a1','#f9e2af','#fab387','#eba0ac'],
  mono:    ['#cdd6f4','#bac2de','#a6adc8','#9399b2','#7f849c','#6c7086','#585b70','#45475a'],
};
const CHART_PALETTE_META = [
  {key:'default',name:'標準'},{key:'warm',name:'ウォーム'},{key:'cool',name:'クール'},
  {key:'vivid',name:'ビビッド'},{key:'pastel',name:'パステル'},{key:'mono',name:'モノトーン'},
];
const CHART_COLORS_DEFAULT = CHART_PALETTES.default;
const CHART_PIE_CX = 175, CHART_PIE_CY = 140;

function _escSvg(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function _niceMax(v) {
  if (v <= 0) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const n of [1,2,2.5,5,10]) if (n * mag >= v) return n * mag;
  return 10 * mag;
}

function _resolveColors(cd) {
  const base = CHART_PALETTES[cd.palette || 'default'] || CHART_PALETTES.default;
  return (cd.series || []).map((s, i) => s.color || base[i % base.length]);
}

function _axisStroke(cd) { return cd.axisColor || '#313244'; }
function _labelFill(cd) { return cd.axisLabelColor || '#6c7086'; }
function _labelSize(cd) { return cd.axisLabelSize || 9; }
function _gridOpa(cd) { return ((cd.gridOpacity ?? 7) / 100).toFixed(3); }

function _yRange(cd, series) {
  const rawMax = Math.max(...(series || []).map(s => s.value), 0);
  const maxVal = (cd.axisYMax != null && cd.axisYMax !== '') ? Number(cd.axisYMax) : _niceMax(rawMax);
  const minVal = (cd.axisYMin != null && cd.axisYMin !== '') ? Number(cd.axisYMin) : 0;
  return { maxVal, minVal, range: Math.max(maxVal - minVal, 0.001) };
}

function _plotBgRect(cd, x, y, w, h) {
  if (!cd.plotBgColor) return '';
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${cd.plotBgColor}" opacity="0.4"/>`;
}

function _borderRect(cd, W, H) {
  if (!cd.showBorder) return '';
  const bw = cd.borderWidth ?? 1;
  const rx = cd.borderRx ?? 6;
  const bc = cd.borderColor || '#45475a';
  return `<rect x="${(bw/2).toFixed(1)}" y="${(bw/2).toFixed(1)}" width="${(W-bw).toFixed(1)}" height="${(H-bw).toFixed(1)}" rx="${rx}" fill="none" stroke="${bc}" stroke-width="${bw}"/>`;
}

function _buildMarker(cd, cx, cy, color, dataAttr, idx) {
  const shape = cd.markerShape || 'circle';
  if (shape === 'none') return '';
  const r = cd.markerSize ?? 5;
  const a = `${dataAttr}="${idx}"`;
  if (shape === 'square') {
    return `<g ${a}><rect x="${(cx-r).toFixed(1)}" y="${(cy-r).toFixed(1)}" width="${(r*2).toFixed(1)}" height="${(r*2).toFixed(1)}" fill="${color}" stroke="rgba(0,0,0,0.3)" stroke-width="1"/></g>`;
  }
  if (shape === 'diamond') {
    return `<g ${a}><polygon points="${cx},${(cy-r).toFixed(1)} ${(cx+r).toFixed(1)},${cy} ${cx},${(cy+r).toFixed(1)} ${(cx-r).toFixed(1)},${cy}" fill="${color}" stroke="rgba(0,0,0,0.3)" stroke-width="1"/></g>`;
  }
  if (shape === 'triangle') {
    return `<g ${a}><polygon points="${cx},${(cy-r).toFixed(1)} ${(cx+r*0.87).toFixed(1)},${(cy+r*0.5).toFixed(1)} ${(cx-r*0.87).toFixed(1)},${(cy+r*0.5).toFixed(1)}" fill="${color}" stroke="rgba(0,0,0,0.3)" stroke-width="1"/></g>`;
  }
  const hi = r > 1.5 ? `<circle cx="${cx}" cy="${cy}" r="${(r*0.5).toFixed(1)}" fill="#cdd6f4"/>` : '';
  return `<g ${a}><circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" stroke="rgba(0,0,0,0.3)" stroke-width="1"/>${hi}</g>`;
}

const _EASING_MAP = {
  ease: 'ease', 'ease-in': 'ease-in', 'ease-out': 'ease-out',
  'ease-in-out': 'ease-in-out', linear: 'linear',
  bounce: 'cubic-bezier(0.34,1.56,0.64,1)',
};
function _custDur(cd, base) { return (cd && cd.animDuration > 0) ? cd.animDuration : base; }
function _custEase(cd, base) {
  const e = cd && cd.animEasing && cd.animEasing !== 'auto' ? cd.animEasing : null;
  return (e && _EASING_MAP[e]) ? _EASING_MAP[e] : base;
}

function _smoothPath(pts) {
  if (pts.length < 2) return pts.map((p, i) => `${i===0?'M':'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const t = 0.3;
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = i > 1 ? pts[i-2] : pts[i-1];
    const p1 = pts[i-1], p2 = pts[i];
    const p3 = i < pts.length - 1 ? pts[i+1] : pts[i];
    const cp1x = p1.x + (p2.x - p0.x) * t;
    const cp1y = p1.y + (p2.y - p0.y) * t;
    const cp2x = p2.x - (p3.x - p1.x) * t;
    const cp2y = p2.y - (p3.y - p1.y) * t;
    d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
  }
  return d;
}

function buildBarChartSVG(cd) {
  const colors = _resolveColors(cd);
  const series = cd.series || [];
  const padL = 45, padR = 20, padT = cd.title ? 34 : 18, padB = 44;
  const W = 400, H = 280;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const yr = _yRange(cd, series);
  const barW = Math.max(4, Math.floor((chartW / (series.length || 1)) * 0.6));
  const barGap = chartW / (series.length || 1);
  const rx = cd.barRadius ?? 3;

  let defs = '<defs>';
  series.forEach((s, i) => {
    const c = colors[i];
    defs += `<linearGradient id="bg${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${c}" stop-opacity="0.95"/><stop offset="100%" stop-color="${c}" stop-opacity="0.65"/></linearGradient>`;
  });
  defs += '</defs>';

  const plotBg = _plotBgRect(cd, padL, padT, chartW, chartH);
  let grid = '';
  if (cd.showGrid !== false) {
    for (let k = 1; k <= 5; k++) {
      const gy = padT + chartH - (k / 5) * chartH;
      grid += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="rgba(255,255,255,${_gridOpa(cd)})" stroke-width="1"/>`;
      const lv = (yr.minVal + (k / 5) * yr.range).toFixed(yr.maxVal < 10 ? 1 : 0);
      grid += `<text x="${padL - 5}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="${_labelSize(cd)}" fill="${_labelFill(cd)}">${_escSvg(lv)}</text>`;
    }
  }

  const axes = `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + chartH}" stroke="${_axisStroke(cd)}" stroke-width="1.5"/>` +
               `<line x1="${padL}" y1="${padT + chartH}" x2="${W - padR}" y2="${padT + chartH}" stroke="${_axisStroke(cd)}" stroke-width="1.5"/>`;

  let bars = '';
  series.forEach((s, i) => {
    const bh = yr.range > 0 ? Math.max(0, (s.value - yr.minVal) / yr.range) * chartH : 0;
    const bx = padL + i * barGap + (barGap - barW) / 2;
    const by = padT + chartH - bh;
    bars += `<rect data-bar="${i}" x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW}" height="${bh.toFixed(1)}" rx="${rx}" fill="url(#bg${i})"/>`;
    bars += `<rect x="${(bx + 2).toFixed(1)}" y="${by.toFixed(1)}" width="${Math.max(0, barW - 4)}" height="${Math.min(bh, 8).toFixed(1)}" rx="2" fill="rgba(255,255,255,0.12)" pointer-events="none"/>`;
    if (cd.showValues && bh > 12) {
      bars += `<text x="${(bx + barW / 2).toFixed(1)}" y="${(by - 4).toFixed(1)}" text-anchor="middle" font-size="${_labelSize(cd)}" fill="#cdd6f4">${_escSvg(s.value)}</text>`;
    }
    const lx = padL + i * barGap + barGap / 2;
    const maxLabelLen = Math.floor(barGap / 6.5);
    const label = String(s.label || '').length > maxLabelLen ? String(s.label).slice(0, maxLabelLen - 1) + '…' : (s.label || '');
    bars += `<text x="${lx.toFixed(1)}" y="${(padT + chartH + 14).toFixed(1)}" text-anchor="middle" font-size="${_labelSize(cd)}" fill="${_labelFill(cd)}">${_escSvg(label)}</text>`;
  });

  let title = '';
  if (cd.title) {
    title = `<text x="${W / 2}" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="#cdd6f4">${_escSvg(cd.title)}</text>`;
  }

  return `${defs}${plotBg}${grid}${axes}${bars}${title}${_borderRect(cd, W, H)}`;
}

function buildHBarChartSVG(cd) {
  const colors = _resolveColors(cd);
  const series = cd.series || [];
  const padL = 75, padR = 30, padT = cd.title ? 34 : 18, padB = 22;
  const W = 400, H = 280;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const yr = _yRange(cd, series);
  const barH = Math.max(4, Math.floor((chartH / (series.length || 1)) * 0.6));
  const barGap = chartH / (series.length || 1);
  const rx = cd.barRadius ?? 3;

  let defs = '<defs>';
  series.forEach((s, i) => {
    const c = colors[i];
    defs += `<linearGradient id="hbg${i}" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="${c}" stop-opacity="0.65"/><stop offset="100%" stop-color="${c}" stop-opacity="0.95"/></linearGradient>`;
  });
  defs += '</defs>';

  const plotBg = _plotBgRect(cd, padL, padT, chartW, chartH);
  let grid = '';
  if (cd.showGrid !== false) {
    for (let k = 1; k <= 5; k++) {
      const gx = padL + (k / 5) * chartW;
      grid += `<line x1="${gx.toFixed(1)}" y1="${padT}" x2="${gx.toFixed(1)}" y2="${padT + chartH}" stroke="rgba(255,255,255,${_gridOpa(cd)})" stroke-width="1"/>`;
      const lv = (yr.minVal + (k / 5) * yr.range).toFixed(yr.maxVal < 10 ? 1 : 0);
      grid += `<text x="${gx.toFixed(1)}" y="${(padT + chartH + 12).toFixed(1)}" text-anchor="middle" font-size="${_labelSize(cd)}" fill="${_labelFill(cd)}">${_escSvg(lv)}</text>`;
    }
  }

  const axes = `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + chartH}" stroke="${_axisStroke(cd)}" stroke-width="1.5"/>` +
               `<line x1="${padL}" y1="${padT + chartH}" x2="${W - padR}" y2="${padT + chartH}" stroke="${_axisStroke(cd)}" stroke-width="1.5"/>`;

  let bars = '';
  series.forEach((s, i) => {
    const bw = yr.range > 0 ? Math.max(0, (s.value - yr.minVal) / yr.range) * chartW : 0;
    const by = padT + i * barGap + (barGap - barH) / 2;
    bars += `<rect data-hbar="${i}" x="${padL}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH}" rx="${rx}" fill="url(#hbg${i})"/>`;
    if (cd.showValues && bw > 20) {
      bars += `<text x="${(padL + bw + 4).toFixed(1)}" y="${(by + barH / 2 + 3).toFixed(1)}" text-anchor="start" font-size="${_labelSize(cd)}" fill="#cdd6f4">${_escSvg(s.value)}</text>`;
    }
    const maxLabelLen = Math.floor(padL / 6.5);
    const label = String(s.label || '').length > maxLabelLen ? String(s.label).slice(0, maxLabelLen - 1) + '…' : (s.label || '');
    bars += `<text x="${(padL - 6).toFixed(1)}" y="${(by + barH / 2 + 3).toFixed(1)}" text-anchor="end" font-size="${_labelSize(cd)}" fill="${_labelFill(cd)}">${_escSvg(label)}</text>`;
  });

  let title = '';
  if (cd.title) {
    title = `<text x="${W / 2}" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="#cdd6f4">${_escSvg(cd.title)}</text>`;
  }

  return `${defs}${plotBg}${grid}${axes}${bars}${title}${_borderRect(cd, W, H)}`;
}

function buildLineChartSVG(cd) {
  const colors = _resolveColors(cd);
  const series = cd.series || [];
  const padL = 45, padR = 20, padT = cd.title ? 34 : 18, padB = 44;
  const W = 400, H = 280;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const yr = _yRange(cd, series);
  const n = series.length;

  let defs = '<defs>';
  defs += `<linearGradient id="lg-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${colors[0]}" stop-opacity="0.25"/><stop offset="100%" stop-color="${colors[0]}" stop-opacity="0.02"/></linearGradient>`;
  defs += '</defs>';

  const plotBg = _plotBgRect(cd, padL, padT, chartW, chartH);
  let grid = '';
  if (cd.showGrid !== false) {
    for (let k = 1; k <= 5; k++) {
      const gy = padT + chartH - (k / 5) * chartH;
      grid += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="rgba(255,255,255,${_gridOpa(cd)})" stroke-width="1"/>`;
      const lv = (yr.minVal + (k / 5) * yr.range).toFixed(yr.maxVal < 10 ? 1 : 0);
      grid += `<text x="${padL - 5}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="${_labelSize(cd)}" fill="${_labelFill(cd)}">${_escSvg(lv)}</text>`;
    }
  }

  const axes = `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + chartH}" stroke="${_axisStroke(cd)}" stroke-width="1.5"/>` +
               `<line x1="${padL}" y1="${padT + chartH}" x2="${W - padR}" y2="${padT + chartH}" stroke="${_axisStroke(cd)}" stroke-width="1.5"/>`;

  const pts = series.map((s, i) => {
    const px = n > 1 ? padL + (i / (n - 1)) * chartW : padL + chartW / 2;
    const py = padT + chartH - (yr.range > 0 ? Math.max(0, (s.value - yr.minVal) / yr.range) * chartH : 0);
    return { x: px, y: py };
  });

  let pathD = '';
  let areaD = '';
  if (pts.length >= 2) {
    pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    areaD = pathD + ` L${pts[pts.length-1].x.toFixed(1)},${(padT+chartH).toFixed(1)} L${pts[0].x.toFixed(1)},${(padT+chartH).toFixed(1)} Z`;
  } else if (pts.length === 1) {
    pathD = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    areaD = '';
  }

  const area = (cd.lineFill !== false) && areaD ? `<path data-line-fill="1" d="${areaD}" fill="url(#lg-area)" stroke="none"/>` : '';
  const lw = cd.lineWidth ?? 2.5;
  const line = pathD ? `<path data-line-path="1" d="${pathD}" fill="none" stroke="${colors[0]}" stroke-width="${lw}" stroke-linejoin="round" stroke-linecap="round"/>` : '';

  let dots = '';
  pts.forEach((p, i) => {
    dots += _buildMarker(cd, p.x, p.y, colors[0], 'data-dot', i);
    if (cd.showValues) {
      dots += `<text data-val="${i}" x="${p.x.toFixed(1)}" y="${(p.y - 10).toFixed(1)}" text-anchor="middle" font-size="${_labelSize(cd)}" fill="#cdd6f4">${_escSvg(series[i].value)}</text>`;
    }
    const maxLabelLen = n > 1 ? Math.floor(chartW / (n - 1) / 6.5) : 20;
    const label = String(series[i].label || '').length > maxLabelLen ? String(series[i].label).slice(0, maxLabelLen - 1) + '…' : (series[i].label || '');
    dots += `<text x="${p.x.toFixed(1)}" y="${(padT + chartH + 14).toFixed(1)}" text-anchor="middle" font-size="${_labelSize(cd)}" fill="${_labelFill(cd)}">${_escSvg(label)}</text>`;
  });

  let title = '';
  if (cd.title) {
    title = `<text x="${W / 2}" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="#cdd6f4">${_escSvg(cd.title)}</text>`;
  }

  return `${defs}${plotBg}${grid}${axes}${area}${line}${dots}${title}${_borderRect(cd, W, H)}`;
}

function buildAreaChartSVG(cd) {
  const colors = _resolveColors(cd);
  const series = cd.series || [];
  const padL = 45, padR = 20, padT = cd.title ? 34 : 18, padB = 44;
  const W = 400, H = 280;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const yr = _yRange(cd, series);
  const n = series.length;

  let defs = '<defs>';
  defs += `<linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${colors[0]}" stop-opacity="0.65"/><stop offset="100%" stop-color="${colors[0]}" stop-opacity="0.04"/></linearGradient>`;
  defs += '</defs>';

  const plotBg = _plotBgRect(cd, padL, padT, chartW, chartH);
  let grid = '';
  if (cd.showGrid !== false) {
    for (let k = 1; k <= 5; k++) {
      const gy = padT + chartH - (k / 5) * chartH;
      grid += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="rgba(255,255,255,${_gridOpa(cd)})" stroke-width="1"/>`;
      const lv = (yr.minVal + (k / 5) * yr.range).toFixed(yr.maxVal < 10 ? 1 : 0);
      grid += `<text x="${padL - 5}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="${_labelSize(cd)}" fill="${_labelFill(cd)}">${_escSvg(lv)}</text>`;
    }
  }

  const axes = `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + chartH}" stroke="${_axisStroke(cd)}" stroke-width="1.5"/>` +
               `<line x1="${padL}" y1="${padT + chartH}" x2="${W - padR}" y2="${padT + chartH}" stroke="${_axisStroke(cd)}" stroke-width="1.5"/>`;

  const pts = series.map((s, i) => {
    const px = n > 1 ? padL + (i / (n - 1)) * chartW : padL + chartW / 2;
    const py = padT + chartH - (yr.range > 0 ? Math.max(0, (s.value - yr.minVal) / yr.range) * chartH : 0);
    return { x: px, y: py };
  });

  let pathD = '';
  let areaD = '';
  if (pts.length >= 2) {
    pathD = _smoothPath(pts);
    const baseY = padT + chartH;
    areaD = pathD + ` L${pts[pts.length-1].x.toFixed(1)},${baseY.toFixed(1)} L${pts[0].x.toFixed(1)},${baseY.toFixed(1)} Z`;
  } else if (pts.length === 1) {
    pathD = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  }

  const area = areaD ? `<path data-area-fill="1" d="${areaD}" fill="url(#area-fill)" stroke="none"/>` : '';
  const alw = cd.lineWidth ?? 2.5;
  const line = pathD ? `<path data-area-path="1" d="${pathD}" fill="none" stroke="${colors[0]}" stroke-width="${alw}" stroke-linejoin="round" stroke-linecap="round"/>` : '';

  let dots = '';
  pts.forEach((p, i) => {
    dots += _buildMarker(cd, p.x, p.y, colors[0], 'data-area-dot', i);
    if (cd.showValues) {
      dots += `<text data-val="${i}" x="${p.x.toFixed(1)}" y="${(p.y - 10).toFixed(1)}" text-anchor="middle" font-size="${_labelSize(cd)}" fill="#cdd6f4">${_escSvg(series[i].value)}</text>`;
    }
    const maxLabelLen = n > 1 ? Math.floor(chartW / (n - 1) / 6.5) : 20;
    const label = String(series[i].label || '').length > maxLabelLen ? String(series[i].label).slice(0, maxLabelLen - 1) + '…' : (series[i].label || '');
    dots += `<text x="${p.x.toFixed(1)}" y="${(padT + chartH + 14).toFixed(1)}" text-anchor="middle" font-size="${_labelSize(cd)}" fill="${_labelFill(cd)}">${_escSvg(label)}</text>`;
  });

  let title = '';
  if (cd.title) {
    title = `<text x="${W / 2}" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="#cdd6f4">${_escSvg(cd.title)}</text>`;
  }

  return `${defs}${plotBg}${grid}${axes}${area}${line}${dots}${title}${_borderRect(cd, W, H)}`;
}

function buildPieChartSVG(cd, isDonut) {
  const colors = _resolveColors(cd);
  const series = cd.series || [];
  const cx = CHART_PIE_CX, cy = CHART_PIE_CY;
  const r = isDonut ? 95 : 100;
  const innerR = isDonut ? Math.round(r * 0.52) : 0;
  const total = series.reduce((s, d) => s + (d.value || 0), 0);

  let slices = '';
  let legend = '';
  let angle = -Math.PI / 2;

  series.forEach((s, i) => {
    const pct = total > 0 ? s.value / total : 0;
    const sweep = pct * 2 * Math.PI;
    const endAngle = angle + sweep;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(endAngle), y2 = cy + r * Math.sin(endAngle);
    const large = sweep > Math.PI ? 1 : 0;
    const color = colors[i];

    let d = '';
    if (isDonut) {
      const ix1 = cx + innerR * Math.cos(angle), iy1 = cy + innerR * Math.sin(angle);
      const ix2 = cx + innerR * Math.cos(endAngle), iy2 = cy + innerR * Math.sin(endAngle);
      d = `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large},1 ${x2.toFixed(2)},${y2.toFixed(2)} L${ix2.toFixed(2)},${iy2.toFixed(2)} A${innerR},${innerR} 0 ${large},0 ${ix1.toFixed(2)},${iy1.toFixed(2)} Z`;
    } else {
      d = `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large},1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
    }
    slices += `<path data-slice="${i}" data-cx="${cx}" data-cy="${cy}" d="${d}" fill="${color}" stroke="#1e1e2e" stroke-width="1.5"/>`;

    if (pct > 0.04) {
      const midAngle = angle + sweep / 2;
      const lr = (r + (isDonut ? innerR : 0)) / 2;
      const lx = cx + lr * Math.cos(midAngle);
      const ly = cy + lr * Math.sin(midAngle);
      const pctStr = (pct * 100).toFixed(0) + '%';
      slices += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-size="10" font-weight="600" fill="#fff" pointer-events="none">${_escSvg(pctStr)}</text>`;
    }

    if (cd.showLegend !== false) {
      const ly = 60 + i * 18;
      legend += `<rect x="290" y="${ly - 9}" width="10" height="10" rx="2" fill="${color}"/>`;
      const label = String(s.label || '').length > 12 ? String(s.label).slice(0, 11) + '…' : (s.label || '');
      legend += `<text x="305" y="${ly}" font-size="10" fill="#cdd6f4">${_escSvg(label)}</text>`;
    }

    angle = endAngle;
  });

  let title = '';
  if (cd.title) {
    title = `<text x="${CHART_PIE_CX}" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="#cdd6f4">${_escSvg(cd.title)}</text>`;
  }

  return `${slices}${legend}${title}${_borderRect(cd, 400, 280)}`;
}

function buildRadarChartSVG(cd) {
  const colors = _resolveColors(cd);
  const series = cd.series || [];
  const n = series.length;
  const W = 400, H = 280;
  const cx = 175, cy = 145, r = 98;

  if (n < 3) {
    return `<text x="200" y="145" text-anchor="middle" font-size="13" fill="#6c7086">3つ以上のデータが必要です</text>`;
  }

  const maxVal = _niceMax(Math.max(...series.map(s => s.value), 0));
  const angles = series.map((_, i) => -Math.PI / 2 + (2 * Math.PI * i) / n);

  let grid = '';
  for (let k = 1; k <= 5; k++) {
    const kr = (k / 5) * r;
    const pts = angles.map(a => `${(cx + kr * Math.cos(a)).toFixed(1)},${(cy + kr * Math.sin(a)).toFixed(1)}`).join(' ');
    grid += `<polygon points="${pts}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`;
    if (k === 5) {
      const lv = maxVal.toFixed(maxVal < 10 ? 1 : 0);
      grid += `<text x="${(cx + kr * Math.cos(-Math.PI/2) - 4).toFixed(1)}" y="${(cy + kr * Math.sin(-Math.PI/2) - 4).toFixed(1)}" text-anchor="middle" font-size="8" fill="#6c7086">${_escSvg(lv)}</text>`;
    }
  }
  angles.forEach(a => {
    grid += `<line x1="${cx}" y1="${cy}" x2="${(cx + r * Math.cos(a)).toFixed(1)}" y2="${(cy + r * Math.sin(a)).toFixed(1)}" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>`;
  });

  const dataPts = series.map((s, i) => {
    const dr = maxVal > 0 ? (s.value / maxVal) * r : 0;
    return { x: cx + dr * Math.cos(angles[i]), y: cy + dr * Math.sin(angles[i]) };
  });
  const polyPts = dataPts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  let shape = `<polygon data-radar-path="1" points="${polyPts}" fill="${colors[0]}" fill-opacity="0.22" stroke="${colors[0]}" stroke-width="2" stroke-linejoin="round"/>`;

  dataPts.forEach((p, i) => {
    shape += _buildMarker(cd, p.x, p.y, colors[0], 'data-radar-dot', i);
    if (cd.showValues) {
      shape += `<text x="${p.x.toFixed(1)}" y="${(p.y - 9).toFixed(1)}" text-anchor="middle" font-size="${_labelSize(cd)}" fill="#cdd6f4">${_escSvg(series[i].value)}</text>`;
    }
  });

  angles.forEach((a, i) => {
    const lx = cx + (r + 16) * Math.cos(a);
    const ly = cy + (r + 16) * Math.sin(a);
    const anchor = Math.abs(Math.cos(a)) < 0.15 ? 'middle' : Math.cos(a) < 0 ? 'end' : 'start';
    const label = String(series[i].label || '').length > 10 ? String(series[i].label).slice(0, 9) + '…' : (series[i].label || '');
    shape += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchor}" font-size="10" fill="#a6adc8">${_escSvg(label)}</text>`;
  });

  let title = '';
  if (cd.title) {
    title = `<text x="${W / 2}" y="16" text-anchor="middle" font-size="13" font-weight="600" fill="#cdd6f4">${_escSvg(cd.title)}</text>`;
  }

  return `${grid}${shape}${title}${_borderRect(cd, W, H)}`;
}

function buildChartSVGContent(cd) {
  if (!cd || !cd.series || !cd.series.length) {
    return `<text x="200" y="145" text-anchor="middle" font-size="14" fill="#6c7086">データなし</text>`;
  }
  if (cd.chartType === 'bar')   return buildBarChartSVG(cd);
  if (cd.chartType === 'hbar')  return buildHBarChartSVG(cd);
  if (cd.chartType === 'line')  return buildLineChartSVG(cd);
  if (cd.chartType === 'area')  return buildAreaChartSVG(cd);
  if (cd.chartType === 'pie')   return buildPieChartSVG(cd, false);
  if (cd.chartType === 'donut') return buildPieChartSVG(cd, true);
  if (cd.chartType === 'radar') return buildRadarChartSVG(cd);
  return `<text x="200" y="145" text-anchor="middle" font-size="14" fill="#6c7086">不明なグラフ種別</text>`;
}

// ===== グラフアニメーション =====
function playChartAnimations(containerEl, slideData, excludeIds = new Set()) {
  containerEl.querySelectorAll('.type-chart').forEach(el => {
    if (excludeIds.has(el.dataset.id)) return;
    const d = (slideData?.elements || []).find(e => e.id === el.dataset.id);
    if (d?.chartData) playChartAnimation(el, d.chartData);
  });
}

function playChartAnimation(el, cd) {
  const svg = el.querySelector('svg');
  if (!svg) return;
  const anim = cd.animStyle || 'cascade';
  const dur = (d) => _custDur(cd, d);
  const ease = (e) => _custEase(cd, e);

  if (cd.chartType === 'bar') {
    svg.querySelectorAll('[data-bar]').forEach((bar, i) => {
      bar.style.transformBox = 'fill-box';
      bar.style.transformOrigin = '50% 100%';
      const delay = anim === 'rise' ? 0 : i * 110;
      if (anim === 'fade') {
        bar.animate([{opacity:0},{opacity:1}], {duration:dur(600), delay, easing:ease('ease-out'), fill:'both'});
      } else if (anim === 'bounce') {
        bar.animate(
          [{transform:'scaleY(0)',opacity:0},{transform:'scaleY(1.18)',opacity:1},{transform:'scaleY(0.9)'},{transform:'scaleY(1.05)'},{transform:'scaleY(1)'}],
          {duration:dur(900), delay, easing:ease('ease-out'), fill:'both'}
        );
      } else {
        bar.animate(
          [{transform:'scaleY(0)',opacity:0},{transform:'scaleY(1)',opacity:1}],
          {duration:dur(700), delay, easing:ease('cubic-bezier(0.34,1.3,0.64,1)'), fill:'both'}
        );
      }
    });

  } else if (cd.chartType === 'hbar') {
    svg.querySelectorAll('[data-hbar]').forEach((bar, i) => {
      bar.style.transformBox = 'fill-box';
      bar.style.transformOrigin = '0% 50%';
      const delay = anim === 'rise' ? 0 : i * 110;
      bar.animate(
        [{transform:'scaleX(0)',opacity:0},{transform:'scaleX(1)',opacity:1}],
        {duration:dur(700), delay, easing:ease('cubic-bezier(0.34,1.2,0.64,1)'), fill:'both'}
      );
    });

  } else if (cd.chartType === 'line' || cd.chartType === 'area') {
    const isArea = cd.chartType === 'area';
    const path = svg.querySelector(isArea ? '[data-area-path]' : '[data-line-path]');
    const dots = [...svg.querySelectorAll(isArea ? '[data-area-dot]' : '[data-dot]')];
    const vals = [...svg.querySelectorAll('[data-val]')];
    const n = dots.length;
    const doAnim  = cd.animateDots   !== false;
    const doVals  = cd.animateValues !== false;

    const _drawPath = (delay = 0) => {
      if (!path) return;
      const len = path.getTotalLength();
      path.animate(
        [{strokeDasharray:`${len}`,strokeDashoffset:`${len}`},{strokeDasharray:`${len}`,strokeDashoffset:'0'}],
        {duration:dur(1100), delay, easing:ease('cubic-bezier(0.4,0,0.2,1)'), fill:'both'}
      );
    };

    // Fill reveals left-to-right with clip-path, trailing slightly behind the line
    const _animFill = (delay = 0, drawDur = dur(1100), isFade = false) => {
      const fp = svg.querySelector(isArea ? '[data-area-fill]' : '[data-line-fill]');
      if (!fp) return;
      if (isFade) {
        fp.animate([{opacity:0},{opacity:1}], {duration:dur(700), delay, easing:ease('ease-out'), fill:'both'});
      } else {
        // Same easing as _drawPath so fill tracks the line; 90ms delay gives a "chasing" feel
        fp.animate(
          [{clipPath:'inset(0 100% 0 0)'},{clipPath:'inset(0 0% 0 0)'}],
          {duration: drawDur, delay: delay + 90, easing: ease('cubic-bezier(0.4,0,0.2,1)'), fill:'both'}
        );
      }
    };

    // Dots pop as the line reaches each point; vals animate independently
    const _dotsWithLine = (lineDelay, drawDur) => {
      dots.forEach((dot, i) => {
        const frac = n > 1 ? i / (n - 1) : 0.5;
        const delay = lineDelay + Math.round(frac * drawDur);
        if (doAnim) {
          dot.style.transformBox = 'fill-box';
          dot.style.transformOrigin = '50% 50%';
          dot.animate(
            [{transform:'scale(0)',opacity:0},{transform:'scale(1.4)',opacity:1},{transform:'scale(1)'}],
            {duration:dur(280), delay, easing:ease('cubic-bezier(0.34,1.5,0.64,1)'), fill:'both'}
          );
        }
        if (doVals) {
          const vl = vals[i];
          if (vl) vl.animate([{opacity:0},{opacity:1}], {duration:dur(200), delay:delay+80, easing:ease('ease-out'), fill:'both'});
        }
      });
    };

    const _popDots = (baseDelay = 0, stagger = 80) => {
      if (doAnim) {
        dots.forEach((dot, i) => {
          dot.style.transformBox = 'fill-box';
          dot.style.transformOrigin = '50% 50%';
          dot.animate(
            [{transform:'scale(0)',opacity:0},{transform:'scale(1)',opacity:1}],
            {duration:dur(280), delay:baseDelay+i*stagger, easing:ease('cubic-bezier(0.34,1.5,0.64,1)'), fill:'both'}
          );
        });
      }
      if (doVals) vals.forEach((vl, i) => vl.animate([{opacity:0},{opacity:1}], {duration:dur(200), delay:baseDelay+i*stagger+80, easing:ease('ease-out'), fill:'both'}));
    };

    if (anim === 'dot-first') {
      if (doAnim) {
        dots.forEach((dot, i) => {
          dot.style.transformBox = 'fill-box';
          dot.style.transformOrigin = '50% 50%';
          dot.animate(
            [{transform:'scale(0)',opacity:0},{transform:'scale(1)',opacity:1}],
            {duration:dur(280), delay:i*100, easing:ease('cubic-bezier(0.34,1.5,0.64,1)'), fill:'both'}
          );
        });
      }
      if (doVals) vals.forEach((vl, i) => vl.animate([{opacity:0},{opacity:1}], {duration:dur(200), delay:i*100+80, easing:ease('ease-out'), fill:'both'}));
      const lineDelay = doAnim ? n * 100 : 0;
      _drawPath(lineDelay);
      _animFill(lineDelay, dur(1100));
    } else if (anim === 'rise') {
      if (doAnim) {
        dots.forEach((dot, i) => {
          dot.animate(
            [{transform:'translateY(28px)',opacity:0},{transform:'translateY(0)',opacity:1}],
            {duration:dur(420), delay:i*90, easing:ease('cubic-bezier(0.34,1.2,0.64,1)'), fill:'both'}
          );
        });
      }
      if (doVals) vals.forEach((vl, i) => vl.animate(
        [{transform:'translateY(28px)',opacity:0},{transform:'translateY(0)',opacity:1}],
        {duration:dur(420), delay:i*90, easing:ease('cubic-bezier(0.34,1.2,0.64,1)'), fill:'both'}
      ));
      const lineDelay = doAnim ? n * 90 : 0;
      _drawPath(lineDelay);
      _animFill(lineDelay, dur(1100));
    } else if (anim === 'pop') {
      if (doAnim) {
        dots.forEach(dot => {
          dot.style.transformBox = 'fill-box';
          dot.style.transformOrigin = '50% 50%';
          dot.animate(
            [{transform:'scale(0)',opacity:0},{transform:'scale(1.5)',opacity:1},{transform:'scale(1)'}],
            {duration:dur(500), delay:0, easing:ease('ease-out'), fill:'both'}
          );
        });
      }
      if (doVals) vals.forEach(vl => vl.animate([{opacity:0},{opacity:1}], {duration:dur(300), delay:100, easing:ease('ease-out'), fill:'both'}));
      const lineDelay = doAnim ? 380 : 0;
      _drawPath(lineDelay);
      _animFill(lineDelay, dur(1100));
    } else if (anim === 'fade') {
      if (path) path.animate([{opacity:0},{opacity:1}], {duration:dur(800), easing:ease('ease-out'), fill:'both'});
      if (doAnim) dots.forEach((dot, i) => dot.animate([{opacity:0},{opacity:1}], {duration:dur(500), delay:i*70, easing:ease('ease-out'), fill:'both'}));
      if (doVals) vals.forEach((vl, i) => vl.animate([{opacity:0},{opacity:1}], {duration:dur(400), delay:i*70+80, easing:ease('ease-out'), fill:'both'}));
      _animFill(0, dur(800), true);
    } else {
      // draw: line draws, dots and vals pop as line reaches each point
      const drawDur = dur(1100);
      _drawPath(0);
      _animFill(0, drawDur);
      _dotsWithLine(0, drawDur);
    }

  } else if (cd.chartType === 'radar') {
    const poly = svg.querySelector('[data-radar-path]');
    const dots = [...svg.querySelectorAll('[data-radar-dot]')];
    if (poly) {
      poly.style.transformBox = 'view-box';
      poly.style.transformOrigin = '175px 145px';
      if (anim === 'fade') {
        poly.animate([{opacity:0},{opacity:1}], {duration:dur(800), easing:ease('ease-out'), fill:'both'});
      } else {
        poly.animate(
          [{transform:'scale(0)',opacity:0},{transform:'scale(1)',opacity:1}],
          {duration:dur(800), easing:ease('cubic-bezier(0.34,1.2,0.64,1)'), fill:'both'}
        );
      }
    }
    dots.forEach((dot, i) => {
      dot.style.transformBox = 'fill-box';
      dot.style.transformOrigin = '50% 50%';
      dot.animate(
        [{transform:'scale(0)',opacity:0},{transform:'scale(1)',opacity:1}],
        {duration:dur(300), delay:600+i*60, easing:ease('cubic-bezier(0.34,1.5,0.64,1)'), fill:'both'}
      );
    });

  } else if (cd.chartType === 'pie' || cd.chartType === 'donut') {
    svg.querySelectorAll('[data-slice]').forEach((slice, i) => {
      const cx = parseFloat(slice.dataset.cx || CHART_PIE_CX);
      const cy = parseFloat(slice.dataset.cy || CHART_PIE_CY);
      slice.style.transformBox = 'view-box';
      slice.style.transformOrigin = `${cx}px ${cy}px`;
      const delay = anim === 'burst' ? 0 : i * 130;
      slice.animate(
        [{transform:'scale(0)',opacity:0},{transform:'scale(1)',opacity:1}],
        {duration:dur(500), delay, easing:ease('cubic-bezier(0.34,1.25,0.64,1)'), fill:'both'}
      );
    });
  }
}

function _preHideChartEls(el, cd) {
  const svg = el.querySelector('svg');
  if (!svg) return;
  const anim = cd.animStyle || 'cascade';

  if (cd.chartType === 'bar') {
    svg.querySelectorAll('[data-bar]').forEach(bar => {
      bar.style.transformBox = 'fill-box';
      bar.style.transformOrigin = '50% 100%';
      bar.style.transform = 'scaleY(0)';
      bar.style.opacity = '0';
    });
  } else if (cd.chartType === 'hbar') {
    svg.querySelectorAll('[data-hbar]').forEach(bar => {
      bar.style.transformBox = 'fill-box';
      bar.style.transformOrigin = '0% 50%';
      bar.style.transform = 'scaleX(0)';
      bar.style.opacity = '0';
    });
  } else if (cd.chartType === 'line' || cd.chartType === 'area') {
    const isArea = cd.chartType === 'area';
    const path = svg.querySelector(isArea ? '[data-area-path]' : '[data-line-path]');
    const dots = svg.querySelectorAll(isArea ? '[data-area-dot]' : '[data-dot]');
    if (path) {
      if (anim === 'fade') {
        path.style.opacity = '0';
      } else {
        const len = path.getTotalLength();
        path.style.strokeDasharray = len;
        path.style.strokeDashoffset = len;
      }
    }
    if (cd.animateDots !== false) {
      dots.forEach(dot => {
        dot.style.transformBox = 'fill-box';
        dot.style.transformOrigin = '50% 50%';
        if (anim === 'rise') {
          dot.style.transform = 'translateY(28px)';
          dot.style.opacity = '0';
        } else {
          dot.style.transform = 'scale(0)';
          dot.style.opacity = '0';
        }
      });
    }
    if (cd.animateValues !== false) {
      svg.querySelectorAll('[data-val]').forEach(vl => { vl.style.opacity = '0'; });
    }
    const fillAttr = isArea ? '[data-area-fill]' : '[data-line-fill]';
    const fillPath = svg.querySelector(fillAttr);
    if (fillPath) {
      if (anim === 'fade') {
        fillPath.style.opacity = '0';
      } else {
        fillPath.style.clipPath = 'inset(0 100% 0 0)';
      }
    }
  } else if (cd.chartType === 'radar') {
    const poly = svg.querySelector('[data-radar-path]');
    const dots = svg.querySelectorAll('[data-radar-dot]');
    if (poly) {
      poly.style.transformBox = 'view-box';
      poly.style.transformOrigin = '175px 145px';
      if (anim === 'fade') {
        poly.style.opacity = '0';
      } else {
        poly.style.transform = 'scale(0)';
        poly.style.opacity = '0';
      }
    }
    dots.forEach(dot => {
      dot.style.transformBox = 'fill-box';
      dot.style.transformOrigin = '50% 50%';
      dot.style.transform = 'scale(0)';
      dot.style.opacity = '0';
    });
  } else if (cd.chartType === 'pie' || cd.chartType === 'donut') {
    svg.querySelectorAll('[data-slice]').forEach(slice => {
      const cx = parseFloat(slice.dataset.cx || CHART_PIE_CX);
      const cy = parseFloat(slice.dataset.cy || CHART_PIE_CY);
      slice.style.transformBox = 'view-box';
      slice.style.transformOrigin = `${cx}px ${cy}px`;
      slice.style.transform = 'scale(0)';
      slice.style.opacity = '0';
    });
  }
}

function createElementData(type, x, y) {
  const isLine = LINE_TYPES.has(type);
  const defaults = {
    id: generateId(),
    type,
    x, y,
    w: type === 'text' ? 200 : 160,
    h: type === 'text' ? 60 : isLine ? 20 : 120,
    fill: (type === 'text' || isLine) ? 'transparent' : '#4a90d9',
    fillNone: type === 'text' || isLine,
    stroke: '#000000',
    strokeNone: type === 'text',
    strokeWidth: isLine ? 3 : 2,
    strokeStyle: 'solid',
    opacity: 100,
    text: type === 'text' ? 'テキスト' : '',
    fontSize: 24,
    fontFamily: "'Noto Sans JP', sans-serif",
    color: '#ffffff',
    textAlign: 'center',
    fontWeight: 'normal',
    fontStyle: 'normal',
    underline: '',
    highlightColor: '',
    zIndex: getCurrentSlideData().elements.length + 1,
    src: '',
    textStroke: false,
    textStrokeColor: '#000000',
    textStrokeWidth: 2,
    textStroke2: false,
    textStroke2Color: '#ffffff',
    textStroke2Width: 4,
    textShadow: false,
    textShadowColor: '#000000',
    textShadowX: 2,
    textShadowY: 2,
    textShadowBlur: 4,
    text3D: false,
    text3DColor: '#888888',
    text3DDepth: 4,
    textOpacity: 100,
    listStyle: null,
    fillOpacity: 100,
    strokeOpacity: 100,
    adj: 0.5,
    points: null,
    rotate: 0,
    flipH: false,
    flipV: false,
  };
  if (type === 'circle' || type === 'pentagon' || type === 'hexagon' || type === 'octagon') {
    defaults.w = 120; defaults.h = 120;
  }
  if (type === 'image') {
    defaults.fill = 'transparent'; defaults.fillNone = true;
    defaults.stroke = 'none'; defaults.strokeNone = true;
    defaults.w = 300; defaults.h = 200;
  }
  if (type === 'table') {
    defaults.fillNone = true; defaults.strokeNone = true;
    defaults.w = 480; defaults.h = 200;
    defaults.rows = 3; defaults.cols = 4;
    defaults.rowHeights = [40, 40, 40];
    defaults.colWidths = [120, 120, 120, 120];
    const cells = [];
    for (let r = 0; r < 3; r++) {
      const row = [];
      for (let c = 0; c < 4; c++) {
        row.push(createTableCellData({
        }));
      }
      cells.push(row);
    }
    defaults.cells = cells;
  }
  if (type === 'chart') {
    defaults.fillNone = true; defaults.strokeNone = true;
    defaults.w = 420; defaults.h = 280;
    defaults.chartData = {
      chartType: 'bar', title: '',
      series: [{label:'Q1',value:42},{label:'Q2',value:78},{label:'Q3',value:56},{label:'Q4',value:91}],
      colors: null, palette: 'default',
      showValues: true, showGrid: true, showLegend: true,
      animStyle: 'cascade', lineWidth: 2.5, barRadius: 3,
      axisYMin: null, axisYMax: null, axisColor: '#313244', axisLabelColor: '#6c7086', axisLabelSize: 9,
      markerShape: 'circle', markerSize: 5,
      plotBgColor: '', gridOpacity: 7,
      showBorder: false, borderColor: '#45475a', borderWidth: 1, borderRx: 6,
      animDuration: 0, animEasing: 'auto',
      lineFill: true, animateDots: true, animateValues: true,
    };
  }
  return defaults;
}

// ===== キャンバスクリック（要素追加） =====
// ダブルクリック検出（DOM再構築後も確実に動作する独自実装）
const _dblClick = { id: null, time: 0 };

function startRubberBandSelection(e) {
  const startClientX = e.clientX;
  const startClientY = e.clientY;
  const canvasRect = canvas.getBoundingClientRect();
  const startX = (startClientX - canvasRect.left) / state.scale;
  const startY = (startClientY - canvasRect.top) / state.scale;

  let rubberBand = null;
  let hasMoved = false;

  const onMove = (ev) => {
    const dx = ev.clientX - startClientX;
    const dy = ev.clientY - startClientY;
    if (!hasMoved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      hasMoved = true;
      rubberBand = document.createElement('div');
      rubberBand.style.cssText = 'position:fixed;border:1.5px dashed #4a90d9;background:rgba(74,144,217,0.1);pointer-events:none;z-index:9999;box-sizing:border-box;';
      document.body.appendChild(rubberBand);
    }
    if (!hasMoved) return;
    const x1 = Math.min(startClientX, ev.clientX);
    const y1 = Math.min(startClientY, ev.clientY);
    rubberBand.style.left   = x1 + 'px';
    rubberBand.style.top    = y1 + 'px';
    rubberBand.style.width  = Math.abs(ev.clientX - startClientX) + 'px';
    rubberBand.style.height = Math.abs(ev.clientY - startClientY) + 'px';
  };

  const onUp = (ev) => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (rubberBand) rubberBand.remove();

    if (!hasMoved) {
      if (!e.ctrlKey) {
        clearSelection();
        renderAll();
      }
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const endX = (ev.clientX - rect.left) / state.scale;
    const endY = (ev.clientY - rect.top) / state.scale;
    const selX = Math.min(startX, endX);
    const selY = Math.min(startY, endY);
    const selW = Math.abs(endX - startX);
    const selH = Math.abs(endY - startY);

    const slide = getCurrentSlideData();
    const inRect = slide.elements.filter(el =>
      el.x < selX + selW && el.x + el.w > selX &&
      el.y < selY + selH && el.y + el.h > selY
    );

    if (e.ctrlKey) {
      inRect.forEach(el => state.selectedElements.add(el.id));
      if (inRect.length > 0) state.selectedElement = inRect[inRect.length - 1].id;
    } else {
      state.selectedElements = new Set(inRect.map(el => el.id));
      state.selectedElement = inRect.length > 0 ? inRect[inRect.length - 1].id : null;
    }

    renderAll();
    updatePropertiesPanel();
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// canvas-areaの外側（グレー背景）からもドラッグ選択を開始できるようにする
canvasWrapper.parentElement.addEventListener('mousedown', (e) => {
  if (e.target !== canvasWrapper.parentElement) return;
  if (state.activeTool !== 'select') return;
  if (editingElementId) finishInlineEditData();
  startRubberBandSelection(e);
});

canvas.addEventListener('mousedown', (e) => {
  if (e.target !== canvas && e.target.closest('.slide-element')) return;
  if (editingElementId) finishInlineEditData();

  if (state.activeTool === 'select') {
    startRubberBandSelection(e);
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / state.scale;
  const y = (e.clientY - rect.top) / state.scale;

  if (state.activeTool === 'freehand') {
    const pts = [{ x, y }];
    let previewEl = null;
    const onMove = (ev) => {
      const r = canvas.getBoundingClientRect();
      pts.push({ x: (ev.clientX - r.left) / state.scale, y: (ev.clientY - r.top) / state.scale });
      if (!previewEl) {
        previewEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        previewEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:9999;';
        canvas.appendChild(previewEl);
      }
      let path = previewEl.querySelector('path');
      if (!path) { path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('fill','none'); path.setAttribute('stroke','#4a90d9'); previewEl.appendChild(path); }
      path.setAttribute('stroke-width', 2 / state.scale);
      path.setAttribute('d', pts.map((p,i)=>`${i===0?'M':'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (previewEl) previewEl.remove();
      if (pts.length < 2) return;
      const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const maxX = Math.max(...xs), maxY = Math.max(...ys);
      const w = Math.max(maxX - minX, 10), h = Math.max(maxY - minY, 10);
      const data = createElementData('freehand', Math.round(minX), Math.round(minY));
      data.w = Math.round(w); data.h = Math.round(h);
      data.points = pts.map(p => ({ x: ((p.x-minX)/w)*100, y: ((p.y-minY)/h)*100 }));
      data.strokeNone = false; data.stroke = '#000000'; data.strokeWidth = 3;
      getCurrentSlideData().elements.push(data);
      state.selectedElement = data.id; state.selectedElements = new Set([data.id]);
      selectTool('select'); renderAll(); updatePropertiesPanel();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return;
  }

  if (state.activeTool === 'polyline' || state.activeTool === 'curve') {
    const tool = state.activeTool;
    if (!drawingState) {
      drawingState = { pts: [{ x: Math.round(x), y: Math.round(y) }], tool };
      const previewEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      previewEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;z-index:9999;';
      canvas.appendChild(previewEl);
      drawingState.preview = previewEl;
      const onMovePoly = (ev) => {
        if (!drawingState) return;
        const r = canvas.getBoundingClientRect();
        updatePolylinePreview(drawingState.pts.concat([{ x:(ev.clientX-r.left)/state.scale, y:(ev.clientY-r.top)/state.scale }]), tool, previewEl);
      };
      document.addEventListener('mousemove', onMovePoly);
      drawingState.onMovePoly = onMovePoly;
    } else {
      const newPt = { x: Math.round(x), y: Math.round(y) };
      const last = drawingState.pts[drawingState.pts.length - 1];
      if (Math.abs(newPt.x - last.x) < 6 && Math.abs(newPt.y - last.y) < 6) {
        finishPolyline();
      } else {
        drawingState.pts.push(newPt);
        updatePolylinePreview(drawingState.pts, tool, drawingState.preview);
      }
    }
    return;
  }

  pushHistory();
  const data = createElementData(state.activeTool, Math.round(x - 80), Math.round(y - 40));
  getCurrentSlideData().elements.push(data);
  state.selectedElement = data.id;
  state.selectedElements = new Set([data.id]);
  selectTool('select');
  renderAll();
  updatePropertiesPanel();
});

// ===== スマートガイド（スナップ） =====
const SNAP_THRESHOLD = 6;

function applySmartSnap(rawDx, rawDy, primaryData, initPrimaryPos) {
  const slide = getCurrentSlideData();
  const SW = state.slideWidth;
  const SH = computeSlideHeight(slide);

  const rawX = initPrimaryPos.x + rawDx;
  const rawY = initPrimaryPos.y + rawDy;
  const w = primaryData.w;
  const h = primaryData.h;

  // スナップ候補: スライド境界 + 他の要素のエッジ/中心
  const xTargets = [0, SW / 2, SW];
  const yTargets = [0, SH / 2, SH];
  slide.elements.forEach(el => {
    if (state.selectedElements.has(el.id)) return;
    xTargets.push(el.x, el.x + el.w / 2, el.x + el.w);
    yTargets.push(el.y, el.y + el.h / 2, el.y + el.h);
  });

  // ドラッグ要素のキー座標 (左/中央/右, 上/中央/下)
  const elemXs = [rawX, rawX + w / 2, rawX + w];
  const elemYs = [rawY, rawY + h / 2, rawY + h];

  let snapDX = 0, snapDY = 0;
  let guideXs = [], guideYs = [];
  let minDX = SNAP_THRESHOLD + 1, minDY = SNAP_THRESHOLD + 1;

  for (const ex of elemXs) {
    for (const tx of xTargets) {
      const d = Math.abs(ex - tx);
      if (d < minDX) { minDX = d; snapDX = tx - ex; guideXs = [tx]; }
    }
  }
  for (const ey of elemYs) {
    for (const ty of yTargets) {
      const d = Math.abs(ey - ty);
      if (d < minDY) { minDY = d; snapDY = ty - ey; guideYs = [ty]; }
    }
  }
  if (minDX > SNAP_THRESHOLD) { snapDX = 0; guideXs = []; }
  if (minDY > SNAP_THRESHOLD) { snapDY = 0; guideYs = []; }

  const svg = document.getElementById('smart-guide-svg');
  if (svg) {
    svg.setAttribute('viewBox', `0 0 ${SW} ${SH}`);
    let html = '';
    guideXs.forEach(x => {
      html += `<line x1="${x}" y1="0" x2="${x}" y2="${SH}" stroke="#ff3b5f" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    });
    guideYs.forEach(y => {
      html += `<line x1="0" y1="${y}" x2="${SW}" y2="${y}" stroke="#ff3b5f" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    });
    svg.innerHTML = html;
  }

  return { snapDX, snapDY };
}

function clearSmartGuides() {
  const svg = document.getElementById('smart-guide-svg');
  if (svg) svg.innerHTML = '';
}

// ===== ドラッグ（移動） =====
function onElementMouseDown(e) {
  if (e.target.classList.contains('resize-handle')) return;

  const el = e.currentTarget;
  const id = el.dataset.id;

  // Ctrl+クリック: 複数選択のトグル
  if (e.ctrlKey && state.activeTool === 'select') {
    e.preventDefault();
    e.stopPropagation();
    if (editingElementId) finishInlineEditData();
    if (state.selectedElements.has(id)) {
      state.selectedElements.delete(id);
      if (state.selectedElement === id) {
        const remaining = [...state.selectedElements];
        state.selectedElement = remaining.length > 0 ? remaining[remaining.length - 1] : null;
      }
    } else {
      state.selectedElements.add(id);
      state.selectedElement = id;
    }
    renderAll();
    updatePropertiesPanel();
    return;
  }

  // ダブルクリック検出（renderAll()でDOM再構築されても動作）
  const now = Date.now();
  const isDbl = now - _dblClick.time < 350 && _dblClick.id === id;
  _dblClick.id = id;
  _dblClick.time = now;
  if (isDbl) {
    _dblClick.time = 0;
    e.preventDefault();
    e.stopPropagation();
    const dblData = getElementData(id);
    if (dblData && dblData.type === 'group') {
      // グループ編集モードに入る
      state.editingGroupId = id;
      state.selectedElement = null;
      state.selectedElements = new Set();
      renderAll();
      updatePropertiesPanel();
    } else if (editingElementId !== id) {
      const domEl = canvas.querySelector(`[data-id="${id}"]`) || el;
      if (dblData) startInlineEdit(dblData, domEl);
    }
    return;
  }

  if (editingElementId === id) return;
  if (editingElementId) finishInlineEditData();

  e.preventDefault();
  e.stopPropagation();

  // グループ編集モード中: 別要素クリックで退場
  if (state.editingGroupId) {
    const slide = getCurrentSlideData();
    const grp = slide.elements.find(ge => ge.id === state.editingGroupId);
    const isChild = grp && grp.elements && grp.elements.some(c => c.id === id);
    if (!isChild) state.editingGroupId = null;
  }

  // 選択グループ外をクリック → グループをリセット
  if (!state.selectedElements.has(id)) {
    state.selectedElements = new Set([id]);
    state.selectedElement = id;
    renderAll();
  } else if (state.selectedElement !== id) {
    state.selectedElement = id;
    renderAll();
  }
  updatePropertiesPanel();

  if (state.activeTool !== 'select') return;

  const data = getElementData(id);
  if (!data) return;
  const rect = canvas.getBoundingClientRect();
  state.isDragging = true;

  const startMouseX = (e.clientX - rect.left) / state.scale;
  const startMouseY = (e.clientY - rect.top) / state.scale;

  // 選択中の全要素の初期座標を保存
  const initialPositions = new Map();
  state.selectedElements.forEach(selId => {
    const selData = getElementData(selId);
    if (selData) initialPositions.set(selId, { x: selData.x, y: selData.y });
  });

  let _dragHistoryPushed = false;
  const onMove = (ev) => {
    if (!state.isDragging) return;
    if (!_dragHistoryPushed) { pushHistory(); _dragHistoryPushed = true; }
    const rect = canvas.getBoundingClientRect();
    const rawDx = (ev.clientX - rect.left) / state.scale - startMouseX;
    const rawDy = (ev.clientY - rect.top) / state.scale - startMouseY;

    const initPrimary = initialPositions.get(id);
    const { snapDX, snapDY } = applySmartSnap(rawDx, rawDy, data, initPrimary);
    const dx = Math.round(rawDx + snapDX);
    const dy = Math.round(rawDy + snapDY);

    state.selectedElements.forEach(selId => {
      const selData = getElementData(selId);
      const init = initialPositions.get(selId);
      if (selData && init) {
        selData.x = init.x + dx;
        selData.y = init.y + dy;
        const domEl = canvas.querySelector(`[data-id="${selId}"]`);
        if (domEl) {
          domEl.style.left = selData.x + 'px';
          domEl.style.top = selData.y + 'px';
        }
      }
    });

    updatePosInputs(data);
    renderThumbnails();
  };

  const onUp = () => {
    state.isDragging = false;
    clearSmartGuides();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ===== リサイズ =====
function onResizeMouseDown(e) {
  if (editingElementId) finishInlineEditData();
  e.preventDefault();
  e.stopPropagation();
  pushHistory();

  const dir = e.target.dataset.dir;
  const id = e.target.closest('.slide-element').dataset.id;
  const data = getElementData(id);

  const startX = e.clientX;
  const startY = e.clientY;
  const startData = { ...data };

  const aspectRatio = startData.w / startData.h;

  const onMove = (ev) => {
    const dx = (ev.clientX - startX) / state.scale;
    const dy = (ev.clientY - startY) / state.scale;
    const minSize = 10;
    const lock = state.lockAspect;

    if (dir.includes('e')) data.w = Math.max(minSize, Math.round(startData.w + dx));
    if (dir.includes('s')) data.h = Math.max(minSize, Math.round(startData.h + dy));
    if (dir.includes('w')) {
      const newW = Math.max(minSize, Math.round(startData.w - dx));
      data.x = Math.round(startData.x + startData.w - newW);
      data.w = newW;
    }
    if (dir.includes('n')) {
      const newH = Math.max(minSize, Math.round(startData.h - dy));
      data.y = Math.round(startData.y + startData.h - newH);
      data.h = newH;
    }

    if (lock && dir !== 'n' && dir !== 's' && dir !== 'e' && dir !== 'w') {
      // Corner drag: use the larger of w/h change to drive both
      const wRatio = data.w / startData.w;
      const hRatio = data.h / startData.h;
      const scale = Math.max(wRatio, hRatio);
      data.w = Math.max(minSize, Math.round(startData.w * scale));
      data.h = Math.max(minSize, Math.round(startData.h * scale));
      if (dir.includes('w')) data.x = Math.round(startData.x + startData.w - data.w);
      if (dir.includes('n')) data.y = Math.round(startData.y + startData.h - data.h);
    } else if (lock && (dir === 'e' || dir === 'w')) {
      data.h = Math.max(minSize, Math.round(data.w / aspectRatio));
      if (dir === 'w') data.x = Math.round(startData.x + startData.w - data.w);
    } else if (lock && (dir === 's' || dir === 'n')) {
      data.w = Math.max(minSize, Math.round(data.h * aspectRatio));
      if (dir === 'n') data.y = Math.round(startData.y + startData.h - data.h);
    }

    const domEl = canvas.querySelector(`[data-id="${id}"]`);
    if (domEl) {
      domEl.style.left = data.x + 'px';
      domEl.style.top = data.y + 'px';
      domEl.style.width = data.w + 'px';
      domEl.style.height = data.h + 'px';
      if (domEl.dataset.svgLine) {
        // SVG直線は再描画
      }
    }
    updatePosInputs(data);
    renderThumbnails();
  };

  const onUp = () => {
    renderAll();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ===== 要素データ取得 =====
function getElementData(id) {
  const slide = getCurrentSlideData();
  const top = slide.elements.find(el => el.id === id);
  if (top) return top;
  if (state.editingGroupId) {
    const grp = slide.elements.find(el => el.id === state.editingGroupId);
    if (grp && grp.elements) return grp.elements.find(el => el.id === id) || null;
  }
  return null;
}

// ===== インラインテキスト編集 =====
function finishInlineEditData() {
  if (!editingElementId) return;
  const id = editingElementId;
  editingElementId = null;
  const data = getElementData(id);
  const domEl = canvas.querySelector(`[data-id="${id}"]`);
  if (data && domEl) {
    const inner = domEl.querySelector('.element-inner');
    if (inner) {
      data.text = inner.innerText || '';
      inner.contentEditable = 'false';
      inner.style.userSelect = '';
      inner.style.cursor = '';
      inner.style.outline = '';
      inner.style.pointerEvents = data && data.type !== 'text' ? 'none' : '';
    }
    domEl.style.cursor = '';
  }
}

function finishInlineEdit() {
  finishInlineEditData();
  renderAll();
}

function startInlineEdit(data, domEl) {
  if (!data || data.type === 'image' || data.type === 'table' || LINE_TYPES.has(data.type)) return;
  if (editingElementId) finishInlineEditData();
  const inner = domEl.querySelector('.element-inner');
  if (!inner) return;
  editingElementId = data.id;
  inner.textContent = data.text || '';
  inner.contentEditable = 'true';
  inner.style.cursor = 'text';
  inner.style.userSelect = 'text';
  inner.style.outline = 'none';
  inner.style.pointerEvents = 'auto';
  domEl.style.cursor = 'text';
  inner.addEventListener('blur', finishInlineEdit, { once: true });
  requestAnimationFrame(() => {
    if (editingElementId !== data.id) return;
    inner.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(inner);
      range.collapse(false);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    } catch (_) {}
  });
}

// ===== フォーマットタブ表示制御 =====
function showFormatTab() {
  const tab = document.getElementById('tab-format');
  if (!tab) return;
  tab.style.display = '';
  // タブを表示するだけ。自動切り替えはしない（ユーザーが手動で選択）
}

function hideFormatTab() {
  const tab = document.getElementById('tab-format');
  if (!tab) return;
  tab.style.display = 'none';
  if (tab.classList.contains('active')) {
    tab.classList.remove('active');
    document.querySelectorAll('.ribbon-pane').forEach(p => p.classList.remove('active'));
    const homeTab = document.querySelector('.ribbon-tab[data-tab="home"]');
    const homePane = document.querySelector('.ribbon-pane[data-pane="home"]');
    if (homeTab) homeTab.classList.add('active');
    if (homePane) homePane.classList.add('active');
  }
}

function showTableFormatTab() {
  const tab = document.getElementById('tab-table-format');
  if (tab) tab.style.display = '';
}

function hideTableFormatTab() {
  const tab = document.getElementById('tab-table-format');
  if (!tab) return;
  tab.style.display = 'none';
  if (tab.classList.contains('active')) {
    tab.classList.remove('active');
    document.querySelectorAll('.ribbon-pane').forEach(p => p.classList.remove('active'));
    const homeTab = document.querySelector('.ribbon-tab[data-tab="home"]');
    const homePane = document.querySelector('.ribbon-pane[data-pane="home"]');
    if (homeTab) homeTab.classList.add('active');
    if (homePane) homePane.classList.add('active');
  }
}

// ===== プロパティパネル更新 =====
function updatePropertiesPanel() {
  if (!state.selectedElement) {
    syncFontRibbon(null);
    hideFormatTab();
    hideTableFormatTab();
    return;
  }

  const data = getElementData(state.selectedElement);
  if (!data) { hideFormatTab(); hideTableFormatTab(); return; }

  document.getElementById('prop-x').value = data.x;
  document.getElementById('prop-y').value = data.y;
  document.getElementById('prop-w').value = data.w;
  document.getElementById('prop-h').value = data.h;
  const isImg   = data.type === 'image';
  const isChart = data.type === 'chart';
  const isLine  = LINE_TYPES.has(data.type);
  const isGrp   = data.type === 'group';
  const isTable = data.type === 'table';

  if (isTable) {
    // 表選択時: 図形の書式は位置/サイズのみ、表の書式タブを表示
    const rowFill = document.getElementById('row-fill');
    const rowStrokeStyle = document.getElementById('row-stroke-style');
    if (rowFill) rowFill.style.display = 'none';
    if (rowStrokeStyle) rowStrokeStyle.style.display = 'none';
    syncFontRibbon(null);
    showFormatTab();
    showTableFormatTab();
    updateTableFormatRibbon();
    const propRotate = document.getElementById('prop-rotate');
    if (propRotate) propRotate.value = data.rotate || 0;
    return;
  }

  hideTableFormatTab();

  // グループ選択時は最初の非画像子要素の値を参照して表示
  const fillRef = isGrp
    ? (data.elements || []).find(c => c.type !== 'image' && !LINE_TYPES.has(c.type)) || data
    : data;
  document.getElementById('prop-fill').value = fillRef.fill || '#4a90d9';
  const fillPrev = document.getElementById('prop-fill-preview');
  if (fillPrev) fillPrev.style.background = fillRef.fillNone ? 'transparent' : (fillRef.fill || '#4a90d9');
  document.getElementById('prop-stroke').value = fillRef.stroke || '#000000';
  const strokePrev = document.getElementById('prop-stroke-preview');
  if (strokePrev) strokePrev.style.background = fillRef.strokeNone ? 'transparent' : (fillRef.stroke || '#000000');
  document.getElementById('prop-stroke-width').value = fillRef.strokeWidth ?? 0;
  document.getElementById('prop-stroke-style').value = fillRef.strokeStyle || 'solid';
  syncFontRibbon(isGrp ? null : data);

  const rowFill = document.getElementById('row-fill');
  const fillColorRow = document.getElementById('fill-color-row');
  const rowStrokeStyle = document.getElementById('row-stroke-style');
  if (rowFill) rowFill.style.display = (isImg || isChart) ? 'none' : '';
  if (fillColorRow) fillColorRow.style.display = (isImg || isChart || isLine) ? 'none' : '';
  if (rowStrokeStyle) rowStrokeStyle.style.display = (isImg || isChart) ? 'none' : '';

  const propRotate = document.getElementById('prop-rotate');
  if (propRotate) propRotate.value = data.rotate || 0;
  const btnFlipH = document.getElementById('btn-flip-h');
  const btnFlipV = document.getElementById('btn-flip-v');
  if (btnFlipH) btnFlipH.classList.toggle('active', !!data.flipH);
  if (btnFlipV) btnFlipV.classList.toggle('active', !!data.flipV);

  showFormatTab();
}

function updatePosInputs(data) {
  document.getElementById('prop-x').value = data.x;
  document.getElementById('prop-y').value = data.y;
  document.getElementById('prop-w').value = data.w;
  document.getElementById('prop-h').value = data.h;
}

// ===== プロパティ変更ハンドラ =====
let _propHistoryTimer = null;
function onPropChange() {
  if (!state.selectedElement) return;
  const data = getElementData(state.selectedElement);
  if (!data) return;

  if (!_propHistoryTimer) pushHistory();
  clearTimeout(_propHistoryTimer);
  _propHistoryTimer = setTimeout(() => { _propHistoryTimer = null; }, 800);

  if (editingElementId) finishInlineEditData();

  // 位置・サイズはプライマリ要素のみ
  data.x = parseInt(document.getElementById('prop-x').value) || 0;
  data.y = parseInt(document.getElementById('prop-y').value) || 0;
  data.w = parseInt(document.getElementById('prop-w').value) || 10;
  data.h = parseInt(document.getElementById('prop-h').value) || 10;

  // 塗りつぶし・枠線は複数選択の全要素に適用
  const fill        = document.getElementById('prop-fill').value;
  const stroke      = document.getElementById('prop-stroke').value;
  const strokeWidth = parseFloat(document.getElementById('prop-stroke-width').value) || 0;
  const strokeStyle = document.getElementById('prop-stroke-style').value;

  const applyFillStroke = (d) => {
    if (d.type === 'group') {
      (d.elements || []).forEach(child => {
        if (child.type !== 'image') {
          child.fill = fill; child.fillNone = false;
          child.stroke = stroke; child.strokeNone = false;
          child.strokeWidth = strokeWidth; child.strokeStyle = strokeStyle;
        }
      });
    } else {
      d.fill = fill; d.stroke = stroke;
      d.strokeWidth = strokeWidth; d.strokeStyle = strokeStyle;
    }
  };

  state.selectedElements.forEach(id => {
    const d = getElementData(id);
    if (d) applyFillStroke(d);
  });

  renderAll();
}

// ===== プロパティパネルのイベント登録 =====
const propIds = [
  'prop-x','prop-y',
  'prop-fill',
  'prop-stroke','prop-stroke-width','prop-stroke-style',
];
propIds.forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('input', onPropChange);
  el.addEventListener('change', onPropChange);
});

// w/h inputs: support aspect ratio lock
['prop-w','prop-h'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('change', () => {
    if (!state.selectedElement) return;
    const data = getElementData(state.selectedElement);
    if (!data) return;
    const newW = parseInt(document.getElementById('prop-w').value) || 10;
    const newH = parseInt(document.getElementById('prop-h').value) || 10;
    if (state.lockAspect) {
      const ratio = data.w / data.h;
      if (id === 'prop-w') {
        data.w = Math.max(10, newW);
        data.h = Math.max(10, Math.round(data.w / ratio));
        document.getElementById('prop-h').value = data.h;
      } else {
        data.h = Math.max(10, newH);
        data.w = Math.max(10, Math.round(data.h * ratio));
        document.getElementById('prop-w').value = data.w;
      }
    } else {
      data.w = Math.max(10, newW);
      data.h = Math.max(10, newH);
    }
    renderAll();
  });
});

// 縦横比ロックボタン
document.getElementById('btn-lock-aspect').addEventListener('click', () => {
  state.lockAspect = !state.lockAspect;
  document.getElementById('btn-lock-aspect').classList.toggle('active', state.lockAspect);
});

// プロパティパネルのスウォッチボタン
document.getElementById('prop-fill-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const data = state.selectedElement ? getElementData(state.selectedElement) : null;
  showPptColorPicker(e.currentTarget, (c) => {
    if (!state.selectedElement) return;
    pushHistory();
    state.selectedElements.forEach(id => {
      const d = getElementData(id);
      if (!d) return;
      if (c === null) { d.fillNone = true; }
      else { d.fill = c; d.fillNone = false; }
    });
    if (c === null) {
      document.getElementById('prop-fill-preview').style.background = 'transparent';
    } else {
      document.getElementById('prop-fill').value = c;
      document.getElementById('prop-fill-preview').style.background = c;
    }
    renderAll();
  }, {
    showNone: true, noneLabel: '塗りつぶし無し',
    showOpacity: true, initialOpacity: data ? (data.fillOpacity ?? 100) : 100,
    onOpacityChange: (v) => {
      if (!state.selectedElement) return;
      state.selectedElements.forEach(id => {
        const d = getElementData(id);
        if (d) d.fillOpacity = v;
      });
      renderAll();
    },
  });
});

document.getElementById('prop-stroke-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const data = state.selectedElement ? getElementData(state.selectedElement) : null;
  showPptColorPicker(e.currentTarget, (c) => {
    if (!state.selectedElement) return;
    pushHistory();
    state.selectedElements.forEach(id => {
      const d = getElementData(id);
      if (!d) return;
      if (c === null) { d.strokeNone = true; }
      else { d.stroke = c; d.strokeNone = false; }
    });
    if (c === null) {
      document.getElementById('prop-stroke-preview').style.background = 'transparent';
    } else {
      document.getElementById('prop-stroke').value = c;
      document.getElementById('prop-stroke-preview').style.background = c;
    }
    renderAll();
  }, {
    showNone: true, noneLabel: '枠線なし',
    showOpacity: true, initialOpacity: data ? (data.strokeOpacity ?? 100) : 100,
    onOpacityChange: (v) => {
      if (!state.selectedElement) return;
      state.selectedElements.forEach(id => {
        const d = getElementData(id);
        if (d) d.strokeOpacity = v;
      });
      renderAll();
    },
  });
});

// ===== 重なり順 =====
function _reorderElement(elements, id, op) {
  const sorted = [...elements].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
  const idx = sorted.findIndex(e => e.id === id);
  if (idx === -1) return;
  if (op === 'front') {
    const [item] = sorted.splice(idx, 1);
    sorted.push(item);
  } else if (op === 'back') {
    const [item] = sorted.splice(idx, 1);
    sorted.unshift(item);
  } else if (op === 'forward' && idx < sorted.length - 1) {
    [sorted[idx], sorted[idx + 1]] = [sorted[idx + 1], sorted[idx]];
  } else if (op === 'backward' && idx > 0) {
    [sorted[idx], sorted[idx - 1]] = [sorted[idx - 1], sorted[idx]];
  }
  sorted.forEach((e, i) => { e.zIndex = i + 1; });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('#btn-order-front,#btn-order-fwd,#btn-order-bwd,#btn-order-back');
  if (!btn || !state.selectedElement) return;
  pushHistory();
  let elements;
  if (state.editingGroupId) {
    const grp = getCurrentSlideData().elements.find(el => el.id === state.editingGroupId);
    elements = grp ? grp.elements : getCurrentSlideData().elements;
  } else {
    elements = getCurrentSlideData().elements;
  }
  const op = btn.id === 'btn-order-front' ? 'front' :
             btn.id === 'btn-order-fwd'   ? 'forward' :
             btn.id === 'btn-order-bwd'   ? 'backward' : 'back';
  _reorderElement(elements, state.selectedElement, op);
  renderAll();
});

// ===== 回転・反転ハンドラ =====
document.addEventListener('click', (e) => {
  const btn = e.target.closest('#btn-rotate-l,#btn-rotate-r,#btn-flip-h,#btn-flip-v');
  if (!btn || !state.selectedElement) return;
  pushHistory();
  state.selectedElements.forEach(selId => {
    const d = getElementData(selId);
    if (!d) return;
    if (btn.id === 'btn-rotate-l') d.rotate = ((d.rotate || 0) - 90 + 360) % 360;
    if (btn.id === 'btn-rotate-r') d.rotate = ((d.rotate || 0) + 90) % 360;
    if (btn.id === 'btn-flip-h')   d.flipH = !d.flipH;
    if (btn.id === 'btn-flip-v')   d.flipV = !d.flipV;
  });
  const primary = getElementData(state.selectedElement);
  const propRotate = document.getElementById('prop-rotate');
  if (propRotate && primary) propRotate.value = primary.rotate || 0;
  const btnFlipH = document.getElementById('btn-flip-h');
  const btnFlipV = document.getElementById('btn-flip-v');
  if (btnFlipH && primary) btnFlipH.classList.toggle('active', !!primary.flipH);
  if (btnFlipV && primary) btnFlipV.classList.toggle('active', !!primary.flipV);
  renderAll();
});

document.addEventListener('change', (e) => {
  if (e.target.id !== 'prop-rotate') return;
  if (!state.selectedElement) return;
  const val = ((parseInt(e.target.value) || 0) % 360 + 360) % 360;
  e.target.value = val;
  state.selectedElements.forEach(selId => {
    const d = getElementData(selId);
    if (d) d.rotate = val;
  });
  renderAll();
});

// ===== ツールバーのイベント =====
document.getElementById('btn-new-slide').addEventListener('click', addSlide);

function applySize() {
  const slide = getCurrentSlideData();
  state.slideWidth = parseInt(document.getElementById('slide-width').value) || 960;
  if (!slide.autoHeight) {
    state.slideHeight = parseInt(document.getElementById('slide-height').value) || 540;
  }
  renderAll();
}

document.getElementById('btn-apply-size').addEventListener('click', () => {
  applySize();
  document.getElementById('size-custom-popup').classList.remove('visible');
});

// ===== スライドの向き =====
document.getElementById('btn-landscape').addEventListener('click', () => {
  const slide = getCurrentSlideData();
  if (slide.autoHeight) return;
  const w = Math.max(state.slideWidth, state.slideHeight);
  const h = Math.min(state.slideWidth, state.slideHeight);
  state.slideWidth = w; state.slideHeight = h;
  document.getElementById('slide-width').value = w;
  document.getElementById('slide-height').value = h;
  document.getElementById('btn-landscape').classList.add('active');
  document.getElementById('btn-portrait').classList.remove('active');
  renderAll();
});

document.getElementById('btn-portrait').addEventListener('click', () => {
  const slide = getCurrentSlideData();
  if (slide.autoHeight) return;
  const w = Math.min(state.slideWidth, state.slideHeight);
  const h = Math.max(state.slideWidth, state.slideHeight);
  state.slideWidth = w; state.slideHeight = h;
  document.getElementById('slide-width').value = w;
  document.getElementById('slide-height').value = h;
  document.getElementById('btn-landscape').classList.remove('active');
  document.getElementById('btn-portrait').classList.add('active');
  renderAll();
});

// ===== デザインポップアップ =====
function showDesignPopup(anchorEl, popupId) {
  const popup = document.getElementById(popupId);
  document.querySelectorAll('.design-popup').forEach(p => {
    if (p.id !== popupId) p.classList.remove('visible');
  });
  if (popup.classList.contains('visible')) { popup.classList.remove('visible'); return; }
  popup.style.top = '-9999px'; popup.style.left = '-9999px';
  popup.classList.add('visible');
  const rect = anchorEl.getBoundingClientRect();
  const pr = popup.getBoundingClientRect();
  let top = rect.bottom + 4, left = rect.left;
  if (left + pr.width > window.innerWidth - 4) left = window.innerWidth - pr.width - 4;
  if (left < 4) left = 4;
  if (top + pr.height > window.innerHeight - 4) top = rect.top - pr.height - 4;
  if (top < 4) top = 4;
  popup.style.top = top + 'px'; popup.style.left = left + 'px';
}

document.addEventListener('click', e => {
  if (!e.target.closest('.design-popup') && !e.target.closest('#bg-template-btn') &&
      !e.target.closest('#btn-size-preset') && !e.target.closest('#btn-size-custom')) {
    document.querySelectorAll('.design-popup').forEach(p => p.classList.remove('visible'));
  }
});

// ===== 背景色 =====
document.getElementById('bg-color-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.querySelectorAll('.design-popup').forEach(p => p.classList.remove('visible'));
  showPptColorPicker(e.currentTarget, (c) => {
    if (c === null) return;
    document.getElementById('bg-color-preview').style.background = c;
    pushHistory();
    getCurrentSlideData().bgColor = c;
    renderAll();
  });
});

document.getElementById('bg-template-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('ppt-color-picker').classList.remove('visible');
  showDesignPopup(e.currentTarget, 'bg-template-popup');
});

document.querySelectorAll('.bg-tmpl-swatch').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    pushHistory();
    const slide = getCurrentSlideData();
    slide.bgColor = btn.dataset.bg;
    document.getElementById('bg-color-preview').style.background = btn.dataset.bg;
    document.querySelectorAll('.bg-tmpl-swatch').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('bg-template-popup').classList.remove('visible');
    renderAll();
  });
});

// ===== グリッド線・ガイド表示 =====
document.getElementById('chk-grid').addEventListener('change', (e) => {
  state.showGrid = e.target.checked;
  document.getElementById('grid-overlay').style.display = state.showGrid ? '' : 'none';
});
document.getElementById('chk-guide').addEventListener('change', (e) => {
  state.showGuide = e.target.checked;
  document.getElementById('guide-overlay').style.display = state.showGuide ? '' : 'none';
});

// ===== サイズプリセット =====
document.getElementById('btn-size-preset').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('ppt-color-picker').classList.remove('visible');
  showDesignPopup(e.currentTarget, 'size-preset-popup');
});

document.querySelectorAll('.dsp-item').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const w = parseInt(btn.dataset.w);
    const h = btn.dataset.h;
    const slide = getCurrentSlideData();
    if (h === 'auto') {
      state.slideWidth = w;
      slide.autoHeight = true;
      document.getElementById('slide-width').value = w;
      document.getElementById('slide-height').disabled = true;
      document.getElementById('slide-height-px').style.display = 'none';
      document.getElementById('slide-height-auto').style.display = '';
      document.getElementById('slide-auto-height').checked = true;
    } else {
      state.slideWidth = w;
      state.slideHeight = parseInt(h);
      slide.autoHeight = false;
      document.getElementById('slide-width').value = w;
      document.getElementById('slide-height').value = parseInt(h);
      document.getElementById('slide-height').disabled = false;
      document.getElementById('slide-height-px').style.display = '';
      document.getElementById('slide-height-auto').style.display = 'none';
      document.getElementById('slide-auto-height').checked = false;
      const isLandscape = w >= parseInt(h);
      document.getElementById('btn-landscape').classList.toggle('active', isLandscape);
      document.getElementById('btn-portrait').classList.toggle('active', !isLandscape);
    }
    document.querySelectorAll('.dsp-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('size-preset-popup').classList.remove('visible');
    renderAll();
  });
});

// ===== カスタムサイズポップアップ =====
document.getElementById('btn-size-custom').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('ppt-color-picker').classList.remove('visible');
  const slide = getCurrentSlideData();
  document.getElementById('slide-width').value = state.slideWidth;
  if (!slide.autoHeight) document.getElementById('slide-height').value = state.slideHeight;
  document.getElementById('slide-auto-height').checked = !!slide.autoHeight;
  document.getElementById('slide-height').disabled = !!slide.autoHeight;
  document.getElementById('slide-height-px').style.display = slide.autoHeight ? 'none' : '';
  document.getElementById('slide-height-auto').style.display = slide.autoHeight ? '' : 'none';
  showDesignPopup(e.currentTarget, 'size-custom-popup');
});

document.getElementById('slide-auto-height').addEventListener('change', (e) => {
  const slide = getCurrentSlideData();
  slide.autoHeight = e.target.checked;
  document.getElementById('slide-height').disabled = e.target.checked;
  document.getElementById('slide-height-px').style.display = e.target.checked ? 'none' : '';
  document.getElementById('slide-height-auto').style.display = e.target.checked ? '' : 'none';
  if (!e.target.checked) {
    state.slideHeight = parseInt(document.getElementById('slide-height').value) || 540;
  }
  renderAll();
});

// ===== ツール選択 =====
function selectTool(tool) {
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  document.querySelectorAll('.sp-shape-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  state.activeTool = tool;
  canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
}

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => selectTool(btn.dataset.tool));
});


// ===== 要素コンテキストメニュー =====
const elContextMenu = document.getElementById('el-context-menu');
const elCtxCut    = document.getElementById('el-ctx-cut');
const elCtxCopy   = document.getElementById('el-ctx-copy');
const elCtxPaste  = document.getElementById('el-ctx-paste');
const elCtxDelete = document.getElementById('el-ctx-delete');

function showElContextMenu(x, y) {
  elCtxPaste.classList.toggle('disabled', !state.elementClipboard || state.elementClipboard.length === 0);
  const isGroup = state.selectedElement && getElementData(state.selectedElement)?.type === 'group';
  const canGroup = state.selectedElements.size >= 2;
  document.getElementById('el-ctx-group').style.display   = canGroup && !isGroup ? '' : 'none';
  document.getElementById('el-ctx-ungroup').style.display = isGroup ? '' : 'none';
  document.getElementById('el-ctx-sep-group').style.display = (canGroup || isGroup) ? '' : 'none';
  elContextMenu.style.left = x + 'px';
  elContextMenu.style.top  = y + 'px';
  elContextMenu.classList.add('visible');
  requestAnimationFrame(() => {
    const r = elContextMenu.getBoundingClientRect();
    if (r.right  > window.innerWidth)  elContextMenu.style.left = (x - r.width)  + 'px';
    if (r.bottom > window.innerHeight) elContextMenu.style.top  = (y - r.height) + 'px';
  });
}

function hideElContextMenu() {
  elContextMenu.classList.remove('visible');
}

elCtxCut.addEventListener('click', () => {
  if (state.selectedElements.size === 0) return;
  pushHistory();
  state.elementClipboard = [...state.selectedElements]
    .map(id => getElementData(id)).filter(Boolean)
    .map(d => JSON.parse(JSON.stringify(d)));
  const slide = getCurrentSlideData();
  slide.elements = slide.elements.filter(el => !state.selectedElements.has(el.id));
  clearSelection();
  renderAll();
  hideElContextMenu();
});

elCtxCopy.addEventListener('click', () => {
  if (state.selectedElements.size === 0) return;
  state.elementClipboard = [...state.selectedElements]
    .map(id => getElementData(id)).filter(Boolean)
    .map(d => JSON.parse(JSON.stringify(d)));
  hideElContextMenu();
});

elCtxPaste.addEventListener('click', () => {
  if (!state.elementClipboard || state.elementClipboard.length === 0) return;
  pushHistory();
  const slide = getCurrentSlideData();
  const newIds = new Set();
  state.elementClipboard.forEach(clipEl => {
    const newEl = { ...JSON.parse(JSON.stringify(clipEl)), id: generateId() };
    newEl.x += 20; newEl.y += 20;
    newEl.zIndex = slide.elements.length + 1;
    slide.elements.push(newEl);
    newIds.add(newEl.id);
    state.selectedElement = newEl.id;
  });
  state.selectedElements = newIds;
  renderAll();
  hideElContextMenu();
});

elCtxDelete.addEventListener('click', () => {
  if (state.selectedElements.size === 0) return;
  pushHistory();
  const slide = getCurrentSlideData();
  slide.elements = slide.elements.filter(el => !state.selectedElements.has(el.id));
  clearSelection();
  renderAll();
  hideElContextMenu();
});

document.getElementById('el-ctx-group').addEventListener('click', () => {
  groupSelectedElements();
  hideElContextMenu();
});

document.getElementById('el-ctx-ungroup').addEventListener('click', () => {
  ungroupElement();
  hideElContextMenu();
});

document.addEventListener('click', hideElContextMenu);

// ===== スライドのディープコピー =====
function cloneSlide(slide) {
  const cloned = JSON.parse(JSON.stringify(slide));
  cloned.elements = cloned.elements.map(el => {
    const newEl = { ...el, id: generateId() };
    if (el.type === 'group' && el.elements) {
      newEl.elements = el.elements.map(child => ({ ...child, id: generateId() }));
    }
    return newEl;
  });
  cloned.hidden = false;
  return cloned;
}

// ===== コンテキストメニュー =====
const contextMenu = document.getElementById('context-menu');
const ctxCut = document.getElementById('ctx-cut');
const ctxCopy = document.getElementById('ctx-copy');
const ctxPaste = document.getElementById('ctx-paste');
const ctxDuplicate = document.getElementById('ctx-duplicate');
const ctxToggleHidden = document.getElementById('ctx-toggle-hidden');
const ctxDeleteSlide = document.getElementById('ctx-delete-slide');

let contextTargetSlide = -1;

function showContextMenu(x, y, slideIndex) {
  contextTargetSlide = slideIndex;

  // ペーストはクリップボードが空なら無効
  ctxPaste.classList.toggle('disabled', state.clipboard === null);

  // 非表示トグルのテキストを現在の状態に合わせる
  const isHidden = state.slides[slideIndex]?.hidden;
  ctxToggleHidden.innerHTML = isHidden
    ? '<span class="ctx-icon">⊙</span>再表示する'
    : '<span class="ctx-icon">⊘</span>非表示スライドにする';

  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu.classList.add('visible');

  // 画面端にはみ出ないよう補正
  requestAnimationFrame(() => {
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      contextMenu.style.left = (x - rect.width) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
      contextMenu.style.top = (y - rect.height) + 'px';
    }
  });
}

function hideContextMenu() {
  contextMenu.classList.remove('visible');
  contextTargetSlide = -1;
}

// 切り取り
ctxCut.addEventListener('click', () => {
  if (contextTargetSlide < 0) return;
  state.clipboard = cloneSlide(state.slides[contextTargetSlide]);
  state.elementClipboard = null;
  if (state.slides.length > 1) {
    state.slides.splice(contextTargetSlide, 1);
    state.currentSlide = Math.min(state.currentSlide, state.slides.length - 1);
    clearSelection();
    renderAll();
  }
  hideContextMenu();
});

// コピー
ctxCopy.addEventListener('click', () => {
  if (contextTargetSlide < 0) return;
  state.clipboard = cloneSlide(state.slides[contextTargetSlide]);
  state.elementClipboard = null;
  hideContextMenu();
});

// ペースト
ctxPaste.addEventListener('click', () => {
  if (!state.clipboard) return;
  const insertAt = contextTargetSlide >= 0 ? contextTargetSlide + 1 : state.currentSlide + 1;
  const newSlide = cloneSlide(state.clipboard);
  state.slides.splice(insertAt, 0, newSlide);
  state.currentSlide = insertAt;
  clearSelection();
  renderAll();
  hideContextMenu();
});

// 複製
ctxDuplicate.addEventListener('click', () => {
  if (contextTargetSlide < 0) return;
  pushHistory();
  const newSlide = cloneSlide(state.slides[contextTargetSlide]);
  state.slides.splice(contextTargetSlide + 1, 0, newSlide);
  state.currentSlide = contextTargetSlide + 1;
  clearSelection();
  renderAll();
  hideContextMenu();
});

// 非表示トグル
ctxToggleHidden.addEventListener('click', () => {
  if (contextTargetSlide < 0) return;
  pushHistory();
  state.slides[contextTargetSlide].hidden = !state.slides[contextTargetSlide].hidden;
  renderAll();
  hideContextMenu();
});

// 削除
ctxDeleteSlide.addEventListener('click', () => {
  if (contextTargetSlide < 0) return;
  if (state.slides.length <= 1) { hideContextMenu(); return; }
  pushHistory();
  state.slides.splice(contextTargetSlide, 1);
  state.currentSlide = Math.min(state.currentSlide, state.slides.length - 1);
  clearSelection();
  renderAll();
  hideContextMenu();
});

document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

function updatePolylinePreview(pts, tool, svgEl) {
  svgEl.innerHTML = '';
  if (pts.length < 2) return;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#4a90d9');
  path.setAttribute('stroke-width', 2 / state.scale);
  path.setAttribute('stroke-dasharray', `${6/state.scale},${3/state.scale}`);
  path.setAttribute('d', tool === 'curve'
    ? catmullRomPath(pts)
    : pts.map((p,i) => `${i===0?'M':'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
  svgEl.appendChild(path);
  pts.forEach(p => {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
    c.setAttribute('r', 4 / state.scale);
    c.setAttribute('fill', '#89b4fa'); c.setAttribute('stroke', 'none');
    svgEl.appendChild(c);
  });
}

function finishPolyline() {
  if (!drawingState) return;
  const { pts, tool, preview, onMovePoly } = drawingState;
  document.removeEventListener('mousemove', onMovePoly);
  preview.remove();
  drawingState = null;
  if (pts.length < 2) return;
  pushHistory();
  const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const maxX = Math.max(...xs), maxY = Math.max(...ys);
  const w = Math.max(maxX - minX, 10), h = Math.max(maxY - minY, 10);
  const data = createElementData(tool, Math.round(minX), Math.round(minY));
  data.w = Math.round(w); data.h = Math.round(h);
  data.points = pts.map(p => ({ x: ((p.x-minX)/w)*100, y: ((p.y-minY)/h)*100 }));
  data.strokeNone = false; data.stroke = '#000000'; data.strokeWidth = 3;
  getCurrentSlideData().elements.push(data);
  state.selectedElement = data.id; state.selectedElements = new Set([data.id]);
  selectTool('select'); renderAll(); updatePropertiesPanel();
}

// ===== キーボードショートカット =====
document.addEventListener('keydown', (e) => {
  if (editingElementId) {
    if (e.key === 'Escape') { e.preventDefault(); finishInlineEdit(); }
    return;
  }
  if (e.key === 'Escape' && state.editingGroupId) {
    e.preventDefault();
    state.editingGroupId = null;
    clearSelection();
    renderAll();
    updatePropertiesPanel();
    return;
  }
  if (e.key === 'Escape' && drawingState) {
    drawingState.preview.remove();
    document.removeEventListener('mousemove', drawingState.onMovePoly);
    drawingState = null;
    selectTool('select');
    return;
  }
  if (e.key === 'Enter' && drawingState) {
    finishPolyline();
    return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  // Ctrl+Z: Undo / Ctrl+Y: Redo
  if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); return; }
  // Ctrl+0: ズームリセット
  if (e.ctrlKey && e.key === '0') { e.preventDefault(); state.manualScale = null; updateScale(); return; }
  // Ctrl+G: グループ化 / Ctrl+Shift+G: グループ解除
  if (e.ctrlKey && !e.shiftKey && e.key === 'g') { e.preventDefault(); groupSelectedElements(); return; }
  if (e.ctrlKey && e.shiftKey  && e.key === 'G') { e.preventDefault(); ungroupElement(); return; }

  // Ctrl+C: 要素選択中→要素コピー、未選択→スライドコピー
  if (e.ctrlKey && e.key === 'c') {
    e.preventDefault();
    if (state.selectedElements.size > 0) {
      state.elementClipboard = [...state.selectedElements]
        .map(id => getElementData(id)).filter(Boolean)
        .map(d => JSON.parse(JSON.stringify(d)));
    } else {
      state.clipboard = cloneSlide(state.slides[state.currentSlide]);
      state.elementClipboard = null;
    }
    return;
  }

  // Ctrl+X: 要素選択中→要素切り取り、未選択→スライド切り取り
  if (e.ctrlKey && e.key === 'x') {
    e.preventDefault();
    if (state.selectedElements.size > 0) {
      pushHistory();
      state.elementClipboard = [...state.selectedElements]
        .map(id => getElementData(id)).filter(Boolean)
        .map(d => JSON.parse(JSON.stringify(d)));
      const slide = getCurrentSlideData();
      slide.elements = slide.elements.filter(el => !state.selectedElements.has(el.id));
      clearSelection();
      renderAll();
    } else {
      state.clipboard = cloneSlide(state.slides[state.currentSlide]);
      state.elementClipboard = null;
      if (state.slides.length > 1) {
        pushHistory();
        state.slides.splice(state.currentSlide, 1);
        state.currentSlide = Math.min(state.currentSlide, state.slides.length - 1);
        clearSelection();
        renderAll();
      }
    }
    return;
  }

  // Ctrl+V: 要素クリップあり→要素ペースト、なし→スライドペースト
  if (e.ctrlKey && e.key === 'v') {
    e.preventDefault();
    if (state.elementClipboard && state.elementClipboard.length > 0) {
      pushHistory();
      const slide = getCurrentSlideData();
      const newIds = new Set();
      state.elementClipboard.forEach(clipEl => {
        const newEl = { ...JSON.parse(JSON.stringify(clipEl)), id: generateId() };
        newEl.x += 20; newEl.y += 20;
        newEl.zIndex = slide.elements.length + 1;
        slide.elements.push(newEl);
        newIds.add(newEl.id);
        state.selectedElement = newEl.id;
      });
      state.selectedElements = newIds;
      renderAll();
    } else if (state.clipboard) {
      pushHistory();
      const insertAt = state.currentSlide + 1;
      const newSlide = cloneSlide(state.clipboard);
      state.slides.splice(insertAt, 0, newSlide);
      state.currentSlide = insertAt;
      clearSelection();
      renderAll();
    }
    return;
  }

  if (e.ctrlKey && e.key === 'b') {
    e.preventDefault();
    if (state.selectedElement) {
      const data = getElementData(state.selectedElement);
      if (data) applyFontProp({ fontWeight: data.fontWeight === 'bold' ? 'normal' : 'bold' });
    }
    return;
  }
  if (e.ctrlKey && e.key === 'i') {
    e.preventDefault();
    if (state.selectedElement) {
      const data = getElementData(state.selectedElement);
      if (data) applyFontProp({ fontStyle: data.fontStyle === 'italic' ? 'normal' : 'italic' });
    }
    return;
  }
  if (e.ctrlKey && e.key === 'u') {
    e.preventDefault();
    if (state.selectedElement) {
      const data = getElementData(state.selectedElement);
      if (data) applyFontProp({ underline: data.underline ? '' : 'single' });
    }
    return;
  }

  if (e.key === 'Backspace') {
    if (state.selectedElements.size > 0) {
      pushHistory();
      const slide = getCurrentSlideData();
      slide.elements = slide.elements.filter(el => !state.selectedElements.has(el.id));
      clearSelection();
      renderAll();
    } else {
      deleteSlide(); // deleteSlide already calls pushHistory
    }
  }

  if (e.key === 'Delete') {
    if (state.selectedElements.size > 0) {
      pushHistory();
      const slide = getCurrentSlideData();
      slide.elements = slide.elements.filter(el => !state.selectedElements.has(el.id));
      clearSelection();
      renderAll();
    }
  }

  // 矢印キーで移動
  if (state.selectedElements.size > 0 && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    state.selectedElements.forEach(selId => {
      const d = getElementData(selId);
      if (!d) return;
      if (e.key === 'ArrowLeft')  d.x -= step;
      if (e.key === 'ArrowRight') d.x += step;
      if (e.key === 'ArrowUp')    d.y -= step;
      if (e.key === 'ArrowDown')  d.y += step;
    });
    renderAll();
  }

  // V=選択, T=テキスト, R=四角形, C=円, L=直線
  const toolMap = { v:'select', t:'text', r:'rect', c:'circle', l:'line' };
  if (toolMap[e.key.toLowerCase()]) selectTool(toolMap[e.key.toLowerCase()]);
});

// ===== ウィンドウリサイズ対応 =====
window.addEventListener('resize', () => {
  updateScale();
});

// ===== Ctrl+スクロール でスライドズーム =====
document.getElementById('canvas-area').addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const cur = state.manualScale ?? state.scale;
  const factor = e.deltaY < 0 ? 1.1 : (1 / 1.1);
  state.manualScale = Math.max(0.05, Math.min(5, cur * factor));
  updateScale();
}, { passive: false });

// ===== リボンタブ切り替え =====
document.querySelectorAll('.ribbon-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    if (name === 'file') {
      openBackstage('new');
      return;
    }
    document.querySelectorAll('.ribbon-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.ribbon-pane').forEach(p => p.classList.remove('active'));
    const pane = document.querySelector(`.ribbon-pane[data-pane="${name}"]`);
    if (pane) pane.classList.add('active');
    if (name === 'animation') {
      renderAnimBadges(); renderAnimWindow(); updateAnimRibbon();
    } else {
      document.querySelectorAll('.anim-badge').forEach(b => b.remove());
    }
  });
});

// ===== バックステージ =====
const backstage = document.getElementById('backstage');

function openBackstage(section) {
  backstage.classList.add('open');
  switchBsPane(section || 'new');
}

function closeBackstage() {
  backstage.classList.remove('open');
}

function switchBsPane(name) {
  document.querySelectorAll('.bs-nav-item').forEach(i => i.classList.remove('active'));
  const navItem = document.querySelector(`.bs-nav-item[data-bs="${name}"]`);
  if (navItem) navItem.classList.add('active');
  document.querySelectorAll('.bs-pane').forEach(p => p.classList.remove('active'));
  const pane = document.getElementById(`bs-pane-${name}`);
  if (pane) pane.classList.add('active');
  if (name === 'recent') renderRecentList();
}

document.getElementById('bs-back').addEventListener('click', closeBackstage);

document.querySelectorAll('.bs-nav-item').forEach(item => {
  item.addEventListener('click', async () => {
    const target = item.dataset.bs;
    if (target === 'save-as') {
      closeBackstage();
      await saveAs();
    } else if (target === 'overwrite') {
      closeBackstage();
      await save();
    } else {
      switchBsPane(target);
    }
  });
});

// Escキーでバックステージを閉じる
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && backstage.classList.contains('open')) {
    closeBackstage();
  }
});

// ===== プロジェクト データ =====
const RECENT_KEY = 'orca_recent_files';
const MAX_RECENT = 8;

function getProjectData() {
  return {
    version: 1,
    slideWidth: state.slideWidth,
    slideHeight: state.slideHeight,
    slides: state.slides,
  };
}

function loadProjectData(data) {
  state.slideWidth  = data.slideWidth  || 960;
  state.slideHeight = data.slideHeight || 540;
  state.slides      = data.slides && data.slides.length ? data.slides : [createSlideData()];
  state.slides.forEach(s => {
    if (!s.animations) s.animations = [];
    if (!s.notes) s.notes = '';
    if (!s.elements) s.elements = [];
  });
  state.currentSlide   = 0;
  clearSelection();
  document.getElementById('slide-width').value  = state.slideWidth;
  document.getElementById('slide-height').value = state.slideHeight;
  currentFileHandle = null;
  markClean();
  renderAll();
}

// ===== 最近開いた項目 =====
function getRecentFiles() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch { return []; }
}

function saveToRecent(name, projectData) {
  let list = getRecentFiles().filter(r => r.name !== name);
  list.unshift({ name, date: new Date().toISOString(), data: projectData });
  if (list.length > MAX_RECENT) list = list.slice(0, MAX_RECENT);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}

function renderRecentList() {
  const container = document.getElementById('bs-recent-list');
  const list = getRecentFiles();
  if (list.length === 0) {
    container.innerHTML = '<div class="bs-recent-empty">最近開いたファイルはありません。</div>';
    return;
  }
  container.innerHTML = '';
  list.forEach(item => {
    const row = document.createElement('div');
    row.className = 'bs-recent-item';
    const date = new Date(item.date).toLocaleDateString('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    row.innerHTML = `<div class="bs-recent-name">${item.name}.orca</div><div class="bs-recent-date">${date}</div>`;
    row.addEventListener('click', () => {
      loadProjectData(item.data);
      document.getElementById('save-filename').value = item.name;
      closeBackstage();
    });
    container.appendChild(row);
  });
}

// ===== 汎用確認モーダル =====
function showConfirmModal(message, buttons) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    document.getElementById('confirm-modal-msg').textContent = message;
    const btnsEl = document.getElementById('confirm-modal-btns');
    btnsEl.innerHTML = '';
    buttons.forEach(({ label, value, style }) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.className = style === 'primary' ? 'modal-btn-primary'
                    : style === 'danger'  ? 'modal-btn-danger'
                    : 'modal-btn';
      btn.addEventListener('click', () => {
        modal.classList.remove('open');
        resolve(value);
      });
      btnsEl.appendChild(btn);
    });
    modal.classList.add('open');
  });
}
document.getElementById('confirm-modal-backdrop').addEventListener('click', () => {
  document.getElementById('confirm-modal').classList.remove('open');
});

// ===== 新規 =====
document.getElementById('bs-btn-new').addEventListener('click', async () => {
  const choice = await showConfirmModal(
    '現在のプロジェクトを保存しますか？',
    [
      { label: '保存して新規作成', value: 'save',    style: 'primary' },
      { label: '保存しない',       value: 'discard', style: 'danger'  },
      { label: 'キャンセル',       value: 'cancel',  style: ''        },
    ]
  );
  if (choice === 'cancel') return;

  // 現在のプロジェクトを保存
  if (choice === 'save') {
    const ok = await save();
    if (!ok) return; // 保存ダイアログをキャンセルした
  }

  // 新規プロジェクトの保存先を選択
  let newHandle = null;
  if (window.showSaveFilePicker) {
    try {
      newHandle = await window.showSaveFilePicker({
        suggestedName: 'プロジェクト.orca',
        types: [{ description: 'スライドメイト プロジェクト', accept: { 'application/json': ['.orca'] } }],
        startIn: _startIn(),
      });
      await _rememberHandle(newHandle);
    } catch (err) {
      if (err.name === 'AbortError') return; // ユーザーがキャンセル
      // 非対応環境はそのまま続行
    }
  }

  // 新規プロジェクトを作成
  state.slides = [createSlideData()];
  state.currentSlide = 0;
  clearSelection();

  if (newHandle) {
    try {
      const newData = getProjectData();
      const writable = await newHandle.createWritable();
      await writable.write(new Blob([JSON.stringify(newData, null, 2)], { type: 'application/json' }));
      await writable.close();
      currentFileHandle = newHandle;
      const newName = newHandle.name.replace(/\.orca$/i, '');
      document.getElementById('save-filename').value = newName;
      saveToRecent(newName, newData);
    } catch (err) {
      console.error('新規プロジェクト保存失敗:', err);
      currentFileHandle = null;
      document.getElementById('save-filename').value = 'プロジェクト';
    }
  } else {
    currentFileHandle = null;
    document.getElementById('save-filename').value = 'プロジェクト';
  }

  markClean();
  renderAll();
  closeBackstage();
});

// ===== 開く =====
document.getElementById('bs-btn-open').addEventListener('click', async () => {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'スライドメイト プロジェクト', accept: { 'application/json': ['.orca'] } }],
        multiple: false,
        startIn: _startIn(),
      });
      const file = await handle.getFile();
      const text = await file.text();
      const data = JSON.parse(text);
      loadProjectData(data);
      currentFileHandle = handle; // loadProjectData が null にするので後から上書き
      await _rememberHandle(handle);
      const name = file.name.replace(/\.(orca|json)$/i, '');
      document.getElementById('save-filename').value = name;
      saveToRecent(name, data);
      closeBackstage();
    } catch (err) {
      if (err.name !== 'AbortError') alert('ファイルの読み込みに失敗しました。形式が正しくない可能性があります。');
    }
  } else {
    document.getElementById('file-input').click();
  }
});

// showOpenFilePicker 非対応ブラウザ用フォールバック
document.getElementById('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      loadProjectData(data);
      // handle 取得不可のため currentFileHandle は null のまま（上書き保存は saveAs にフォールバック）
      const name = file.name.replace(/\.(orca|json)$/i, '');
      document.getElementById('save-filename').value = name;
      saveToRecent(name, data);
      closeBackstage();
    } catch {
      alert('ファイルの読み込みに失敗しました。形式が正しくない可能性があります。');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ===== ファイル保存ユーティリティ =====
// blob を任意の場所にファイルとして保存。ユーザーがキャンセルしたら false を返す。
async function saveFileWithPicker(blob, suggestedName, types) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types, startIn: _startIn() });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      await _rememberHandle(handle);
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      // SecurityError 等（ユーザージェスチャー外）→ フォールバック
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = suggestedName;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}

// 名前を付けて保存（currentFileHandle を更新し、isDirty を解除）
async function saveAs() {
  const name = (document.getElementById('save-filename').value || 'プロジェクト').trim();
  const data = getProjectData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `${name}.orca`,
        types: [{ description: 'スライドメイト プロジェクト', accept: { 'application/json': ['.orca'] } }],
        startIn: _startIn(),
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      await _rememberHandle(handle);
      currentFileHandle = handle;
      const savedName = handle.name.replace(/\.orca$/i, '');
      document.getElementById('save-filename').value = savedName;
      saveToRecent(savedName, data);
      markClean();
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
    }
  }
  // フォールバック: 通常ダウンロード（handle は取れないのでそのまま）
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${name}.orca`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  saveToRecent(name, data);
  markClean();
  return true;
}

// 上書き保存（handle がなければ saveAs にフォールバック）
async function save() {
  if (!currentFileHandle) return saveAs();
  try {
    const data = getProjectData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const writable = await currentFileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    saveToRecent(currentFileHandle.name.replace(/\.orca$/i, ''), data);
    markClean();
    return true;
  } catch (err) {
    console.error('上書き保存失敗:', err);
    // ファイルへの書き込みに失敗した場合のみ saveAs にフォールバック
    if (err.name !== 'AbortError') return saveAs();
    return false;
  }
}

// ===== コピーを保存 =====
// currentFileHandle・isDirty には影響しない（あくまでコピー）
document.getElementById('bs-btn-save').addEventListener('click', async () => {
  const name = (document.getElementById('save-filename').value || 'プロジェクト').trim();
  const data = getProjectData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const ok = await saveFileWithPicker(blob, `${name}.orca`, [
    { description: 'スライドメイト プロジェクト', accept: { 'application/json': ['.orca'] } },
  ]);
  if (ok) saveToRecent(name, data);
});

// ===== 印刷 =====
document.getElementById('bs-btn-print').addEventListener('click', () => {
  closeBackstage();
  setTimeout(() => window.print(), 200);
});

// ===== エクスポート共通 =====

function escapeXML(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _parseBgForSvg(bgColor) {
  if (!bgColor || (!bgColor.startsWith('linear-gradient') && !bgColor.startsWith('radial-gradient'))) {
    return { defs: '', fill: bgColor || '#ffffff' };
  }
  const colors = bgColor.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/g) || ['#000000'];
  const stops = colors.map((c, i) => {
    const pct = colors.length === 1 ? 0 : Math.round(i / (colors.length - 1) * 100);
    return `<stop offset="${pct}%" stop-color="${c}"/>`;
  }).join('');
  return {
    defs: `<defs><linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">${stops}</linearGradient></defs>`,
    fill: 'url(#bgGrad)'
  };
}

function _applyBgToCtx(ctx, bgColor, w, h) {
  if (bgColor && (bgColor.startsWith('linear-gradient') || bgColor.startsWith('radial-gradient'))) {
    const colors = bgColor.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/g) || ['#000000'];
    const grad = ctx.createLinearGradient(0, 0, w, h);
    colors.forEach((c, i) => {
      grad.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), c);
    });
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = bgColor || '#ffffff';
  }
  ctx.fillRect(0, 0, w, h);
}

function slideToSVGString(slide) {
  const w = state.slideWidth, h = computeSlideHeight(slide);
  const sorted = flattenSlideElements(slide.elements).sort((a, b) => (a.zIndex||1) - (b.zIndex||1));
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  const _bgSvg = _parseBgForSvg(slide.bgColor);
  s += _bgSvg.defs;
  s += `<rect width="${w}" height="${h}" fill="${_bgSvg.fill}"/>`;

  for (const el of sorted) {
    const op     = el.opacity / 100;
    const anchor = el.textAlign === 'left' ? 'start' : el.textAlign === 'right' ? 'end' : 'middle';
    const tx     = el.textAlign === 'left' ? el.x+8 : el.textAlign === 'right' ? el.x+el.w-8 : el.x+el.w/2;
    const fw     = el.fontWeight || 'normal';
    const fi     = el.fontStyle  || 'normal';
    const fs     = el.fontSize || 24;
    const col    = el.color || '#000';

    if (el.type === 'text') {
      const fill   = el.fillNone   ? 'none' : el.fill;
      const stroke = el.strokeNone ? 'none' : el.stroke;
      const sw     = el.strokeNone ? 0 : el.strokeWidth;
      if (!el.fillNone) s += `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" fill="${fill}" opacity="${op}"/>`;
      if (!el.strokeNone && sw > 0) s += `<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" fill="none" stroke="${stroke}" stroke-width="${sw}" opacity="${op}"/>`;
      if (el.text) s += `<text x="${tx}" y="${el.y+el.h/2}" text-anchor="${anchor}" dominant-baseline="middle" font-size="${fs}" font-weight="${fw}" font-style="${fi}" fill="${col}" opacity="${op}">${escapeXML(el.text)}</text>`;
    } else if (el.type === 'image') {
      s += `<image x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" href="${el.src}" preserveAspectRatio="none" opacity="${op}"/>`;
    } else {
      s += `<svg x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" viewBox="0 0 100 100" preserveAspectRatio="none" opacity="${op}">`;
      s += shapeInnerSVGStyled(el);
      s += `</svg>`;
      if (el.text) s += `<text x="${tx}" y="${el.y+el.h/2}" text-anchor="${anchor}" dominant-baseline="middle" font-size="${fs}" font-weight="${fw}" font-style="${fi}" fill="${col}" opacity="${op}">${escapeXML(el.text)}</text>`;
    }
  }
  s += '</svg>';
  return s;
}

const imageCache = new Map();

function loadCachedImage(src) {
  if (imageCache.has(src)) return Promise.resolve(imageCache.get(src));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { imageCache.set(src, img); resolve(img); };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function buildShapeCanvasPath(ctx, el) {
  const {x, y, w, h, type} = el;
  function px(nx) { return x + nx * w / 100; }
  function py(ny) { return y + ny * h / 100; }
  ctx.beginPath();
  switch (type) {
    case 'rect':   ctx.rect(x, y, w, h); break;
    case 'roundrect': {
      const r = Math.min(w, h) * 0.14;
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
      break;
    }
    case 'circle':   ctx.ellipse(x+w/2, y+h/2, w/2, h/2, 0, 0, Math.PI*2); break;
    case 'triangle': ctx.moveTo(px(50),py(2)); ctx.lineTo(px(98),py(98)); ctx.lineTo(px(2),py(98)); ctx.closePath(); break;
    case 'rtriangle':ctx.moveTo(px(2),py(2));  ctx.lineTo(px(98),py(98)); ctx.lineTo(px(2),py(98)); ctx.closePath(); break;
    case 'diamond':  ctx.moveTo(px(50),py(2)); ctx.lineTo(px(98),py(50)); ctx.lineTo(px(50),py(98)); ctx.lineTo(px(2),py(50)); ctx.closePath(); break;
    case 'parallelogram': ctx.moveTo(px(25),py(2)); ctx.lineTo(px(98),py(2)); ctx.lineTo(px(75),py(98)); ctx.lineTo(px(2),py(98)); ctx.closePath(); break;
    case 'trapezoid': ctx.moveTo(px(20),py(2)); ctx.lineTo(px(80),py(2)); ctx.lineTo(px(98),py(98)); ctx.lineTo(px(2),py(98)); ctx.closePath(); break;
    case 'cross': ctx.moveTo(px(35),py(2)); ctx.lineTo(px(65),py(2)); ctx.lineTo(px(65),py(35)); ctx.lineTo(px(98),py(35)); ctx.lineTo(px(98),py(65)); ctx.lineTo(px(65),py(65)); ctx.lineTo(px(65),py(98)); ctx.lineTo(px(35),py(98)); ctx.lineTo(px(35),py(65)); ctx.lineTo(px(2),py(65)); ctx.lineTo(px(2),py(35)); ctx.lineTo(px(35),py(35)); ctx.closePath(); break;
    case 'arrow-r': ctx.moveTo(px(2),py(32)); ctx.lineTo(px(62),py(32)); ctx.lineTo(px(62),py(12)); ctx.lineTo(px(98),py(50)); ctx.lineTo(px(62),py(88)); ctx.lineTo(px(62),py(68)); ctx.lineTo(px(2),py(68)); ctx.closePath(); break;
    case 'arrow-l': ctx.moveTo(px(98),py(32)); ctx.lineTo(px(38),py(32)); ctx.lineTo(px(38),py(12)); ctx.lineTo(px(2),py(50)); ctx.lineTo(px(38),py(88)); ctx.lineTo(px(38),py(68)); ctx.lineTo(px(98),py(68)); ctx.closePath(); break;
    case 'arrow-u': ctx.moveTo(px(32),py(98)); ctx.lineTo(px(32),py(38)); ctx.lineTo(px(12),py(38)); ctx.lineTo(px(50),py(2)); ctx.lineTo(px(88),py(38)); ctx.lineTo(px(68),py(38)); ctx.lineTo(px(68),py(98)); ctx.closePath(); break;
    case 'arrow-d': ctx.moveTo(px(32),py(2)); ctx.lineTo(px(32),py(62)); ctx.lineTo(px(12),py(62)); ctx.lineTo(px(50),py(98)); ctx.lineTo(px(88),py(62)); ctx.lineTo(px(68),py(62)); ctx.lineTo(px(68),py(2)); ctx.closePath(); break;
    case 'arrow-h': ctx.moveTo(px(2),py(50)); ctx.lineTo(px(22),py(22)); ctx.lineTo(px(22),py(40)); ctx.lineTo(px(78),py(40)); ctx.lineTo(px(78),py(22)); ctx.lineTo(px(98),py(50)); ctx.lineTo(px(78),py(78)); ctx.lineTo(px(78),py(60)); ctx.lineTo(px(22),py(60)); ctx.lineTo(px(22),py(78)); ctx.closePath(); break;
    case 'callout': ctx.moveTo(px(2),py(2)); ctx.lineTo(px(98),py(2)); ctx.lineTo(px(98),py(72)); ctx.lineTo(px(42),py(72)); ctx.lineTo(px(18),py(98)); ctx.lineTo(px(24),py(72)); ctx.lineTo(px(2),py(72)); ctx.closePath(); break;
    case 'pentagon': case 'hexagon': case 'octagon': {
      const sides = {pentagon:5,hexagon:6,octagon:8}[type];
      const startA = type === 'octagon' ? Math.PI/8 : -Math.PI/2;
      for (let i = 0; i < sides; i++) {
        const a = startA + 2*Math.PI*i/sides;
        const nx = 50 + 48*Math.cos(a), ny = 50 + 48*Math.sin(a);
        i === 0 ? ctx.moveTo(px(nx),py(ny)) : ctx.lineTo(px(nx),py(ny));
      }
      ctx.closePath(); break;
    }
    case 'star4': case 'star5': case 'star6': case 'star8': {
      const n = {star4:4,star5:5,star6:6,star8:8}[type];
      const ir = {star4:20,star5:18,star6:24,star8:20}[type];
      for (let i = 0; i < n*2; i++) {
        const r = i%2===0 ? 48 : ir;
        const a = (Math.PI*i)/n - Math.PI/2;
        const nx = 50+r*Math.cos(a), ny = 50+r*Math.sin(a);
        i===0 ? ctx.moveTo(px(nx),py(ny)) : ctx.lineTo(px(nx),py(ny));
      }
      ctx.closePath(); break;
    }
    default: ctx.rect(x, y, w, h);
  }
}

async function slideToCanvas(slide) {
  const cvs = document.createElement('canvas');
  cvs.width = state.slideWidth; cvs.height = computeSlideHeight(slide);
  const ctx = cvs.getContext('2d');

  _applyBgToCtx(ctx, slide.bgColor, cvs.width, cvs.height);

  const sorted = flattenSlideElements(slide.elements).sort((a, b) => (a.zIndex||1) - (b.zIndex||1));
  for (const el of sorted) {
    ctx.save();
    ctx.globalAlpha = el.opacity / 100;

    const dash = getStrokeDashCanvas(el.strokeStyle, el.strokeWidth);
    ctx.setLineDash(dash);

    if (el.type === 'text') {
      if (!el.fillNone) { ctx.fillStyle = el.fill; ctx.fillRect(el.x, el.y, el.w, el.h); }
      if (!el.strokeNone && el.strokeWidth > 0) { ctx.strokeStyle = el.stroke; ctx.lineWidth = el.strokeWidth; ctx.strokeRect(el.x, el.y, el.w, el.h); }
      if (el.text) {
        ctx.setLineDash([]);
        ctx.fillStyle = el.color;
        ctx.font = `${el.fontWeight||'normal'} ${el.fontSize}px ${el.fontFamily||'sans-serif'}`;
        ctx.textAlign = el.textAlign || 'center';
        ctx.textBaseline = 'middle';
        const tx = el.textAlign === 'left' ? el.x+8 : el.textAlign === 'right' ? el.x+el.w-8 : el.x+el.w/2;
        ctx.fillText(el.text, tx, el.y+el.h/2);
      }
    } else if (el.type === 'line') {
      if (!el.strokeNone) {
        ctx.beginPath(); ctx.moveTo(el.x, el.y+el.h/2); ctx.lineTo(el.x+el.w, el.y+el.h/2);
        ctx.strokeStyle = el.stroke; ctx.lineWidth = el.strokeWidth; ctx.stroke();
      }
    } else if (el.type === 'arrow-line') {
      if (!el.strokeNone) {
        ctx.beginPath(); ctx.moveTo(el.x, el.y+el.h/2); ctx.lineTo(el.x + el.w*0.82, el.y+el.h/2);
        ctx.strokeStyle = el.stroke; ctx.lineWidth = el.strokeWidth; ctx.stroke();
        ctx.setLineDash([]);
        const aw = Math.max(el.h*0.14, 6);
        ctx.beginPath();
        ctx.moveTo(el.x+el.w*0.82, el.y+el.h/2-aw);
        ctx.lineTo(el.x+el.w, el.y+el.h/2);
        ctx.lineTo(el.x+el.w*0.82, el.y+el.h/2+aw);
        ctx.closePath(); ctx.fillStyle = el.stroke; ctx.fill();
      }
    } else if (el.type === 'image') {
      if (el.src) {
        const img = await loadCachedImage(el.src);
        if (img) ctx.drawImage(img, el.x, el.y, el.w, el.h);
      }
    } else {
      buildShapeCanvasPath(ctx, el);
      if (!el.fillNone) { ctx.setLineDash([]); ctx.fillStyle = el.fill; ctx.fill(); ctx.setLineDash(dash); }
      if (!el.strokeNone && el.strokeWidth > 0) { ctx.strokeStyle = el.stroke; ctx.lineWidth = el.strokeWidth; ctx.stroke(); }
      if (el.text) {
        ctx.setLineDash([]);
        ctx.fillStyle = el.color;
        ctx.font = `${el.fontWeight||'normal'} ${el.fontSize}px ${el.fontFamily||'sans-serif'}`;
        ctx.textAlign = el.textAlign || 'center';
        ctx.textBaseline = 'middle';
        const tx = el.textAlign === 'left' ? el.x+8 : el.textAlign === 'right' ? el.x+el.w-8 : el.x+el.w/2;
        ctx.fillText(el.text, tx, el.y+el.h/2);
      }
    }
    ctx.restore();
  }
  return cvs;
}

function openInNewTab(html) {
  const win = window.open('', '_blank');
  win.document.write(html);
  win.document.close();
}

// PDF
document.getElementById('exp-pdf').addEventListener('click', () => {
  const slides = state.slides.filter(s => !s.hidden);
  const w = state.slideWidth, h = state.slideHeight;
  const pages = slides.map(s => `<div class="page">${slideToSVGString(s)}</div>`).join('');
  openInNewTab(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{background:#fff}
      .page{width:${w}px;height:${h}px;overflow:hidden;page-break-after:always}
      @page{size:${w}px ${h}px;margin:0}
    </style></head><body>${pages}
    <script>window.addEventListener('load',()=>window.print())<\/script>
  </body></html>`);
});

// SVG
document.getElementById('exp-svg').addEventListener('click', () => {
  const slides = state.slides.filter(s => !s.hidden);
  if (slides.length === 1) {
    const blob = new Blob([slideToSVGString(slides[0])], { type: 'image/svg+xml' });
    window.open(URL.createObjectURL(blob), '_blank');
    return;
  }
  const items = slides.map((s, i) =>
    `<p>スライド ${i+1}</p><div class="wrap">${slideToSVGString(s)}</div>`
  ).join('');
  openInNewTab(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>body{background:#444;margin:0;padding:20px;display:flex;flex-direction:column;align-items:center;gap:20px;font-family:sans-serif}
    p{color:#ccc}.wrap{box-shadow:0 2px 12px rgba(0,0,0,.6)}</style>
    </head><body>${items}</body></html>`);
});

// PNG
document.getElementById('exp-png').addEventListener('click', async () => {
  const slides = state.slides.filter(s => !s.hidden);
  if (slides.length === 1) {
    const cvs = await slideToCanvas(slides[0]);
    window.open(cvs.toDataURL('image/png'), '_blank');
    return;
  }
  const dataURLs = await Promise.all(slides.map(s => slideToCanvas(s).then(c => c.toDataURL('image/png'))));
  const imgs = dataURLs.map((url, i) =>
    `<p>スライド ${i+1}</p><img src="${url}">`
  ).join('');
  openInNewTab(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>body{background:#444;margin:0;padding:20px;display:flex;flex-direction:column;align-items:center;gap:20px;font-family:sans-serif}
    p{color:#ccc}img{box-shadow:0 2px 12px rgba(0,0,0,.6);max-width:100%}</style>
    </head><body>${imgs}</body></html>`);
});

// ===== リボン フォントコントロール =====

// PPT準拠テーマカラー（10列ベース色）
const THEME_BASE_COLORS = [
  '#FFFFFF','#000000','#E7E6E6','#44546A',
  '#4472C4','#ED7D31','#A5A5A5','#FFC000','#5B9BD5','#70AD47'
];

// PPT標準色（10色）
const STANDARD_COLORS = [
  '#C00000','#FF0000','#FFC000','#FFFF00','#92D050',
  '#00B050','#00B0F0','#0070C0','#002060','#7030A0'
];

function tintColor(hex, factor) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return '#' + [
    Math.min(255, Math.round(r + (255-r)*factor)),
    Math.min(255, Math.round(g + (255-g)*factor)),
    Math.min(255, Math.round(b + (255-b)*factor))
  ].map(v => v.toString(16).padStart(2,'0')).join('');
}

function shadeColor(hex, factor) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return '#' + [
    Math.max(0, Math.round(r*(1-factor))),
    Math.max(0, Math.round(g*(1-factor))),
    Math.max(0, Math.round(b*(1-factor)))
  ].map(v => v.toString(16).padStart(2,'0')).join('');
}

// ===== グローバルPPTカラーピッカー =====
let _pptCpCallback = null;
let _pptCpOpacityCallback = null;

function initPptColorPicker() {
  const themeGrid = document.getElementById('ppt-cp-theme');
  const rowDefs = [
    { type: 'base' },
    { type: 'tint', f: 0.8 },
    { type: 'tint', f: 0.6 },
    { type: 'tint', f: 0.4 },
    { type: 'shade', f: 0.25 },
    { type: 'shade', f: 0.5 },
  ];
  rowDefs.forEach(row => {
    THEME_BASE_COLORS.forEach(base => {
      const color = row.type === 'base' ? base
        : row.type === 'tint' ? tintColor(base, row.f)
        : shadeColor(base, row.f);
      const cell = document.createElement('div');
      cell.className = 'ppt-cp-cell';
      cell.style.background = color;
      cell.title = color;
      cell.addEventListener('click', e => { e.stopPropagation(); _selectPptColor(color); });
      themeGrid.appendChild(cell);
    });
  });

  const stdRow = document.getElementById('ppt-cp-std');
  STANDARD_COLORS.forEach(c => {
    const cell = document.createElement('div');
    cell.className = 'ppt-cp-cell';
    cell.style.background = c;
    cell.title = c;
    cell.addEventListener('click', e => { e.stopPropagation(); _selectPptColor(c); });
    stdRow.appendChild(cell);
  });

  const native = document.getElementById('ppt-cp-native');
  document.getElementById('ppt-cp-more').addEventListener('click', e => {
    e.stopPropagation();
    // Position at the color picker popup's location so the dialog opens there
    const pr = document.getElementById('ppt-color-picker').getBoundingClientRect();
    native.style.top  = Math.round(pr.top)  + 'px';
    native.style.left = Math.round(pr.left) + 'px';
    native.click();
  });
  native.addEventListener('change', () => { _selectPptColor(native.value); });

  document.getElementById('ppt-cp-none').addEventListener('click', e => {
    e.stopPropagation();
    hidePptColorPicker();
    if (_pptCpCallback) { _pptCpCallback(null); _pptCpCallback = null; }
  });

  const opacitySlider = document.getElementById('ppt-cp-opacity');
  const opacityVal = document.getElementById('ppt-cp-opacity-val');
  opacitySlider.addEventListener('input', () => {
    const v = parseInt(opacitySlider.value);
    opacityVal.textContent = v + '%';
    if (_pptCpOpacityCallback) _pptCpOpacityCallback(v);
  });

  document.addEventListener('click', e => {
    const picker = document.getElementById('ppt-color-picker');
    if (picker.classList.contains('visible') && !picker.contains(e.target)) {
      hidePptColorPicker();
    }
  });
}

function showPptColorPicker(anchorEl, callback, optsOrBool = {}) {
  const opts = typeof optsOrBool === 'boolean' ? { showNone: optsOrBool } : (optsOrBool || {});
  _pptCpCallback = callback;
  _pptCpOpacityCallback = opts.onOpacityChange || null;

  const picker = document.getElementById('ppt-color-picker');
  const noneBtn = document.getElementById('ppt-cp-none');
  noneBtn.style.display = opts.showNone ? '' : 'none';
  if (opts.showNone && opts.noneLabel) noneBtn.textContent = opts.noneLabel;

  const opacityRow = document.getElementById('ppt-cp-opacity-row');
  opacityRow.style.display = opts.showOpacity ? '' : 'none';
  if (opts.showOpacity) {
    const v = opts.initialOpacity ?? 100;
    document.getElementById('ppt-cp-opacity').value = v;
    document.getElementById('ppt-cp-opacity-val').textContent = v + '%';
  }

  // Render off-screen to measure actual size, then position near anchor
  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = '-9999px';
  picker.style.left = '-9999px';
  picker.classList.add('visible');
  const pr = picker.getBoundingClientRect();
  let top  = rect.bottom + 4;
  let left = rect.left;
  if (left + pr.width  > window.innerWidth  - 4) left = window.innerWidth  - pr.width  - 4;
  if (left < 4) left = 4;
  if (top  + pr.height > window.innerHeight - 4) top  = rect.top - pr.height - 4;
  if (top  < 4) top  = 4;
  picker.style.top  = top  + 'px';
  picker.style.left = left + 'px';
}

function hidePptColorPicker() {
  document.getElementById('ppt-color-picker').classList.remove('visible');
  _pptCpOpacityCallback = null;
}

function _selectPptColor(color) {
  hidePptColorPicker();
  if (_pptCpCallback) { _pptCpCallback(color); _pptCpCallback = null; }
}

let lastHighlightColor = '#ffff00';
let lastFontColor = '#ffffff';

function syncFontRibbon(data) {
  const ffEl = document.getElementById('rbn-fontfamily');
  const fsEl = document.getElementById('rbn-fontsize');
  if (!data) {
    if (ffEl) ffEl.value = "'Noto Sans JP', sans-serif";
    if (fsEl) fsEl.value = 24;
    const boldEl = document.getElementById('rbn-bold');
    const italicEl = document.getElementById('rbn-italic');
    const ulEl = document.getElementById('rbn-underline');
    if (boldEl) boldEl.classList.remove('active');
    if (italicEl) italicEl.classList.remove('active');
    if (ulEl) ulEl.classList.remove('active');
    syncTextEffectRibbon(null);
    syncParaRibbon(null);
    return;
  }
  if (ffEl) ffEl.value = data.fontFamily || "'Noto Sans JP', sans-serif";
  if (fsEl) fsEl.value = data.fontSize || 24;
  document.getElementById('rbn-bold').classList.toggle('active', data.fontWeight === 'bold');
  document.getElementById('rbn-italic').classList.toggle('active', data.fontStyle === 'italic');
  document.getElementById('rbn-underline').classList.toggle('active', !!data.underline);
  document.getElementById('rbn-hl-swatch').style.background = data.highlightColor || 'transparent';
  document.getElementById('rbn-fc-swatch').style.background = data.color || '#ffffff';
  syncTextEffectRibbon(data);
  syncParaRibbon(data);
}

function syncParaRibbon(data) {
  const alignMap = {
    left: 'rbn-align-left', center: 'rbn-align-center', right: 'rbn-align-right',
    justify: 'rbn-align-justify', distributeCenter: 'rbn-align-distribute',
  };
  Object.entries(alignMap).forEach(([align, id]) => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', !!(data && data.textAlign === align));
  });
  // デフォルト（center）のボタンを選択状態にする（data なし or 未設定時）
  if (!data || !data.textAlign || !alignMap[data.textAlign]) {
    const centerBtn = document.getElementById('rbn-align-center');
    if (centerBtn) centerBtn.classList.add('active');
  }
  const bulletBtn = document.getElementById('rbn-bullet');
  const numberedBtn = document.getElementById('rbn-numbered');
  if (bulletBtn) bulletBtn.classList.toggle('active', !!(data && data.listStyle === 'bullet'));
  if (numberedBtn) numberedBtn.classList.toggle('active', !!(data && data.listStyle === 'numbered'));
}

function initParaRibbon() {
  const alignBtns = [
    ['rbn-align-left', 'left'],
    ['rbn-align-center', 'center'],
    ['rbn-align-right', 'right'],
    ['rbn-align-justify', 'justify'],
    ['rbn-align-distribute', 'distributeCenter'],
  ];
  alignBtns.forEach(([id, align]) => {
    document.getElementById(id).addEventListener('click', () => {
      applyFontProp({ textAlign: align });
    });
  });

  document.getElementById('rbn-bullet').addEventListener('click', () => {
    if (!state.selectedElement) return;
    const data = getElementData(state.selectedElement);
    if (!data) return;
    applyFontProp({ listStyle: data.listStyle === 'bullet' ? null : 'bullet' });
  });

  document.getElementById('rbn-numbered').addEventListener('click', () => {
    if (!state.selectedElement) return;
    const data = getElementData(state.selectedElement);
    if (!data) return;
    applyFontProp({ listStyle: data.listStyle === 'numbered' ? null : 'numbered' });
  });
}

function applyFontProp(props) {
  if (state.selectedElements.size === 0) return;
  pushHistory();
  if (editingElementId) finishInlineEditData();
  state.selectedElements.forEach(selId => {
    const d = getElementData(selId);
    if (d) Object.assign(d, props);
  });
  const primaryData = getElementData(state.selectedElement);
  if (primaryData) syncFontRibbon(primaryData);
  renderAll();
}

function buildColorGrid(container, colors, cols, onSelect) {
  container.innerHTML = '';
  container.style.gridTemplateColumns = `repeat(${cols}, 20px)`;
  colors.forEach(c => {
    const cell = document.createElement('div');
    cell.className = 'rbn-color-cell';
    cell.style.background = c;
    cell.title = c;
    cell.addEventListener('click', (e) => { e.stopPropagation(); onSelect(c); });
    container.appendChild(cell);
  });
}

function toggleRibbonPopup(id, anchorEl) {
  const popup = document.getElementById(id);
  const wasVisible = popup.classList.contains('visible');
  hideAllRibbonPopups();
  if (!wasVisible) {
    const rect = anchorEl.getBoundingClientRect();
    popup.style.top  = (rect.bottom + 2) + 'px';
    popup.style.left = rect.left + 'px';
    popup.classList.add('visible');
    requestAnimationFrame(() => {
      const pr = popup.getBoundingClientRect();
      if (pr.right  > window.innerWidth)  popup.style.left = (window.innerWidth  - pr.width  - 4) + 'px';
      if (pr.bottom > window.innerHeight) popup.style.top  = (rect.top - pr.height - 2) + 'px';
    });
  }
}

function hideAllRibbonPopups() {
  const ulMenu = document.getElementById('rbn-ul-menu');
  if (ulMenu) ulMenu.classList.remove('visible');
  hidePptColorPicker();
  hideAllFxPopups();
}

function initFontRibbon() {
  document.getElementById('rbn-fontfamily').addEventListener('change', () => {
    applyFontProp({ fontFamily: document.getElementById('rbn-fontfamily').value });
  });

  document.getElementById('rbn-fontsize').addEventListener('change', () => {
    applyFontProp({ fontSize: parseInt(document.getElementById('rbn-fontsize').value) || 24 });
  });

  document.getElementById('rbn-size-up').addEventListener('click', () => {
    if (state.selectedElements.size === 0) return;
    const sizes = [6,7,8,9,10,11,12,14,16,18,20,24,28,32,36,40,48,54,60,72,80,96,120];
    if (editingElementId) finishInlineEditData();
    state.selectedElements.forEach(selId => {
      const d = getElementData(selId);
      if (!d) return;
      d.fontSize = sizes.find(s => s > (d.fontSize || 24)) || Math.min(300, (d.fontSize || 24) + 4);
    });
    const primaryData = getElementData(state.selectedElement);
    if (primaryData) syncFontRibbon(primaryData);
    renderAll();
  });

  document.getElementById('rbn-size-down').addEventListener('click', () => {
    if (state.selectedElements.size === 0) return;
    const sizes = [6,7,8,9,10,11,12,14,16,18,20,24,28,32,36,40,48,54,60,72,80,96,120];
    if (editingElementId) finishInlineEditData();
    state.selectedElements.forEach(selId => {
      const d = getElementData(selId);
      if (!d) return;
      d.fontSize = [...sizes].reverse().find(s => s < (d.fontSize || 24)) || Math.max(6, (d.fontSize || 24) - 2);
    });
    const primaryData = getElementData(state.selectedElement);
    if (primaryData) syncFontRibbon(primaryData);
    renderAll();
  });

  document.getElementById('rbn-bold').addEventListener('click', () => {
    if (!state.selectedElement) return;
    const data = getElementData(state.selectedElement);
    if (data) applyFontProp({ fontWeight: data.fontWeight === 'bold' ? 'normal' : 'bold' });
  });

  document.getElementById('rbn-italic').addEventListener('click', () => {
    if (!state.selectedElement) return;
    const data = getElementData(state.selectedElement);
    if (data) applyFontProp({ fontStyle: data.fontStyle === 'italic' ? 'normal' : 'italic' });
  });

  document.getElementById('rbn-underline').addEventListener('click', () => {
    if (!state.selectedElement) return;
    const data = getElementData(state.selectedElement);
    if (data) applyFontProp({ underline: data.underline ? '' : 'single' });
  });

  document.getElementById('rbn-underline').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleRibbonPopup('rbn-ul-menu', e.currentTarget);
  });

  document.getElementById('rbn-underline-arr').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleRibbonPopup('rbn-ul-menu', e.currentTarget);
  });

  document.querySelectorAll('#rbn-ul-menu .rbn-menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      applyFontProp({ underline: item.dataset.ul });
      hideAllRibbonPopups();
    });
  });

  document.getElementById('rbn-highlight').addEventListener('click', () => {
    if (!state.selectedElement) return;
    const data = getElementData(state.selectedElement);
    if (!data) return;
    const col = lastHighlightColor || '#ffff00';
    applyFontProp({ highlightColor: data.highlightColor === col ? '' : col });
  });

  document.getElementById('rbn-highlight-arr').addEventListener('click', (e) => {
    e.stopPropagation();
    showPptColorPicker(e.currentTarget, (c) => {
      lastHighlightColor = c || '';
      document.getElementById('rbn-hl-swatch').style.background = c || 'transparent';
      applyFontProp({ highlightColor: c || '' });
    }, true);
  });

  document.getElementById('rbn-fontcolor').addEventListener('click', () => {
    if (!lastFontColor) return;
    applyFontProp({ color: lastFontColor });
  });

  document.getElementById('rbn-fontcolor-arr').addEventListener('click', (e) => {
    e.stopPropagation();
    showPptColorPicker(e.currentTarget, (c) => {
      lastFontColor = c;
      document.getElementById('rbn-fc-swatch').style.background = c;
      applyFontProp({ color: c });
    });
  });
}

document.addEventListener('click', hideAllRibbonPopups);

document.querySelectorAll('.rbn-fx-popup').forEach(popup => {
  popup.addEventListener('click', e => e.stopPropagation());
});

// ===== テキスト効果リボン =====
const TX_FX_POPUP_IDS = ['rbn-tx-stroke-popup','rbn-tx-stroke2-popup','rbn-tx-shadow-popup','rbn-tx-3d-popup'];

function hideAllFxPopups() {
  TX_FX_POPUP_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('visible');
  });
}

function toggleFxPopup(id, anchorEl) {
  const popup = document.getElementById(id);
  const wasVisible = popup.classList.contains('visible');
  hideAllRibbonPopups();
  if (!wasVisible) {
    const rect = anchorEl.getBoundingClientRect();
    popup.style.top = (rect.bottom + 2) + 'px';
    popup.style.left = rect.left + 'px';
    popup.classList.add('visible');
    requestAnimationFrame(() => {
      const pr = popup.getBoundingClientRect();
      if (pr.right > window.innerWidth) popup.style.left = (window.innerWidth - pr.width - 4) + 'px';
      if (pr.bottom > window.innerHeight) popup.style.top = (rect.top - pr.height - 2) + 'px';
    });
  }
}

function syncTextEffectRibbon(data) {
  const opEl = document.getElementById('rbn-tx-opacity');
  const opVal = document.getElementById('rbn-tx-opacity-val');
  if (!data) {
    ['rbn-tx-stroke','rbn-tx-stroke2','rbn-tx-shadow','rbn-tx-3d'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });
    if (opEl) opEl.value = 100;
    if (opVal) opVal.textContent = '100%';
    return;
  }
  document.getElementById('rbn-tx-stroke').classList.toggle('active', !!data.textStroke);
  document.getElementById('rbn-tx-stroke2').classList.toggle('active', !!data.textStroke2);
  document.getElementById('rbn-tx-shadow').classList.toggle('active', !!data.textShadow);
  document.getElementById('rbn-tx-3d').classList.toggle('active', !!data.text3D);
  const op = data.textOpacity !== undefined ? data.textOpacity : 100;
  if (opEl) { opEl.value = op; }
  if (opVal) opVal.textContent = op + '%';
  document.getElementById('rbn-tx-stroke-swatch').style.background = data.textStrokeColor || '#000000';
  document.getElementById('rbn-tx-stroke2-swatch').style.background = data.textStroke2Color || '#ffffff';
  document.getElementById('rbn-tx-shadow-swatch').style.background = data.textShadowColor || '#000000';
  document.getElementById('rbn-tx-3d-swatch').style.background = data.text3DColor || '#888888';
  const scEl = document.getElementById('rbn-tx-stroke-color');
  if (scEl) { scEl.value = data.textStrokeColor || '#000000'; }
  const scPrev = document.getElementById('rbn-tx-stroke-color-preview');
  if (scPrev) scPrev.style.background = data.textStrokeColor || '#000000';
  const swV = data.textStrokeWidth !== undefined ? data.textStrokeWidth : 2;
  const swEl = document.getElementById('rbn-tx-stroke-width');
  if (swEl) { swEl.value = swV; document.getElementById('rbn-tx-stroke-width-val').textContent = swV; }
  const sc2El = document.getElementById('rbn-tx-stroke2-color');
  if (sc2El) { sc2El.value = data.textStroke2Color || '#ffffff'; }
  const sc2Prev = document.getElementById('rbn-tx-stroke2-color-preview');
  if (sc2Prev) sc2Prev.style.background = data.textStroke2Color || '#ffffff';
  const sw2V = data.textStroke2Width !== undefined ? data.textStroke2Width : 4;
  const sw2El = document.getElementById('rbn-tx-stroke2-width');
  if (sw2El) { sw2El.value = sw2V; document.getElementById('rbn-tx-stroke2-width-val').textContent = sw2V; }
  const shcEl = document.getElementById('rbn-tx-shadow-color');
  if (shcEl) { shcEl.value = data.textShadowColor || '#000000'; }
  const shcPrev = document.getElementById('rbn-tx-shadow-color-preview');
  if (shcPrev) shcPrev.style.background = data.textShadowColor || '#000000';
  const shxEl = document.getElementById('rbn-tx-shadow-x');
  if (shxEl) shxEl.value = data.textShadowX !== undefined ? data.textShadowX : 2;
  const shyEl = document.getElementById('rbn-tx-shadow-y');
  if (shyEl) shyEl.value = data.textShadowY !== undefined ? data.textShadowY : 2;
  const shbV = data.textShadowBlur !== undefined ? data.textShadowBlur : 4;
  const shbEl = document.getElementById('rbn-tx-shadow-blur');
  if (shbEl) { shbEl.value = shbV; document.getElementById('rbn-tx-shadow-blur-val').textContent = shbV; }
  const d3cEl = document.getElementById('rbn-tx-3d-color');
  if (d3cEl) { d3cEl.value = data.text3DColor || '#888888'; }
  const d3cPrev = document.getElementById('rbn-tx-3d-color-preview');
  if (d3cPrev) d3cPrev.style.background = data.text3DColor || '#888888';
  const depV = data.text3DDepth !== undefined ? data.text3DDepth : 4;
  const depEl = document.getElementById('rbn-tx-3d-depth');
  if (depEl) { depEl.value = depV; document.getElementById('rbn-tx-3d-depth-val').textContent = depV; }
}

function initTextFxRibbon() {
  document.getElementById('rbn-tx-stroke').addEventListener('click', () => {
    if (!state.selectedElement) return;
    const d = getElementData(state.selectedElement);
    if (d) applyFontProp({ textStroke: !d.textStroke });
  });
  document.getElementById('rbn-tx-stroke2').addEventListener('click', () => {
    if (!state.selectedElement) return;
    const d = getElementData(state.selectedElement);
    if (d) applyFontProp({ textStroke2: !d.textStroke2 });
  });
  document.getElementById('rbn-tx-shadow').addEventListener('click', () => {
    if (!state.selectedElement) return;
    const d = getElementData(state.selectedElement);
    if (d) applyFontProp({ textShadow: !d.textShadow });
  });
  document.getElementById('rbn-tx-3d').addEventListener('click', () => {
    if (!state.selectedElement) return;
    const d = getElementData(state.selectedElement);
    if (d) applyFontProp({ text3D: !d.text3D });
  });

  document.getElementById('rbn-tx-stroke-arr').addEventListener('click', e => { e.stopPropagation(); toggleFxPopup('rbn-tx-stroke-popup', e.currentTarget); });
  document.getElementById('rbn-tx-stroke2-arr').addEventListener('click', e => { e.stopPropagation(); toggleFxPopup('rbn-tx-stroke2-popup', e.currentTarget); });
  document.getElementById('rbn-tx-shadow-arr').addEventListener('click', e => { e.stopPropagation(); toggleFxPopup('rbn-tx-shadow-popup', e.currentTarget); });
  document.getElementById('rbn-tx-3d-arr').addEventListener('click', e => { e.stopPropagation(); toggleFxPopup('rbn-tx-3d-popup', e.currentTarget); });

  document.getElementById('rbn-tx-opacity').addEventListener('input', () => {
    const val = parseInt(document.getElementById('rbn-tx-opacity').value);
    document.getElementById('rbn-tx-opacity-val').textContent = val + '%';
    applyFontProp({ textOpacity: val });
  });

  document.getElementById('rbn-tx-stroke-color').addEventListener('input', () => {
    const c = document.getElementById('rbn-tx-stroke-color').value;
    document.getElementById('rbn-tx-stroke-swatch').style.background = c;
    applyFontProp({ textStrokeColor: c });
  });
  document.getElementById('rbn-tx-stroke-width').addEventListener('change', () => {
    const v = Math.max(1, parseInt(document.getElementById('rbn-tx-stroke-width').value) || 1);
    document.getElementById('rbn-tx-stroke-width').value = v;
    applyFontProp({ textStrokeWidth: v });
  });

  document.getElementById('rbn-tx-stroke2-color').addEventListener('input', () => {
    const c = document.getElementById('rbn-tx-stroke2-color').value;
    document.getElementById('rbn-tx-stroke2-swatch').style.background = c;
    applyFontProp({ textStroke2Color: c });
  });
  document.getElementById('rbn-tx-stroke2-width').addEventListener('change', () => {
    const v = Math.max(1, parseInt(document.getElementById('rbn-tx-stroke2-width').value) || 1);
    document.getElementById('rbn-tx-stroke2-width').value = v;
    applyFontProp({ textStroke2Width: v });
  });

  document.getElementById('rbn-tx-shadow-color').addEventListener('input', () => {
    const c = document.getElementById('rbn-tx-shadow-color').value;
    document.getElementById('rbn-tx-shadow-swatch').style.background = c;
    applyFontProp({ textShadowColor: c });
  });
  document.getElementById('rbn-tx-shadow-x').addEventListener('change', () => {
    applyFontProp({ textShadowX: parseInt(document.getElementById('rbn-tx-shadow-x').value) || 0 });
  });
  document.getElementById('rbn-tx-shadow-y').addEventListener('change', () => {
    applyFontProp({ textShadowY: parseInt(document.getElementById('rbn-tx-shadow-y').value) || 0 });
  });
  document.getElementById('rbn-tx-shadow-blur').addEventListener('input', () => {
    const v = parseInt(document.getElementById('rbn-tx-shadow-blur').value);
    document.getElementById('rbn-tx-shadow-blur-val').textContent = v;
    applyFontProp({ textShadowBlur: v });
  });

  document.getElementById('rbn-tx-3d-color').addEventListener('input', () => {
    const c = document.getElementById('rbn-tx-3d-color').value;
    document.getElementById('rbn-tx-3d-swatch').style.background = c;
    applyFontProp({ text3DColor: c });
  });
  document.getElementById('rbn-tx-3d-depth').addEventListener('input', () => {
    const v = parseInt(document.getElementById('rbn-tx-3d-depth').value);
    document.getElementById('rbn-tx-3d-depth-val').textContent = v;
    applyFontProp({ text3DDepth: v });
  });

  // テキスト効果ポップアップのスウォッチボタン
  [
    ['rbn-tx-stroke-color-btn',  'rbn-tx-stroke-color',  'rbn-tx-stroke-color-preview'],
    ['rbn-tx-stroke2-color-btn', 'rbn-tx-stroke2-color', 'rbn-tx-stroke2-color-preview'],
    ['rbn-tx-shadow-color-btn',  'rbn-tx-shadow-color',  'rbn-tx-shadow-color-preview'],
    ['rbn-tx-3d-color-btn',      'rbn-tx-3d-color',      'rbn-tx-3d-color-preview'],
  ].forEach(([btnId, inputId, previewId]) => {
    document.getElementById(btnId).addEventListener('click', (e) => {
      e.stopPropagation();
      const inp = document.getElementById(inputId);
      showPptColorPicker(e.currentTarget, (c) => {
        inp.value = c;
        document.getElementById(previewId).style.background = c;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
  });
}

document.addEventListener('click', hideAllFxPopups);

// ===== 図形ピッカー =====
const SHAPE_GROUPS = [
  { name: '基本図形', shapes: [
    {type:'rect',label:'四角形'},{type:'roundrect',label:'角丸四角形'},{type:'circle',label:'楕円'},
    {type:'triangle',label:'三角形'},{type:'rtriangle',label:'直角三角形'},{type:'diamond',label:'ひし形'},
    {type:'parallelogram',label:'平行四辺形'},{type:'trapezoid',label:'台形'},{type:'pentagon',label:'五角形'},
    {type:'hexagon',label:'六角形'},{type:'octagon',label:'八角形'},{type:'cross',label:'十字形'},
    {type:'cylinder',label:'円柱'},{type:'cloud',label:'雲'},{type:'heart',label:'ハート'},
    {type:'moon',label:'三日月'},{type:'lightning',label:'稲妻'},{type:'ribbon',label:'リボン'},
  ]},
  { name: '矢印', shapes: [
    {type:'arrow-r',label:'右矢印'},{type:'arrow-l',label:'左矢印'},{type:'arrow-u',label:'上矢印'},
    {type:'arrow-d',label:'下矢印'},{type:'arrow-h',label:'左右矢印'},{type:'chevron',label:'シェブロン'},
  ]},
  { name: '星・バナー', shapes: [
    {type:'star3',label:'3角星'},{type:'star4',label:'4角星'},{type:'star5',label:'5角星'},
    {type:'star6',label:'6角星'},{type:'star8',label:'8角星'},{type:'star10',label:'10角星'},
    {type:'star12',label:'12角星'},
  ]},
  { name: '吹き出し', shapes: [
    {type:'callout',label:'吹き出し（下）'},{type:'callout-r',label:'吹き出し（右）'},
    {type:'callout-oval',label:'楕円吹き出し'},
  ]},
  { name: '線', shapes: [
    {type:'line',label:'直線'},{type:'arrow-line',label:'矢印線'},
  ]},
  { name: 'フリーハンド', shapes: [
    {type:'freehand',label:'フリーハンド'},{type:'polyline',label:'折れ線'},
    {type:'curve',label:'なめらか曲線'},
  ]},
];

const shapePicker = document.getElementById('shape-picker');

function buildShapePicker() {
  shapePicker.innerHTML = '';
  SHAPE_GROUPS.forEach(group => {
    const lbl = document.createElement('div');
    lbl.className = 'sp-group-label';
    lbl.textContent = group.name;
    shapePicker.appendChild(lbl);
    const row = document.createElement('div');
    row.className = 'sp-group-items';
    group.shapes.forEach(({type, label}) => {
      const btn = document.createElement('button');
      btn.className = 'sp-shape-btn';
      btn.title = label;
      btn.dataset.tool = type;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.style.cssText = 'width:30px;height:30px;overflow:visible;';
      svg.innerHTML = `<g fill="#4a90d9" stroke="#cdd6f4" stroke-width="4">${shapeInnerSVG(type, 0.5)}</g>`;
      btn.appendChild(svg);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectTool(type);
        hideShapePicker();
      });
      row.appendChild(btn);
    });
    shapePicker.appendChild(row);
  });
}

let shapePickerOpen = false;

function showShapePicker(btn) {
  const rect = btn.getBoundingClientRect();
  shapePicker.style.top  = rect.bottom + 4 + 'px';
  shapePicker.style.left = rect.left + 'px';
  shapePicker.classList.add('visible');
  shapePickerOpen = true;
}

function hideShapePicker() {
  shapePicker.classList.remove('visible');
  shapePickerOpen = false;
}

document.getElementById('btn-show-shapes').addEventListener('click', (e) => {
  e.stopPropagation();
  shapePickerOpen ? hideShapePicker() : showShapePicker(e.currentTarget);
});
document.addEventListener('click', hideShapePicker);

// ===== 画像挿入 =====
document.getElementById('btn-insert-image').addEventListener('click', () => {
  document.getElementById('image-file-input').click();
});

document.getElementById('image-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const src = ev.target.result;
    loadCachedImage(src);
    const data = createElementData('image', 100, 100);
    data.src = src;
    getCurrentSlideData().elements.push(data);
    state.selectedElement = data.id;
    selectTool('select');
    renderAll();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

// ===== 表挿入（サイズピッカー起動） =====
document.getElementById('btn-insert-table').addEventListener('click', (e) => {
  e.stopPropagation();
  showTableSizePicker(e.currentTarget);
});

// ===== 初期化 =====
function init() {
  buildShapePicker();
  initPptColorPicker();
  initFontRibbon();
  initTextFxRibbon();
  initParaRibbon();
  addSlide();
  updateScale();
}

init();

// ===== スライドショー =====

let ssChannel    = null;
let audienceWin  = null;

// 録画状態
const recState = {
  active:   false,
  recorder: null,
  chunks:   [],
  stream:   null,
};

const ssState = {
  active:        false,
  currentIndex:  0,
  activeTool:    null, // null | 'pointer' | 'pen' | 'highlight'
  devMode:       false,
  startTime:     null,
  timerInterval: null,
};

const ssInk = {
  strokes:  [],
  current:  null,
  drawing:  false,
  colors: { pen: '#ff4040', highlight: '#ffff00' },
};

function getSsSlides() {
  return state.slides
    .map((slide, i) => ({ slide, stateIndex: i }))
    .filter(x => !x.slide.hidden);
}

// ---- ポインタースタイル適用 ----
function _hexAdjust(hex, amt) {
  return '#' + [1,3,5].map(i =>
    Math.max(0, Math.min(255, parseInt(hex.slice(i, i+2), 16) + amt))
      .toString(16).padStart(2, '0')
  ).join('');
}

function applyPointerStyle(el) {
  if (!el) return;
  const shape = appSettings.get('pointerShape');
  const color = appSettings.get('pointerColor') || '#ff2020';
  const url   = appSettings.get('pointerImageUrl');

  el.style.cssText = el.style.cssText; // keep display/position/transform
  el.style.width         = '';
  el.style.height        = '';
  el.style.borderRadius  = '';
  el.style.background    = '';
  el.style.boxShadow     = '';

  if (shape === 'custom' && url) {
    el.style.width        = '34px';
    el.style.height       = '34px';
    el.style.borderRadius = '0';
    el.style.background   = `url("${url}") center/contain no-repeat`;
    el.style.boxShadow    = 'none';
  } else if (shape === 'crosshair') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28"><line x1="14" y1="1" x2="14" y2="27" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/><line x1="1" y1="14" x2="27" y2="14" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/><circle cx="14" cy="14" r="3.5" fill="${color}"/></svg>`;
    el.style.width        = '28px';
    el.style.height       = '28px';
    el.style.borderRadius = '0';
    el.style.background   = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}") center/contain no-repeat`;
    el.style.boxShadow    = 'none';
  } else {
    el.style.width        = '22px';
    el.style.height       = '22px';
    el.style.borderRadius = '50%';
    el.style.background   = `radial-gradient(circle at 35% 35%, ${_hexAdjust(color, 70)}, ${color} 55%, ${_hexAdjust(color, -30)})`;
    el.style.boxShadow    = `0 0 12px 6px ${color}80, 0 0 3px 1px ${_hexAdjust(color, 80)}d0`;
  }
}

function applyAllPointerStyles() {
  ['ss-laser', 'ss-pres-laser'].forEach(id => applyPointerStyle(document.getElementById(id)));
}

// ---- 描画ストローク共通ヘルパー ----
function renderStrokeOnCtx(ctx, stroke, scale) {
  const pts = stroke.points;
  if (!pts || pts.length < 2) return;
  ctx.save();
  if (stroke.tool === 'highlight') {
    ctx.globalAlpha = 0.35;
    ctx.lineWidth   = 18 * scale;
  } else {
    ctx.globalAlpha = 1;
    ctx.lineWidth   = 3 * scale;
  }
  ctx.strokeStyle = stroke.color;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0].x * scale, pts[0].y * scale);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * scale, pts[i].y * scale);
  ctx.stroke();
  ctx.restore();
}

// ---- 聴衆ウィンドウ初期化（#ss-audience ハッシュで開かれた場合） ----
function initAudienceMode() {
  ['ribbon','backstage','main','slideshow-overlay'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  document.body.style.cssText = 'background:#000;overflow:hidden;margin:0;';

  const stage = document.createElement('div');
  stage.id = 'aud-stage';
  stage.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#000;';

  const wrapper = document.createElement('div');
  wrapper.id = 'aud-wrapper';
  wrapper.style.cssText = 'position:relative;overflow:hidden;flex-shrink:0;box-shadow:0 0 80px rgba(0,0,0,0.9);';

  const frame = document.createElement('div');
  frame.id = 'aud-frame';
  frame.style.cssText = 'position:absolute;top:0;left:0;overflow:hidden;transform-origin:top left;';

  const audCanvas = document.createElement('canvas');
  audCanvas.id = 'aud-draw-canvas';
  audCanvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:50;';

  const laser = document.createElement('div');
  laser.id = 'aud-laser';
  laser.style.cssText = 'position:fixed;pointer-events:none;display:none;transform:translate(-50%,-50%);z-index:9999;';
  applyPointerStyle(laser);

  const waiting = document.createElement('div');
  waiting.id = 'aud-waiting';
  waiting.textContent = '発表者ウィンドウへ接続中...';
  waiting.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.4);font-size:16px;';

  wrapper.appendChild(frame);
  wrapper.appendChild(audCanvas);
  stage.appendChild(wrapper);
  document.body.appendChild(stage);
  document.body.appendChild(laser);
  document.body.appendChild(waiting);

  let audIndex   = 0;
  let audStrokes = [];

  function getAudScale() {
    const pw = parseInt(wrapper.style.width) || stage.clientWidth;
    return state.slideWidth ? pw / state.slideWidth : 1;
  }

  function renderAudStrokes() {
    const ctx   = audCanvas.getContext('2d');
    const scale = getAudScale();
    ctx.clearRect(0, 0, audCanvas.width, audCanvas.height);
    audStrokes.forEach(s => renderStrokeOnCtx(ctx, s, scale));
  }

  function renderAudSlide(ssIdx) {
    const list = getSsSlides();
    if (!list.length) return;
    audIndex = Math.max(0, Math.min(ssIdx, list.length - 1));
    const { slide } = list[audIndex];
    const effH = computeSlideHeight(slide);

    frame.style.width      = state.slideWidth + 'px';
    frame.style.height     = effH + 'px';
    frame.style.background = slide.bgColor;
    frame.innerHTML        = '';
    slide.elements.forEach(d => frame.appendChild(buildElement(d, { asGroupChild: true })));
    const _audChartAnimIds = new Set((slide.animations || []).filter(a => a.effect === '__chart__').map(a => a.elementId));
    playChartAnimations(frame, slide, _audChartAnimIds);

    const availW = stage.clientWidth;
    const availH = stage.clientHeight;
    const scale  = Math.min(availW / state.slideWidth, availH / effH);
    const pw = Math.round(state.slideWidth * scale);
    const ph = Math.round(effH * scale);
    wrapper.style.width  = pw + 'px';
    wrapper.style.height = ph + 'px';
    frame.style.transform = `scale(${scale})`;
    audCanvas.width  = pw;
    audCanvas.height = ph;
    renderAudStrokes();
  }

  const bc = new BroadcastChannel('slideshow-sync');
  bc.postMessage({ type: 'ready' });

  bc.onmessage = ({ data: msg }) => {
    switch (msg.type) {
      case 'init':
        waiting.style.display = 'none';
        loadProjectData(msg.projectData);
        audStrokes = [];
        renderAudSlide(msg.ssIndex);
        document.documentElement.requestFullscreen?.().catch(() => {});
        break;
      case 'goto':
        audStrokes = [];
        renderAudSlide(msg.ssIndex);
        break;
      case 'ink-add':
        audStrokes.push(msg.stroke);
        renderAudStrokes();
        break;
      case 'ink-clear':
        audStrokes = [];
        renderAudStrokes();
        break;
      case 'pointer-move': {
        if (!msg.active) { laser.style.display = 'none'; break; }
        const sw = parseInt(wrapper.style.width)  || stage.clientWidth;
        const sh = parseInt(wrapper.style.height) || stage.clientHeight;
        const ox = (stage.clientWidth  - sw) / 2;
        const oy = (stage.clientHeight - sh) / 2;
        laser.style.left    = (ox + msg.x * sw) + 'px';
        laser.style.top     = (oy + msg.y * sh) + 'px';
        laser.style.display = 'block';
        break;
      }
      case 'stop':
        window.close();
        break;
    }
  };

  window.addEventListener('resize', () => renderAudSlide(audIndex));
}

// ---- 聴衆ウィンドウを開く ----
function openAudienceWindow() {
  if (ssChannel) ssChannel.close();
  ssChannel = new BroadcastChannel('slideshow-sync');
  let initSent = false;
  ssChannel.onmessage = ({ data: msg }) => {
    if (msg.type === 'ready' && !initSent) {
      initSent = true;
      ssChannel.postMessage({
        type:        'init',
        projectData: getProjectData(),
        ssIndex:     ssState.currentIndex,
      });
    }
  };

  if (audienceWin && !audienceWin.closed) audienceWin.close();
  const url = location.href.split('#')[0] + '#ss-audience';
  audienceWin = window.open(url, 'ss-audience', 'width=1280,height=720,menubar=no,toolbar=no,status=no,scrollbars=no');
}

// ---- スライドショー開始 ----
function startSlideshow(fromStateIndex) {
  const list = getSsSlides();
  if (!list.length) return;

  let ssIdx = list.findIndex(x => x.stateIndex >= fromStateIndex);
  if (ssIdx < 0) ssIdx = 0;

  ssState.active       = true;
  ssState.currentIndex = ssIdx;
  ssState.activeTool   = null;
  ssState.devMode      = !!(document.getElementById('ss-use-devtools')?.checked);
  ssState.startTime    = Date.now();

  ssInk.strokes = [];
  ssInk.current = null;
  ssInk.drawing = false;

  const overlay = document.getElementById('slideshow-overlay');
  overlay.classList.add('active');
  overlay.classList.remove('pointer-mode', 'draw-mode', 'dev-mode');
  if (ssState.devMode) overlay.classList.add('dev-mode');

  ['ss-pointer-btn','ss-pen-btn','ss-hl-btn'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  document.getElementById('ss-laser').style.display = 'none';
  updateInkSwatchUI();

  if (ssState.devMode) {
    openAudienceWindow();
  } else {
    overlay.requestFullscreen?.().catch(() => {});
  }

  renderSlideshowSlide();
  startSsTimer();
}

// ---- スライドショー終了 ----
function stopSlideshow() {
  hideSsGrid();
  stopRecording();
  ssState.active = false;
  setActiveTool(null, true);
  clearInterval(ssState.timerInterval);
  ssState.timerInterval = null;

  const overlay = document.getElementById('slideshow-overlay');
  overlay.classList.remove('active', 'pointer-mode', 'draw-mode', 'dev-mode');
  document.getElementById('ss-laser').style.display = 'none';

  if (ssChannel) {
    ssChannel.postMessage({ type: 'stop' });
    ssChannel.close();
    ssChannel = null;
  }
  if (audienceWin && !audienceWin.closed) { audienceWin.close(); audienceWin = null; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ---- スライドを描画する汎用関数 ----
function renderToFrame(slide, frameId, wrapperId, areaId, opts = {}) {
  const frame   = document.getElementById(frameId);
  const wrapper = document.getElementById(wrapperId);
  const area    = document.getElementById(areaId);
  if (!frame || !wrapper || !area) return;

  if (!slide) {
    frame.innerHTML        = '';
    frame.style.background = '#111122';
    frame.style.width      = state.slideWidth + 'px';
    frame.style.height     = state.slideHeight + 'px';
    const msg = document.createElement('div');
    msg.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.25);font-size:14px;';
    msg.textContent = '（スライドなし）';
    frame.appendChild(msg);
    _scaleFrameToArea(frame, wrapper, area, state.slideWidth, state.slideHeight);
    return;
  }

  const effH = computeSlideHeight(slide);
  frame.style.width      = state.slideWidth + 'px';
  frame.style.height     = effH + 'px';
  frame.style.background = slide.bgColor;
  frame.innerHTML        = '';
  slide.elements.forEach(d => frame.appendChild(buildElement(d, { asGroupChild: true })));
  const _chartAnimIds = new Set((slide.animations || []).filter(a => a.effect === '__chart__').map(a => a.elementId));
  playChartAnimations(frame, slide, _chartAnimIds);
  _scaleFrameToArea(frame, wrapper, area, state.slideWidth, effH, opts);
}

function _scaleFrameToArea(frame, wrapper, area, slideW, slideH, opts = {}) {
  const availW = area.clientWidth;
  const availH = area.clientHeight;
  if (!availW || !availH) return;
  // WEBページ（autoHeight）モードは横幅基準でスケール、縦はスクロール
  const scale = opts.scrollMode ? availW / slideW : Math.min(availW / slideW, availH / slideH);
  wrapper.style.width  = Math.round(slideW * scale) + 'px';
  wrapper.style.height = Math.round(slideH * scale) + 'px';
  frame.style.transform       = `scale(${scale})`;
  frame.style.transformOrigin = 'top left';
}

// ---- 現在のスライドショー画面を描画 ----
function renderSlideshowSlide() {
  const list = getSsSlides();
  if (!list.length) return;

  const idx = Math.max(0, Math.min(ssState.currentIndex, list.length - 1));
  ssState.currentIndex = idx;
  const { slide } = list[idx];

  ssInk.strokes = [];
  ssInk.current = null;
  ssInk.drawing = false;
  ssAnimReset();

  if (ssState.devMode) {
    renderToFrame(slide, 'ss-pres-current-frame', 'ss-pres-current-wrapper', 'ss-pres-current-area', { scrollMode: true });
    ssUpdateDrawCanvas('ss-pres-draw-canvas', 'ss-pres-current-wrapper');
    ssAnimInit(slide, document.getElementById('ss-pres-current-frame'));

    const nextSlide = idx + 1 < list.length ? list[idx + 1].slide : null;
    renderToFrame(nextSlide, 'ss-pres-next-frame', 'ss-pres-next-wrapper', 'ss-pres-next-area');

    const notes = document.getElementById('ss-pres-notes');
    if (notes) notes.value = slide.notes || '';

    const sub = document.getElementById('ss-pres-counter-sub');
    if (sub) sub.textContent = `${idx + 1} / ${list.length}`;

    ssChannel?.postMessage({ type: 'goto', ssIndex: idx });
  } else {
    const overlay = document.getElementById('slideshow-overlay');
    const stage   = document.getElementById('ss-stage');
    overlay?.classList.add('web-scroll-mode');
    renderToFrame(slide, 'ss-slide-frame', 'ss-slide-wrapper', 'ss-stage', { scrollMode: true });
    if (stage) stage.scrollTop = 0;
    ssUpdateDrawCanvas('ss-draw-canvas', 'ss-slide-wrapper');
    ssAnimInit(slide, document.getElementById('ss-slide-frame'));
  }

  updateSsCounter();
}

function scaleSlideshowFrame() {
  if (!ssState.active) return;
  renderSlideshowSlide();
}

function updateSsCounter() {
  const list = getSsSlides();
  document.getElementById('ss-counter').textContent = `${ssState.currentIndex + 1} / ${list.length}`;
}

function ssNext() {
  if (ssAnim.running) return;
  // クリック時終了の無限ループをキャンセル（次の操作に進む前に停止）
  ssAnim._infiniteAnims.forEach(wa => { try { wa?.cancel(); } catch(_) {} });
  ssAnim._infiniteAnims = [];
  if (ssAnimHasMore()) {
    const frameEl = ssState.devMode
      ? document.getElementById('ss-pres-current-frame')
      : document.getElementById('ss-slide-frame');
    ssAnimPlayNext(frameEl);
  } else {
    const list = getSsSlides();
    if (ssState.currentIndex < list.length - 1) { ssState.currentIndex++; renderSlideshowSlide(); }
  }
}
function ssPrev() {
  if (ssState.currentIndex > 0) { ssState.currentIndex--; renderSlideshowSlide(); }
}

// ---- タイマー ----
function startSsTimer() {
  clearInterval(ssState.timerInterval);
  ssState.timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - ssState.startTime) / 1000);
    const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    const ts = `${m}:${s}`;

    const timerEl = document.getElementById('ss-pres-timer');
    if (timerEl) timerEl.textContent = ts;

    const devInfo = document.getElementById('ss-devinfo');
    if (devInfo) devInfo.textContent = ssState.devMode ? `⏱ ${ts}` : '';
  }, 1000);
}

// ---- 描画キャンバス操作 ----
function ssUpdateDrawCanvas(canvasId, wrapperId) {
  const canvas  = document.getElementById(canvasId);
  const wrapper = document.getElementById(wrapperId);
  if (!canvas || !wrapper) return;
  const pw = parseInt(wrapper.style.width)  || wrapper.clientWidth;
  const ph = parseInt(wrapper.style.height) || wrapper.clientHeight;
  canvas.width  = pw;
  canvas.height = ph;
  ssRenderAllStrokes(canvas, pw);
}

function ssRenderAllStrokes(canvas, wrapperPxW) {
  const ctx   = canvas.getContext('2d');
  const scale = wrapperPxW / state.slideWidth;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ssInk.strokes.forEach(s => renderStrokeOnCtx(ctx, s, scale));
  if (ssInk.current) renderStrokeOnCtx(ctx, ssInk.current, scale);
}

function getSsDrawCanvas() {
  return document.getElementById(ssState.devMode ? 'ss-pres-draw-canvas' : 'ss-draw-canvas');
}

function getSsDrawWrapper() {
  return document.getElementById(ssState.devMode ? 'ss-pres-current-wrapper' : 'ss-slide-wrapper');
}

function ssClientToSlide(clientX, clientY) {
  const wrapper = getSsDrawWrapper();
  if (!wrapper) return null;
  const rect  = wrapper.getBoundingClientRect();
  const scale = rect.width / state.slideWidth;
  return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
}

function ssStartDraw(e) {
  if (ssState.activeTool !== 'pen' && ssState.activeTool !== 'highlight') return;
  const wrapper = getSsDrawWrapper();
  if (!wrapper) return;
  const wr = wrapper.getBoundingClientRect();
  if (e.clientX < wr.left || e.clientX > wr.right || e.clientY < wr.top || e.clientY > wr.bottom) return;
  const pt    = ssClientToSlide(e.clientX, e.clientY);
  const tool  = ssState.activeTool;
  const color = tool === 'highlight' ? ssInk.colors.highlight : ssInk.colors.pen;
  ssInk.current = { tool, color, points: [pt] };
  ssInk.drawing = true;
}

function ssContinueDraw(e) {
  if (!ssInk.drawing || !ssInk.current) return;
  const pt = ssClientToSlide(e.clientX, e.clientY);
  if (!pt) return;
  ssInk.current.points.push(pt);
  const canvas  = getSsDrawCanvas();
  const wrapper = getSsDrawWrapper();
  if (canvas && wrapper) {
    const pw = parseInt(wrapper.style.width) || wrapper.clientWidth;
    ssRenderAllStrokes(canvas, pw);
  }
}

function ssEndDraw() {
  if (!ssInk.drawing || !ssInk.current) return;
  ssInk.strokes.push(ssInk.current);
  ssChannel?.postMessage({ type: 'ink-add', stroke: ssInk.current });
  ssInk.current = null;
  ssInk.drawing = false;
}

function ssClearInk() {
  ssInk.strokes = [];
  ssInk.current = null;
  ssInk.drawing = false;
  const canvas = getSsDrawCanvas();
  if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  ssChannel?.postMessage({ type: 'ink-clear' });
}

// ---- ツール切替 ----
function setActiveTool(tool, silent) {
  ssState.activeTool = tool;
  const overlay = document.getElementById('slideshow-overlay');
  document.getElementById('ss-pointer-btn')?.classList.toggle('active', tool === 'pointer');
  document.getElementById('ss-pen-btn')?.classList.toggle('active',     tool === 'pen');
  document.getElementById('ss-hl-btn')?.classList.toggle('active',      tool === 'highlight');
  overlay?.classList.toggle('pointer-mode', tool === 'pointer');
  overlay?.classList.toggle('draw-mode',    tool === 'pen' || tool === 'highlight');
  if (tool !== 'pointer') {
    document.getElementById('ss-laser').style.display      = 'none';
    document.getElementById('ss-pres-laser').style.display = 'none';
    if (!silent) ssChannel?.postMessage({ type: 'pointer-move', active: false });
  }
  updateInkSwatchUI();
}

function updateInkSwatchUI() {
  const wrap   = document.getElementById('ss-ink-color-wrap');
  const swatch = document.getElementById('ss-ink-swatch');
  const input  = document.getElementById('ss-ink-color');
  if (!wrap) return;
  const isDrawTool = ssState.activeTool === 'pen' || ssState.activeTool === 'highlight';
  wrap.style.opacity       = isDrawTool ? '1' : '0.4';
  wrap.style.pointerEvents = isDrawTool ? 'auto' : 'none';
  if (!isDrawTool) closeSsPalette();
  if (swatch && input) {
    const col = ssState.activeTool === 'highlight' ? ssInk.colors.highlight : ssInk.colors.pen;
    swatch.style.background = col;
    input.value = col;
    document.querySelectorAll('#ss-palette-grid .ss-palette-color').forEach(btn => {
      btn.classList.toggle('selected', btn.title === col);
    });
  }
}

// ---- すべてのスライドグリッド ----
function showSsGrid() {
  const grid  = document.getElementById('ss-slides-grid');
  const inner = document.getElementById('ss-slides-grid-inner');
  if (!grid || !inner) return;

  const list = getSsSlides();
  inner.innerHTML = '';

  list.forEach(({ slide }, idx) => {
    const cell = document.createElement('div');
    cell.className = 'ss-grid-cell' + (idx === ssState.currentIndex ? ' current' : '');

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'ss-grid-thumb';

    const thumbInner = document.createElement('div');
    const effH = computeSlideHeight(slide);
    thumbInner.style.cssText = [
      `width:${state.slideWidth}px;`,
      `height:${effH}px;`,
      `background:${slide.bgColor};`,
      'position:absolute;top:0;left:0;transform-origin:top left;transform:scale(0);',
    ].join('');
    slide.elements.forEach(d => thumbInner.appendChild(buildElement(d, { asGroupChild: true })));
    thumbWrap.appendChild(thumbInner);

    const label = document.createElement('div');
    label.className = 'ss-grid-label';
    label.textContent = `${idx + 1}`;

    cell.appendChild(thumbWrap);
    cell.appendChild(label);
    cell.addEventListener('click', () => {
      ssState.currentIndex = idx;
      renderSlideshowSlide();
      hideSsGrid();
    });
    inner.appendChild(cell);
  });

  grid.classList.add('visible');

  requestAnimationFrame(() => {
    inner.querySelectorAll('.ss-grid-thumb').forEach((wrap, i) => {
      const thumbInner = wrap.firstChild;
      if (!thumbInner) return;
      const { slide } = list[i];
      const sc = Math.min(
        wrap.clientWidth  / state.slideWidth,
        wrap.clientHeight / computeSlideHeight(slide)
      );
      thumbInner.style.transform = `scale(${sc})`;
    });
  });
}

function hideSsGrid() {
  document.getElementById('ss-slides-grid')?.classList.remove('visible');
}

// ---- 録画 ----
async function startRecording(fromIndex) {
  if (recState.active) return;
  const fps = parseInt(appSettings.get('recordingFps')) || 30;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 7680 }, height: { ideal: 4320 }, frameRate: { ideal: fps, max: fps } },
      audio: false,
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') alert('画面キャプチャーに失敗しました: ' + err.message);
    return;
  }

  recState.stream = stream;
  recState.chunks = [];
  const mimeType = ['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm','video/mp4']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
  recState.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  recState.recorder.ondataavailable = e => { if (e.data.size > 0) recState.chunks.push(e.data); };
  recState.recorder.onstop = async () => {
    const blob        = new Blob(recState.chunks, { type: recState.recorder.mimeType || 'video/webm' });
    const defaultName = 'slideshow_' + new Date().toISOString().replace(/[:.]/g, '-').slice(0,19) + '.webm';
    await saveFileWithPicker(blob, defaultName, [
      { description: '動画ファイル', accept: { 'video/webm': ['.webm'], 'video/mp4': ['.mp4'] } },
    ]);
    recState.active = false; recState.recorder = null; recState.stream = null; recState.chunks = [];
    updateRecordingUI();
  };
  stream.getVideoTracks()[0]?.addEventListener('ended', stopRecording);
  recState.recorder.start(1000);
  recState.active = true;
  updateRecordingUI();
  startSlideshow(fromIndex);
}

function stopRecording() {
  if (!recState.active || !recState.recorder) return;
  if (recState.recorder.state !== 'inactive') recState.recorder.stop();
  recState.stream?.getTracks().forEach(t => t.stop());
}

function updateRecordingUI() {
  document.getElementById('ss-rec-indicator')?.classList.toggle('recording', recState.active);
}

// ---- リボンボタン & F5 ----
document.getElementById('ss-from-start').addEventListener('click',   () => startSlideshow(0));
document.getElementById('ss-from-current').addEventListener('click', () => startSlideshow(state.currentSlide));
document.getElementById('ss-rec-from-start').addEventListener('click',   () => startRecording(0));
document.getElementById('ss-rec-from-current').addEventListener('click', () => startRecording(state.currentSlide));

document.addEventListener('keydown', (e) => {
  if (e.key === 'F5' && !ssState.active) {
    e.preventDefault();
    e.shiftKey ? startSlideshow(state.currentSlide) : startSlideshow(0);
  }
});

// ---- ツールバーボタン ----
document.getElementById('ss-exit-btn').addEventListener('click', stopSlideshow);
document.getElementById('ss-prev-btn').addEventListener('click',    (e) => { e.stopPropagation(); ssPrev(); });
document.getElementById('ss-next-btn').addEventListener('click',    (e) => { e.stopPropagation(); ssNext(); });
document.getElementById('ss-prev-tb-btn').addEventListener('click', (e) => { e.stopPropagation(); ssPrev(); });
document.getElementById('ss-next-tb-btn').addEventListener('click', (e) => { e.stopPropagation(); ssNext(); });

// ---- ツール切替ボタン ----
document.getElementById('ss-pointer-btn').addEventListener('click', () => {
  setActiveTool(ssState.activeTool === 'pointer' ? null : 'pointer');
});
document.getElementById('ss-pen-btn').addEventListener('click', () => {
  setActiveTool(ssState.activeTool === 'pen' ? null : 'pen');
});
document.getElementById('ss-hl-btn').addEventListener('click', () => {
  setActiveTool(ssState.activeTool === 'highlight' ? null : 'highlight');
});
document.getElementById('ss-eraser-btn').addEventListener('click', ssClearInk);

// ---- インクカラーパレット ----
const SS_PALETTE = [
  '#ffffff','#c0c0c0','#808080','#404040','#000000',
  '#ff3333','#ff8800','#ffee00','#44dd44','#00aa00',
  '#00dddd','#3399ff','#0033ff','#8800ee','#ff00cc',
  '#ff9999','#ffcc88','#ffff99','#99ffcc','#99ccff',
];

(function initInkPalette() {
  const grid = document.getElementById('ss-palette-grid');
  if (!grid) return;
  SS_PALETTE.forEach(color => {
    const btn = document.createElement('button');
    btn.className = 'ss-palette-color';
    btn.style.background = color;
    btn.title = color;
    btn.addEventListener('click', e => { e.stopPropagation(); setInkColor(color); closeSsPalette(); });
    grid.appendChild(btn);
  });
}());

function openSsPalette() { document.getElementById('ss-ink-palette')?.classList.add('open'); }
function closeSsPalette() { document.getElementById('ss-ink-palette')?.classList.remove('open'); }

document.getElementById('ss-ink-palette-btn')?.addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('ss-ink-palette')?.classList.toggle('open');
});

document.getElementById('ss-ink-custom-btn')?.addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('ss-ink-color')?.click();
});

document.getElementById('ss-ink-color')?.addEventListener('input', e => {
  setInkColor(e.target.value);
});
document.getElementById('ss-ink-color')?.addEventListener('change', () => closeSsPalette());

document.addEventListener('click', () => closeSsPalette());

function setInkColor(color) {
  if (ssState.activeTool === 'highlight') ssInk.colors.highlight = color;
  else ssInk.colors.pen = color;
  const swatch = document.getElementById('ss-ink-swatch');
  if (swatch) swatch.style.background = color;
  const input = document.getElementById('ss-ink-color');
  if (input) input.value = color;
  // Update selected state in grid
  document.querySelectorAll('#ss-palette-grid .ss-palette-color').forEach(btn => {
    btn.classList.toggle('selected', btn.title === color);
  });
}

// ---- すべてのスライドグリッドボタン ----
document.getElementById('ss-all-slides-btn').addEventListener('click', () => {
  const grid = document.getElementById('ss-slides-grid');
  grid?.classList.contains('visible') ? hideSsGrid() : showSsGrid();
});
document.getElementById('ss-slides-grid').addEventListener('click', (e) => {
  if (e.target === document.getElementById('ss-slides-grid')) hideSsGrid();
});

// ---- マウスイベント（描画 + ポインター） ----
const _ssOverlay = document.getElementById('slideshow-overlay');
_ssOverlay.addEventListener('mousedown', (e) => {
  if (ssState.activeTool !== 'pen' && ssState.activeTool !== 'highlight') return;
  if (document.getElementById('ss-slides-grid')?.classList.contains('visible')) return;
  e.preventDefault();
  ssStartDraw(e);
});
_ssOverlay.addEventListener('mousemove', (e) => {
  if (ssInk.drawing) { ssContinueDraw(e); return; }
  if (ssState.activeTool !== 'pointer') return;

  if (ssState.devMode) {
    const wrapper   = document.getElementById('ss-pres-current-wrapper');
    const presLaser = document.getElementById('ss-pres-laser');
    if (!wrapper || !presLaser) return;
    const rect = wrapper.getBoundingClientRect();
    const rx = (e.clientX - rect.left) / rect.width;
    const ry = (e.clientY - rect.top)  / rect.height;
    if (rx >= 0 && rx <= 1 && ry >= 0 && ry <= 1) {
      presLaser.style.display = 'block';
      presLaser.style.left = (rx * rect.width)  + 'px';
      presLaser.style.top  = (ry * rect.height) + 'px';
      ssChannel?.postMessage({ type: 'pointer-move', x: rx, y: ry, active: true });
    } else {
      presLaser.style.display = 'none';
      ssChannel?.postMessage({ type: 'pointer-move', active: false });
    }
  } else {
    const laser = document.getElementById('ss-laser');
    laser.style.display = 'block';
    laser.style.left    = e.clientX + 'px';
    laser.style.top     = e.clientY + 'px';
  }
});
_ssOverlay.addEventListener('mouseup',    ssEndDraw);
_ssOverlay.addEventListener('mouseleave', ssEndDraw);

// ---- クリックで次へ ----
document.getElementById('ss-stage').addEventListener('click', () => {
  if (!ssState.activeTool) ssNext();
});
document.getElementById('ss-pres-current-area').addEventListener('click', () => {
  if (!ssState.activeTool) ssNext();
});

// ---- キーボード ----
document.addEventListener('keydown', (e) => {
  if (!ssState.active) return;
  const inTextarea = e.target instanceof HTMLTextAreaElement;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case ' ':
      if (!inTextarea) { e.preventDefault(); ssNext(); }
      break;
    case 'ArrowLeft': case 'ArrowUp':
      if (!inTextarea) { e.preventDefault(); ssPrev(); }
      break;
    case 'Escape':
      if (document.getElementById('ss-slides-grid')?.classList.contains('visible')) {
        hideSsGrid();
      } else {
        stopSlideshow();
      }
      break;
    case 'p': case 'P':
      if (!inTextarea) document.getElementById('ss-pointer-btn').click();
      break;
    case 'b': case 'B':
      if (!inTextarea) document.getElementById('ss-pen-btn').click();
      break;
    case 'h': case 'H':
      if (!inTextarea) document.getElementById('ss-hl-btn').click();
      break;
    case 'e': case 'E':
      if (!inTextarea) ssClearInk();
      break;
    case 'g': case 'G':
      if (!inTextarea) document.getElementById('ss-all-slides-btn').click();
      break;
    case 'f': case 'F':
      if (!inTextarea) {
        document.fullscreenElement
          ? document.exitFullscreen().catch(() => {})
          : document.getElementById('slideshow-overlay').requestFullscreen?.().catch(() => {});
      }
      break;
  }
});

// ---- メモ自動保存 ----
document.getElementById('ss-pres-notes').addEventListener('input', (e) => {
  const list = getSsSlides();
  if (!list.length) return;
  list[ssState.currentIndex].slide.notes = e.target.value;
  markDirty();
});

// ---- リサイズ / フルスクリーン変更 ----
document.addEventListener('fullscreenchange', () => { if (ssState.active) scaleSlideshowFrame(); });
window.addEventListener('resize',             () => { if (ssState.active) scaleSlideshowFrame(); });

// ---- 聴衆モード検出（init() 実行後に判定） ----
if (location.hash === '#ss-audience') initAudienceMode();

// ===== メモパネル =====

// メモ入力 → 現在スライドに保存
document.getElementById('notes-textarea').addEventListener('input', (e) => {
  const slide = getCurrentSlideData();
  if (slide) { slide.notes = e.target.value; markDirty(); }
});

// リサイズハンドルのドラッグ
(function () {
  const panel  = document.getElementById('notes-panel');
  const handle = document.getElementById('notes-resize-handle');
  let dragging = false;
  let startY   = 0;
  let startH   = 0;

  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startY   = e.clientY;
    startH   = panel.offsetHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // ハンドルを上に引くと高さが増える
    const newH = Math.max(36, Math.min(400, startH - (e.clientY - startY)));
    panel.style.height = newH + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}());

// ===== オプション設定 =====
(function initOptionsPane() {
  // FPS
  const fpsEl = document.getElementById('opt-recording-fps');
  if (fpsEl) {
    fpsEl.value = appSettings.get('recordingFps');
    fpsEl.addEventListener('change', () => appSettings.set('recordingFps', parseInt(fpsEl.value)));
  }

  // ポインターの色パレット
  (function initPointerColorPalette() {
    const grid    = document.getElementById('opt-pointer-palette-grid');
    const swatch  = document.getElementById('opt-pointer-color-swatch');
    const label   = document.getElementById('opt-pointer-color-label');
    const input   = document.getElementById('opt-pointer-color');
    const palette = document.getElementById('opt-pointer-color-palette');
    const trigger = document.getElementById('opt-pointer-color-btn');
    if (!grid) return;

    function setPointerColor(color) {
      appSettings.set('pointerColor', color);
      if (swatch) swatch.style.background = color;
      if (label)  label.textContent = color;
      if (input)  input.value = color;
      document.querySelectorAll('#opt-pointer-palette-grid .ss-palette-color').forEach(b => {
        b.classList.toggle('selected', b.title === color);
      });
      applyAllPointerStyles();
    }

    SS_PALETTE.forEach(color => {
      const btn = document.createElement('button');
      btn.className = 'ss-palette-color';
      btn.style.background = color;
      btn.title = color;
      btn.addEventListener('click', e => { e.stopPropagation(); setPointerColor(color); palette?.classList.remove('open'); });
      grid.appendChild(btn);
    });

    trigger?.addEventListener('click', e => { e.stopPropagation(); palette?.classList.toggle('open'); });
    document.getElementById('opt-pointer-custom-color-btn')?.addEventListener('click', e => { e.stopPropagation(); input?.click(); });
    input?.addEventListener('input',  e => setPointerColor(e.target.value));
    input?.addEventListener('change', () => palette?.classList.remove('open'));
    document.addEventListener('click', () => palette?.classList.remove('open'));

    setPointerColor(appSettings.get('pointerColor') || '#ff2020');
  }());

  // ポインターの形
  const shapeInputs = document.querySelectorAll('input[name="pointer-shape"]');
  function updateShapePreviews(val) {
    document.querySelectorAll('.opt-shape-preview').forEach(p => p.classList.remove('selected'));
    const active = document.getElementById('opt-shape-prev-' + val);
    if (active) active.classList.add('selected');
    const customRow = document.getElementById('opt-pointer-custom-row');
    if (customRow) customRow.style.display = val === 'custom' ? 'flex' : 'none';
  }
  shapeInputs.forEach(el => {
    if (el.value === appSettings.get('pointerShape')) el.checked = true;
    el.addEventListener('change', () => {
      if (!el.checked) return;
      appSettings.set('pointerShape', el.value);
      updateShapePreviews(el.value);
      applyAllPointerStyles();
    });
  });
  updateShapePreviews(appSettings.get('pointerShape'));

  // クリックで shape ラベル全体を選択
  document.querySelectorAll('.opt-shape-label').forEach(label => {
    label.addEventListener('click', () => {
      const radio = label.querySelector('input[type="radio"]');
      if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
    });
  });

  // カスタム画像
  const uploadBtn  = document.getElementById('opt-pointer-upload-btn');
  const uploadInput = document.getElementById('opt-pointer-upload');
  const preview     = document.getElementById('opt-pointer-preview');
  uploadBtn?.addEventListener('click', () => uploadInput?.click());
  uploadInput?.addEventListener('change', () => {
    const file = uploadInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const url = e.target.result;
      appSettings.set('pointerImageUrl', url);
      if (preview) { preview.src = url; preview.style.display = 'block'; }
      applyAllPointerStyles();
    };
    reader.readAsDataURL(file);
  });
  const existingUrl = appSettings.get('pointerImageUrl');
  if (existingUrl && preview) { preview.src = existingUrl; preview.style.display = 'block'; }
}());

// ポインタースタイルを起動時に適用
applyAllPointerStyles();

// ===== ファイル保存ショートカット =====
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (e.shiftKey) saveAs(); else save();
  }
});

// ===== 未保存警告 =====
window.addEventListener('beforeunload', (e) => {
  if (isDirty) { e.preventDefault(); e.returnValue = ''; }
});

// ===== アニメーション システム =====

const ANIM_ICONS = {
  'appear':      `<polygon points="11,2 12.8,8.5 19.2,8.5 13.8,12.5 15.8,19 11,15.3 6.2,19 8.2,12.5 2.8,8.5 9.2,8.5" fill="currentColor"/>`,
  'fade-in':     `<rect x="1" y="7" width="5" height="8" rx="1" fill="currentColor" opacity=".2"/><rect x="8" y="7" width="5" height="8" rx="1" fill="currentColor" opacity=".55"/><rect x="15" y="7" width="6" height="8" rx="1" fill="currentColor" opacity=".9"/>`,
  'fly-in':      `<path d="M4 11 L15 11 M11 7 L15 11 L11 15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><rect x="1" y="8.5" width="4" height="5" rx="1" fill="currentColor" opacity=".45"/>`,
  'zoom-in':     `<circle cx="11" cy="11" r="9" stroke="currentColor" stroke-width="1.5" fill="none" opacity=".2"/><circle cx="11" cy="11" r="5" stroke="currentColor" stroke-width="1.5" fill="none" opacity=".5"/><circle cx="11" cy="11" r="2.5" fill="currentColor"/>`,
  'wipe-in':     `<rect x="2" y="5" width="18" height="12" rx="2" fill="currentColor" opacity=".15"/><rect x="2" y="5" width="9" height="12" rx="2" fill="currentColor" opacity=".8"/><line x1="11" y1="3" x2="11" y2="19" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2,2" opacity=".7"/>`,
  'bounce-in':   `<path d="M11 13 Q16 5 11 2 Q6 5 11 13" fill="currentColor" opacity=".4"/><circle cx="11" cy="17" r="4" fill="currentColor"/><line x1="5" y1="21" x2="17" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".4"/>`,
  'split-in':    `<rect x="2" y="2" width="18" height="6" rx="1" fill="currentColor" opacity=".75"/><rect x="2" y="14" width="18" height="6" rx="1" fill="currentColor" opacity=".75"/><rect x="5" y="9" width="12" height="4" rx="1" fill="currentColor" opacity=".2"/>`,
  'pulse':       `<circle cx="11" cy="11" r="3" fill="currentColor"/><circle cx="11" cy="11" r="6" stroke="currentColor" stroke-width="2" fill="none" opacity=".5"/><circle cx="11" cy="11" r="9.5" stroke="currentColor" stroke-width="1.5" fill="none" opacity=".2"/>`,
  'spin':        `<path d="M11 2 A9 9 0 1 1 2.5 14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/><polygon points="11,0 8,5 14,5" fill="currentColor"/>`,
  'shake':       `<rect x="6" y="6" width="10" height="10" rx="2" fill="currentColor"/><path d="M1 9 L4 9 M1 13 L4 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".5"/><path d="M18 9 L21 9 M18 13 L21 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".5"/>`,
  'flash':       `<path d="M13 2 L7 12 H11 L9 20 L17 10 H13 Z" fill="currentColor"/>`,
  'color-pulse': `<circle cx="11" cy="11" r="9" fill="currentColor" opacity=".18"/><circle cx="11" cy="11" r="6" fill="currentColor" opacity=".45"/><circle cx="11" cy="11" r="3" fill="currentColor"/>`,
  'disappear':   `<circle cx="11" cy="11" r="3.5" fill="currentColor" opacity=".18"/><circle cx="5.5" cy="7" r="2.5" fill="currentColor" opacity=".35"/><circle cx="16.5" cy="6.5" r="1.8" fill="currentColor" opacity=".25"/><circle cx="5" cy="15.5" r="1.2" fill="currentColor" opacity=".18"/><circle cx="17" cy="16" r="1" fill="currentColor" opacity=".12"/><circle cx="11" cy="4" r="1" fill="currentColor" opacity=".2"/>`,
  'fade-out':    `<rect x="1" y="7" width="5" height="8" rx="1" fill="currentColor" opacity=".9"/><rect x="8" y="7" width="5" height="8" rx="1" fill="currentColor" opacity=".55"/><rect x="15" y="7" width="6" height="8" rx="1" fill="currentColor" opacity=".2"/>`,
  'fly-out':     `<path d="M18 11 L7 11 M11 7 L7 11 L11 15" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><rect x="17" y="8.5" width="4" height="5" rx="1" fill="currentColor" opacity=".45"/>`,
  'zoom-out':    `<circle cx="11" cy="11" r="9" stroke="currentColor" stroke-width="2" fill="none" opacity=".75"/><circle cx="11" cy="11" r="5" stroke="currentColor" stroke-width="1.5" fill="none" opacity=".45"/><circle cx="11" cy="11" r="2.5" fill="currentColor" opacity=".25"/><line x1="8" y1="11" x2="14" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
  'float-in':    `<path d="M11 4 L11 14 M7 8 L11 4 L15 8" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><rect x="5" y="15" width="12" height="4" rx="1" fill="currentColor" opacity=".65"/>`,
  'wheel-in':    `<circle cx="11" cy="11" r="9" stroke="currentColor" stroke-width="1" fill="none" opacity=".2"/><path d="M11 11 L11 2 A9 9 0 0 1 19.8 14 Z" fill="currentColor" opacity=".8"/><path d="M11 11 L19.8 14 A9 9 0 0 1 2.2 14 Z" fill="currentColor" opacity=".45"/><path d="M11 11 L2.2 14 A9 9 0 0 1 11 2 Z" fill="currentColor" opacity=".2"/>`,
  'random-bars-in': `<rect x="2" y="2" width="18" height="3" rx="1" fill="currentColor"/><rect x="2" y="7" width="18" height="3" rx="1" fill="currentColor" opacity=".25"/><rect x="2" y="12" width="18" height="3" rx="1" fill="currentColor" opacity=".75"/><rect x="2" y="17" width="18" height="3" rx="1" fill="currentColor" opacity=".45"/>`,
  'stretch-in':  `<rect x="9.5" y="3" width="3" height="16" rx="1" fill="currentColor" opacity=".2"/><rect x="3" y="7" width="16" height="8" rx="2" fill="currentColor"/><line x1="1" y1="11" x2="4" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".5"/><line x1="18" y1="11" x2="21" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".5"/>`,
  'teeter':      `<rect x="7" y="5" width="8" height="10" rx="1" fill="currentColor" opacity=".35" transform="rotate(-10 11 11)"/><rect x="7" y="5" width="8" height="10" rx="1" fill="currentColor" transform="rotate(10 11 11)" opacity=".35"/><rect x="7.5" y="5.5" width="7" height="9" rx="1" fill="currentColor"/><line x1="3" y1="20" x2="19" y2="20" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".45"/>`,
  'grow-shrink': `<rect x="6" y="6" width="10" height="10" rx="1" stroke="currentColor" stroke-width="1.5" fill="none" opacity=".3"/><rect x="2" y="2" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2" fill="none" opacity=".6"/><rect x="8.5" y="8.5" width="5" height="5" rx="0.5" fill="currentColor"/>`,
  'bold-flash':  `<rect x="2" y="4" width="14" height="3" rx="1.5" fill="currentColor"/><rect x="2" y="9" width="11" height="3" rx="1.5" fill="currentColor" opacity=".65"/><rect x="2" y="14" width="14" height="3" rx="1.5" fill="currentColor" opacity=".35"/><path d="M17 4 L21 11 L17 18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity=".8"/>`,
  'float-out':   `<path d="M11 8 L11 18 M7 14 L11 18 L15 14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><rect x="5" y="2" width="12" height="4" rx="1" fill="currentColor" opacity=".65"/>`,
  'wipe-out':    `<rect x="2" y="5" width="18" height="12" rx="2" fill="currentColor" opacity=".15"/><rect x="11" y="5" width="9" height="12" rx="2" fill="currentColor" opacity=".8"/><line x1="11" y1="3" x2="11" y2="19" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2,2" opacity=".65"/>`,
  'split-out':   `<rect x="2" y="2" width="18" height="5" rx="1" fill="currentColor" opacity=".75"/><rect x="2" y="15" width="18" height="5" rx="1" fill="currentColor" opacity=".75"/><rect x="5" y="9" width="12" height="4" rx="1" fill="currentColor" opacity=".18"/>`,
  'bounce-out':  `<circle cx="11" cy="7" r="4.5" fill="currentColor"/><path d="M7 13 Q11 20 15 13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" opacity=".6"/><line x1="5" y1="21" x2="17" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity=".4"/>`,
};

const ANIM_EFFECTS = [
  // 開始
  { id: 'appear',      label: 'アピール',       cat: 'in',  color: '#3a9c3a', hasDir: false },
  { id: 'fade-in',     label: 'フェード',        cat: 'in',  color: '#3a9c3a', hasDir: false },
  { id: 'fly-in',      label: 'フライイン',      cat: 'in',  color: '#3a9c3a', hasDir: true,
    dirs: [['from-bottom','下から'],['from-top','上から'],['from-left','左から'],['from-right','右から']] },
  { id: 'zoom-in',     label: 'ズーム',          cat: 'in',  color: '#3a9c3a', hasDir: false },
  { id: 'wipe-in',     label: 'ワイプ',          cat: 'in',  color: '#3a9c3a', hasDir: true,
    dirs: [['from-left','左から'],['from-right','右から'],['from-top','上から'],['from-bottom','下から']] },
  { id: 'bounce-in',   label: 'バウンド',        cat: 'in',  color: '#3a9c3a', hasDir: false },
  { id: 'split-in',    label: 'スプリット',      cat: 'in',  color: '#3a9c3a', hasDir: false },
  { id: 'float-in',    label: 'フロート',         cat: 'in',  color: '#3a9c3a', hasDir: true,
    dirs: [['from-bottom','下から'],['from-top','上から']] },
  { id: 'wheel-in',    label: 'ホイール',         cat: 'in',  color: '#3a9c3a', hasDir: false },
  { id: 'random-bars-in', label: 'ランダムストライプ', cat: 'in', color: '#3a9c3a', hasDir: false },
  { id: 'stretch-in',  label: 'ストレッチ',       cat: 'in',  color: '#3a9c3a', hasDir: false },
  // 強調
  { id: 'pulse',       label: 'パルス',          cat: 'em',  color: '#c87800', hasDir: false },
  { id: 'spin',        label: 'スピン',          cat: 'em',  color: '#c87800', hasDir: false },
  { id: 'shake',       label: 'シェイク',        cat: 'em',  color: '#c87800', hasDir: false },
  { id: 'flash',       label: 'フラッシュ',      cat: 'em',  color: '#c87800', hasDir: false },
  { id: 'color-pulse', label: 'カラーパルス',    cat: 'em',  color: '#c87800', hasDir: false },
  { id: 'teeter',      label: 'ティーター',       cat: 'em',  color: '#c87800', hasDir: false },
  { id: 'grow-shrink', label: '拡大/縮小',        cat: 'em',  color: '#c87800', hasDir: false },
  { id: 'bold-flash',  label: '太字フラッシュ',   cat: 'em',  color: '#c87800', hasDir: false },
  // 終了
  { id: 'disappear',   label: '消失',            cat: 'out', color: '#c0392b', hasDir: false },
  { id: 'fade-out',    label: 'フェードアウト',  cat: 'out', color: '#c0392b', hasDir: false },
  { id: 'fly-out',     label: 'フライアウト',    cat: 'out', color: '#c0392b', hasDir: true,
    dirs: [['to-bottom','下へ'],['to-top','上へ'],['to-left','左へ'],['to-right','右へ']] },
  { id: 'zoom-out',    label: 'ズームアウト',    cat: 'out', color: '#c0392b', hasDir: false },
  { id: 'float-out',   label: 'フロートアウト',   cat: 'out', color: '#c0392b', hasDir: true,
    dirs: [['to-bottom','下へ'],['to-top','上へ']] },
  { id: 'wipe-out',    label: 'ワイプアウト',     cat: 'out', color: '#c0392b', hasDir: true,
    dirs: [['to-right','右へ'],['to-left','左へ'],['to-top','上へ'],['to-bottom','下へ']] },
  { id: 'split-out',   label: 'スプリットアウト', cat: 'out', color: '#c0392b', hasDir: false },
  { id: 'bounce-out',  label: 'バウンドアウト',   cat: 'out', color: '#c0392b', hasDir: false },
];

function getAnimEffectDef(id) { return ANIM_EFFECTS.find(e => e.id === id); }

const ANIM_CAT_ENTRANCE = new Set(['appear','fade-in','fly-in','zoom-in','wipe-in','bounce-in','split-in','float-in','wheel-in','random-bars-in','stretch-in']);
const ANIM_CAT_EXIT     = new Set(['disappear','fade-out','fly-out','zoom-out','float-out','wipe-out','split-out','bounce-out']);

// ---- 表アニメーション定義 ----
const TBL_ANIM_EFFECTS = [
  // 開始（出現）
  { id: 'tbl-row-fade',    label: '行ごとフェード',      unit: 'rows',  kf: 'fade',  cat: 'tbl-in', color: '#74c7ec' },
  { id: 'tbl-col-fade',    label: '列ごとフェード',      unit: 'cols',  kf: 'fade',  cat: 'tbl-in', color: '#74c7ec' },
  { id: 'tbl-cell-fade',   label: 'セルごとフェード',    unit: 'cells', kf: 'fade',  cat: 'tbl-in', color: '#74c7ec' },
  { id: 'tbl-row-fly',     label: '行ごとフライイン',    unit: 'rows',  kf: 'fly',   cat: 'tbl-in', color: '#89dceb' },
  { id: 'tbl-col-fly',     label: '列ごとフライイン',    unit: 'cols',  kf: 'fly',   cat: 'tbl-in', color: '#89dceb' },
  { id: 'tbl-cell-fly',    label: 'セルごとフライイン',  unit: 'cells', kf: 'fly',   cat: 'tbl-in', color: '#89dceb' },
  { id: 'tbl-row-wipe',    label: '行ごとワイプ',        unit: 'rows',  kf: 'wipe',  cat: 'tbl-in', color: '#94e2d5' },
  { id: 'tbl-col-wipe',    label: '列ごとワイプ',        unit: 'cols',  kf: 'wipe',  cat: 'tbl-in', color: '#94e2d5' },
  // 強調（目立たせる）
  { id: 'tbl-row-hl',      label: '行ハイライト',        unit: 'rows',  kf: 'hl',    cat: 'tbl-em', color: '#f9e2af', defaultHl: '#f9e2af' },
  { id: 'tbl-col-hl',      label: '列ハイライト',        unit: 'cols',  kf: 'hl',    cat: 'tbl-em', color: '#f9e2af', defaultHl: '#f9e2af' },
  { id: 'tbl-cell-hl',     label: 'セルハイライト',      unit: 'cells', kf: 'hl',    cat: 'tbl-em', color: '#f9e2af', defaultHl: '#f9e2af' },
  { id: 'tbl-row-flash',   label: '行フラッシュ',        unit: 'rows',  kf: 'flash', cat: 'tbl-em', color: '#fab387' },
  { id: 'tbl-col-flash',   label: '列フラッシュ',        unit: 'cols',  kf: 'flash', cat: 'tbl-em', color: '#fab387' },
  { id: 'tbl-cell-flash',  label: 'セルフラッシュ',      unit: 'cells', kf: 'flash', cat: 'tbl-em', color: '#fab387' },
  { id: 'tbl-row-pop',     label: '行ポップ',            unit: 'rows',  kf: 'pop',   cat: 'tbl-em', color: '#cba6f7', defaultHl: '#cba6f7' },
  { id: 'tbl-col-pop',     label: '列ポップ',            unit: 'cols',  kf: 'pop',   cat: 'tbl-em', color: '#cba6f7', defaultHl: '#cba6f7' },
  { id: 'tbl-cell-pop',    label: 'セルポップ',          unit: 'cells', kf: 'pop',   cat: 'tbl-em', color: '#cba6f7', defaultHl: '#cba6f7' },
];
const TBL_ANIM_IDS = new Set(TBL_ANIM_EFFECTS.map(e => e.id));
function getTblAnimDef(id) { return TBL_ANIM_EFFECTS.find(e => e.id === id); }
function _hexToRgba(hex, a) {
  const v = hex.replace('#','');
  const r = parseInt(v.slice(0,2),16), g = parseInt(v.slice(2,4),16), b = parseInt(v.slice(4,6),16);
  return `rgba(${r},${g},${b},${a})`;
}

function buildAnimKeyframes(animData) {
  const dir = animData.direction || '';
  switch (animData.effect) {
    case 'appear':
      return { kf: [{opacity:0},{opacity:1}], dur: 0 };
    case 'fade-in':
      return { kf: [{opacity:0},{opacity:1}], easing: 'ease-out' };
    case 'fade-out':
      return { kf: [{opacity:1},{opacity:0}], easing: 'ease-in' };
    case 'fly-in': {
      const t = {'from-bottom':'translateY(80px)','from-top':'translateY(-80px)',
                 'from-left':'translateX(-80px)','from-right':'translateX(80px)'}[dir] || 'translateY(80px)';
      return { kf: [{opacity:0,transform:t},{opacity:1,transform:'translate(0,0)'}], easing: 'ease-out' };
    }
    case 'fly-out': {
      const t = {'to-bottom':'translateY(80px)','to-top':'translateY(-80px)',
                 'to-left':'translateX(-80px)','to-right':'translateX(80px)'}[dir] || 'translateY(80px)';
      return { kf: [{opacity:1,transform:'translate(0,0)'},{opacity:0,transform:t}], easing: 'ease-in' };
    }
    case 'zoom-in':
      return { kf: [{opacity:0,transform:'scale(0.1)'},{opacity:1,transform:'scale(1)'}],
               easing: 'cubic-bezier(0.175,0.885,0.32,1.275)' };
    case 'zoom-out':
      return { kf: [{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(0.1)'}], easing: 'ease-in' };
    case 'wipe-in': {
      const c = {'from-left':['inset(0 100% 0 0)','inset(0 0% 0 0)'],
                 'from-right':['inset(0 0 0 100%)','inset(0 0 0 0%)'],
                 'from-top':['inset(100% 0 0 0)','inset(0% 0 0 0)'],
                 'from-bottom':['inset(0 0 100% 0)','inset(0 0 0% 0)']}[dir] || ['inset(0 100% 0 0)','inset(0 0% 0 0)'];
      return { kf: [{clipPath:c[0]},{clipPath:c[1]}], easing: 'ease-out' };
    }
    case 'bounce-in':
      return { kf: [{opacity:0,transform:'scale(0.3)'},{opacity:1,transform:'scale(1.15)',offset:0.6},
                    {transform:'scale(0.92)',offset:0.8},{transform:'scale(1)'}], easing: 'ease-out' };
    case 'split-in':
      return { kf: [{clipPath:'inset(50% 0 50% 0)'},{clipPath:'inset(0% 0 0% 0)'}], easing: 'ease-out' };
    case 'pulse':
      return { kf: [{transform:'scale(1)'},{transform:'scale(1.3)',offset:0.5},{transform:'scale(1)'}], easing: 'ease-in-out' };
    case 'spin':
      return { kf: [{transform:'rotate(0deg)'},{transform:'rotate(360deg)'}], easing: 'linear' };
    case 'shake':
      return { kf: [{transform:'translateX(0)'},{transform:'translateX(-8px)',offset:0.15},
                    {transform:'translateX(8px)',offset:0.35},{transform:'translateX(-8px)',offset:0.55},
                    {transform:'translateX(8px)',offset:0.75},{transform:'translateX(-5px)',offset:0.9},
                    {transform:'translateX(0)'}], easing: 'linear' };
    case 'flash':
      return { kf: [{opacity:1},{opacity:0,offset:0.25},{opacity:1,offset:0.5},{opacity:0,offset:0.75},{opacity:1}], easing: 'linear' };
    case 'color-pulse':
      return { kf: [{filter:'brightness(1)'},{filter:'brightness(2)',offset:0.5},{filter:'brightness(1)'}], easing: 'ease-in-out' };
    case 'float-in': {
      const ft = dir === 'from-top' ? 'translateY(-30px)' : 'translateY(30px)';
      return { kf: [{opacity:0,transform:ft},{opacity:1,transform:'translateY(0)'}], easing:'ease-out' };
    }
    case 'float-out': {
      const ft = dir === 'to-top' ? 'translateY(-30px)' : 'translateY(30px)';
      return { kf: [{opacity:1,transform:'translateY(0)'},{opacity:0,transform:ft}], easing:'ease-in' };
    }
    case 'wheel-in':
      return { kf: [{opacity:0,transform:'rotate(-90deg) scale(0.5)'},{opacity:1,transform:'rotate(0deg) scale(1)'}], easing:'ease-out' };
    case 'random-bars-in':
      return { kf: [{transform:'scaleY(0.04)',opacity:0},{transform:'scaleY(1)',opacity:1}], easing:'ease-out' };
    case 'stretch-in':
      return { kf: [{transform:'scaleX(0)'},{transform:'scaleX(1)'}], easing:'cubic-bezier(0.175,0.885,0.32,1.275)' };
    case 'teeter':
      return { kf: [{transform:'rotate(0deg)'},{transform:'rotate(-8deg)',offset:0.2},
                    {transform:'rotate(8deg)',offset:0.5},{transform:'rotate(-4deg)',offset:0.8},
                    {transform:'rotate(0deg)'}], easing:'ease-in-out' };
    case 'grow-shrink':
      return { kf: [{transform:'scale(1)'},{transform:'scale(1.5)',offset:0.5},{transform:'scale(1)'}], easing:'ease-in-out' };
    case 'bold-flash':
      return { kf: [{filter:'brightness(1)'},{filter:'brightness(3.5)',offset:0.25},{filter:'brightness(1)',offset:0.5},
                    {filter:'brightness(3.5)',offset:0.75},{filter:'brightness(1)'}], easing:'linear' };
    case 'wipe-out': {
      const wc = {'to-right':['inset(0 0% 0 0)','inset(0 100% 0 0)'],
                  'to-left':['inset(0 0 0 0%)','inset(0 0 0 100%)'],
                  'to-top':['inset(0% 0 0 0)','inset(100% 0 0 0)'],
                  'to-bottom':['inset(0 0 0% 0)','inset(0 0 100% 0)']}[dir] || ['inset(0 0% 0 0)','inset(0 100% 0 0)'];
      return { kf: [{clipPath:wc[0]},{clipPath:wc[1]}], easing:'ease-in' };
    }
    case 'split-out':
      return { kf: [{clipPath:'inset(0% 0 0% 0)'},{clipPath:'inset(50% 0 50% 0)'}], easing:'ease-in' };
    case 'bounce-out':
      return { kf: [{opacity:1,transform:'scale(1)'},{transform:'scale(1.1)',offset:0.2},
                    {transform:'scale(0.95)',offset:0.4},{opacity:1,transform:'scale(1.05)',offset:0.6},
                    {opacity:0,transform:'scale(0)'}], easing:'ease-in' };
    case 'disappear':
      return { kf: [{opacity:1},{opacity:0}], dur: 0 };
    default:
      return null;
  }
}

function playAnimEffect(el, animData, { onComplete, iterations } = {}) {
  const def = buildAnimKeyframes(animData);
  if (!def) { onComplete?.(); return null; }
  const isEntrance = ANIM_CAT_ENTRANCE.has(animData.effect);
  const isExit     = ANIM_CAT_EXIT.has(animData.effect);
  if (isEntrance) el.style.visibility = 'visible';
  const msec = def.dur !== undefined ? def.dur : (animData.duration || 0.5) * 1000;
  if (msec === 0) {
    el.style.visibility = isExit ? 'hidden' : 'visible';
    onComplete?.(); return null;
  }
  const iter = iterations !== undefined ? iterations : 1;
  const wa = el.animate(def.kf, { duration: msec, easing: def.easing || 'ease-out', fill: 'forwards', iterations: iter });
  if (iter === Infinity) {
    wa.onfinish = () => { if (isExit) el.style.visibility = 'hidden'; };
  } else {
    wa.onfinish = () => { if (isExit) el.style.visibility = 'hidden'; onComplete?.(); };
  }
  return wa;
}

// ---- 表アニメーション ----
function _tblAnimGetUnits(el, def, tableTarget) {
  if (!def) return [];
  const tgt = tableTarget && tableTarget.length > 0 ? tableTarget : null;
  if (def.unit === 'rows') {
    const allRows = [...el.querySelectorAll('tbody tr')];
    const indices = tgt ?? allRows.map((_, i) => i);
    return indices
      .filter(i => i < allRows.length)
      .sort((a, b) => a - b)
      .map(i => [...allRows[i].querySelectorAll('td')])
      .filter(tds => tds.length);
  }
  if (def.unit === 'cols') {
    const colCount = el.querySelector('colgroup')?.children?.length || 0;
    const indices = tgt ?? Array.from({ length: colCount }, (_, i) => i);
    return indices
      .filter(i => i < colCount)
      .sort((a, b) => a - b)
      .map(c => [...el.querySelectorAll(`td[data-col="${c}"]`)])
      .filter(tds => tds.length);
  }
  if (def.unit === 'cells') {
    if (tgt) {
      return tgt
        .map(({ row, col }) => {
          const td = el.querySelector(`td[data-row="${row}"][data-col="${col}"]`);
          return td ? [td] : [];
        })
        .filter(tds => tds.length);
    }
    return [...el.querySelectorAll('td')].map(td => [td]);
  }
  return [];
}

function _tblAnimKeyframes(kf, hlColor) {
  if (kf === 'fade') return { mode: 'in', start: [{opacity:0}], end: [{opacity:1}] };
  if (kf === 'fly')  return { mode: 'in', start: [{opacity:0,transform:'translateY(16px)'}], end: [{opacity:1,transform:'none'}] };
  if (kf === 'wipe') return { mode: 'in', start: [{clipPath:'inset(0 100% 0 0)'}], end: [{clipPath:'inset(0 0% 0 0)'}] };
  if (kf === 'hl') {
    const c0 = _hexToRgba(hlColor || '#f9e2af', 0);
    const c1 = _hexToRgba(hlColor || '#f9e2af', 0.55);
    return { mode: 'em', frames: [
      {boxShadow:`inset 0 0 0 9999px ${c0}`},
      {boxShadow:`inset 0 0 0 9999px ${c1}`, offset: 0.4},
      {boxShadow:`inset 0 0 0 9999px ${c1}`, offset: 0.6},
      {boxShadow:`inset 0 0 0 9999px ${c0}`}
    ]};
  }
  if (kf === 'flash') {
    return { mode: 'em', frames: [
      {opacity:1},{opacity:0.08,offset:0.2},{opacity:1,offset:0.4},{opacity:0.08,offset:0.7},{opacity:1}
    ]};
  }
  if (kf === 'pop') {
    const c0 = _hexToRgba(hlColor || '#cba6f7', 0);
    const c1 = _hexToRgba(hlColor || '#cba6f7', 0.35);
    return { mode: 'em', frames: [
      {boxShadow:`inset 0 0 0 9999px ${c0}`, transform:'scale(1)'},
      {boxShadow:`inset 0 0 0 9999px ${c1}`, transform:'scale(1.04)', offset: 0.35},
      {boxShadow:`inset 0 0 0 9999px ${c0}`, transform:'scale(1)'}
    ]};
  }
  return { mode: 'in', start: [{opacity:0}], end: [{opacity:1}] };
}

function _preHideTableCells(el, def, tableTarget) {
  if (def.cat !== 'tbl-in') return;
  const kfData = _tblAnimKeyframes(def.kf);
  _tblAnimGetUnits(el, def, tableTarget).forEach(tds => tds.forEach(td => {
    Object.assign(td.style, kfData.start[0]);
  }));
}

function playTableAnimation(el, animData, { onComplete } = {}) {
  const def = getTblAnimDef(animData.effect);
  if (!def) { onComplete?.(); return; }
  const units = _tblAnimGetUnits(el, def, animData.tableTarget);
  if (!units.length) { onComplete?.(); return; }

  const isEm = def.cat === 'tbl-em';
  const dur  = Math.max(100, (animData.duration || (isEm ? 0.65 : 0.4)) * 1000);
  const stagger = Math.max(20, (animData.tableStagger ?? (isEm ? (dur / 1000) : 0.12)) * 1000);
  const kfData = _tblAnimKeyframes(def.kf, animData.tableHlColor);

  if (def.kf === 'hl') {
    // ハイライトトグル：対象セルを一斉に処理。1回目でON（色パルスでアピール）、2回目でOFF
    const hlColor = animData.tableHlColor || '#f9e2af';
    const c0     = _hexToRgba(hlColor, 0);
    const c1     = _hexToRgba(hlColor, 0.55);
    const cPeak  = _hexToRgba(hlColor, 0.85); // 一時的に強くしてアピール
    const allTds = units.flat();
    const isOn   = allTds[0]?.dataset.tblHlActive === '1';
    setTimeout(() => {
      let remaining = allTds.length;
      const onDone = () => { if (--remaining === 0) onComplete?.(!isOn); };
      allTds.forEach(td => {
        const frames = isOn
          // OFF：色をフェードアウト
          ? [{ boxShadow: `inset 0 0 0 9999px ${c1}` },
             { boxShadow: `inset 0 0 0 9999px ${c0}` }]
          // ON：透明 → ピーク色でアピール → 定常色で定着
          : [{ boxShadow: `inset 0 0 0 9999px ${c0}` },
             { boxShadow: `inset 0 0 0 9999px ${cPeak}`, offset: 0.35 },
             { boxShadow: `inset 0 0 0 9999px ${c1}` }];
        const easing = isOn ? 'ease-in' : 'ease-out';
        const a = td.animate(frames, { duration: dur, easing, fill: 'forwards' });
        a.onfinish = () => {
          if (isOn) {
            td.style.removeProperty('box-shadow');
            delete td.dataset.tblHlActive;
          } else {
            td.style.boxShadow = `inset 0 0 0 9999px ${c1}`;
            td.dataset.tblHlActive = '1';
          }
          try { a.cancel(); } catch(_) {}
          onDone();
        };
      });
    }, (animData.delay || 0) * 1000);
    return;
  }

  if (isEm) {
    // 強調：1ユニットずつ順番に再生してから次へ（スキャン効果）
    let i = 0;
    const playNext = () => {
      if (i >= units.length) { onComplete?.(); return; }
      const tds = units[i++];
      let remaining = tds.length;
      tds.forEach(td => {
        const a = td.animate(kfData.frames, { duration: dur, easing: 'ease-in-out', fill: 'none' });
        a.onfinish = () => { if (--remaining === 0) setTimeout(playNext, 0); };
      });
    };
    setTimeout(playNext, (animData.delay || 0) * 1000);
  } else {
    // 開始：スタッガード表示
    const { start, end } = kfData;
    const startProps = Object.keys(start[0]).map(p => p.replace(/([A-Z])/g, c => '-' + c.toLowerCase()));
    units.forEach(tds => tds.forEach(td => Object.assign(td.style, start[0])));
    units.forEach((tds, i) => {
      const isLast = i === units.length - 1;
      setTimeout(() => {
        tds.forEach((td, j) => {
          const a = td.animate([...start, ...end], { duration: dur, easing: 'ease-out', fill: 'forwards' });
          const isLastCell = isLast && j === tds.length - 1;
          a.onfinish = () => {
            startProps.forEach(p => td.style.removeProperty(p));
            try { a.cancel(); } catch(_) {}
            if (isLastCell) onComplete?.();
          };
        });
      }, i * stagger);
    });
  }
}

// ---- スライドショー アニメーション状態 ----
const ssAnim = { queue: [], pointer: 0, running: false, _timers: [], _infiniteAnims: [] };

function ssAnimReset() {
  ssAnim._timers.forEach(t => clearTimeout(t));
  ssAnim._infiniteAnims.forEach(wa => { try { wa?.cancel(); } catch(_) {} });
  ssAnim.queue = []; ssAnim.pointer = 0; ssAnim.running = false; ssAnim._timers = []; ssAnim._infiniteAnims = [];
}

function ssAnimInit(slide, frameEl) {
  ssAnimReset();
  const anims = slide?.animations || [];
  let group = null;
  anims.forEach(anim => {
    if (anim.trigger === 'on-click' || !group) { group = []; ssAnim.queue.push(group); }
    group.push(anim);
  });
  anims.forEach(anim => {
    if (!ANIM_CAT_ENTRANCE.has(anim.effect)) return;
    const el = frameEl?.querySelector(`[data-id="${anim.elementId}"]`);
    if (el) el.style.visibility = 'hidden';
  });
  anims.forEach(anim => {
    if (anim.effect !== '__chart__') return;
    const el = frameEl?.querySelector(`[data-id="${anim.elementId}"]`);
    const elemData = slide?.elements?.find(e => e.id === anim.elementId);
    if (el && elemData?.chartData) _preHideChartEls(el, elemData.chartData);
  });
  anims.forEach(anim => {
    if (!TBL_ANIM_IDS.has(anim.effect)) return;
    const el = frameEl?.querySelector(`[data-id="${anim.elementId}"]`);
    const def = getTblAnimDef(anim.effect);
    if (el && def && def.cat === 'tbl-in') _preHideTableCells(el, def, anim.tableTarget);
  });
}

function ssAnimHasMore() { return ssAnim.pointer < ssAnim.queue.length; }

function ssAnimPlayNext(frameEl) {
  if (!ssAnimHasMore() || ssAnim.running) return;
  // クリック時終了の無限ループアニメーションをキャンセル
  ssAnim._infiniteAnims.forEach(wa => { try { wa?.cancel(); } catch(_) {} });
  ssAnim._infiniteAnims = [];

  const group = ssAnim.queue[ssAnim.pointer++];
  ssAnim.running = true;
  let pending = 0, prevEndMs = 0;
  // グループ内どれかが hlApplied=true を返したら記録（finish の呼び出し順序に依存しない）
  let hlAppliedFlag = false;
  const hlOnlyGroup = []; // ハイライトOFF用の小グループ（hl アニメのみ）
  const finish = (hlApplied) => {
    if (hlApplied === true) hlAppliedFlag = true;
    pending--;
    if (pending <= 0) {
      // ハイライトONになった → hlアニメだけを次グループとして差し込む（直前アニメは再生しない）
      if (hlAppliedFlag && hlOnlyGroup.length) ssAnim.queue.splice(ssAnim.pointer, 0, hlOnlyGroup);
      ssAnim.running = false;
    }
  };

  // 繰り返し計算用：グループ内の非無限アニメーションの最大終了時刻を先算出
  let groupTotalMs = 0, tmpPrev = 0;
  group.forEach((animData, i) => {
    if (animData.repeat && animData.repeatEnd === 'on-click') return;
    const dMs = (animData.delay || 0) * 1000;
    const dur = TBL_ANIM_IDS.has(animData.effect) ? (animData.duration || 0.4) * 1000 : (animData.duration || 0.5) * 1000;
    const st  = (i === 0 || animData.trigger === 'with-prev') ? dMs : tmpPrev + dMs;
    tmpPrev = st + dur;
    groupTotalMs = Math.max(groupTotalMs, st + dur);
  });

  group.forEach((animData, i) => {
    const el = frameEl?.querySelector(`[data-id="${animData.elementId}"]`);
    if (!el) return;
    const delayMs = (animData.delay || 0) * 1000;
    const durMs = TBL_ANIM_IDS.has(animData.effect)
      ? (animData.duration || 0.4) * 1000
      : (animData.duration || 0.5) * 1000;
    const startMs = (i === 0 || animData.trigger === 'with-prev') ? delayMs : prevEndMs + delayMs;
    const isInfinite = animData.repeat && animData.repeatEnd === 'on-click';
    if (!isInfinite) prevEndMs = startMs + durMs;

    // hl アニメは OFF 用グループに収集（with-prev で一緒に動いた場合でも hl だけ再生できるように）
    if (TBL_ANIM_IDS.has(animData.effect) && getTblAnimDef(animData.effect)?.kf === 'hl') {
      hlOnlyGroup.push(animData);
    }

    if (isInfinite) {
      // 無限ループ：pending に含めず、後でキャンセル管理
      const tid = setTimeout(() => {
        const wa = playAnimEffect(el, animData, { iterations: Infinity });
        if (wa) ssAnim._infiniteAnims.push(wa);
      }, startMs);
      ssAnim._timers.push(tid);
    } else if (animData.repeat) {
      // 有限繰り返し：グループの残り時間に合わせてループ回数を計算
      const remaining = Math.max(durMs, groupTotalMs - startMs);
      const iterations = Math.max(1, Math.ceil(remaining / durMs));
      pending++;
      if (animData.effect === '__chart__') {
        const tid = setTimeout(() => {
          const ssSlide = getSsSlides()[ssState.currentIndex]?.slide;
          const elemData = ssSlide?.elements?.find(e => e.id === animData.elementId);
          if (elemData?.chartData) playChartAnimation(el, elemData.chartData);
          finish();
        }, startMs);
        ssAnim._timers.push(tid);
      } else if (TBL_ANIM_IDS.has(animData.effect)) {
        const tid = setTimeout(() => playTableAnimation(el, animData, { onComplete: finish }), startMs);
        ssAnim._timers.push(tid);
      } else {
        const tid = setTimeout(() => playAnimEffect(el, animData, { onComplete: finish, iterations }), startMs);
        ssAnim._timers.push(tid);
      }
    } else {
      pending++;
      if (animData.effect === '__chart__') {
        const tid = setTimeout(() => {
          const ssSlide = getSsSlides()[ssState.currentIndex]?.slide;
          const elemData = ssSlide?.elements?.find(e => e.id === animData.elementId);
          if (elemData?.chartData) playChartAnimation(el, elemData.chartData);
          finish();
        }, startMs);
        ssAnim._timers.push(tid);
      } else if (TBL_ANIM_IDS.has(animData.effect)) {
        const tid = setTimeout(() => playTableAnimation(el, animData, { onComplete: finish }), startMs);
        ssAnim._timers.push(tid);
      } else {
        const tid = setTimeout(() => playAnimEffect(el, animData, { onComplete: finish }), startMs);
        ssAnim._timers.push(tid);
      }
    }
  });
  if (pending === 0) ssAnim.running = false;
}

// ---- エディター アニメーション管理 ----
let animSelectedId = null;

function getCurrentSlideAnimations() { return getCurrentSlideData()?.animations || []; }

function addAnimation(elementId, effectId) {
  const slide = getCurrentSlideData();
  if (!slide) return;
  if (!slide.animations) slide.animations = [];
  pushHistory();
  const effDef = getAnimEffectDef(effectId);
  const anim = {
    id: 'anim_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    elementId, effect: effectId, trigger: 'on-click',
    duration: effDef?.cat === 'em' ? 1.0 : 0.5,
    delay: 0,
    direction: effDef?.dirs?.[0]?.[0] || '',
    repeat: false,
    repeatEnd: 'on-click',
  };
  slide.animations.push(anim);
  renderAnimBadges(); renderAnimWindow(); selectAnimEntry(anim.id);
}

function addTableAnimation(elementId, effectId) {
  const slide = getCurrentSlideData(); if (!slide) return;
  if (!slide.animations) slide.animations = [];
  pushHistory();
  const def = getTblAnimDef(effectId);
  const isEm = def?.cat === 'tbl-em';

  // 選択中のセルからターゲットを記録（なければ全体）
  const selCells = (state.selectedElement === elementId && state.selectedTableCells?.length > 0)
    ? state.selectedTableCells : [];
  let tableTarget = undefined;
  if (selCells.length > 0) {
    if (def?.unit === 'rows') {
      tableTarget = [...new Set(selCells.map(s => s.row))].sort((a, b) => a - b);
    } else if (def?.unit === 'cols') {
      tableTarget = [...new Set(selCells.map(s => s.col))].sort((a, b) => a - b);
    } else if (def?.unit === 'cells') {
      tableTarget = selCells.map(s => ({ row: s.row, col: s.col }));
    }
  }

  const anim = {
    id: 'anim_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    elementId, effect: effectId, trigger: 'on-click',
    duration: isEm ? 0.65 : 0.4,
    delay: 0, direction: '',
    tableStagger: isEm ? 0.65 : 0.12,
    repeat: false,
    repeatEnd: 'on-click',
    ...(def?.defaultHl ? { tableHlColor: def.defaultHl } : {}),
    ...(tableTarget !== undefined ? { tableTarget } : {}),
  };
  slide.animations.push(anim);
  renderAnimBadges(); renderAnimWindow(); selectAnimEntry(anim.id);
}

function addChartAnimation(elementId) {
  const slide = getCurrentSlideData(); if (!slide) return;
  const existing = (slide.animations || []).find(a => a.elementId === elementId && a.effect === '__chart__');
  if (existing) { selectAnimEntry(existing.id); return; }
  if (!slide.animations) slide.animations = [];
  pushHistory();
  const anim = {
    id: 'anim_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    elementId, effect: '__chart__', trigger: 'on-click', duration: 1.5, delay: 0, direction: '', repeat: false, repeatEnd: 'on-click',
  };
  slide.animations.push(anim);
  renderAnimBadges(); renderAnimWindow(); selectAnimEntry(anim.id);
}

function removeAnimation(animId) {
  const slide = getCurrentSlideData();
  if (!slide?.animations) return;
  pushHistory();
  slide.animations = slide.animations.filter(a => a.id !== animId);
  if (animSelectedId === animId) animSelectedId = null;
  renderAnimBadges(); renderAnimWindow(); updateAnimRibbon();
}

function selectAnimEntry(animId) {
  animSelectedId = animId;
  renderAnimWindow(); updateAnimRibbon();
}

function getSelectedAnim() { return getCurrentSlideAnimations().find(a => a.id === animSelectedId); }

function updateAnimRibbon() {
  const anim = getSelectedAnim();
  const trigSel = document.getElementById('anim-trigger-sel');
  const durIn   = document.getElementById('anim-duration-in');
  const delIn   = document.getElementById('anim-delay-in');
  if (!trigSel) return;
  if (anim) {
    trigSel.value = anim.trigger;
    durIn.value   = anim.duration.toFixed(2);
    delIn.value   = anim.delay.toFixed(2);
    trigSel.disabled = delIn.disabled = false;
    durIn.disabled = anim.effect === '__chart__';
  } else {
    trigSel.disabled = durIn.disabled = delIn.disabled = true;
  }
  const selId = state.selectedElement;
  const elemAnims = selId ? getCurrentSlideAnimations().filter(a => a.elementId === selId) : [];
  document.querySelectorAll('.anim-gal-item').forEach(item => {
    item.classList.toggle('selected', elemAnims.some(a => a.effect === item.dataset.effect));
  });
  const _updSelElem = getCurrentSlideData()?.elements?.find(e => e.id === selId);
  const _updChartItem = document.getElementById('anim-gal-chart-item');
  if (_updChartItem) _updChartItem.style.display = _updSelElem?.type === 'chart' ? '' : 'none';
  const _isTbl = _updSelElem?.type === 'table';
  document.querySelectorAll('.tbl-anim-gal-item').forEach(it => { it.style.display = _isTbl ? '' : 'none'; });
}

function renderAnimBadges() {
  document.querySelectorAll('.anim-badge').forEach(b => b.remove());
  if (!document.querySelector('.ribbon-tab[data-tab="animation"].active')) return;
  const anims = getCurrentSlideAnimations();
  if (!anims.length) return;
  const elemFirst = {}, elemLast = {};
  anims.forEach((anim, i) => {
    const color = anim.effect === '__chart__' ? '#89b4fa' : TBL_ANIM_IDS.has(anim.effect) ? (getTblAnimDef(anim.effect)?.color || '#74c7ec') : (getAnimEffectDef(anim.effect)?.color || '#888');
    const info = { num: i + 1, color };
    if (elemFirst[anim.elementId] === undefined) elemFirst[anim.elementId] = info;
    elemLast[anim.elementId] = info;
  });
  const _selElem = getCurrentSlideData()?.elements?.find(e => e.id === state.selectedElement);
  const _chartGalItem = document.getElementById('anim-gal-chart-item');
  if (_chartGalItem) _chartGalItem.style.display = _selElem?.type === 'chart' ? '' : 'none';
  Object.entries(elemFirst).forEach(([elemId, { num, color }]) => {
    const el = canvas.querySelector(`[data-id="${elemId}"]`);
    if (!el) return;
    const b = document.createElement('div');
    b.className = 'anim-badge'; b.style.background = color; b.textContent = num;
    el.appendChild(b);
    const last = elemLast[elemId];
    if (last.num !== num) {
      const b2 = document.createElement('div');
      b2.className = 'anim-badge secondary'; b2.style.background = last.color; b2.textContent = last.num;
      el.appendChild(b2);
    }
  });
}

function renderAnimWindow() {
  const list = document.getElementById('anim-list');
  if (!list) return;
  const anims = getCurrentSlideAnimations();
  list.innerHTML = '';
  if (!anims.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:20px 8px;text-align:center;color:#45475a;font-size:12px;white-space:pre-line;';
    empty.textContent = 'アニメーションがありません\n要素を選択して効果を追加してください';
    list.appendChild(empty); return;
  }
  const slide = getCurrentSlideData();
  anims.forEach((anim, i) => {
    const isChartAnim = anim.effect === '__chart__';
    const isTblAnim   = TBL_ANIM_IDS.has(anim.effect);
    const effDef   = isChartAnim || isTblAnim ? null : getAnimEffectDef(anim.effect);
    const tblDef   = isTblAnim ? getTblAnimDef(anim.effect) : null;
    const elemData = slide?.elements.find(e => e.id === anim.elementId);
    const elemName = isChartAnim || elemData?.type === 'chart'
      ? 'グラフ'
      : elemData?.type === 'table'
        ? '表'
        : (elemData?.text?.slice(0, 14) || (elemData ? elemData.type : '不明'));
    const trigIcon = anim.trigger === 'on-click' ? '🖱️' : anim.trigger === 'with-prev' ? '⚡' : '⏱️';
    const isSelected = anim.id === animSelectedId;
    const badgeColor = isChartAnim ? '#89b4fa' : (tblDef?.color || effDef?.color || '#888');
    const effectLabel = isChartAnim ? 'グラフアニメーション' : (tblDef?.label || effDef?.label || anim.effect);
    const entryIcon = isChartAnim
      ? `<svg width="15" height="15" viewBox="0 0 22 22" style="flex-shrink:0;color:${badgeColor}" fill="currentColor" stroke="none"><rect x="2" y="12" width="4" height="8" rx="1"/><rect x="9" y="7" width="4" height="13" rx="1"/><rect x="16" y="3" width="4" height="17" rx="1"/></svg>`
      : isTblAnim
        ? `<svg width="15" height="15" viewBox="0 0 22 22" style="flex-shrink:0;color:${badgeColor}" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="18" height="18" rx="1"/><line x1="2" y1="8" x2="20" y2="8"/><line x1="2" y1="14" x2="20" y2="14"/><line x1="8" y1="2" x2="8" y2="20"/><line x1="14" y1="2" x2="14" y2="20"/></svg>`
        : `<svg width="15" height="15" viewBox="0 0 22 22" style="flex-shrink:0;color:${badgeColor}" fill="none" stroke="currentColor" stroke-width="1.2">${ANIM_ICONS[anim.effect] || ''}</svg>`;

    const entry = document.createElement('div');
    entry.className = 'anim-entry' + (isSelected ? ' selected' : '');
    entry.dataset.animId = anim.id;
    entry.innerHTML = `
      <span class="anim-entry-num" style="background:${badgeColor}">${i+1}</span>
      <span class="anim-entry-trigger">${trigIcon}</span>
      ${entryIcon}
      <span class="anim-entry-text">
        <div class="anim-entry-name">${elemName}</div>
        <div class="anim-entry-effect">${effectLabel}</div>
      </span>
      <button class="anim-entry-del" data-anim-id="${anim.id}" title="削除">×</button>`;

    const dirOpts = effDef?.dirs
      ? effDef.dirs.map(([v,l]) => `<option value="${v}"${anim.direction===v?' selected':''}>${l}</option>`).join('')
      : '';
    const detail = document.createElement('div');
    detail.className = 'anim-detail' + (isSelected ? ' open' : '');
    detail.innerHTML = `
      <div class="anim-detail-row">
        <span class="anim-detail-label">開始</span>
        <select class="anim-detail-select" data-field="trigger">
          <option value="on-click"${anim.trigger==='on-click'?' selected':''}>クリック時</option>
          <option value="with-prev"${anim.trigger==='with-prev'?' selected':''}>直前と同時</option>
          <option value="after-prev"${anim.trigger==='after-prev'?' selected':''}>直前の後</option>
        </select>
      </div>
      ${isChartAnim ? '' : `<div class="anim-detail-row">
        <span class="anim-detail-label">継続時間</span>
        <input class="anim-detail-num" type="number" data-field="duration" min="0.1" max="60" step="0.1" value="${anim.duration.toFixed(2)}"><span>秒</span>
      </div>`}
      <div class="anim-detail-row">
        <span class="anim-detail-label">遅延</span>
        <input class="anim-detail-num" type="number" data-field="delay" min="0" max="60" step="0.1" value="${anim.delay.toFixed(2)}"><span>秒</span>
      </div>
      <div class="anim-detail-row">
        <span class="anim-detail-label">繰り返し</span>
        <input type="checkbox" class="anim-detail-check" data-field="repeat"${anim.repeat ? ' checked' : ''}>
      </div>
      ${anim.repeat ? `<div class="anim-detail-row">
        <span class="anim-detail-label">終了</span>
        <select class="anim-detail-select" data-field="repeatEnd">
          <option value="on-click"${(anim.repeatEnd ?? 'on-click') === 'on-click' ? ' selected' : ''}>クリック時</option>
          <option value="with-prev"${anim.repeatEnd === 'with-prev' ? ' selected' : ''}>直前と同時</option>
          <option value="after-prev"${anim.repeatEnd === 'after-prev' ? ' selected' : ''}>直前の後</option>
        </select>
      </div>` : ''}
      ${isTblAnim ? `<div class="anim-detail-row">
        <span class="anim-detail-label">間隔</span>
        <input class="anim-detail-num" type="number" data-field="tableStagger" min="0.01" max="5" step="0.01" value="${(anim.tableStagger ?? (tblDef?.cat === 'tbl-em' ? (anim.duration || 0.65) : 0.12)).toFixed(2)}"><span>秒</span>
      </div>` : ''}
      ${isTblAnim && tblDef?.cat === 'tbl-em' && tblDef?.defaultHl ? `<div class="anim-detail-row">
        <span class="anim-detail-label">色</span>
        <button class="ppt-swatch-btn" data-field="tableHlColor" style="width:28px;height:20px"><span class="ppt-swatch-color" style="background:${anim.tableHlColor || tblDef.defaultHl}"></span></button>
      </div>` : ''}
      ${effDef?.hasDir ? `<div class="anim-detail-row"><span class="anim-detail-label">方向</span><select class="anim-detail-select" data-field="direction">${dirOpts}</select></div>` : ''}`;

    list.appendChild(entry);
    list.appendChild(detail);
  });
}

function previewAnimations() {
  const slide = getCurrentSlideData();
  const anims = slide?.animations || [];
  if (!anims.length) return;
  anims.forEach(anim => {
    if (!ANIM_CAT_ENTRANCE.has(anim.effect)) return;
    const el = canvas.querySelector(`[data-id="${anim.elementId}"]`);
    if (el) el.style.visibility = 'hidden';
  });
  anims.forEach(anim => {
    if (anim.effect !== '__chart__') return;
    const el = canvas.querySelector(`[data-id="${anim.elementId}"]`);
    const elemData = slide?.elements?.find(e => e.id === anim.elementId);
    if (el && elemData?.chartData) _preHideChartEls(el, elemData.chartData);
  });
  anims.forEach(anim => {
    if (!TBL_ANIM_IDS.has(anim.effect)) return;
    const el = canvas.querySelector(`[data-id="${anim.elementId}"]`);
    const def = getTblAnimDef(anim.effect);
    if (el && def && def.cat === 'tbl-in') _preHideTableCells(el, def, anim.tableTarget);
  });
  let cursor = 0, prevEnd = 0;
  anims.forEach((anim, i) => {
    let startMs;
    if (i === 0 || anim.trigger === 'on-click') {
      startMs = (i === 0 ? 0 : cursor + 300) + (anim.delay || 0) * 1000;
      cursor = prevEnd = startMs + (anim.duration || 0.5) * 1000;
    } else if (anim.trigger === 'with-prev') {
      startMs = Math.max(0, cursor - (anim.duration||0.5)*1000) + (anim.delay||0)*1000;
      const e = startMs + (anim.duration||0.5)*1000;
      if (e > cursor) { cursor = e; prevEnd = cursor; }
    } else {
      startMs = prevEnd + (anim.delay||0)*1000;
      cursor = prevEnd = startMs + (anim.duration||0.5)*1000;
    }
    setTimeout(() => {
      const el = canvas.querySelector(`[data-id="${anim.elementId}"]`);
      if (!el) return;
      if (anim.effect === '__chart__') {
        const elemData = getCurrentSlideData()?.elements?.find(e => e.id === anim.elementId);
        if (elemData?.chartData) playChartAnimation(el, elemData.chartData);
      } else if (TBL_ANIM_IDS.has(anim.effect)) {
        playTableAnimation(el, anim, {});
      } else {
        playAnimEffect(el, anim, anim.repeat ? { iterations: 3 } : {});
      }
    }, startMs);
  });
}

// ---- UI 初期化 ----
(function initAnimSystem() {
  const gallery = document.getElementById('anim-gallery');
  if (!gallery) return;

  const byRow = { in: [], em: [], out: [] };
  ANIM_EFFECTS.forEach(eff => byRow[eff.cat]?.push(eff));
  const orderedEffects = [...byRow.in, ...byRow.em, ...byRow.out];

  // グラフアニメーション専用アイテム（チャート選択時のみ表示）
  const chartGalItem = document.createElement('div');
  chartGalItem.id = 'anim-gal-chart-item';
  chartGalItem.className = 'anim-gal-item';
  chartGalItem.style.display = 'none';
  chartGalItem.title = 'グラフアニメーションをタイムラインに追加';
  chartGalItem.dataset.effect = '__chart__';
  chartGalItem.innerHTML = `<svg width="20" height="20" viewBox="0 0 22 22" style="color:#89b4fa;display:block;flex-shrink:0" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="12" width="4" height="8" rx="1"/><rect x="9" y="7" width="4" height="13" rx="1"/><rect x="16" y="3" width="4" height="17" rx="1"/></svg><span class="anim-gal-label">グラフ</span>`;
  chartGalItem.addEventListener('click', () => {
    const selId = state.selectedElement;
    if (!selId) return;
    addChartAnimation(selId);
  });
  gallery.appendChild(chartGalItem);

  // 表アニメーション専用アイテム（表選択時のみ表示）
  const TBL_ICONS_IN = {
    rows:  `<line x1="3" y1="7" x2="19" y2="7" stroke-width="2.5"/><line x1="3" y1="13" x2="19" y2="13" stroke-dasharray="3 2" stroke-width="1.5"/><line x1="3" y1="19" x2="19" y2="19" stroke-dasharray="3 2" stroke-width="1.5"/>`,
    cols:  `<line x1="7" y1="3" x2="7" y2="19" stroke-width="2.5"/><line x1="13" y1="3" x2="13" y2="19" stroke-dasharray="3 2" stroke-width="1.5"/><line x1="19" y1="3" x2="19" y2="19" stroke-dasharray="3 2" stroke-width="1.5"/>`,
    cells: `<rect x="3" y="3" width="7" height="7" rx="1" fill="currentColor"/><rect x="12" y="3" width="7" height="7" rx="1" fill="currentColor" opacity=".4"/><rect x="3" y="12" width="7" height="7" rx="1" fill="currentColor" opacity=".2"/><rect x="12" y="12" width="7" height="7" rx="1" fill="currentColor" opacity=".1"/>`,
  };
  const TBL_ICONS_EM = {
    hl:    { rows:  `<rect x="3" y="4" width="16" height="5" rx="1" fill="currentColor" opacity=".85"/><rect x="3" y="11" width="16" height="3.5" rx="1" fill="currentColor" opacity=".3"/><rect x="3" y="16.5" width="16" height="3.5" rx="1" fill="currentColor" opacity=".15"/>`,
              cols:  `<rect x="4" y="3" width="5" height="16" rx="1" fill="currentColor" opacity=".85"/><rect x="11" y="3" width="3.5" height="16" rx="1" fill="currentColor" opacity=".3"/><rect x="16.5" y="3" width="3.5" height="16" rx="1" fill="currentColor" opacity=".15"/>`,
              cells: `<rect x="3" y="3" width="7" height="7" rx="1" fill="currentColor" opacity=".9"/><rect x="12" y="3" width="7" height="7" rx="1" fill="currentColor" opacity=".35"/><rect x="3" y="12" width="7" height="7" rx="1" fill="currentColor" opacity=".15"/><rect x="12" y="12" width="7" height="7" rx="1" fill="currentColor" opacity=".05"/>` },
    flash: { rows:  `<rect x="3" y="4" width="16" height="4" rx="1" fill="currentColor"/><line x1="5" y1="12" x2="19" y2="12" stroke-width="1.5"/><line x1="5" y1="16" x2="19" y2="16" stroke-width="1.5"/>`,
              cols:  `<rect x="4" y="3" width="4" height="16" rx="1" fill="currentColor"/><line x1="12" y1="5" x2="12" y2="19" stroke-width="1.5"/><line x1="16" y1="5" x2="16" y2="19" stroke-width="1.5"/>`,
              cells: `<rect x="3" y="3" width="7" height="7" rx="1" fill="currentColor"/><rect x="12" y="12" width="7" height="7" rx="1" fill="currentColor"/><rect x="12" y="3" width="7" height="7" rx="1" fill="currentColor" opacity=".3"/><rect x="3" y="12" width="7" height="7" rx="1" fill="currentColor" opacity=".3"/>` },
    pop:   { rows:  `<rect x="2" y="4" width="18" height="5" rx="2" fill="currentColor" opacity=".9"/><rect x="3" y="11" width="16" height="3.5" rx="1" fill="currentColor" opacity=".3"/><rect x="3" y="16.5" width="16" height="3.5" rx="1" fill="currentColor" opacity=".15"/>`,
              cols:  `<rect x="3" y="2" width="5" height="18" rx="2" fill="currentColor" opacity=".9"/><rect x="11" y="3" width="3.5" height="16" rx="1" fill="currentColor" opacity=".3"/><rect x="16.5" y="3" width="3.5" height="16" rx="1" fill="currentColor" opacity=".15"/>`,
              cells: `<rect x="2" y="2" width="8" height="8" rx="2" fill="currentColor" opacity=".9"/><rect x="12" y="3" width="7" height="7" rx="1" fill="currentColor" opacity=".35"/><rect x="3" y="12" width="7" height="7" rx="1" fill="currentColor" opacity=".15"/><rect x="12" y="12" width="7" height="7" rx="1" fill="currentColor" opacity=".05"/>` },
  };
  TBL_ANIM_EFFECTS.forEach(teff => {
    const item = document.createElement('div');
    item.className = 'anim-gal-item tbl-anim-gal-item';
    item.dataset.effect = teff.id;
    item.title = teff.label;
    item.style.display = 'none';
    const iconSet = teff.cat === 'tbl-em' ? TBL_ICONS_EM[teff.kf] : TBL_ICONS_IN;
    const icon = iconSet?.[teff.unit] || '';
    const shortLabel = teff.label.replace('ごと','<br>').replace('ライト','<br>ライト').replace('ッシュ','<br>ッシュ').replace('ップ','<br>ップ');
    item.innerHTML = `<svg width="20" height="20" viewBox="0 0 22 22" style="color:${teff.color};display:block;flex-shrink:0" fill="none" stroke="currentColor" stroke-width="1.2">${icon}</svg><span class="anim-gal-label" style="font-size:9px;line-height:1.2;text-align:center">${shortLabel}</span>`;
    item.addEventListener('click', () => {
      const selId = state.selectedElement;
      if (!selId) return;
      addTableAnimation(selId, teff.id);
    });
    gallery.appendChild(item);
  });

  orderedEffects.forEach(eff => {
    const item = document.createElement('div');
    item.className = 'anim-gal-item';
    item.dataset.effect = eff.id;
    item.title = eff.label;
    item.innerHTML = `<svg width="20" height="20" viewBox="0 0 22 22" style="color:${eff.color};display:block;flex-shrink:0">${ANIM_ICONS[eff.id] || ''}</svg><span class="anim-gal-label">${eff.label}</span>`;
    item.addEventListener('click', () => {
      const selId = state.selectedElement;
      if (!selId) { alert('要素を選択してからアニメーションを追加してください'); return; }
      addAnimation(selId, eff.id);
      const el = canvas.querySelector(`[data-id="${selId}"]`);
      if (el) playAnimEffect(el, { effect: eff.id, direction: getAnimEffectDef(eff.id)?.dirs?.[0]?.[0] || '' }, {});
    });
    gallery.appendChild(item);
  });

  gallery.addEventListener('wheel', e => {
    e.preventDefault();
    gallery.scrollLeft += e.deltaY > 0 ? 38 : -38;
  }, { passive: false });

  function _syncPickerChartSection() {
    const selElem = getCurrentSlideData()?.elements?.find(e => e.id === state.selectedElement);
    const sec = document.getElementById('anim-picker-chart-sec');
    if (sec) sec.style.display = selElem?.type === 'chart' ? '' : 'none';
  }

  function _syncPickerTblSection() {
    const selElem = getCurrentSlideData()?.elements?.find(e => e.id === state.selectedElement);
    const sec = document.getElementById('anim-picker-tbl-sec');
    if (sec) sec.style.display = selElem?.type === 'table' ? '' : 'none';
  }

  document.getElementById('anim-gal-expand-btn')?.addEventListener('click', e => {
    if (!picker) return;
    if (picker.classList.contains('open')) { picker.classList.remove('open'); return; }
    _syncPickerChartSection();
    _syncPickerTblSection();
    const rect = e.currentTarget.getBoundingClientRect();
    picker.style.left = rect.right - 310 + 'px';
    picker.style.top  = (rect.bottom + 4) + 'px';
    picker.classList.add('open');
    e.stopPropagation();
  });

  const picker = document.getElementById('anim-effect-picker');
  // グラフアニメーション専用ピッカーアイテム
  const chartPickerGrid = document.getElementById('anim-picker-chart');
  if (chartPickerGrid) {
    const chartPickerItem = document.createElement('div');
    chartPickerItem.className = 'anim-picker-item';
    chartPickerItem.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22" style="color:#89b4fa;display:block;flex-shrink:0" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="12" width="4" height="8" rx="1"/><rect x="9" y="7" width="4" height="13" rx="1"/><rect x="16" y="3" width="4" height="17" rx="1"/></svg><span>グラフアニメーション</span>`;
    chartPickerItem.addEventListener('click', ev => {
      ev.stopPropagation();
      const selId = state.selectedElement;
      if (selId) addChartAnimation(selId);
      picker?.classList.remove('open');
    });
    chartPickerGrid.appendChild(chartPickerItem);
  }

  const tblPickerGrid = document.getElementById('anim-picker-tbl');
  if (tblPickerGrid) {
    TBL_ANIM_EFFECTS.forEach(teff => {
      const item = document.createElement('div');
      item.className = 'anim-picker-item';
      const iconSet = teff.cat === 'tbl-em' ? TBL_ICONS_EM[teff.kf] : TBL_ICONS_IN;
      const icon = iconSet?.[teff.unit] || '';
      item.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22" style="color:${teff.color};display:block;flex-shrink:0" fill="none" stroke="currentColor" stroke-width="1.2">${icon}</svg><span>${teff.label}</span>`;
      item.addEventListener('click', ev => {
        ev.stopPropagation();
        const selId = state.selectedElement;
        if (selId) addTableAnimation(selId, teff.id);
        picker?.classList.remove('open');
      });
      tblPickerGrid.appendChild(item);
    });
  }

  ['in','em','out'].forEach(cat => {
    const grid = document.getElementById(`anim-picker-${cat}`);
    if (!grid) return;
    ANIM_EFFECTS.filter(e => e.cat === cat).forEach(eff => {
      const item = document.createElement('div');
      item.className = 'anim-picker-item';
      item.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22" style="color:${eff.color};display:block;flex-shrink:0">${ANIM_ICONS[eff.id]||''}</svg><span>${eff.label}</span>`;
      item.addEventListener('click', ev => {
        ev.stopPropagation();
        const selId = state.selectedElement;
        if (selId) {
          addAnimation(selId, eff.id);
          const el = canvas.querySelector(`[data-id="${selId}"]`);
          if (el) playAnimEffect(el, { effect: eff.id, direction: getAnimEffectDef(eff.id)?.dirs?.[0]?.[0] || '' }, {});
        }
        picker?.classList.remove('open');
      });
      grid.appendChild(item);
    });
  });

  document.getElementById('anim-add-btn')?.addEventListener('click', e => {
    if (!picker) return;
    if (picker.classList.contains('open')) { picker.classList.remove('open'); return; }
    _syncPickerChartSection();
    _syncPickerTblSection();
    const rect = e.currentTarget.getBoundingClientRect();
    picker.style.left = rect.left + 'px';
    picker.style.top  = (rect.bottom + 4) + 'px';
    picker.classList.add('open');
    e.stopPropagation();
  });
  document.addEventListener('click', () => picker?.classList.remove('open'));

  document.getElementById('anim-window-btn')?.addEventListener('click', () => {
    document.getElementById('anim-window-panel')?.classList.toggle('open');
  });
  document.getElementById('anim-window-close-btn')?.addEventListener('click', () => {
    document.getElementById('anim-window-panel')?.classList.remove('open');
  });

  document.getElementById('anim-trigger-sel')?.addEventListener('change', e => {
    const anim = getSelectedAnim(); if (!anim) return;
    pushHistory(); anim.trigger = e.target.value; updateAnimRibbon(); renderAnimWindow();
  });
  document.getElementById('anim-duration-in')?.addEventListener('input', e => {
    const anim = getSelectedAnim(); if (!anim) return;
    const val = parseFloat(e.target.value);
    if (!isNaN(val) && val >= 0.1) anim.duration = val;
  });
  document.getElementById('anim-duration-in')?.addEventListener('change', e => {
    const anim = getSelectedAnim(); if (!anim) return;
    pushHistory(); anim.duration = Math.max(0.1, parseFloat(e.target.value) || 0.5);
    e.target.value = anim.duration.toFixed(2); updateAnimRibbon(); renderAnimWindow();
  });
  document.getElementById('anim-delay-in')?.addEventListener('input', e => {
    const anim = getSelectedAnim(); if (!anim) return;
    const val = parseFloat(e.target.value);
    if (!isNaN(val) && val >= 0) anim.delay = val;
  });
  document.getElementById('anim-delay-in')?.addEventListener('change', e => {
    const anim = getSelectedAnim(); if (!anim) return;
    pushHistory(); anim.delay = Math.max(0, parseFloat(e.target.value) || 0);
    e.target.value = anim.delay.toFixed(2); updateAnimRibbon(); renderAnimWindow();
  });

  document.getElementById('anim-list')?.addEventListener('click', e => {
    const delBtn = e.target.closest('.anim-entry-del');
    if (delBtn) { e.stopPropagation(); removeAnimation(delBtn.dataset.animId); return; }
    const hlColorBtn = e.target.closest('[data-field="tableHlColor"]');
    if (hlColorBtn) {
      e.stopPropagation();
      const entry = hlColorBtn.closest('.anim-detail')?.previousElementSibling;
      if (!entry) return;
      const anim = getCurrentSlideAnimations().find(a => a.id === entry.dataset.animId);
      if (!anim) return;
      showPptColorPicker(hlColorBtn, (c) => {
        if (!c) return;
        pushHistory();
        anim.tableHlColor = c;
        hlColorBtn.querySelector('.ppt-swatch-color').style.background = c;
        updateAnimRibbon();
      });
      return;
    }
    const entry = e.target.closest('.anim-entry');
    if (entry) {
      const id = entry.dataset.animId;
      if (animSelectedId === id) entry.nextElementSibling?.classList.toggle('open');
      else selectAnimEntry(id);
    }
  });

  document.getElementById('anim-list')?.addEventListener('input', e => {
    const field = e.target.dataset.field; if (!field) return;
    if (field !== 'duration' && field !== 'delay' && field !== 'tableStagger') return;
    const entry = e.target.closest('.anim-detail')?.previousElementSibling;
    if (!entry) return;
    const anim = getCurrentSlideAnimations().find(a => a.id === entry.dataset.animId);
    if (!anim) return;
    const val = parseFloat(e.target.value);
    if (isNaN(val)) return;
    if      (field === 'duration'     && val >= 0.1)  anim.duration     = val;
    else if (field === 'delay'        && val >= 0)    anim.delay        = val;
    else if (field === 'tableStagger' && val >= 0.01) anim.tableStagger = val;
    updateAnimRibbon();
  });

  document.getElementById('anim-list')?.addEventListener('change', e => {
    const field = e.target.dataset.field; if (!field) return;
    const entry = e.target.closest('.anim-detail')?.previousElementSibling;
    if (!entry) return;
    const anim = getCurrentSlideAnimations().find(a => a.id === entry.dataset.animId);
    if (!anim) return;
    pushHistory();
    if      (field === 'trigger')       anim.trigger       = e.target.value;
    else if (field === 'duration')      anim.duration      = Math.max(0.1, parseFloat(e.target.value) || 0.5);
    else if (field === 'delay')         anim.delay         = Math.max(0, parseFloat(e.target.value) || 0);
    else if (field === 'direction')     anim.direction     = e.target.value;
    else if (field === 'tableStagger')  anim.tableStagger  = Math.max(0.01, parseFloat(e.target.value) || 0.12);
    else if (field === 'repeat')        anim.repeat        = e.target.checked;
    else if (field === 'repeatEnd')     anim.repeatEnd     = e.target.value;
    updateAnimRibbon(); renderAnimWindow();
  });

  document.getElementById('anim-preview-btn')?.addEventListener('click', previewAnimations);
  document.getElementById('anim-play-all-btn')?.addEventListener('click', previewAnimations);
}());

// ===== 配置（整列） =====
function alignElements(type) {
  const selIds = [...state.selectedElements];
  if (selIds.length < 2) return;
  const slide = getCurrentSlideData();
  const elems = selIds.map(id => slide.elements.find(e => e.id === id)).filter(Boolean);
  if (elems.length < 2) return;
  pushHistory();

  if (type === 'left') {
    const minX = Math.min(...elems.map(e => e.x));
    elems.forEach(e => { e.x = minX; });
  } else if (type === 'center-h') {
    const minX = Math.min(...elems.map(e => e.x));
    const maxX = Math.max(...elems.map(e => e.x + e.w));
    const cx = (minX + maxX) / 2;
    elems.forEach(e => { e.x = Math.round(cx - e.w / 2); });
  } else if (type === 'right') {
    const maxX = Math.max(...elems.map(e => e.x + e.w));
    elems.forEach(e => { e.x = maxX - e.w; });
  } else if (type === 'top') {
    const minY = Math.min(...elems.map(e => e.y));
    elems.forEach(e => { e.y = minY; });
  } else if (type === 'center-v') {
    const minY = Math.min(...elems.map(e => e.y));
    const maxY = Math.max(...elems.map(e => e.y + e.h));
    const cy = (minY + maxY) / 2;
    elems.forEach(e => { e.y = Math.round(cy - e.h / 2); });
  } else if (type === 'bottom') {
    const maxY = Math.max(...elems.map(e => e.y + e.h));
    elems.forEach(e => { e.y = maxY - e.h; });
  } else if (type === 'distribute-h') {
    if (elems.length < 3) return;
    elems.sort((a, b) => a.x - b.x);
    const totalW = elems.reduce((s, e) => s + e.w, 0);
    const span = (elems[elems.length - 1].x + elems[elems.length - 1].w) - elems[0].x;
    const gap = (span - totalW) / (elems.length - 1);
    let curX = elems[0].x;
    elems.forEach(e => { e.x = Math.round(curX); curX += e.w + gap; });
  } else if (type === 'distribute-v') {
    if (elems.length < 3) return;
    elems.sort((a, b) => a.y - b.y);
    const totalH = elems.reduce((s, e) => s + e.h, 0);
    const span = (elems[elems.length - 1].y + elems[elems.length - 1].h) - elems[0].y;
    const gap = (span - totalH) / (elems.length - 1);
    let curY = elems[0].y;
    elems.forEach(e => { e.y = Math.round(curY); curY += e.h + gap; });
  }

  renderAll();
  updatePropertiesPanel();
}

(function initAlignSystem() {
  const popup = document.getElementById('align-popup');
  if (!popup) return;

  document.getElementById('align-open-btn')?.addEventListener('click', e => {
    if (popup.classList.contains('open')) { popup.classList.remove('open'); return; }
    const rect = e.currentTarget.getBoundingClientRect();
    popup.style.left = rect.left + 'px';
    popup.style.top  = (rect.bottom + 4) + 'px';
    popup.classList.add('open');
    e.stopPropagation();
  });

  popup.addEventListener('click', e => {
    const item = e.target.closest('.align-item');
    if (!item) return;
    e.stopPropagation();
    alignElements(item.dataset.align);
    popup.classList.remove('open');
  });

  document.addEventListener('click', () => popup.classList.remove('open'));
}());

// ===== チャートエディタ =====
let _chartEditorTargetId = null;

function openChartEditor(elementId = null) {
  _chartEditorTargetId = elementId;
  const modal = document.getElementById('chart-editor-modal');
  if (!modal) return;

  if (elementId) {
    const d = getElementData(elementId);
    if (d?.chartData) _loadChartEditorData(d.chartData);
    else _resetChartEditorData();
  } else {
    _resetChartEditorData();
  }

  _updateChartEditorPreview();
  modal.style.display = 'flex';
}

function closeChartEditor() {
  const modal = document.getElementById('chart-editor-modal');
  if (modal) modal.style.display = 'none';
  _chartEditorTargetId = null;
}

function _getChartEditorData() {
  const type = document.querySelector('.ced-type-btn.active')?.dataset.type || 'bar';
  const title = document.getElementById('ced-title').value;
  const showValues = document.getElementById('ced-show-values').checked;
  const showGrid = document.getElementById('ced-show-grid').checked;
  const showLegend = document.getElementById('ced-show-legend')?.checked !== false;
  const animStyle = document.getElementById('ced-anim-style').value;
  const palette = document.querySelector('.ced-palette-item.active')?.dataset.palette || 'default';
  const lineWidth = parseFloat(document.getElementById('ced-line-width')?.value) || 2.5;
  const barRadius = parseInt(document.getElementById('ced-bar-radius')?.value, 10) ?? 3;
  // Axis
  const ayminRaw = document.getElementById('ced-axis-ymin')?.value;
  const aymaxRaw = document.getElementById('ced-axis-ymax')?.value;
  const axisYMin = (ayminRaw != null && ayminRaw !== '') ? Number(ayminRaw) : null;
  const axisYMax = (aymaxRaw != null && aymaxRaw !== '') ? Number(aymaxRaw) : null;
  const axisColor = document.getElementById('ced-axis-color')?.value || '#313244';
  const axisLabelColor = document.getElementById('ced-label-color')?.value || '#6c7086';
  const axisLabelSize = parseInt(document.getElementById('ced-label-size')?.value, 10) || 9;
  // Marker
  const markerShape = document.getElementById('ced-marker-shape')?.value || 'circle';
  const markerSize = parseInt(document.getElementById('ced-marker-size')?.value, 10) || 5;
  // Plot area
  const plotBgOn = document.getElementById('ced-plot-bg-on')?.checked;
  const plotBgColor = plotBgOn ? (document.getElementById('ced-plot-bg-color')?.value || '#1e1e2e') : '';
  const gridOpacity = parseInt(document.getElementById('ced-grid-opacity')?.value, 10) ?? 7;
  // Border
  const showBorder = document.getElementById('ced-show-border')?.checked || false;
  const borderColor = document.getElementById('ced-border-color')?.value || '#45475a';
  const borderWidth = parseFloat(document.getElementById('ced-border-width')?.value) || 1;
  const borderRx = parseInt(document.getElementById('ced-border-rx')?.value, 10) ?? 6;
  // Animation detail
  const animDuration = parseInt(document.getElementById('ced-anim-dur')?.value, 10) || 0;
  const animEasing = document.getElementById('ced-anim-easing')?.value || 'auto';
  const lineFill     = document.getElementById('ced-line-fill')?.checked !== false;
  const animateDots  = document.getElementById('ced-anim-dots')?.checked !== false;
  const animateValues= document.getElementById('ced-anim-values')?.checked !== false;
  const series = [];
  document.querySelectorAll('.ced-row').forEach(row => {
    const label = row.querySelector('.ced-row-label').value;
    const value = parseFloat(row.querySelector('.ced-row-value').value) || 0;
    if (label || value) series.push({ label, value });
  });
  return {
    chartType: type, title, series, colors: null, palette,
    showValues, showGrid, showLegend, animStyle, lineWidth, barRadius,
    axisYMin, axisYMax, axisColor, axisLabelColor, axisLabelSize,
    markerShape, markerSize, plotBgColor, gridOpacity,
    showBorder, borderColor, borderWidth, borderRx,
    animDuration, animEasing, lineFill, animateDots, animateValues,
  };
}

function _loadChartEditorData(cd) {
  document.querySelectorAll('.ced-type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === cd.chartType);
  });
  document.getElementById('ced-title').value = cd.title || '';
  document.getElementById('ced-show-values').checked = cd.showValues !== false;
  document.getElementById('ced-show-grid').checked = cd.showGrid !== false;
  document.getElementById('ced-anim-style').value = cd.animStyle || 'cascade';
  document.querySelectorAll('.ced-palette-item').forEach(item => {
    item.classList.toggle('active', item.dataset.palette === (cd.palette || 'default'));
  });
  const _setRange = (id, valId, val) => { const el = document.getElementById(id); if (el) { el.value = val; const v = document.getElementById(valId); if (v) v.textContent = val; } };
  _setRange('ced-line-width', 'ced-lw-val', cd.lineWidth ?? 2.5);
  _setRange('ced-bar-radius', 'ced-br-val', cd.barRadius ?? 3);
  const slEl = document.getElementById('ced-show-legend');
  if (slEl) slEl.checked = cd.showLegend !== false;
  // Axis
  const aymin = document.getElementById('ced-axis-ymin'); if (aymin) aymin.value = cd.axisYMin != null ? cd.axisYMin : '';
  const aymax = document.getElementById('ced-axis-ymax'); if (aymax) aymax.value = cd.axisYMax != null ? cd.axisYMax : '';
  const acEl = document.getElementById('ced-axis-color'); if (acEl) acEl.value = cd.axisColor || '#313244';
  const lcEl = document.getElementById('ced-label-color'); if (lcEl) lcEl.value = cd.axisLabelColor || '#6c7086';
  _setRange('ced-label-size', 'ced-ls-val', cd.axisLabelSize || 9);
  // Marker
  const msEl = document.getElementById('ced-marker-shape'); if (msEl) msEl.value = cd.markerShape || 'circle';
  _setRange('ced-marker-size', 'ced-ms-val', cd.markerSize ?? 5);
  // Plot area
  const pbOnEl = document.getElementById('ced-plot-bg-on'); if (pbOnEl) pbOnEl.checked = !!(cd.plotBgColor);
  const pbEl = document.getElementById('ced-plot-bg-color'); if (pbEl) pbEl.value = cd.plotBgColor || '#1e1e2e';
  _setRange('ced-grid-opacity', 'ced-go-val', cd.gridOpacity ?? 7);
  // Border
  const sbEl = document.getElementById('ced-show-border'); if (sbEl) sbEl.checked = !!(cd.showBorder);
  const bcEl = document.getElementById('ced-border-color'); if (bcEl) bcEl.value = cd.borderColor || '#45475a';
  _setRange('ced-border-width', 'ced-bw-val', cd.borderWidth ?? 1);
  _setRange('ced-border-rx', 'ced-brx-val', cd.borderRx ?? 6);
  // Animation detail
  const adEl = document.getElementById('ced-anim-dur');
  if (adEl) { adEl.value = cd.animDuration || 0; const v = document.getElementById('ced-ad-val'); if (v) v.textContent = adEl.value == 0 ? '自動' : adEl.value + 'ms'; }
  const aeEl = document.getElementById('ced-anim-easing'); if (aeEl) aeEl.value = cd.animEasing || 'auto';
  const lfEl = document.getElementById('ced-line-fill'); if (lfEl) lfEl.checked = cd.lineFill !== false;
  const adEl2 = document.getElementById('ced-anim-dots');   if (adEl2) adEl2.checked = cd.animateDots !== false;
  const avEl  = document.getElementById('ced-anim-values'); if (avEl)  avEl.checked  = cd.animateValues !== false;
  _renderChartEditorRows(cd.series || []);
}

function _resetChartEditorData() {
  document.querySelectorAll('.ced-type-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  document.getElementById('ced-title').value = '';
  document.getElementById('ced-show-values').checked = true;
  document.getElementById('ced-show-grid').checked = true;
  document.getElementById('ced-anim-style').value = 'cascade';
  document.querySelectorAll('.ced-palette-item').forEach((item, i) => item.classList.toggle('active', i === 0));
  const _setRange = (id, valId, val) => { const el = document.getElementById(id); if (el) { el.value = val; const v = document.getElementById(valId); if (v) v.textContent = val; } };
  _setRange('ced-line-width', 'ced-lw-val', 2.5);
  _setRange('ced-bar-radius', 'ced-br-val', 3);
  const slEl = document.getElementById('ced-show-legend'); if (slEl) slEl.checked = true;
  const aymin = document.getElementById('ced-axis-ymin'); if (aymin) aymin.value = '';
  const aymax = document.getElementById('ced-axis-ymax'); if (aymax) aymax.value = '';
  const acEl = document.getElementById('ced-axis-color'); if (acEl) acEl.value = '#313244';
  const lcEl = document.getElementById('ced-label-color'); if (lcEl) lcEl.value = '#6c7086';
  _setRange('ced-label-size', 'ced-ls-val', 9);
  const msEl = document.getElementById('ced-marker-shape'); if (msEl) msEl.value = 'circle';
  _setRange('ced-marker-size', 'ced-ms-val', 5);
  const pbOnEl = document.getElementById('ced-plot-bg-on'); if (pbOnEl) pbOnEl.checked = false;
  const pbEl = document.getElementById('ced-plot-bg-color'); if (pbEl) pbEl.value = '#1e1e2e';
  _setRange('ced-grid-opacity', 'ced-go-val', 7);
  const sbEl = document.getElementById('ced-show-border'); if (sbEl) sbEl.checked = false;
  const bcEl = document.getElementById('ced-border-color'); if (bcEl) bcEl.value = '#45475a';
  _setRange('ced-border-width', 'ced-bw-val', 1);
  _setRange('ced-border-rx', 'ced-brx-val', 6);
  const adEl = document.getElementById('ced-anim-dur');
  if (adEl) { adEl.value = 0; const v = document.getElementById('ced-ad-val'); if (v) v.textContent = '自動'; }
  const aeEl = document.getElementById('ced-anim-easing'); if (aeEl) aeEl.value = 'auto';
  const lfEl2 = document.getElementById('ced-line-fill'); if (lfEl2) lfEl2.checked = true;
  const adEl3 = document.getElementById('ced-anim-dots');   if (adEl3) adEl3.checked = true;
  const avEl2 = document.getElementById('ced-anim-values'); if (avEl2) avEl2.checked = true;
  _renderChartEditorRows([{label:'Q1',value:42},{label:'Q2',value:78},{label:'Q3',value:56},{label:'Q4',value:91}]);
}

function _renderChartEditorRows(series) {
  const container = document.getElementById('ced-rows');
  container.innerHTML = '';
  series.forEach(item => _addChartEditorRow(item.label, item.value));
}

function _addChartEditorRow(label = '', value = '') {
  const container = document.getElementById('ced-rows');
  const row = document.createElement('div');
  row.className = 'ced-row';
  row.innerHTML = `
    <input class="ced-row-label" type="text" value="${_escSvg(String(label))}" placeholder="ラベル">
    <input class="ced-row-value" type="number" value="${value}" placeholder="0" min="0">
    <button class="ced-row-del" title="削除">✕</button>
  `;
  row.querySelector('.ced-row-del').addEventListener('click', () => {
    row.remove();
    _updateChartEditorPreview();
  });
  row.querySelector('.ced-row-label').addEventListener('input', _updateChartEditorPreview);
  row.querySelector('.ced-row-value').addEventListener('input', _updateChartEditorPreview);
  container.appendChild(row);
}

function _updateChartEditorPreview() {
  const cd = _getChartEditorData();
  const preview = document.getElementById('ced-preview');
  if (!preview) return;
  _syncAnimStyleOptions(cd.chartType);
  _updateFormatSection(cd.chartType);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 400 280');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.cssText = 'width:100%;height:100%;display:block;';
  svg.innerHTML = buildChartSVGContent(cd);
  preview.innerHTML = '';
  preview.appendChild(svg);
}

function _updateFormatSection(chartType) {
  const rowLW  = document.getElementById('fmt-row-linewidth');
  const rowBR  = document.getElementById('fmt-row-barradius');
  const rowLG  = document.getElementById('fmt-row-legend');
  const rowLF  = document.getElementById('fmt-row-linefill');
  const accSt  = document.getElementById('acc-style');
  const accAx  = document.getElementById('acc-axis');
  const accMk  = document.getElementById('acc-marker');
  const isLine  = chartType === 'line' || chartType === 'area';
  const isBar   = chartType === 'bar'  || chartType === 'hbar';
  const isPie   = chartType === 'pie'  || chartType === 'donut';
  const isRadar = chartType === 'radar';
  if (rowLW) rowLW.style.display = isLine ? '' : 'none';
  if (rowBR) rowBR.style.display = isBar  ? '' : 'none';
  if (rowLG) rowLG.style.display = isPie  ? '' : 'none';
  if (rowLF) rowLF.style.display = chartType === 'line' ? '' : 'none';
  const rowAD = document.getElementById('fmt-row-anim-dots');
  const rowAV = document.getElementById('fmt-row-anim-values');
  if (rowAD) rowAD.style.display = isLine ? '' : 'none';
  if (rowAV) rowAV.style.display = isLine ? '' : 'none';
  if (accSt) accSt.style.display = isRadar ? 'none' : '';
  if (accAx) accAx.style.display = (isPie || isRadar) ? 'none' : '';
  if (accMk) accMk.style.display = (isLine || isRadar) ? '' : 'none';
}

function _syncAnimStyleOptions(chartType) {
  const sel = document.getElementById('ced-anim-style');
  if (!sel) return;
  const cur = sel.value;
  const map = {
    bar:   [{v:'cascade',t:'順番に (カスケード)'},{v:'rise',t:'一斉に'},{v:'bounce',t:'バウンス'},{v:'fade',t:'フェード'}],
    hbar:  [{v:'slide',t:'スライド (順番に)'},{v:'rise',t:'一斉に'}],
    line:  [{v:'draw',t:'描画'},{v:'dot-first',t:'点から描画'},{v:'rise',t:'浮き上がり'},{v:'pop',t:'ポップ'},{v:'fade',t:'フェード'}],
    area:  [{v:'draw',t:'描画'},{v:'rise',t:'浮き上がり'},{v:'pop',t:'ポップ'},{v:'fade',t:'フェード'}],
    radar: [{v:'expand',t:'展開'},{v:'fade',t:'フェード'}],
    pie:   [{v:'sweep',t:'展開 (順番に)'},{v:'burst',t:'一斉に'}],
    donut: [{v:'sweep',t:'展開 (順番に)'},{v:'burst',t:'一斉に'}],
  };
  const opts = map[chartType] || map.bar;
  sel.innerHTML = opts.map(o => `<option value="${o.v}">${o.t}</option>`).join('');
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}

(function initChartEditor() {
  // Tab switching
  document.querySelectorAll('.ced-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ced-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      document.getElementById('ced-pane-data').style.display = target === 'data' ? '' : 'none';
      document.getElementById('ced-pane-fmt').style.display  = target === 'fmt'  ? '' : 'none';
    });
  });

  // Accordion toggle
  document.querySelectorAll('.acc-head').forEach(head => {
    head.addEventListener('click', () => {
      head.closest('.acc-group').classList.toggle('open');
    });
  });

  // Build palette picker
  const paletteGrid = document.getElementById('ced-palette-grid');
  if (paletteGrid) {
    CHART_PALETTE_META.forEach((meta, idx) => {
      const item = document.createElement('div');
      item.className = 'ced-palette-item' + (idx === 0 ? ' active' : '');
      item.dataset.palette = meta.key;
      const colors = CHART_PALETTES[meta.key];
      item.innerHTML = `<div class="ced-palette-dots">${colors.slice(0,5).map(c=>`<span class="ced-palette-dot" style="background:${c}"></span>`).join('')}</div><span class="ced-palette-name">${meta.name}</span>`;
      item.addEventListener('click', () => {
        paletteGrid.querySelectorAll('.ced-palette-item').forEach(el => el.classList.remove('active'));
        item.classList.add('active');
        _updateChartEditorPreview();
      });
      paletteGrid.appendChild(item);
    });
  }

  document.querySelectorAll('.ced-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ced-type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _updateChartEditorPreview();
    });
  });

  const cedTitle = document.getElementById('ced-title');
  if (cedTitle) cedTitle.addEventListener('input', _updateChartEditorPreview);

  const cedShowValues = document.getElementById('ced-show-values');
  if (cedShowValues) cedShowValues.addEventListener('change', _updateChartEditorPreview);

  const cedShowGrid = document.getElementById('ced-show-grid');
  if (cedShowGrid) cedShowGrid.addEventListener('change', _updateChartEditorPreview);

  const cedShowLegend = document.getElementById('ced-show-legend');
  if (cedShowLegend) cedShowLegend.addEventListener('change', _updateChartEditorPreview);

  const cedLineWidth = document.getElementById('ced-line-width');
  if (cedLineWidth) cedLineWidth.addEventListener('input', () => {
    const v = document.getElementById('ced-lw-val');
    if (v) v.textContent = cedLineWidth.value;
    _updateChartEditorPreview();
  });

  const cedBarRadius = document.getElementById('ced-bar-radius');
  if (cedBarRadius) cedBarRadius.addEventListener('input', () => {
    const v = document.getElementById('ced-br-val');
    if (v) v.textContent = cedBarRadius.value;
    _updateChartEditorPreview();
  });

  const cedAnimStyle = document.getElementById('ced-anim-style');
  if (cedAnimStyle) cedAnimStyle.addEventListener('change', _updateChartEditorPreview);

  const cedAddRow = document.getElementById('ced-add-row');
  if (cedAddRow) cedAddRow.addEventListener('click', () => {
    _addChartEditorRow();
    _updateChartEditorPreview();
  });

  const cedPlayBtn = document.getElementById('ced-play-btn');
  if (cedPlayBtn) cedPlayBtn.addEventListener('click', () => {
    _updateChartEditorPreview();
    const cd = _getChartEditorData();
    const preview = document.getElementById('ced-preview');
    if (preview) playChartAnimation(preview, cd);
  });

  // New format controls
  const _onFmtInput = _updateChartEditorPreview;
  ['ced-axis-ymin','ced-axis-ymax'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', _onFmtInput);
  });
  ['ced-axis-color','ced-label-color','ced-plot-bg-color','ced-border-color'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', _onFmtInput);
  });
  ['ced-plot-bg-on','ced-show-border','ced-line-fill','ced-anim-dots','ced-anim-values'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', _onFmtInput);
  });
  ['ced-marker-shape','ced-anim-easing'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', _onFmtInput);
  });
  [
    ['ced-label-size',   'ced-ls-val',  v => v],
    ['ced-marker-size',  'ced-ms-val',  v => v],
    ['ced-grid-opacity', 'ced-go-val',  v => v],
    ['ced-border-width', 'ced-bw-val',  v => v],
    ['ced-border-rx',    'ced-brx-val', v => v],
    ['ced-anim-dur',     'ced-ad-val',  v => v == 0 ? '自動' : v + 'ms'],
  ].forEach(([rangeId, valId, fmt]) => {
    const el = document.getElementById(rangeId);
    if (el) el.addEventListener('input', () => {
      const v = document.getElementById(valId);
      if (v) v.textContent = fmt(el.value);
      _onFmtInput();
    });
  });

  const cedCancel = document.getElementById('ced-cancel');
  if (cedCancel) cedCancel.addEventListener('click', closeChartEditor);

  const cedClose = document.getElementById('ced-close');
  if (cedClose) cedClose.addEventListener('click', closeChartEditor);

  const cedOk = document.getElementById('ced-ok');
  if (cedOk) cedOk.addEventListener('click', () => {
    const cd = _getChartEditorData();
    if (!cd.series.length) { alert('データを1つ以上入力してください'); return; }
    pushHistory();
    if (_chartEditorTargetId) {
      const d = getElementData(_chartEditorTargetId);
      if (d) { d.chartData = cd; renderAll(); }
    } else {
      const slide = getCurrentSlideData();
      const x = Math.round((state.slideWidth - 420) / 2);
      const y = Math.round((computeSlideHeight(slide) - 280) / 2);
      const d = createElementData('chart', x, y);
      d.chartData = cd;
      slide.elements.push(d);
      state.selectedElement = d.id;
      state.selectedElements = new Set([d.id]);
      renderAll();
      updatePropertiesPanel();
    }
    closeChartEditor();
  });

  const modal = document.getElementById('chart-editor-modal');
  if (modal) modal.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeChartEditor();
  });

  const btnInsertChart = document.getElementById('btn-insert-chart');
  if (btnInsertChart) btnInsertChart.addEventListener('click', () => openChartEditor(null));
}());

// ===== 表（Table）機能 =====

// ----- セルデータ生成 -----
function createTableCellData(opts = {}) {
  return {
    text: '',
    fill: opts.fill || '#ffffff',
    fillNone: opts.fillNone !== undefined ? opts.fillNone : true,
    stroke: '#aaaaaa',
    strokeWidth: 1,
    strokeStyle: 'solid',
    borderTop: true, borderRight: true, borderBottom: true, borderLeft: true,
    fontSize: 14,
    fontFamily: "'Noto Sans JP', sans-serif",
    color: opts.color || '#333333',
    fontWeight: opts.fontWeight || 'normal',
    fontStyle: 'normal',
    underline: '',
    textAlign: 'center',
    vertAlign: 'middle',
    diagDown: false, diagDownColor: '#333333', diagDownWidth: 1, diagDownStyle: 'solid',
    diagUp:   false, diagUpColor:   '#333333', diagUpWidth:   1, diagUpStyle:   'solid',
    colSpan: 1, rowSpan: 1, merged: false,
  };
}

// ----- 表の挿入 -----
function insertTable(rows, cols) {
  pushHistory();
  const slide = getCurrentSlideData();
  const w = Math.min(state.slideWidth - 40, 480);
  const h = Math.min(computeSlideHeight(slide) - 40, 220);
  const x = Math.round((state.slideWidth - w) / 2);
  const y = Math.round((computeSlideHeight(slide) - h) / 2);

  const data = createElementData('table', x, y);
  data.w = w; data.h = h;
  data.rows = rows; data.cols = cols;

  const rowH = Math.max(Math.round(h / rows), 24);
  const colW = Math.max(Math.round(w / cols), 30);
  data.rowHeights = Array(rows).fill(rowH);
  data.colWidths  = Array(cols).fill(colW);

  const cells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push(createTableCellData({
      }));
    }
    cells.push(row);
  }
  data.cells = cells;

  slide.elements.push(data);
  state.selectedElement = data.id;
  state.selectedElements = new Set([data.id]);
  state.selectedTableCell = null;
  state.selectedTableCells = [];
  selectTool('select');
  renderAll();
  updatePropertiesPanel();
}

// ----- 表サムネイルSVG生成 -----
function buildTableThumbnailSVG(data) {
  const { rows, cols, cells, colWidths, rowHeights } = data;
  const totalW = colWidths.reduce((s, v) => s + v, 0) || cols;
  const totalH = rowHeights.reduce((s, v) => s + v, 0) || rows;
  let svg = '';
  let y = 0;
  for (let r = 0; r < rows; r++) {
    const rh = (rowHeights[r] / totalH) * 100;
    let x = 0;
    for (let c = 0; c < cols; c++) {
      const cw = (colWidths[c] / totalW) * 100;
      const cell = cells[r]?.[c];
      if (cell && !cell.merged) {
        const spC = cell.colSpan || 1;
        const spR = cell.rowSpan || 1;
        let cellW = 0, cellH = 0;
        for (let ci = c; ci < c + spC && ci < cols; ci++) cellW += (colWidths[ci] / totalW) * 100;
        for (let ri = r; ri < r + spR && ri < rows; ri++) cellH += (rowHeights[ri] / totalH) * 100;
        const fill = cell.fillNone ? 'transparent' : (cell.fill || '#ffffff');
        const stroke = cell.stroke || '#aaaaaa';
        svg += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${cellW.toFixed(2)}" height="${cellH.toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="0.8"/>`;
      }
      x += cw;
    }
    y += rh;
  }
  return svg;
}

// ----- 表要素のDOM構築 -----
function buildTableElement(data) {
  const { rows, cols, cells, colWidths, rowHeights } = data;
  const totalW = colWidths.reduce((s, v) => s + v, 0) || cols;
  const totalH = rowHeights.reduce((s, v) => s + v, 0) || rows;
  const colPcts = colWidths.map(v => (v / totalW * 100).toFixed(4) + '%');
  const rowPcts = rowHeights.map(v => (v / totalH * 100).toFixed(4) + '%');

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;';

  const table = document.createElement('table');
  table.className = 'tbl-inner';

  const cg = document.createElement('colgroup');
  colPcts.forEach(p => { const col = document.createElement('col'); col.style.width = p; cg.appendChild(col); });
  table.appendChild(cg);

  const tbody = document.createElement('tbody');
  const isTableSel = state.selectedElement === data.id;

  for (let r = 0; r < rows; r++) {
    const tr = document.createElement('tr');
    tr.style.height = rowPcts[r];
    for (let c = 0; c < cols; c++) {
      const cell = cells[r]?.[c];
      if (!cell || cell.merged) continue;

      const td = document.createElement('td');
      td.dataset.row = r;
      td.dataset.col = c;
      td.dataset.tableId = data.id;

      // 罫線スタイル
      const bStyle = cell.strokeStyle === 'dashed' ? 'dashed'
                   : cell.strokeStyle === 'dotted'  ? 'dotted' : 'solid';
      const bv = `${cell.strokeWidth || 1}px ${bStyle} ${cell.stroke || '#aaaaaa'}`;
      td.style.borderTop    = cell.borderTop    ? bv : 'none';
      td.style.borderRight  = cell.borderRight  ? bv : 'none';
      td.style.borderBottom = cell.borderBottom ? bv : 'none';
      td.style.borderLeft   = cell.borderLeft   ? bv : 'none';

      // 塗りつぶし
      td.style.background = cell.fillNone ? 'transparent' : (cell.fill || '#ffffff');

      // テキストスタイル
      td.style.fontSize      = (cell.fontSize || 14) + 'px';
      td.style.fontFamily    = cell.fontFamily || "'Noto Sans JP', sans-serif";
      td.style.color         = cell.color || '#333333';
      td.style.fontWeight    = cell.fontWeight || 'normal';
      td.style.fontStyle     = cell.fontStyle || 'normal';
      td.style.textDecoration = cell.underline ? 'underline' : '';
      td.style.textAlign     = cell.textAlign || 'center';
      td.style.verticalAlign = cell.vertAlign || 'middle';
      td.style.padding       = '3px 6px';
      td.style.userSelect    = 'none';

      if ((cell.colSpan || 1) > 1) td.colSpan = cell.colSpan;
      if ((cell.rowSpan || 1) > 1) td.rowSpan = cell.rowSpan;

      // セル選択ハイライト
      if (isTableSel && state.selectedTableCells.some(s => s.row === r && s.col === c)) {
        td.classList.add('tbl-cell-selected');
      }

      // テキストコンテナ
      const textDiv = document.createElement('div');
      textDiv.className = 'tbl-cell-text';
      textDiv.style.cssText = 'position:relative;z-index:1;white-space:pre-wrap;word-break:break-word;min-height:1em;pointer-events:none;';
      textDiv.textContent = cell.text || '';
      td.appendChild(textDiv);

      // 斜め線SVG
      if (cell.diagDown || cell.diagUp) {
        const dsvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        dsvg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;overflow:visible;';
        dsvg.setAttribute('viewBox', '0 0 100 100');
        dsvg.setAttribute('preserveAspectRatio', 'none');
        if (cell.diagDown) {
          const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          ln.setAttribute('x1','0'); ln.setAttribute('y1','0'); ln.setAttribute('x2','100'); ln.setAttribute('y2','100');
          ln.setAttribute('stroke', cell.diagDownColor || '#333333');
          ln.setAttribute('stroke-width', (cell.diagDownWidth || 1) * 0.4);
          ln.setAttribute('vector-effect', 'non-scaling-stroke');
          ln.setAttribute('stroke-dasharray', _tblDashArray(cell.diagDownStyle));
          dsvg.appendChild(ln);
        }
        if (cell.diagUp) {
          const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          ln.setAttribute('x1','0'); ln.setAttribute('y1','100'); ln.setAttribute('x2','100'); ln.setAttribute('y2','0');
          ln.setAttribute('stroke', cell.diagUpColor || '#333333');
          ln.setAttribute('stroke-width', (cell.diagUpWidth || 1) * 0.4);
          ln.setAttribute('vector-effect', 'non-scaling-stroke');
          ln.setAttribute('stroke-dasharray', _tblDashArray(cell.diagUpStyle));
          dsvg.appendChild(ln);
        }
        td.appendChild(dsvg);
      }

      // セルクリック → PPTモデル
      // 表が未選択：伝播させてonElementMouseDownに表ドラッグを任せる
      // 表が選択済：伝播を止めてセル操作（ダブルクリック検出・ドラッグ範囲選択）
      td.addEventListener('mousedown', (e) => {
        if (!state.selectedElements.has(data.id)) {
          // 1クリック目：表をまず選択させる（伝播させてonElementMouseDownに任せる）
          // ダブルクリック検出のため時刻だけ記録しておく
          _tblDblClick = { tableId: data.id, row: r, col: c, time: Date.now() };
          return;
        }
        e.stopPropagation();

        // ダブルクリック検出
        const now = Date.now();
        const isDbl = _tblDblClick.tableId === data.id &&
                      _tblDblClick.row === r &&
                      _tblDblClick.col === c &&
                      (now - _tblDblClick.time) < 400;
        _tblDblClick = { tableId: data.id, row: r, col: c, time: now };

        if (isDbl) {
          _startTableCellEditById(data.id, r, c);
          return;
        }

        // セル選択
        if (e.ctrlKey) {
          const idx = state.selectedTableCells.findIndex(s => s.row === r && s.col === c);
          if (idx >= 0) {
            state.selectedTableCells.splice(idx, 1);
            if (state.selectedTableCell?.row === r && state.selectedTableCell?.col === c) {
              state.selectedTableCell = state.selectedTableCells[0] || null;
            }
          } else {
            state.selectedTableCells.push({ row: r, col: c });
            state.selectedTableCell = { row: r, col: c };
          }
          renderAll();
          updateTableFormatRibbon();
          return;
        }

        state.selectedTableCell = { row: r, col: c };
        state.selectedTableCells = [{ row: r, col: c }];
        renderAll();
        updateTableFormatRibbon();

        // ドラッグ範囲選択
        const startRow = r, startCol = c;
        let dragging = false;

        const onMove = (me) => {
          const el = document.elementFromPoint(me.clientX, me.clientY);
          const overTd = el?.closest?.('td[data-table-id]');
          if (!overTd || overTd.dataset.tableId !== String(data.id)) return;
          const endRow = parseInt(overTd.dataset.row);
          const endCol = parseInt(overTd.dataset.col);
          if (isNaN(endRow) || isNaN(endCol)) return;
          if (endRow === startRow && endCol === startCol && !dragging) return;
          dragging = true;

          const minR = Math.min(startRow, endRow), maxR = Math.max(startRow, endRow);
          const minC = Math.min(startCol, endCol), maxC = Math.max(startCol, endCol);
          state.selectedTableCells = [];
          for (let rr = minR; rr <= maxR; rr++) {
            for (let cc = minC; cc <= maxC; cc++) {
              state.selectedTableCells.push({ row: rr, col: cc });
            }
          }
          state.selectedTableCell = { row: startRow, col: startCol };

          // ハイライトだけ更新（renderAllを避けてパフォーマンス確保）
          const wrapper = canvas.querySelector(`[data-id="${data.id}"]`);
          if (wrapper) {
            wrapper.querySelectorAll('td[data-table-id]').forEach(cell => {
              const cr = parseInt(cell.dataset.row), cc2 = parseInt(cell.dataset.col);
              cell.classList.toggle('tbl-cell-selected',
                state.selectedTableCells.some(s => s.row === cr && s.col === cc2));
            });
          }
          updateTableFormatRibbon();
        };

        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if (dragging) { renderAll(); updateTableFormatRibbon(); }
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrapper.appendChild(table);

  // 列・行リサイズハンドル（表選択中のみ表示）
  if (isTableSel) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:8;';

    // 列境界ハンドル
    let cumC = 0;
    for (let ci = 0; ci < cols - 1; ci++) {
      cumC += colWidths[ci] / totalW * 100;
      const hLine = document.createElement('div');
      hLine.style.cssText = `position:absolute;top:0;bottom:0;left:${cumC.toFixed(4)}%;width:10px;margin-left:-5px;cursor:col-resize;pointer-events:auto;`;
      const capturedCi = ci;
      hLine.addEventListener('mousedown', (e) => {
        e.stopPropagation(); e.preventDefault();
        pushHistory();
        const sx = e.clientX;
        const w0 = data.colWidths[capturedCi], w1 = data.colWidths[capturedCi + 1];
        const MIN = 20;
        const onMove = (me) => {
          const dx = (me.clientX - sx) / state.scale;
          const nw0 = Math.max(MIN, Math.min(w0 + w1 - MIN, w0 + dx));
          data.colWidths[capturedCi] = nw0;
          data.colWidths[capturedCi + 1] = w0 + w1 - nw0;
          renderAll();
        };
        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      overlay.appendChild(hLine);
    }

    // 行境界ハンドル
    let cumR = 0;
    for (let ri = 0; ri < rows - 1; ri++) {
      cumR += rowHeights[ri] / totalH * 100;
      const vLine = document.createElement('div');
      vLine.style.cssText = `position:absolute;left:0;right:0;top:${cumR.toFixed(4)}%;height:10px;margin-top:-5px;cursor:row-resize;pointer-events:auto;`;
      const capturedRi = ri;
      vLine.addEventListener('mousedown', (e) => {
        e.stopPropagation(); e.preventDefault();
        pushHistory();
        const sy = e.clientY;
        const h0 = data.rowHeights[capturedRi], h1 = data.rowHeights[capturedRi + 1];
        const MIN = 15;
        const onMove = (me) => {
          const dy = (me.clientY - sy) / state.scale;
          const nh0 = Math.max(MIN, Math.min(h0 + h1 - MIN, h0 + dy));
          data.rowHeights[capturedRi] = nh0;
          data.rowHeights[capturedRi + 1] = h0 + h1 - nh0;
          renderAll();
        };
        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      overlay.appendChild(vLine);
    }

    wrapper.appendChild(overlay);
  }

  return wrapper;
}

function _tblDashArray(style) {
  if (style === 'dashed') return '6 4';
  if (style === 'dotted') return '2 3';
  return 'none';
}

// ----- セルテキスト編集 -----

function _startTableCellEdit(tableId, row, col, textDiv) {
  if (_editingTableCell) finishTableCellEdit();
  const data = getElementData(tableId);
  if (!data || data.type !== 'table') return;
  const cell = data.cells[row]?.[col];
  if (!cell || cell.merged) return;

  _editingTableCell = { tableId, row, col, textDiv };
  textDiv.style.pointerEvents = 'auto';
  textDiv.contentEditable = 'true';
  textDiv.style.userSelect = 'text';
  textDiv.style.cursor = 'text';
  textDiv.style.outline = 'none';
  textDiv.textContent = cell.text || '';

  requestAnimationFrame(() => {
    textDiv.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(textDiv);
      range.collapse(false);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    } catch(_) {}
  });
  textDiv.addEventListener('keydown', (e) => { e.stopPropagation(); }, { capture: true });
}

function _startTableCellEditById(tableId, row, col) {
  const wrapper = canvas.querySelector(`[data-id="${tableId}"]`);
  if (!wrapper) return;
  const td = wrapper.querySelector(`td[data-row="${row}"][data-col="${col}"]`);
  if (!td) return;
  const textDiv = td.querySelector('.tbl-cell-text');
  if (!textDiv) return;
  // セルを選択状態にしてから編集開始
  state.selectedTableCell = { row, col };
  state.selectedTableCells = [{ row, col }];
  _startTableCellEdit(tableId, row, col, textDiv);
}

function finishTableCellEdit() {
  if (!_editingTableCell) return;
  const { tableId, row, col, textDiv } = _editingTableCell;
  _editingTableCell = null;
  const data = getElementData(tableId);
  if (data && data.cells[row]?.[col]) {
    data.cells[row][col].text = textDiv.innerText || '';
  }
  textDiv.contentEditable = 'false';
  textDiv.style.userSelect = '';
  textDiv.style.cursor = '';
  textDiv.style.pointerEvents = '';
}

// ----- 表の書式タブ：リボン更新 -----
function updateTableFormatRibbon() {
  const td = getSelectedTableData();
  if (!td) return;
  const cell = getSelectedCellData();
  if (!cell) return;

  // 塗りつぶし
  const fill = cell.fillNone ? 'transparent' : (cell.fill || '#ffffff');
  const fp = document.getElementById('tbl-fill-preview');
  if (fp) fp.style.background = fill;
  const fnc = document.getElementById('tbl-fill-none');
  if (fnc) fnc.checked = !!cell.fillNone;

  // 罫線
  const bcp = document.getElementById('tbl-border-color-preview');
  if (bcp) bcp.style.background = cell.stroke || '#aaaaaa';
  const bw = document.getElementById('tbl-border-width');
  if (bw) bw.value = cell.strokeWidth || 1;
  const bs = document.getElementById('tbl-border-style');
  if (bs) bs.value = cell.strokeStyle || 'solid';

  // 斜め線
  const dd = document.getElementById('tbl-diag-down');
  if (dd) dd.classList.toggle('active', !!cell.diagDown);
  const du = document.getElementById('tbl-diag-up');
  if (du) du.classList.toggle('active', !!cell.diagUp);
  const dcp = document.getElementById('tbl-diag-color-preview');
  if (dcp) dcp.style.background = cell.diagDownColor || cell.diagUpColor || '#333333';
  const dw = document.getElementById('tbl-diag-width');
  if (dw) dw.value = cell.diagDownWidth || cell.diagUpWidth || 1;
  const ds = document.getElementById('tbl-diag-style');
  if (ds) ds.value = cell.diagDownStyle || cell.diagUpStyle || 'solid';

  // テキスト配置
  document.querySelectorAll('.tbl-halign').forEach(b => b.classList.toggle('active', b.dataset.align === (cell.textAlign || 'center')));
  document.querySelectorAll('.tbl-valign').forEach(b => b.classList.toggle('active', b.dataset.align === (cell.vertAlign || 'middle')));
}

// ----- ヘルパー -----
function getSelectedTableData() {
  if (!state.selectedElement) return null;
  const d = getElementData(state.selectedElement);
  return (d && d.type === 'table') ? d : null;
}

function getSelectedCellData() {
  const td = getSelectedTableData();
  if (!td || !state.selectedTableCell) return null;
  const { row, col } = state.selectedTableCell;
  return td.cells[row]?.[col] || null;
}

function _getCellsToApply(tableData) {
  if (state.selectedTableCells && state.selectedTableCells.length > 0) {
    return state.selectedTableCells;
  }
  const result = [];
  for (let r = 0; r < tableData.rows; r++)
    for (let c = 0; c < tableData.cols; c++)
      if (!tableData.cells[r]?.[c]?.merged) result.push({ row: r, col: c });
  return result;
}

function _applyCellProp(prop, value) {
  const tableData = getSelectedTableData();
  if (!tableData) return;
  const targets = state.selectedTableCells?.length > 0
    ? state.selectedTableCells
    : (state.selectedTableCell ? [state.selectedTableCell] : []);
  targets.forEach(({ row, col }) => {
    const cell = tableData.cells[row]?.[col];
    if (cell && !cell.merged) cell[prop] = value;
  });
}

// ----- 罫線プリセット -----
function _applyBorderPreset(preset) {
  const tableData = getSelectedTableData();
  if (!tableData) return;
  const color = document.getElementById('tbl-border-color-preview')?.style.background || '#aaaaaa';
  const width = parseFloat(document.getElementById('tbl-border-width')?.value || 1);
  const style = document.getElementById('tbl-border-style')?.value || 'solid';
  const targets = _getCellsToApply(tableData);
  const { rows, cols } = tableData;
  targets.forEach(({ row: r, col: c }) => {
    const cell = tableData.cells[r]?.[c];
    if (!cell || cell.merged) return;
    cell.stroke = color; cell.strokeWidth = width; cell.strokeStyle = style;
    switch (preset) {
      case 'all':
        cell.borderTop = cell.borderRight = cell.borderBottom = cell.borderLeft = true; break;
      case 'none':
        cell.borderTop = cell.borderRight = cell.borderBottom = cell.borderLeft = false; break;
      case 'outer':
        cell.borderTop    = r === 0;
        cell.borderBottom = r === rows - 1;
        cell.borderLeft   = c === 0;
        cell.borderRight  = c === cols - 1;
        break;
      case 'inner':
        cell.borderTop    = r > 0;
        cell.borderBottom = r < rows - 1;
        cell.borderLeft   = c > 0;
        cell.borderRight  = c < cols - 1;
        break;
    }
  });
}

// ----- 行・列の操作 -----
function _tblAddRowAbove() {
  const td = getSelectedTableData(); if (!td) return;
  pushHistory();
  const row = state.selectedTableCell?.row ?? 0;
  const newRow = Array(td.cols).fill(null).map(() => createTableCellData());
  td.cells.splice(row, 0, newRow);
  td.rowHeights.splice(row, 0, td.rowHeights[row] || 40);
  td.rows++;
  if (state.selectedTableCell) state.selectedTableCell.row++;
  state.selectedTableCells.forEach(s => { if (s.row >= row) s.row++; });
  renderAll(); updateTableFormatRibbon();
}

function _tblAddRowBelow() {
  const td = getSelectedTableData(); if (!td) return;
  pushHistory();
  const row = (state.selectedTableCell?.row ?? td.rows - 1) + 1;
  const newRow = Array(td.cols).fill(null).map(() => createTableCellData());
  td.cells.splice(row, 0, newRow);
  td.rowHeights.splice(row, 0, td.rowHeights[row - 1] || 40);
  td.rows++;
  renderAll(); updateTableFormatRibbon();
}

function _tblDelRow() {
  const td = getSelectedTableData(); if (!td || td.rows <= 1) return;
  pushHistory();
  const row = state.selectedTableCell?.row ?? td.rows - 1;
  td.cells.splice(row, 1);
  td.rowHeights.splice(row, 1);
  td.rows--;
  state.selectedTableCell = null; state.selectedTableCells = [];
  renderAll(); updateTableFormatRibbon();
}

function _tblAddColLeft() {
  const td = getSelectedTableData(); if (!td) return;
  pushHistory();
  const col = state.selectedTableCell?.col ?? 0;
  for (let r = 0; r < td.rows; r++) td.cells[r].splice(col, 0, createTableCellData());
  td.colWidths.splice(col, 0, td.colWidths[col] || 80);
  td.cols++;
  if (state.selectedTableCell) state.selectedTableCell.col++;
  state.selectedTableCells.forEach(s => { if (s.col >= col) s.col++; });
  renderAll(); updateTableFormatRibbon();
}

function _tblAddColRight() {
  const td = getSelectedTableData(); if (!td) return;
  pushHistory();
  const col = (state.selectedTableCell?.col ?? td.cols - 1) + 1;
  for (let r = 0; r < td.rows; r++) td.cells[r].splice(col, 0, createTableCellData());
  td.colWidths.splice(col, 0, td.colWidths[col - 1] || 80);
  td.cols++;
  renderAll(); updateTableFormatRibbon();
}

function _tblDelCol() {
  const td = getSelectedTableData(); if (!td || td.cols <= 1) return;
  pushHistory();
  const col = state.selectedTableCell?.col ?? td.cols - 1;
  for (let r = 0; r < td.rows; r++) td.cells[r].splice(col, 1);
  td.colWidths.splice(col, 1);
  td.cols--;
  state.selectedTableCell = null; state.selectedTableCells = [];
  renderAll(); updateTableFormatRibbon();
}

function _tblEqHeight() {
  const td = getSelectedTableData(); if (!td) return;
  pushHistory();
  const avg = Math.max(Math.round(td.h / td.rows), 20);
  td.rowHeights = Array(td.rows).fill(avg);
  renderAll();
}

function _tblEqWidth() {
  const td = getSelectedTableData(); if (!td) return;
  pushHistory();
  const avg = Math.max(Math.round(td.w / td.cols), 30);
  td.colWidths = Array(td.cols).fill(avg);
  renderAll();
}

// ----- セルの結合 -----
function _tblMergeCells() {
  const td = getSelectedTableData();
  if (!td || state.selectedTableCells.length < 2) {
    alert('結合するには2つ以上のセルをCtrl+クリックで選択してください');
    return;
  }
  const rows = state.selectedTableCells.map(s => s.row);
  const cols = state.selectedTableCells.map(s => s.col);
  const minR = Math.min(...rows), maxR = Math.max(...rows);
  const minC = Math.min(...cols), maxC = Math.max(...cols);
  if (state.selectedTableCells.length !== (maxR - minR + 1) * (maxC - minC + 1)) {
    alert('結合は長方形の範囲のみ可能です');
    return;
  }
  pushHistory();
  let allText = '';
  for (let r = minR; r <= maxR; r++)
    for (let c = minC; c <= maxC; c++) {
      const cell = td.cells[r]?.[c];
      if (cell && !cell.merged && cell.text) allText += (allText ? '\n' : '') + cell.text;
    }
  const master = td.cells[minR][minC];
  master.colSpan = maxC - minC + 1;
  master.rowSpan = maxR - minR + 1;
  master.merged = false;
  master.text = allText;
  for (let r = minR; r <= maxR; r++)
    for (let c = minC; c <= maxC; c++) {
      if (r === minR && c === minC) continue;
      td.cells[r][c].merged = true;
      td.cells[r][c].text = '';
    }
  state.selectedTableCell = { row: minR, col: minC };
  state.selectedTableCells = [{ row: minR, col: minC }];
  renderAll(); updateTableFormatRibbon();
}

// ----- セルの分割 -----

function _tblShowSplitDialog() {
  const td = getSelectedTableData();
  if (!td || !state.selectedTableCell) return;
  const cell = td.cells[state.selectedTableCell.row]?.[state.selectedTableCell.col];
  if (!cell || cell.merged) return;
  const dialog = document.getElementById('tbl-split-dialog');
  if (!dialog) return;
  // プリセット：現在の結合状態を初期値にする
  document.getElementById('tbl-split-cols').value = cell.colSpan || 1;
  document.getElementById('tbl-split-rows').value = cell.rowSpan || 1;
  dialog.style.display = 'flex';
  document.getElementById('tbl-split-cols').focus();
}

// 表の指定列にカラムを挿入（splitRowMin〜splitRowMax の行は新規セル、他はcolSpan拡張）
function _insertTableColumn(tbl, insertAt, splitRowMin, splitRowMax) {
  // insertAt-1 列の幅を半分にして新列を追加
  tbl.colWidths[insertAt - 1] = (tbl.colWidths[insertAt - 1] || 60) / 2;
  tbl.colWidths.splice(insertAt, 0, tbl.colWidths[insertAt - 1]);
  tbl.cols++;
  for (let r = 0; r < tbl.rows; r++) {
    if (r >= splitRowMin && r <= splitRowMax) {
      tbl.cells[r].splice(insertAt, 0, createTableCellData());
    } else {
      // insertAt-1 位置のマスターセルを探してcolSpanを増やす
      let mc = insertAt - 1;
      while (mc >= 0 && tbl.cells[r][mc]?.merged) mc--;
      if (mc >= 0 && tbl.cells[r][mc] && !tbl.cells[r][mc].merged) {
        tbl.cells[r][mc].colSpan = (tbl.cells[r][mc].colSpan || 1) + 1;
      }
      tbl.cells[r].splice(insertAt, 0, { ...createTableCellData(), merged: true });
    }
  }
}

// 表の指定行に行を挿入（splitColMin〜splitColMax の列は新規セル、他はrowSpan拡張）
function _insertTableRow(tbl, insertAt, splitColMin, splitColMax) {
  tbl.rowHeights[insertAt - 1] = (tbl.rowHeights[insertAt - 1] || 30) / 2;
  tbl.rowHeights.splice(insertAt, 0, tbl.rowHeights[insertAt - 1]);
  tbl.rows++;
  const newRow = [];
  for (let c = 0; c < tbl.cols; c++) {
    if (c >= splitColMin && c <= splitColMax) {
      newRow.push(createTableCellData());
    } else {
      let mr = insertAt - 1;
      while (mr >= 0 && tbl.cells[mr][c]?.merged) mr--;
      if (mr >= 0 && tbl.cells[mr][c] && !tbl.cells[mr][c].merged) {
        tbl.cells[mr][c].rowSpan = (tbl.cells[mr][c].rowSpan || 1) + 1;
      }
      newRow.push({ ...createTableCellData(), merged: true });
    }
  }
  tbl.cells.splice(insertAt, 0, newRow);
}

function _tblSplitCellInto(splitC, splitR) {
  const tbl = getSelectedTableData();
  if (!tbl || !state.selectedTableCell) return;
  const { row: r0, col: c0 } = state.selectedTableCell;
  const cell = tbl.cells[r0]?.[c0];
  if (!cell || cell.merged) return;

  const spanR = cell.rowSpan || 1;
  const spanC = cell.colSpan || 1;
  splitR = Math.max(1, Math.round(splitR));
  splitC = Math.max(1, Math.round(splitC));
  if (splitR === spanR && splitC === spanC) return;

  pushHistory();

  // 既存の結合を全て解除
  for (let r = r0; r < r0 + spanR; r++)
    for (let c = c0; c < c0 + spanC; c++) {
      tbl.cells[r][c].merged = false;
      tbl.cells[r][c].colSpan = 1;
      tbl.cells[r][c].rowSpan = 1;
    }

  // 列を追加（splitC > spanC の場合）
  for (let i = spanC; i < splitC; i++) {
    _insertTableColumn(tbl, c0 + i, r0, r0 + spanR - 1);
  }

  // 行を追加（splitR > spanR の場合）
  for (let i = spanR; i < splitR; i++) {
    _insertTableRow(tbl, r0 + i, c0, c0 + splitC - 1);
  }

  // 幅を均等化
  let totalW = 0;
  for (let c = c0; c < c0 + splitC; c++) totalW += tbl.colWidths[c] || 0;
  const eachW = totalW / splitC;
  for (let c = c0; c < c0 + splitC; c++) tbl.colWidths[c] = eachW;

  // 高さを均等化
  let totalH = 0;
  for (let r = r0; r < r0 + splitR; r++) totalH += tbl.rowHeights[r] || 0;
  const eachH = totalH / splitR;
  for (let r = r0; r < r0 + splitR; r++) tbl.rowHeights[r] = eachH;

  state.selectedTableCell = { row: r0, col: c0 };
  state.selectedTableCells = [{ row: r0, col: c0 }];
  renderAll();
  updateTableFormatRibbon();
}

// ダイアログ初期化（DOMContentLoaded後に呼ばれる）
(function initSplitDialog() {
  const dialog = document.getElementById('tbl-split-dialog');
  if (!dialog) return;
  const closeDialog = () => { dialog.style.display = 'none'; };
  document.getElementById('tbl-split-cancel')?.addEventListener('click', closeDialog);
  dialog.addEventListener('mousedown', e => { if (e.target === dialog) closeDialog(); });
  document.getElementById('tbl-split-ok')?.addEventListener('click', () => {
    const c = parseInt(document.getElementById('tbl-split-cols').value) || 1;
    const r = parseInt(document.getElementById('tbl-split-rows').value) || 1;
    closeDialog();
    _tblSplitCellInto(c, r);
  });
  // Enterキーで確定
  dialog.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('tbl-split-ok')?.click(); }
    if (e.key === 'Escape') closeDialog();
  });
})();

// ----- 表サイズピッカー -----
function showTableSizePicker(btn) {
  const picker = document.getElementById('table-size-picker');
  if (!picker) return;
  if (picker.classList.contains('visible')) { picker.classList.remove('visible'); return; }
  document.getElementById('table-size-label').textContent = '行 × 列を選択';
  picker.querySelectorAll('.tbl-pick-cell').forEach(c => c.classList.remove('hover'));
  picker.style.top = '-9999px'; picker.style.left = '-9999px';
  picker.classList.add('visible');
  requestAnimationFrame(() => {
    const rect = btn.getBoundingClientRect();
    const pr = picker.getBoundingClientRect();
    let top = rect.bottom + 4, left = rect.left;
    if (left + pr.width > window.innerWidth - 4) left = window.innerWidth - pr.width - 4;
    if (top + pr.height > window.innerHeight - 4) top = rect.top - pr.height - 4;
    picker.style.top = top + 'px'; picker.style.left = left + 'px';
  });
}

// ----- 初期化：表サイズピッカー -----
(function initTableSizePicker() {
  const picker = document.getElementById('table-size-picker');
  const grid   = document.getElementById('table-grid-picker');
  const label  = document.getElementById('table-size-label');
  if (!picker || !grid || !label) return;

  for (let r = 1; r <= 8; r++)
    for (let c = 1; c <= 10; c++) {
      const cell = document.createElement('div');
      cell.className = 'tbl-pick-cell';
      cell.dataset.row = r; cell.dataset.col = c;
      grid.appendChild(cell);
    }

  grid.addEventListener('mouseover', e => {
    const cell = e.target.closest('.tbl-pick-cell');
    if (!cell) return;
    const maxR = +cell.dataset.row, maxC = +cell.dataset.col;
    label.textContent = `${maxR}行 × ${maxC}列`;
    grid.querySelectorAll('.tbl-pick-cell').forEach(c =>
      c.classList.toggle('hover', +c.dataset.row <= maxR && +c.dataset.col <= maxC));
  });
  grid.addEventListener('mouseleave', () => {
    grid.querySelectorAll('.tbl-pick-cell').forEach(c => c.classList.remove('hover'));
    label.textContent = '行 × 列を選択';
  });
  grid.addEventListener('click', e => {
    const cell = e.target.closest('.tbl-pick-cell');
    if (!cell) return;
    picker.classList.remove('visible');
    insertTable(+cell.dataset.row, +cell.dataset.col);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#table-size-picker') && !e.target.closest('#btn-insert-table'))
      picker.classList.remove('visible');
  });
}());

// ----- 初期化：表の書式リボンのイベント -----
(function initTableFormatRibbon() {
  // 塗りつぶし色
  const fillBtn = document.getElementById('tbl-fill-btn');
  if (fillBtn) fillBtn.addEventListener('click', e => {
    e.stopPropagation();
    showPptColorPicker(fillBtn, c => {
      if (c === null) return;
      pushHistory();
      _applyCellProp('fill', c);
      _applyCellProp('fillNone', false);
      const fp = document.getElementById('tbl-fill-preview');
      if (fp) fp.style.background = c;
      const fnc = document.getElementById('tbl-fill-none');
      if (fnc) fnc.checked = false;
      renderAll();
    }, { showNone: true, noneLabel: '塗りなし' });
  });

  const fillNone = document.getElementById('tbl-fill-none');
  if (fillNone) fillNone.addEventListener('change', () => {
    pushHistory();
    _applyCellProp('fillNone', fillNone.checked);
    const fp = document.getElementById('tbl-fill-preview');
    if (fp) fp.style.background = fillNone.checked ? 'transparent' : (getSelectedCellData()?.fill || '#ffffff');
    renderAll();
  });

  // 罫線色
  const borderColorBtn = document.getElementById('tbl-border-color-btn');
  if (borderColorBtn) borderColorBtn.addEventListener('click', e => {
    e.stopPropagation();
    showPptColorPicker(borderColorBtn, c => {
      if (c === null) return;
      pushHistory();
      _applyCellProp('stroke', c);
      const bp = document.getElementById('tbl-border-color-preview');
      if (bp) bp.style.background = c;
      renderAll();
    });
  });

  // 罫線幅
  const borderWidth = document.getElementById('tbl-border-width');
  if (borderWidth) borderWidth.addEventListener('change', () => {
    pushHistory(); _applyCellProp('strokeWidth', parseFloat(borderWidth.value)); renderAll();
  });

  // 罫線スタイル
  const borderStyle = document.getElementById('tbl-border-style');
  if (borderStyle) borderStyle.addEventListener('change', () => {
    pushHistory(); _applyCellProp('strokeStyle', borderStyle.value); renderAll();
  });

  // 罫線プリセット
  ['all','outer','inner','none'].forEach(preset => {
    const btn = document.getElementById(`tbl-border-${preset}`);
    if (btn) btn.addEventListener('click', () => { pushHistory(); _applyBorderPreset(preset); renderAll(); });
  });

  // 斜め線（右下がり）
  const diagDown = document.getElementById('tbl-diag-down');
  if (diagDown) diagDown.addEventListener('click', () => {
    const cell = getSelectedCellData(); if (!cell) return;
    pushHistory();
    const v = !cell.diagDown;
    _applyCellProp('diagDown', v);
    diagDown.classList.toggle('active', v);
    renderAll();
  });

  // 斜め線（右上がり）
  const diagUp = document.getElementById('tbl-diag-up');
  if (diagUp) diagUp.addEventListener('click', () => {
    const cell = getSelectedCellData(); if (!cell) return;
    pushHistory();
    const v = !cell.diagUp;
    _applyCellProp('diagUp', v);
    diagUp.classList.toggle('active', v);
    renderAll();
  });

  // 斜め線色
  const diagColorBtn = document.getElementById('tbl-diag-color-btn');
  if (diagColorBtn) diagColorBtn.addEventListener('click', e => {
    e.stopPropagation();
    showPptColorPicker(diagColorBtn, c => {
      if (c === null) return;
      pushHistory();
      _applyCellProp('diagDownColor', c); _applyCellProp('diagUpColor', c);
      const dp = document.getElementById('tbl-diag-color-preview');
      if (dp) dp.style.background = c;
      renderAll();
    });
  });

  // 斜め線幅
  const diagWidth = document.getElementById('tbl-diag-width');
  if (diagWidth) diagWidth.addEventListener('change', () => {
    pushHistory();
    const v = parseFloat(diagWidth.value);
    _applyCellProp('diagDownWidth', v); _applyCellProp('diagUpWidth', v);
    renderAll();
  });

  // 斜め線種類
  const diagStyle = document.getElementById('tbl-diag-style');
  if (diagStyle) diagStyle.addEventListener('change', () => {
    pushHistory();
    _applyCellProp('diagDownStyle', diagStyle.value); _applyCellProp('diagUpStyle', diagStyle.value);
    renderAll();
  });

  // テキスト水平配置
  document.querySelectorAll('.tbl-halign').forEach(btn => {
    btn.addEventListener('click', () => {
      pushHistory(); _applyCellProp('textAlign', btn.dataset.align);
      document.querySelectorAll('.tbl-halign').forEach(b => b.classList.toggle('active', b === btn));
      renderAll();
    });
  });

  // テキスト垂直配置
  document.querySelectorAll('.tbl-valign').forEach(btn => {
    btn.addEventListener('click', () => {
      pushHistory(); _applyCellProp('vertAlign', btn.dataset.align);
      document.querySelectorAll('.tbl-valign').forEach(b => b.classList.toggle('active', b === btn));
      renderAll();
    });
  });

  // 行・列の操作
  document.getElementById('tbl-add-row-above')?.addEventListener('click', _tblAddRowAbove);
  document.getElementById('tbl-add-row-below')?.addEventListener('click', _tblAddRowBelow);
  document.getElementById('tbl-del-row')?.addEventListener('click', _tblDelRow);
  document.getElementById('tbl-add-col-left')?.addEventListener('click', _tblAddColLeft);
  document.getElementById('tbl-add-col-right')?.addEventListener('click', _tblAddColRight);
  document.getElementById('tbl-del-col')?.addEventListener('click', _tblDelCol);

  // 幅・高さをそろえる
  document.getElementById('tbl-eq-height')?.addEventListener('click', _tblEqHeight);
  document.getElementById('tbl-eq-width')?.addEventListener('click', _tblEqWidth);

  // 結合・分割
  document.getElementById('tbl-merge-cells')?.addEventListener('click', _tblMergeCells);
  document.getElementById('tbl-split-cell')?.addEventListener('click', _tblShowSplitDialog);

  // Webビューア エクスポート
  document.getElementById('exp-web-viewer')?.addEventListener('click', exportToWebViewer);
}());

// ===== Web ビューア エクスポート =====
// app.js への変更はこのブロックのみ。元に戻すには git checkout app.js を実行。
//
// アニメーションエンジンの実装は _buildViewerHtml 内の埋め込みスクリプトに含まれています。
// 新しいエフェクトを追加したときは buildAnimKeyframes / playAnimEffect /
// playTableAnimation と合わせて下記の埋め込みコード（buildKf / playEff / playTbl）も更新してください。

function exportToWebViewer() {
  const slidesData = state.slides
    .filter(s => !s.hidden)
    .map(slide => {
      const frame = document.createElement('div');
      slide.elements.forEach(d => frame.appendChild(buildElement(d, { asGroupChild: true })));
      return {
        html: frame.innerHTML,
        bgColor: slide.bgColor || '#ffffff',
        animations: slide.animations || [],
        w: state.slideWidth,
        h: computeSlideHeight(slide),
      };
    });

  if (!slidesData.length) { alert('エクスポートするスライドがありません。'); return; }

  const html = _buildViewerHtml(slidesData);
  const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'web-presentation.html';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
}

function _buildViewerHtml(slidesData) {
  const dataJson = JSON.stringify(slidesData);
  const sectionsHtml = slidesData.map((s, i) =>
    `<section class="sv-section" data-slide="${i}" style="background:${s.bgColor}">` +
    `<div class="sv-wrapper"><div class="sv-frame" data-frame="${i}" ` +
    `style="width:${s.w}px;height:${s.h}px;background:${s.bgColor}">${s.html}</div></div></section>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>プレゼンテーション</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=BIZ+UDPGothic:wght@400;700&family=BIZ+UDPMincho&family=Dancing+Script:wght@400;700&family=Dela+Gothic+One&family=DotGothic16&family=Hina+Mincho&family=Inter:wght@400;700&family=Kaisei+Decol&family=Kosugi&family=Kosugi+Maru&family=Lato:wght@400;700&family=Lobster&family=M+PLUS+1p:wght@400;700&family=M+PLUS+Rounded+1c:wght@400;700&family=Merriweather:wght@400;700&family=Montserrat:wght@400;700&family=Noto+Sans+JP:wght@400;700&family=Noto+Serif+JP:wght@400;700&family=Open+Sans:wght@400;700&family=Oswald:wght@400;700&family=Pacifico&family=Playfair+Display:wght@400;700&family=Poppins:wght@400;700&family=Raleway:wght@400;700&family=Rampart+One&family=Reggae+One&family=Roboto:wght@400;700&family=Sawarabi+Gothic&family=Sawarabi+Mincho&family=Shippori+Mincho:wght@400;700&family=Source+Code+Pro:wght@400;700&family=Stick&family=Yomogi&family=Yusei+Magic&family=Zen+Kaku+Gothic+New:wght@400;700&family=Zen+Maru+Gothic:wght@400;700&display=swap">
<style>
/* ビューア レイアウト */
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{background:#0a0a0a;overflow-x:hidden}
.sv-section{width:100%;min-height:100vh;display:flex;align-items:center;justify-content:center}
.sv-wrapper{position:relative;overflow:hidden}
.sv-frame{position:relative;transform-origin:top left;overflow:hidden}

/* スライドメイト要素レンダリング（style.css から必要部分を抜粋） */
.slide-element{position:absolute;box-sizing:border-box}
.slide-element.type-group{background:transparent!important;border:none!important}
.slide-element.type-line{overflow:visible}
.slide-element.type-line svg{position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible}
.slide-element>svg polygon,.slide-element>svg rect,.slide-element>svg ellipse,
.slide-element>svg path,.slide-element>svg line,.slide-element>svg circle{vector-effect:non-scaling-stroke}
.type-table{background:transparent!important;border:none!important;overflow:hidden}
.tbl-inner{width:100%;height:100%;table-layout:fixed;border-collapse:collapse}
.tbl-inner td{word-break:break-word;overflow:hidden;position:relative;box-sizing:border-box}
.tbl-cell-text{white-space:pre-wrap;word-break:break-word;min-height:1em;pointer-events:none}
</style>
</head>
<body>
${sectionsHtml}
<script>
window.__SD__=${dataJson};
(function(){
'use strict';
var SD=window.__SD__;

// ---- アニメーションエンジン（app.js の buildAnimKeyframes / playAnimEffect / playTableAnimation と同期） ----
var ENTRANCE=new Set(['appear','fade-in','fly-in','zoom-in','wipe-in','bounce-in','split-in','float-in','wheel-in','random-bars-in','stretch-in']);
var EXIT=new Set(['disappear','fade-out','fly-out','zoom-out','float-out','wipe-out','split-out','bounce-out']);
var TBL=[
  {id:'tbl-row-fade',unit:'rows',kf:'fade',cat:'tbl-in'},{id:'tbl-col-fade',unit:'cols',kf:'fade',cat:'tbl-in'},
  {id:'tbl-row-fly',unit:'rows',kf:'fly',cat:'tbl-in'},{id:'tbl-col-fly',unit:'cols',kf:'fly',cat:'tbl-in'},
  {id:'tbl-cell-fly',unit:'cells',kf:'fly',cat:'tbl-in'},
  {id:'tbl-row-wipe',unit:'rows',kf:'wipe',cat:'tbl-in'},{id:'tbl-col-wipe',unit:'cols',kf:'wipe',cat:'tbl-in'},
  {id:'tbl-row-hl',unit:'rows',kf:'hl',cat:'tbl-em',defaultHl:'#f9e2af'},{id:'tbl-col-hl',unit:'cols',kf:'hl',cat:'tbl-em',defaultHl:'#f9e2af'},
  {id:'tbl-row-flash',unit:'rows',kf:'flash',cat:'tbl-em'},{id:'tbl-col-flash',unit:'cols',kf:'flash',cat:'tbl-em'},
  {id:'tbl-row-pop',unit:'rows',kf:'pop',cat:'tbl-em',defaultHl:'#cba6f7'},{id:'tbl-col-pop',unit:'cols',kf:'pop',cat:'tbl-em',defaultHl:'#cba6f7'},
  {id:'tbl-cell-pop',unit:'cells',kf:'pop',cat:'tbl-em',defaultHl:'#cba6f7'}
];
var TBL_IDS=new Set(TBL.map(function(e){return e.id;}));
function tblDef(id){return TBL.find(function(e){return e.id===id;});}
function rgba(hex,a){var v=hex.replace('#','');return 'rgba('+parseInt(v.slice(0,2),16)+','+parseInt(v.slice(2,4),16)+','+parseInt(v.slice(4,6),16)+','+a+')';}

function buildKf(anim){
  var d=anim.direction||'';
  switch(anim.effect){
    case 'appear':return{kf:[{opacity:0},{opacity:1}],dur:0};
    case 'fade-in':return{kf:[{opacity:0},{opacity:1}],easing:'ease-out'};
    case 'fade-out':return{kf:[{opacity:1},{opacity:0}],easing:'ease-in'};
    case 'fly-in':{var t={'from-bottom':'translateY(80px)','from-top':'translateY(-80px)','from-left':'translateX(-80px)','from-right':'translateX(80px)'}[d]||'translateY(80px)';return{kf:[{opacity:0,transform:t},{opacity:1,transform:'translate(0,0)'}],easing:'ease-out'};}
    case 'fly-out':{var t={'to-bottom':'translateY(80px)','to-top':'translateY(-80px)','to-left':'translateX(-80px)','to-right':'translateX(80px)'}[d]||'translateY(80px)';return{kf:[{opacity:1,transform:'translate(0,0)'},{opacity:0,transform:t}],easing:'ease-in'};}
    case 'zoom-in':return{kf:[{opacity:0,transform:'scale(0.1)'},{opacity:1,transform:'scale(1)'}],easing:'cubic-bezier(0.175,0.885,0.32,1.275)'};
    case 'zoom-out':return{kf:[{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(0.1)'}],easing:'ease-in'};
    case 'wipe-in':{var c={'from-left':['inset(0 100% 0 0)','inset(0 0% 0 0)'],'from-right':['inset(0 0 0 100%)','inset(0 0 0 0%)'],'from-top':['inset(100% 0 0 0)','inset(0% 0 0 0)'],'from-bottom':['inset(0 0 100% 0)','inset(0 0 0% 0)']}[d]||['inset(0 100% 0 0)','inset(0 0% 0 0)'];return{kf:[{clipPath:c[0]},{clipPath:c[1]}],easing:'ease-out'};}
    case 'bounce-in':return{kf:[{opacity:0,transform:'scale(0.3)'},{opacity:1,transform:'scale(1.15)',offset:0.6},{transform:'scale(0.92)',offset:0.8},{transform:'scale(1)'}],easing:'ease-out'};
    case 'split-in':return{kf:[{clipPath:'inset(50% 0 50% 0)'},{clipPath:'inset(0% 0 0% 0)'}],easing:'ease-out'};
    case 'pulse':return{kf:[{transform:'scale(1)'},{transform:'scale(1.3)',offset:0.5},{transform:'scale(1)'}],easing:'ease-in-out'};
    case 'spin':return{kf:[{transform:'rotate(0deg)'},{transform:'rotate(360deg)'}],easing:'linear'};
    case 'shake':return{kf:[{transform:'translateX(0)'},{transform:'translateX(-8px)',offset:0.15},{transform:'translateX(8px)',offset:0.35},{transform:'translateX(-8px)',offset:0.55},{transform:'translateX(8px)',offset:0.75},{transform:'translateX(-5px)',offset:0.9},{transform:'translateX(0)'}],easing:'linear'};
    case 'flash':return{kf:[{opacity:1},{opacity:0,offset:0.25},{opacity:1,offset:0.5},{opacity:0,offset:0.75},{opacity:1}],easing:'linear'};
    case 'color-pulse':return{kf:[{filter:'brightness(1)'},{filter:'brightness(2)',offset:0.5},{filter:'brightness(1)'}],easing:'ease-in-out'};
    case 'float-in':{var ft=d==='from-top'?'translateY(-30px)':'translateY(30px)';return{kf:[{opacity:0,transform:ft},{opacity:1,transform:'translateY(0)'}],easing:'ease-out'};}
    case 'float-out':{var ft=d==='to-top'?'translateY(-30px)':'translateY(30px)';return{kf:[{opacity:1,transform:'translateY(0)'},{opacity:0,transform:ft}],easing:'ease-in'};}
    case 'wheel-in':return{kf:[{opacity:0,transform:'rotate(-90deg) scale(0.5)'},{opacity:1,transform:'rotate(0deg) scale(1)'}],easing:'ease-out'};
    case 'random-bars-in':return{kf:[{transform:'scaleY(0.04)',opacity:0},{transform:'scaleY(1)',opacity:1}],easing:'ease-out'};
    case 'stretch-in':return{kf:[{transform:'scaleX(0)'},{transform:'scaleX(1)'}],easing:'cubic-bezier(0.175,0.885,0.32,1.275)'};
    case 'teeter':return{kf:[{transform:'rotate(0deg)'},{transform:'rotate(-8deg)',offset:0.2},{transform:'rotate(8deg)',offset:0.5},{transform:'rotate(-4deg)',offset:0.8},{transform:'rotate(0deg)'}],easing:'ease-in-out'};
    case 'grow-shrink':return{kf:[{transform:'scale(1)'},{transform:'scale(1.5)',offset:0.5},{transform:'scale(1)'}],easing:'ease-in-out'};
    case 'bold-flash':return{kf:[{filter:'brightness(1)'},{filter:'brightness(3.5)',offset:0.25},{filter:'brightness(1)',offset:0.5},{filter:'brightness(3.5)',offset:0.75},{filter:'brightness(1)'}],easing:'linear'};
    case 'wipe-out':{var wc={'to-right':['inset(0 0% 0 0)','inset(0 100% 0 0)'],'to-left':['inset(0 0 0 0%)','inset(0 0 0 100%)'],'to-top':['inset(0% 0 0 0)','inset(100% 0 0 0)'],'to-bottom':['inset(0 0 0% 0)','inset(0 0 100% 0)']}[d]||['inset(0 0% 0 0)','inset(0 100% 0 0)'];return{kf:[{clipPath:wc[0]},{clipPath:wc[1]}],easing:'ease-in'};}
    case 'split-out':return{kf:[{clipPath:'inset(0% 0 0% 0)'},{clipPath:'inset(50% 0 50% 0)'}],easing:'ease-in'};
    case 'bounce-out':return{kf:[{opacity:1,transform:'scale(1)'},{transform:'scale(1.1)',offset:0.2},{transform:'scale(0.95)',offset:0.4},{opacity:1,transform:'scale(1.05)',offset:0.6},{opacity:0,transform:'scale(0)'}],easing:'ease-in'};
    case 'disappear':return{kf:[{opacity:1},{opacity:0}],dur:0};
    default:return null;
  }
}

function playEff(el,anim,cb){
  var def=buildKf(anim);
  if(!def){cb&&cb();return;}
  var isIn=ENTRANCE.has(anim.effect),isOut=EXIT.has(anim.effect);
  if(isIn)el.style.visibility='visible';
  var ms=def.dur!==undefined?def.dur:(anim.duration||0.5)*1000;
  if(ms===0){el.style.visibility=isOut?'hidden':'visible';cb&&cb();return;}
  var wa=el.animate(def.kf,{duration:ms,easing:def.easing||'ease-out',fill:'forwards'});
  wa.onfinish=function(){if(isOut)el.style.visibility='hidden';cb&&cb();};
}

function tblUnits(el,def,tgt){
  if(!def)return[];
  var t=tgt&&tgt.length?tgt:null;
  if(def.unit==='rows'){var rows=[].slice.call(el.querySelectorAll('tbody tr'));var idx=t||rows.map(function(_,i){return i;});return idx.filter(function(i){return i<rows.length;}).sort(function(a,b){return a-b;}).map(function(i){return[].slice.call(rows[i].querySelectorAll('td'));}).filter(function(x){return x.length;});}
  if(def.unit==='cols'){var cc=el.querySelector('colgroup')?el.querySelector('colgroup').children.length:0;var idx=t||Array.from({length:cc},function(_,i){return i;});return idx.filter(function(i){return i<cc;}).sort(function(a,b){return a-b;}).map(function(c){return[].slice.call(el.querySelectorAll('td[data-col="'+c+'"]'));}).filter(function(x){return x.length;});}
  if(def.unit==='cells'){if(t)return t.map(function(rc){var td=el.querySelector('td[data-row="'+rc.row+'"][data-col="'+rc.col+'"]');return td?[td]:[];}).filter(function(x){return x.length;});return[].slice.call(el.querySelectorAll('td')).map(function(td){return[td];});}
  return[];
}

function tblKf(kf,hlColor){
  if(kf==='fade')return{mode:'in',start:[{opacity:0}],end:[{opacity:1}]};
  if(kf==='fly')return{mode:'in',start:[{opacity:0,transform:'translateY(16px)'}],end:[{opacity:1,transform:'none'}]};
  if(kf==='wipe')return{mode:'in',start:[{clipPath:'inset(0 100% 0 0)'}],end:[{clipPath:'inset(0 0% 0 0)'}]};
  if(kf==='hl'){var c0=rgba(hlColor||'#f9e2af',0),c1=rgba(hlColor||'#f9e2af',0.55);return{mode:'em',frames:[{boxShadow:'inset 0 0 0 9999px '+c0},{boxShadow:'inset 0 0 0 9999px '+c1,offset:0.4},{boxShadow:'inset 0 0 0 9999px '+c1,offset:0.6},{boxShadow:'inset 0 0 0 9999px '+c0}]};}
  if(kf==='flash')return{mode:'em',frames:[{opacity:1},{opacity:0.08,offset:0.2},{opacity:1,offset:0.4},{opacity:0.08,offset:0.7},{opacity:1}]};
  if(kf==='pop'){var c0=rgba(hlColor||'#cba6f7',0),c1=rgba(hlColor||'#cba6f7',0.35);return{mode:'em',frames:[{boxShadow:'inset 0 0 0 9999px '+c0,transform:'scale(1)'},{boxShadow:'inset 0 0 0 9999px '+c1,transform:'scale(1.04)',offset:0.35},{boxShadow:'inset 0 0 0 9999px '+c0,transform:'scale(1)'}]};}
  return{mode:'in',start:[{opacity:0}],end:[{opacity:1}]};
}

function playTbl(el,anim,cb){
  var def=tblDef(anim.effect);
  if(!def){cb&&cb();return;}
  var units=tblUnits(el,def,anim.tableTarget);
  if(!units.length){cb&&cb();return;}
  var isEm=def.cat==='tbl-em';
  var dur=Math.max(100,(anim.duration||(isEm?0.65:0.4))*1000);
  var stagger=Math.max(20,(anim.tableStagger!=null?anim.tableStagger:(isEm?dur/1000:0.12))*1000);
  var kfd=tblKf(def.kf,anim.tableHlColor);
  if(def.kf==='hl'){
    var hlC=anim.tableHlColor||'#f9e2af',c0=rgba(hlC,0),c1=rgba(hlC,0.55),cP=rgba(hlC,0.85);
    var allTds=units.reduce(function(a,b){return a.concat(b);},[]);
    var isOn=allTds[0]&&allTds[0].dataset.tblHlActive==='1';
    setTimeout(function(){
      var rem=allTds.length,done=function(){if(--rem===0)cb&&cb(!isOn);};
      allTds.forEach(function(td){
        var frames=isOn?[{boxShadow:'inset 0 0 0 9999px '+c1},{boxShadow:'inset 0 0 0 9999px '+c0}]:[{boxShadow:'inset 0 0 0 9999px '+c0},{boxShadow:'inset 0 0 0 9999px '+cP,offset:0.35},{boxShadow:'inset 0 0 0 9999px '+c1}];
        var a=td.animate(frames,{duration:dur,easing:isOn?'ease-in':'ease-out',fill:'forwards'});
        a.onfinish=function(){if(isOn){td.style.removeProperty('box-shadow');delete td.dataset.tblHlActive;}else{td.style.boxShadow='inset 0 0 0 9999px '+c1;td.dataset.tblHlActive='1';}try{a.cancel();}catch(e){}done();};
      });
    },(anim.delay||0)*1000);
    return;
  }
  if(isEm){
    var i=0,pn=function(){if(i>=units.length){cb&&cb();return;}var tds=units[i++],rem=tds.length;tds.forEach(function(td){var a=td.animate(kfd.frames,{duration:dur,easing:'ease-in-out',fill:'none'});a.onfinish=function(){if(--rem===0)setTimeout(pn,0);};});};
    setTimeout(pn,(anim.delay||0)*1000);
  }else{
    var st=kfd.start,en=kfd.end,sp=Object.keys(st[0]).map(function(p){return p.replace(/([A-Z])/g,function(c){return'-'+c.toLowerCase();});});
    units.forEach(function(tds){tds.forEach(function(td){Object.assign(td.style,st[0]);});});
    units.forEach(function(tds,i){
      var last=i===units.length-1;
      setTimeout(function(){
        tds.forEach(function(td,j){
          var a=td.animate([].concat(st,en),{duration:dur,easing:'ease-out',fill:'forwards'});
          a.onfinish=function(){sp.forEach(function(p){td.style.removeProperty(p);});try{a.cancel();}catch(ex){}if(last&&j===tds.length-1)cb&&cb();};
        });
      },i*stagger);
    });
  }
}

// ---- アニメーション再生・リセット（スクロールビューア用） ----

var slideTimers={};
var slideSeq={};    // シーケンスカウンタ：リセット時にインクリメントして古いコールバックを無効化
var pendingStart={}; // enterObs のデバウンスタイマー

function _timers(idx){if(!slideTimers[idx])slideTimers[idx]=[];return slideTimers[idx];}
function _clearTimers(idx){_timers(idx).forEach(function(t){clearTimeout(t);});slideTimers[idx]=[];}
function _seq(idx){return slideSeq[idx]||0;}
function _live(idx,seq){return _seq(idx)===seq;}

function preHide(frame,anims){
  anims.forEach(function(anim){
    if(!ENTRANCE.has(anim.effect))return;
    var el=frame.querySelector('[data-id="'+anim.elementId+'"]');
    if(el)el.style.visibility='hidden';
  });
  anims.forEach(function(anim){
    if(!TBL_IDS.has(anim.effect))return;
    var el=frame.querySelector('[data-id="'+anim.elementId+'"]');
    var def=tblDef(anim.effect);
    if(el&&def&&def.cat==='tbl-in'){
      var kfd=tblKf(def.kf);
      tblUnits(el,def,anim.tableTarget).forEach(function(tds){tds.forEach(function(td){Object.assign(td.style,kfd.start[0]);});});
    }
  });
}

function resetSlide(slideData,frame,idx){
  // シーケンスをインクリメント → 実行中の全コールバックが _live チェックで早期リターン
  slideSeq[idx]=(_seq(idx)+1);
  // デバウンスタイマーをキャンセル
  if(pendingStart[idx]){clearTimeout(pendingStart[idx]);delete pendingStart[idx];}
  // タイマーと Web Animation をすべてキャンセル
  _clearTimers(idx);
  frame.querySelectorAll('*').forEach(function(el){
    el.getAnimations().forEach(function(a){try{a.cancel();}catch(e){}});
  });
  // 初期表示状態に戻す
  var anims=slideData.animations||[];
  anims.forEach(function(anim){
    if(ENTRANCE.has(anim.effect)){
      var el=frame.querySelector('[data-id="'+anim.elementId+'"]');
      if(el)el.style.visibility='hidden';
    }else if(EXIT.has(anim.effect)){
      var el=frame.querySelector('[data-id="'+anim.elementId+'"]');
      if(el)el.style.visibility='visible';
    }
  });
  anims.forEach(function(anim){
    if(!TBL_IDS.has(anim.effect))return;
    var el=frame.querySelector('[data-id="'+anim.elementId+'"]');
    var def=tblDef(anim.effect);
    if(!el||!def)return;
    if(def.cat==='tbl-in'){
      var kfd=tblKf(def.kf);
      tblUnits(el,def,anim.tableTarget).forEach(function(tds){tds.forEach(function(td){Object.assign(td.style,kfd.start[0]);});});
    }else if(def.kf==='hl'){
      tblUnits(el,def,anim.tableTarget).reduce(function(a,b){return a.concat(b);},[]).forEach(function(td){
        td.style.removeProperty('box-shadow');delete td.dataset.tblHlActive;
      });
    }
  });
  frame.classList.remove('sv-played');
}

function playGroup(frame,group,done,idx,seq){
  if(!_live(idx,seq)){done&&done();return;}
  var pending=0,prev=0,fin=function(){if(--pending<=0)done&&done();};
  group.forEach(function(anim,i){
    if(anim.effect==='__chart__')return;
    var el=frame.querySelector('[data-id="'+anim.elementId+'"]');
    if(!el)return;
    var dMs=(anim.delay||0)*1000;
    var durMs=TBL_IDS.has(anim.effect)?(anim.duration||0.4)*1000:(anim.duration||0.5)*1000;
    var start=(i===0||anim.trigger==='with-prev')?dMs:prev+dMs;
    prev=start+durMs;
    pending++;
    var t;
    if(TBL_IDS.has(anim.effect)){
      t=setTimeout(function(){if(!_live(idx,seq)){fin();return;}playTbl(el,anim,fin);},start);
    }else{
      t=setTimeout(function(){if(!_live(idx,seq)){fin();return;}playEff(el,anim,fin);},start);
    }
    _timers(idx).push(t);
  });
  if(pending===0)done&&done();
}

function playSlide(slideData,frame,idx){
  // 新しいシーケンスを発行 → 前回の再生コールバックはすべて無効になる
  var seq=slideSeq[idx]=(_seq(idx)+1);
  var anims=slideData.animations||[];
  preHide(frame,anims);
  var queue=[],g=null;
  anims.forEach(function(a){if(a.trigger==='on-click'||!g){g=[];queue.push(g);}g.push(a);});
  var p=0;
  function next(){
    if(!_live(idx,seq))return;
    if(p>=queue.length){frame.classList.add('sv-played');return;}
    playGroup(frame,queue[p++],function(){
      if(!_live(idx,seq))return;
      var t=setTimeout(next,150);
      _timers(idx).push(t);
    },idx,seq);
  }
  next();
}

// ---- スケール & スクロール監視 ----
function scaleFrames(){
  document.querySelectorAll('.sv-frame').forEach(function(frame,i){
    var s=SD[i];if(!s)return;
    var sc=window.innerWidth/s.w;
    frame.style.transform='scale('+sc+')';
    var w=frame.parentElement;
    if(w){w.style.width=Math.round(s.w*sc)+'px';w.style.height=Math.round(s.h*sc)+'px';}
  });
}

window.addEventListener('load',function(){
  scaleFrames();
  window.addEventListener('resize',scaleFrames);

  // exitObs: セクションが完全に画面外に出たらリセット
  var exitObs=new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      if(entry.isIntersecting)return;
      var sec=entry.target,idx=parseInt(sec.dataset.slide,10);
      var frame=sec.querySelector('.sv-frame');
      if(!frame)return;
      if(frame.classList.contains('sv-played')||_seq(idx)>0){
        resetSlide(SD[idx],frame,idx);
      }
    });
  },{threshold:0});

  // enterObs: セクションが20%以上見えたら100msデバウンス後に再生
  var enterObs=new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      if(!entry.isIntersecting||entry.intersectionRatio<0.2)return;
      var sec=entry.target,idx=parseInt(sec.dataset.slide,10);
      var frame=sec.querySelector('.sv-frame');
      if(!frame||frame.classList.contains('sv-played'))return;
      if(pendingStart[idx])clearTimeout(pendingStart[idx]);
      pendingStart[idx]=setTimeout(function(){
        delete pendingStart[idx];
        if(frame.classList.contains('sv-played'))return;
        playSlide(SD[idx],frame,idx);
      },100);
    });
  },{threshold:0.2});

  document.querySelectorAll('.sv-section').forEach(function(s){
    exitObs.observe(s);
    enterObs.observe(s);
  });
});

})();
<\/script>
</body>
</html>`;
}
