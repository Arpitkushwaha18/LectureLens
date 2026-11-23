import { useState, useRef } from "react";
import { Button } from "@/components/ui/Button";
import type { NotebookBlock } from "@lecturelens/contracts";
export type MapBlock = Extract<NotebookBlock, { type: "mindmap" | "diagram" }>;
export function MindMapView({ map, interactive = true }: { map: MapBlock; interactive?: boolean }) {
  const [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null),
    svg = useRef<SVGSVGElement>(null);
  const positions = map.nodes.map((node, i) => {
    const angle = ((i - 1) * 2 * Math.PI) / Math.max(1, map.nodes.length - 1);
    return {
      ...node,
      x: i ? 450 + Math.cos(angle) * 320 : 450,
      y: i ? 350 + Math.sin(angle) * 250 : 350,
    };
  });
  const wrap = (text: string) => text.match(/.{1,19}(?:\s|$)|.{1,19}/g)?.slice(0, 5) ?? [text];
  function exportSvg() {
    if (!svg.current) return;
    const blob = new Blob(
        [svg.current.outerHTML.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"')],
        { type: "image/svg+xml" },
      ),
      url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download = "lecturelens-mind-map.svg";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <figure className="mind-map-view">
      <figcaption>{map.title}</figcaption>
      {interactive ? (
        <div className="map-toolbar">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Zoom out"
            onClick={() => setZoom((v) => Math.max(0.6, v - 0.2))}
          >
            −
          </Button>
          <span>{Math.round(zoom * 100)}%</span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Zoom in"
            onClick={() => setZoom((v) => Math.min(2.5, v + 0.2))}
          >
            +
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            Reset view
          </Button>
          <Button variant="secondary" size="sm" onClick={exportSvg}>
            Download SVG
          </Button>
        </div>
      ) : null}
      <svg
        ref={svg}
        role="img"
        aria-label={map.title}
        viewBox={`${450 - 450 / zoom + pan.x} ${350 - 350 / zoom + pan.y} ${900 / zoom} ${700 / zoom}`}
        onPointerDown={(e) => {
          if (!interactive) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
        }}
        onPointerMove={(e) => {
          if (drag.current) {
            const factor = 900 / e.currentTarget.getBoundingClientRect().width / zoom;
            setPan({
              x: drag.current.px - (e.clientX - drag.current.x) * factor,
              y: drag.current.py - (e.clientY - drag.current.y) * factor,
            });
          }
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        style={{ touchAction: interactive ? "none" : "auto" }}
      >
        {map.edges.map((edge, i) => {
          const from = positions.find((n) => n.id === edge.from),
            to = positions.find((n) => n.id === edge.to);
          return from && to ? (
            <g key={i}>
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#a1b5c7" strokeWidth="3" />
              {edge.label ? (
                <text
                  x={(from.x + to.x) / 2}
                  y={(from.y + to.y) / 2 - 8}
                  fontSize="12"
                  textAnchor="middle"
                  fill="#2b4a6f"
                >
                  {edge.label}
                </text>
              ) : null}
            </g>
          ) : null;
        })}
        {positions.map((node, i) => (
          <g key={node.id}>
            <rect
              x={node.x - 87}
              y={node.y - 47}
              width="174"
              height="94"
              rx="12"
              fill={i ? ["#f5e5df", "#e9eddd", "#f9efcd", "#e5edf5"][i % 4] : "#2b4a6f"}
              stroke={i ? "#d7c9ac" : "#2b4a6f"}
            />
            <text
              x={node.x}
              y={node.y - 25}
              textAnchor="middle"
              fill={i ? "#243f59" : "#fffdf8"}
              fontSize="15"
            >
              {wrap(node.label).map((line, j) => (
                <tspan key={j} x={node.x} dy={j ? 17 : 0}>
                  {line.trim()}
                </tspan>
              ))}
            </text>
          </g>
        ))}
      </svg>
      {interactive ? (
        <p className="text-xs text-ink-muted">Drag to explore. Zoom controls work on phones too.</p>
      ) : null}
    </figure>
  );
}
