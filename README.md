# ⚡ E-Charge — PWA Android 1 main + Voix → Google Sheets

Application web installable (PWA) conçue pour enregistrer rapidement d'une seule main (ou à la voix en français de Belgique `fr-BE`) vos séances de charge de véhicules électriques directement dans Google Sheets.

- **Application en ligne (PWA)** : https://marc1850be.github.io/e-charge/

## Fonctionnalités
- Interface pensée pour la **zone du pouce** (mode droitier / gaucher, thème sombre/clair auto)
- **Dictée vocale `fr-BE`** (`septante` / `nonante`, kilométrage, `%`, autonomie, bornes fréquentes)
- **Détection automatique** d'une charge en cours + clôture en 1 tap sans noter la fin (`⏭`) si vous avez oublié
- **Mode hors-ligne** (file d'attente locale avec synchronisation automatique dès le retour du réseau)
- **Respect des formules Google Sheets** existantes et protection de la ligne `Bilan`

## Mise en place
1. Collez le script modèle `apps-script/Code.gs.example` dans **Extensions → Apps Script** de votre Google Sheet, adaptez `CONFIG` et déployez en **Application Web**.
2. Ouvrez https://marc1850be.github.io/e-charge/ dans **Chrome sur Android**.
3. Dans **⚙️ Réglages**, entrez votre URL Apps Script + votre code PIN, puis **Installer l'application** depuis le menu Chrome (`⋮`).
