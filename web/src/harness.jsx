/**
 * 渲染检查台 —— 不进构建、不进生产（vite build 只打包 index.html）。
 *
 * 存在的理由：这台机器上的浏览器扩展连不上，而画布这些组件的毛病**只有真跑
 * 看得见**（TDZ 白屏、层级错位、工具栏落点）。8443 有登录墙，用 playwright 去
 * 撞登录墙意味着要处理密码 —— 那条路不走。
 *
 * 所以退一步：把组件单独挂起来，喂假数据，用服务端本来就装着的 chromium 截图。
 * 看的是**外壳与布局**（窗框 / 顶栏 / 工具栏落点），不是内容 —— iframe 会因为
 * 没有后端而空着，那正常。
 *
 * 跑法见 scripts/shoot-harness.mjs。
 */
import { useEffect, useState, useRef } from 'react';
import { PAPER } from './lib/paper.js';
import { createRoot } from 'react-dom/client';
import { PanelManagerProvider } from './components/layout/PanelManager.jsx';
import SiteWindow from './components/canvas/SiteWindow.jsx';
import ArtifactWindow from './components/canvas/ArtifactWindow.jsx';
import FloatingToolbar from './components/ui/FloatingToolbar.jsx';

/**
 * 迟到的工具组：站点窗的「上线」控件要先请求发布状态，loaded 之前整个返回
 * null。锚点如果只在挂载时算一次，就是按**缺一组**的宽度算的 left，控件到货
 * 之后工具栏往右长出去 —— 表现就是"工具栏偏到右下角"。
 */
function LateGroup() {
  const [ready, setReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setReady(true), 400); return () => clearTimeout(t); }, []);
  if (!ready) return null;
  return <span style={{ padding: '3px 9px', fontSize: 12 }}>https://demo.share.example.com ⟳ ⊘</span>;
}

const CASES = {
  site: (onToolbarGroups) => (
    <SiteWindow
      projectId="p_demo"
      task="伊蕾娜手账研究站"
      base="伊蕾娜手账研究站"
      entry="index.html"
      title="伊蕾娜手账研究站"
      pages={['index.html', 'about.html', 'posts/first.html']}
      fileVersions={{}}
      artifactExports={['site', 'html', 'handoff']}
      onExport={() => {}}
      onToolbarGroups={onToolbarGroups}
      onClose={() => {}}
    />
  ),
};

CASES.late = (onToolbarGroups) => (
  <ArtifactWindow
    kind="latecase"
    title="迟到组时序"
    subtitle="index.html"
    groups={[
      { id: 'mode', type: 'mode', value: 'a', onChange: () => {}, items: [
        { id: 'a', label: '预览' }, { id: 'b', label: '源码' },
      ] },
      { id: 'late', node: <LateGroup /> },
    ]}
    onToolbarGroups={onToolbarGroups}
    onClose={() => {}}
  >
    <div style={{ flex: 1, background: '#f4f2ee' }} />
  </ArtifactWindow>
);

/**
 * 宿主：照 CanvasFrame 的新范式来 —— 窗只把工具组报上来，**工具栏只有一条**，
 * 钉底缘正中、永远显示、层级压过产物窗。检查台跟线上不同构的话，量出来的
 * 位置就没有意义。
 */
function Host({ children: render }) {
  const [winGroups, setWinGroups] = useState(null);
  const hostRef = useRef(null);
  return (
    <div ref={hostRef} style={{ position: 'relative', height: '100%', isolation: 'isolate', background: PAPER.wall }}>
      {render(setWinGroups)}
      <FloatingToolbar id="tools" boundsRef={hostRef} dock="bottom-center" stack="row" zIndex={510} groups={winGroups || []} />
    </div>
  );
}

const which = new URLSearchParams(location.search).get('case') || 'site';
createRoot(document.getElementById('root')).render(
  <PanelManagerProvider projectId="p_demo" defaultPanels={{}} panelMeta={{}}>
    <Host>{(onToolbarGroups) => (CASES[which] || CASES.site)(onToolbarGroups)}</Host>
  </PanelManagerProvider>,
);
