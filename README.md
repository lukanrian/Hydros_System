# Hydros System

Aplicativo Windows em desenvolvimento para dimensionamento predial de água fria, água quente e alimentação. O primeiro corte importa a geometria hidráulica de IFC4 e permite inspecioná-la em 3D; os cálculos ainda não estão habilitados.

## Executar

Requisitos: Windows, .NET 10 SDK e Microsoft Edge WebView2 Runtime.

```powershell
dotnet build Hydros.System.sln
dotnet run --project src/Hydros.System.UI/Hydros.System.UI.csproj
```

É possível abrir um IFC diretamente ao iniciar: `dotnet run --project src/Hydros.System.UI/Hydros.System.UI.csproj -- "C:\caminho\modelo.ifc"`. Também há o botão **Abrir IFC**.

A prévia mostra segmentos de tubulação, conexões, válvulas, bombas e medidores reconhecidos pelo IFC. Use o painel **Projeto** para alternar água fria, água quente e alimentação; no modo alimentação é exibido o campo de pressão dinâmica da concessionária e o destino. Essas entradas ainda não acionam dimensionamento nesta versão.

O viewer deriva do padrão Three.js/WebGL e `camera-controls` do Dimensionador Tipo Grelha. As bibliotecas distribuídas e suas licenças estão em `src/Hydros.System.UI/Web/lib`. O app original, os IFCs, catálogos, normas e as pranchas de referência em `PROJETOS MODELO/` não são alterados nem incluídos no Git.

As pranchas ajudam a conferir nomes de sistemas, tags de ramais/colunas, símbolos e materiais declarados em cada projeto. Informações particulares das pranchas (diâmetros, vazões, pressões, bombas e soluções adotadas) não são premissas, coeficientes nem oráculo dos cálculos do Hydros System. Os critérios de cálculo devem vir da norma aplicável, dos dados do fabricante e das entradas aprovadas para o projeto em análise.
