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
- A implementação atual resolve redes em árvore com um caminho de alimentação por nó. Ambiguidades, pontas abertas na rede alcançada e ciclos nessa rede bloqueiam o cálculo com motivo; trechos de componentes desconectados são excluídos e reportados. Circuitos fechados não suportados ou condições não identificáveis também devem ser bloqueados.
- Água quente inclui distribuição e retorno hidráulico. Energia do aquecedor permanece fora do escopo aprovado da primeira versão.
- Recirculação: o IFC deve classificar explicitamente as redes de distribuição e retorno. As alças são derivadas dos nós confirmados compartilhados pelas duas redes até o aquecedor selecionado; não se criam ligações por proximidade nem se aceita retorno aberto.
- Para cada tubo que participa das alças, exigir perda térmica linear informada (W/m), comprimento e fonte; exigir ΔT positivo entre saída do aquecedor e retorno. A perda de cada tubo é `W/m × comprimento`. Calcular a vazão da alça por `Q/(ρ·cp·ΔT)` (cp = 4186 J/kg·K; ρ pela temperatura informada). Perdas de tubos atendendo mais de uma alça são rateadas proporcionalmente às perdas exclusivas, como no método de referência RecircMP.
- A vazão em tubo compartilhado é a soma das alças que o percorrem. Calcular a perda do circuito pela Darcy–Weisbach e usar a maior perda como altura requerida de circulação; a diferença para cada alça menos desfavorável é a perda adicional necessária para balanceá-la. O resultado não escolhe válvula nem bomba sem dados de fabricante.
- Alimentação: destino configurável entre reservatório e rede direta; pressão residual dinâmica informada na vazão de projeto. Para reservatório, conferir também reposição diária conforme 6.7.2.
- Nenhum resultado é apresentado como dimensionamento concluído enquanto houver conexões pendentes, demanda ou propriedade física necessária ausente, método de vazão não registrado, caminho fechado ou pressão de fronteira incompleta.

## Próximos 10 passos de implementação

1. [x] Mapear cláusulas da norma aos requisitos de dados e verificações, sem usar os desenhos/memoriais como regra.
2. [x] Preservar as entradas de fronteira da alimentação por arquivo e solicitar pressão dinâmica e máxima estática da concessionária.
3. [x] Representar os pontos de utilização e coletar vazões de projeto explícitas com origem/unidade.
4. [x] Extrair material associado e propriedades de diâmetro/comprimento do IFC com unidade; avisar quando diâmetro interno ou comprimento válido estiver ausente.
5. [x] Transformar as conexões confirmadas em grafo de nós/trechos e mostrar extremidades abertas e componentes desconectados.
6. [x] Permitir selecionar a fonte no modelo 3D e guardar carga total/cota por rede; na alimentação, guardar pressões da concessionária e vazão de referência.
7. [x] Distribuir vazões explícitas marcadas em um cenário simultâneo por rede em árvore, agregando a demanda a jusante de cada trecho; bloquear conexão ambígua, ponta solta na rede alcançada, ciclo ou dado necessário ausente. Componentes desconectados são sinalizados e excluídos do cálculo.
8. [x] Calcular perdas distribuídas e localizadas e pressões/velocidades por trecho quando diâmetro, comprimento, rugosidade, K e temperatura estiverem informados com fonte; bloquear dados ausentes. Fator de atrito Churchill; Darcy–Weisbach.
9. [x] Água fria e alimentação direta/reservatório têm verificações iniciais. Água quente calcula recirculação por perdas térmicas e ΔT quando o IFC identifica retorno/alças; 056-MARLUCI não tem retorno explícito e segue parcial nesse modo. A reposição ao reservatório usa volume diário/tempo explicitados e limites de até 6 h (3 h unifamiliar).
10. [x] O seletor lista 24 modelos/famílias WDM/Rowa e exibe os gráficos originais do catálogo Rowa 2026 quando as imagens estão na instalação local (não são versionadas); só WDM VPI1 EEP 1.5 15 (1,5 cv) tem curva tabulada para avaliação automática. Relatório JSON e memorial editável em Word (.docx) disponíveis. Curvas Rowa digitalizadas, seleção de válvula de balanceamento e compatibilidade completa/NPSH permanecem pendentes.

## Limites

- Dados de pranchas e memoriais de exemplo podem ajudar a reconhecer nomes, elementos e apresentação. Não são usados para demanda, fatores, coeficientes, rugosidade, perda, pressão de referência, desempenho de bomba ou validação numérica.
- Catálogo de bomba só pode abastecer a seleção após extração de curva com modelo, unidade, página e faixa de validade identificados.
- A primeira curva integrada é do sistema pressurizador WDM VPI1 EEP 1.5 15 (uma bomba) e sua triagem não substitui verificação de tensão, temperatura, sucção/NPSH, instalação nem validação do fabricante.
- Nenhum dos três IFCs fornecidos explicita uma rede de retorno de água quente. O cálculo de recirculação exige que outros IFCs identifiquem ida e retorno e fechem as alças pelas conexões confirmadas; sem isso, o programa mantém o resultado parcial.
- A perda adicional calculada para balanceamento é uma meta hidráulica. A válvula, seu Kv/faixa de operação e a curva da bomba circuladora precisam de dados tabulados do fabricante antes de seleção final.
- Resultados são ferramenta de apoio e precisam deixar entradas, hipóteses, avisos e fonte normativa explícitos para revisão profissional.
- Verificação desta revisão: build sem erros/avisos, 46 testes automatizados passando; os testes de recirculação usam uma rede sintética com ida, retorno, troncos comuns e duas alças. Os IFCs fornecidos não identificam retorno e não validam esse modo com um modelo real. Inspeção visual do viewport não foi executada.
