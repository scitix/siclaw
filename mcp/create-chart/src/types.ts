export interface PieSlice {
  label: string;
  value: number;
}

export interface BarSeries {
  name: string;
  values: number[];
}

export interface LinePoint {
  x: number | string;
  y: number;
}

export interface LineSeries {
  name: string;
  points: LinePoint[];
}

export interface ChartCommonOpts {
  title?: string;
  width?: number;
  height?: number;
  x_label?: string;
  y_label?: string;
}

export type RenderChartArgs =
  | ({ type: "pie"; data: { slices: PieSlice[] } } & ChartCommonOpts)
  | ({
      type: "bar";
      data: { categories: string[]; series: BarSeries[] };
    } & ChartCommonOpts)
  | ({ type: "line"; data: { series: LineSeries[] } } & ChartCommonOpts);

export interface RenderChartResult {
  chart_id: string;
  type: "pie" | "bar" | "line";
  spec_path: string;
  svg_path: string;
  bytes: number;
  embed_instructions: string;
}
