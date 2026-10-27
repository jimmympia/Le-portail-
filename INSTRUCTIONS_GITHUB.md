# Fichiers à pousser sur GitHub : jimmympia/Le-portail-

## Contenu
- `index.html` — Portail Parents V2.3.120 (messagerie, vie scolaire, matières, logo calibré)
- `icon-192.png` / `icon-512.png` — icônes PWA
- `manifest.json` — installation « Ajouter à l’écran d’accueil »

## Comment pousser (depuis un téléphone ou un PC)

### Méthode A — Interface GitHub
1. Ouvrir https://github.com/jimmympia/Le-portail-
2. Cliquer sur `index.html` → icône crayon (Edit)
3. Ou : Add file → Upload files
4. Envoyer `index.html` (remplace l’ancien)
5. Optionnel : remplacer aussi `icon-192.png`, `icon-512.png`, `manifest.json`
6. Commit message : `Mise à jour Portail Parents V2.3.120`
7. Render redéploiera automatiquement (si auto-deploy activé), sinon Manual Deploy

### Méthode B — Dossier public/
Si votre serveur lit `public/index.html` :
- Créer / mettre à jour `public/index.html` avec ce fichier
(le server.js accepte aussi `index.html` à la racine)

## Après déploiement
1. Ouvrir https://le-portail.onrender.com
2. Connexion admin (mot de passe ADMIN_PASSWORD sur Render)
3. L’URL API est détectée automatiquement (même origine)
4. Maintenance → Synchroniser

## Vérifications
- https://le-portail.onrender.com/api/health → `{"ok":true,...}`
- Créer un parent test, se connecter sur un 2e navigateur/téléphone
