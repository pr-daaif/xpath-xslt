# XPath / XSLT Lab

Bac à sable web pour tester des expressions **XPath 3.1** et des feuilles **XSLT 3.0** avec le moteur
[SaxonJS](https://www.saxonica.com/saxon-js/) (paquet npm `saxon-js`, le moteur de `xslt3`).

- `mondial.xml` ([Mondial](https://www.dbis.informatik.uni-goettingen.de/Mondial/), Univ. Göttingen) est chargé par défaut.
- Les étudiants peuvent téléverser leurs propres fichiers XML (5 Mo max) : ils deviennent sélectionnables par tous.
- L'enseignant peut supprimer un fichier partagé via le bouton **Admin** (mot de passe `ADMIN_PASSWORD`).
- Onglet **XPath** : résultat item par item, avec le type XDM (`element(name)`, `xs:integer`, `map(*)`…), le nombre d'items et la durée.
- Onglet **XSLT** : aperçu HTML (iframe isolée), source, `xsl:message`, documents secondaires (`xsl:result-document`).
- Panneau **Structure** (chemins du document avec nombre d'occurrences, cliquables), exemples, historique, espaces de noms.

## Architecture

```
navigateur (Vite + CodeMirror)  ──HTTP──▶  Express (server/index.js)
                                              ├─ storage.js   fichiers partagés : data/index.json + data/files/<uuid>.xml
                                              └─ pool.js      N processus server/evaluator.js (SaxonJS)
```

L'évaluation se fait côté serveur, dans des processus enfants isolés. Chaque processus garde en cache
les documents déjà analysés (mondial.xml n'est parsé qu'une fois).

### Sécurité

SaxonJS permet d'appeler du JavaScript depuis XPath/XSLT (`ixsl:eval`, `js:*`), et de lire des fichiers
(`doc()`, `unparsed-text()`). Comme les expressions viennent des étudiants, plusieurs protections sont empilées :

1. **Permission Model de Node** (`--permission`) sur les évaluateurs : aucune écriture disque, aucun processus
   enfant, lecture limitée à `node_modules`, `builtin/` et `data/files/`.
2. **JavaScript neutralisé** dans l'évaluateur : constructeurs `Function` bloqués, `process`, `fetch`, `eval`… retirés.
3. **Filtre** des préfixes et espaces de noms `ixsl` / `js` (message clair pour l'étudiant).
4. **Délai maximal** (10 s par défaut) et **limite mémoire** : le processus est tué puis relancé.
5. Variables d'environnement vides dans les évaluateurs (le mot de passe admin n'y est pas visible).
6. Les fichiers téléversés sont servis en `text/plain` avec une CSP `sandbox` ; l'aperçu HTML XSLT est
   affiché dans une iframe `sandbox` sans scripts.
7. Limitation de débit (évaluations, téléversements, tentatives admin) et conteneur Docker en lecture seule,
   sans privilèges.

## Développement

```bash
npm install
npm run dev        # API sur :3000 + Vite sur http://localhost:5173
```

Pour tester la production en local : `npm run build && ADMIN_PASSWORD=secret npm start` → http://localhost:3000

## Déploiement avec Dokploy

1. **Create Service → Compose**, source *GitHub* (ou *Git* : `https://github.com/pr-daaif/xpath-xslt.git`),
   branche `main`, fichier `docker-compose.yml`.
2. Onglet **Environment** : `ADMIN_PASSWORD=…` (obligatoire), et si besoin `POOL_SIZE`, `EVAL_TIMEOUT_MS`…
3. Onglet **Domains** : service `xpath-lab`, port **3000**, HTTPS activé (Let's Encrypt).
4. **Deploy**. Les fichiers partagés sont conservés dans le volume `xpath-data` entre deux déploiements.

Les étudiants passent par Traefik : `TRUST_PROXY=1` (valeur par défaut du compose) permet d'identifier leur IP réelle.

### Sans Dokploy

`docker compose up -d --build` puis un reverse proxy HTTPS (nginx, Caddy) vers le port 3000 du conteneur
(ajoutez `ports: ["127.0.0.1:3000:3000"]` au service). Prévoir `client_max_body_size 6m` côté nginx.

### Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `ADMIN_PASSWORD` | *(vide = suppression désactivée)* | Mot de passe du mode Admin |
| `PORT` | `3000` | Port HTTP |
| `DATA_DIR` | `./data` | Dossier des fichiers partagés |
| `TRUST_PROXY` | `loopback` (`1` dans compose) | Réglage `trust proxy` d'Express, pour l'IP réelle des étudiants |
| `POOL_SIZE` | 2 à 4 selon les CPU | Nombre d'évaluateurs en parallèle |
| `EVAL_TIMEOUT_MS` | `10000` | Délai maximal d'une évaluation |
| `EVAL_MEMORY_MB` | `768` | Mémoire maximale d'un évaluateur |
| `MAX_UPLOAD_MB` | `5` | Taille maximale d'un fichier téléversé |
| `MAX_FILES` | `200` | Nombre maximal de fichiers partagés |
| `MAX_RESULT_ITEMS` | `1000` | Items affichés au maximum par résultat XPath |

## Licences

- **SaxonJS** © Saxonica Ltd., redistribué sous la [licence Saxonica](node_modules/saxon-js/LICENSE.txt)
  (redistribution autorisée en binaire non modifié, avec mention du copyright).
- **Mondial** : base de données de Wolfgang May, Université de Göttingen, utilisée à des fins d'enseignement.
