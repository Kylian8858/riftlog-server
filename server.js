const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());

const RIOT_BASE = 'https://europe.api.riotgames.com';

function riotHeaders() {
  return { 'X-Riot-Token': process.env.RIOT_API_KEY };
}

async function riotFetch(res, url) {
  if (!process.env.RIOT_API_KEY) {
    return res.status(500).json({ error: 'RIOT_API_KEY non configurée' });
  }
  try {
    const r = await fetch(url, { headers: riotHeaders() });
    const body = await r.json();
    if (!r.ok) {
      const msg =
        r.status === 401 ? 'Clé API invalide ou expirée' :
        r.status === 403 ? 'Accès refusé' :
        r.status === 404 ? 'Ressource introuvable' :
        r.status === 429 ? 'Rate limit atteint — réessaie dans quelques secondes' :
        body?.status?.message || 'Erreur Riot API';
      return res.status(r.status).json({ error: msg, riot: body });
    }
    res.json(body);
  } catch (err) {
    res.status(502).json({ error: 'Impossible de joindre l\'API Riot', detail: err.message });
  }
}

app.get('/account/:gameName/:tagLine', (req, res) => {
  const { gameName, tagLine } = req.params;
  riotFetch(res, `${RIOT_BASE}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
});

app.get('/matches/:puuid', (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 20, 100);
  riotFetch(res, `${RIOT_BASE}/lol/match/v5/matches/by-puuid/${req.params.puuid}/ids?count=${count}`);
});

app.get('/match/:matchId', (req, res) => {
  riotFetch(res, `${RIOT_BASE}/lol/match/v5/matches/${req.params.matchId}`);
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`riftlog-server listening on port ${PORT}`));
