const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile, spawn } = require('child_process');
const express = require('express');
const { Server } = require('socket.io');
const chokidar = require('chokidar');
const simpleGit = require('simple-git');
const { glob } = require('glob');

const ROOT = __dirname;
const CFG = path.join(ROOT, 'config.json');
const DEVSTATE_PATHS = ['DEVSTATE.md', '.devstate/DEVSTATE.md', 'docs/DEVSTATE.md'];
const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/coverage/**'];
const TEXT = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.html', '.css', '.scss', '.json', '.md', '.yml', '.yaml', '.txt', '.java', '.cs', '.cpp', '.c', '.h', '.go', '.rs', '.php', '.rb', '.sql', '.sh', '.ps1', '.xml', '.toml', '.vue', '.svelte']);
const EMPTY = 'No data detected';
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const cache = new Map();
const watchers = new Map();
const events = new Map();
const timers = new Map();

const cfg = () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return { port: 5050, scanInterval: 60, projects: [] }; } };
const save = c => fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const id = p => Buffer.from(path.resolve(p).toLowerCase()).toString('base64url');
const project = p => ({ id: id(p.path), name: p.name || path.basename(path.resolve(p.path)), path: path.resolve(p.path) });
const projects = () => (cfg().projects || []).map(project).filter(p => isDir(p.path));
const read = (base, file) => { try { const target = path.join(base, file); return fs.statSync(target).size < 800000 ? fs.readFileSync(target, 'utf8') : ''; } catch { return ''; } };
const run = (cmd, args, cwd) => new Promise(resolve => execFile(cmd, args, { cwd, windowsHide: true, timeout: 4000 }, (error, out) => resolve(error ? '' : out.trim())));
const chooseFolder = () => new Promise((resolve, reject) => {
  if (process.platform !== 'win32') return reject(Error('Folder picker is only available on Windows.'));
  const result = path.join(ROOT, `.folder-picker-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', path.join(ROOT, 'folder-picker.ps1'), result], {
    cwd: ROOT, detached: true, windowsHide: true, stdio: 'ignore'
  });
  child.on('error', reject);
  child.unref();
  const started = Date.now();
  const poll = setInterval(() => {
    if (!fs.existsSync(result)) {
      if (Date.now() - started > 300000) { clearInterval(poll); reject(Error('Folder picker timed out.')); }
      return;
    }
    clearInterval(poll);
    const selected = fs.readFileSync(result, 'utf8').trim();
    fs.unlinkSync(result);
    resolve(selected);
  }, 200);
});
const clean = value => String(value || '').replace(/^[\s>*_-]+|[\s*_`]+$/g, '').trim();
const list = text => text.split(/\r?\n/).map(line => clean(line.replace(/^\s*(?:[-*+]|\d+[.)]|\[[ xX]\])\s*/, ''))).filter(line => line && !/^#{1,6}\s/.test(line) && !/^```/.test(line));
const sectionValue = text => clean(list(text)[0] || text.replace(/\r?\n/g, ' '));
const percent = value => { const match = String(value || '').match(/(?:^|:\s*|\b)(\d{1,3}(?:\.\d+)?)\s*%?(?:\b|$)/); return match ? Math.max(0, Math.min(100, Number(match[1]))) : null; };

function addEvent(p, type, file, detail = '') {
  const event = { time: new Date().toISOString(), type, file: file || '', detail, message: `${type}${file ? `: ${file}` : ''}` };
  const current = events.get(p.id) || [];
  current.unshift(event);
  events.set(p.id, current.slice(0, 100));
  io.emit('event', { projectId: p.id, event });
}

function findDevstate(base) {
  for (const relative of DEVSTATE_PATHS) {
    const target = path.join(base, relative);
    if (isFile(target)) return { relative, target, mtime: fs.statSync(target).mtime.toISOString() };
  }
  return null;
}

function splitSections(markdown) {
  const sections = {};
  let current = 'preamble';
  sections[current] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      current = heading[1].toLowerCase().replace(/[`*_]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
      sections[current] = sections[current] || [];
    } else sections[current].push(line);
  }
  return Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join('\n').trim()]));
}

function getSection(sections, ...names) {
  for (const name of names) {
    const exact = sections[name];
    if (exact !== undefined) return exact;
    const key = Object.keys(sections).find(k => k === name || k.startsWith(`${name} `));
    if (key) return sections[key];
  }
  return '';
}

function parseKeyValues(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s*)?\**([^:|]+?)\**\s*:\s*(.+?)\s*$/);
    if (match) result[clean(match[1]).toLowerCase()] = clean(match[2]);
  }
  return result;
}

function parseTable(text) {
  const rows = text.split(/\r?\n/).filter(line => /^\s*\|.*\|\s*$/.test(line) && !/^\s*\|[\s|:-]+\|\s*$/.test(line)).map(line => line.trim().slice(1, -1).split('|').map(clean));
  if (rows.length < 2) return [];
  const headers = rows[0].map(x => x.toLowerCase());
  return rows.slice(1).filter(row => row.some(Boolean) && !row.every(cell => !cell || /^:?-{3,}:?$/.test(cell))).map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
}

function labeledList(text, ...labels) {
  const lines = text.split(/\r?\n/);
  const wanted = labels.map(x => x.toLowerCase());
  const start = lines.findIndex(line => wanted.includes(clean(line).replace(/:$/, '').toLowerCase()));
  if (start < 0) return [];
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*[A-Za-z][A-Za-z ]+:\s*$/.test(line)) break;
    block.push(line);
  }
  return list(block.join('\n'));
}

function parseWorkflow(text) {
  const table = parseTable(text);
  if (table.length) return table.map(row => {
    const name = row.task || row.name || row.item || row.phase || row.step || Object.values(row)[0] || EMPTY;
    const rawState = row.status || row.state || row.phase || 'TODO';
    const state = String(rawState).toUpperCase().match(/DONE|ACTIVE|RISK|BLOCKED|TODO/)?.[0] || 'TODO';
    return { name, state, percent: percent(row.percent || row.progress || rawState) };
  });
  return list(text).map(item => {
    const state = item.toUpperCase().match(/\b(DONE|ACTIVE|RISK|BLOCKED|TODO)\b/)?.[1] || 'TODO';
    return { name: clean(item.replace(/\b(DONE|ACTIVE|RISK|BLOCKED|TODO)\b/ig, '').replace(/\d{1,3}%/g, '')), state, percent: percent(item) };
  });
}

function workflowAverage(workflow) {
  if (!workflow.length) return null;
  const defaults = { DONE: 100, ACTIVE: 50, RISK: 40, BLOCKED: 25, TODO: 0 };
  return Math.round(workflow.reduce((sum, item) => sum + (item.percent ?? defaults[item.state] ?? 0), 0) / workflow.length);
}

function parseValidation(text) {
  const values = parseKeyValues(text);
  const rows = Object.entries(values).map(([name, status]) => ({ name, status }));
  return rows.length ? rows : list(text).map(item => ({ name: item, status: item.match(/\b(pass(?:ed)?|fail(?:ed)?|pending|unknown|blocked|healthy|error)\b/i)?.[0] || EMPTY }));
}

function parseDevstate(markdown, source) {
  try {
    const data = JSON.parse(markdown);
    const completed = (data.completed_phases || []).map(x => x.description || `Phase ${x.phase}`);
    const blockers = (data.current_blockers || []).map(x => x.description || x.id).filter(Boolean);
    const validation = Object.entries(data.validation || {}).map(([name, value]) => ({ name, status: typeof value === 'object' ? value.status || EMPTY : value }));
    const files = data.files_changed || [];
    return {
      source: 'DEVSTATE.md JSON LIVE', sourcePath: source.relative, sourceUpdatedAt: source.mtime, meta: data,
      target: data.project || EMPTY, phase: `Phase ${data.current_phase || data.current_task || EMPTY}`,
      overallPercent: Number(data.overall_completion_pct) || null, workflowPercent: null,
      workflow: [...completed.slice(-5).map(name => ({ name, state: 'DONE', percent: 100 })), { name: `Phase ${data.current_task || data.current_phase || EMPTY}`, state: blockers.length ? 'BLOCKED' : 'ACTIVE', percent: null }],
      done: completed, active: [`Phase ${data.current_task || data.current_phase || EMPTY}`], next: [],
      blockers, architecture: data.project || EMPTY, modules: [], keyFiles: files,
      recentChanges: files, risks: [], validation,
      nextCommand: (data.current_blockers || [])[0]?.resolution || EMPTY
    };
  } catch {}
  const sections = splitSections(markdown);
  const meta = parseKeyValues(getSection(sections, 'meta'));
  const progressText = getSection(sections, 'progress');
  const progress = parseKeyValues(progressText);
  const workflow = parseWorkflow(getSection(sections, 'workflow', 'workflow table'));
  const architectureText = getSection(sections, 'architecture', 'architecture summary');
  const architectureValues = parseKeyValues(architectureText);
  const architecture = sectionValue(architectureText) || EMPTY;
  const modules = Object.keys(architectureValues).length ? Object.keys(architectureValues).map(x => x.replace(/\b\w/g, c => c.toUpperCase())).slice(0, 8) : list(architectureText).slice(0, 8);
  const validation = parseValidation(getSection(sections, 'validation', 'validation status'));
  const overallPercent = percent(meta['overall percent'] || progress['overall percent'] || progress.overall || progressText);
  const done = list(getSection(sections, 'done tasks', 'completed tasks', 'done')).concat(labeledList(progressText, 'done', 'done tasks', 'completed'));
  const active = list(getSection(sections, 'active tasks', 'current tasks', 'active')).concat(labeledList(progressText, 'active', 'active tasks'));
  const next = list(getSection(sections, 'next tasks', 'next')).concat(labeledList(progressText, 'next', 'next tasks'));
  const blockers = list(getSection(sections, 'blockers', 'blocked')).concat(labeledList(progressText, 'blocked', 'blockers'));
  const risks = list(getSection(sections, 'risks'));
  const targetText = getSection(sections, 'project target', 'target');
  const phaseText = getSection(sections, 'current phase', 'phase');
  const targetValues = parseKeyValues(targetText);
  const phaseValues = parseKeyValues(phaseText);
  const keyFilesText = getSection(sections, 'key files');
  const keyFilesTable = parseTable(keyFilesText);
  const commandLines = getSection(sections, 'next command', 'recommended next command').split(/\r?\n/).map(clean).filter(x => x && !/^```/.test(x) && !/^#/.test(x) && !/^recommended next.*command:?$/i.test(x) && !/^maintenance instruction:/i.test(x));
  return {
    source: 'DEVSTATE.md LIVE',
    sourcePath: source.relative,
    sourceUpdatedAt: source.mtime,
    meta,
    target: targetValues['one-sentence project goal'] || targetValues['project goal'] || sectionValue(targetText) || meta.target || EMPTY,
    phase: phaseValues['phase name'] || phaseValues.phase || sectionValue(phaseText) || meta.phase || EMPTY,
    overallPercent,
    workflowPercent: workflowAverage(workflow),
    workflow,
    done: done.length ? done : workflow.filter(x => x.state === 'DONE').map(x => x.name),
    active: active.length ? active : workflow.filter(x => x.state === 'ACTIVE').map(x => x.name),
    next,
    blockers,
    architecture,
    modules,
    keyFiles: keyFilesTable.length ? keyFilesTable.map(row => `${row.file || row.path || Object.values(row)[0]} — ${row.purpose || row.status || ''}`) : list(keyFilesText),
    recentChanges: list(getSection(sections, 'recent changes')),
    risks,
    validation,
    nextCommand: commandLines[0] || EMPTY
  };
}

async function processes(p) {
  const cmd = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object {$_.Name -match 'node|npm|python|docker|git'} | Select-Object Name,ProcessId,CommandLine | ConvertTo-Json -Compress"]]
    : ['ps', ['-eo', 'pid,comm,args']];
  const out = await run(cmd[0], cmd[1], p.path);
  if (!out) return [];
  try {
    const rows = JSON.parse(out);
    return (Array.isArray(rows) ? rows : [rows]).filter(x => (x.CommandLine || '').toLowerCase().includes(p.path.toLowerCase())).slice(0, 8).map(x => ({ name: x.Name, pid: x.ProcessId, command: x.CommandLine }));
  } catch { return out.split('\n').filter(x => x.includes(p.path)).slice(0, 8).map(x => ({ name: x.trim() })); }
}

function infer(base, files, text, packageData) {
  const dirs = [...new Set(files.filter(f => f.includes(path.sep) || f.includes('/')).map(f => f.split(/[\\/]/)[0]))].filter(x => !x.startsWith('.')).slice(0, 8);
  const heads = [...text.matchAll(/^#{1,3}\s+(.+)$/gm)].map(x => clean(x[1])).filter(x => x.length < 55);
  const target = (read(base, 'README.md').split(/\r?\n/).find(x => x.trim() && !x.startsWith('#') && !x.startsWith('!') && !x.startsWith('[')) || EMPTY).slice(0, 220);
  const langs = { '.js': 'JavaScript', '.ts': 'TypeScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.cs': 'C#', '.php': 'PHP', '.rb': 'Ruby', '.vue': 'Vue', '.svelte': 'Svelte' };
  const language = [...new Set(files.map(f => langs[path.extname(f).toLowerCase()]).filter(Boolean))].slice(0, 4);
  const frameworks = []; const deps = { ...(packageData.dependencies || {}), ...(packageData.devDependencies || {}) };
  ['react', 'next', 'vue', 'svelte', 'express', 'vite', 'electron', 'nestjs'].forEach(x => deps[x] && frameworks.push(x));
  const done = heads.filter(x => /done|complete|shipped|released/i.test(x)).slice(0, 4);
  const next = heads.filter(x => /next|todo|roadmap|plan|objective|milestone/i.test(x)).slice(0, 5);
  const risks = heads.filter(x => /risk|block|issue|limitation|problem/i.test(x)).slice(0, 4);
  const workflow = (dirs.length ? dirs : heads.slice(0, 7)).map((name, index, all) => ({ name, state: index < all.length - 1 ? 'DONE' : next.length ? 'ACTIVE' : 'TODO', percent: null }));
  return { source: 'Repo Scan Fallback', sourcePath: '', sourceUpdatedAt: null, meta: {}, target, phase: next[0] || heads.find(x => /phase|status|progress/i.test(x)) || EMPTY, overallPercent: null, workflowPercent: workflowAverage(workflow), workflow, done, active: workflow.filter(x => x.state === 'ACTIVE').map(x => x.name), next, blockers: [], architecture: dirs.join(', ') || EMPTY, modules: dirs, keyFiles: [], recentChanges: [], risks, validation: [], nextCommand: EMPTY, language, frameworks };
}

async function analyze(p) {
  const start = Date.now();
  const files = await glob('**/*', { cwd: p.path, nodir: true, dot: true, ignore: IGNORE });
  let lines = 0, code = 0, docs = 0, markers = [], folders = {};
  let pkg = {}; try { pkg = JSON.parse(read(p.path, 'package.json') || '{}'); } catch {}
  const docNames = ['README.md', 'ROADMAP.md', 'PLAN.md', 'TODO.md', 'CHANGELOG.md'];
  let intelText = docNames.map(f => read(p.path, f)).join('\n');
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    folders[file.split(/[\\/]/)[0]] = (folders[file.split(/[\\/]/)[0]] || 0) + 1;
    if (ext === '.md') docs++;
    if (!TEXT.has(ext)) continue;
    code++;
    const text = read(p.path, file);
    lines += text ? text.split(/\r?\n/).length : 0;
    if (/^(docs|spec|design|architecture|\.github)[\\/]/i.test(file)) intelText += `\n${text}`;
    for (const [index, line] of text.split(/\r?\n/).entries()) if (/\b(TODO|FIXME|NOTE)\b/i.test(line) && markers.length < 80) markers.push({ file, line: index + 1, text: line.trim().slice(0, 150), type: (line.match(/\b(TODO|FIXME|NOTE)\b/i) || ['NOTE'])[0].toUpperCase() });
  }
  let git = { branch: EMPTY, clean: null, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, commits: [], head: '' };
  if (isDir(path.join(p.path, '.git'))) try {
    const g = simpleGit(p.path), status = await g.status(), log = await g.log({ maxCount: 7 });
    git = { branch: status.current || EMPTY, clean: status.isClean(), ahead: status.ahead || 0, behind: status.behind || 0, staged: status.staged.length, unstaged: status.modified.length + status.deleted.length, untracked: status.not_added.length, commits: log.all.map(c => ({ hash: c.hash.slice(0, 7), message: c.message, date: c.date, author: c.author_name })), head: log.latest?.hash || '' };
  } catch {}
  const previousHead = cache.get(p.id)?.git?.head;
  if (previousHead && git.head && previousHead !== git.head) addEvent(p, 'git commit detected', git.commits[0]?.hash || '');
  const tests = files.filter(f => /(test|spec)\.(js|ts|jsx|tsx|py|go|rs)$/i.test(f) || /(^|[\\/])(test|tests|spec)([\\/]|$)/i.test(f)).length;
  const docSet = docNames.filter(f => files.some(x => x.toLowerCase() === f.toLowerCase()));
  const density = markers.length / Math.max(lines, 1) * 1000;
  let heuristicScore = 35 + (git.clean ? 15 : 0) + Math.min(20, docSet.length * 4) + (tests ? 15 : 0) + (Object.keys(pkg).length ? 10 : 0) - Math.min(25, Math.round(density * 3));
  heuristicScore = Math.max(0, Math.min(100, heuristicScore));
  const source = findDevstate(p.path);
  const status = source ? parseDevstate(read(p.path, source.relative), source) : infer(p.path, files, intelText, pkg);
  const overallPercent = status.overallPercent ?? status.workflowPercent ?? heuristicScore;
  const validationEvents = status.validation.filter(x => /fail|error|blocked/i.test(x.status));
  return {
    project: p, ts: new Date().toISOString(), ms: Date.now() - start, status, overallPercent,
    metrics: { files: files.length, code, docs, lines, markers: markers.length },
    markers, markerCounts: { TODO: markers.filter(x => x.type === 'TODO').length, FIXME: markers.filter(x => x.type === 'FIXME').length, NOTE: markers.filter(x => x.type === 'NOTE').length },
    git, health: { score: heuristicScore, reasons: [`${docSet.length}/5 core documents`, `${tests} test files`, git.clean ? 'clean git tree' : `${git.staged + git.unstaged + git.untracked} pending git changes`, `${density.toFixed(1)} markers / 1k lines`] },
    docs: { present: docSet, missing: docNames.filter(x => !docSet.includes(x)) },
    heatmap: Object.entries(folders).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([name, count]) => ({ name, count })),
    processes: await processes(p), events: events.get(p.id) || [], scanInterval: 60, validationErrors: validationEvents
  };
}

async function rescan(p) {
  const state = await analyze(p);
  cache.set(p.id, state);
  io.emit('state', state);
  return state;
}
function schedule(p, delay = 350) {
  clearTimeout(timers.get(p.id));
  timers.set(p.id, setTimeout(() => rescan(p).catch(() => {}), delay));
}
function watches() {
  for (const watcher of watchers.values()) watcher.close();
  watchers.clear();
  for (const p of projects()) {
    const watcher = chokidar.watch(p.path, { ignored: IGNORE, ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
    watcher.on('all', (kind, file) => {
      const relative = path.relative(p.path, file).replace(/\\/g, '/');
      const isDevstate = DEVSTATE_PATHS.some(candidate => candidate.toLowerCase() === relative.toLowerCase());
      const type = isDevstate ? 'DEVSTATE.md changed' : kind === 'add' ? 'repo file added' : kind === 'unlink' ? 'repo file deleted' : 'repo file changed';
      addEvent(p, type, relative);
      schedule(p, isDevstate ? 20 : 350);
    });
    watchers.set(p.id, watcher);
    schedule(p, 20);
  }
}

app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.get('/api/projects', (req, res) => res.json(projects()));
app.post('/api/choose-folder', async (req, res) => {
  try {
    const selected = await chooseFolder();
    res.json({ path: selected || null });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/projects', (req, res) => {
  try {
    const repoPath = path.resolve(req.body.path || '');
    if (!isDir(repoPath)) throw Error('Path does not exist or is not a directory.');
    const config = cfg(); config.projects = config.projects || [];
    if (!config.projects.some(x => id(x.path) === id(repoPath))) config.projects.push({ path: repoPath, name: req.body.name || path.basename(repoPath) });
    save(config); watches(); res.json(project({ path: repoPath, name: req.body.name }));
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/projects/:id', (req, res) => {
  const config = cfg(); config.projects = (config.projects || []).filter(x => id(x.path) !== req.params.id);
  save(config); cache.delete(req.params.id); watches(); res.json({ ok: true });
});
app.get('/api/projects/:id/state', (req, res) => res.json(cache.get(req.params.id) || null));
app.post('/api/projects/:id/rescan', async (req, res) => {
  const p = projects().find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found' });
  res.json(await rescan(p));
});
let shutdownTimer;
function scheduleShutdown(delay = 15000) {
  clearTimeout(shutdownTimer);
  shutdownTimer = setTimeout(async () => {
    if (io.engine.clientsCount) return;
    for (const watcher of watchers.values()) await watcher.close();
    server.close(() => process.exit(0));
  }, delay);
}
io.on('connection', socket => {
  clearTimeout(shutdownTimer);
  socket.emit('projects', projects());
  for (const state of cache.values()) socket.emit('state', state);
  socket.on('disconnect', () => scheduleShutdown());
});
watches();
setInterval(() => projects().forEach(p => schedule(p, 20)), 60000);
const port = Number(process.env.PORT) || cfg().port || 5050;
server.listen(port, () => scheduleShutdown(45000));
