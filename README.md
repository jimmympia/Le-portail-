# Portail Parents — serveur central (CST Manjo)

Un seul service qui fait deux choses : il **héberge l'application** (dossier `public/`) et il **fournit l'API** `/api/...` pour que parents, enseignants, surveillant et administration échangent messages et bulletins entre leurs téléphones.

- Aucune dépendance obligatoire (Node 18+). Le module `pg` n'est utilisé que si `DATABASE_URL` est défini.
- Les parents ne reçoivent que **leurs** données ; les enseignants que celles de **leurs** classes. Aucun hachage de mot de passe n'est jamais envoyé à un téléphone non administrateur.
- Mots de passe stockés avec scrypt côté serveur. Sessions de 12 h. Blocage après 8 essais ratés (10 min).

---

## Déploiement gratuit depuis un téléphone (Render + Neon)

### 1. Mettre les fichiers sur GitHub
1. Créez un dépôt, par exemple `portail-parents-serveur`.
2. Envoyez **tous** les fichiers de ce dossier en gardant l'arborescence : `server.js`, `store.js`, `package.json`, `render.yaml`, `.gitignore`, `README.md` à la racine, et `index.html`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png` **dans un dossier `public/`** (sur GitHub : *Add file → Upload files* ou *Create new file* avec le nom `public/index.html`).

### 2. Base de données gratuite (les données survivent aux redémarrages)
1. Compte sur **neon.tech** → *Create project*.
2. Copiez la *Connection string* (elle commence par `postgresql://`).

> Sans base de données, le serveur écrit dans un fichier : sur l'offre gratuite de Render ce fichier est **effacé à chaque redémarrage**. Pour un essai seulement.

### 3. Créer le service sur Render
1. **render.com** → *New + → Web Service* → choisissez votre dépôt.
2. Runtime **Node**, *Build command* `npm install --omit=dev`, *Start command* `node server.js`, plan **Free**.
3. *Environment* → ajoutez :
   - `ADMIN_PASSWORD` = le mot de passe de l'administrateur (long, personnel)
   - `DATABASE_URL` = la chaîne copiée depuis Neon
4. *Create Web Service*. Au bout de quelques minutes vous obtenez une adresse `https://xxxx.onrender.com`.

### 4. Premier démarrage
1. Ouvrez l'adresse sur le téléphone de l'administrateur → connexion `admin` + `ADMIN_PASSWORD`.
   L'application se connecte **automatiquement** au serveur (rien à saisir dans « Serveur central »).
2. Créez/importez comme d'habitude enseignants, parents, classes, professeurs principaux. À chaque synchronisation le serveur **crée et met à jour les comptes tout seul** (le bouton de création de comptes devient facultatif).
3. Les enseignants se connectent avec leur nom (ou e-mail) et leur mot de passe, les parents avec leur numéro de téléphone (mot de passe = le numéro, comme avant).

### 5. Distribuer aux téléphones
- **Lien** : envoyez `https://xxxx.onrender.com` ; sur Android, menu du navigateur → *Installer l'application*.
- **APK** : PWABuilder avec cette même adresse (le manifest et le service worker sont inclus).

---

## À savoir

| Sujet | Détail |
|---|---|
| Veille | Render gratuit s'endort après 15 min sans visite : la première ouverture peut prendre ~30–60 s. Un ping gratuit (UptimeRobot) sur `/api/health` toutes les 10 min l'évite. |
| Sauvegarde | Les données sont dans Neon. Gardez aussi la sauvegarde JSON de l'application (Profil → Sauvegarde). |
| Mot de passe admin perdu | Sur Render : `RESET_ADMIN=true` + nouveau `ADMIN_PASSWORD`, redéployez, puis retirez `RESET_ADMIN`. |
| Un seul administrateur actif | Si un 2ᵉ appareil administrateur est resté hors ligne pendant que le premier modifiait des données, il récupère la version du serveur (un message l'indique). |
| Serveur remis à zéro | Si la base est vide mais qu'un appareil administrateur a déjà des données, ses données **repeuplent** le serveur à sa prochaine synchronisation. |
| Session expirée | Après 12 h, l'application affiche « Session expirée » : se déconnecter puis se reconnecter. |
| Taille | Corps de requête limité à 30 Mo (`MAX_BODY_MB`). Les bulletins PDF sont stockés dans la base. |

## Variables d'environnement

`ADMIN_PASSWORD` · `DATABASE_URL` · `ADMIN_USERNAME` (défaut `admin`) · `RESET_ADMIN` · `ALLOWED_ORIGINS` (défaut `*`) · `MAX_BODY_MB` · `DATA_DIR` (mode fichier) · `PGSSL=disable` (base locale sans SSL) · `PORT`

## Essai en local

```
ADMIN_PASSWORD=MonMotDePasse node server.js     # http://localhost:3000
npm test                                        # 53 vérifications de l'API
```

## Routes

`GET /api/health` · `POST /api/auth/login` · `POST /api/auth/logout` · `POST /api/auth/password` · `POST /api/sync` · `POST /api/messages` · `POST /api/messages/:id/read` · `POST /api/notifications/sync` · `POST /api/admin/users/provision`
