import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchCpiSeries } from "../../artifacts/api-server/src/services/bls.js";

function mockFetchOnce(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? "OK" : "Internal Server Error",
      json: async () => body,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchCpiSeries", () => {
  it("parses real-shaped BLS monthly data points", async () => {
    mockFetchOnce({
      status: "REQUEST_SUCCEEDED",
      message: [],
      Results: {
        series: [
          {
            seriesID: "CUUR0000SA0",
            data: [
              { year: "2025", period: "M08", periodName: "August", value: "323.976" },
              { year: "2025", period: "M07", periodName: "July", value: "323.048" },
            ],
          },
        ],
      },
    });

    const result = await fetchCpiSeries(2025, 2025);
    expect(result).toEqual([
      { period: "2025-08-01", indexValue: 323.976 },
      { period: "2025-07-01", indexValue: 323.048 },
    ]);
  });

  // Confirmed live against the real BLS API (2026-09-17): a month BLS
  // hasn't published yet, or has withheld, comes back with value: "-"
  // instead of a numeric string (e.g. October 2025, footnoted "Data
  // unavailable due to the 2025 lapse in appropriations"). Number("-")
  // is NaN, which would silently corrupt inflation-adjustment math
  // downstream if stored -- must be skipped, not stored as NaN.
  it("skips a data point whose value is the BLS unavailable-data placeholder", async () => {
    mockFetchOnce({
      status: "REQUEST_SUCCEEDED",
      message: [],
      Results: {
        series: [
          {
            seriesID: "CUUR0000SA0",
            data: [
              { year: "2025", period: "M10", periodName: "October", value: "-" },
              { year: "2025", period: "M09", periodName: "September", value: "324.800" },
            ],
          },
        ],
      },
    });

    const result = await fetchCpiSeries(2025, 2025);
    expect(result).toEqual([{ period: "2025-09-01", indexValue: 324.8 }]);
  });

  it("skips M13 (annual average) -- not a real calendar month", async () => {
    mockFetchOnce({
      status: "REQUEST_SUCCEEDED",
      message: [],
      Results: {
        series: [
          {
            seriesID: "CUUR0000SA0",
            data: [
              { year: "2024", period: "M13", periodName: "Annual", value: "310.326" },
              { year: "2024", period: "M12", periodName: "December", value: "315.605" },
            ],
          },
        ],
      },
    });

    const result = await fetchCpiSeries(2024, 2024);
    expect(result).toEqual([{ period: "2024-12-01", indexValue: 315.605 }]);
  });

  it("returns an empty array when the requested series isn't in the response", async () => {
    mockFetchOnce({ status: "REQUEST_SUCCEEDED", message: [], Results: { series: [] } });
    const result = await fetchCpiSeries(2025, 2025);
    expect(result).toEqual([]);
  });

  it("throws on a non-REQUEST_SUCCEEDED status", async () => {
    mockFetchOnce({ status: "REQUEST_NOT_PROCESSED", message: ["bad series id"] });
    await expect(fetchCpiSeries(2025, 2025)).rejects.toThrow(/REQUEST_NOT_PROCESSED/);
  });

  it("throws on an HTTP-level failure", async () => {
    mockFetchOnce({}, false);
    await expect(fetchCpiSeries(2025, 2025)).rejects.toThrow(/500/);
  });
});
