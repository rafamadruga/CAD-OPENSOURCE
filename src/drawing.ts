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
  /** dimensões reais (mm) da geometria na vista: [horizontal, vertical] */
  dims: [number, number];
}

type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

interface Hole {
  diameter: number;
  count: number;
}

/**
 * Detecta furos/circulares analisando as arestas do B-rep: três pontos
 * de cada aresta circular definem o circumcentro e o raio. Furos
 * coaxiais (as duas bordas de um furo passante) são agrupados.
 */
function detectHoles(body: Shape3D): Hole[] {
  const groups = new Map<string, Hole>();
  for (const edge of body.edges) {
    if (edge.geomType !== "CIRCLE") continue;
    const p = (t: number): Vec3 => {
      const v = edge.pointAt(t);
      return [v.x, v.y, v.z];
    };
    const [p1, p2, p3] = [p(0.1), p(0.4), p(0.7)];
    const v1 = sub(p2, p1);
    const v2 = sub(p3, p1);
    const n = cross(v1, v2);
    const n2 = dot(n, n);
    if (n2 < 1e-12) continue;
    // circumcentro 3D por três pontos
    const center = add3(
      p1,
      scale3(
        add3(
          scale3(cross(n, v1), dot(v2, v2)),
          scale3(cross(v2, n), dot(v1, v1)),
        ),
        1 / (2 * n2),
      ),
    );
    const radius = Math.hypot(...sub(center, p1));
    const nLen = Math.sqrt(n2);
    const axis = scale3(n, 1 / nLen).map((v) => +Math.abs(v).toFixed(3));
    // posição radial: centro projetado no plano ⊥ ao eixo (agrupa coaxiais)
    const along = dot(center, scale3(n, 1 / nLen));
    const radial = sub(center, scale3(scale3(n, 1 / nLen), along)).map((v) => +v.toFixed(1));
    const key = `${(radius * 2).toFixed(1)}|${axis.join()}|${radial.join()}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { diameter: radius * 2, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.diameter - a.diameter);
}

/** Linha de cota horizontal com setas, linhas de extensão e valor. */
function dimH(x1: number, x2: number, yEdge: number, value: string): string {
  const y = yEdge + 20;
  return `<g class="dim">
    <line x1="${x1}" y1="${yEdge + 4}" x2="${x1}" y2="${y + 4}"/>
    <line x1="${x2}" y1="${yEdge + 4}" x2="${x2}" y2="${y + 4}"/>
    <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}"/>
    <path d="M ${x1} ${y} l 7 -2.6 v 5.2 z"/>
    <path d="M ${x2} ${y} l -7 -2.6 v 5.2 z"/>
    <text x="${(x1 + x2) / 2}" y="${y - 5}" text-anchor="middle">${value}</text>
  </g>`;
}

/** Linha de cota vertical com setas, linhas de extensão e valor. */
function dimV(y1: number, y2: number, xEdge: number, value: string): string {
  const x = xEdge + 20;
  return `<g class="dim">
    <line x1="${xEdge + 4}" y1="${y1}" x2="${x + 4}" y2="${y1}"/>
    <line x1="${xEdge + 4}" y1="${y2}" x2="${x + 4}" y2="${y2}"/>
    <line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/>
    <path d="M ${x} ${y1} l -2.6 7 h 5.2 z"/>
    <path d="M ${x} ${y2} l -2.6 -7 h 5.2 z"/>
    <text x="${x + 6}" y="${(y1 + y2) / 2}" transform="rotate(-90 ${x + 6} ${(y1 + y2) / 2})" text-anchor="middle">${value}</text>
  </g>`;
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

  const make = (plane: "front" | "top" | "left", title: string, dims: [number, number]): View => {
    const projection = drawProjection(body, plane);
    const visible = projection.visible.toSVGPaths().flat();
    const hidden = projection.hidden.toSVGPaths().flat();
    return { title, paths: { visible, hidden }, box: parseViewBox(projection.visible.toSVGViewBox(2)), dims };
  };

  const front = make("front", "FRENTE", [W, H]);
  const top = make("top", "TOPO", [W, D]);
  const side = make("left", "LATERAL ESQ.", [D, H]);

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
    </svg>`;

    // cotas: a geometria ocupa dims*scale px, centrada na célula
    const gw = view.dims[0] * scale;
    const gh = view.dims[1] * scale;
    content += dimH(cx - gw / 2, cx + gw / 2, cy + gh / 2, fmt(view.dims[0]));
    content += dimV(cy - gh / 2, cy + gh / 2, cx + gw / 2 + 14, fmt(view.dims[1]));
    content += `<text x="${cx}" y="${cy + cellH / 2 + 26}" text-anchor="middle" class="label">${view.title}</text>`;
  }

  // tabela de furos detectados no B-rep
  const holes = detectHoles(body).slice(0, 8);
  if (holes.length > 0) {
    const tx = M;
    let ty = PAGE_H - 86;
    content += `<text x="${tx}" y="${ty}" class="block" font-weight="bold">FUROS / CIRCULARES</text>`;
    for (const hole of holes) {
      ty += 18;
      content += `<text x="${tx}" y="${ty}" class="block">Ø ${fmt(hole.diameter)} mm${hole.count > 1 ? ` (${hole.count} bordas)` : ""}</text>`;
    }
  }

  const today = new Date().toLocaleDateString("pt-BR");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}">
  <style>
    .label { font: bold 15px system-ui, sans-serif; fill: #111; }
    .block { font: 12px system-ui, sans-serif; fill: #111; }
    .dim line { stroke: #1660a8; stroke-width: 0.9; }
    .dim path { fill: #1660a8; }
    .dim text { font: 12px system-ui, sans-serif; fill: #1660a8; }
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
