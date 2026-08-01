/**
 * Desenho técnico 2D: projeções ortográficas do B-rep exato.
 *
 * O kernel projeta o sólido em cada plano de vista (drawProjection do
 * OCCT via replicad), separando arestas visíveis e ocultas. Montamos a
 * folha como um SVG único com as três vistas em escala uniforme,
 * dimensões gerais e legenda — pronto para imprimir.
 */
import { drawProjection, type Shape3D } from "replicad";

interface View {
  title: string;
  paths: { visible: string[]; hidden: string[] };
  /** viewBox "x y w h" do desenho projetado */
  box: { x: number; y: number; w: number; h: number };
  dims: string;
}

function parseViewBox(vb: string): { x: number; y: number; w: number; h: number } {
  const [x, y, w, h] = vb.split(" ").map(Number);
  return { x, y, w, h };
}

const fmt = (v: number) => String(+v.toFixed(1));

/** Gera a folha de desenho técnico (SVG completo) do corpo atual. */
export function technicalDrawing(body: Shape3D, docName = "modelo"): string {
  const [min, max] = body.boundingBox.bounds;
  const W = max[0] - min[0]; // largura (X)
  const D = max[1] - min[1]; // profundidade (Y)
  const H = max[2] - min[2]; // altura (Z)

  const make = (plane: "front" | "top" | "left", title: string, dims: string): View => {
    const projection = drawProjection(body, plane);
    const visible = projection.visible.toSVGPaths().flat();
    const hidden = projection.hidden.toSVGPaths().flat();
    return { title, paths: { visible, hidden }, box: parseViewBox(projection.visible.toSVGViewBox(2)), dims };
  };

  const front = make("front", "FRENTE", `${fmt(W)} × ${fmt(H)}`);
  const top = make("top", "TOPO", `${fmt(W)} × ${fmt(D)}`);
  const side = make("left", "LATERAL ESQ.", `${fmt(D)} × ${fmt(H)}`);

  // folha A4 paisagem (96 dpi) com grade 2×2:
  // topo em cima da frente; lateral à direita da frente
  const PAGE_W = 1123;
  const PAGE_H = 794;
  const M = 48; // margem
  const GAP = 36;
  const LABEL_H = 34;

  const BLOCK_H = 78; // faixa reservada à legenda no rodapé
  const cellW = (PAGE_W - 2 * M - GAP) / 2;
  const cellH = (PAGE_H - 2 * M - GAP - 2 * LABEL_H - BLOCK_H) / 2;

  // escala uniforme entre todas as vistas (mm → px)
  const scale = Math.min(
    ...[front, top, side].map((v) => Math.min(cellW / v.box.w, cellH / v.box.h)),
  );

  const cells: { view: View; col: number; row: number }[] = [
    { view: top, col: 0, row: 0 },
    { view: front, col: 0, row: 1 },
    { view: side, col: 1, row: 1 },
  ];

  let content = "";
  for (const { view, col, row } of cells) {
    const w = view.box.w * scale;
    const h = view.box.h * scale;
    const cx = M + col * (cellW + GAP) + cellW / 2;
    const cy = M + row * (cellH + LABEL_H + GAP) + cellH / 2;
    const paths = (list: string[], style: string) =>
      list.map((d) => `<path d="${d}" ${style}/>`).join("\n");

    // svg aninhado: o viewBox da projeção cuida de toda a transformação
    content += `
    <svg x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}"
         viewBox="${view.box.x} ${view.box.y} ${view.box.w} ${view.box.h}" overflow="visible">
      ${paths(view.paths.hidden, `fill="none" stroke="#888" stroke-width="${0.6 / scale}" stroke-dasharray="${3 / scale} ${2 / scale}"`)}
      ${paths(view.paths.visible, `fill="none" stroke="#111" stroke-width="${1.1 / scale}"`)}
    </svg>
    <text x="${cx}" y="${cy + cellH / 2 + 22}" text-anchor="middle" class="label">${view.title} — ${view.dims} mm</text>`;
  }

  const today = new Date().toLocaleDateString("pt-BR");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}">
  <style>
    .label { font: bold 15px system-ui, sans-serif; fill: #111; }
    .block { font: 12px system-ui, sans-serif; fill: #111; }
  </style>
  <rect width="${PAGE_W}" height="${PAGE_H}" fill="white"/>
  <rect x="12" y="12" width="${PAGE_W - 24}" height="${PAGE_H - 24}" fill="none" stroke="#111" stroke-width="1.5"/>
  ${content}
  <g>
    <rect x="${PAGE_W - 342}" y="${PAGE_H - 86}" width="330" height="68" fill="none" stroke="#111"/>
    <text x="${PAGE_W - 330}" y="${PAGE_H - 64}" class="block" font-weight="bold">${docName} — ${fmt(W)} × ${fmt(D)} × ${fmt(H)} mm</text>
    <text x="${PAGE_W - 330}" y="${PAGE_H - 44}" class="block">Projeções ortográficas (mm)</text>
    <text x="${PAGE_W - 330}" y="${PAGE_H - 26}" class="block">CAD Open Source — ${today}</text>
  </g>
</svg>`;
}
