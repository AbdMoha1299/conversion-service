# PDF Conversion Micro-service

Service HTTP minimaliste qui reçoit un PDF, le transforme en différentes résolutions WebP et charge les fichiers dans Supabase Storage. Il renvoie la liste des pages générées ainsi que le manifest qui pourra être consommé par la liseuse moderne.

## Pré-requis

- Node.js 18+
- Poppler installé sur la machine (`pdfinfo`, `pdftoppm`, `pdftocairo`, …). Sur macOS : `brew install poppler`. Sur Linux : `apt-get install poppler-utils`.
- ImageMagick **non** requis (on utilise `sharp` pour les conversions).
- Accès à une instance Supabase (URL + clé service role).

## Installation

```bash
cd conversion-service
npm install
cp .env.example .env
# éditez .env pour définir CONVERSION_SERVICE_SECRET et autres variables
```

## Lancement

```bash
npm run dev
# ou
npm start
```

Le serveur écoute par défaut sur `http://localhost:3000` et expose les routes :

- `POST /convert` : déclenche la conversion.
- `GET /health` : simple vérification de santé.

## Route `/convert`

### Headers

- `Content-Type: application/json`
- `X-Api-Key: <CONVERSION_SERVICE_SECRET>` (si défini dans `.env`)

### Corps JSON

```jsonc
{
  "editionId": "uuid-de-edition",
  "pdfUrl": "https://.../secured.pdf",
  "supabaseUrl": "https://your-project.supabase.co",
  "supabaseKey": "service-role-key",
  "bucket": "editions",                // facultatif, défaut: editions
  "variants": [                        // facultatif, défauts fournis
    { "key": "low", "width": 900, "quality": 72 },
    { "key": "medium", "width": 1400, "quality": 80 },
    { "key": "high", "width": 2400, "quality": 90 }
  ],
  "thumbnail": { "key": "thumbnail", "width": 360, "quality": 60 }
}
```

### Réponse (`200`)

```jsonc
{
  "success": true,
  "editionId": "uuid",
  "bucket": "editions",
  "manifestPath": "uuid/manifest.json",
  "totalPages": 12,
  "pages": [
    {
      "pageNumber": 1,
      "width": 2480,
      "height": 3508,
      "assets": {
        "low":      { "path": "uuid/pages/low/001.webp", "publicUrl": "..." },
        "medium":   { "path": "uuid/pages/medium/001.webp", "publicUrl": "..." },
        "high":     { "path": "uuid/pages/high/001.webp", "publicUrl": "..." },
        "thumbnail":{ "path": "uuid/pages/thumbnail/001.webp", "publicUrl": "..." }
      }
    },
    "..."
  ],
  "uploads": [
    "uuid/pages/low/001.webp",
    "uuid/pages/medium/001.webp",
    "..."
  ]
}
```

En cas d’échec, la réponse contient `success: false` et `error`.

## Intégration avec Supabase Edge

La fonction Edge `convert-pdf-to-images` (dans `supabase/functions/`) peut appeler ce service. Il suffit de définir la variable `PDF_CONVERSION_SERVICE_URL` côté Supabase et de transmettre l’`X-Api-Key` attendu (secret partagé). La fonction Edge se charge ensuite de mettre à jour les tables `pages`, `editions`, etc.

## Personnalisation

- **Résolutions** : ajustez le tableau `VARIANTS` dans `src/server.js` ou envoyez votre propre configuration dans le body.
- **Bucket** : par défaut `editions`, changeable via `.env` ou dans la requête.
- **Sécurité** : utilisez `CONVERSION_SERVICE_SECRET` pour restreindre l’accès (champ `X-Api-Key`).
- **Timeouts** : adaptez ceux d’axios/pipeline si nécessaire.

## Déploiement

Le service est un simple serveur Express ; vous pouvez le déployer sur n’importe quelle VM / container (Docker, Fly.io, Render, etc.). Assurez-vous que Poppler et les dépendances natives de `sharp` soient disponibles.

