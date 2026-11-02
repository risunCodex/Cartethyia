# Cleanup proposal — observability

Status: proposal, belum diimplementasikan.
Sumber: audit statis (lihat README).

## Ringkasan

- Files: 18 · kandidat dead exports: 31

## Kandidat

- `EventQuery`
- `EventTotals`
- `EventListQuery`
- `BreakdownGroup`
- `HealthTotals`
- `eventRecordFromRow`
- `FamilyKpiTotals`
- `FamilyUsageTotals`
- `HealthPerformance`
- `UsagePerformanceTotals`
- `ConsoleLogEvent`
- `resetConsoleLogsForTests`
- `LOG_CIRCULAR_MARKER`
- `MetricLabels`
- `CounterMetric`
- `GaugeMetric`
- `HistogramMetric`
- `CaptureScope`
- `PayloadSignals`
- `StoredPayload`
- `isPayloadFileReference`
- `MAX_PERFORMANCE_ENTRIES`
- `PerformanceMetricsSnapshot`
- `resetPerformanceMetricsForTesting`
- `RequestCompletedNotice`
- `resetRequestNotifyForTests`
- `RuntimeMetricSources`
- `TelemetryBatchBufferOptions`
- `ReconcileOptions`
- `ReconcileReport`
- `TokenSpeedInput`

## Catatan

Hati-hati: reset*ForTests dipakai test (sudah ikut dicek, tapi bila tak ada referensi test, boleh hapus).

## Verifikasi

1. Untuk tiap kandidat: grep lintas seluruh repo (termasuk .tsx/docs/scripts)
   untuk re-export alias & magic string.
2. Privatkan bila internal-only; hapus bila benar-benar tak dipakai.
3. Jalankan `bunx tsc --noEmit`, `bun run test:backend`,
   `bun run dashboard:typecheck`, dan golden payload protocol.
