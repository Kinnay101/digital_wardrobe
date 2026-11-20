// Wetter über Open-Meteo (kostenlos, ohne Konto, Sitz in der Schweiz; Daten: CC BY 4.0, Quelle wird angezeigt).
// Gesendet werden nur gerundete Koordinaten (ca. 1 km genau) bzw. der eingegebene Ortsname bei der Ortssuche.
// Ort und letzte Vorhersage liegen nur auf diesem Gerät (localStorage).

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const LS_LOC = 'wetter-ort';
const LS_CACHE = 'wetter-cache';
const MAX_AGE = 60 * 60 * 1000; // Vorhersage höchstens 1 Stunde wiederverwenden

const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const write = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* egal */ } };
const round = (v) => Math.round(v * 100) / 100;

/** Gespeicherter Ort: { name, lat, lon, source: 'city' | 'gps' } oder null. */
export const getLocation = () => read(LS_LOC);
export function setLocation(loc) {
  write(LS_LOC, loc ? { ...loc, lat: round(loc.lat), lon: round(loc.lon) } : null);
  write(LS_CACHE, null);
}

/** Ortssuche (Name → Koordinaten). */
export async function searchCity(q) {
  const url = `${GEOCODE}?name=${encodeURIComponent(q.trim())}&count=6&language=de&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Ortssuche fehlgeschlagen');
  const data = await res.json();
  return (data.results || []).map((r) => ({
    name: r.name, detail: [r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude,
  }));
}

/** Aktueller Standort (fragt beim ersten Mal um Erlaubnis). */
export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Standort wird von diesem Gerät nicht unterstützt')); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: round(p.coords.latitude), lon: round(p.coords.longitude) }),
      (err) => reject(new Error(err.code === 1 ? 'Standort-Freigabe wurde abgelehnt' : 'Standort nicht verfügbar')),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 30 * 60 * 1000 },
    );
  });
}

/**
 * Vorhersage für heute und morgen: [{ date, tMax, tMin, feelsMax, feelsMin, rainProb, rainSum, wind, code }].
 * Nutzt die gespeicherte Vorhersage, wenn sie frisch genug ist (oder offline).
 */
export async function getForecast(loc, { force = false } = {}) {
  const cache = read(LS_CACHE);
  const same = cache && cache.lat === loc.lat && cache.lon === loc.lon;
  if (same && !force && Date.now() - cache.at < MAX_AGE) return cache.days;
  const params = new URLSearchParams({
    latitude: loc.lat, longitude: loc.lon, timezone: 'auto', forecast_days: '2',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max',
  });
  try {
    const res = await fetch(`${FORECAST}?${params}`);
    if (!res.ok) throw new Error('Wetterdienst nicht erreichbar');
    const d = (await res.json()).daily;
    const days = d.time.map((date, i) => ({
      date,
      tMax: d.temperature_2m_max[i], tMin: d.temperature_2m_min[i],
      feelsMax: d.apparent_temperature_max[i], feelsMin: d.apparent_temperature_min[i],
      rainProb: d.precipitation_probability_max[i] ?? 0, rainSum: d.precipitation_sum[i] ?? 0,
      wind: d.wind_speed_10m_max[i] ?? 0, code: d.weather_code[i],
    }));
    write(LS_CACHE, { lat: loc.lat, lon: loc.lon, at: Date.now(), days });
    return days;
  } catch (err) {
    if (same) return cache.days; // offline: letzte bekannte Vorhersage
    throw err;
  }
}

/** WMO-Wettercode → Text und Symbol. */
export function describe(code) {
  if (code === 0) return { text: 'Klar', icon: '☀️' };
  if (code <= 2) return { text: 'Leicht bewölkt', icon: '🌤️' };
  if (code === 3) return { text: 'Bewölkt', icon: '☁️' };
  if (code <= 48) return { text: 'Nebel', icon: '🌫️' };
  if (code <= 57) return { text: 'Nieselregen', icon: '🌦️' };
  if (code <= 67) return { text: 'Regen', icon: '🌧️' };
  if (code <= 77) return { text: 'Schnee', icon: '🌨️' };
  if (code <= 82) return { text: 'Regenschauer', icon: '🌦️' };
  if (code <= 86) return { text: 'Schneeschauer', icon: '🌨️' };
  return { text: 'Gewitter', icon: '⛈️' };
}
