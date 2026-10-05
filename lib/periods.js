'use strict';

// Filtre par année de sortie (films, séries, anime). Format de l'id : "debut-fin", bornes facultatives.
const PERIODS = [
  { id: 'all', label: 'Toutes les années' },
  { id: '2020-', label: 'Depuis 2020' },
  { id: '2010-', label: 'Depuis 2010' },
  { id: '2000-', label: 'Depuis 2000' },
  { id: '1990-', label: 'Depuis 1990' },
  { id: '-1999', label: 'Avant 2000' },
  { id: '2010-2019', label: 'Années 2010' },
  { id: '2000-2009', label: 'Années 2000' },
  { id: '1990-1999', label: 'Années 90' },
  { id: '1980-1989', label: 'Années 80' },
];

// true / false, ou null si l'année est inconnue et qu'un filtre est actif
function inPeriod(year, periodId) {
  if (!periodId || periodId === 'all') return true;
  if (!year) return null;
  const [from, to] = periodId.split('-').map((x) => (x ? Number(x) : null));
  return (from == null || year >= from) && (to == null || year <= to);
}

module.exports = { PERIODS, inPeriod };
