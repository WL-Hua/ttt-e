'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
const STORAGE_KEY = 'zhitu-exam-v1';
const app = document.querySelector('#app');
const input = document.querySelector('#pdf-input');
const wrongInput = document.querySelector('#wrong-import');
const progressInput = document.querySelector('#progress-import');
const toast = document.querySelector('#toast');
const sharedMode = location.protocol === 'http:' && location.hostname === '127.0.0.1' && location.port === '8765';
let state = { papers: [], wrong: [], session: null, progress: [] };
let view = 'home';
let attemptReview = null;
let wrongAnswerMode = false;
let notice = '';
let toastTimer;
let wrongReady = !sharedMode;
let wrongBusy = false;
let wrongRevision = 0;
let progressReady = !sharedMode;
let progressBusy = false;
let progressGeneration = 0;
let syncWarning = sharedMode ? '正在连接本机共享错题本…' : '当前是浏览器本地模式：错题本不会自动跨浏览器共享。请启动本机服务并打开共享地址。';

try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed.papers) || !Array.isArray(parsed.wrong)) throw new Error('存储格式无效');
    state = { papers: parsed.papers, wrong: parsed.wrong, session: parsed.session || null, progress: Array.isArray(parsed.progress) ? parsed.progress : [], pendingLegacy: parsed.pendingLegacy || null, progressMigrationDone: parsed.progressMigrationDone || false, bundledInstalled: parsed.bundledInstalled || false, bundledVersion: parsed.bundledVersion || 0 };
  }
} catch (error) {
  notice = `无法读取浏览器中的学习记录：${error.message}。请检查浏览器存储设置。`;
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    notify(`保存失败：${error.message}。当前进度可能无法保留，请检查浏览器存储空间和权限。`, true);
    return false;
  }
}

function notify(message, persistent = false) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  if (!persistent) toastTimer = setTimeout(() => toast.classList.remove('show'), 4500);
}

function validProgress(item) {
  const session = item && item.session;
  return Boolean(item && typeof item.paperId === 'string' && item.paperId &&
    Number.isSafeInteger(item.revision) && item.revision > 0 &&
    Number.isSafeInteger(item.count) && item.count >= 0 &&
    (item.attempts === undefined || (Array.isArray(item.attempts) && item.attempts.every(validAttempt))) &&
    (session === null || (session && typeof session.id === 'string' && session.id &&
      Number.isSafeInteger(session.index) && session.index >= 0 && session.answers &&
      typeof session.answers === 'object' && !Array.isArray(session.answers) &&
      Object.values(session.answers).every(answer => Array.isArray(answer) && answer.every(letter => typeof letter === 'string')))));
}

function validAttempt(attempt) {
  return Boolean(attempt && typeof attempt.id === 'string' && attempt.id &&
    typeof attempt.submittedAt === 'string' && Number.isFinite(Date.parse(attempt.submittedAt)) &&
    attempt.answers && typeof attempt.answers === 'object' && !Array.isArray(attempt.answers) &&
    Object.values(attempt.answers).every(answer => Array.isArray(answer) && answer.every(letter => typeof letter === 'string')));
}

function sessionSnapshot(session) {
  return { id: session.practiceId, index: session.index, answers: session.answers };
}

function progressFor(paperId) {
  return state.progress.find(item => item.paperId === paperId);
}

function restorePaper(paper, snapshot) {
  return { title: paper.name, questions: paper.questions, sources: Object.fromEntries(paper.questions.map(q => [q.id, paper.name])),
    answers: snapshot.answers, index: Math.min(snapshot.index, paper.questions.length - 1), submitted: false,
    paperId: paper.id, practiceId: snapshot.id };
}

function legacyProgress() {
  const session = state.session;
  if (!session || session.submitted || session.paperId || !Array.isArray(session.questions)) return null;
  const paper = state.papers.find(item => item.name === session.title && item.questions.length === session.questions.length &&
    item.questions.every((question, index) => question.id === session.questions[index].id));
  if (!paper) return null;
  return { paperId: paper.id, revision: 1, count: 0,
    session: { id: crypto.randomUUID(), index: session.index, answers: session.answers } };
}

async function progressRequest(path, body) {
  const response = await fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store'
  } : { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  if (!Array.isArray(data.items) || !data.items.every(validProgress)) throw new Error('共享试卷进度格式无效');
  return data.items;
}

async function refreshProgress() {
  if (!sharedMode || progressBusy) return;
  const generation = progressGeneration;
  try {
    const items = await progressRequest('/api/progress');
    if (generation !== progressGeneration || progressBusy) return;
    const changed = !progressReady || JSON.stringify(items) !== JSON.stringify(state.progress);
    const previousCurrent = state.session && state.session.paperId ? progressFor(state.session.paperId) : null;
    state.progress = items;
    progressReady = true;
    if (!state.progressMigrationDone) {
      const legacy = legacyProgress();
      if (legacy && !progressFor(legacy.paperId)) {
        await updateProgress('/api/progress/import', legacy.paperId, legacy.session, null, legacy.count);
        if (!progressReady) return;
      } else if (legacy) {
        state.pendingLegacy = legacy;
        notify('该试卷已有共享记录，旧进度未覆盖。可在“我的试卷”导出未迁移的旧进度。', true);
      }
      if (legacy) {
        const entry = progressFor(legacy.paperId);
        const paper = state.papers.find(item => item.id === legacy.paperId);
        if (entry && entry.session && paper) state.session = restorePaper(paper, entry.session);
        else state.session = null;
      }
      state.progressMigrationDone = true;
      save();
    }
    if (changed) {
      const current = state.session;
      if (current && current.paperId && !current.submitted) {
        const entry = progressFor(current.paperId);
        const paper = state.papers.find(item => item.id === current.paperId);
        if (JSON.stringify(previousCurrent) !== JSON.stringify(entry)) {
          if (entry && entry.session && paper) state.session = restorePaper(paper, entry.session);
          else { state.session = null; if (view === 'exam') { view = 'papers'; notify('该试卷的进度已在其他浏览器中更改。', true); } }
        }
      }
      save();
      render();
    }
  } catch (error) {
    if (generation !== progressGeneration) return;
    progressReady = false;
    notify(`无法读取本机共享试卷进度：${error.message}。请确认服务窗口运行中。`, true);
    render();
  }
}

async function updateProgress(path, paperId, session, sessionId, importedCount = 0, attempt = null, importedAttempts = []) {
  const existing = progressFor(paperId);
  if (!sharedMode) {
    const previousProgress = state.progress;
    const entry = { paperId, revision: (existing ? existing.revision : 0) + 1,
      count: path.endsWith('/import') ? importedCount : (existing ? existing.count : 0) + (path.endsWith('/submit') ? 1 : 0),
      session: path.endsWith('/submit') ? null : session,
      attempts: path.endsWith('/submit') ? [...(existing && existing.attempts || []), attempt] : (path.endsWith('/import') ? importedAttempts : (existing && existing.attempts || [])) };
    state.progress = state.progress.filter(item => item.paperId !== paperId).concat(entry);
    if (!save()) {
      state.progress = previousProgress;
      return false;
    }
    return true;
  }
  if (!progressReady || progressBusy) {
    notify('共享试卷进度尚未连接或正在保存，请稍后重试。', true);
    return false;
  }
  progressBusy = true;
  progressGeneration++;
  try {
    state.progress = await progressRequest(path, { paperId, revision: existing ? existing.revision : 0, session, sessionId, count: importedCount, attempt, attempts: importedAttempts });
    save();
    return true;
  } catch (error) {
    progressReady = false;
    notify(`试卷进度保存失败：${error.message}。请刷新后确认最新进度，再继续操作。`, true);
    return false;
  } finally {
    progressBusy = false;
  }
}

function downloadProgress(items, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'tour-progress-v1', items }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportProgress() {
  if (sharedMode && !progressReady) { notify('共享试卷进度未连接，无法导出。', true); return; }
  const items = state.progress.slice();
  const legacy = legacyProgress();
  if (legacy && !items.some(item => item.paperId === legacy.paperId)) items.push(legacy);
  downloadProgress(items, '导游试卷进度.json');
}

async function importProgress(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.format !== 'tour-progress-v1' || !Array.isArray(data.items) || !data.items.every(validProgress)) throw new Error('文件不是有效的试卷进度备份');
    let imported = 0;
    let skipped = 0;
    for (const item of data.items) {
      if (progressFor(item.paperId)) { skipped++; continue; }
      if (!await updateProgress('/api/progress/import', item.paperId, item.session, null, item.count, null, item.attempts || [])) return;
      imported++;
    }
    render();
    notify(`已导入 ${imported} 份试卷记录，跳过 ${skipped} 份已有记录。`, true);
  } catch (error) {
    notify(`导入试卷进度失败：${error.message}`, true);
  }
}

function validWrongItem(item) {
  const q = item && item.question;
  return Boolean(q && typeof q.id === 'string' && q.id && typeof q.stem === 'string' &&
    typeof q.type === 'string' && Array.isArray(q.options) && q.options.length >= 2 &&
    q.options.every(option => option && typeof option.letter === 'string' && typeof option.text === 'string') &&
    Array.isArray(q.answer) && q.answer.length && q.answer.every(letter => typeof letter === 'string') &&
    typeof item.paperName === 'string');
}

async function wrongRequest(path, body) {
  const response = await fetch(path, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store'
  } : { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  if (!Array.isArray(data.items) || !data.items.every(validWrongItem)) throw new Error('共享错题本数据格式无效');
  return data.items;
}

async function refreshWrong() {
  if (!sharedMode || wrongBusy) return;
  const revision = wrongRevision;
  try {
    const items = await wrongRequest('/api/wrong');
    if (revision !== wrongRevision || wrongBusy) return;
    const changed = !wrongReady || syncWarning || JSON.stringify(state.wrong) !== JSON.stringify(items);
    state.wrong = items;
    wrongReady = true;
    syncWarning = '';
    if (changed) {
      save();
      render();
    }
  } catch (error) {
    if (revision !== wrongRevision) return;
    const wasReady = wrongReady;
    wrongReady = false;
    syncWarning = `无法读取本机共享错题本：${error.message}。请确认服务窗口仍在运行；连接恢复前不能交卷或修改错题。`;
    if (wasReady || view === 'wrong') render();
  }
}

async function updateWrong(path, payload) {
  if (!sharedMode) return true;
  if (!wrongReady || wrongBusy) {
    notify('共享错题本尚未连接或正在保存，请稍后重试。', true);
    return false;
  }
  wrongBusy = true;
  wrongRevision++;
  try {
    state.wrong = await wrongRequest(path, payload);
    wrongReady = true;
    syncWarning = '';
    return true;
  } catch (error) {
    wrongReady = false;
    syncWarning = `共享错题本保存失败：${error.message}。请检查服务后重试；操作结果可能已保存，请先刷新确认。`;
    notify(syncWarning, true);
    return false;
  } finally {
    wrongBusy = false;
    render();
  }
}

function exportWrong() {
  if (sharedMode && !wrongReady) {
    notify('共享错题本未连接，无法导出。', true);
    return;
  }
  const data = JSON.stringify({ format: 'tour-wrong-v1', items: state.wrong }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = '导游错题本.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importWrong(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.format !== 'tour-wrong-v1' || !Array.isArray(data.items) || !data.items.every(validWrongItem)) {
      throw new Error('文件不是有效的错题本备份');
    }
    if (sharedMode) {
      if (!await updateWrong('/api/wrong/add', { items: data.items })) return;
    } else {
      const ids = new Set(state.wrong.map(item => item.question.id));
      for (const item of data.items) {
        if (!ids.has(item.question.id)) { state.wrong.push(item); ids.add(item.question.id); }
      }
    }
    save();
    render();
    notify(`已合并备份中的 ${data.items.length} 道错题，相同题目不会重复添加。`);
  } catch (error) {
    notify(`导入错题本失败：${error.message}`, true);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function cleanText(text) {
  return text.replace(/\s+/g, ' ').replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1').trim();
}

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function parsePaper(text, filename) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let section = '';
  let current = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex].trim();
    const sectionMatch = line.match(/^[一二三四五六七八九十]+[、.．]\s*(判断题|单(?:项)?选(?:择)?题|多(?:项)?选(?:择)?题)/);
    if (sectionMatch) {
      section = sectionMatch[1].includes('多') ? '多选题' : sectionMatch[1].includes('判断') ? '判断题' : '单选题';
      continue;
    }
    const start = line.match(/^(\d{1,4})\s*[.．、]\s*(\S.*)$/);
    const standaloneNumber = line.match(/^(\d{1,4})$/);
    const number = start || (standaloneNumber && section ? [standaloneNumber[0], standaloneNumber[1], ''] : null);
    const following = [];
    if (number) {
      for (let i = lineIndex + 1; i < lines.length; i++) {
        const next = lines[i].trim();
        if (/^\d{1,4}(?:\s*[.．、]\s*\S.*)?$/.test(next)) break;
        following.push(next);
      }
    }
    const optionCount = following.filter(item => /^[A-E](?:\s*[.．、]\s*|\s+)\S/.test(item)).length;
    const hasQuestionStem = following.some(item => /^题干\s*[：:]/.test(item));
    if (number && (optionCount >= 2 || /内容缺失/.test(number[2]) || section === '判断题' || (standaloneNumber && hasQuestionStem))) {
      current = { number: Number(number[1]), section, lines: number[2] ? [number[2]] : [] };
      chunks.push(current);
    } else if (current && line) {
      current.lines.push(line);
    }
  }

  const questions = [];
  const skipped = [];
  for (const chunk of chunks) {
    const answerIndex = chunk.lines.findIndex(line => /^(?:正确)?答案\s*[：:]/.test(line));
    if (answerIndex < 0) { skipped.push(chunk.number); continue; }
    const answerText = chunk.lines[answerIndex].replace(/^(?:正确)?答案\s*[：:]\s*/, '').trim().toUpperCase();
    const answerMatch = answerText.match(/^[A-E](?:\s*[,，、/\s]?\s*[A-E])*/);
    let answer = answerMatch ? [...new Set(answerMatch[0].match(/[A-E]/g))].sort() : [];
    const stem = [];
    let options = [];
    for (const line of chunk.lines.slice(0, answerIndex)) {
      const option = line.match(/^([A-E])(?:\s*[.．、]\s*|\s+)(.*)$/);
      if (option) options.push({ letter: option[1], text: option[2] });
      else if (options.length) options[options.length - 1].text += ' ' + line;
      else stem.push(line.replace(/^题干\s*[：:]\s*/, ''));
    }
    if (chunk.section === '判断题' && !answer.length) {
      const truthMatch = answerText.match(/^(对|错|正确|错误|是|否|√|×|✔|✘)/);
      const truth = truthMatch ? truthMatch[1] : null;
      if (truth) {
        if (!options.length) options = [{ letter: 'A', text: '正确' }, { letter: 'B', text: '错误' }];
        const answerIsTrue = /^(对|正确|是|√|✔)$/.test(truth);
        const matchingOption = options.find(option => {
          const text = option.text.replace(/[\s。．.!！?？]/g, '');
          return answerIsTrue ? /^(对|正确|是|√|✔)$/.test(text) : /^(错|错误|否|×|✘)$/.test(text);
        });
        if (matchingOption) answer = [matchingOption.letter];
      }
    }
    const letters = options.map(option => option.letter);
    if (!stem.length || chunk.lines.includes('[DOCX选项编号异常]') || options.length < 2 || letters.some((letter, index) => letter !== String.fromCharCode(65 + index)) || !answer.length || answer.some(letter => !letters.includes(letter)) || (chunk.section && chunk.section !== '多选题' && answer.length > 1)) {
      skipped.push(chunk.number);
      continue;
    }
    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1].number;
      const next = chunks[i].number;
      if (next > previous + 1 && next - previous <= 200) {
        for (let number = previous + 1; number < next; number++) if (!skipped.includes(number)) skipped.push(number);
      }
    }
    skipped.sort((a, b) => a - b);
    const explanation = chunk.lines.slice(answerIndex + 1).join(' ').replace(/^解析\s*[：:]\s*/, '');
    questions.push({
      number: chunk.number,
      type: chunk.section || (answer.length > 1 ? '多选题' : '单选题'),
      stem: cleanText(stem.join(' ')),
      options: options.map(option => ({ letter: option.letter, text: cleanText(option.text) })),
      answer,
      explanation: cleanText(explanation)
    });
  }
  const id = hashText(text) + '-' + text.length;
  questions.forEach((question, index) => { question.id = `${id}-${index}`; });
  return { id, name: filename.replace(/\.(?:pdf|docx)$/i, ''), questions, skipped, format: /\.docx$/i.test(filename) ? 'DOCX' : 'PDF' };
}

async function extractDocx(data, base64 = false) {
  const zip = await JSZip.loadAsync(data, { base64 });
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('不是有效的 DOCX：缺少正文');
  const xml = new DOMParser().parseFromString(await entry.async('string'), 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('DOCX 正文 XML 无效');
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const body = xml.getElementsByTagNameNS(ns, 'body')[0];
  if (!body) throw new Error('DOCX 缺少正文');
  const numberingEntry = zip.file('word/numbering.xml');
  const formats = new Map();
  if (numberingEntry) {
    const numbering = new DOMParser().parseFromString(await numberingEntry.async('string'), 'application/xml');
    if (numbering.querySelector('parsererror')) throw new Error('DOCX 编号 XML 无效');
    const abstracts = new Map(Array.from(numbering.getElementsByTagNameNS(ns, 'abstractNum'), element => [
      element.getAttributeNS(ns, 'abstractNumId'), element
    ]));
    for (const element of numbering.getElementsByTagNameNS(ns, 'num')) {
      const abstractId = element.getElementsByTagNameNS(ns, 'abstractNumId')[0];
      const abstract = abstractId && abstracts.get(abstractId.getAttributeNS(ns, 'val'));
      if (!abstract) continue;
      for (const level of abstract.getElementsByTagNameNS(ns, 'lvl')) {
        const format = level.getElementsByTagNameNS(ns, 'numFmt')[0];
        if (format) formats.set(`${element.getAttributeNS(ns, 'numId')}:${level.getAttributeNS(ns, 'ilvl')}`, format.getAttributeNS(ns, 'val'));
      }
    }
  }
  const lines = [];
  let number = 0;
  let nextOption = 0;
  let hasQuestion = false;
  let hasAnswer = false;
  let inSection = false;
  const paragraphs = [];
  for (const paragraph of body.getElementsByTagNameNS(ns, 'p')) {
    const text = Array.from(paragraph.getElementsByTagNameNS(ns, 't'), node => node.textContent).join('').trim();
    const inlineOptionCount = (text.match(/\s[A-E]\s+(?=\S)/g) || []).length;
    const normalized = text
      .replace(/([。！？])\s+(?=\d{1,4}\s*[.．、]\s*\S)/g, '$1\n')
      .replace(/([^\n])(?=[一二三四五六七八九十]+[、.．]\s*(?:判断题|单(?:项)?选(?:择)?题|多(?:项)?选(?:择)?题))/g, '$1\n')
      .replace(/([）)])\s+(?=\d{1,4}\s*[.．、]\s*\S)/g, '$1\n')
      .replace(/([。！？?])\s+([A-E])\s+(?=\S)/g, '$1\n$2. ');
    const parts = (inlineOptionCount >= 2 ? normalized.replace(/([^\n])\s+([A-E])\s+(?=\S)/g, '$1\n$2. ') : normalized).split('\n');
    parts.forEach((part, index) => paragraphs.push({ text: part, paragraph: index === 0 ? paragraph : null }));
  }
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const item = paragraphs[paragraphIndex];
    let text = item.text.trim();
    const paragraph = item.paragraph;
    if (!text) continue;
    if (/^[一二三四五六七八九十]+[、.．]\s*(判断题|单(?:项)?选(?:择)?题|多(?:项)?选(?:择)?题)/.test(text)) {
      inSection = true;
      lines.push(text);
      continue;
    }
    if (!inSection) continue;
    const numPr = paragraph && paragraph.getElementsByTagNameNS(ns, 'numPr')[0];
    const levelNode = numPr && numPr.getElementsByTagNameNS(ns, 'ilvl')[0];
    const level = numPr ? Number(levelNode ? levelNode.getAttributeNS(ns, 'val') : 0) : -1;
    const idNode = numPr && numPr.getElementsByTagNameNS(ns, 'numId')[0];
    const format = idNode && formats.get(`${idNode.getAttributeNS(ns, 'val')}:${level}`);
    const explicit = text.match(/^(\d{1,4})\s*[.．、]\s*(\S.*)$/);
    const standaloneNumber = text.match(/^(\d{1,4})$/);
    const option = text.match(/^([A-E])\s*[.．、]\s*/);
    const isAnswer = /^(?:正确)?答案\s*[：:]/.test(text);
    const isExplanation = /^解析\s*[：:]/.test(text);
    if (standaloneNumber && /^题干\s*[：:]/.test(paragraphs[paragraphIndex + 1]?.text || '')) {
      number = Number(standaloneNumber[1]);
      lines.push(String(number));
      hasQuestion = true;
      hasAnswer = false;
      nextOption = 0;
      continue;
    }
    let anotherQuestionFirst = false;
    if (format === 'decimal' && hasAnswer && !explicit) {
      for (let i = paragraphIndex + 1; i < paragraphs.length; i++) {
        const next = paragraphs[i];
        if (/(?:正确)?答案\s*[：:]/.test(next.text) || /(?:^|\s)[A-E]\s*[.．、]/.test(next.text)) break;
        const nextNum = next.paragraph && next.paragraph.getElementsByTagNameNS(ns, 'numPr')[0];
        const nextId = nextNum && nextNum.getElementsByTagNameNS(ns, 'numId')[0];
        const nextLevel = nextNum && nextNum.getElementsByTagNameNS(ns, 'ilvl')[0];
        if (nextId && formats.get(`${nextId.getAttributeNS(ns, 'val')}:${nextLevel ? nextLevel.getAttributeNS(ns, 'val') : '0'}`) === 'decimal') {
          anotherQuestionFirst = true;
          break;
        }
      }
    }
    if (explicit && !isExplanation && (!hasQuestion || hasAnswer) && Number(explicit[1]) >= number + 1) {
      number = Number(explicit[1]);
      text = `${number}. ${explicit[2]}`;
      hasQuestion = true;
      hasAnswer = false;
      nextOption = 0;
    } else if (format === 'decimal' && !option && !isAnswer && !isExplanation && (!hasQuestion || hasAnswer) && !anotherQuestionFirst) {
      number++;
      text = `${number}. ${text}`;
      hasQuestion = true;
      hasAnswer = false;
      nextOption = 0;
    } else if (format === 'upperLetter' && !option && !isAnswer && !isExplanation && hasQuestion && !hasAnswer && nextOption < 5) {
      text = `${String.fromCharCode(65 + nextOption)}. ${text}`;
      nextOption++;
    } else if (format === 'decimal' && hasQuestion && !hasAnswer && !option && !isAnswer && !isExplanation) {
      if (level > 0 && nextOption > 0) lines.push('[DOCX选项编号异常]');
      if (nextOption < 5) {
        text = `${String.fromCharCode(65 + nextOption)}. ${text}`;
        nextOption++;
      }
    }
    if (hasQuestion && !hasAnswer) text = text.replace(/^([A-E])\s+(?=\S)/, '$1. ');
    text = text.replace(/\s*(正确答案|(?<!正确)答案)\s*([：:])/g, '\n$1$2');
    text = text.replace(/\s*解析\s*([：:])/g, '\n解析$1');
    text = text.replace(/([^\n])\s+([A-E]\s*[.．、]\s*)/g, '$1\n$2');
    text = text.replace(/([。？?！!])\s*([A-E]\s*[.．、]\s*)/g, '$1\n$2');
    const pieces = text.split('\n');
    for (const piece of pieces) {
      const currentOption = piece.match(/^([A-E])\s*[.．、]/);
      if (currentOption) nextOption = currentOption[1].charCodeAt(0) - 64;
      if (/^(?:正确)?答案\s*[：:]/.test(piece)) hasAnswer = true;
      lines.push(piece);
    }
    if (/内容缺失/.test(text)) hasAnswer = true;
  }
  return lines.join('\n');
}

async function extractPdf(file) {
  return extractPdfBytes(await file.arrayBuffer());
}

async function extractPdfBytes(data) {
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let text = '';
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      text += content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('') + '\n';
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  return text;
}

function comparableText(text) {
  return text.replace(/[\s\p{P}\p{S}]/gu, '');
}

function sameQuestion(left, right) {
  return left.type === right.type && comparableText(left.stem) === comparableText(right.stem)
    && left.answer.join('') === right.answer.join('')
    && left.options.length === right.options.length
    && left.options.every((option, index) => option.letter === right.options[index].letter
      && comparableText(option.text) === comparableText(right.options[index].text));
}

async function completeFromReference(paper, base64) {
  if (!base64 || !paper.skipped.length) return [];
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const reference = parsePaper(await extractPdfBytes(bytes), `${paper.name}.pdf`);
  const byNumber = new Map(reference.questions.map(question => [question.number, question]));
  if (paper.questions.length < 10 || paper.questions.some(question => {
    const candidate = byNumber.get(question.number);
    return !candidate || !sameQuestion(question, candidate);
  })) throw new Error('同名 PDF 与 DOCX 的题目不完全一致，未使用 PDF 补全');
  const filled = [];
  for (const number of paper.skipped) {
    const question = byNumber.get(number);
    if (question) {
      paper.questions.push({ ...question, id: `${paper.id}-reference-${number}`, source: '同名 PDF 补全' });
      filled.push(number);
    }
  }
  paper.questions.sort((left, right) => left.number - right.number);
  paper.skipped = paper.skipped.filter(number => !filled.includes(number));
  paper.filledFromPdf = filled;
  return filled;
}

async function importFiles(files) {
  if (!files.length) return;
  let imported = 0;
  const messages = [];
  for (const file of files) {
    notify(`正在识别 ${file.name}，请稍候…`, true);
    try {
      const text = /\.docx$/i.test(file.name) ? await extractDocx(await file.arrayBuffer()) : await extractPdf(file);
      const paper = parsePaper(text, file.name);
      const existingIndex = state.papers.findIndex(existing => existing.id === paper.id);
      if (!paper.questions.length) {
        messages.push(`${file.name}：没有识别到完整题目。请确认文档含文字，且题目后有选项及“正确答案：”或“答案：”。`);
      } else if (existingIndex >= 0 && paper.questions.length > state.papers[existingIndex].questions.length) {
        const existing = state.papers[existingIndex];
        const progress = progressFor(existing.id);
        if (!progress || (!progress.session && !progress.count && !(progress.attempts && progress.attempts.length))) {
          state.papers[existingIndex] = paper;
          imported++;
          messages.push(`${file.name}：检测到此前版本未完整识别题目，已更新识别结果。`);
        } else {
          paper.id = `${paper.id}-complete-${paper.questions.length}`;
          paper.name += '（完整识别版）';
          paper.questions.forEach((question, index) => { question.id = `${paper.id}-${index}`; });
          if (state.papers.some(existingPaper => existingPaper.id === paper.id)) {
            messages.push(`${file.name}：完整识别版本已经导入，未重复添加。`);
          } else {
            state.papers.unshift(paper);
            imported++;
            messages.push(`${file.name}：已导入完整识别版本；原有试卷和答题记录已保留。`);
          }
        }
      } else if (existingIndex >= 0) {
        messages.push(`${file.name}：已经导入，未重复添加。`);
      } else {
        state.papers.unshift(paper);
        imported++;
        if (paper.skipped.length) messages.push(`${file.name}：已导入 ${paper.questions.length} 题，未能识别第 ${paper.skipped.join('、')} 题，请核对原文件。`);
      }
    } catch (error) {
      messages.push(`${file.name}：导入失败（${error.message}）。`);
    }
  }
  const saved = save();
  notice = messages.join('\n');
  if (saved) notify(imported ? `成功导入 ${imported} 份试卷${messages.length ? '，请查看识别提示' : ''}。` : '没有新增试卷，请查看识别提示。');
  view = 'papers';
  render();
}

async function installBundledPapers() {
  if (state.bundledVersion === 1) return;
  if (!Array.isArray(window.BUNDLED_DOCX)) {
    notice = '内置试卷数据未加载，请检查 bundled-papers.js 是否存在。';
    render();
    return;
  }
  const messages = [];
  let failed = false;
  for (const file of window.BUNDLED_DOCX) {
    try {
      const paper = parsePaper(await extractDocx(file.data, true), file.name);
      if (!paper.questions.length) throw new Error('未识别到完整题目');
      const existing = state.papers.find(item => item.id === paper.id);
      if (state.bundledInstalled && !existing) continue;
      if (paper.skipped.length && file.referencePdf) {
        try {
          await completeFromReference(paper, file.referencePdf);
        } catch (error) {
          messages.push(`${file.name}：${error.message}。`);
        }
      }
      if (existing) {
        const index = state.papers.indexOf(existing);
        state.papers[index] = paper;
      } else {
        state.papers.push(paper);
      }
      if (paper.skipped.length) messages.push(`${file.name}：未识别第 ${paper.skipped.join('、')} 题。`);
    } catch (error) {
      failed = true;
      messages.push(`${file.name}：导入失败（${error.message}）。`);
    }
  }
  state.bundledInstalled = !failed;
  state.bundledVersion = failed ? 0 : 1;
  if (!save()) state.bundledVersion = 0;
  if (messages.length) notice = `内置试卷识别提示（未识别的题目不计入试卷，请核对原文件）：\n${messages.join('\n')}`;
  render();
}

function heading(kicker, title, description, right = '') {
  return `<div class="page-heading"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${description}</p></div>${right}</div>`;
}

function paperCard(paper) {
  const progress = progressFor(paper.id);
  const snapshot = progress && progress.session;
  const attempts = progress && Array.isArray(progress.attempts) ? progress.attempts : [];
  const answered = snapshot ? paper.questions.filter(q => (snapshot.answers[q.id] || []).length).length : 0;
  return `<article class="paper-card"><div class="paper-top"><div class="paper-icon">▤</div><span class="tag">${paper.questions.length} 道题目</span></div><h3>${escapeHtml(paper.name)}</h3><div class="paper-meta">${escapeHtml(paper.format || 'PDF')} 试卷 · 整卷作答${paper.filledFromPdf && paper.filledFromPdf.length ? ` · 同名 PDF 补全：第 ${paper.filledFromPdf.join('、')} 题` : ''}${paper.skipped.length ? ` · 未识别：第 ${paper.skipped.join('、')} 题` : ''}</div><div class="paper-meta">已交卷 ${progress ? progress.count : 0} 次${snapshot ? ` · 进行到第 ${Math.min(snapshot.index + 1, paper.questions.length)} 题 · 已答 ${answered} 题` : ' · 暂无未完成练习'}</div><div class="paper-actions"><button class="link-action" data-action="start" data-id="${escapeHtml(paper.id)}">${snapshot ? '继续练习' : '开始练习'} ↗</button><button class="delete-action" data-action="delete-paper" data-id="${escapeHtml(paper.id)}" aria-label="删除 ${escapeHtml(paper.name)}">删除</button></div>${attempts.length ? `<div class="attempt-history"><strong>历史答卷</strong>${attempts.map((attempt, index) => `<button class="link-action" data-action="view-attempt" data-id="${escapeHtml(paper.id)}" data-index="${index}">第 ${index + 1} 次 · ${escapeHtml(new Date(attempt.submittedAt).toLocaleString('zh-CN'))} →</button>`).join('')}</div>` : ''}</article>`;
}

function home() {
  const date = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  const total = state.papers.reduce((sum, paper) => sum + paper.questions.length, 0);
  return `${heading('YOUR STUDY SPACE', '今天，也要向前一步', '把每一次练习，变成看得见的进步。', `<div class="date-pill">☼ &nbsp; ${escapeHtml(date)}</div>`)}
    ${state.session && !state.session.submitted ? `<div class="notice">你有一份未完成的练习：${escapeHtml(state.session.title)}。 <button class="link-action" data-action="resume">继续作答 →</button></div>` : ''}
    ${notice ? `<div class="notice" role="alert">${escapeHtml(notice)}</div>` : ''}
    <section class="hero"><div class="hero-copy"><div class="hero-tag">A LITTLE PROGRESS EVERY DAY</div><h2>准备好，<br>迎接下一次挑战。</h2><p>导入你的试卷，开启一场专注练习。</p><button class="button primary" data-action="import">＋ &nbsp; 导入试卷</button></div><div class="hero-art" aria-hidden="true"><div class="orb"></div><div class="art-book"></div><div class="art-spark">✳</div></div></section>
    <div class="stats"><div class="stat"><div class="stat-icon">▤</div><div><div class="stat-label">我的试卷</div><div class="stat-value">${state.papers.length}<small>份</small></div></div></div><div class="stat"><div class="stat-icon">✎</div><div><div class="stat-label">收录题目</div><div class="stat-value">${total}<small>题</small></div></div></div><div class="stat"><div class="stat-icon">◇</div><div><div class="stat-label">待巩固错题</div><div class="stat-value">${state.wrong.length}<small>题</small></div></div></div></div>
    <div class="section-title"><div><h2>我的试卷</h2><p>选一份试卷，开始今天的练习</p></div><button class="text-button" data-view="papers">查看全部 →</button></div>
    <div class="cards">${state.papers.slice(0, 2).map(paperCard).join('')}<button class="upload-card" data-action="import"><span class="upload-plus">＋</span><strong>导入新试卷</strong><small>支持 DOCX 和含文字的 PDF</small></button></div>`;
}

function papersView() {
  return `${heading('YOUR PAPERS', '我的试卷', '所有准备，都从这里开始。', '<button class="button primary" data-action="import">＋ 导入试卷</button>')}
    <div class="notice">${sharedMode ? (progressReady ? '试卷进度和交卷次数已连接本机共享存储。' : '试卷进度未连接本机共享存储，请确认服务窗口运行中。') : '当前为浏览器本地模式，试卷进度不会自动跨浏览器共享。'} 试卷文件仍需在各浏览器分别导入。</div>
    <div><button class="button secondary" data-action="export-progress">导出试卷进度</button> <button class="button secondary" data-action="import-progress">导入试卷进度</button>${state.pendingLegacy ? ' <button class="button secondary" data-action="export-legacy-progress">导出未迁移的旧进度</button>' : ''}</div>
    ${notice ? `<div class="notice" role="alert">${escapeHtml(notice)}</div>` : ''}
    <div class="section-title"><div><h2>试卷列表 <span class="tag">${state.papers.length}</span></h2><p>完成整套试卷后，即可查看成绩与解析</p></div></div>
    <div class="cards">${state.papers.map(paperCard).join('')}<button class="upload-card" data-action="import"><span class="upload-plus">＋</span><strong>导入新试卷</strong><small>支持一次选择多个 DOCX 或 PDF</small></button></div>`;
}

function wrongView() {
  return `${heading('REVIEW & GROW', '错题本', '把不会的题，变成下一次的底气。', `<div class="wrong-mode-actions"><button class="button ${wrongAnswerMode ? 'primary' : 'secondary'}" data-action="wrong-answer-mode" aria-pressed="${wrongAnswerMode}">${wrongAnswerMode ? '✓ 直接查看答案' : '直接查看答案'}</button><button class="button ${wrongAnswerMode ? 'secondary' : 'primary'}" data-action="practice-wrong" ${state.wrong.length ? '' : 'disabled'}>↻ &nbsp; 答题练习</button></div>`)}
    ${syncWarning ? `<div class="notice" role="alert">${escapeHtml(syncWarning)}</div>` : `<div class="notice">错题本已连接本机共享存储，不同浏览器使用同一地址即可查看。</div>`}
    <div><button class="button secondary" data-action="export-wrong">导出错题本</button> <button class="button secondary" data-action="import-wrong">导入错题本</button></div>
    <div class="section-title"><div><h2>待巩固的题目 <span class="tag">${state.wrong.length}</span></h2><p>错题会保留在这里，可反复练习或手动移除</p></div></div>
    <div class="wrong-list">${state.wrong.length ? state.wrong.map(item => `<article class="panel wrong-item"><span class="tag">${escapeHtml(item.question.type)} · 第 ${item.question.number} 题</span><h3>${escapeHtml(item.question.stem)}</h3>${wrongAnswerMode ? `<div class="wrong-answer-options">${item.question.options.map(option => `<div class="${item.question.answer.includes(option.letter) ? 'correct-answer-option' : ''}"><strong>${escapeHtml(option.letter)}.</strong> ${escapeHtml(option.text)}${item.question.answer.includes(option.letter) ? ' <span>正确答案</span>' : ''}</div>`).join('')}</div><div class="answer-box"><strong>正确答案：${item.question.answer.map(escapeHtml).join('、')}</strong>${item.question.explanation ? `<br><br>解析：${escapeHtml(item.question.explanation)}` : ''}</div>` : ''}<div class="wrong-item-bottom"><span>${escapeHtml(item.paperName)}</span><button class="delete-action" data-action="remove-wrong" data-id="${escapeHtml(item.question.id)}">移除错题</button></div></article>`).join('') : '<div class="empty-card"><div class="empty-symbol">✳</div>还没有错题，继续保持！<br>完成试卷后，答错、漏选和未作答的题目会自动收录在这里。</div>'}</div>`;
}

function isCorrect(question, selected) {
  return selected.length === question.answer.length && question.answer.every(letter => selected.includes(letter));
}

function maxQuestionScore(question) {
  return question.type === '多选题' ? 1 : 0.5;
}

function questionScore(question, selected) {
  if (isCorrect(question, selected)) return maxQuestionScore(question);
  if (question.type === '多选题' && selected.length && selected.every(letter => question.answer.includes(letter))) return 0.5;
  return 0;
}

function examView() {
  const session = attemptReview || state.session;
  const archivedReview = Boolean(attemptReview);
  if (!session || !session.questions.length) { view = 'home'; return home(); }
  const question = session.questions[session.index];
  const selected = session.answers[question.id] || [];
  const answered = session.questions.filter(q => (session.answers[q.id] || []).length).length;
  const correctCount = session.questions.filter(q => isCorrect(q, session.answers[q.id] || [])).length;
  const score = session.questions.reduce((total, q) => total + questionScore(q, session.answers[q.id] || []), 0);
  const maximum = session.questions.reduce((total, q) => total + maxQuestionScore(q), 0);
  const partialCount = session.questions.filter(q => !isCorrect(q, session.answers[q.id] || []) && questionScore(q, session.answers[q.id] || []) > 0).length;
  const result = session.submitted;
  const banner = result ? `<div class="result-banner"><div class="score">${score}<small> / ${maximum} 分</small></div><div><h2>${archivedReview ? '历史答卷回看' : '练习完成，继续加油！'}</h2><p>${archivedReview ? `交卷时间：${escapeHtml(new Date(session.submittedAt).toLocaleString('zh-CN'))}<br>` : ''}全对 ${correctCount} 题 · 漏选 ${partialCount} 题 · 错选或未作答 ${session.questions.length - correctCount - partialCount} 题<br>判断、单选每题 0.5 分；多选每题 1 分，漏选 0.5 分，错选 0 分。</p></div><button class="button secondary" data-view="wrong">查看错题本 →</button></div>` : '';
  return `${heading(archivedReview ? 'ANSWER SHEET' : result ? 'PRACTICE RESULTS' : 'FOCUS & PRACTICE', archivedReview ? '历史答卷回看' : result ? '练习结果' : '专注练习', result ? '回顾每一道题，让练习更有价值。' : '慢慢来，认真思考每一道题。', `<button class="button secondary" ${archivedReview ? 'data-action="exit-attempt-review"' : 'data-view="papers"'}>← ${archivedReview ? '返回答卷记录' : '返回试卷'}</button>`)}
    ${banner}<div class="exam-layout"><section class="panel exam-main"><div class="exam-head"><h2>${escapeHtml(session.title)}</h2><small>${session.index + 1} / ${session.questions.length}</small></div>
    <div class="progress-track"><div class="progress-fill" style="width:${(result ? 100 : answered / session.questions.length * 100)}%"></div></div>
    <div class="question-kicker"><span class="tag">${escapeHtml(question.type)}</span><span>原卷第 ${question.number} 题 ${question.type === '多选题' ? ' · 可选择多个答案' : ' · 请选择一个答案'}${question.source ? ` · ${escapeHtml(question.source)}` : ''}</span></div>
    <div class="question-title">${escapeHtml(question.stem)}</div>
    <div>${question.options.map(option => {
      const chosen = selected.includes(option.letter);
      const resultClass = result && question.answer.includes(option.letter) ? 'correct' : result && chosen ? 'incorrect' : '';
      return `<label class="option ${chosen ? 'selected' : ''} ${resultClass}"><input type="${question.type === '多选题' ? 'checkbox' : 'radio'}" name="answer" value="${option.letter}" ${chosen ? 'checked' : ''} ${result ? 'disabled' : ''}><span class="option-letter">${option.letter}</span><span>${escapeHtml(option.text)}</span></label>`;
    }).join('')}</div>
    ${result ? `<div class="answer-box"><strong class="${isCorrect(question, selected) ? '' : 'bad'}">${isCorrect(question, selected) ? '回答正确' : questionScore(question, selected) > 0 ? '漏选' : '回答错误'}</strong> &nbsp; 得分：${questionScore(question, selected)} / ${maxQuestionScore(question)} &nbsp; · &nbsp; 你的答案：${selected.join('、') || '未作答'} &nbsp; · &nbsp; 正确答案：${question.answer.join('、')}${question.explanation ? `<br><br>解析：${escapeHtml(question.explanation)}` : ''}</div>` : ''}
    <div class="exam-actions"><button class="button secondary" data-action="prev" ${session.index === 0 ? 'disabled' : ''}>← 上一题</button><button class="button secondary" data-action="next" ${session.index === session.questions.length - 1 ? 'disabled' : ''}>下一题 →</button></div></section>
    <aside class="panel exam-side"><h3>答题卡</h3><p>${result ? '绿色为全对，红色为漏选、错误或未作答' : `已作答 ${answered} / ${session.questions.length} 题`}</p><div class="palette">${session.questions.map((q, index) => `<button data-action="jump" data-index="${index}" class="${index === session.index ? 'current' : ''} ${result ? (isCorrect(q, session.answers[q.id] || []) ? 'right' : 'wrong') : ((session.answers[q.id] || []).length ? 'answered' : '')}" aria-label="第 ${index + 1} 题">${index + 1}</button>`).join('')}</div>${archivedReview ? '<button class="button secondary full" data-action="exit-attempt-review">返回答卷记录</button>' : result ? '<button class="button secondary full" data-action="restart">↻ 重新练习</button>' : '<button class="button primary full" data-action="submit">交卷并查看结果</button>'}</aside></div>`;
}

function render() {
  document.querySelector('#paper-count').textContent = state.papers.length;
  document.querySelector('#wrong-count').textContent = state.wrong.length;
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  document.querySelector('#top-location').textContent = ({ home: '学习首页', papers: '我的试卷', wrong: '错题本', exam: '专注练习' })[view];
  document.querySelector('#storage-description').textContent = sharedMode ? '错题和试卷进度保存在本机' : '错题和进度保存在当前浏览器中';
  app.innerHTML = view === 'home' ? home() : view === 'papers' ? papersView() : view === 'wrong' ? wrongView() : examView();
}

function confirmAction(title, message, buttonText) {
  return new Promise(resolve => {
    const dialog = document.querySelector('#confirm-dialog');
    document.querySelector('#dialog-title').textContent = title;
    document.querySelector('#dialog-message').textContent = message;
    const confirm = document.querySelector('#dialog-confirm');
    const cancel = document.querySelector('#dialog-cancel');
    confirm.textContent = buttonText;
    const close = value => { dialog.close(); resolve(value); };
    confirm.onclick = () => close(true);
    cancel.onclick = () => close(false);
    dialog.oncancel = event => { event.preventDefault(); close(false); };
    dialog.showModal();
  });
}

async function startSession(title, questions, sources, paperId = null) {
  const session = { title, questions, sources, answers: {}, index: 0, submitted: false, paperId, practiceId: crypto.randomUUID() };
  if (paperId && !await updateProgress('/api/progress/save', paperId, sessionSnapshot(session))) return;
  attemptReview = null;
  state.session = session;
  save();
  view = 'exam';
  render();
  window.scrollTo(0, 0);
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button, a[data-view]');
  if (!button) return;
  if (button.dataset.view) {
    event.preventDefault();
    attemptReview = null;
    view = button.dataset.view;
    render();
    if (view === 'wrong') refreshWrong();
    return;
  }
  const action = button.dataset.action;
  const session = attemptReview || state.session;
  if (progressBusy) { notify('正在保存试卷进度，请稍候。'); return; }
  if (action === 'import') input.click();
  else if (action === 'export-progress') exportProgress();
  else if (action === 'export-legacy-progress' && state.pendingLegacy) downloadProgress([state.pendingLegacy], '导游未迁移的旧进度.json');
  else if (action === 'import-progress') progressInput.click();
  else if (action === 'export-wrong') exportWrong();
  else if (action === 'import-wrong') wrongInput.click();
  else if (action === 'wrong-answer-mode') { wrongAnswerMode = !wrongAnswerMode; render(); }
  else if (action === 'view-attempt') {
    const paper = state.papers.find(item => item.id === button.dataset.id);
    const progress = paper && progressFor(paper.id);
    const attempt = progress && progress.attempts && progress.attempts[Number(button.dataset.index)];
    if (paper && validAttempt(attempt)) {
      attemptReview = { title: paper.name, questions: paper.questions,
        sources: Object.fromEntries(paper.questions.map(question => [question.id, paper.name])),
        answers: attempt.answers, index: 0, submitted: true, paperId: paper.id,
        practiceId: attempt.id, submittedAt: attempt.submittedAt };
      view = 'exam';
      render();
      window.scrollTo(0, 0);
    } else {
      notify('这份历史答卷记录无效，请重新导入试卷进度备份。', true);
    }
  } else if (action === 'exit-attempt-review') {
    attemptReview = null;
    view = 'papers';
    render();
  }
  else if (action === 'resume' && session) { view = 'exam'; render(); }
  else if (action === 'start') {
    const paper = state.papers.find(item => item.id === button.dataset.id);
    if (sharedMode && !progressReady) { notify('共享试卷进度未连接，请检查服务并稍后重试。', true); return; }
    if (paper) {
      if (session && !session.paperId && !session.submitted &&
        !await confirmAction('切换到试卷？', '当前未交卷的错题练习进度将被替换。', '切换试卷')) return;
      const progress = progressFor(paper.id);
      if (progress && progress.session) {
        state.session = restorePaper(paper, progress.session);
        save(); view = 'exam'; render(); window.scrollTo(0, 0);
      } else {
        await startSession(paper.name, paper.questions, Object.fromEntries(paper.questions.map(q => [q.id, paper.name])), paper.id);
      }
    }
  } else if (action === 'practice-wrong') {
    if (state.wrong.length && (!session || session.paperId || session.submitted || await confirmAction('开始错题练习？', '当前未交卷的错题练习进度将被替换。', '开始新练习'))) {
      await startSession('错题专项练习', state.wrong.map(item => item.question), Object.fromEntries(state.wrong.map(item => [item.question.id, item.paperName])));
    }
  } else if (action === 'delete-paper') {
    const paper = state.papers.find(item => item.id === button.dataset.id);
    if (paper && await confirmAction('删除这份试卷？', '删除后试卷会从当前浏览器的列表中移除；错题和试卷进度记录会保留。', '确认删除')) {
      state.papers = state.papers.filter(item => item.id !== paper.id);
      save(); render();
    }
  } else if (action === 'remove-wrong') {
    if (sharedMode) {
      if (!await updateWrong('/api/wrong/remove', { id: button.dataset.id })) return;
    } else {
      state.wrong = state.wrong.filter(item => item.question.id !== button.dataset.id);
    }
    save(); render();
  } else if (session && ['prev', 'next', 'jump'].includes(action)) {
    const previous = session.index;
    session.index = action === 'prev' ? session.index - 1 : action === 'next' ? session.index + 1 : Number(button.dataset.index);
    if (session.paperId && !session.submitted && !await updateProgress('/api/progress/save', session.paperId, sessionSnapshot(session))) { session.index = previous; render(); return; }
    save(); render();
    if (!window.matchMedia('(max-width: 650px)').matches) window.scrollTo(0, 0);
  } else if (session && action === 'submit') {
    const unanswered = session.questions.filter(q => !(session.answers[q.id] || []).length).length;
    if (await confirmAction('确定交卷吗？', unanswered ? `还有 ${unanswered} 道题未作答，交卷后将按错误计入错题本。` : '交卷后将显示成绩、正确答案和解析，并自动收录错题。', '确认交卷')) {
      if (state.session !== session) { notify('练习已发生变化，请重新确认交卷。', true); return; }
      const incorrect = session.questions.filter(question => !isCorrect(question, session.answers[question.id] || []))
        .map(question => ({ question, paperName: session.sources[question.id] }));
      const attempt = { id: session.practiceId, submittedAt: new Date().toISOString(),
        answers: Object.fromEntries(Object.entries(session.answers).map(([id, answer]) => [id, answer.slice()])) };
      if (session.paperId && sharedMode && !progressReady) { notify('共享试卷进度未连接，无法交卷。', true); return; }
      if (sharedMode && !await updateWrong('/api/wrong/add', { items: incorrect })) return;
      if (state.session !== session) { notify('练习已发生变化，请重新确认交卷。', true); return; }
      if (session.paperId && !await updateProgress('/api/progress/submit', session.paperId, null, session.practiceId, 0, attempt)) return;
      session.submitted = true;
      session.submittedAt = attempt.submittedAt;
      if (!sharedMode) {
        for (const item of incorrect) {
          if (!state.wrong.some(existing => existing.question.id === item.question.id)) state.wrong.push(item);
        }
      }
      save(); render(); window.scrollTo(0, 0);
    }
  } else if (session && action === 'restart' && !attemptReview) {
    if (session.paperId && progressFor(session.paperId) && progressFor(session.paperId).session) {
      notify('这份试卷已有未完成的练习，请从试卷列表继续。', true);
      return;
    }
    await startSession(session.title, session.questions, session.sources, session.paperId);
  }
});

document.addEventListener('change', async event => {
  if (event.target === input) {
    const files = Array.from(input.files);
    input.value = '';
    importFiles(files);
  } else if (event.target === wrongInput) {
    const file = wrongInput.files[0];
    wrongInput.value = '';
    if (file) importWrong(file);
  } else if (event.target === progressInput) {
    const file = progressInput.files[0];
    progressInput.value = '';
    if (file) await importProgress(file);
  } else if (event.target.name === 'answer' && state.session && !state.session.submitted) {
    if (progressBusy) { notify('正在保存试卷进度，请稍候。'); render(); return; }
    const session = state.session;
    const question = session.questions[session.index];
    const current = session.answers[question.id] || [];
    session.answers[question.id] = question.type === '多选题'
      ? (event.target.checked ? [...current, event.target.value].sort() : current.filter(letter => letter !== event.target.value))
      : [event.target.value];
    if (session.paperId && !await updateProgress('/api/progress/save', session.paperId, sessionSnapshot(session))) { session.answers[question.id] = current; render(); return; }
    save(); render();
  }
});

if (!sharedMode && !state.progressMigrationDone) {
  const legacy = legacyProgress();
  if (legacy && !progressFor(legacy.paperId)) state.progress.push(legacy);
  if (legacy) {
    const entry = progressFor(legacy.paperId);
    const paper = state.papers.find(item => item.id === legacy.paperId);
    if (entry && entry.session && paper) state.session = restorePaper(paper, entry.session);
  }
  state.progressMigrationDone = true;
  save();
}
render();
installBundledPapers();
if (sharedMode) {
  refreshWrong();
  refreshProgress();
  setInterval(refreshWrong, 5000);
  setInterval(refreshProgress, 5000);
  window.addEventListener('focus', refreshWrong);
  window.addEventListener('focus', refreshProgress);
}
