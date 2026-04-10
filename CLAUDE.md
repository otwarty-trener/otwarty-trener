# CLAUDE.md

## Zasady pakietow

**Pakiety NIGDY nie sa instalowane lokalnie.** Zawsze z npm registry.

- Przed uzyciem nowej wersji pakietu: najpierw `npm publish`, potem `npm install` z registry
- ZAKAZANE: `file:../`, `npm link`, workspace references, lokalne symlinkowanie
- Dotyczy wszystkich zaleznosci we wszystkich podprojektach

## Deploy

- Po zmianach od razu `wrangler deploy`, nie czekac na potwierdzenie
- Przy zmianach w theme: bump version w `package.json` + `layout.ts` (THEME_VERSION) + `ai.ts` (version), nie pytac

## CSS

- **Classless** — zero klas CSS, selektory strukturalne (section:has, aria-label, itemscope)
- **Jeden raz** — przeczytaj caly CSS, zaplanuj, napisz raz, publish raz. Nie iteruj.
- **Komponentowy** — kazdy komponent niesie swoj CSS w `src/styles/*.ts`, skladanie przez `composeCss()`
- **Layout w base.ts** — main (container, margin-inline:auto) to jedyne zrodlo prawdy. Komponenty NIE overriduja main. Komponent ustawia tylko swoj wlasny max-width.
- **Scoped selektory** — kazdy komponent celuje w swoj kontekst, nie w gole elementy. Np. profileCard: `section:has(> article[itemscope]) > article[itemscope]`, forms: `form:not([role="search"]) label`

## Git

- Sprawdzaj `git remote -v` przed pushem — stare nazwy repo moga wciaz siedziec w konfiguracji
