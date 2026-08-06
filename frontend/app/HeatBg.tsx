// 共用底纹：热力图水印（确定性伪随机 4 级，颜色走当前主题 token）
const CELLS = Array.from({ length: 900 }, (_, i) => {
  const h = (i * 1103515245 + 12345) >>> 0;
  const r = h % 100;
  return r < 56 ? 0 : r < 80 ? 1 : r < 93 ? 2 : 3;
});

export default function HeatBg({ contained = false }: { contained?: boolean }) {
  return (
    <div
      aria-hidden
      style={{ position: contained ? "absolute" : "fixed", inset: 0, zIndex: 0, overflow: "hidden", pointerEvents: "none" }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill,30px)",
          gridAutoRows: "30px",
          gap: 6,
          padding: 16,
          opacity: 0.5,
        }}
      >
        {CELLS.map((lvl, i) => (
          <div key={i} style={{ borderRadius: 4, background: `var(--heatbg-${lvl})` }} />
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "linear-gradient(180deg, rgba(var(--scrim-rgb),0.5), rgba(var(--scrim-rgb),0.78))",
        }}
      />
    </div>
  );
}
