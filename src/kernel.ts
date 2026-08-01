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
  type Edge,
  type Shape3D,
} from "replicad";

import type { EdgeRef, Feature } from "./features";

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
