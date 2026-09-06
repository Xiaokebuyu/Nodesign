#!/usr/bin/env python3
"""rembg-service — long-running FastAPI service over Unix socket.

server/index.js spawn 这个进程在自己启动时；自己 shutdown 时 SIGTERM 它。
所有 onnxruntime session 在内存里 warm 缓存，避免 per-call cold spawn 税
（每次省 ~20-40s）。

启动顺序（2026-05-11 重构）：
  1. bind Unix socket（立刻 ready，~1s）
  2. uvicorn startup event 起后台 _preload(models) task 异步预热
  3. /remove 请求路径：未预热则同步 load（per-model asyncio.Lock 防并发重 load）
  避免老版"先 preload → 再 bind socket"路径在 birefnet+CoreML 卡死时
  socket 永不创建的死锁。

Endpoints:
  GET  /health
    返回 {"ok": true, "loaded_models": [...], "preload_done": bool}（也用作 isAvailable 探活）

  POST /remove
    Headers:
      X-Model: <rembg model name>             default 'isnet-general-use'（安全档）
      X-Alpha-Matting: 0|1                    default 0
    Body: raw image bytes (PNG/JPEG/WEBP/...)
    Returns: RGBA PNG bytes (200) or JSON error (4xx/5xx)

Env:
  NODESIGN_REMBG_SOCKET         Unix socket path (default /tmp/nodesign-rembg.sock)
  NODESIGN_REMBG_PRELOAD        逗号分隔的 model 列表，启动时异步预加载
                                例：'isnet-general-use,birefnet-general-lite'
  NODESIGN_REMBG_PROVIDERS      逗号分隔 onnxruntime providers 覆盖默认。
                                未设时：darwin 默认 'CPUExecutionProvider' 单一
                                项绕过 CoreML+birefnet 卡死 bug（onnxruntime
                                1.19.2 验证），其它平台传 None 让 ort 自选
                                （Linux CUDA EP / Windows DML 等）。
  NODESIGN_REMBG_AM_MAX_DIM     alpha matting 的分辨率上限（长边 px，默认 1024）。
                                见下方 _remove_with_am_cap 的长注释。0 = 不限制。
"""
import asyncio
import atexit
import ctypes
import ctypes.util
import gc
import io
import os
import sys
import warnings

# urllib3 v2 + LibreSSL（Apple python）只是警告，silence 防污染 stderr
warnings.filterwarnings('ignore')

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from PIL import Image
import onnxruntime as ort
from rembg import remove, new_session


def _make_malloc_trim():
    """glibc 的 malloc_trim(0)：把 free 出来但还挂在堆上的内存还给内核。

    只对 glibc 有效（这台是 Debian，有）。musl / macOS 拿不到符号就返回一个空
    函数，调用处不用关心平台差异。
    """
    try:
        libc = ctypes.CDLL(ctypes.util.find_library('c'), use_errno=True)
        trim = libc.malloc_trim
        trim.argtypes = [ctypes.c_size_t]
        trim.restype = ctypes.c_int
        return lambda: trim(0)
    except Exception:
        return lambda: None


_malloc_trim = _make_malloc_trim()


def _resolve_providers():
    """决定传给 rembg new_session 的 providers 列表。

    darwin（Apple Silicon Mac）必须排除 CoreMLExecutionProvider：
    onnxruntime 1.19.2 在 birefnet-general-lite 上 CoreML graph compile
    卡死（>110s 未返回；CPU-only providers 2.5s 完成）。

    Linux / Windows 走 None = ort 自选，保留 CUDA EP / DML 等加速。
    Env NODESIGN_REMBG_PROVIDERS 覆盖一切（escape hatch + ort 升级后复测用）。

    将来 onnxruntime 升级时重测：
      .venv-rembg/bin/python3 -c "from rembg import new_session; \\
        import time; t=time.time(); new_session('birefnet-general-lite'); \\
        print(time.time()-t)"
    < 30s 返回即可考虑放开 darwin 默认。
    """
    env = os.environ.get('NODESIGN_REMBG_PROVIDERS', '').strip()
    if env:
        return [p.strip() for p in env.split(',') if p.strip()]
    if sys.platform == 'darwin':
        return ['CPUExecutionProvider']
    return None  # ort 自选


PROVIDERS = _resolve_providers()

app = FastAPI()

# 模型 session 缓存：model name → onnxruntime session
sessions = {}
# per-model asyncio.Lock 防并发同一 model 重复 new_session（preload + 第一个
# /remove 撞车场景）。dict 默认 lazy 建 Lock。
_session_locks: dict = {}
# preload 任务完成与否（仅 /health 报告用）
_preload_done = False


def _get_lock(model_name: str) -> asyncio.Lock:
    if model_name not in _session_locks:
        _session_locks[model_name] = asyncio.Lock()
    return _session_locks[model_name]


def _mem_tuned_options():
    """省内存优先的 onnxruntime SessionOptions。

    起因：birefnet-general-lite 只有 214MB 权重，但一次 1.57MP 推理的峰值 RSS
    到 2.4GB，在 3.9G 无 swap 的机器上直接被 OOM killer 杀掉（2026-07-29 两次、
    07-31 复现一次，dmesg 有记录）。杀的是这个常驻进程，连带 fast 档一起死，
    所以整档被 env 禁掉了。

    钱花在哪：ort 默认开 CPU arena 分配器，它按需成倍扩张且**不还给系统**，
    对 birefnet 这种 transformer backbone（大量临时激活）峰值会翻好几倍。
      enable_cpu_mem_arena=False  —— 用完即还，峰值大幅下降，代价是分配器调用
                                     多一点（单核上这点开销远小于被 OOM 杀掉）
      enable_mem_pattern=False    —— 内存复用模式表本身也要预分配一大块
      intra/inter_op=1            —— 这台机器就 1 核，多线程只是每条线程再占一份
                                     临时缓冲，一点也不快

    isnet 那档本来就只占 997MB，加上这些也不会变慢到哪去，统一走同一份配置。
    """
    opts = ort.SessionOptions()
    opts.enable_cpu_mem_arena = False
    opts.enable_mem_pattern = False
    opts.intra_op_num_threads = int(os.environ.get('NODESIGN_REMBG_THREADS', '1'))
    opts.inter_op_num_threads = 1
    return opts


def _load_session_sync(model_name: str):
    """同步 load——锁内调用。onnxruntime new_session 是阻塞 CPU 工作，
    用 asyncio.to_thread 在外层包裹。"""
    if model_name not in sessions:
        sessions[model_name] = new_session(
            model_name, providers=PROVIDERS, sess_opts=_mem_tuned_options(),
        )
    return sessions[model_name]


async def ensure_session(model_name: str):
    """异步获取 session：已 load 直接返；未 load 锁内同步 load 然后返。"""
    if model_name in sessions:
        return sessions[model_name]
    async with _get_lock(model_name):
        # double-check：另一 task 可能已经 load 完
        if model_name in sessions:
            return sessions[model_name]
        return await asyncio.to_thread(_load_session_sync, model_name)


async def _preload(models):
    """启动后台预热——串行 load 防同时撑爆内存。失败单 model 不影响整体。"""
    global _preload_done
    for m in models:
        print(f'[rembg-service] preloading {m}...', file=sys.stderr, flush=True)
        try:
            await ensure_session(m)
            print(f'[rembg-service]   ✓ {m} ready', file=sys.stderr, flush=True)
        except Exception as e:
            print(f'[rembg-service]   ✗ {m} failed: {type(e).__name__}: {e}',
                  file=sys.stderr, flush=True)
    _preload_done = True
    print(f'[rembg-service] preload done, loaded={sorted(sessions.keys())}',
          file=sys.stderr, flush=True)


@app.on_event('startup')
async def _on_startup():
    preload = os.environ.get('NODESIGN_REMBG_PRELOAD', '').strip()
    if not preload:
        return
    models = [s.strip() for s in preload.split(',') if s.strip()]
    if models:
        asyncio.create_task(_preload(models))


# 在途请求数。launcher 的 RSS 看门狗只在这个数为 0 时才敢回收本进程，
# 否则会把用户正在等的那次抠图打断。
_inflight = 0


def _self_rss_mb():
    """本进程 RSS（MB）。读 /proc 而不是引 psutil：少一个依赖，Linux 上够用。"""
    try:
        with open('/proc/self/status') as f:
            for line in f:
                if line.startswith('VmRSS:'):
                    return round(int(line.split()[1]) / 1024)
    except OSError:
        pass
    return None


@app.get('/health')
def health():
    return {
        'ok': True,
        'loaded_models': sorted(sessions.keys()),
        'preload_done': _preload_done,
        # 下面两个给 launcher 的看门狗用（见 rembg-launcher.js）
        'inflight': _inflight,
        'rss_mb': _self_rss_mb(),
    }


AM_MAX_DIM = int(os.environ.get('NODESIGN_REMBG_AM_MAX_DIM', '1024'))


def _remove_with_am_cap(image_bytes, session, alpha_matting):
    """抠图。开 alpha matting 时把 AM 那一步限制在 AM_MAX_DIM 之内。

    alpha matting 走 pymatting，它对 W×H 的图建一个 (W·H)×(W·H) 的稀疏拉普拉斯
    矩阵再解方程组，内存和时间都随**像素数**走。这里的生图动辄 1.6MP 到 6.5MP，
    不限制的话解算既慢又吃内存，原来 "fast 加 AM" 试过一次没通就是卡在这。

    限制之后：AM 在 ≤1024 长边上算（≤1MP），算出来的 alpha 再 LANCZOS 放大回原
    尺寸，跟**原分辨率的 RGB** 合成。输出仍是全分辨率，只有边缘的柔和过渡是在低
    分辨率上解出来再插值的。代价是边缘比全分辨率 AM 略"雾"一点；收益是这一档在
    这台机器上第一次变得可用。

    ⚠️ 这个上限**不是** birefnet 档 OOM 的解药，别把两件事记混。2026-07-31 实测：
    birefnet-general-lite 在 alpha_matting=0 的情况下，一张 1.57MP 的图峰值 RSS
    就到 2435MB，照样被 OOM killer 杀掉（可用内存 2234MB）。撑爆的是模型推理本身，
    跟 AM 无关。ort 的 arena/mem_pattern 调优只把 fast 从 997MB 压到 892MB，对
    birefnet 那 2.4GB 基本没动。birefnet 档要能用，得先给这台机器加 swap。

    不开 AM 时原样走 rembg，一个像素都不动。
    """
    if not alpha_matting:
        return remove(image_bytes, session=session, alpha_matting=False)

    src = Image.open(io.BytesIO(image_bytes))
    src.load()
    w, h = src.size
    long_edge = max(w, h)

    if AM_MAX_DIM <= 0 or long_edge <= AM_MAX_DIM:
        return remove(image_bytes, session=session, alpha_matting=True)

    scale = AM_MAX_DIM / long_edge
    small = src.convert('RGB').resize(
        (max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS,
    )
    buf = io.BytesIO()
    small.save(buf, format='PNG')
    cut_small = remove(buf.getvalue(), session=session, alpha_matting=True)

    alpha = Image.open(io.BytesIO(cut_small)).convert('RGBA').getchannel('A')
    alpha = alpha.resize((w, h), Image.LANCZOS)

    out = src.convert('RGB')
    out.putalpha(alpha)
    result = io.BytesIO()
    out.save(result, format='PNG')
    return result.getvalue()


@app.post('/remove')
async def remove_endpoint(request: Request):
    global _inflight
    # 缺省换成 isnet（2026-08-02）：原来的 birefnet-general-lite 是个陷阱 ——
    # 不带 X-Model 的直连调用会加载 2.4GB 峰值的模型，在这台机器上直接 OOM
    # 连坐整个 service（当天真踩过）。工具层永远显式传 model，缺省只服务于
    # 手工调试，就该是安全档。
    model = request.headers.get('x-model', 'isnet-general-use')
    alpha_matting = request.headers.get('x-alpha-matting', '0') == '1'
    image_bytes = await request.body()
    if not image_bytes:
        raise HTTPException(400, detail='empty body')
    _inflight += 1
    try:
        session = await ensure_session(model)
        # rembg remove 是 CPU 密集——丢线程池防阻塞 event loop
        rgba = await asyncio.to_thread(
            _remove_with_am_cap, image_bytes, session, alpha_matting,
        )
        return Response(content=rgba, media_type='image/png')
    except Exception as e:
        print(f'[rembg-service] /remove error: {type(e).__name__}: {e}',
              file=sys.stderr, flush=True)
        raise HTTPException(500, detail=f'{type(e).__name__}: {e}')
    finally:
        _inflight -= 1
        # 主动还内存：pymatting 的稀疏矩阵和 PIL 的全分辨率图都是大块 numpy /
        # buffer，Python 的分配器不一定马上还给系统。gc 一次 + malloc_trim 把
        # 空闲堆顶还回去，能明显压低 RSS 高水位（2026-07-31 事故就是高水位不降
        # 一路把机器推进内存抖动）。拿不到 malloc_trim 的平台静默跳过。
        gc.collect()
        _malloc_trim()


def cleanup_socket(socket_path: str):
    """退出时删 socket file，方便下次启动重新 bind。"""
    try:
        if os.path.exists(socket_path):
            os.unlink(socket_path)
            print(f'[rembg-service] cleaned up {socket_path}', file=sys.stderr, flush=True)
    except OSError:
        pass


def main():
    import uvicorn
    providers_label = ','.join(PROVIDERS) if PROVIDERS else '<ort-default>'
    print(f'[rembg-service] providers={providers_label}', file=sys.stderr, flush=True)

    # Windows 没有 AF_UNIX：launcher 给了 NODESIGN_REMBG_PORT 就 bind 127.0.0.1 上的端口（只听环回）
    port = os.environ.get('NODESIGN_REMBG_PORT')
    if port:
        print(f'[rembg-service] listening on 127.0.0.1:{port}', file=sys.stderr, flush=True)
        # log_level=warning 静音 uvicorn access logs（每次请求一行很吵）
        uvicorn.run(app, host='127.0.0.1', port=int(port), log_level='warning', access_log=False)
        return

    socket_path = os.environ.get('NODESIGN_REMBG_SOCKET', '/tmp/nodesign-rembg.sock')
    # bind 前清掉旧 socket（上次没干净退出会留残骸；SIGKILL 不走 atexit）
    cleanup_socket(socket_path)
    atexit.register(cleanup_socket, socket_path)
    print(f'[rembg-service] listening on {socket_path}', file=sys.stderr, flush=True)
    uvicorn.run(app, uds=socket_path, log_level='warning', access_log=False)


if __name__ == '__main__':
    main()
