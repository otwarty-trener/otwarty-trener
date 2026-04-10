# CLAUDE.md

## Zasady pakietow

**Pakiety NIGDY nie sa instalowane lokalnie.** Zawsze z npm registry.

- Przed uzyciem nowej wersji pakietu: najpierw `npm publish`, potem `npm install` z registry
- ZAKAZANE: `file:../`, `npm link`, workspace references, lokalne symlinkowanie
- Dotyczy wszystkich zaleznosci we wszystkich podprojektach (landing, ceidg-sync, itd.)
