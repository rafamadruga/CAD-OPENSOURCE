/**
 * Camada do kernel geométrico.
 *
 * Carrega o OpenCASCADE compilado para WebAssembly e avalia a árvore
 * de features chamando o kernel via replicad (API amigável sobre o OCCT).
 */
import opencascade from "replicad-opencascadejs/src/replicad_single.js";
import opencascadeWasm from "replicad-opencascadejs/src/replicad_single.wasm?url";
import {
  setOC,
  makeBaseBox,
  makeCylinder,
  makeSphere,
  draw,
  drawCircle,
  importSTEP,
  Plane,
  type Edge,
  type Shape3D,
  type Sketch,
} from "replicad";

import type {
  EdgeRef,
  FaceRef,
  Feature,
  SketchData,
  SketchPlaneData,
} from "./features";
import type { Face } from "replicad";

export async function initKernel(): Promise<void> {
  const OC = await (opencascade as unknown as (opts: object) => Promise<unknown>)({
    locateFile: () => opencascadeWasm,
  });
  setOC(OC as Parameters<typeof setOC>[0]);
}

function buildPrimitive(f: Feature): Shape3D {
  const p = f.params;
  let shape: Shape3D;
  switch (f.type) {
    case "box":
      shape = makeBaseBox(p.width, p.depth, p.height);
      break;
    case "cylinder":
      shape = makeCylinder(p.radius, p.height);
      break;
    case "sphere":
      shape = makeSphere(p.radius);
      break;
    default:
      throw new Error(`Tipo não é primitiva: ${f.type}`);
  }
  return shape.translate(p.x, p.y, p.z);
}

/** Constrói a face 2D do sketch posicionada no seu plano 3D. */
function buildSketch(s: SketchData): Sketch {
  let drawing;
  if (s.entity.kind === "circle") {
    drawing = drawCircle(s.entity.radius).translate(s.entity.center);
  } else {
    const segments =
      s.entity.kind === "profile"
        ? s.entity.segments
        : s.entity.points.map((p) => ({ to: p, via: undefined }));
    const [first, ...rest] = segments;
    let pen = draw(first.to);
    for (const seg of rest) {
      pen = seg.via ? pen.threePointsArcTo(seg.to, seg.via) : pen.lineTo(seg.to);
    }
    drawing = pen.close();
  }
  const plane = new Plane(s.plane.origin, s.plane.xDir, s.plane.normal);
  return drawing.sketchOnPlane(plane) as Sketch;
}

export interface EvaluationResult {
  body: Shape3D | null;
  /** ids das features que falharam nesta avaliação */
  errors: Map<number, string>;
}

const REF_TOL = 1e-3;

function nearPoint(
  p: { x: number; y: number; z: number },
  q: [number, number, number],
): boolean {
  return Math.hypot(p.x - q[0], p.y - q[1], p.z - q[2]) < REF_TOL;
}

function matchesFingerprint(edge: Edge, r: EdgeRef): boolean {
  if (Math.abs(edge.length - r.length) >= REF_TOL) return false;
  const s = edge.startPoint;
  const e = edge.endPoint;
  return (
    (nearPoint(s, r.start) && nearPoint(e, r.end)) ||
    (nearPoint(s, r.end) && nearPoint(e, r.start))
  );
}

/**
 * Reencontra as arestas referenciadas no corpo atual: primeiro pela
 * impressão digital geométrica; se a geometria mudou (ex.: dimensão
 * editada), cai para o índice topológico.
 */
function resolveEdgeRefs(bodyEdges: Edge[], refs: EdgeRef[]): Set<number> {
  const selected = new Set<number>();
  for (const ref of refs) {
    const byGeometry = bodyEdges.find((e) => matchesFingerprint(e, ref));
    if (byGeometry) selected.add(byGeometry.hashCode);
    else if (ref.index < bodyEdges.length) selected.add(bodyEdges[ref.index].hashCode);
  }
  return selected;
}

/**
 * Reexecuta o histórico inteiro, na ordem, produzindo o corpo final.
 * Uma feature que falha (ex.: fillet com raio grande demais, booleana
 * degenerada) é pulada e marcada com erro — o resto do histórico segue.
 */
export function evaluate(features: Feature[]): EvaluationResult {
  const errors = new Map<number, string>();
  let body: Shape3D | null = null;

  /**
   * Resolve um sketch pelo id: re-ancora o plano na face de referência
   * do corpo atual (quando houver) e aplica o offset ao longo da normal.
   */
  const resolveSketchById = (id: number | undefined): SketchData => {
    const sketchFeature = features.find((x) => x.id === id && x.type === "sketch");
    if (!sketchFeature?.sketch) throw new Error("Sketch de referência não encontrado");
    let sketchData = sketchFeature.sketch;
    if (sketchData.faceRef && body) {
      const plane = resolveFacePlane(body, sketchData.faceRef);
      if (plane) sketchData = { ...sketchData, plane };
      else
        errors.set(
          sketchFeature.id,
          "Face de referência não reencontrada — usando o plano original",
        );
    }
    const offset = sketchFeature.params.offset || 0;
    if (offset) {
      const { origin, normal } = sketchData.plane;
      sketchData = {
        ...sketchData,
        plane: {
          ...sketchData.plane,
          origin: [
            origin[0] + normal[0] * offset,
            origin[1] + normal[1] * offset,
            origin[2] + normal[2] * offset,
          ],
        },
      };
    }
    return sketchData;
  };
  const resolveSketch = (f: Feature): SketchData => resolveSketchById(f.sketchId);

  const combine = (f: Feature, solid: Shape3D): Shape3D => {
    if (!body) {
      if (f.mode === "cut") throw new Error("Não há corpo para cortar");
      return solid;
    }
    return f.mode === "add" ? body.fuse(solid) : body.cut(solid);
  };

  for (const f of features) {
    try {
      // o sketch em si não altera o corpo — ele é consumido pelo pad/revolução
      if (f.type === "sketch") continue;

      if (f.type === "pad") {
        // pad cresce para fora do plano; pocket corta para dentro
        const distance = f.mode === "cut" ? -f.params.distance : f.params.distance;
        body = combine(f, buildSketch(resolveSketch(f)).extrude(distance) as Shape3D);
        continue;
      }

      if (f.type === "revolve") {
        const s = resolveSketch(f);
        // eixo de revolução: o Y local do plano (o eixo vertical na vista de sketch)
        const n = s.plane.normal;
        const x = s.plane.xDir;
        const yDir: [number, number, number] = [
          n[1] * x[2] - n[2] * x[1],
          n[2] * x[0] - n[0] * x[2],
          n[0] * x[1] - n[1] * x[0],
        ];
        const solid = buildSketch(s).revolve(yDir, {
          origin: s.plane.origin,
          angle: f.params.angle,
        }) as Shape3D;
        body = combine(f, solid);
        continue;
      }

      if (f.type === "loft") {
        const ids = f.sketchIds ?? [];
        if (ids.length < 2) throw new Error("Loft precisa de pelo menos 2 sketches");
        const [first, ...rest] = ids.map((id) => buildSketch(resolveSketchById(id)));
        const solid = first.loftWith(rest as (typeof first)[], { ruled: false });
        body = combine(f, solid);
        continue;
      }

      if (f.type === "import") {
        const shape = importedShapes.get(f.id);
        if (!shape) throw new Error("Arquivo STEP inválido ou ainda não carregado");
        // clona: as transformações do replicad consomem o objeto original,
        // e o cache precisa sobreviver às próximas reavaliações
        body = combine(f, shape.clone().translate(f.params.x, f.params.y, f.params.z));
        continue;
      }

      if (f.type === "shell") {
        if (!body) throw new Error("Não há corpo para ocar");
        if (!f.faceRef) throw new Error("Nenhuma face de referência para a abertura");
        const face = resolveFace(body, f.faceRef);
        if (!face) throw new Error("Face de referência não reencontrada");
        body = body.shell(f.params.thickness, (ff) => ff.inList([face]));
        continue;
      }

      if (f.type === "fillet" || f.type === "chamfer") {
        if (!body) throw new Error(`Não há corpo para aplicar o ${f.type}`);
        const apply = (radiusConfig: (e: Edge) => number | null): Shape3D =>
          f.type === "fillet" ? body!.fillet(radiusConfig) : body!.chamfer(radiusConfig);
        const refs = f.edgeRefs;
        if (refs && refs.length > 0) {
          const selected = resolveEdgeRefs(body.edges, refs);
          if (selected.size === 0) throw new Error("Nenhuma aresta de referência reencontrada");
          body = apply((edge) => (selected.has(edge.hashCode) ? f.params.radius : null));
          if (selected.size < refs.length) {
            errors.set(
              f.id,
              `Só ${selected.size} de ${refs.length} aresta(s) de referência foram reencontradas`,
            );
          }
        } else {
          body = apply(() => f.params.radius);
        }
        continue;
      }

      body = combine(f, buildPrimitive(f));
    } catch (e) {
      errors.set(f.id, e instanceof Error ? e.message : String(e));
    }
  }

  return { body, errors };
}

/** Plano padrão de sketch: XY na origem (chão do modelo). */
export const XY_PLANE: SketchPlaneData = {
  origin: [0, 0, 0],
  xDir: [1, 0, 0],
  normal: [0, 0, 1],
};

/** Plano de sketch de uma face plana, com base ortonormal determinística. */
function planeFromFaceObj(face: Face): SketchPlaneData {
  const c = face.center;
  const n = face.normalAt();
  const nLen = Math.hypot(n.x, n.y, n.z) || 1;
  const nz: [number, number, number] = [n.x / nLen, n.y / nLen, n.z / nLen];

  // base ortonormal: referência pouco alinhada com a normal → xDir = ref × n
  const ref: [number, number, number] = Math.abs(nz[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const xr: [number, number, number] = [
    ref[1] * nz[2] - ref[2] * nz[1],
    ref[2] * nz[0] - ref[0] * nz[2],
    ref[0] * nz[1] - ref[1] * nz[0],
  ];
  const xLen = Math.hypot(...xr) || 1;

  return {
    origin: [c.x, c.y, c.z],
    xDir: [xr[0] / xLen, xr[1] / xLen, xr[2] / xLen],
    normal: nz,
  };
}

/**
 * Extrai o plano de sketch (e a referência estável) de uma face plana
 * selecionada. Retorna null se a face não existir ou não for plana.
 */
export function planeFromFace(
  body: Shape3D,
  faceId: number,
): { plane: SketchPlaneData; faceRef: FaceRef } | null {
  const faces = body.faces;
  const index = faces.findIndex((f) => f.hashCode === faceId);
  if (index < 0 || faces[index].geomType !== "PLANE") return null;

  const plane = planeFromFaceObj(faces[index]);
  return {
    plane,
    faceRef: { center: plane.origin, normal: plane.normal, index },
  };
}

function sameDirection(n: { x: number; y: number; z: number }, ref: [number, number, number]): boolean {
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  return (n.x * ref[0] + n.y * ref[1] + n.z * ref[2]) / len > 0.999;
}

/**
 * Reencontra a face referenciada no corpo atual: fingerprint geométrico
 * (centro + normal) e, se a geometria mudou, o índice topológico — desde
 * que a normal ainda bata (a face pode ter transladado, não virado).
 */
function resolveFace(body: Shape3D, ref: FaceRef): Face | null {
  const faces = body.faces;
  const face = faces.find((f) => {
    if (f.geomType !== "PLANE" || !sameDirection(f.normalAt(), ref.normal)) return false;
    const c = f.center;
    return (
      Math.hypot(c.x - ref.center[0], c.y - ref.center[1], c.z - ref.center[2]) < REF_TOL
    );
  });
  if (face) return face;
  if (ref.index < faces.length) {
    const candidate = faces[ref.index];
    if (candidate.geomType === "PLANE" && sameDirection(candidate.normalAt(), ref.normal)) {
      return candidate;
    }
  }
  return null;
}

function resolveFacePlane(body: Shape3D, ref: FaceRef): SketchPlaneData | null {
  const face = resolveFace(body, ref);
  return face ? planeFromFaceObj(face) : null;
}

// ── import STEP: o parse é assíncrono, o resultado fica em cache ──

const importedShapes = new Map<number, Shape3D | null>();

/**
 * Garante que toda feature de import tenha seu STEP já convertido em
 * shape (parse assíncrono, feito uma vez). Chamar antes de evaluate().
 */
export async function prepareImports(features: Feature[]): Promise<void> {
  const live = new Set(features.map((f) => f.id));
  for (const id of [...importedShapes.keys()]) {
    if (!live.has(id)) importedShapes.delete(id); // limpa features removidas
  }
  for (const f of features) {
    if (f.type !== "import" || !f.stepData || importedShapes.has(f.id)) continue;
    try {
      const shape = await importSTEP(new Blob([f.stepData]));
      importedShapes.set(f.id, shape as Shape3D);
    } catch {
      importedShapes.set(f.id, null);
    }
  }
}

export interface TopoGroup {
  /** offset no buffer (índices para faces, pontos para arestas) */
  start: number;
  count: number;
  /** hashCode topológico da entidade nesta avaliação */
  id: number;
}

export interface TessellatedBody {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edgeLines: Float32Array;
  /** mapeia trechos do buffer de índices de volta às faces do B-rep */
  faceGroups: TopoGroup[];
  /** mapeia trechos do buffer de linhas de volta às arestas do B-rep */
  edgeGroups: TopoGroup[];
  /** impressão digital geométrica de cada aresta, por hashCode */
  edgeRefs: Map<number, EdgeRef>;
}

/** Converte o B-rep exato em malha de triângulos + linhas de aresta para a GPU. */
export function tessellate(body: Shape3D): TessellatedBody {
  const mesh = body.mesh({ tolerance: 0.05, angularTolerance: 15 });
  const edges = body.meshEdges({ tolerance: 0.05, angularTolerance: 15 });

  const edgeRefs = new Map<number, EdgeRef>();
  body.edges.forEach((edge, index) => {
    const s = edge.startPoint;
    const e = edge.endPoint;
    edgeRefs.set(edge.hashCode, {
      start: [s.x, s.y, s.z],
      end: [e.x, e.y, e.z],
      length: edge.length,
      index,
    });
  });

  return {
    vertices: new Float32Array(mesh.vertices),
    normals: new Float32Array(mesh.normals),
    indices: new Uint32Array(mesh.triangles),
    edgeLines: new Float32Array(edges.lines),
    faceGroups: mesh.faceGroups.map((g) => ({ start: g.start, count: g.count, id: g.faceId })),
    edgeGroups: edges.edgeGroups.map((g) => ({ start: g.start, count: g.count, id: g.edgeId })),
    edgeRefs,
  };
}

export function exportSTL(body: Shape3D): Blob {
  return body.blobSTL({ tolerance: 0.01, angularTolerance: 5 });
}

export function exportSTEP(body: Shape3D): Blob {
  return body.blobSTEP();
}
