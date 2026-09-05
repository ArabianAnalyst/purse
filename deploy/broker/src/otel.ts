import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

/** Starts the OpenTelemetry SDK from the standard OTEL_EXPORTER_OTLP_* environment. Returns a shutdown, or null when no endpoint is set. */
export function startOtel(serviceName = "purse-broker"): (() => Promise<void>) | null {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15_000 }),
  });
  sdk.start();
  return () => sdk.shutdown();
}
