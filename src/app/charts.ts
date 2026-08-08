/**
 * Crude trend charts (WP-A6).
 *
 * Seven sparklines over generations, drawn on one canvas. The form follows from
 * the question: every one of these is change-over-time, so every one is a line.
 *
 * Colour comes from `palette.ts`, whose values were validated against this app's
 * own surfaces. Two rules from that method do real work here and are worth
 * naming, because breaking either is the usual way a chart like this goes wrong:
 *
 * - **One axis, never two scales.** The tOpt panel carries the population's mean
 *   thermal optimum *and* the mean water temperature, which is legal only because
 *   both are °C on one shared scale — that is what makes "tOpt chases the climate
 *   with a lag" readable as a gap between two lines. `tOpt`'s trait link is the
 *   identity, so its latent mean is already in °C and needs no conversion. The
 *   attack/defense panel is the same trick in logit units.
 * - **A second series gets a legend.** Single-series panels take slot 1 and are
 *   named by their title instead, and no label text is ever tinted with the
 *   series colour: a swatch carries identity, ink carries words.
 *
 * Rows arrive as `SampleRow`s and are flattened into plain number columns on
 * arrival, so a long ambient run retains a few arrays of floats instead of
 * thousands of fat objects.
 */

import type { SampleRow } from '../contracts/stats';
import { BASELINE, GRIDLINE, INK_MUTED, INK_SECONDARY, SERIES_1, SERIES_2 } from './palette';

export interface TrendSeries {
  generation: number[];
  population: number[];
  sizeMean: number[];
  sizeSd: number[];
  tOptMean: number[];
  tOptSd: number[];
  waterTempC: number[];
  attackMean: number[];
  defenseMean: number[];
  speedCapMean: number[];
  speedCapSd: number[];
  predatorFraction: number[];
  heterozygosity: number[];
}

export function createTrendSeries(): TrendSeries {
  return {
    generation: [],
    population: [],
    sizeMean: [],
    sizeSd: [],
    tOptMean: [],
    tOptSd: [],
    waterTempC: [],
    attackMean: [],
    defenseMean: [],
    speedCapMean: [],
    speedCapSd: [],
    predatorFraction: [],
    heterozygosity: [],
  };
}

export function resetTrendSeries(series: TrendSeries): void {
  for (const key of Object.keys(series) as (keyof TrendSeries)[]) series[key].length = 0;
}

export function appendTrendRow(series: TrendSeries, row: SampleRow): void {
  series.generation.push(row.generation);
  series.population.push(row.population);
  series.sizeMean.push(row.traits.size.mean);
  series.sizeSd.push(row.traits.size.sd);
  series.tOptMean.push(row.traits.tOpt.mean);
  series.tOptSd.push(row.traits.tOpt.sd);
  series.waterTempC.push(row.resources.meanTemperatureC);
  series.attackMean.push(row.guilds.meanAttack);
  series.defenseMean.push(row.guilds.meanDefense);
  series.speedCapMean.push(row.traits.speedCap.mean);
  series.speedCapSd.push(row.traits.speedCap.sd);
  series.predatorFraction.push(row.guilds.predatorFraction);
  series.heterozygosity.push(row.popgen.meanHeterozygosity);
}

interface Line {
  readonly values: readonly number[];
  readonly colour: string;
  readonly label: string;
  /** Optional ±1 SD band around `values`. */
  readonly sd?: readonly number[];
}

interface Panel {
  readonly title: string;
  readonly lines: readonly Line[];
  /** Force the y range to include these, e.g. 0 for a fraction. */
  readonly include?: readonly number[];
}

const COLUMNS = 4;
const PANEL_GAP = 10;
const TITLE_HEIGHT = 14;
const AXIS_WIDTH = 42;

/** Share of the window height the strip occupies; mirrored by `#charts` in index.html. */
const STRIP_HEIGHT_FRACTION = 0.34;

export class TrendCharts {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private cssWidth = 1;
  private cssHeight = 1;

  constructor(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('chart canvas 2d context unavailable');
    this.canvas = canvas;
    this.context = context;
  }

  /**
   * Size from the viewport, not from the element's own box.
   *
   * A canvas is a replaced element, so an absolutely-positioned one with `left:0;
   * right:0` and no CSS `width` takes its *intrinsic* width — the `width`
   * attribute — instead of stretching. Measuring `getBoundingClientRect()` and
   * writing the result back into that attribute therefore feeds the canvas its
   * own stale size and the strip creeps outward a little on every resize instead
   * of filling the window. Both the CSS box and the backing store are set here.
   */
  resize(): void {
    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio));
    this.cssWidth = Math.max(1, window.innerWidth);
    this.cssHeight = Math.max(1, Math.round(window.innerHeight * STRIP_HEIGHT_FRACTION));
    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;
    this.canvas.width = Math.round(this.cssWidth * ratio);
    this.canvas.height = Math.round(this.cssHeight * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  draw(series: TrendSeries): void {
    const context = this.context;
    context.clearRect(0, 0, this.cssWidth, this.cssHeight);
    context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textBaseline = 'middle';

    if (series.generation.length < 2) {
      context.fillStyle = INK_MUTED;
      context.fillText('waiting for sample rows — the first lands at tick 200', 12, this.cssHeight / 2);
      return;
    }

    const panels: readonly Panel[] = [
      { title: 'population', lines: [{ values: series.population, colour: SERIES_1, label: 'pop' }], include: [0] },
      {
        title: 'tOpt vs water °C',
        lines: [
          { values: series.tOptMean, colour: SERIES_1, label: 'tOpt', sd: series.tOptSd },
          { values: series.waterTempC, colour: SERIES_2, label: 'water' },
        ],
      },
      {
        title: 'attack vs defense (logit)',
        lines: [
          { values: series.attackMean, colour: SERIES_1, label: 'attack' },
          { values: series.defenseMean, colour: SERIES_2, label: 'defense' },
        ],
      },
      {
        title: 'predator fraction',
        lines: [{ values: series.predatorFraction, colour: SERIES_1, label: 'predators' }],
        include: [0, 1],
      },
      { title: 'size (cm)', lines: [{ values: series.sizeMean, colour: SERIES_1, label: 'size', sd: series.sizeSd }] },
      {
        title: 'speedCap (wu/tick)',
        lines: [{ values: series.speedCapMean, colour: SERIES_1, label: 'speedCap', sd: series.speedCapSd }],
      },
      {
        title: 'heterozygosity',
        lines: [{ values: series.heterozygosity, colour: SERIES_1, label: 'H' }],
        include: [0],
      },
    ];

    const rows = Math.ceil(panels.length / COLUMNS);
    const panelWidth = (this.cssWidth - PANEL_GAP * (COLUMNS + 1)) / COLUMNS;
    const panelHeight = (this.cssHeight - PANEL_GAP * (rows + 1)) / rows;

    for (let index = 0; index < panels.length; index += 1) {
      const panel = panels[index];
      if (panel === undefined) continue;
      const column = index % COLUMNS;
      const row = Math.floor(index / COLUMNS);
      this.drawPanel(
        panel,
        series.generation,
        PANEL_GAP + column * (panelWidth + PANEL_GAP),
        PANEL_GAP + row * (panelHeight + PANEL_GAP),
        panelWidth,
        panelHeight,
      );
    }
  }

  private drawPanel(panel: Panel, generations: readonly number[], x: number, y: number, width: number, height: number): void {
    const context = this.context;

    // maxWidth so a long title can never run into the next panel's.
    context.fillStyle = INK_SECONDARY;
    context.fillText(panel.title, x, y + TITLE_HEIGHT / 2, Math.max(20, width - 4));

    const plotX = x + AXIS_WIDTH;
    const plotY = y + TITLE_HEIGHT + 4;
    const plotWidth = Math.max(8, width - AXIS_WIDTH);
    const plotHeight = Math.max(8, height - TITLE_HEIGHT - 16);

    let low = Infinity;
    let high = -Infinity;
    for (const line of panel.lines) {
      for (let index = 0; index < line.values.length; index += 1) {
        const value = line.values[index] ?? 0;
        const spread = line.sd?.[index] ?? 0;
        if (value - spread < low) low = value - spread;
        if (value + spread > high) high = value + spread;
      }
    }
    for (const forced of panel.include ?? []) {
      if (forced < low) low = forced;
      if (forced > high) high = forced;
    }
    if (!Number.isFinite(low) || !Number.isFinite(high)) return;
    if (high - low < 1e-9) {
      high += 0.5;
      low -= 0.5;
    }

    const toX = (index: number): number =>
      plotX + (generations.length < 2 ? 0 : (index / (generations.length - 1)) * plotWidth);
    const toY = (value: number): number => plotY + plotHeight - ((value - low) / (high - low)) * plotHeight;

    // Recessive frame: a hairline baseline and top rule, no grid box.
    context.strokeStyle = GRIDLINE;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(plotX, plotY);
    context.lineTo(plotX + plotWidth, plotY);
    context.stroke();
    context.strokeStyle = BASELINE;
    context.beginPath();
    context.moveTo(plotX, plotY + plotHeight);
    context.lineTo(plotX + plotWidth, plotY + plotHeight);
    context.stroke();

    // Axis extremes as text, which is all a sparkline needs and is also the
    // relief channel that lets the lines themselves stay thin and unlabelled.
    context.fillStyle = INK_MUTED;
    context.textAlign = 'right';
    context.fillText(formatTick(high), plotX - 5, plotY + 5);
    context.fillText(formatTick(low), plotX - 5, plotY + plotHeight - 5);
    context.textAlign = 'left';

    for (const line of panel.lines) {
      if (line.sd !== undefined) {
        context.fillStyle = line.colour;
        context.globalAlpha = 0.16;
        context.beginPath();
        for (let index = 0; index < line.values.length; index += 1) {
          const point = (line.values[index] ?? 0) + (line.sd[index] ?? 0);
          if (index === 0) context.moveTo(toX(index), toY(point));
          else context.lineTo(toX(index), toY(point));
        }
        for (let index = line.values.length - 1; index >= 0; index -= 1) {
          const point = (line.values[index] ?? 0) - (line.sd[index] ?? 0);
          context.lineTo(toX(index), toY(point));
        }
        context.closePath();
        context.fill();
        context.globalAlpha = 1;
      }

      context.strokeStyle = line.colour;
      context.lineWidth = 1.75;
      context.beginPath();
      for (let index = 0; index < line.values.length; index += 1) {
        const point = toY(line.values[index] ?? 0);
        if (index === 0) context.moveTo(toX(index), point);
        else context.lineTo(toX(index), point);
      }
      context.stroke();
    }

    // A legend only where there are two series to tell apart; a lone series is
    // named by the panel title. The swatch carries identity so the words can
    // stay in ordinary ink.
    if (panel.lines.length > 1) {
      let legendX = plotX;
      const legendY = plotY + plotHeight + 8;
      for (const line of panel.lines) {
        context.strokeStyle = line.colour;
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(legendX, legendY);
        context.lineTo(legendX + 10, legendY);
        context.stroke();
        context.fillStyle = INK_MUTED;
        context.fillText(line.label, legendX + 14, legendY);
        legendX += 16 + context.measureText(line.label).width + 10;
      }
    } else {
      context.fillStyle = INK_MUTED;
      context.fillText(
        `gen ${formatTick(generations[0] ?? 0)}–${formatTick(generations[generations.length - 1] ?? 0)}`,
        plotX,
        plotY + plotHeight + 8,
      );
    }
  }
}

function formatTick(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return value.toFixed(0);
  if (magnitude >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
