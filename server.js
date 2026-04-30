const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());

// ── DATABASE ─────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      puuid       TEXT PRIMARY KEY,
      game_name   TEXT,
      tag_line    TEXT,
      region      TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      match_id      TEXT PRIMARY KEY,
      puuid         TEXT,
      game_creation BIGINT,
      game_duration INTEGER,
      champion_name TEXT,
      enemy_champion TEXT,
      lane          TEXT,
      result        TEXT,
      kills         INTEGER,
      deaths        INTEGER,
      assists       INTEGER,
      cs            INTEGER,
      cs_per_min    FLOAT,
      gold_earned   INTEGER,
      game_mode     TEXT,
      created_at    TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS timeline_data (
      id              SERIAL PRIMARY KEY,
      match_id        TEXT,
      puuid           TEXT,
      gold_at_10      INTEGER,
      cs_at_10        INTEGER,
      xp_at_10        INTEGER,
      gold_diff_at_10 INTEGER,
      cs_diff_at_10   INTEGER,
      kills_at_10     INTEGER,
      deaths_at_10    INTEGER,
      created_at      TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log('PostgreSQL tables ready');
}

// ── RIOT HELPERS ──────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function regionalBase(region) {
  const r = (region || '').toUpperCase();
  if (['NA', 'BR', 'LAN', 'LAS', 'OC'].includes(r)) return 'https://americas.api.riotgames.com';
  if (['KR', 'JP'].includes(r))                       return 'https://asia.api.riotgames.com';
  return 'https://europe.api.riotgames.com'; // EUW, EUNE, TR, RU + default
}

const QUEUE_LABELS = {
  420: 'Solo/Duo', 440: 'Flex', 400: 'Normal', 430: 'Normal',
  450: 'ARAM', 700: 'Clash', 900: 'URF', 1020: 'One for All',
  1300: 'Nexus Blitz', 1400: 'Ultimate Spellbook',
};

const LANE_LABELS = {
  TOP: 'Top', JUNGLE: 'Jungle', MIDDLE: 'Mid',
  BOTTOM: 'Bot (ADC)', UTILITY: 'Support',
};

async function riotGet(url, key, retries = 3) {
  const r = await fetch(url, { headers: { 'X-Riot-Token': key } });
  if (r.status === 429) {
    const retry = parseInt(r.headers.get('Retry-After') || '2');
    const wait  = Math.max(retry * 1000, 2000);
    if (retries > 0) { await sleep(wait); return riotGet(url, key, retries - 1); }
    throw new Error('Rate limit persistant — réessaie dans quelques secondes');
  }
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(`Riot API ${r.status}: ${body?.status?.message || r.statusText}`);
  }
  return r.json();
}

// Ancien helper pour les 3 endpoints de compatibilité
async function riotFetch(res, url) {
  if (!process.env.RIOT_API_KEY) {
    return res.status(500).json({ error: 'RIOT_API_KEY non configurée' });
  }
  try {
    const r = await fetch(url, { headers: { 'X-Riot-Token': process.env.RIOT_API_KEY } });
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

// ── ANCIENS ENDPOINTS (compatibilité) ────────────────────────────────────────

const RIOT_BASE = 'https://europe.api.riotgames.com';

app.get('/account/:gameName/:tagLine', (req, res) => {
  const { gameName, tagLine } = req.params;
  riotFetch(res, `${RIOT_BASE}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`);
});

app.get('/matches/:puuid', (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 20, 100);
  const region = req.query.region || 'EUW';
  const base   = regionalBase(region);
  riotFetch(res, `${base}/lol/match/v5/matches/by-puuid/${req.params.puuid}/ids?count=${count}`);
});

app.get('/match/:matchId', (req, res) => {
  riotFetch(res, `${RIOT_BASE}/lol/match/v5/matches/${req.params.matchId}`);
});

// ── SYNC ENDPOINT ─────────────────────────────────────────────────────────────

app.get('/sync/:gameName/:tagLine/:region', async (req, res) => {
  const { gameName, tagLine, region } = req.params;
  const key = process.env.RIOT_API_KEY;
  if (!key) return res.status(500).json({ error: 'RIOT_API_KEY manquante' });

  const base = regionalBase(region);

  try {
    // 1 — PUUID
    const acct = await riotGet(
      `${base}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      key
    );
    const puuid = acct.puuid;

    // 2 — Sauvegarde joueur
    await pool.query(
      `INSERT INTO players (puuid, game_name, tag_line, region)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (puuid) DO UPDATE SET game_name=$2, tag_line=$3, region=$4`,
      [puuid, gameName, tagLine, region]
    );

    // 3 — Match IDs (20 derniers)
    await sleep(50);
    const matchIds = await riotGet(
      `${base}/lol/match/v5/matches/by-puuid/${puuid}/ids?count=20`,
      key
    );

    // 4 — Chaque match
    let imported = 0, skipped = 0;

    for (const matchId of matchIds) {
      const exists = await pool.query(
        'SELECT 1 FROM matches WHERE match_id=$1 AND puuid=$2',
        [matchId, puuid]
      );
      if (exists.rows.length) { skipped++; continue; }

      // Détails du match
      await sleep(50);
      const match = await riotGet(`${base}/lol/match/v5/matches/${matchId}`, key);

      // Timeline
      await sleep(50);
      let timeline = null;
      try {
        timeline = await riotGet(`${base}/lol/match/v5/matches/${matchId}/timeline`, key);
      } catch (e) {
        console.warn(`Timeline unavailable for ${matchId}:`, e.message);
      }

      const info = match.info;
      const me   = info.participants.find(p => p.puuid === puuid);
      if (!me) { skipped++; continue; }

      const opp = info.participants.find(p =>
        p.teamId !== me.teamId && p.individualPosition === me.individualPosition
      );

      const durMin   = Math.round((info.gameDuration || 0) / 60);
      const cs       = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);
      const csPerMin = durMin > 0 ? Math.round((cs / durMin) * 10) / 10 : null;
      const lane     = LANE_LABELS[me.individualPosition] || me.individualPosition || '';
      const gameMode = QUEUE_LABELS[info.queueId] || info.gameMode || '';

      await pool.query(
        `INSERT INTO matches
           (match_id, puuid, game_creation, game_duration, champion_name, enemy_champion,
            lane, result, kills, deaths, assists, cs, cs_per_min, gold_earned, game_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (match_id) DO NOTHING`,
        [
          matchId, puuid,
          info.gameStartTimestamp || 0, info.gameDuration || 0,
          me.championName || '', opp?.championName || '',
          lane, me.win ? 'win' : 'loss',
          me.kills || 0, me.deaths || 0, me.assists || 0,
          cs, csPerMin, me.goldEarned || 0, gameMode,
        ]
      );

      // ── Timeline at 10 min ────────────────────────────────────────────────
      const myPid  = me.participantId;
      const oppPid = opp?.participantId ?? null;
      const frames = timeline?.info?.frames || [];

      // Frame la plus proche de 600 000 ms sans la dépasser
      const frame10 = frames.reduce((best, f) => {
        if (f.timestamp <= 600000) return f;
        return best;
      }, frames[0] || null);

      let gold10 = null, cs10 = null, xp10 = null;
      let goldDiff10 = null, csDiff10 = null, kills10 = 0, deaths10 = 0;

      if (frame10?.participantFrames) {
        const myF  = frame10.participantFrames[myPid];
        const oppF = oppPid ? frame10.participantFrames[oppPid] : null;

        if (myF) {
          gold10 = myF.totalGold ?? null;
          cs10   = (myF.minionsKilled || 0) + (myF.jungleMinionsKilled || 0);
          xp10   = myF.xp ?? null;

          if (oppF) {
            const oppCs10 = (oppF.minionsKilled || 0) + (oppF.jungleMinionsKilled || 0);
            goldDiff10 = gold10 - (oppF.totalGold || 0);
            csDiff10   = cs10   - oppCs10;
          }
        }
      }

      // Kills/deaths avant 10 min via events
      for (const frame of frames) {
        if (!frame.events) continue;
        for (const ev of frame.events) {
          if (ev.timestamp >= 600000) break;
          if (ev.type === 'CHAMPION_KILL') {
            if (ev.killerId  === myPid) kills10++;
            if (ev.victimId  === myPid) deaths10++;
          }
        }
      }

      await pool.query(
        `INSERT INTO timeline_data
           (match_id, puuid, gold_at_10, cs_at_10, xp_at_10,
            gold_diff_at_10, cs_diff_at_10, kills_at_10, deaths_at_10)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [matchId, puuid, gold10, cs10, xp10, goldDiff10, csDiff10, kills10, deaths10]
      );

      imported++;
    }

    res.json({ imported, skipped });

  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PLAYER DATA ENDPOINTS ─────────────────────────────────────────────────────

app.get('/player/:puuid/matches', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM matches WHERE puuid=$1 ORDER BY game_creation DESC`,
      [req.params.puuid]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/player/:puuid/timeline/:matchId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM timeline_data WHERE puuid=$1 AND match_id=$2 LIMIT 1`,
      [req.params.puuid, req.params.matchId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Timeline introuvable' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/player/:puuid/stats', async (req, res) => {
  try {
    const { puuid } = req.params;

    const statsRes = await pool.query(
      `SELECT
         COUNT(*)                                                              AS total,
         COUNT(*) FILTER (WHERE result = 'win')                               AS wins,
         AVG(CASE WHEN deaths = 0
               THEN (kills + assists)::float
               ELSE (kills + assists)::float / deaths END)                    AS kda,
         AVG(cs_per_min)                                                      AS avg_cs_min,
         AVG(gold_earned)                                                     AS avg_gold
       FROM matches WHERE puuid=$1`,
      [puuid]
    );

    const tlRes = await pool.query(
      `SELECT
         AVG(gold_diff_at_10) AS avg_gold_diff_10,
         AVG(cs_diff_at_10)   AS avg_cs_diff_10
       FROM timeline_data WHERE puuid=$1`,
      [puuid]
    );

    const champRes = await pool.query(
      `SELECT champion_name,
              COUNT(*)                                  AS games,
              COUNT(*) FILTER (WHERE result = 'win')    AS wins
       FROM matches
       WHERE puuid=$1 AND champion_name != ''
       GROUP BY champion_name
       ORDER BY games DESC
       LIMIT 1`,
      [puuid]
    );

    const s  = statsRes.rows[0];
    const tl = tlRes.rows[0];
    const ch = champRes.rows[0];
    const total = parseInt(s.total);

    res.json({
      total,
      winrate:      total > 0 ? Math.round(parseInt(s.wins) / total * 100) : 0,
      kda:          parseFloat((parseFloat(s.kda) || 0).toFixed(2)),
      avgCsMin:     parseFloat((parseFloat(s.avg_cs_min) || 0).toFixed(1)),
      avgGold:      Math.round(parseFloat(s.avg_gold) || 0),
      avgGoldDiff10: Math.round(parseFloat(tl.avg_gold_diff_10) || 0),
      avgCsDiff10:   parseFloat((parseFloat(tl.avg_cs_diff_10) || 0).toFixed(1)),
      topChampion: ch ? {
        name:    ch.champion_name,
        games:   parseInt(ch.games),
        winrate: Math.round(parseInt(ch.wins) / parseInt(ch.games) * 100),
      } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HEALTH ────────────────────────────────────────────────────────────────────

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: 'connected' });
  } catch {
    res.json({ ok: true, db: 'disconnected' });
  }
});

// ── START ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

(async () => {
  if (process.env.DATABASE_URL) {
    try { await initDB(); } catch (e) { console.error('DB init error:', e.message); }
  } else {
    console.warn('DATABASE_URL non définie — PostgreSQL désactivé');
  }
  app.listen(PORT, () => console.log(`riftlog-server listening on port ${PORT}`));
})();
