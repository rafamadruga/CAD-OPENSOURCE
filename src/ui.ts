/**
 * Interface: barra de ferramentas + árvore de features com parâmetros
 * editáveis. Qualquer mudança dispara a reavaliação do histórico.
 */
import {
  FEATURE_SPECS,
  createFeature,
  type BooleanMode,
  type EdgeRef,
  type Feature,
  type FeatureType,
  type SketchData,
  type SketchEntity,
} from "./features";

interface UICallbacks {
  onModelChange: (features: Feature[]) => void;
  onExportSTL: () => void;
  onExportSTEP: () => void;
  /** arestas atualmente selecionadas no viewport (para fillet seletivo) */
  getSelectedEdgeRefs: () => EdgeRef[];
  onStartSketch: (kind: SketchEntity["kind"]) => void;
  onFinishSketch: (mode: BooleanMode) => void;
  onCancelSketch: () => void;
}

export class UI {
  private features: Feature[] = [];
  private treeEl: HTMLElement;
  private statusEl: HTMLElement;
  private selectionEl: HTMLElement;

  constructor(root: HTMLElement, private callbacks: UICallbacks) {
    root.innerHTML = `
      <header id="toolbar">
        <div id="toolbar-main" class="toolbar-row">
          <span class="brand">CAD Open Source</span>
          <button data-sketch="polygon" title="Desenhar um contorno no plano XY ou na face selecionada">✏ Sketch: Polígono</button>
          <button data-sketch="circle" title="Desenhar um círculo no plano XY ou na face selecionada">✏ Sketch: Círculo</button>
          <span class="divider"></span>
          <button data-add="box">+ Caixa</button>
          <button data-add="cylinder">+ Cilindro</button>
          <button data-cut="cylinder">− Furo cilíndrico</button>
          <button data-add="sphere">+ Esfera</button>
          <button data-add="fillet">Fillet</button>
          <span class="spacer"></span>
          <button id="export-stl" title="Malha para impressão 3D">Exportar STL</button>
          <button id="export-step" title="B-rep exato, abre em qualquer CAD">Exportar STEP</button>
        </div>
        <div id="toolbar-sketch" class="toolbar-row hidden">
          <span class="brand sketch-brand">✏ Modo Sketch</span>
          <span id="sketch-hint"></span>
          <span class="spacer"></span>
          <button id="sketch-pad" disabled>Extrudar (adicionar)</button>
          <button id="sketch-pocket" disabled>Cortar (pocket)</button>
          <button id="sketch-cancel">Cancelar</button>
        </div>
      </header>
      <div id="workspace">
        <aside id="panel">
          <h2>Histórico de features</h2>
          <div id="tree"></div>
          <p id="selection" class="hint">Clique numa aresta ou face do modelo para selecionar.</p>
          <p id="status"></p>
        </aside>
        <main id="viewport"></main>
      </div>
    `;

    this.treeEl = root.querySelector("#tree")!;
    this.statusEl = root.querySelector("#status")!;
    this.selectionEl = root.querySelector("#selection")!;

    root.querySelectorAll<HTMLButtonElement>("[data-add]").forEach((btn) =>
      btn.addEventListener("click", () =>
        this.addFeature(btn.dataset.add as FeatureType, "add"),
      ),
    );
    root.querySelectorAll<HTMLButtonElement>("[data-cut]").forEach((btn) =>
      btn.addEventListener("click", () =>
        this.addFeature(btn.dataset.cut as FeatureType, "cut"),
      ),
    );
    root.querySelector("#export-stl")!.addEventListener("click", callbacks.onExportSTL);
    root.querySelector("#export-step")!.addEventListener("click", callbacks.onExportSTEP);

    root.querySelectorAll<HTMLButtonElement>("[data-sketch]").forEach((btn) =>
      btn.addEventListener("click", () =>
        callbacks.onStartSketch(btn.dataset.sketch as SketchEntity["kind"]),
      ),
    );
    root.querySelector("#sketch-pad")!.addEventListener("click", () =>
      callbacks.onFinishSketch("add"),
    );
    root.querySelector("#sketch-pocket")!.addEventListener("click", () =>
      callbacks.onFinishSketch("cut"),
    );
    root.querySelector("#sketch-cancel")!.addEventListener("click", callbacks.onCancelSketch);
  }

  /** Alterna a barra para o modo sketch (ou de volta). */
  setSketchMode(active: boolean, hint = ""): void {
    document.querySelector("#toolbar-main")!.classList.toggle("hidden", active);
    document.querySelector("#toolbar-sketch")!.classList.toggle("hidden", !active);
    document.querySelector("#sketch-hint")!.textContent = hint;
    if (active) this.setSketchReady(false);
  }

  setSketchHint(hint: string): void {
    document.querySelector("#sketch-hint")!.textContent = hint;
  }

  setSketchReady(ready: boolean): void {
    document.querySelector<HTMLButtonElement>("#sketch-pad")!.disabled = !ready;
    document.querySelector<HTMLButtonElement>("#sketch-pocket")!.disabled = !ready;
  }

  /** Adiciona o par Sketch + Pad/Pocket ao histórico. */
  addSketchAndPad(sketch: SketchData, mode: BooleanMode): void {
    const sketchFeature = createFeature("sketch", "add", { sketch });
    const padFeature = createFeature("pad", mode, { sketchId: sketchFeature.id });
    this.features.push(sketchFeature, padFeature);
    this.renderTree();
    this.callbacks.onModelChange(this.features);
  }

  get viewportEl(): HTMLElement {
    return document.querySelector("#viewport")!;
  }

  setStatus(text: string, isError = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("error", isError);
  }

  setSelection(sel: { faceId: number | null; edgeIds: number[] }): void {
    if (sel.edgeIds.length > 0) {
      const n = sel.edgeIds.length;
      this.selectionEl.textContent = `${n} aresta${n > 1 ? "s" : ""} selecionada${n > 1 ? "s" : ""} — "Fillet" será aplicado só nela${n > 1 ? "s" : ""}.`;
    } else if (sel.faceId !== null) {
      this.selectionEl.textContent = "1 face selecionada.";
    } else {
      this.selectionEl.textContent = "Clique numa aresta ou face do modelo para selecionar.";
    }
  }

  /** Marca erros por feature após uma avaliação. */
  showErrors(errors: Map<number, string>): void {
    for (const f of this.features) f.error = errors.get(f.id);
    this.renderTree();
  }

  private addFeature(type: FeatureType, mode: BooleanMode): void {
    const edgeRefs =
      type === "fillet" ? this.callbacks.getSelectedEdgeRefs() : undefined;
    this.features.push(createFeature(type, mode, { edgeRefs }));
    this.renderTree();
    this.callbacks.onModelChange(this.features);
  }

  private removeFeature(id: number): void {
    // remover um sketch remove também os pads que dependem dele
    this.features = this.features.filter((f) => f.id !== id && f.sketchId !== id);
    this.renderTree();
    this.callbacks.onModelChange(this.features);
  }

  private renderTree(): void {
    this.treeEl.innerHTML = "";
    if (this.features.length === 0) {
      this.treeEl.innerHTML =
        '<p class="hint">Adicione uma primitiva na barra acima para começar.</p>';
      return;
    }

    for (const f of this.features) {
      const item = document.createElement("details");
      item.className = "feature" + (f.error ? " has-error" : "");
      item.open = f === this.features[this.features.length - 1];

      const summary = document.createElement("summary");
      summary.innerHTML = `<span>${f.name}</span>`;
      const del = document.createElement("button");
      del.textContent = "×";
      del.title = "Remover feature";
      del.className = "delete";
      del.addEventListener("click", (e) => {
        e.preventDefault();
        this.removeFeature(f.id);
      });
      summary.appendChild(del);
      item.appendChild(summary);

      if (f.error) {
        const err = document.createElement("p");
        err.className = "feature-error";
        err.textContent = `⚠ ${f.error}`;
        item.appendChild(err);
      }

      for (const spec of FEATURE_SPECS[f.type]) {
        const row = document.createElement("label");
        row.className = "param";
        row.textContent = spec.label;
        const input = document.createElement("input");
        input.type = "number";
        input.step = "1";
        if (spec.min !== undefined) input.min = String(spec.min);
        input.value = String(f.params[spec.key]);
        input.addEventListener("change", () => {
          const value = Number(input.value);
          if (Number.isFinite(value)) {
            f.params[spec.key] = spec.min !== undefined ? Math.max(spec.min, value) : value;
            input.value = String(f.params[spec.key]);
            this.callbacks.onModelChange(this.features);
          }
        });
        row.appendChild(input);
        item.appendChild(row);
      }

      this.treeEl.appendChild(item);
    }
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
