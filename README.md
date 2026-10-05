# Blind test multijoueur (façon PopSauce)

Un extrait de 30 s, tous les joueurs tapent en même temps. Le premier au score cible gagne.

## Thèmes (tout est chargé en ligne, plusieurs au choix par partie)

L'hôte coche autant de thèmes qu'il veut. À chaque extrait, un thème est tiré au hasard parmi ceux cochés
(ils sont donc représentés à parts égales), et dans ce thème les éléments populaires sortent en priorité.
Une playlist Deezer perso peut s'ajouter comme un thème de plus.

| Groupe | Thèmes | À trouver | Source |
|---|---|---|---|
| Musique | Rap FR, Variété française, Années 80 / 90 / 2000 / 2010, Rap US, Pop internationale, Rock / Métal, Électro / Dance, Afro / Latino, K-pop, Hits du moment | l'artiste ET le titre (3 / 2 / 1 pts chacun) | playlists Deezer trouvées par recherche, ou classement Deezer |
| Écrans | Films, Séries, Disney / Pixar, Jeux vidéo | le nom de l'œuvre (6 / 4 / 2 pts) | BO sur Deezer, nom tiré du titre de l'album ; titres français via Wikidata |
| Anime | Openings, Endings | le nom de l'anime (6 / 4 / 2 pts) | top 500 MyAnimeList (sinon AniList, Kitsu, Jikan) + AnimeThemes |

Pour ajouter un thème : une ligne dans `THEMES` (`lib/online.js`), avec ses mots-clés de recherche Deezer.

**Filtre par période** : l'hôte peut limiter films, séries et anime à une période (depuis 2000, années 90…).
L'année vient de Wikidata pour les films et séries (ou, à défaut, de la date de sortie de l'album de BO sur Deezer), d'AniList/MyAnimeList pour les anime.
Le rap et les hits ne sont pas filtrés.

Pour élargir une catégorie, ajoute des recherches dans `QUERIES` (`lib/online.js`) ;
pour plus d'anime, augmente le nombre de pages dans `lib/anime.js` (`fromAniList(8)` : 50 anime par page, `fromKitsu(18)` : 20 par page, `fromJikan(14)` : 25 par page).
Toutes ces API sont gratuites et sans clé.

## Lancer

```bash
npm install
npm start          # ou npm run dev (rechargement auto)
```

Ouvre http://localhost:3000, crée un salon, puis partage le lien (bouton « Copier le lien »).
Pour jouer à plusieurs sur le même réseau : http://<ip-de-ta-machine>:3000.
Node 18 minimum (utilise `fetch` natif).
Clé MyAnimeList : le Client ID est dans `lib/config.js`. Si ton dépôt est public, mets-le plutôt
dans une variable d'environnement `MAL_CLIENT_ID` sur Render et vide la valeur du fichier.
Conseillé : ajoute une variable d'environnement `CONTACT` (ton e-mail) dans Render ; elle est envoyée à Wikidata,
qui peut bloquer les requêtes non identifiées. Le serveur doit avoir accès à Internet pour joindre l'API Deezer.

## Structure

- `server.js` : salons (code à 4 lettres), déroulement des manches, chrono et scoring côté serveur
- `lib/online.js` : liste des thèmes et chargement de leurs extraits depuis les sources en ligne (avec cache)
- `lib/rounds.js` : transforme un élément en manche (extrait, réponses acceptées, révélation)
- `lib/deezer.js`, `lib/anime.js`, `lib/wikidata.js` : appels aux API Deezer, AniList/AnimeThemes, Wikidata
- `lib/names.js` : extraction du nom d'œuvre depuis un titre d'album de BO, variantes de noms
- `lib/matching.js` : normalisation des réponses (accents, articles, « feat. », « Remastered »…) et tolérance aux fautes (Levenshtein)
- `public/` : client (HTML, CSS, JS sans framework)
- `test/matching.test.js` : `npm test` pour vérifier la reconnaissance des réponses

## Points techniques

- **Synchro** : le client mesure l'écart entre son horloge et celle du serveur (5 pings, on garde le plus rapide).
  Le serveur envoie l'heure de départ 2,5 s dans le futur, chaque client précharge puis lance l'extrait à cet instant.
- **Anti-triche** : le titre et l'artiste ne sont jamais envoyés avant la révélation ; les points sont calculés par le serveur.
- **Extraits** : ce sont les extraits officiels de 30 s fournis par l'API publique Deezer. Leurs URL expirent,
  donc le serveur en redemande une fraîche avant chaque manche.
- **Mobile** : l'audio est « débloqué » au clic sur Créer / Rejoindre, sinon iOS refuse la lecture automatique.
  Si le navigateur bloque quand même, un bouton « Activer le son » apparaît.

## Catalogue musical (Last.fm + MusicBrainz + Deezer)

Les thèmes musicaux ne piochent plus dans des playlists d'utilisateurs : le serveur constitue un **catalogue**
en arrière-plan, enregistré dans `data/music-catalog.json` :
1. **Last.fm** donne, pour chaque thème, les morceaux les plus associés à ses étiquettes (`tags` dans `lib/online.js`,
   ex. `['rock', 'hard rock', 'metal']`) et le **nombre d'auditeurs** de chaque morceau (sa popularité).
2. **MusicBrainz**, pour les décennies, donne l'**année de première sortie** (pas celle d'une compilation
   ou d'une réédition) et le code **ISRC**.
3. **Deezer** retrouve l'enregistrement exact par son ISRC (ou la meilleure correspondance artiste + titre)
   et fournit l'extrait de 30 s.

Jusqu'à 300 morceaux par thème. Chaque morceau résolu reste en cache, et chaque thème est remis à jour
une fois par semaine. La toute première construction prend du temps (MusicBrainz limite à 1 requête par seconde) :
compte environ une heure pour tous les thèmes. Pendant ce temps, et sans clé Last.fm, le jeu utilise l'ancien
système (playlists Deezer filtrées par album). L'avancement est visible dans les logs (« Catalogue Rock / Métal :
300 morceaux ») et à l'adresse `/catalogue.json`.

**Clé nécessaire** : clé API Last.fm gratuite (https://www.last.fm/api/account/create), à mettre dans
`lib/config.js` ou dans la variable d'environnement `LASTFM_API_KEY`. Renseigne aussi `CONTACT` (ton e-mail) :
MusicBrainz exige que les requêtes automatiques soient identifiables.

Pour ajouter un style musical : une ligne dans `THEMES` avec ses étiquettes Last.fm (n'importe quel tag existant
sur last.fm : « disco », « grunge », « 60s », « bossa nova »…).

## Qualité des extraits et des réponses

- **Réponses souples** (`lib/matching.js`) : accents, articles, fautes de frappe, variantes de romaji
  (*Shippuuden* / *Shippuden*), nombres en lettres ou en chiffres (*deux* / *2*, *seven* / *7*),
  chiffres romains (*Final Fantasy VII* / *7*). Les chiffres doivent en revanche être exacts.
- **Mauvaises versions écartées** (`lib/quality.js`) : live, karaoké, instrumental, remix, accéléré/ralenti,
  reprises « à la manière de »… ; pour les BO, les pistes de moins de 45 s.
- **Vérification par album** : pour les décennies, l'année de sortie de l'album du morceau doit correspondre
  (compilations écartées) ; pour les thèmes de genre (Rock / Métal, Rap…), le genre Deezer de l'album aussi.
  Les playlists des éditeurs Deezer sont privilégiées. Les logs indiquent pour chaque thème le nombre d'intrus écartés.
- **Pas de doublons** : une même chanson ou une même œuvre présente dans plusieurs thèmes cochés n'est jouée qu'une fois.
- **Réponses acceptées** affichées à la révélation (« Aussi accepté : Shingeki no Kyojin, SnK… »).
- **Couleur par thème** : l'interface change de couleur selon la famille de l'extrait
  (musique rose, films/séries bleu, Disney violet, jeux vidéo vert, anime orange), avec le nom du thème affiché.

## Déroulement d'une partie

- **Contrôles de l'hôte** : Pause / Reprendre (l'extrait repart où il s'était arrêté, avec 1,5 s de décompte),
  Passer (révèle tout de suite, ou enchaîne si la réponse est déjà affichée), ✕ à côté d'un joueur pour l'exclure
  (il ne peut plus revenir dans ce salon depuis le même navigateur).
- **Compensation de latence** : le serveur mesure le ping de chaque joueur toutes les 5 s, et chaque navigateur signale
  si son extrait a démarré en retard. Une bonne réponse est datée au moment où elle a vraiment été tapée
  (ping et retard retirés, plafonnés) ; les réponses arrivées dans une même fenêtre de 300 ms sont classées sur ce temps.
  Le temps de chaque trouveur s'affiche dans le fil (« Léa a trouvé l'anime en premier (+6) · 1,2 s »).
- **Difficulté adaptative** (réglage par défaut) : niveau de 1 à 5 étoiles selon la part de joueurs qui trouvent
  sur les derniers extraits ; plus le salon est fort, plus le jeu pioche des œuvres moins connues, et inversement.
- **Bilan personnel** en fin de partie : extraits trouvés, temps moyen, réponse la plus rapide, premières places,
  meilleure série, thème fort et thème à travailler.

## Retours des bêta-testeurs (v2)

- **Vote pour passer** : bouton « Passer l'extrait (1/4) » pour tous ; quand tout le monde a voté, la réponse est révélée.
  Pendant la révélation, le même vote fait passer à l'extrait suivant. Un second clic retire son vote.
- **Propositions** : pour les chansons, seuls les noms d'artistes sont proposés (plus les titres, qui donnaient la réponse).
  L'hôte peut aussi désactiver complètement les propositions (mode difficile).

## Popularité

Les extraits ne sont pas tirés au hasard pur : plus une œuvre ou un morceau est populaire, plus il a de chances
de sortir tôt dans la partie (`lib/popularity.js`). Les moins connus gardent une petite chance.
- anime : nombre de membres MyAnimeList (ou AniList, Kitsu)
- rap, hits, playlists : score d'écoute Deezer (`rank`)
- films, séries : nombre de Wikipédia ayant un article sur l'œuvre (Wikidata), sinon le score Deezer de la BO ;
  dans une BO, le morceau le plus écouté est privilégié ; entre un film et son remake, le plus connu est retenu

Réglage : variable d'environnement `POPULARITY_STRENGTH` (3 par défaut ; 1 = léger, 5 = presque que des classiques).
Avec 3, sur 300 anime, les 50 plus populaires fournissent environ la moitié des extraits d'une partie,
et la moitié la moins connue environ 12 %.

## Salles permanentes

Dans le salon, l'hôte peut « Rendre ce salon permanent » en choisissant une adresse (ex. `3bci`).
La salle est ensuite accessible à `/salle/3bci` : ses réglages sont gardés, chaque partie terminée s'ajoute
à son historique, et un classement cumulé (points, victoires, parties) s'affiche dans le salon.
La personne qui a créé la salle en redevient l'hôte quand elle entre (reconnue par son navigateur).

## Thèmes de la communauté

Bouton « Parcourir et créer des thèmes de la communauté » dans les réglages. Deux types de thèmes :
- **Liste d'œuvres** : une œuvre par ligne, `Nom | autres noms acceptés | recherche Deezer` (les deux derniers
  champs sont facultatifs). À trouver : le nom de l'œuvre (Film, Série, Jeu, Anime ou Œuvre).
- **Playlist Deezer** : à trouver l'artiste et le titre.

Chacun peut aimer un thème (👍), l'hôte l'ajoute à la partie comme un thème normal, et seul le créateur peut le supprimer.
Les plus aimés et les plus joués apparaissent en premier.

## Mode streamer et mode Twitch

- **Mode streamer** (bouton en haut, propre à chaque joueur) : code du salon flouté, adresse masquée,
  saisie affichée en points et propositions masquées, pour ne pas se faire copier par les spectateurs.
- **Mode Twitch** : l'hôte indique sa chaîne dans les réglages. Son navigateur se connecte au chat en lecture seule
  (connexion anonyme, aucune clé nécessaire) et chaque message devient une proposition. Les spectateurs ont leur propre
  classement (panneau « Chat Twitch » et podium), séparé de celui des joueurs, et leurs réponses restent acceptées
  3 s après la fin de l'extrait pour compenser le retard du stream. Une proposition par seconde et par spectateur.
  Limite : le chat est public, les spectateurs voient donc les réponses des autres.

## Données

Salles et thèmes communautaires sont enregistrés dans `data/db.json` (variable `DATA_FILE` pour changer l'emplacement).
Pense à sauvegarder ce fichier, et à ne pas l'écraser lors des mises à jour (il est exclu de git par `data/.gitignore`).
Sur un hébergeur sans disque persistant (Render gratuit), ce fichier est perdu à chaque redémarrage.

## Relais par le navigateur

AniList, Kitsu et MyAnimeList bloquent souvent les adresses IP des hébergeurs (Render, etc.).
Quand le serveur est refusé, il demande au navigateur de l'hôte du salon de faire la même requête
depuis sa propre connexion et de lui renvoyer le résultat (`relay:fetch` dans `server.js` et `client.js`).
Seuls les domaines de ces API d'anime peuvent être relayés. Conséquence : au démarrage du serveur,
le préchargement des anime peut échouer (aucun hôte connecté) ; ils se chargent au lancement de la première partie.

## Limites du prototype

- État en mémoire : un redémarrage du serveur vide les salons.
- Pas de reconnexion automatique dans le salon après une coupure réseau.
- Les charts Deezer dépendent du pays du serveur.
- Films et séries : quelques extraits peuvent tomber sur une BO peu connue, selon le contenu des playlists trouvées.
- Les openings anime sont en .ogg ; sur les iPhone qui ne le lisent pas, le jeu bascule sur la version vidéo .webm (son uniquement).

## Pistes d'évolution

Indices progressifs (initiales du titre), mode « année de sortie », playlists favorites enregistrées,
historique des parties, reconnexion avec jeton, hébergement multi-instance avec l'adaptateur Redis de Socket.io.
