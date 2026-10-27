# Administrateurs multiples (principal & vice-principal)

## Après déploiement du nouveau server.js

Sur **Render** → service le-portail → **Environment**, ajoutez par exemple :

### Option recommandée
```
PRINCIPAL_USERNAME=principal
PRINCIPAL_PASSWORD=ChoisissezUnMotDePasseFort
PRINCIPAL_NAME=Principal
VICE_USERNAME=vice
VICE_PASSWORD=AutreMotDePasseFort
VICE_NAME=Vice-principal
```

### Ou en une seule ligne
```
EXTRA_ADMINS=principal:MotPrincipal,vice:MotVice
```

Puis **Save** + **Manual Deploy**.

## Connexion
| Personne | Identifiant | Mot de passe |
|----------|-------------|--------------|
| Administration (TI / secrétariat) | `admin` | `ADMIN_PASSWORD` |
| Principal | `principal` (ou PRINCIPAL_USERNAME) | PRINCIPAL_PASSWORD |
| Vice-principal | `vice` (ou VICE_USERNAME) | VICE_PASSWORD |

Tous ont les **mêmes droits administrateur** (parents, classes, sync, etc.).

## Changer un mot de passe plus tard
1. Modifier la variable sur Render
2. Ajouter temporairement `RESET_EXTRA_ADMINS=true`
3. Redéployer
4. Retirer `RESET_EXTRA_ADMINS`

## Fichier à pousser sur GitHub
Remplacer `server.js` à la racine du dépôt **Le-portail-** par ce fichier, commit, deploy Render.
