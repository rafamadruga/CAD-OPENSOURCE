# CAD Open Source

CAD paramétrico de modelagem 3D que roda **no navegador** — gratuito e open-source.

![stack](https://img.shields.io/badge/stack-TypeScript%20%2B%20OpenCASCADE%20(WASM)%20%2B%20Three.js-blue)

## O que já funciona (v0.1 — MVP)

- **Kernel geométrico real**: OpenCASCADE (o mesmo do FreeCAD) compilado para WebAssembly, via [replicad](https://replicad.xyz)
- **Modelagem paramétrica com histórico**: árvore de features reavaliada a cada mudança de parâmetro (history-based modeling, como FreeCAD/SolidWorks)
- **Primitivas**: caixa, cilindro, esfera — com posição editável
- **Operações booleanas**: adicionar (fuse) e cortar (furos)
- **Fillet** (arredondamento de arestas)
- **Viewport 3D**: sombreamento + arestas técnicas, órbita/zoom/pan, convenção Z-para-cima
- **Exportação**: **STL** (impressão 3D) e **STEP** (B-rep exato, abre em qualquer CAD profissional)

## Rodando

```bash
npm install
npm run dev      # desenvolvimento — http://localhost:5173
npm run build    # produção (type-check + bundle em dist/)
```

## Arquitetura

```
src/
├── features.ts   # modelo paramétrico: tipos de feature e seus parâmetros
├── kernel.ts     # camada do kernel: OCCT/WASM, avaliação do histórico, tesselação, export
├── viewport.ts   # renderização Three.js (malha + arestas + grade + órbita)
├── ui.ts         # barra de ferramentas + árvore de features editável
└── main.ts       # bootstrap e ciclo paramétrico (editar → reavaliar → tesselar → GPU)
```

O fluxo é o de um CAD clássico em 4 camadas (ver [`docs/01-como-funciona-um-cad.md`](docs/01-como-funciona-um-cad.md)):
mudança de parâmetro → **reavaliação do histórico de features** (chamando o kernel B-rep) →
**tesselação** do B-rep exato em triângulos → renderização WebGL.

## Roadmap

- [x] Viewport 3D + primitivas do kernel
- [x] Booleanas (união/corte) e export STL/STEP
- [ ] Seleção de faces/arestas no viewport (picking)
- [ ] Sketch 2D → extrusão (o fluxo CAD "de verdade")
- [ ] Solver de restrições geométricas no sketch
- [ ] Fillet/chamfer seletivo (só nas arestas escolhidas)
- [ ] Undo/redo e salvar/abrir documento nativo
- [ ] Import STEP
- [ ] Desenho técnico 2D (projeções)

## Licença

MIT
