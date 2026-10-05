'use strict';

/*
  Petite base de données dans un fichier JSON (data/db.json), sans dépendance à installer.
  - salles : salons permanents (adresse fixe, réglages, historique, classement)
  - themes : thèmes créés par la communauté
  Les écritures sont regroupées (au plus une toutes les 500 ms) et atomiques :
  on écrit un fichier temporaire puis on le renomme, pour ne jamais laisser un fichier à moitié écrit.
  Pour changer l'emplacement : variable d'environnement DATA_FILE.
*/

const fs = require('fs');
const path = require('path');

const FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
let db = { salles: {}, themes: {} };

try {
  if (fs.existsSync(FILE)) db = { salles: {}, themes: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch (err) {
  // Fichier illisible : on le met de côté plutôt que de l'écraser
  console.error('Base de données illisible, copie de secours créée :', err.message);
  try { fs.copyFileSync(FILE, `${FILE}.corrompu-${Date.now()}`); } catch { /* rien */ }
}

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, FILE);
    } catch (err) {
      console.error('Sauvegarde impossible :', err.message);
    }
  }, 500);
}

module.exports = { get db() { return db; }, save };
