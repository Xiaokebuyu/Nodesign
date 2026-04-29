/** 迷你柱状图 — 纯 CSS，不依赖 recharts */
export default function MiniBar({ data, color, height = 36 }) {
  const max = Math.max(...data, 1);
  return (
    <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height }}>
      {data.map((v, i) => (
        <div key={i} style={{
          flex: 1, borderRadius: 2,
          height: `${(v / max) * 100}%`,
          background: i >= data.length - 3 ? color : color + "60",
          transition: "height 0.4s ease",
          minHeight: 2,
        }} />
      ))}
    </div>
  );
}
