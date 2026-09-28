# Changesets

Este diretório gerencia o versionamento e o changelog do pacote.

Fluxo:

1. Toda PR com mudança de comportamento adiciona um arquivo `*.md` aqui
   (`npx changeset`) descrevendo a mudança e o tipo de bump (patch/minor/major).
2. Ao mergear na `main`, o workflow **Release** (`changesets/action`) abre ou
   atualiza uma PR "chore: version packages".
3. Ao mergear essa PR de versão, o publish é disparado no npm com provenance.