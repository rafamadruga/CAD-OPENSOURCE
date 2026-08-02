# CAD Open Source

CAD paramétrico de modelagem 3D que roda **no navegador** — gratuito e open-source.

![stack](https://img.shields.io/badge/stack-TypeScript%20%2B%20OpenCASCADE%20(WASM)%20%2B%20Three.js-blue)
![licença](https://img.shields.io/badge/licen%C3%A7a-MIT-green)

Construído sobre o kernel geométrico **OpenCASCADE** (o mesmo do FreeCAD) compilado para WebAssembly via [replicad](https://replicad.xyz) — ou seja, **B-rep exato**, não malha de polígonos. O STEP exportado abre em SolidWorks, Fusion 360, FreeCAD e qualquer CAD profissional.

## 🌐 Usar agora (sem instalar nada)

**➜ https://rafamadruga.github.io/CAD-OPENSOURCE/**

Abre direto no navegador — nada para baixar ou instalar. Todo o processamento acontece na sua máquina (o modelo nunca sai do seu computador). Salve seus projetos como `.cad.json` (menu Salvar) e exporte STL para impressão 3D ou STEP para outros CADs.

## Rodando do código-fonte

```bash
npm install
npm run dev      # desenvolvimento — http://localhost:5173
npm run build    # produção (type-check + bundle em dist/)
```

## Funcionalidades

### Modelagem 3D
| Feature | Detalhes |
|---|---|
| Primitivas | Caixa, cilindro, esfera, com posição editável e booleanas add/cut |
| Pad / Pocket | Extrusão e corte de sketches, com distância paramétrica |
| Revolução (lathe) | Perfil girado em torno do eixo da vista de sketch, ângulo paramétrico |
| Loft | Transição suave entre 2+ sketches em planos com offset paramétrico |
| Casca (shell) | Oca o sólido removendo a face selecionada, espessura paramétrica |
| Fillet / Chamfer | Seletivos: só nas arestas clicadas (ou todas) |

### Sketcher 2D
- Perfis com **linhas + arcos por três pontos**, círculos, snap de 1 mm, desfazer ponto
- Desenho no plano XY ou **sobre qualquer face plana selecionada** (o sketch acompanha a face quando o modelo muda)
- **Edição de sketch existente** preservando as operações dependentes
- **Solver de restrições geométricas** (`src/solver.ts`, Gauss-Newton amortecido com jacobiano numérico): Horizontal, Vertical, Cota, Fixar, Paralela, Perpendicular, Igual — com graus de liberdade ao vivo, **rejeição de restrições conflitantes** e anotações renderizadas no desenho (valores de cota, H, V, ∥, ⊥, =, ⚓)

### Interoperabilidade
- **Import STEP**: peças de outros CADs entram no histórico como feature paramétrica (posição editável, participa de booleanas); o arquivo fica serializado dentro do documento
- **Export STEP** (B-rep exato) e **STL** (impressão 3D)
- **Desenho técnico 2D** em SVG: projeções frente/topo/lateral com linhas ocultas tracejadas, escala uniforme, **cotas com setas** e **tabela de furos** detectados no B-rep — pronto para imprimir

### Fundamentos
- **Histórico paramétrico**: mudou um parâmetro, o modelo inteiro reconstrói (tipicamente < 200 ms)
- **Referências topológicas estáveis**: mitigação do *topological naming problem* em arestas, faces e planos de sketch (impressão digital geométrica + fallback por índice, re-resolvidos a cada reconstrução)
- **Picking**: clique em faces/arestas no viewport, mapeado de volta às entidades do B-rep
- **Undo/Redo** (Ctrl+Z / Ctrl+Shift+Z) e **documento nativo** `.cad.json` auto-contido
- Viewport Three.js com sombreamento + arestas técnicas, órbita/zoom/pan, Z para cima

## Arquitetura

```
src/
├── features.ts   # modelo paramétrico: tipos de feature, sketch e referências topológicas
├── kernel.ts     # camada do kernel: OCCT/WASM, avaliação do histórico, tesselação, import/export
├── solver.ts     # solver de restrições geométricas 2D (Gauss-Newton / Levenberg-Marquardt)
├── viewport.ts   # Three.js: renderização, picking, modo sketch com preview e anotações
├── drawing.ts    # desenho técnico: projeções ortográficas, cotas e tabela de furos (SVG)
├── ui.ts         # barra de ferramentas, árvore de features, undo/redo, salvar/abrir
└── main.ts       # bootstrap e ciclo paramétrico (editar → reavaliar → tesselar → GPU)
```

O fluxo é o de um CAD clássico em 4 camadas (ver [`docs/01-como-funciona-um-cad.md`](docs/01-como-funciona-um-cad.md), o documento de pesquisa que fundamentou o projeto): mudança de parâmetro → **reavaliação do histórico de features** (chamando o kernel B-rep) → **tesselação** do B-rep exato em triângulos → renderização WebGL.

## Roadmap

- [ ] Restrições de tangência e ângulo no solver (envolvem arcos)
- [ ] Sweep ao longo de um caminho
- [ ] Posições dos furos cotadas nas vistas do desenho 2D
- [ ] Espelhamento e padrões (linear/circular) de features
- [ ] Montagens (múltiplos corpos com posicionamento)
- [x] Deploy hospedado (GitHub Pages, automático a cada push na `main`)

## Testes

Cada funcionalidade é validada por testes E2E em Chromium headless (Playwright) contra o build de produção: modelagem, edição paramétrica, solver (convergência a erro ~1e-16 e rejeição de conflitos), roundtrip STEP, undo/redo, documento nativo e geração do desenho técnico.

## Licença

MIT
