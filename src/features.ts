/**
 * Modelo paramétrico: a "árvore de features".
 *
 * Cada feature é um passo da receita que constrói o corpo sólido.
 * O histórico é reavaliado do zero sempre que um parâmetro muda —
 * o mesmo princípio de history-based modeling do FreeCAD/SolidWorks,
 * na versão linear mais simples (um único corpo).
 */

export type FeatureType = "box" | "cylinder" | "sphere" | "fillet" | "sketch" | "pad";

/** Plano de sketch no espaço: origem + base ortonormal. */
export interface SketchPlaneData {
  origin: [number, number, number];
  xDir: [number, number, number];
  normal: [number, number, number];
}

/** Geometria 2D desenhada, em coordenadas locais do plano. */
export type SketchEntity =
  | { kind: "polygon"; points: [number, number][] }
  | { kind: "circle"; center: [number, number]; radius: number };

/**
 * Referência estável a uma face do B-rep (mesma estratégia do EdgeRef):
 * fingerprint geométrico + índice topológico como fallback. Permite que
 * um sketch desenhado numa face a acompanhe quando o modelo muda
 * (ex.: pocket na face de cima segue a altura do pad).
 */
export interface FaceRef {
  center: [number, number, number];
  normal: [number, number, number];
  index: number;
}

export interface SketchData {
  plane: SketchPlaneData;
  entity: SketchEntity;
  /** presente quando o sketch foi desenhado sobre uma face do corpo */
  faceRef?: FaceRef;
}

/** "add" funde com o corpo; "cut" subtrai (furo). Ignorado pelo fillet. */
export type BooleanMode = "add" | "cut";

/**
 * Referência estável a uma aresta do B-rep.
 *
 * Os ids topológicos do kernel (hashCode) mudam a cada reconstrução —
 * o clássico "topological naming problem". Guardamos duas pistas e
 * reencontramos a aresta após cada reavaliação do histórico:
 * 1. impressão digital geométrica (extremos + comprimento) — sobrevive
 *    a reconstruções da mesma geometria;
 * 2. índice na ordem de iteração topológica — fallback que sobrevive a
 *    mudanças de dimensão (a geometria move, a estrutura fica).
 */
export interface EdgeRef {
  start: [number, number, number];
  end: [number, number, number];
  length: number;
  index: number;
}

export interface Feature {
  id: number;
  type: FeatureType;
  name: string;
  mode: BooleanMode;
  /** Parâmetros numéricos editáveis (dimensões e posição). */
  params: Record<string, number>;
  /** Fillet: arestas alvo. Vazio/ausente = todas as arestas do corpo. */
  edgeRefs?: EdgeRef[];
  /** Sketch: a geometria 2D desenhada e seu plano. */
  sketch?: SketchData;
  /** Pad: id da feature de sketch que ele extruda. */
  sketchId?: number;
  /** Preenchido pelo avaliador quando a feature falha (ex.: fillet impossível). */
  error?: string;
}

export interface ParamSpec {
  key: string;
  label: string;
  min?: number;
  default: number;
}

/** Especificação dos parâmetros de cada tipo de feature (usada pela UI). */
export const FEATURE_SPECS: Record<FeatureType, ParamSpec[]> = {
  box: [
    { key: "width", label: "Largura (X)", min: 0.1, default: 60 },
    { key: "depth", label: "Profundidade (Y)", min: 0.1, default: 40 },
    { key: "height", label: "Altura (Z)", min: 0.1, default: 20 },
    { key: "x", label: "Posição X", default: 0 },
    { key: "y", label: "Posição Y", default: 0 },
    { key: "z", label: "Posição Z", default: 0 },
  ],
  cylinder: [
    { key: "radius", label: "Raio", min: 0.1, default: 8 },
    { key: "height", label: "Altura", min: 0.1, default: 30 },
    { key: "x", label: "Posição X", default: 0 },
    { key: "y", label: "Posição Y", default: 0 },
    { key: "z", label: "Posição Z", default: 0 },
  ],
  sphere: [
    { key: "radius", label: "Raio", min: 0.1, default: 12 },
    { key: "x", label: "Posição X", default: 0 },
    { key: "y", label: "Posição Y", default: 0 },
    { key: "z", label: "Posição Z", default: 0 },
  ],
  fillet: [{ key: "radius", label: "Raio", min: 0.01, default: 2 }],
  sketch: [],
  pad: [{ key: "distance", label: "Distância", min: 0.1, default: 20 }],
};

const TYPE_LABELS: Record<FeatureType, string> = {
  box: "Caixa",
  cylinder: "Cilindro",
  sphere: "Esfera",
  fillet: "Fillet",
  sketch: "Sketch",
  pad: "Pad",
};

let nextId = 1;

export function createFeature(
  type: FeatureType,
  mode: BooleanMode,
  extra?: { edgeRefs?: EdgeRef[]; sketch?: SketchData; sketchId?: number },
): Feature {
  const params: Record<string, number> = {};
  for (const spec of FEATURE_SPECS[type]) params[spec.key] = spec.default;
  const id = nextId++;

  let label = TYPE_LABELS[type];
  let prefix = "";
  if (type === "pad") {
    label = mode === "cut" ? "Pocket" : "Pad";
  } else if (type !== "fillet" && type !== "sketch" && mode === "cut") {
    prefix = "Furo ";
  }

  let name = `${prefix}${label} ${id}`;
  if (type === "fillet") {
    name += extra?.edgeRefs?.length
      ? ` (${extra.edgeRefs.length} aresta${extra.edgeRefs.length > 1 ? "s" : ""})`
      : " (todas as arestas)";
  }
  return { id, type, name, mode, params, ...extra };
}
