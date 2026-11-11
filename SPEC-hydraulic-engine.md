# Spec: hydraulic-core — auditável, com dados explícitos

## Objetivo

Calcular vazões, perdas de carga e pressões por trecho para água fria, água quente e alimentação, mantendo a origem de cada dado e bloqueando resultados quando faltarem entradas necessárias. Os memoriais e as pranchas de projeto não fornecem critérios ou valores padrão.

## Regras normativas mapeadas

Base disponível: cópia local da ABNT NBR 5626:2020. Confirmar edição e eventuais erratas/emendas no Catálogo ABNT antes de uma distribuição oficial.

| Requisito | Referência | Consequência no programa |
|---|---|---|
| Vazões de utilização explícitas | 6.7.1.1–6.7.1.2 | O projetista informa a vazão máxima de cada ponto considerado em uso. Não presumir simultaneidade. |
| Vazão por trecho com método reconhecido ou fundamentado | 6.14.1–6.14.2 | Registrar método e dados usados para agregar demandas em cada trecho. |
| Diâmetro depende de vazão, velocidade, material, perdas e pressão requerida | 6.14.3 | Diâmetro interno e material precisam ser verificados; o nominal do IFC não é tomado como interno. |
| Equações pertinentes; Darcy-Weisbach é a mais indicada | 6.14.4 | Perda distribuída pela equação universal; perdas localizadas exigem K ou dado verificável do componente. |
| Pressão dinâmica de aparelho segundo fabricante; piso de 10 kPa | 6.9.1–6.9.2 | Usar requisito do aparelho quando informado; mostrar o piso normativo como alerta mínimo, não como substituto da especificação do fabricante. |
| Pressão dinâmica mínima na rede | 6.9.3–6.9.4 | Verificar 5 kPa com as exceções normativas identificadas. |
| Pressão estática máxima nos pontos de utilização | 6.9.5 | Verificar limite de 400 kPa em condição sem escoamento. |
| Pressões fria/quente próximas no misturador | 6.9.6 | Comparar entradas de misturadores quando ambas as redes estiverem dimensionadas. |
| Velocidade, ruído, cavitação e golpe de aríete | 6.8.1–6.8.5 | Reportar velocidade e advertências; 3 m/s é referência de limitação dos picos, não garantia contra golpe de aríete. |
| Retorno de água quente, acionamento e balanceamento | 6.6.4–6.6.5 | Modelar retorno e exigir balanceamento quando houver dois ou mais ramais de retorno. |
| Alimentador: pressão mínima e máxima da fonte | 6.5.3.1 | Solicitar pressão residual dinâmica na vazão de projeto e pressão máxima estática da concessionária. |
| Reposição do volume diário do reservatório | 6.7.2 | Para alimentação a reservatório, usar volume diário e tempo de reposição definidos para o projeto. |

## Contrato de cálculo

- Unidades internas: m, m³/s, Pa, kg/m³, Pa·s; conversões visíveis no resultado.
- Cada trecho: origem/destino revisados, comprimento medido ou informado, diâmetro interno, material, rugosidade de fonte identificada, coeficiente K e vazão de projeto.
- Cada ponto de utilização: classe/aparelho, vazão máxima de projeto e pressão de operação requerida; guardar autor, unidade, origem e revisão.
- Cada condição de contorno: fonte, cota/nível, pressão/vazão ou carga total; nenhum zero inserido como substituto de dado ausente.
- Primeira implementação pode resolver redes em árvore com um caminho de alimentação por nó. Circuitos fechados ou condições não identificáveis devem ser bloqueados com motivo até haver solver de malha.
- Água quente inclui distribuição e retorno hidráulico. Energia do aquecedor permanece fora do escopo aprovado da primeira versão.
- Alimentação: destino configurável entre reservatório e rede direta; pressão residual dinâmica informada na vazão de projeto. Para reservatório, conferir também reposição diária conforme 6.7.2.
- Nenhum resultado é apresentado como dimensionamento concluído enquanto houver conexões pendentes, demanda ou propriedade física necessária ausente, método de vazão não registrado, caminho fechado ou pressão de fronteira incompleta.

## Próximos 10 passos de implementação

1. [x] Mapear cláusulas da norma aos requisitos de dados e verificações, sem usar os desenhos/memoriais como regra.
2. [x] Preservar as entradas de fronteira da alimentação por arquivo e solicitar pressão dinâmica e máxima estática da concessionária.
3. [x] Representar os pontos de utilização e coletar vazões de projeto explícitas com origem/unidade.
4. [x] Extrair material associado e propriedades de diâmetro/comprimento do IFC com unidade; avisar quando diâmetro interno ou comprimento válido estiver ausente.
5. [x] Transformar as conexões confirmadas em grafo de nós/trechos e mostrar extremidades abertas e componentes desconectados.
6. [ ] Permitir selecionar fonte, cota/nível e condição de contorno de cada rede.
7. [ ] Calcular vazões em redes radiais a partir das vazões explícitas dos pontos e registrar o método.
8. [ ] Calcular perdas distribuídas e localizadas, pressões e velocidades por trecho com avisos de dado ausente.
9. [ ] Habilitar os modos fria/quente/alimentação e suas verificações específicas, incluindo retorno de água quente.
10. [ ] Integrar curvas de fabricante verificáveis, seleção de bomba e relatório/memorial rastreável.

## Limites

- Dados de pranchas e memoriais de exemplo podem ajudar a reconhecer nomes, elementos e apresentação. Não são usados para demanda, fatores, coeficientes, rugosidade, perda, pressão de referência, desempenho de bomba ou validação numérica.
- Catálogo de bomba só pode abastecer a seleção após extração de curva com modelo, unidade, página e faixa de validade identificados.
- Resultados são ferramenta de apoio e precisam deixar entradas, hipóteses, avisos e fonte normativa explícitos para revisão profissional.
