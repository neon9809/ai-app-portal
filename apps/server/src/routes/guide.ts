/**
 * 开发指南与平台文档（R2）：
 *  - GET /api/dev/guide   登录可见：应用开发规范（app-develop skill.md），供一键复制
 *    （skill.md 含沙箱模型/能力声明/审核流程等侦察材料，不再对匿名开放——P2-12）
 *  - GET /api/dev/docs    仅管理员：平台使用说明（README / 内部实现约定）
 * 文件查找顺序：包内 assets（Docker 镜像）→ 仓库 ai-app-portal-docs（开发态）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { requireAdmin, requireAuth } from '../lib/auth.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const guideRouter = Router();

interface DocFile {
  file: string;
  title: string;
}

const SKILL_FILE = 'app-develop.skill-v0.2.md';
const DOCS: DocFile[] = [
  { file: 'README.md', title: '平台使用说明（README）' },
  { file: 'app-develop-internal.skill.md', title: '平台实现与架构约定' },
];

/** 依次探测：Docker 镜像 assets → 仓库文档目录 */
function locate(file: string): string | null {
  const candidates = [
    path.join(PKG_ROOT, 'assets', file),
    path.resolve(PKG_ROOT, '../../ai-app-portal-docs', file),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* continue */
    }
  }
  return null;
}

function readDoc(file: string): string | null {
  const p = locate(file);
  if (!p) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

guideRouter.get('/dev/guide', requireAuth, (_req, res) => {
  const skillMd = readDoc(SKILL_FILE);
  if (!skillMd) {
    res.status(404).json({ error: { code: 'GUIDE_NOT_FOUND', message: '开发指南文件未随部署包提供' } });
    return;
  }
  res.json({ skillMd });
});

guideRouter.get('/dev/docs', requireAdmin, (_req, res) => {
  const docs = DOCS.map((d) => ({ title: d.title, file: d.file, content: readDoc(d.file) }))
    .filter((d) => d.content !== null);
  res.json({ docs });
});
