import { FONT_SANS, COLOR, GAP, FONT_SIZE } from "../../lib/theme.js";

const pulse = {
  animation: 'skeletonPulse 1.5s ease-in-out infinite',
};

const injectKeyframes = (() => {
  let injected = false;
  return () => {
    if (injected || typeof document === 'undefined') return;
    const style = document.createElement('style');
    style.textContent = `@keyframes skeletonPulse { 0%,100%{opacity:0.6} 50%{opacity:1} }`;
    document.head.appendChild(style);
    injected = true;
  };
})();

function Bar({ w = '100%', h = 16, r = 6, mb = 8 }) {
  injectKeyframes();
  return <div style={{ width: w, height: h, borderRadius: r, background: COLOR.bgSkBar, marginBottom: mb, ...pulse }} />;
}

/** 统计卡片骨架 */
function StatRow({ count = 4 }) {
  return (
    <div style={{ display: 'flex', gap: GAP.md, marginBottom: GAP.lg }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ flex: 1, padding: `14px ${GAP.lg}px`, borderRadius: GAP.base, background: COLOR.bgSkeleton, ...pulse }}>
          <Bar w="50%" h={FONT_SIZE.xs} mb={GAP.sm} />
          <Bar w="40%" h={22} mb={0} />
        </div>
      ))}
    </div>
  );
}

/** 图表区域骨架 */
function ChartSkeleton() {
  return (
    <div style={{ borderRadius: GAP.lg, background: COLOR.bgSkeleton, padding: GAP.xl, marginBottom: GAP.xl, ...pulse }}>
      <div style={{ display: 'flex', gap: GAP.base, marginBottom: GAP.xl }}>
        <Bar w={60} h={24} r={6} mb={0} />
        <Bar w={60} h={24} r={6} mb={0} />
        <Bar w={60} h={24} r={6} mb={0} />
      </div>
      <Bar w="100%" h={180} r={8} mb={0} />
    </div>
  );
}

/** DeskRow 骨架 */
function RowSkeleton() {
  return (
    <div style={{ borderRadius: 14, background: COLOR.bgSkeleton, padding: `${GAP.xl}px ${GAP.xxl}px`, marginBottom: GAP.lg, ...pulse }}>
      <Bar w={100} h={FONT_SIZE.lg} mb={GAP.base} />
      <div style={{ display: 'flex', gap: GAP.base }}>
        {[1, 2, 3, 4].map(i => <Bar key={i} w={126} h={140} r={12} mb={0} />)}
      </div>
    </div>
  );
}

/** Dashboard 完整骨架 */
export function DashboardSkeleton() {
  return (
    <>
      <StatRow count={3} />
      <StatRow count={4} />
      <ChartSkeleton />
      <RowSkeleton />
      <RowSkeleton />
    </>
  );
}

/** MCP 完整骨架 */
export function McpSkeleton() {
  return (
    <div style={{ padding: `0 0 ${GAP.page}px` }}>
      <StatRow count={4} />
      <ChartSkeleton />
      <RowSkeleton />
    </div>
  );
}

/** 错误 + 重试 */
export function ErrorRetry({ message, onRetry }) {
  return (
    <div style={{ textAlign: 'center', padding: `${GAP.page}px ${GAP.xxl}px` }}>
      <div style={{ fontFamily: FONT_SANS, fontSize: FONT_SIZE.lg, color: COLOR.error, marginBottom: GAP.lg }}>
        {message || '数据加载失败'}
      </div>
      <button onClick={onRetry} style={{
        fontFamily: FONT_SANS, fontSize: FONT_SIZE.base, padding: `${GAP.md}px ${GAP.xxl}px`,
        borderRadius: GAP.md, border: `1px solid ${COLOR.borderHv}`,
        background: COLOR.bgWhite, color: COLOR.text, cursor: 'pointer',
        transition: 'background 0.15s',
      }}
        onMouseEnter={e => e.currentTarget.style.background = COLOR.borderLt}
        onMouseLeave={e => e.currentTarget.style.background = COLOR.bgWhite}
      >
        点击重试
      </button>
    </div>
  );
}
