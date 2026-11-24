import { graphlib, layout, type Point } from "@dagrejs/dagre";
import type { NotebookBlock } from "@lecturelens/contracts";

export type GraphBlock = Extract<NotebookBlock, { type: "diagram" | "mindmap" }>;
type NodePosition = { x: number; y: number; width: number; height: number };
type EdgePosition = { x: number; y: number; height: number; points: Point[] };
export function wrapGraphLabel(text: string, limit = 24) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > limit) {
      lines.push(line);
      line = "";
    }
    if (word.length > limit) {
      if (line) {
        lines.push(line);
        line = "";
      }
      for (let i = 0; i < word.length; i += limit) lines.push(word.slice(i, i + limit));
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}
export function layoutNotebookGraph(block: GraphBlock) {
  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: block.type === "mindmap" ? "LR" : "TB",
    nodesep: 32,
    ranksep: 60,
    marginx: 24,
    marginy: 24,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of block.nodes) {
    const lines = wrapGraphLabel(node.label);
    graph.setNode(node.id, { width: 210, height: Math.max(60, lines.length * 20 + 28), lines });
  }
  block.edges.forEach((edge, i) =>
    graph.setEdge(
      edge.from,
      edge.to,
      {
        width: edge.label ? 150 : 0,
        height: edge.label ? wrapGraphLabel(edge.label).length * 16 + 12 : 0,
      },
      String(i),
    ),
  );
  layout(graph);
  return {
    width: graph.graph().width!,
    height: graph.graph().height!,
    nodes: block.nodes.map((node) => ({
      ...node,
      ...(graph.node(node.id) as NodePosition),
      lines: wrapGraphLabel(node.label),
    })),
    edges: block.edges.map((edge, i) => ({
      ...edge,
      ...(graph.edge({ v: edge.from, w: edge.to, name: String(i) }) as EdgePosition),
      lines: wrapGraphLabel(edge.label ?? ""),
    })),
  };
}
