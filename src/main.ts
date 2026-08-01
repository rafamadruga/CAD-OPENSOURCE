/**
 * Bootstrap: carrega o kernel, monta a UI e liga o ciclo paramétrico
 * (mudança de parâmetro → reavaliação do histórico → tesselação → GPU).
 */
import type { Shape3D } from "replicad";

import type { Feature } from "./features";
import { evaluate, exportSTEP, exportSTL, initKernel, tessellate } from "./kernel";
import { UI, downloadBlob } from "./ui";
import { Viewport } from "./viewport";
import "./style.css";

const app = document.querySelector<HTMLElement>("#app")!;

let currentBody: Shape3D | null = null;
let viewport: Viewport;

function rebuild(features: Feature[], ui: UI): void {
  const started = performance.now();
  const { body, errors } = evaluate(features);
  currentBody = body;
  viewport.setBody(body ? tessellate(body) : null);
  ui.showErrors(errors);

  const ms = (performance.now() - started).toFixed(0);
  if (errors.size > 0) {
    ui.setStatus(`Reconstruído com ${errors.size} erro(s) em ${ms} ms`, true);
  } else if (body) {
    ui.setStatus(`Reconstruído em ${ms} ms — ${features.length} feature(s)`);
  } else {
    ui.setStatus("Modelo vazio");
  }
}

async function start(): Promise<void> {
  await initKernel();

  const ui = new UI(app, {
    onModelChange: (features) => rebuild(features, ui),
    onExportSTL: () => {
      if (currentBody) downloadBlob(exportSTL(currentBody), "modelo.stl");
    },
    onExportSTEP: () => {
      if (currentBody) downloadBlob(exportSTEP(currentBody), "modelo.step");
    },
  });

  viewport = new Viewport(ui.viewportEl);
  ui.setStatus("Kernel pronto. Adicione uma primitiva para começar.");
}

start().catch((e) => {
  app.innerHTML = `<div id="loading"><p class="error">Falha ao iniciar: ${e}</p></div>`;
});
