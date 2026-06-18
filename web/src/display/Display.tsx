import { useEffect, useRef } from "react";
import type { Config, Theme } from "@shared/index.js";
import { DEFAULT_CONFIG } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { Renderer } from "./renderer.js";

const THEMES: Theme[] = ["ambient", "telemetry", "focus"];

const DEG = Math.PI / 180;
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG);
  const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}
function angleDiff(a: number, b: number): number {
  const d = ((a - b) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

let audioCtx: AudioContext | null = null;

function beep(freq = 880, duration = 0.18): void {
  try {
    audioCtx ??= new AudioContext();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch { /* audio blocked */ }
}

/** Boeing-style autopilot disconnect: cavalry-charge G→C→E→G, played twice. */
function apDisconnect(): void {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    // Cavalry charge notes (Hz) and relative durations
    const notes = [392, 523, 659, 784]; // G4 C5 E5 G5
    const noteDur = 0.09;
    const gap = 0.01;
    const repeatDelay = 0.45;

    for (let rep = 0; rep < 2; rep++) {
      notes.forEach((freq, i) => {
        const t = ctx.currentTime + rep * repeatDelay + i * (noteDur + gap);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "square";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.14, t + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.001, t + noteDur);
        osc.start(t);
        osc.stop(t + noteDur);
      });
    }
  } catch { /* audio blocked */ }
}

export function Display() {
  const { state, conn } = useStream("display");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);

  // Keep the latest config in a ref so the RAF loop always reads fresh values.
  const configRef = useRef<Config>(state.config ?? DEFAULT_CONFIG);
  configRef.current = state.config ?? DEFAULT_CONFIG;

  // Create renderer once.
  useEffect(() => {
    if (!canvasRef.current) return;
    const r = new Renderer(canvasRef.current, () => configRef.current);
    rendererRef.current = r;
    r.start();
    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      r.stop();
      rendererRef.current = null;
    };
  }, []);

  // Feed snapshots.
  useEffect(() => {
    rendererRef.current?.update(state.aircraft);
  }, [state.now, state.aircraft]);

  // Source health: during an outage the renderer holds planes instead of
  // staling them out. A dropped WebSocket counts as an outage too.
  useEffect(() => {
    rendererRef.current?.setSourceOk(state.connected && (state.status?.ok ?? true));
  }, [state.connected, state.status]);

  // Mouse hover — pass canvas-local coords to the renderer.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onMove = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      rendererRef.current?.setHover(e.clientX - r.left, e.clientY - r.top);
    };
    const onLeave = () => rendererRef.current?.setHover(-999, -999);
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  // Sound alert: beep once when a new aircraft enters the visible radius.
  const alertedRef = useRef(new Set<string>());
  useEffect(() => {
    const cfg = configRef.current;
    const alerted = alertedRef.current;
    const nowHexes = new Set(state.aircraft.map((a) => a.hex));

    // Remove aircraft that have left so they can beep again if they return.
    for (const hex of alerted) {
      if (!nowHexes.has(hex)) alerted.delete(hex);
    }

    for (const ac of state.aircraft) {
      if (ac.lat == null || ac.lon == null) continue;
      if (alerted.has(ac.hex)) continue;

      const dLat = ac.lat - cfg.centerLat;
      const dLon = (ac.lon - cfg.centerLon) * Math.cos(cfg.centerLat * Math.PI / 180);
      const rangeMi = Math.sqrt(dLat * dLat + dLon * dLon) * 69;

      if (rangeMi <= cfg.radiusMiles) {
        alerted.add(ac.hex);
        apDisconnect();
      }
    }
  }, [state.aircraft, state.now]);

  // Keyboard calibration (handy when a keyboard is plugged into the Pi).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = configRef.current;
      switch (e.key) {
        case "r":
          conn.patchConfig({ rotationDeg: (c.rotationDeg + 5) % 360 });
          break;
        case "R":
          conn.patchConfig({ rotationDeg: (c.rotationDeg - 5 + 360) % 360 });
          break;
        case "m":
          conn.patchConfig({ mirrorX: !c.mirrorX });
          break;
        case "M":
          conn.patchConfig({ mirrorY: !c.mirrorY });
          break;
        case "t": {
          const next = THEMES[(THEMES.indexOf(c.theme) + 1) % THEMES.length];
          conn.patchConfig({ theme: next });
          break;
        }
        case "[":
          conn.patchConfig({ radiusMiles: Math.max(0.5, c.radiusMiles - 0.5) });
          break;
        case "]":
          conn.patchConfig({ radiusMiles: c.radiusMiles + 0.5 });
          break;
        case "h":
          conn.patchConfig({ showHud: !c.showHud });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conn]);

  const cfg = state.config;
  return (
    <div className="display-root">
      <canvas ref={canvasRef} className="display-canvas" />
      {cfg?.showHud && (
        <div className="hud">
          <div className={`hud-dot ${state.connected ? "ok" : "bad"}`} />
          <span>
            {state.status?.source ?? "—"} · {state.aircraft.length} ac ·{" "}
            rot {cfg.rotationDeg}° · mirror {cfg.mirrorX ? "X" : "–"}
            {cfg.mirrorY ? "Y" : ""} · r {cfg.radiusMiles}mi · {cfg.projectionMode} · {cfg.theme}
          </span>
        </div>
      )}
      {!state.connected && <div className="reconnect">connecting…</div>}
    </div>
  );
}
