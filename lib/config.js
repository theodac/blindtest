'use strict';

/*
  Configuration des clés d'API.
  Priorité à la variable d'environnement (Render > Environment), sinon la valeur écrite ici.
  ⚠️ Si ton dépôt GitHub est public, préfère la variable d'environnement : tout ce qui est écrit
  dans ce fichier est visible par n'importe qui.
*/

module.exports = {
  // API officielle MyAnimeList : https://myanimelist.net/apiconfig (seul le Client ID est nécessaire)
  MAL_CLIENT_ID: process.env.MAL_CLIENT_ID || '39b2bd5209682b8ccac5f74943c27f5c',

  // Last.fm : https://www.last.fm/api/account/create (clé gratuite). Sert à constituer le catalogue
  // des thèmes musicaux (morceaux par style, nombre d'auditeurs). Sans clé, l'ancien système est utilisé.
  LASTFM_API_KEY: process.env.LASTFM_API_KEY || '92dad0c22241739fc090273328804126',
};
