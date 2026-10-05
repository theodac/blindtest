/* global io */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const socket = io();

  const WHAT = { Artiste: 'l’artiste', Titre: 'le titre', Film: 'le film', 'Série': 'la série', Anime: 'l’anime', Jeu: 'le jeu', 'Œuvre': 'l’œuvre' };
  const NAME_OF = { Film: 'du film', 'Série': 'de la série', Anime: 'de l’anime', Jeu: 'du jeu', 'Œuvre': 'de l’œuvre' };

  // ---------- État local ----------
  let config = { themes: [], goals: [], durations: [] };
  let state = null;           // dernier room:state reçu
  let round = null;           // { number, preview, startAt, endsAt }
  let revealed = false;
  let clockOffset = 0;        // heure serveur - heure locale
  let playTimer = null;
  const serverNow = () => Date.now() + clockOffset;

  // ---------- Audio ----------
  // Deux lecteurs qui alternent : pendant qu'un joue l'extrait en cours, l'autre télécharge le suivant.
  // Les deux sont "débloqués" au clic sur Créer / Rejoindre, sinon iOS refuse de les lancer ensuite.
  const players = [new Audio(), new Audio()];
  let audio = players[0]; // lecteur actif
  const idle = () => (audio === players[0] ? players[1] : players[0]);
  const savedVolume = Number(localStorageGet('volume') ?? 0.7);
  for (const p of players) {
    p.preload = 'auto';
    p.volume = savedVolume;
    p.addEventListener('play', () => { if (p === audio) $('disc').classList.add('spinning'); });
    p.addEventListener('pause', () => { if (p === audio) $('disc').classList.remove('spinning'); });
    p.addEventListener('ended', () => { if (p === audio) $('disc').classList.remove('spinning'); });
    p.addEventListener('playing', () => {
      if (p !== audio) return;
      $('status').textContent = $('status').textContent.replace(' (chargement…)', '');
      // Retard de démarrage de l'extrait chez moi : le serveur en tient compte pour départager les réponses
      if (round && !revealed) {
        const lag = serverNow() - round.startAt;
        if (lag > 150) socket.emit('round:lag', { number: round.number, lag: Math.round(lag) });
      }
    });
  }
  $('volume').value = savedVolume;

  function silentWav() {
    const buf = new ArrayBuffer(46);
    const v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 38, true); w(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    w(36, 'data'); v.setUint32(40, 2, true); v.setUint8(44, 128); v.setUint8(45, 128);
    return 'data:audio/wav;base64,' + btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  function unlockAudio() {
    for (const p of players) {
      if (p.dataset.unlocked) continue;
      p.src = silentWav();
      p.play().then(() => { p.pause(); p.dataset.unlocked = '1'; }).catch(() => {});
    }
  }

  // Les openings d'anime sont en .ogg : Safari ne sait pas toujours les lire, on passe alors à la version vidéo
  function pickUrl({ preview, previewAlt }) {
    const oggOk = audio.canPlayType('audio/ogg; codecs="opus"') || audio.canPlayType('audio/ogg');
    return previewAlt && /\.ogg($|\?)/.test(preview) && !oggOk ? previewAlt : preview;
  }

  // Télécharge l'extrait de la manche suivante dans le lecteur inactif
  function preload(info) {
    const url = pickUrl(info);
    const p = idle();
    if (p.dataset.url === url) return;
    p.pause();
    p.dataset.url = url;
    p.src = url;
    p.load();
  }

  // Bascule sur le lecteur qui a déjà l'extrait (ou le charge maintenant si le préchargement n'a pas eu lieu)
  function loadRound(info) {
    const url = pickUrl(info);
    stopAudio();
    if (idle().dataset.url === url) {
      audio = idle();
    } else {
      audio.dataset.url = url;
      audio.src = url;
      audio.load();
    }
    if (audio.readyState < 3) setStatus($('status').textContent + ' (chargement…)');
  }

  // Lance l'extrait à l'heure serveur `startAt`, à `offset` secondes du début (reprise après une pause)
  function playAt(startAt, offset = 0) {
    clearTimeout(playTimer);
    const p = audio;
    const start = () => {
      if (p !== audio) return;
      const late = Math.max(0, (serverNow() - startAt) / 1000);
      const target = offset + late;
      if ((target > 0.25 || offset > 0) && isFinite(p.duration)) p.currentTime = Math.min(target, p.duration - 0.5);
      else if (offset === 0) p.currentTime = 0;
      p.play().then(() => { $('unmute').hidden = true; }).catch(() => { $('unmute').hidden = false; });
    };
    const wait = startAt - serverNow();
    if (wait > 0) playTimer = setTimeout(start, wait);
    else if (p.readyState >= 1) start();
    else p.addEventListener('loadedmetadata', start, { once: true });
  }

  function stopAudio() {
    clearTimeout(playTimer);
    for (const p of players) if (p === audio) p.pause();
  }

  $('volume').addEventListener('input', (e) => {
    for (const p of players) p.volume = Number(e.target.value);
    localStorageSet('volume', e.target.value);
  });
  $('unmute').addEventListener('click', () => {
    audio.play().then(() => { $('unmute').hidden = true; }).catch(() => {});
  });

  socket.on('round:preload', preload);

  // ---------- Synchronisation d'horloge ----------
  async function syncClock() {
    let best = null;
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const server = await new Promise((res) => socket.timeout(3000).emit('time:sync', (err, t) => res(err ? null : t)));
      const t1 = Date.now();
      if (server == null) continue;
      const rtt = t1 - t0;
      if (!best || rtt < best.rtt) best = { rtt, offset: server - (t0 + t1) / 2 };
    }
    if (best) clockOffset = best.offset;
  }
  socket.on('connect', syncClock);
  socket.on('lat', (cb) => typeof cb === 'function' && cb()); // mesure du ping par le serveur

  // Identifiant aléatoire gardé dans le navigateur (sert à l'hôte pour exclure un joueur)
  let playerKey = localStorageGet('key');
  if (!playerKey) {
    playerKey = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorageSet('key', playerKey);
  }

  // ---------- Accueil ----------
  $('name').value = localStorageGet('name') || '';
  const urlCode = new URLSearchParams(location.search).get('code');
  if (urlCode) $('code').value = urlCode.toUpperCase();
  socket.on('connect', () => socket.emit('identify', { key: playerKey }));

  // Salle permanente : /salle/3bci
  const salleMatch = location.pathname.match(/^\/salle\/([^/?#]+)/);
  const salleSlug = salleMatch ? decodeURIComponent(salleMatch[1]) : null;
  if (salleSlug) {
    $('create').textContent = `Entrer dans la salle « ${salleSlug} »`;
    document.querySelector('.join').hidden = true;
  }

  function homeError(msg) { $('home-error').textContent = msg || ''; }
  function playerName() {
    const n = $('name').value.trim();
    localStorageSet('name', n);
    return n;
  }

  $('create').addEventListener('click', () => {
    unlockAudio();
    if (salleSlug) {
      socket.emit('salle:open', { slug: salleSlug, name: playerName(), key: playerKey },
        (res) => (res.ok ? enterRoom(res.code, res.slug) : homeError(res.error)));
      return;
    }
    socket.emit('room:create', { name: playerName(), key: playerKey }, (res) => (res.ok ? enterRoom(res.code) : homeError(res.error)));
  });
  function join() {
    const code = $('code').value.trim().toUpperCase();
    if (code.length !== 4) return homeError('Le code fait 4 lettres.');
    unlockAudio();
    socket.emit('room:join', { code, name: playerName(), key: playerKey }, (res) => (res.ok ? enterRoom(res.code) : homeError(res.error)));
  }
  $('join').addEventListener('click', join);
  $('code').addEventListener('keydown', (e) => e.key === 'Enter' && join());

  function enterRoom(code, slug) {
    homeError('');
    $('home').hidden = true;
    $('room').hidden = false;
    $('room-code').textContent = code;
    updateUrl(slug);
  }

  // L'adresse affichée : /salle/… pour une salle permanente, ?code=… sinon, rien en mode streamer
  function updateUrl(slug = state && state.salle && state.salle.slug) {
    if (streamerMode) history.replaceState(null, '', '/');
    else if (slug) history.replaceState(null, '', `/salle/${encodeURIComponent(slug)}`);
    else history.replaceState(null, '', `/?code=${$('room-code').textContent}`);
  }

  function inviteLink() {
    if (state && state.salle) return `${location.origin}/salle/${encodeURIComponent(state.salle.slug)}`;
    return `${location.origin}/?code=${$('room-code').textContent}`;
  }

  $('leave').addEventListener('click', () => {
    socket.emit('room:leave');
    syncTwitch(null);
    stopAudio();
    state = null; round = null;
    $('room').hidden = true;
    $('home').hidden = false;
    $('podium').hidden = true;
    $('feed').replaceChildren();
    history.replaceState(null, '', location.pathname);
  });

  $('copy-link').addEventListener('click', async () => {
    const link = inviteLink();
    try { await navigator.clipboard.writeText(link); toast('Lien copié. Envoie-le aux autres joueurs.'); }
    catch { toast(streamerMode ? 'Copie impossible (mode streamer : le lien n’est pas affiché).' : link); }
  });

  // ---------- Réglages ----------
  socket.on('hello', (data) => {
    config = data;
    renderThemes(data.themes);
    fillSelect($('goal'), data.goals.map((g) => [g, `${g} points`]));
    fillSelect($('duration'), data.durations.map((d) => [d, `${d} s`]));
    fillSelect($('period'), data.periods.map((p) => [p.id, p.label]));
  });

  function fillSelect(sel, options) {
    sel.replaceChildren(...options.map(([value, label]) => {
      const o = document.createElement('option');
      o.value = value; o.textContent = label;
      return o;
    }));
  }

  function sendSettings(extra) {
    $('settings-error').textContent = '';
    const payload = {
      goal: $('goal').value, duration: $('duration').value, period: $('period').value,
      difficulty: $('difficulty').value, ...extra,
    };
    socket.emit('room:settings', payload, (res) => {
      if (res.ok) return;
      $('settings-error').textContent = res.error;
      // On remet les thèmes affichés dans l'état réellement enregistré
      if (state) for (const b of themeButtons()) b.setAttribute('aria-pressed', String(state.settings.themes.includes(b.dataset.id)));
    });
  }
  // Thèmes : des boutons à cocher, regroupés (Musique, Écrans, Anime)
  function renderThemes(themes) {
    const groups = new Map();
    for (const t of themes) {
      if (!groups.has(t.group)) groups.set(t.group, []);
      groups.get(t.group).push(t);
    }
    const nodes = [];
    for (const [group, list] of groups) {
      const title = document.createElement('p');
      title.className = 'theme-group';
      title.textContent = group;
      const wrap = document.createElement('div');
      wrap.className = 'theme-list';
      for (const t of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'theme-chip';
        b.dataset.id = t.id;
        b.textContent = t.label;
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => {
          b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
          sendSettings({ themes: selectedThemes() });
        });
        wrap.append(b);
      }
      nodes.push(title, wrap);
    }
    $('themes').replaceChildren(...nodes);
  }
  const themeButtons = () => [...$('themes').querySelectorAll('.theme-chip')];
  const selectedThemes = () => themeButtons().filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.id);

  $('all-themes').addEventListener('click', () => {
    const all = themeButtons().every((b) => b.getAttribute('aria-pressed') === 'true');
    // Tout décocher garde au moins le premier thème
    themeButtons().forEach((b, i) => b.setAttribute('aria-pressed', String(!all || i === 0)));
    sendSettings({ themes: selectedThemes() });
  });
  $('custom').addEventListener('change', () => sendSettings({ playlist: $('custom').value }));
  $('goal').addEventListener('change', () => sendSettings());
  $('duration').addEventListener('change', () => sendSettings());
  $('period').addEventListener('change', () => sendSettings());
  $('difficulty').addEventListener('change', () => sendSettings());
  $('suggestions').addEventListener('change', () => sendSettings({ suggestions: $('suggestions').value === 'on' }));
  $('vote-skip').addEventListener('click', () => socket.emit('vote:skip'));

  $('start').addEventListener('click', () => {
    unlockAudio();
    socket.emit('game:start');
  });
  $('stop').addEventListener('click', () => socket.emit('game:stop'));

  // ---------- Rendu du salon ----------
  socket.on('room:state', (s) => {
    state = s;
    const isHost = s.hostId === socket.id;
    const inLobby = s.state === 'lobby' || s.state === 'ended';

    // Joueurs
    const players = [...s.players].sort((a, b) => b.score - a.score);
    $('scores').replaceChildren(...players.map((p) => {
      const li = document.createElement('li');
      if (p.id === socket.id) li.className = 'me';
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = p.name;
      if (p.id === s.hostId) {
        const tag = document.createElement('small');
        tag.textContent = 'hôte';
        name.append(tag);
      }
      const dots = document.createElement('span');
      dots.className = 'dots';
      dots.title = 'Réponses trouvées sur cet extrait';
      for (let i = 0; i < s.targetCount; i++) {
        const dot = document.createElement('i');
        if (i < p.foundCount) dot.className = 'on';
        dots.append(dot);
      }
      const score = document.createElement('span');
      score.className = 'pscore';
      score.textContent = p.score;
      li.append(name, dots, score);
      if (isHost && p.id !== socket.id) {
        const kick = document.createElement('button');
        kick.type = 'button';
        kick.className = 'kick';
        kick.title = `Exclure ${p.name}`;
        kick.setAttribute('aria-label', `Exclure ${p.name}`);
        kick.textContent = '✕';
        kick.addEventListener('click', () => {
          if (confirm(`Exclure ${p.name} du salon ?`)) socket.emit('host:kick', { id: p.id });
        });
        li.classList.add('with-kick');
        li.append(kick);
      }
      return li;
    }));

    // Réglages
    $('settings').hidden = !inLobby;
    $('stop').hidden = !(isHost && !inLobby);
    $('start').hidden = !isHost;
    $('wait-host').hidden = isHost;
    for (const id of ['goal', 'duration', 'period', 'difficulty', 'suggestions', 'custom', 'all-themes']) $(id).disabled = !isHost;
    $('suggestions').value = s.settings.suggestions === false ? 'off' : 'on';
    // Vote pour passer : tous les joueurs doivent voter
    $('vote-skip').hidden = !s.skip || s.paused;
    if (s.skip) {
      const mine = s.skip.voters.includes(socket.id);
      $('vote-skip').setAttribute('aria-pressed', String(mine));
      const what = s.state === 'reveal' ? 'Suivant' : 'Passer l’extrait';
      $('vote-skip').textContent = `${mine ? '✓ ' : ''}${what} (${s.skip.voters.length}/${s.skip.needed})`;
      $('vote-skip').title = 'Quand tout le monde a voté, on passe directement';
    }
    for (const b of themeButtons()) {
      b.disabled = !isHost;
      b.setAttribute('aria-pressed', String(s.settings.themes.includes(b.dataset.id)));
    }
    $('all-themes').textContent = themeButtons().every((b) => b.getAttribute('aria-pressed') === 'true') ? 'Tout décocher' : 'Tout cocher';
    if (document.activeElement !== $('custom')) $('custom').value = s.settings.playlist || '';
    $('goal').value = s.settings.goal;
    $('duration').value = s.settings.duration;
    $('period').value = s.settings.period;
    $('difficulty').value = s.settings.difficulty || 'adaptive';
    // Contrôles de l'hôte pendant la partie
    const inGame = ['round', 'reveal', 'loading'].includes(s.state);
    $('host-controls').hidden = !(isHost && inGame && s.state !== 'loading');
    $('pause').textContent = s.paused ? 'Reprendre' : 'Pause';
    // Niveau de la difficulté adaptative (★ de 1 à 5)
    const showLevel = inGame && s.settings.difficulty === 'adaptive';
    $('level').hidden = !showLevel;
    if (showLevel) {
      const stars = s.level + 3;
      $('level').textContent = `Niveau ${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}`;
    }
    renderExtras(s, isHost);
    $('start').textContent = s.state === 'ended' ? 'Rejouer' : 'Lancer la partie';

    // Statut
    if (s.state === 'lobby') setStatus(isHost ? 'Choisis la musique, puis lance la partie.' : 'En attente de l’hôte…');
    if (s.state === 'loading') setStatus(`Chargement : ${s.settings.themesLabel}…`);
    if (s.state === 'ended') setStatus('Partie terminée.');
    if (inLobby || s.state === 'loading') {
      delete document.documentElement.dataset.family;
      $('theme-tag').hidden = true;
      $('guess').disabled = true;
      $('clock').textContent = '';
      $('cover').hidden = true;
      $('answer').hidden = true;
      setRing(1);
    }
  });

  function setStatus(text) { $('status').textContent = text; }

  // ---------- Manches ----------
  socket.on('round:start', (r) => {
    round = r;
    revealed = false;
    $('answer').hidden = true;
    $('cover').hidden = true;
    $('cover').removeAttribute('src');
    $('feed').replaceChildren();
    buildChips(r.targets);
    $('guess').value = '';
    $('guess').disabled = false;
    $('guess').classList.remove('good');
    setStatus(`Extrait ${r.number} : ${r.prompt.toLowerCase()}`);
    // Couleur et étiquette du thème de l'extrait
    document.documentElement.dataset.family = (r.theme && r.theme.family) || 'music';
    $('theme-tag').textContent = (r.theme && r.theme.label) || '';
    $('theme-tag').hidden = !r.theme;
    $('guess').placeholder = r.targets.length === 1
      ? `Tape le nom ${NAME_OF[r.targets[0].label] || ''}`
      : 'Tape l’artiste, le titre, ou les deux';

    loadRound(r);
    playAt(r.startAt, r.offset || 0);
    if (!matchMedia('(pointer: coarse)').matches) $('guess').focus();
  });

  socket.on('round:reveal', (a) => {
    revealed = true;
    $('guess').disabled = true;
    closeSuggestions();
    $('clock').textContent = '';
    setRing(0);
    if (a.cover) { $('cover').src = a.cover; $('cover').hidden = false; }
    $('answer-title').textContent = a.headline;
    $('answer-artist').textContent = a.sub;
    const accepted = a.accepted || [];
    $('answer-accepted').textContent = accepted.length ? `Aussi accepté : ${accepted.join(', ')}` : '';
    $('answer-accepted').hidden = !accepted.length;
    $('answer-link').href = a.link || '#';
    $('answer-link').hidden = !a.link;
    $('answer').hidden = false;
    setStatus('C’était…');
  });

  socket.on('game:end', ({ ranking, reason, twitch }) => {
    stopAudio();
    round = null;
    const winner = ranking[0];
    $('podium-title').textContent = winner && winner.score > 0 ? `${winner.name} gagne !` : 'Fin de partie';
    $('podium-reason').textContent = reason || '';
    $('recap').hidden = true; // rempli par 'game:recap' juste après
    $('podium-list').replaceChildren(...ranking.slice(0, 10).map((p) => {
      const li = document.createElement('li');
      li.textContent = `${p.name} : ${p.score} pts`;
      return li;
    }));
    const tw = twitch;
    $('podium-twitch').hidden = !(tw && tw.length);
    if (tw && tw.length) {
      $('podium-twitch-list').replaceChildren(...tw.map((v) => {
        const li = document.createElement('li');
        li.textContent = `${v.name} : ${v.score} pts`;
        return li;
      }));
    }
    $('podium').hidden = false;
  });
  $('podium-close').addEventListener('click', () => { $('podium').hidden = true; });

  // ---------- Mode streamer ----------
  // Code du salon flouté, adresse masquée, saisie en points, pas de propositions affichées :
  // les spectateurs du stream ne peuvent ni rejoindre ni copier tes réponses.
  let streamerMode = localStorageGet('streamer') === '1';
  function applyStreamer() {
    document.body.classList.toggle('streamer', streamerMode);
    $('streamer').setAttribute('aria-pressed', String(streamerMode));
    $('guess').type = streamerMode ? 'password' : 'text';
    $('guess').autocomplete = streamerMode ? 'new-password' : 'off';
    if (streamerMode) closeSuggestions();
    if (!$('room').hidden) updateUrl();
  }
  $('streamer').addEventListener('click', () => {
    streamerMode = !streamerMode;
    localStorageSet('streamer', streamerMode ? '1' : '0');
    applyStreamer();
  });
  applyStreamer();

  // ---------- Pause / reprise ----------
  socket.on('game:paused', () => {
    clearTimeout(playTimer);
    audio.pause();
    $('guess').disabled = true;
    closeSuggestions();
    setStatus('⏸ Partie en pause');
  });

  socket.on('round:resume', (info) => {
    if (!info) { setStatus('Reprise…'); return; } // pause pendant la révélation
    round = { ...round, ...info };
    $('guess').disabled = false;
    setStatus(`Extrait ${round.number} : ${round.prompt.toLowerCase()}`);
    playAt(info.startAt, info.offset);
  });

  $('pause').addEventListener('click', () => socket.emit(state && state.paused ? 'host:resume' : 'host:pause'));
  $('skip').addEventListener('click', () => socket.emit('host:skip'));

  socket.on('kicked', () => {
    syncTwitch(null);
    stopAudio();
    state = null; round = null;
    $('room').hidden = true;
    $('podium').hidden = true;
    $('home').hidden = false;
    homeError('L’hôte t’a exclu du salon.');
    history.replaceState(null, '', location.pathname);
  });

  // ---------- Bilan personnel ----------
  socket.on('game:recap', (r) => {
    const sec = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
    const rows = [
      ['Extraits trouvés', `${r.found} / ${r.played} (${Math.round(r.rate * 100)} %)`],
      ['Temps moyen', r.avgMs != null ? sec(r.avgMs) : '—'],
      ['Plus rapide', r.fastest ? `${sec(r.fastest.ms)} sur ${r.fastest.label}` : '—'],
      ['Premières places', String(r.firsts)],
      ['Meilleure série', r.maxStreak ? `${r.maxStreak} d’affilée` : '—'],
    ];
    if (r.bestTheme) rows.push(['Thème fort', `${r.bestTheme.label} (${Math.round(r.bestTheme.rate * 100)} %)`]);
    if (r.worstTheme && r.worstTheme.label !== (r.bestTheme && r.bestTheme.label)) {
      rows.push(['À travailler', `${r.worstTheme.label} (${Math.round(r.worstTheme.rate * 100)} %)`]);
    }
    $('recap-list').replaceChildren(...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }));
    $('recap').hidden = false;
  });

  socket.on('game:stopped', () => {
    stopAudio();
    round = null;
    toast('L’hôte a arrêté la partie.');
  });

  // ---------- Propositions ----------
  function submitGuess(text) {
    text = String(text || '').trim();
    if (!text || !round) return;
    socket.emit('guess', text);
    $('guess').value = '';
    closeSuggestions();
  }

  // Autocomplétion : propositions sous le champ, comme sur MovieGuessr
  let suggestItems = [];
  let suggestActive = -1;
  let suggestTimer = null;
  let suggestSeq = 0;

  function closeSuggestions() {
    suggestItems = [];
    suggestActive = -1;
    $('suggestions').hidden = true;
    $('suggestions').replaceChildren();
    $('guess').setAttribute('aria-expanded', 'false');
    $('guess').removeAttribute('aria-activedescendant');
  }

  // Met en jaune la partie du libellé qui correspond à la saisie (sans tenir compte des accents)
  function highlight(label, query) {
    const fold = (str) => str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const span = document.createElement('span');
    const q = fold(query.trim());
    const i = q ? fold(label).indexOf(q) : -1;
    if (i < 0) { span.textContent = label; return span; }
    const mark = document.createElement('mark');
    mark.textContent = label.slice(i, i + q.length);
    span.append(label.slice(0, i), mark, label.slice(i + q.length));
    return span;
  }

  function renderSuggestions(list, query) {
    suggestItems = list;
    suggestActive = -1;
    if (streamerMode || !list.length || document.activeElement !== $('guess')) return closeSuggestions();
    $('suggestions').replaceChildren(...list.map((s, i) => {
      const li = document.createElement('li');
      li.id = `sugg-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const label = document.createElement('span');
      label.className = 's-label';
      label.append(highlight(s.label, query));
      if (s.alt) {
        const alt = document.createElement('span');
        alt.className = 's-alt';
        alt.textContent = s.alt;
        label.append(alt);
      }
      const kind = document.createElement('span');
      kind.className = 's-kind';
      kind.textContent = s.kind;
      li.append(label, kind);
      // mousedown plutôt que click : le champ ne perd pas le focus avant la sélection
      li.addEventListener('mousedown', (e) => { e.preventDefault(); submitGuess(s.label); });
      return li;
    }));
    $('suggestions').hidden = false;
    $('guess').setAttribute('aria-expanded', 'true');
  }

  function moveActive(delta) {
    if (!suggestItems.length) return;
    suggestActive = (suggestActive + delta + suggestItems.length + 1) % (suggestItems.length + 1) - 1;
    [...$('suggestions').children].forEach((li, i) => li.setAttribute('aria-selected', String(i === suggestActive)));
    if (suggestActive >= 0) {
      const li = $(`sugg-${suggestActive}`);
      li.scrollIntoView({ block: 'nearest' });
      $('guess').setAttribute('aria-activedescendant', li.id);
    } else {
      $('guess').removeAttribute('aria-activedescendant');
    }
  }

  $('guess').addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const query = $('guess').value;
    if (query.trim().length < 2) return closeSuggestions();
    suggestTimer = setTimeout(() => {
      const seq = ++suggestSeq;
      socket.emit('suggest', query, (list) => {
        if (seq !== suggestSeq || list === null) return; // réponse périmée ou ignorée
        renderSuggestions(list || [], query);
      });
    }, 90);
  });

  $('guess').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); return; }
    if (e.key === 'Escape') { closeSuggestions(); return; }
    if (e.key === 'Tab' && suggestItems.length && !e.shiftKey) {
      // Tab complète avec la proposition surlignée (ou la première)
      e.preventDefault();
      $('guess').value = suggestItems[Math.max(0, suggestActive)].label;
      closeSuggestions();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submitGuess(suggestActive >= 0 ? suggestItems[suggestActive].label : $('guess').value);
  });
  $('guess').addEventListener('blur', () => setTimeout(closeSuggestions, 100));

  socket.on('guess:result', ({ gained, found }) => {
    for (const chip of $('chips').children) chip.classList.toggle('on', found.includes(chip.dataset.key));
    const allFound = $('chips').children.length > 0 && found.length >= $('chips').children.length;
    const input = $('guess');
    if (gained.length) {
      input.classList.add('good');
      setTimeout(() => input.classList.remove('good'), 600);
    } else {
      input.classList.remove('miss');
      void input.offsetWidth; // relance l'animation
      input.classList.add('miss');
    }
    if (allFound) {
      input.disabled = true;
      input.placeholder = 'Tout trouvé, bravo !';
    }
  });

  function buildChips(targets) {
    $('chips').replaceChildren(...targets.map((t) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.key = t.key;
      chip.textContent = t.label;
      return chip;
    }));
  }

  socket.on('feed', ({ name, label, pts, rank, ms }) => {
    const li = document.createElement('li');
    const who = document.createElement('strong');
    who.textContent = name;
    li.append(who, ` a trouvé ${WHAT[label] || label}${rank === 0 ? ' en premier' : ''} (+${pts})`);
    if (ms != null) {
      const t = document.createElement('span');
      t.className = 'ms';
      t.textContent = ` · ${(ms / 1000).toFixed(1).replace('.', ',')} s`;
      li.append(t);
    }
    $('feed').prepend(li);
    while ($('feed').children.length > 6) $('feed').lastChild.remove();
  });

  socket.on('notice', ({ text, type }) => toast(text, type));

  // Relais : le serveur demande au navigateur de l'hôte d'interroger une API d'anime
  // qui bloque l'hébergeur (AniList, Kitsu…). Seuls ces domaines sont acceptés.
  const RELAY_HOSTS = /(^|\.)(anilist\.co|kitsu\.app|kitsu\.io|jikan\.moe|animethemes\.moe)$/;
  socket.on('relay:fetch', async ({ url, method, body, accept }, cb) => {
    if (typeof cb !== 'function') return;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !RELAY_HOSTS.test(u.hostname)) return cb({ ok: false, error: 'domaine non autorisé' });
      const headers = { Accept: accept || 'application/json' };
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(url, {
        method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
      });
      if (!res.ok) return cb({ ok: false, error: `${u.hostname} a répondu ${res.status} au navigateur` });
      cb({ ok: true, data: await res.json() });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  // ---------- Chrono (anneau autour du disque) ----------
  const CIRC = 2 * Math.PI * 48;
  $('ring').style.strokeDasharray = CIRC;
  function setRing(progress) {
    $('ring').style.strokeDashoffset = CIRC * (1 - Math.max(0, Math.min(1, progress)));
  }

  function tick() {
    requestAnimationFrame(tick);
    if (!round || revealed || !state || state.state !== 'round') { $('disc').classList.remove('urgent'); return; }
    const now = serverNow();
    if (state.paused) return;
    if (now < round.startAt) {
      $('clock').textContent = Math.ceil((round.startAt - now) / 1000);
      // Avant le départ (ou à la reprise d'une pause), l'anneau montre le temps restant
      setRing(round.durationMs ? (round.endsAt - round.startAt) / round.durationMs : 1);
      return;
    }
    if (state.paused) return; // chrono figé pendant la pause
    const total = round.durationMs || (round.endsAt - round.startAt);
    const left = Math.max(0, round.endsAt - now);
    $('clock').textContent = Math.ceil(left / 1000);
    setRing(left / total);
    $('disc').classList.toggle('urgent', left < 5000);
  }
  requestAnimationFrame(tick);

  // ---------- Salle permanente, communauté, Twitch : affichage dans le salon ----------
  function renderExtras(s, isHost) {
    // Thèmes de la communauté sélectionnés (un clic les retire)
    $('community-chips').replaceChildren(...s.communityThemes.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'theme-chip';
      b.setAttribute('aria-pressed', 'true');
      b.textContent = t.label;
      b.disabled = !isHost;
      b.title = 'Retirer de la partie';
      b.addEventListener('click', () => sendSettings({ themes: s.settings.themes.filter((id) => id !== t.id) }));
      return b;
    }));
    $('open-community').textContent = isHost
      ? 'Parcourir et créer des thèmes de la communauté'
      : 'Voir et créer des thèmes de la communauté';

    // Twitch
    $('twitch').disabled = !isHost;
    if (document.activeElement !== $('twitch')) $('twitch').value = s.settings.twitch || '';
    $('twitch-panel').hidden = !s.twitch;
    if (s.twitch) {
      $('twitch-board').replaceChildren(...(s.twitch.length ? s.twitch : [{ name: 'Personne pour l’instant', score: '' }]).map((v) => {
        const li = document.createElement('li');
        const n = document.createElement('span');
        n.className = 'pname';
        n.textContent = v.name;
        const sc = document.createElement('span');
        sc.className = 'pscore';
        sc.textContent = v.score;
        li.append(n, document.createElement('span'), sc);
        return li;
      }));
    }
    syncTwitch(isHost ? s.settings.twitch : null);

    // Salle permanente
    $('salle-create').hidden = !(isHost && !s.salle);
    $('salle-info').hidden = !s.salle;
    $('salle-panel').hidden = !s.salle && !isHost;
    $('salle-title').textContent = s.salle ? `Salle « ${s.salle.title} »` : 'Salle permanente';
    if (s.salle) {
      $('salle-link').textContent = streamerMode ? 'Copier le lien de la salle' : `${location.host}/salle/${s.salle.slug}`;
      $('salle-board').replaceChildren(...(s.salle.leaderboard.length ? s.salle.leaderboard : []).map((p) => {
        const li = document.createElement('li');
        li.textContent = `${p.name} : ${p.points} pts, ${p.wins} victoire${p.wins > 1 ? 's' : ''} (${p.games} parties)`;
        return li;
      }));
      $('salle-history').replaceChildren(...s.salle.history.map((g) => {
        const li = document.createElement('li');
        const d = new Date(g.date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        const w = g.top[0];
        li.textContent = `${d} : ${w ? `${w.name} gagne (${w.score} pts)` : '—'}, ${g.rounds} extraits`;
        return li;
      }));
      if (!s.salle.history.length) $('salle-history').innerHTML = '<li class="muted">Aucune partie terminée pour l’instant.</li>';
    }
  }

  $('salle-save').addEventListener('click', () => {
    $('salle-error').textContent = '';
    const slug = $('salle-slug').value;
    socket.emit('salle:create', { slug, title: slug, key: playerKey }, (res) => {
      if (!res.ok) { $('salle-error').textContent = res.error; return; }
      updateUrl(res.slug);
      toast('Salle créée : son adresse ne changera plus.');
    });
  });
  $('salle-link').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteLink()); toast('Lien de la salle copié.'); } catch { /* rien */ }
  });

  $('twitch').addEventListener('change', () => sendSettings({ twitch: $('twitch').value }));

  // ---------- Thèmes de la communauté ----------
  let communitySeq = 0;
  function loadCommunity() {
    const seq = ++communitySeq;
    socket.emit('community:list', { query: $('community-search').value }, (list) => {
      if (seq === communitySeq) renderCommunity(list || []);
    });
  }

  function renderCommunity(list) {
    const isHost = state && state.hostId === socket.id && ['lobby', 'ended'].includes(state.state);
    const selected = new Set(state ? state.settings.themes : []);
    if (!list.length) {
      $('community-list').innerHTML = '<li class="muted">Aucun thème pour l’instant. Crée le premier !</li>';
      return;
    }
    $('community-list').replaceChildren(...list.map((t) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'c-name';
      name.textContent = t.name;
      const meta = document.createElement('span');
      meta.className = 'c-meta';
      const what = t.kind === 'playlist' ? 'playlist Deezer' : `${t.count} œuvres, à trouver : ${t.workLabel.toLowerCase()}`;
      meta.textContent = `par ${t.creator} · ${what} · joué ${t.plays} fois`;
      const desc = document.createElement('span');
      desc.className = 'c-desc';
      desc.textContent = t.description || '';
      const actions = document.createElement('div');
      actions.className = 'c-actions';

      const like = document.createElement('button');
      like.type = 'button';
      like.className = `btn btn-ghost btn-small${t.liked ? ' liked' : ''}`;
      like.textContent = `👍 ${t.likes}`;
      like.setAttribute('aria-pressed', String(t.liked));
      like.addEventListener('click', () => socket.emit('community:like', { id: t.id }, loadCommunity));
      actions.append(like);

      if (isHost) {
        const id = `c:${t.id}`;
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'btn btn-small';
        add.textContent = selected.has(id) ? 'Retirer' : 'Ajouter';
        add.addEventListener('click', () => {
          const themes = selected.has(id) ? state.settings.themes.filter((x) => x !== id) : [...state.settings.themes, id];
          sendSettings({ themes });
          setTimeout(loadCommunity, 150);
        });
        actions.append(add);
      }
      if (t.mine) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-ghost btn-small';
        del.textContent = 'Supprimer';
        del.addEventListener('click', () => {
          if (confirm(`Supprimer définitivement « ${t.name} » ?`)) socket.emit('community:delete', { id: t.id }, loadCommunity);
        });
        actions.append(del);
      }
      li.append(name, actions, meta, desc);
      return li;
    }));
  }

  $('open-community').addEventListener('click', () => { $('community').hidden = false; loadCommunity(); $('community-search').focus(); });
  $('community-close').addEventListener('click', () => { $('community').hidden = true; });
  $('community').addEventListener('click', (e) => { if (e.target === $('community')) $('community').hidden = true; });
  let searchTimer = null;
  $('community-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadCommunity, 200); });
  $('cf-kind').addEventListener('change', () => {
    const playlist = $('cf-kind').value === 'playlist';
    $('cf-playlist').hidden = !playlist;
    $('cf-works').hidden = playlist;
  });
  $('cf-submit').addEventListener('click', () => {
    $('cf-error').textContent = '';
    socket.emit('community:create', {
      name: $('cf-name').value,
      description: $('cf-desc').value,
      kind: $('cf-kind').value,
      playlist: $('cf-playlist-link').value,
      workLabel: $('cf-label').value,
      entries: $('cf-entries').value,
      creator: playerName(),
    }, (res) => {
      if (!res.ok) { $('cf-error').textContent = res.error; return; }
      toast('Thème publié !');
      for (const id of ['cf-name', 'cf-desc', 'cf-playlist-link', 'cf-entries']) $(id).value = '';
      $('community-form').open = false;
      $('community-search').value = '';
      loadCommunity();
    });
  });

  // ---------- Mode Twitch ----------
  // Le navigateur de l'hôte se connecte au chat Twitch en lecture seule (anonyme, sans clé)
  // et transmet chaque message au serveur, qui le traite comme une proposition.
  let twitchWs = null;
  let twitchChannel = null;
  let twitchRetry = null;

  function setTwitchStatus(text) {
    $('twitch-status').hidden = !text;
    $('twitch-status').textContent = text || '';
  }

  function syncTwitch(channel) {
    if (channel === twitchChannel) return;
    twitchChannel = channel;
    clearTimeout(twitchRetry);
    if (twitchWs) { twitchWs.onclose = null; twitchWs.close(); twitchWs = null; }
    if (!channel) { setTwitchStatus(''); return; }
    connectTwitch(channel);
  }

  function connectTwitch(channel) {
    setTwitchStatus(`Connexion au chat de ${channel}…`);
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    twitchWs = ws;
    ws.onopen = () => {
      ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`); // connexion anonyme en lecture
      ws.send(`JOIN #${channel}`);
    };
    ws.onmessage = (e) => {
      for (const line of String(e.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send(line.replace('PING', 'PONG')); continue; }
        if (/ 366 /.test(line)) setTwitchStatus(`Connecté au chat de ${channel} : les spectateurs peuvent jouer.`);
        const m = line.match(/^:([^!]+)![^ ]+ PRIVMSG #[^ ]+ :(.*)$/);
        if (m) socket.emit('twitch:msg', { user: m[1], text: m[2] });
      }
    };
    ws.onclose = () => {
      if (twitchWs !== ws || twitchChannel !== channel) return;
      setTwitchStatus('Chat Twitch déconnecté, nouvelle tentative…');
      twitchRetry = setTimeout(() => connectTwitch(channel), 5000);
    };
  }

  socket.on('twitch:feed', ({ name, label, pts, rank }) => {
    const li = document.createElement('li');
    const who = document.createElement('strong');
    who.textContent = `📺 ${name}`;
    li.append(who, ` a trouvé ${WHAT[label] || label}${rank === 0 ? ' en premier' : ''} (+${pts})`);
    $('feed').prepend(li);
    while ($('feed').children.length > 6) $('feed').lastChild.remove();
  });

  // ---------- Divers ----------
  let toastTimer = null;
  function toast(text, type) {
    const el = $('toast');
    el.textContent = text;
    el.className = `toast${type === 'error' ? ' error' : ''}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, type === 'error' ? 6000 : 3000);
  }

  function localStorageGet(k) { try { return localStorage.getItem(`bt:${k}`); } catch { return null; } }
  function localStorageSet(k, v) { try { localStorage.setItem(`bt:${k}`, v); } catch { /* stockage indisponible */ } }

  // Si le serveur redémarre, on revient à l'accueil
  socket.on('disconnect', () => {
    if (!$('room').hidden) {
      stopAudio();
      $('room').hidden = true;
      $('home').hidden = false;
      homeError('Connexion perdue avec le serveur. Recrée ou rejoins un salon.');
    }
  });
})();
