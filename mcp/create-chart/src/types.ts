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

export type RenderChartToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };

export interface RenderChartToolResponse {
  content: [
    { type: "text"; text: string },
    { type: "image"; data: string; mimeType: "image/png" },
  ];
}
