const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const PUN_CSV_URL =
  'https://githubusercontent.com';

let cacheColonnine = [];
let ultimoAggiornamento = 0;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 ore

// Calcolo distanza in km (Formula di Haversine)
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

// Parser CSV robusto (gestisce sia ';' che ',' e campi tra virgolette)
function parseCSVLine(line, separator) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === separator && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Pulizia e normalizzazione del nome del gestore (CPO)
function formattaGestore(raw) {
  if (!raw) return 'Colonnina Pubblica EV';
  const pulito = raw.replace(/^["']|["']$/g, '').trim();
  if (!pulito || pulito.toLowerCase() === 'nd' || pulito.toLowerCase() === 'n/d') {
    return 'Colonnina Pubblica EV';
  }
  const lower = pulito.toLowerCase();
  if (lower.includes('enel')) return 'Enel X Way';
  if (lower.includes('be charge') || lower.includes('becharge') || lower.includes('plenitude')) {
    return 'Plenitude / Be Charge';
  }
  if (lower.includes('ewiva')) return 'Ewiva';
  if (lower.includes('free to x') || lower.includes('freetox')) return 'Free To X';
  if (lower.includes('ionity')) return 'IONITY';
  if (lower.includes('tesla')) return 'Tesla Supercharger';
  if (lower.includes('neogy')) return 'Neogy';
  if (lower.includes('a2a')) return 'A2A E-Moving';
  if (lower.includes('duferco')) return 'Duferco Energia';
  if (lower.includes('atlante')) return 'Atlante';
  if (lower.includes('hera')) return 'Hera Comm';
  if (lower.includes('iren')) return 'IrenGO';
  if (lower.includes('acea')) return 'Acea Energia';
  if (lower.includes('repower')) return 'Repower';
  if (lower.includes('sorgenia')) return 'Sorgenia';

  return pulito
    .toLowerCase()
    .split(' ')
    .map((w) => (w.length > 2 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toUpperCase()))
    .join(' ');
}

// Normalizzazione tipo presa / connettore
function formattaPresa(rawPresa, potenzaKw) {
  const p = (rawPresa || '').toLowerCase();
  if (p.includes('ccs') || p.includes('combo')) return 'CCS Combo 2';
  if (p.includes('chademo')) return 'CHAdeMO';
  if (p.includes('type 2') || p.includes('tipo 2') || p.includes('mennekes') || p.includes('t2')) {
    return 'Tipo 2';
  }
  if (p.includes('type 3') || p.includes('tipo 3') || p.includes('scame')) return 'Tipo 3A';
  if (p.includes('schuko')) return 'Schuko';

  if (potenzaKw >= 50) return 'CCS Combo 2';
  return 'Tipo 2';
}

// Stima prezzo medio €/kWh in base alla potenza e all'operatore
function stimaPrezzoKwh(gestore, potenzaKw, prezzoCsv) {
  if (prezzoCsv && !isNaN(prezzoCsv) && prezzoCsv > 0) {
    return Number(prezzoCsv.toFixed(2));
  }
  const g = gestore.toLowerCase();
  if (g.includes('tesla')) return potenzaKw >= 50 ? 0.49 : 0.42;
  if (potenzaKw >= 100) return 0.79; // Ultra-Fast DC
  if (potenzaKw >= 50) return 0.69;  // Fast DC
  return 0.58;                       // Standard AC
}

async function caricaDatiColonnine() {
  const ora = Date.now();
  if (cacheColonnine.length > 0 && ora - ultimoAggiornamento < CACHE_TTL_MS) {
    return cacheColonnine;
  }

  console.log('Scaricamento dataset colonnine EV da:', PUN_CSV_URL);
  const response = await fetch(PUN_CSV_URL);
  if (!response.ok) {
    throw new Error(`Errore download dataset: ${response.status}`);
  }

  const text = await response.text();
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('Dataset CSV vuoto o non valido');
  }

  const separator = lines[0].includes(';') ? ';' : ',';
  const headers = parseCSVLine(lines[0], separator).map((h) =>
    h.toLowerCase().replace(/^["']|["']$/g, '')
  );

  console.log('Intestazioni CSV rilevate:', headers);

  const findIdx = (keywords) =>
    headers.findIndex((h) => keywords.some((kw) => h === kw || h.includes(kw)));

  const idxLat = findIdx(['latitudine', 'latitude', 'lat', 'y']);
  const idxLng = findIdx(['longitudine', 'longitude', 'lon', 'lng', 'x']);
  const idxGestore = findIdx([
    'operatore',
    'gestore',
    'cpo',
    'denominazione',
    'ragione_sociale',
    'owner',
    'brand',
    'nome',
  ]);
  const idxIndirizzo = findIdx(['indirizzo', 'address', 'via', 'ubicazione', 'localita', 'location']);
  const idxComune = findIdx(['comune', 'citta', 'city', 'municipality']);
  const idxProvincia = findIdx(['provincia', 'province', 'prov']);
  const idxPotenza = findIdx(['potenza', 'power', 'kw', 'max_power', 'potenza_kw', 'potenza_massima']);
  const idxPresa = findIdx([
    'presa',
    'connettore',
    'connector',
    'tipo_presa',
    'tipologia_presa',
    'socket',
    'standard',
  ]);
  const idxPrezzo = findIdx(['prezzo', 'tariffa', 'price', 'costo']);
  const idxData = findIdx(['data', 'aggiornamento', 'updated', 'date']);

  const oggi = new Date().toLocaleDateString('it-IT');
  const parsed = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i], separator);
    if (cols.length < 3) continue;

    const lat = parseFloat((cols[idxLat] || '').replace(',', '.'));
    const lng = parseFloat((cols[idxLng] || '').replace(',', '.'));
    if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) continue;

    const gestore = formattaGestore(idxGestore !== -1 ? cols[idxGestore] : '');
    const via = idxIndirizzo !== -1 ? cols[idxIndirizzo] : '';
    const comune = idxComune !== -1 ? cols[idxComune] : '';
    const prov = idxProvincia !== -1 ? cols[idxProvincia] : '';

    let indirizzoCompleto = [via, comune, prov ? `(${prov})` : '']
      .filter((p) => p && p.trim().length > 0)
      .join(', ')
      .replace(', (', ' (');
    if (!indirizzoCompleto) indirizzoCompleto = 'Indirizzo non disponibile';

    let potenzaKw = 22;
    if (idxPotenza !== -1 && cols[idxPotenza]) {
      const pVal = parseFloat(cols[idxPotenza].replace(',', '.').replace(/[^\d.]/g, ''));
      if (!isNaN(pVal) && pVal > 0) {
        potenzaKw = pVal > 1000 ? Math.round(pVal / 1000) : Math.round(pVal);
      }
    }

    const tipoPresa = formattaPresa(idxPresa !== -1 ? cols[idxPresa] : '', potenzaKw);
    const categoriaRicarica = potenzaKw >= 50 ? 'Fast DC' : 'Ricarica AC';
    const tipoRicarica = `${tipoPresa} • ${potenzaKw} kW`;

    const prezzoRaw = idxPrezzo !== -1 ? parseFloat((cols[idxPrezzo] || '').replace(',', '.')) : NaN;
    const prezzo = stimaPrezzoKwh(gestore, potenzaKw, prezzoRaw);

    const dataAgg = idxData !== -1 && cols[idxData] ? cols[idxData] : oggi;

    parsed.push({
      gestore,
      prezzo,
      latitudine: lat,
      longitudine: lng,
      indirizzo: indirizzoCompleto,
      self: potenzaKw >= 50,
      data: dataAgg,
      potenzaKw,
      tipoPresa,
      categoriaRicarica,
      tipoRicarica,
    });
  }

  cacheColonnine = parsed;
  ultimoAggiornamento = ora;
  console.log(`Caricate ${cacheColonnine.length} colonnine in cache.`);
  return cacheColonnine;
}

async function gestisciRicercaColonnine(req, res) {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const raggio = parseFloat(req.query.raggio) || 10;

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Parametri lat e lng obbligatori' });
    }

    const tutte = await caricaDatiColonnine();

    const vicine = tutte
      .map((c) => {
        const dist = calcolaDistanzaKm(lat, lng, c.latitudine, c.longitudine);
        return {
          ...c,
          distanza: Number(dist.toFixed(1)),
        };
      })
      .filter((c) => c.distanza <= raggio)
      .sort((a, b) => a.prezzo - b.prezzo || a.distanza - b.distanza)
      .slice(0, 30);

    res.json(vicine);
  } catch (err) {
    console.error('Errore ricerca colonnine:', err);
    res.status(500).json({ error: 'Errore interno del server', dettagli: err.message });
  }
}

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    servizio: 'Colonnine EV API Italia',
    colonnineInCache: cacheColonnine.length,
  });
});

app.get('/api/colonnine', gestisciRicercaColonnine);
app.get('/api/distributori', gestisciRicercaColonnine);

app.get('/api/debug-sample', async (req, res) => {
  try {
    const tutte = await caricaDatiColonnine();
    res.json({
      totale: tutte.length,
      esempio: tutte.slice(0, 3),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server colonnine EV attivo sulla porta ${PORT}`);
});




