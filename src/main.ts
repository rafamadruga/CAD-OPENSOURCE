/**
 * Bootstrap: carrega o kernel, monta a UI e liga o ciclo paramétrico
 * (mudança de parâmetro → reavaliação do histórico → tesselação → GPU).
 */
import type { Shape3D } from "replicad";

import type { EdgeRef, FaceRef, Feature, SketchPlaneData } from "./features";
import {
  evaluate,
  exportSTEP,
  exportSTL,
  initKernel,
  planeFromFace,
  tessellate,
  XY_PLANE,
  type TessellatedBody,
} from "./kernel";
import { UI, downloadBlob } from "./ui";
import { Viewport, type Selection } from "./viewport";
import "./style.css";

const app = document.querySelector<HTMLElement>("#app")!;

let currentBody: Shape3D | null = null;
let currentTess: TessellatedBody | null = null;
let currentSelection: Selection = { faceId: null, edgeIds: [] };
let viewport: Viewport;

function rebuild(features: Feature[], ui: UI): void {
  const started = performance.now();
  const { body, errors } = evaluate(features);
  currentBody = body;
  currentTess = body ? tessellate(body) : null;
  viewport.setBody(currentTess); // limpa a seleção (a topologia mudou)
  ui.showErrors(errors);

  const ms = (performance.now() - started).toFixed(0);
  if (errors.size > 0) {
    ui.setStatus(`Reconstruído com ${errors.size} aviso(s) em ${ms} ms`, true);
  } else if (body) {
    ui.setStatus(`Reconstruído em ${ms} ms — ${features.length} feature(s)`);
  } else {
    ui.setStatus("Modelo vazio");
  }
}

/** Converte os ids de aresta selecionados nas impressões digitais estáveis. */
function selectedEdgeRefs(): EdgeRef[] {
  if (!currentTess) return [];
  return currentSelection.edgeIds
    .map((id) => currentTess!.edgeRefs.get(id))
    .filter((r): r is EdgeRef => r !== undefined);
}

async function start(): Promise<void> {
  await initKernel();

  let sketchPlane: SketchPlaneData = XY_PLANE;
  let sketchFaceRef: FaceRef | undefined;
  let sketchKind: "polygon" | "circle" = "polygon";

  const ui = new UI(app, {
    onModelChange: (features) => rebuild(features, ui),
    onExportSTL: () => {
      if (currentBody) downloadBlob(exportSTL(currentBody), "modelo.stl");
    },
    onExportSTEP: () => {
      if (currentBody) downloadBlob(exportSTEP(currentBody), "modelo.step");
    },
    getSelectedEdgeRefs: selectedEdgeRefs,
    onStartSketch: (kind) => {
      // desenha na face plana selecionada, ou no plano XY
      sketchKind = kind;
      sketchPlane = XY_PLANE;
      sketchFaceRef = undefined;
      let where = "no plano XY";
      if (currentSelection.faceId !== null && currentBody) {
        const result = planeFromFace(currentBody, currentSelection.faceId);
        if (result) {
          sketchPlane = result.plane;
          sketchFaceRef = result.faceRef;
          where = "na face selecionada";
        }
      }
      viewport.startSketch(sketchPlane, kind);
      ui.setSketchMode(
        true,
        kind === "polygon"
          ? `Clique para adicionar os vértices do polígono ${where} (mín. 3).`
          : `Clique no centro e depois num ponto da borda do círculo ${where}.`,
      );
    },
    onFinishSketch: (action) => {
      const entity = viewport.finishSketch();
      ui.setSketchMode(false);
      if (entity)
        ui.addSketchAndOp({ plane: sketchPlane, entity, faceRef: sketchFaceRef }, action);
    },
    onCancelSketch: () => {
      viewport.cancelSketch();
      ui.setSketchMode(false);
    },
  });

  viewport = new Viewport(ui.viewportEl, (sel) => {
    currentSelection = sel;
    ui.setSelection(sel);
  });
  viewport.onSketchProgress = (n) => {
    ui.setSketchReady(sketchKind === "polygon" ? n >= 3 : n >= 2);
  };
  ui.setStatus("Kernel pronto. Adicione uma primitiva para começar.");

  // gancho de depuração para os testes E2E
  (window as unknown as { __cad: object }).__cad = {
    project: (x: number, y: number, z: number) => viewport.projectToScreen(x, y, z),
  };
}

start().catch((e) => {
  app.innerHTML = `<div id="loading"><p class="error">Falha ao iniciar: ${e}</p></div>`;
});
