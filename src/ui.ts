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
} from "./features";

interface UICallbacks {
  onModelChange: (features: Feature[]) => void;
  onExportSTL: () => void;
  onExportSTEP: () => void;
  /** arestas atualmente selecionadas no viewport (para fillet seletivo) */
  getSelectedEdgeRefs: () => EdgeRef[];
}

export class UI {
  private features: Feature[] = [];
  private treeEl: HTMLElement;
  private statusEl: HTMLElement;
  private selectionEl: HTMLElement;

  constructor(root: HTMLElement, private callbacks: UICallbacks) {
    root.innerHTML = `
      <header id="toolbar">
        <span class="brand">CAD Open Source</span>
        <button data-add="box">+ Caixa</button>
        <button data-add="cylinder">+ Cilindro</button>
        <button data-cut="cylinder">− Furo cilíndrico</button>
        <button data-add="sphere">+ Esfera</button>
        <button data-cut="sphere">− Corte esférico</button>
        <button data-add="fillet">Fillet</button>
        <span class="spacer"></span>
        <button id="export-stl" title="Malha para impressão 3D">Exportar STL</button>
        <button id="export-step" title="B-rep exato, abre em qualquer CAD">Exportar STEP</button>
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
    this.features.push(createFeature(type, mode, edgeRefs));
    this.renderTree();
    this.callbacks.onModelChange(this.features);
  }

  private removeFeature(id: number): void {
    this.features = this.features.filter((f) => f.id !== id);
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
