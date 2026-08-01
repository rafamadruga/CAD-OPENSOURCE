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
  if (s.entity.kind === "polygon") {
    const [first, ...rest] = s.entity.points;
    let pen = draw(first);
    for (const p of rest) pen = pen.lineTo(p);
    drawing = pen.close();
  } else {
    drawing = drawCircle(s.entity.radius).translate(s.entity.center);
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

  for (const f of features) {
    try {
      // o sketch em si não altera o corpo — ele é consumido pelo pad
      if (f.type === "sketch") continue;

      if (f.type === "pad") {
        const sketchFeature = features.find(
          (x) => x.id === f.sketchId && x.type === "sketch",
        );
        if (!sketchFeature?.sketch) throw new Error("Sketch de referência não encontrado");

        // sketch ancorado numa face: re-resolve o plano no corpo atual,
        // para o sketch acompanhar a face quando o modelo muda
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

        // pad cresce para fora do plano; pocket corta para dentro
        const distance = f.mode === "cut" ? -f.params.distance : f.params.distance;
        const solid = buildSketch(sketchData).extrude(distance) as Shape3D;
        if (!body) {
          if (f.mode === "cut") throw new Error("Não há corpo para cortar");
          body = solid;
        } else {
          body = f.mode === "add" ? body.fuse(solid) : body.cut(solid);
        }
        continue;
      }

      if (f.type === "fillet") {
        if (!body) throw new Error("Não há corpo para aplicar o fillet");
        const refs = f.edgeRefs;
        if (refs && refs.length > 0) {
          const selected = resolveEdgeRefs(body.edges, refs);
          if (selected.size === 0) throw new Error("Nenhuma aresta de referência reencontrada");
          body = body.fillet((edge) =>
            selected.has(edge.hashCode) ? f.params.radius : null,
          );
          if (selected.size < refs.length) {
            errors.set(
              f.id,
              `Só ${selected.size} de ${refs.length} aresta(s) de referência foram reencontradas`,
            );
          }
        } else {
          body = body.fillet(f.params.radius);
        }
        continue;
      }

      const shape = buildPrimitive(f);
      if (!body) {
        if (f.mode === "cut") throw new Error("Não há corpo para cortar");
        body = shape;
      } else {
        body = f.mode === "add" ? body.fuse(shape) : body.cut(shape);
      }
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
function resolveFacePlane(body: Shape3D, ref: FaceRef): SketchPlaneData | null {
  const faces = body.faces;
  let face = faces.find((f) => {
    if (f.geomType !== "PLANE" || !sameDirection(f.normalAt(), ref.normal)) return false;
    const c = f.center;
    return (
      Math.hypot(c.x - ref.center[0], c.y - ref.center[1], c.z - ref.center[2]) < REF_TOL
    );
  });
  if (!face && ref.index < faces.length) {
    const candidate = faces[ref.index];
    if (candidate.geomType === "PLANE" && sameDirection(candidate.normalAt(), ref.normal)) {
      face = candidate;
    }
  }
  return face ? planeFromFaceObj(face) : null;
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
