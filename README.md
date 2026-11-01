# Site + serveur + tableau de bord (tout est relié)

## Fichiers (tout est dans le dossier livré)
```
server.js          le serveur (API, base de données, Stripe)
seed.json          catalogue de départ (copie des produits de index.html)
package.json
.env.example       les variables à remplir sur Railway
public/
  index.html       le site client
  admin.html       le tableau de bord  ->  https://TON-SITE/admin.html (mot de passe = ADMIN_KEY)
docker-compose.yml base PostgreSQL locale pour tester
```

## Comment tout est relié
| Dans l'admin | Effet sur le site client |
|---|---|
| Catalogue : prix, nom, ancien prix, badge, image, description | Changé sur le site en < 20 s |
| Catalogue : Masquer / Afficher | Le produit disparaît / revient |
| Catalogue : nouveau produit (section Menu, Enfant ou Tunisien) | Apparaît dans la bonne page |
| Stock : bouton + (le produit devient « suivi ») | À 0 : « Épuisé », commande bloquée. ≤ 5 : « Plus que X » |
| Stock : − / Perte / Remise à zéro | Le site se met à jour |
| Commande payée sur le site | Stock −1 par article, commande dans « Commandes » + alerte |
| Commande passée en « Annulé » | Les articles retournent en stock |
| Statut Expédié / Livré | Le client le voit dans « Mes commandes » |
| Street vente (caisse) | Stock −1, visible dans Journal / Récap avec le site |

Sécurité : le prix payé est recalculé par le serveur (jamais pris du navigateur) et le stock est vérifié avant le paiement.

## Mise en ligne sur Railway
1. Mets tout sur GitHub (sans .env) puis Railway → Deploy from GitHub.
2. **+ New → Database → PostgreSQL** (DATABASE_URL arrive toute seule).
3. Variables : `JWT_SECRET`, `ADMIN_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SMTP_*`, `MAIL_FROM`.
4. Stripe → Webhooks → `https://TON-SITE/api/stripe-webhook`, événement `payment_intent.succeeded`.
5. Au premier démarrage, les 29 produits de `seed.json` sont créés dans l'admin.

## Important
- Un produit ajouté directement dans index.html n'est PAS vendable (le serveur le refuse) : ajoute-le dans admin → Catalogue.
- Stock « non suivi » = toujours disponible (cas de départ). Il devient suivi dès que tu fais « + » dans Stock.
- Seul le paiement par carte (Stripe) crée une commande. PayPal / Apple Pay / Google Pay ouvrent un lien externe et ne sont pas reliés.
- Test en local avec une vraie base : `docker compose up -d`, copie `.env.example` en `.env`, puis `npm install` et `node --env-file=.env server.js` (Node 20+).
- **Formules** : le prix d'un « Maxi Menu », « 9 pièces », « Grande »… = prix du produit + un supplément. Les suppléments sont dans le tableau `SUPPLEMENTS` en haut de `server.js` (valeurs de départ à régler).
- Supprimer un produit dans l'admin le retire aussi du seed : il ne revient plus au redémarrage.
- La base (tables) se crée toute seule au premier démarrage, rien à installer à la main.

## Admin : onglets
Commandes · Cuisine (ouverture, précommandes, temps de préparation) · Street vente (caisse avec formules et photos) · Stock · Catalogue · Journal / Récap · Gestion (photos et documents) · HACCP (factures, fournisseurs, retards) · Paramètres · Clients.
Les photos/documents sont réduits (≈ 1400 px) puis gardés dans PostgreSQL. Mets ton logo dans `public/logo.png` pour l'afficher dans l'en-tête de l'admin.
