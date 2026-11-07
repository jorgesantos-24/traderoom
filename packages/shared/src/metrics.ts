/**
 * Minimal Prometheus text-format registry (counters and gauges only).
 * Small enough that a client library is not worth the extra dependency.
 */
export type Labels = Readonly<Record<string, string>>;

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(labels[k] ?? '')}"`).join(',')}}`;
}

function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

interface Metric {
  name: string;
  help: string;
  type: 'counter' | 'gauge';
  samples(): Iterable<[string, number]>;
}

export class Counter {
  private readonly values = new Map<string, number>();

  inc(labels: Labels = {}, by = 1): void {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  samples(): Iterable<[string, number]> {
    return this.values.entries();
  }
}

export class Gauge {
  private readonly values = new Map<string, number>();

  constructor(private readonly collect?: () => Iterable<[Labels, number]>) {}

  set(labels: Labels, value: number): void {
    this.values.set(labelKey(labels), value);
  }

  get(labels: Labels = {}): number | undefined {
    return this.values.get(labelKey(labels));
  }

  *samples(): Iterable<[string, number]> {
    if (this.collect) {
      for (const [labels, value] of this.collect()) yield [labelKey(labels), value];
      return;
    }
    yield* this.values.entries();
  }
}

export class Registry {
  private readonly metrics: Metric[] = [];

  counter(name: string, help: string): Counter {
    const c = new Counter();
    this.metrics.push({ name, help, type: 'counter', samples: () => c.samples() });
    return c;
  }

  /** With `collect`, the gauge is computed at scrape time and `set` is ignored. */
  gauge(name: string, help: string, collect?: () => Iterable<[Labels, number]>): Gauge {
    const g = new Gauge(collect);
    this.metrics.push({ name, help, type: 'gauge', samples: () => g.samples() });
    return g;
  }

  render(): string {
    const out: string[] = [];
    for (const m of this.metrics) {
      out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`);
      for (const [labels, value] of m.samples()) out.push(`${m.name}${labels} ${formatValue(value)}`);
    }
    return `${out.join('\n')}\n`;
  }
}
