# Hydros System – instruções de continuidade

- Após cada atualização de código, atualize o grafo do Graphify (`graphify-out/graph.json` e `graph.html`) e o relatório (`GRAPH_REPORT.md`). Preserve nós curados; não force uma reconstrução que os remova.
- Em cada atualização, crie ou atualize um arquivo `.docx` de handoff com as mudanças, pendências e próximos passos objetivos para o próximo agente.
- Se o comando incremental do Graphify falhar por risco de perda de nós, mantenha o grafo existente, atualize as relações comprovadas pelas fontes e regenere a visualização/relatório; registre a limitação no handoff.
- Quando o usuário digitar `/graphify`, siga as instruções da skill Graphify instalada antes de qualquer outra ação.
