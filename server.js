const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason);
});

const app = express();
app.use(cors());

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'riftlog-server' });
});

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.json({ status: 'ok', db: 'disconnected' });
  }
});

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
      match_id         TEXT PRIMARY KEY,
      puuid            TEXT,
      game_creation    BIGINT,
      game_duration    INTEGER,
      champion_name    TEXT,
      enemy_champion   TEXT,
      lane             TEXT,
      result           TEXT,
      kills            INTEGER,
      deaths           INTEGER,
      assists          INTEGER,
      cs               INTEGER,
      cs_per_min       FLOAT,
      gold_earned      INTEGER,
      game_mode        TEXT,
      created_at       TIMESTAMP DEFAULT NOW()
    )
  `);

  // Enrich columns (idempotent)
  const matchCols = [
    'ADD COLUMN IF NOT EXISTS kill_participation FLOAT',
    'ADD COLUMN IF NOT EXISTS vision_score       INTEGER',
    'ADD COLUMN IF NOT EXISTS damage_dealt       INTEGER',
    'ADD COLUMN IF NOT EXISTS gold_per_min       FLOAT',
    'ADD COLUMN IF NOT EXISTS wards_placed       INTEGER',
    'ADD COLUMN IF NOT EXISTS wards_killed       INTEGER',
    'ADD COLUMN IF NOT EXISTS control_wards      INTEGER',
    'ADD COLUMN IF NOT EXISTS items              TEXT',
    'ADD COLUMN IF NOT EXISTS runes              TEXT',
    'ADD COLUMN IF NOT EXISTS all_participants   TEXT',
  ];
  for (const col of matchCols) {
    await pool.query(`ALTER TABLE matches ${col}`);
  }

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

  const tlCols = [
    'ADD COLUMN IF NOT EXISTS gold_at_15      INTEGER',
    'ADD COLUMN IF NOT EXISTS cs_at_15        INTEGER',
    'ADD COLUMN IF NOT EXISTS xp_at_15        INTEGER',
    'ADD COLUMN IF NOT EXISTS gold_diff_at_15 INTEGER',
    'ADD COLUMN IF NOT EXISTS cs_diff_at_15   INTEGER',
  ];
  for (const col of tlCols) {
    await pool.query(`ALTER TABLE timeline_data ${col}`);
  }

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

// ── SYNC STATE ────────────────────────────────────────────────────────────────

const syncStatus = {};

async function runSync(puuid, gameName, tagLine, region, key) {
  const base = regionalBase(region);
  try {
    await pool.query(
      `INSERT INTO players (puuid, game_name, tag_line, region)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (puuid) DO UPDATE SET game_name=$2, tag_line=$3, region=$4`,
      [puuid, gameName, tagLine, region]
    );

    await sleep(50);
    const matchIds = await riotGet(
      `${base}/lol/match/v5/matches/by-puuid/${puuid}/ids?count=20`,
      key
    );

    const total = matchIds.length;
    syncStatus[puuid].total = total;

    let imported = 0, skipped = 0;

    for (const matchId of matchIds) {
      const exists = await pool.query(
        'SELECT 1 FROM matches WHERE match_id=$1 AND puuid=$2',
        [matchId, puuid]
      );
      if (exists.rows.length) { skipped++; continue; }

      await sleep(50);
      const match = await riotGet(`${base}/lol/match/v5/matches/${matchId}`, key);

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

      const durSec   = info.gameDuration || 0;
      const durMin   = durSec / 60;
      const cs       = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);
      const csPerMin = durMin > 0 ? Math.round((cs / durMin) * 10) / 10 : null;
      const lane     = LANE_LABELS[me.individualPosition] || me.individualPosition || '';
      const gameMode = QUEUE_LABELS[info.queueId] || info.gameMode || '';

      // Enriched fields
      const teamKills = info.participants
        .filter(p => p.teamId === me.teamId)
        .reduce((s, p) => s + (p.kills || 0), 0);
      const killParticipation = teamKills > 0
        ? Math.round(((me.kills || 0) + (me.assists || 0)) / teamKills * 100) / 100
        : null;
      const goldPerMin = durMin > 0 ? Math.round((me.goldEarned || 0) / durMin * 10) / 10 : null;
      const items = JSON.stringify([
        me.item0, me.item1, me.item2, me.item3, me.item4, me.item5, me.item6,
      ]);
      const runes = JSON.stringify(me.perks || null);
      const allParticipants = JSON.stringify(info.participants.map(p => ({
        puuid:            p.puuid,
        championName:     p.championName,
        teamId:           p.teamId,
        individualPosition: p.individualPosition,
        kills:            p.kills,
        deaths:           p.deaths,
        assists:          p.assists,
        totalDamageDealtToChampions: p.totalDamageDealtToChampions,
        goldEarned:       p.goldEarned,
        totalMinionsKilled: p.totalMinionsKilled,
        neutralMinionsKilled: p.neutralMinionsKilled,
        visionScore:      p.visionScore,
        win:              p.win,
      })));

      await pool.query(
        `INSERT INTO matches
           (match_id, puuid, game_creation, game_duration, champion_name, enemy_champion,
            lane, result, kills, deaths, assists, cs, cs_per_min, gold_earned, game_mode,
            kill_participation, vision_score, damage_dealt, gold_per_min,
            wards_placed, wards_killed, control_wards, items, runes, all_participants)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 $16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
         ON CONFLICT (match_id) DO NOTHING`,
        [
          matchId, puuid,
          info.gameStartTimestamp || 0, durSec,
          me.championName || '', opp?.championName || '',
          lane, me.win ? 'win' : 'loss',
          me.kills || 0, me.deaths || 0, me.assists || 0,
          cs, csPerMin, me.goldEarned || 0, gameMode,
          killParticipation,
          me.visionScore || 0,
          me.totalDamageDealtToChampions || 0,
          goldPerMin,
          me.wardsPlaced || 0,
          me.wardsKilled || 0,
          me.visionWardsBoughtInGame || 0,
          items, runes, allParticipants,
        ]
      );

      const myPid  = me.participantId;
      const oppPid = opp?.participantId ?? null;
      const frames = timeline?.info?.frames || [];

      function closestFrame(ms) {
        return frames.reduce((best, f) => {
          if (f.timestamp <= ms) return f;
          return best;
        }, frames[0] || null);
      }

      function extractFrame(frame) {
        if (!frame?.participantFrames) return { my: null, opp: null };
        return {
          my:  frame.participantFrames[myPid]  || null,
          opp: oppPid ? frame.participantFrames[oppPid] || null : null,
        };
      }

      function frameStats(my, opp) {
        if (!my) return { gold: null, cs: null, xp: null, goldDiff: null, csDiff: null };
        const gold = my.totalGold ?? null;
        const cs   = (my.minionsKilled || 0) + (my.jungleMinionsKilled || 0);
        const xp   = my.xp ?? null;
        let goldDiff = null, csDiff = null;
        if (opp) {
          goldDiff = gold - (opp.totalGold || 0);
          csDiff   = cs   - ((opp.minionsKilled || 0) + (opp.jungleMinionsKilled || 0));
        }
        return { gold, cs, xp, goldDiff, csDiff };
      }

      const { my: my10, opp: opp10 } = extractFrame(closestFrame(600000));
      const s10 = frameStats(my10, opp10);

      const { my: my15, opp: opp15 } = extractFrame(closestFrame(900000));
      const s15 = frameStats(my15, opp15);

      console.log('Timeline match:', matchId);
      console.log('Gold @10:', s10.gold);
      console.log('Gold diff @10:', s10.goldDiff);
      console.log('Inserting timeline data...');

      let kills10 = 0, deaths10 = 0;
      for (const frame of frames) {
        if (!frame.events) continue;
        for (const ev of frame.events) {
          if (ev.timestamp >= 600000) break;
          if (ev.type === 'CHAMPION_KILL') {
            if (ev.killerId === myPid) kills10++;
            if (ev.victimId === myPid) deaths10++;
          }
        }
      }

      await pool.query(
        `INSERT INTO timeline_data
           (match_id, puuid,
            gold_at_10, cs_at_10, xp_at_10, gold_diff_at_10, cs_diff_at_10,
            kills_at_10, deaths_at_10,
            gold_at_15, cs_at_15, xp_at_15, gold_diff_at_15, cs_diff_at_15)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          matchId, puuid,
          s10.gold, s10.cs, s10.xp, s10.goldDiff, s10.csDiff,
          kills10, deaths10,
          s15.gold, s15.cs, s15.xp, s15.goldDiff, s15.csDiff,
        ]
      );

      console.log('Timeline inserted for:', matchId);
      imported++;
      syncStatus[puuid].imported = imported;
      syncStatus[puuid].message  = `${imported} / ${total - skipped} match${imported > 1 ? 's' : ''} importé${imported > 1 ? 's' : ''}…`;
    }

    syncStatus[puuid] = { status: 'done', imported, skipped, total, message: `${imported} match${imported > 1 ? 's' : ''} importé${imported > 1 ? 's' : ''}` };
    console.log(`Sync done for ${puuid}: imported=${imported} skipped=${skipped}`);

  } catch (err) {
    console.error('Sync background error:', err);
    syncStatus[puuid] = { status: 'error', message: err.message };
  }
}

// ── SYNC ENDPOINT ─────────────────────────────────────────────────────────────

app.get('/sync/:gameName/:tagLine/:region', async (req, res) => {
  const { gameName, tagLine, region } = req.params;
  const key = process.env.RIOT_API_KEY;
  if (!key) return res.status(500).json({ error: 'RIOT_API_KEY manquante' });

  const base = regionalBase(region);

  try {
    const acct = await riotGet(
      `${base}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      key
    );
    const puuid = acct.puuid;

    syncStatus[puuid] = { status: 'running', imported: 0, total: 0, message: 'Démarrage…' };

    res.json({ status: 'started', puuid });

    runSync(puuid, gameName, tagLine, region, key);

  } catch (err) {
    console.error('Sync init error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/sync-status/:puuid', (req, res) => {
  const st = syncStatus[req.params.puuid];
  if (!st) return res.json({ status: 'idle' });
  res.json(st);
});

// ── PLAYER DATA ENDPOINTS ─────────────────────────────────────────────────────

app.get('/player/:puuid/matches', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.*, t.gold_at_10, t.gold_diff_at_10,
              t.cs_at_10, t.cs_diff_at_10,
              t.gold_at_15, t.gold_diff_at_15
       FROM matches m
       LEFT JOIN timeline_data t ON m.match_id = t.match_id
       WHERE m.puuid = $1
       ORDER BY m.game_creation DESC`,
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

// ── START ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`riftlog-server listening on port ${PORT}`);

  if (process.env.DATABASE_URL) {
    initDB()
      .then(() => console.log('DB ready'))
      .catch(e => console.error('DB init error:', e.message));
  } else {
    console.warn('DATABASE_URL non définie — PostgreSQL désactivé');
  }
});
