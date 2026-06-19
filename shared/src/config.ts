import { SFO_AIRPORT, type Airport } from "./airport.js";

export type Theme = "ambient" | "telemetry" | "focus";
export type LabelDensity = "all" | "nearestN" | "nearestOnly";
export type DataSource = "radio" | "api";
export type SpeedUnit = "kt" | "mph" | "kmh";
export type ProjectionMode = "map" | "sky";

export interface Palette {
  bg: string;
  glyph: string;
  trail: string;
  accent: string;
  warn: string;
  grid: string;
  text: string;
}

export interface Fonts {
  label: string;
  mono: string;
}

export interface LocationProfile {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusMiles: number;
}

export interface ShowFields {
  airline: boolean;
  flight: boolean;
  type: boolean;
  altitude: boolean;
  speed: boolean;
  verticalRate: boolean;
  destination: boolean;
  registration: boolean;
}

export interface Config {
  centerLat: number;
  centerLon: number;
  locationName: string;
  radiusMiles: number;
  locationProfiles: LocationProfile[];

  radioUrl: string;

  rotationDeg: number;
  mirrorX: boolean;
  mirrorY: boolean;
  labelRotationDeg: number;
  projectionMode: ProjectionMode;

  minAltitudeFt: number;
  maxAltitudeFt: number;
  hideOnGround: boolean;

  interpolate: boolean;
  maxExtrapolationSec: number;
  staleSec: number;
  smoothing: number;
  maxFps: number;

  theme: Theme;
  palette: Palette;
  fonts: Fonts;
  glyphSizePx: number;
  altitudeColor: boolean;
  trailSeconds: number;
  brightness: number;

  labelDensity: LabelDensity;
  nearestN: number;
  showFields: ShowFields;
  speedUnit: SpeedUnit;

  rangeRings: boolean;
  gridMode: boolean;
  compass: boolean;
  highlightEmergency: boolean;
  showAirport: boolean;
  airport: Airport;
  showHud: boolean;

  showStars: boolean;
  showSun: boolean;
  showMoon: boolean;
  showSatellites: boolean;
  satelliteLabels: boolean;
  showPlanets: boolean;
  starMagLimit: number;
  starLabelMagLimit: number;
  skyTimeOffsetMin: number;

  showDestArc: boolean;
  showRouteDetail: boolean;
  vignette: boolean;
}

export const DEFAULT_CONFIG: Config = {
  centerLat: 37.6213,
  centerLon: -122.379,
  locationName: "San Francisco International",
  radiusMiles: 3,
  locationProfiles: [],

  radioUrl: "http://localhost:8080/data/aircraft.json",

  rotationDeg: 0,
  mirrorX: true,
  mirrorY: false,
  labelRotationDeg: 0,
  projectionMode: "map",

  minAltitudeFt: 100,
  maxAltitudeFt: 60000,
  hideOnGround: true,

  interpolate: true,
  maxExtrapolationSec: 5,
  staleSec: 20,
  smoothing: 0.18,
  maxFps: 0,

  theme: "ambient",
  palette: {
    bg: "#000000",
    glyph: "#E8ECFF",
    trail: "#6B7280",
    accent: "#9B7ECF",
    warn: "#FF5A47",
    grid: "#3A4256",
    text: "#AEB6C6",
  },
  fonts: {
    label: "Inter, system-ui, sans-serif",
    mono: "'JetBrains Mono', ui-monospace, monospace",
  },
  glyphSizePx: 22,
  altitudeColor: true,
  trailSeconds: 45,
  brightness: 1,

  labelDensity: "all",
  nearestN: 5,
  showFields: {
    airline: true,
    flight: true,
    type: true,
    altitude: true,
    speed: true,
    verticalRate: false,
    destination: true,
    registration: false,
  },
  speedUnit: "kt",

  rangeRings: true,
  gridMode: false,
  compass: true,
  highlightEmergency: true,
  showAirport: true,
  airport: SFO_AIRPORT,
  showHud: false,

  showStars: true,
  showSun: true,
  showMoon: true,
  showSatellites: true,
  satelliteLabels: false,
  showPlanets: true,
  starMagLimit: 2.6,
  starLabelMagLimit: 0.3,
  skyTimeOffsetMin: 0,

  showDestArc: true,
  showRouteDetail: true,
  vignette: true,
};

export function mergeConfig(base: Config, patch: Partial<Config>): Config {
  return {
    ...base,
    ...patch,
    palette: { ...base.palette, ...(patch.palette ?? {}) },
    fonts: { ...base.fonts, ...(patch.fonts ?? {}) },
    showFields: { ...base.showFields, ...(patch.showFields ?? {}) },
  };
}
