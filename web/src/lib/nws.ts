/**
 * National Weather Service hourly forecast for a stadium at kickoff.
 * Two calls: /points (cached a long time per venue) then the hourly grid.
 * Any failure returns undefined and the report says no forecast is available.
 */
import type { WeatherInput } from "./types";
import { heatIndex } from "./weather";
import { compassToDegrees, windComponent as windComponentFor } from "./stadiums";

const UA = process.env.NWS_USER_AGENT ?? "ScoutTheSlate/0.1 (prototype)";

interface Period {
  startTime: string;
  endTime: string;
  temperature: number;
  probabilityOfPrecipitation: { value: number | null };
  relativeHumidity: { value: number | null };
  windSpeed: string; // "5 mph" or "5 to 10 mph"
  windDirection: string;
  shortForecast: string;
}

async function nws<T>(url: string, revalidate: number): Promise<T | undefined> {
  try {
    // 4 s: a normal answer takes 70 to 150 ms, and the game page waits on it.
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/geo+json" }, next: { revalidate }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

function mph(s: string): number {
  const nums = s.match(/\d+/g)?.map(Number) ?? [];
  return nums.length ? Math.max(...nums) : 0;
}

export interface VenueForWeather {
  latitude: number;
  longitude: number;
  dome: boolean | null;
  grass: boolean | null;
  elevationMeters: number | null;
  /** Field axis bearing 0..180 from stadiums.json, when known. Enables the crosswind call. */
  fieldBearing?: number;
  fieldBearingConfidence?: "high" | "medium" | "low";
}

export async function forecastAtKickoff(v: VenueForWeather, kickoffIso: string): Promise<WeatherInput | undefined> {
  const lat = v.latitude.toFixed(4);
  const lon = v.longitude.toFixed(4);
  const point = await nws<{ properties: { forecastHourly: string } }>(`https://api.weather.gov/points/${lat},${lon}`, 30 * 86400);
  const hourlyUrl = point?.properties?.forecastHourly;
  if (!hourlyUrl) return undefined;
  const hourly = await nws<{ properties: { periods: Period[]; updateTime?: string } }>(hourlyUrl, 1800);
  const periods = hourly?.properties?.periods;
  if (!periods?.length) return undefined;

  const kick = new Date(kickoffIso).getTime();
  const end = kick + 3.5 * 3600 * 1000;
  const at = periods.find((p) => new Date(p.startTime).getTime() <= kick && new Date(p.endTime).getTime() > kick);
  if (!at) return undefined; // kickoff is outside the 7-day hourly window
  const during = periods.filter((p) => {
    const t = new Date(p.startTime).getTime();
    return t >= kick - 3600 * 1000 && t < end;
  });

  const pops = during.map((p) => p.probabilityOfPrecipitation.value ?? 0);
  const maxPop = pops.length ? Math.max(...pops) : (at.probabilityOfPrecipitation.value ?? 0);
  const wetIdx = pops.findIndex((p) => p >= 50);
  const precipWindow =
    maxPop >= 50 ? (wetIdx <= 1 ? "from kickoff" : wetIdx <= 2 ? "by the 2nd quarter" : "in the 2nd half") : undefined;

  const temp = at.temperature;
  const rh = at.relativeHumidity.value ?? 50;
  const wind = mph(at.windSpeed);
  const gust = Math.max(wind, ...during.map((p) => mph(p.windSpeed)));
  const storm = during.some((p) => /thunder/i.test(p.shortForecast)) ? "watch" : "none";
  // Crosswind needs the field axis (OpenStreetMap, stadiums.json) and a wind direction. Calm or unknown stays undefined.
  const windFrom = compassToDegrees(at.windDirection);
  const component = v.fieldBearing != null && windFrom != null && wind > 0 ? windComponentFor(windFrom, v.fieldBearing) : undefined;

  return {
    windMph: wind,
    gustMph: gust,
    windDir: at.windDirection,
    crosswind: component === "crosswind",
    fieldBearing: v.fieldBearing,
    fieldBearingConfidence: v.fieldBearingConfidence,
    windComponent: component,
    precipChance: maxPop,
    precipWindow,
    tempF: temp,
    feelsLikeF: temp >= 80 ? heatIndex(temp, rh) : temp,
    humidity: rh,
    stormRisk: storm,
    roof: v.dome ? "fixed" : "open",
    surface: v.grass === false ? "turf" : "grass",
    elevationFt: v.elevationMeters != null ? Math.round(v.elevationMeters * 3.28084) : 0,
    asOf: hourly?.properties?.updateTime ?? new Date().toISOString(),
  };
}

/** Run forecasts with a small concurrency cap so a 60-game slate does not fire 120 requests at once. */
export async function forecastMany<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}
