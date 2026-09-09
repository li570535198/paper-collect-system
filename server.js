// 学校论文收集系统 - 云端版后端
// Express + Multer + JSON文件存储

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== 目录配置 ==========
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'papers.json');
const PWD_FILE = path.join(DATA_DIR, 'password.json');

// 初始化目录与文件
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]', 'utf-8');
if (!fs.existsSync(PWD_FILE)) fs.writeFileSync(PWD_FILE, JSON.stringify({ password: 'admin123' }));

// ========== Multer 配置 ==========
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // 修复 Multer 的 Latin-1 编码问题：将 Latin-1 解码的文件名转回 UTF-8
    const raw = file.originalname;
    try {
      file.originalname = Buffer.from(raw, 'latin1').toString('utf-8');
    } catch (e) {
      file.originalname = raw;
    }
    const ext = path.extname(file.originalname) || '';
    const id = crypto.randomBytes(8).toString('hex');
    cb(null, id + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 } // 单文件 20MB
});

// ========== 数据读写 ==========
function readPapers() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); }
  catch (e) { return []; }
}
function writePapers(papers) {
  fs.writeFileSync(DB_FILE, JSON.stringify(papers, null, 2), 'utf-8');
}
function readPassword() {
  try { return JSON.parse(fs.readFileSync(PWD_FILE, 'utf-8')).password || 'admin123'; }
  catch (e) { return 'admin123'; }
}
function writePassword(pwd) {
  fs.writeFileSync(PWD_FILE, JSON.stringify({ password: pwd }), 'utf-8');
}

// ========== 中间件 ==========
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ========== API 路由 ==========

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// POST /api/login - 登录验证
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password === readPassword()) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, error: '密码错误' });
});

// PUT /api/password - 修改密码
app.put('/api/password', (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (oldPassword !== readPassword()) {
    return res.status(400).json({ success: false, error: '当前密码错误' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ success: false, error: '新密码至少4位' });
  }
  writePassword(newPassword);
  res.json({ success: true, message: '密码修改成功' });
});

// GET /api/papers - 获取论文列表（支持 ?submitter=xxx 筛选）
app.get('/api/papers', (req, res) => {
  let papers = readPapers().sort((a, b) => b.submitTime - a.submitTime);
  if (req.query.submitter) {
    papers = papers.filter(p => p.submitter === req.query.submitter);
  }
  res.json(papers);
});

// POST /api/papers - 提交新论文（multipart，支持多文件）
app.post('/api/papers', upload.array('files', 10), (req, res) => {
  const fields = req.body;
  const files = req.files || [];

  if (!fields.submitter || !fields.submitter.trim()) {
    return res.status(400).json({ success: false, error: '请填写提交人' });
  }
  if (!fields.department || !fields.department.trim()) {
    return res.status(400).json({ success: false, error: '请选择所属学院' });
  }
  if (!fields.title || !fields.title.trim()) {
    return res.status(400).json({ success: false, error: '请填写论文标题' });
  }
  if (files.length === 0) {
    return res.status(400).json({ success: false, error: '请上传论文附件' });
  }

  // 解析作者列表
  let authors = [];
  try { authors = JSON.parse(fields.authors || '[]'); } catch (e) { authors = []; }
  if (authors.length === 0) authors.push(fields.submitter.trim());

  const fileInfos = files.map(f => ({
    fileName: f.originalname,
    fileSize: f.size,
    filePath: f.filename  // Multer 保存后的磁盘文件名
  }));

  const papers = readPapers();
  const id = crypto.randomBytes(8).toString('hex');
  const paper = {
    id,
    submitter: fields.submitter.trim(),
    department: fields.department.trim(),
    phone: (fields.phone || '').trim(),
    title: fields.title.trim(),
    authors,
    note: (fields.note || '').trim(),
    files: fileInfos,
    submitTime: Date.now(),
    status: 'pending',
    remark: ''
  };
  papers.push(paper);
  writePapers(papers);

  res.json({ success: true, id, message: '提交成功' });
});

// GET /api/papers/:id/file/:index - 下载指定论文的指定附件
app.get('/api/papers/:id/file/:index', (req, res) => {
  const papers = readPapers();
  const paper = papers.find(p => p.id === req.params.id);
  if (!paper) return res.status(404).send('论文不存在');

  const idx = parseInt(req.params.index, 10);
  const file = (paper.files && paper.files[idx]) || null;
  if (!file) return res.status(404).send('文件不存在');

  const fp = path.join(UPLOAD_DIR, file.filePath);
  if (!fs.existsSync(fp)) return res.status(404).send('文件已丢失');

  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
  res.sendFile(fp);
});

// PUT /api/papers/:id - 更新论文（审核状态等）
app.put('/api/papers/:id', (req, res) => {
  const papers = readPapers();
  const idx = papers.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '论文不存在' });

  // 只允许更新特定字段
  const allowed = ['status', 'remark'];
  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  papers[idx] = { ...papers[idx], ...update };
  writePapers(papers);
  res.json({ success: true });
});

// DELETE /api/papers/:id - 删除论文及关联文件
app.delete('/api/papers/:id', (req, res) => {
  const papers = readPapers();
  const idx = papers.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '论文不存在' });

  const paper = papers[idx];
  // 删除关联文件
  if (paper.files && paper.files.length) {
    for (const f of paper.files) {
      if (f.filePath) {
        const fp = path.join(UPLOAD_DIR, f.filePath);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (e) {}
      }
    }
  }
  papers.splice(idx, 1);
  writePapers(papers);
  res.json({ success: true });
});

// GET /api/stats - 统计数据
app.get('/api/stats', (req, res) => {
  const papers = readPapers();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();
  const weekAgo = todayStart - 7 * 24 * 60 * 60 * 1000;

  const stats = {
    total: papers.length,
    todayCount: papers.filter(p => p.submitTime >= todayStart).length,
    weekCount: papers.filter(p => p.submitTime >= weekAgo).length,
    byDepartment: {},
    byStatus: { pending: 0, approved: 0, rejected: 0, excellent: 0 },
    byDay: {}
  };

  for (const p of papers) {
    const dept = p.department || '未分类';
    stats.byDepartment[dept] = (stats.byDepartment[dept] || 0) + 1;
    const status = p.status || 'pending';
    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    const day = new Date(p.submitTime).toISOString().slice(0, 10);
    stats.byDay[day] = (stats.byDay[day] || 0) + 1;
  }

  res.json(stats);
});

// ========== 页面路由（美观 URL）==========
app.get('/submit', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'submit.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/qrcode', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'qrcode.html')));

// ========== 启动 ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('  学校论文收集系统 - 云端版');
  console.log('========================================');
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`  上传目录: ${UPLOAD_DIR}`);
  console.log('========================================');
});
