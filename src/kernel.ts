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
  type Shape3D,
} from "replicad";

import type { Feature } from "./features";

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
        body = body.fillet(f.params.radius);
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

export interface TessellatedBody {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edgeLines: Float32Array;
}

/** Converte o B-rep exato em malha de triângulos + linhas de aresta para a GPU. */
export function tessellate(body: Shape3D): TessellatedBody {
  const mesh = body.mesh({ tolerance: 0.05, angularTolerance: 15 });
  const edges = body.meshEdges({ tolerance: 0.05, angularTolerance: 15 });
  return {
    vertices: new Float32Array(mesh.vertices),
    normals: new Float32Array(mesh.normals),
    indices: new Uint32Array(mesh.triangles),
    edgeLines: new Float32Array(edges.lines),
  };
}

export function exportSTL(body: Shape3D): Blob {
  return body.blobSTL({ tolerance: 0.01, angularTolerance: 5 });
}

export function exportSTEP(body: Shape3D): Blob {
  return body.blobSTEP();
}
