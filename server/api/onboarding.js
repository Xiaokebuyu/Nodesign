/**
 * 新手引导的服务端入口（2026-09-12）。
 *
 * 只有一件事：给还没有项目的人铺一份示例项目（onboarding/seed.js 里是幂等的）。
 * 由首页在「拿到项目列表、发现是空的」之后调一次 —— 判断放在服务端，前端只管问，
 * 这样网页版和桌面版走同一条路，刷新几次也只会铺一份。
 */
import { Router } from 'express';
import { ensureSampleProject, sampleState } from '../onboarding/seed.js';

const router = Router();

router.get('/sample', (req, res) => {
  res.json(sampleState(req.user?.id ?? null));
});

router.post('/sample', async (req, res, next) => {
  try {
    res.json(await ensureSampleProject(req.user?.id ?? null));
  } catch (err) { next(err); }
});

export default router;
