/**
 * BLS (Bureau of Labor Statistics) public API adapter -- the source of
 * real CPI-U data for Advanced Goals' inflation adjustment (see
 * workspace-notes/RECURRING_AND_GOALS_SPEC.md's "Advanced Goals"
 * section). Series CUUR0000SA0: CPI-U, all items, US city average, not
 * seasonally adjusted -- the standard general-inflation series.
 *
 * Same swap-point convention as plaid.ts: real implementation behind a
 * plain function, an explicit env var gate, no SDK dependency (BLS's API
 * is plain JSON over HTTPS, no client library needed).
 *
 * Works keyless (BLS_API_KEY unset) at v1-tier limits (25 queries/day,
 * 10-year lookback) -- plenty for a monthly-cadence sync. Set
 * BLS_API_KEY (free registration at https://www.bls.gov/developers/) to
 * raise those limits (500/day, 20-year lookback); no code change needed
 * either way, since `registrationkey` is simply omitted from the request
 * body when unset.
 */

const BLS_SERIES_ID = "CUUR0000SA0";
const BLS_API_URL = "https://api.bls.gov/publicAPI/v2/timeseries/data/";
const REQUEST_TIMEOUT_MS = 10_000;

export interface CpiDataPoint {
  period: string; // "YYYY-MM-01"
  indexValue: number;
}

interface BlsApiResponse {
  status: string;
  message?: string[];
  Results?: {
    series: Array<{
      seriesID: string;
      data: Array<{ year: string; period: string; periodName: string; value: string }>;
    }>;
  };
}

/** Fetches CPI-U monthly index values for [startYear, endYear] (inclusive).
 * Skips BLS's non-monthly period codes (M13 = annual average) -- only
 * M01-M12 map to a real calendar month. Throws on a network/HTTP failure
 * or a non-REQUEST_SUCCEEDED status; the caller (routes/actions.ts)
 * decides how to surface that, since a failed sync is a legitimate
 * "nothing changed" outcome for an Actions Contract action, not a crash. */
export async function fetchCpiSeries(startYear: number, endYear: number): Promise<CpiDataPoint[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const body: Record<string, unknown> = {
      seriesid: [BLS_SERIES_ID],
      startyear: String(startYear),
      endyear: String(endYear),
    };
    if (process.env.BLS_API_KEY) body.registrationkey = process.env.BLS_API_KEY;

    const res = await fetch(BLS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`BLS API request failed: ${res.status} ${res.statusText}`);

    const data = (await res.json()) as BlsApiResponse;
    if (data.status !== "REQUEST_SUCCEEDED") {
      throw new Error(`BLS API returned ${data.status}: ${(data.message ?? []).join("; ")}`);
    }

    const series = data.Results?.series.find((s) => s.seriesID === BLS_SERIES_ID);
    if (!series) return [];

    return series.data
      .filter((point) => /^M(0[1-9]|1[0-2])$/.test(point.period))
      .map((point) => {
        const month = point.period.slice(1); // "M08" -> "08"
        return { period: `${point.year}-${month}-01`, indexValue: Number(point.value) };
      });
  } finally {
    clearTimeout(timeout);
  }
}
