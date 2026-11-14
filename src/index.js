const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;

const PUN_CSV_URL =
  'https://githubusercontent.com';

const CODICI_EMIO3 = {
  BEC: { nomeUfficiale: 'Plenitude + Be Charge', ac: 0.65, dc: 0.85 },
  ENL: { nomeUfficiale: 'Enel X Way', ac: 0.67, dc: 0.75 },
  ENX: { nomeUfficiale: 'Enel X Way', ac: 0.67, dc: 0.75 },
  EWI: { nomeUfficiale: 'Ewiva', ac: 0.75, dc: 0.80 },
  A2A: { nomeUfficiale: 'A2A E-Moving', ac: 0.65, dc: 0.90 },
  DUF: { nomeUfficiale: 'Duferco Energia', ac: 0.74, dc: 0.79 },
  ELC: { nomeUfficiale: 'Electra', ac: 0.54, dc: 0.54 },
  ELP: { nomeUfficiale: 'Electrip', ac: 0.75, dc: 0.80 },
  ION: { nomeUfficiale: 'Ionity', ac: 0.85, dc: 0.85 },
  ATL: { nomeUfficiale: 'Atlante', ac: 0.69, dc: 0.85 },
  FTX: { nomeUfficiale: 'Free To X', ac: 0.75, dc: 0.85 },
  NEO: { nomeUfficiale: 'Neogy', ac: 0.65, dc: 0.82 },
  HER: { nomeUfficiale: 'Hera Comm', ac: 0.66, dc: 0.84 },
  IRE: { nomeUfficiale: 'IrenGO', ac: 0.65, dc: 0.82 },
  ACE: { nomeUfficiale: 'Acea Energia', ac: 0.65, dc: 0.83 },
  TSL: { nomeUfficiale: 'Tesla Supercharger', ac: 0.55, dc: 0.65 },
  REP: { nomeUfficiale: 'Repower', ac: 0.68, dc: 0.82 },
  PWI: { nomeUfficiale: 'Powy', ac: 0.65, dc: 0.80 },
  GAS: { nomeUfficiale: 'GasGas', ac: 0.65, dc: 0.79 },
};

let cacheColonnine = [];
let ultimoAggiornamentoCache = 0;
const DURATA_CACHE_MS = 24 * 60 * 60 * 1000;

function scaricaTestoHttps(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { family: 4, headers: { 'User-Agent': 'ColonnineEVItaliaApp/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(scaricaTestoHttps(res.headers.location));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP status ${res.statusCode}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function calcolaDistanzaKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function risolviOperatoreETariffa(evseId, nomeLocation, isFastDc) {
  const matchCodice = String(evseId || '').toUpperCase().match(/^IT\*([A-Z0-9]{3})\*/);
  if (matchCodice) {
    const sigla = matchCodice.at(1);
    if (CODICI_EMIO3[sigla]) {
      const op = CODICI_EMIO3[sigla];
      return {
        gestore: op.nomeUfficiale,
        prezzo: isFastDc ? op.dc : op.ac,
      };
    }
  }
  const loc = String(nomeLocation || '').trim();
  const nomePulito = loc.includes(' - ') ? loc.split(' - ').at(0).trim() : loc;
  return {
    gestore: nomePulito || 'Colonnina Pubblica EV',
    prezzo: isFastDc ? 0.74 : 0.62,
  };
}

function traduciConnettore(rawConn) {
  const c = String(rawConn || '').toUpperCase();
  if (c.includes('T2_COMBO') || c.includes('CCS')) return 'CCS2 Combo';
  if (c.includes('T2')) return 'Tipo 2';
  if (c.includes('T3A')) return 'Tipo 3A';
  if (c.includes('CHADEMO')) return 'CHAdeMO';
  if (c.includes('DOMESTIC') || c.includes('SCHUKO')) return 'Schuko';
  return c || 'Tipo 2';
}

function parseCsvLine(line, sep) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.at(i);
    if (ch === '"') {
      if (inQuotes && line.at(i + 1) === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === sep && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

async function caricaDatasetPun() {
  const ora = Date.now();
  if (cacheColonnine.length > 0 && ora - ultimoAggiornamentoCache < DURATA_CACHE_MS) {
    return cacheColonnine;
  }

  const csvText = await scaricaTestoHttps(PUN_CSV_URL);
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('Dataset PUN vuoto');
  }

  const headerLine = lines.at(0);
  const sep = headerLine.split(';').length > headerLine.split(',').length ? ';' : ',';
  const headers = parseCsvLine(headerLine, sep).map((h) => h.toLowerCase().trim());

  const idxLat = headers.findIndex((h) => h === 'latitudine_evse' || h === 'latitudine' || h === 'y');
  const idxLon = headers.findIndex((h) => h === 'longitudine_evse' || h === 'longitudine' || h === 'x');
  const idxEvse = headers.findIndex((h) => h === 'id_univoco_evse');
  const idxLoc = headers.findIndex((h) => h === 'nome_location');
  const idxAddr = headers.findIndex((h) => h === 'indirizzo');
  const idxCity = headers.findIndex((h) => h === 'comune' || h === 'città' || h === 'citta');
  const idxPower = headers.findIndex((h) => h === 'potenza_erogabile');
  const idxConn = headers.findIndex((h) => h === 'standard_del_connettore');
  const idxFascia = headers.findIndex((h) => h === 'fasce_di_potenza');

  const stazioniMap = new Map();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines.at(i), sep);
    const lat = parseFloat((cols.at(idxLat) || '').replace(',', '.'));
    const lon = parseFloat((cols.at(idxLon) || '').replace(',', '.'));
    if (isNaN(lat) || isNaN(lon) || lat < 35 || lat > 48 || lon < 6 || lon > 19) continue;

    const evseId = idxEvse >= 0 ? cols.at(idxEvse) : '';
    const nomeLoc = idxLoc >= 0 ? cols.at(idxLoc) : '';
    const rawAddr = idxAddr >= 0 ? cols.at(idxAddr) : '';
    const rawCity = idxCity >= 0 ? cols.at(idxCity) : '';
    const rawPower = idxPower >= 0 ? cols.at(idxPower) : '';
    const rawConn = idxConn >= 0 ? cols.at(idxConn) : '';
    const rawFascia = idxFascia >= 0 ? cols.at(idxFascia) : '';

    let potenzaKw = 22;
    const valW = parseFloat(String(rawPower).replace(',', '.'));
    if (!isNaN(valW) && valW > 0) {
      potenzaKw = valW >= 1000 ? Math.round(valW / 1000) : Math.round(valW);
    }

    const isFastDc =
      potenzaKw >= 43 ||
      String(rawFascia).toLowerCase().includes('veloce') ||
      String(rawConn).toUpperCase().includes('COMBO');

    const { gestore, prezzo } = risolviOperatoreETariffa(evseId, nomeLoc, isFastDc);
    const presa = traduciConnettore(rawConn);
    const indirizzo = [rawAddr, rawCity].filter(Boolean).join(', ') || `Posizione GPS (${lat.toFixed(4)}, ${lon.toFixed(4)})`;

    const chiavePos = `${lat.toFixed(5)}_${lon.toFixed(5)}_${gestore}`;
    if (stazioniMap.has(chiavePos)) {
      const esistente = stazioniMap.get(chiavePos);
      if (!esistente.preseSet.has(presa)) {
        esistente.preseSet.add(presa);
      }
      if (potenzaKw > esistente.potenzaKw) {
        esistente.potenzaKw = potenzaKw;
        esistente.prezzo = prezzo;
        esistente.self = !isFastDc;
      }
    } else {
      stazioniMap.set(chiavePos, {
        gestore,
        prezzo,
        latitudine: lat,
        longitudine: lon,
        indirizzo,
        self: !isFastDc,
        potenzaKw,
        preseSet: new Set([presa]),
      });
    }
  }

  const parsed = Array.from(stazioniMap.values()).map((s) => {
    const preseList = Array.from(s.preseSet).join(', ');
    const isFast = s.potenzaKw >= 43;
    return {
      gestore: s.gestore,
      prezzo: s.prezzo,
      latitudine: s.latitudine,
      longitudine: s.longitudine,
      indirizzo: s.indirizzo,
      self: s.self,
      potenzaKw: s.potenzaKw,
      prese: preseList,
      tipoRicarica: `${isFast ? 'Fast DC' : 'Ricarica AC'} (${s.potenzaKw} kW) • ${preseList}`,
    };
  });

  cacheColonnine = parsed;
  ultimoAggiornamentoCache = ora;
  console.log(`Dataset PUN caricato in memoria: ${parsed.length} stazioni uniche`);
  return cacheColonnine;
}

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    message: 'API Colonnine EV Italia (PUN Nazionale) attiva',
    colonnineInCache: cacheColonnine.length,
  });
});

app.get('/api/colonnine', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng || req.query.lon);
    const raggioKm = Math.min(Math.max(parseFloat(req.query.raggio || req.query.radius || '10') || 10, 1), 50);

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Parametri lat e lng obbligatori' });
    }

    const tutteLeColonnine = await caricaDatasetPun();

    const oggi = new Date().toLocaleDateString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });

    const risultati = [];
    for (const col of tutteLeColonnine) {
      if (Math.abs(col.latitudine - lat) > 0.6 || Math.abs(col.longitudine - lng) > 0.8) continue;

      const distKm = calcolaDistanzaKm(lat, lng, col.latitudine, col.longitudine);
      if (distKm <= raggioKm) {
        risultati.push({
          ...col,
          distanza: distKm.toFixed(1),
          data: oggi,
        });
      }
    }

    risultati.sort((a, b) => a.prezzo - b.prezzo || parseFloat(a.distanza) - parseFloat(b.distanza));
    res.json(risultati);
  } catch (err) {
    console.error('Errore /api/colonnine:', err.message);
    res.status(500).json({ error: 'Errore interno durante la ricerca colonnine' });
  }
});

app.listen(PORT, () => {
  console.log(`Server Colonnine EV in ascolto sulla porta ${PORT}`);
});



















