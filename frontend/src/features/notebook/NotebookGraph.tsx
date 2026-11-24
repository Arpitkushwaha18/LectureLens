import { useId } from "react";
import { layoutNotebookGraph, type GraphBlock } from "./graph-layout";

export function NotebookGraph({ block }: { block: GraphBlock }) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const graph = layoutNotebookGraph(block);
  return (
    <figure className="notebook-graph">
      <figcaption>{block.title}</figcaption>
      <div className="graph-scroll">
        <svg
          role="img"
          aria-label={block.title}
          width={graph.width}
          height={graph.height}
          viewBox={`0 0 ${graph.width} ${graph.height}`}
        >
          <defs>
            <marker
              id={`arrow-${id}`}
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="3"
              orient="auto"
            >
              <path d="M0,0 L0,6 L8,3 z" fill="#58748f" />
            </marker>
          </defs>
          {graph.edges.map((edge, i) => (
            <g key={i}>
              <path
                d={edge.points.map((point, j) => `${j ? "L" : "M"}${point.x},${point.y}`).join(" ")}
                fill="none"
                stroke="#58748f"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                markerEnd={`url(#arrow-${id})`}
              />
              {edge.label ? (
                <g>
                  <rect
                    x={edge.x - 75}
                    y={edge.y - edge.height / 2}
                    width="150"
                    height={edge.height}
                    rx="4"
                    fill="#fff9eb"
                  />
                  <text
                    x={edge.x}
                    y={edge.y - (edge.lines.length - 1) * 8}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize="13"
                    fill="#2b4a6f"
                  >
                    {edge.lines.map((line, j) => (
                      <tspan key={j} x={edge.x} dy={j ? 16 : 0}>
                        {line}
                      </tspan>
                    ))}
                  </text>
                </g>
              ) : null}
            </g>
          ))}
          {graph.nodes.map((node) => (
            <g key={node.id}>
              <rect
                x={node.x - node.width / 2}
                y={node.y - node.height / 2}
                width={node.width}
                height={node.height}
                rx="10"
                fill="#fff6c8"
                stroke="#b9aa6e"
              />
              <text
                x={node.x}
                y={node.y - (node.lines.length - 1) * 10}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize="16"
                fill="#1c2733"
              >
                {node.lines.map((line, j) => (
                  <tspan key={j} x={node.x} dy={j ? 20 : 0}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </figure>
  );
}
