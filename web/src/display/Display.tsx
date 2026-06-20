import { useEffect, useMemo, useRef, useState } from "react";
import type { Config, Theme } from "@shared/index.js";
import { DEFAULT_CONFIG } from "@shared/index.js";
import { useStream } from "../lib/useStream.js";
import { Renderer } from "./renderer.js";
import { Renderer3D } from "./renderer3d.js";

const THEMES: Theme[] = ["ambient", "telemetry", "focus"];

let audioCtx: AudioContext | null = null;

function apDisconnect(): void {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const notes = [392, 523, 659, 784];
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

type AnyRenderer = {
  togglePin(x: number, y: number): void;
  setHover(x: number, y: number): void;
  update(aircraft: Parameters<Renderer["update"]>[0]): void;
  setSourceOk(ok: boolean): void;
};

export function Display() {
  const { state, conn } = useStream("display");

  // Two canvas refs — 2D and 3D — only one visible at a time
  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const canvas3dRef  = useRef<HTMLCanvasElement>(null);
  const container3dRef = useRef<HTMLDivElement>(null);

  const rendererRef  = useRef<AnyRenderer | null>(null);
  const configRef    = useRef<Config>(state.config ?? DEFAULT_CONFIG);
  configRef.current  = state.config ?? DEFAULT_CONFIG;

  const [showFsHint, setShowFsHint] = useState(true);
  const [showStats,  setShowStats]  = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setShowFsHint(false), 4000);
    return () => clearTimeout(t);
  }, []);

  const view3d = state.config?.view3d ?? false;

  // 2D renderer — active when view3d is false
  useEffect(() => {
    if (view3d || !canvasRef.current) return;
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
  }, [view3d]);

  // 3D renderer — active when view3d is true
  useEffect(() => {
    if (!view3d || !canvas3dRef.current || !container3dRef.current) return;
    const r = new Renderer3D(canvas3dRef.current, container3dRef.current, () => configRef.current);
    rendererRef.current = r;
    r.start();
    const onResize = () => r.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      r.stop();
      rendererRef.current = null;
    };
  }, [view3d]);

  // Feed snapshots to whichever renderer is active
  useEffect(() => {
    rendererRef.current?.update(state.aircraft);
  }, [state.now, state.aircraft]);

  // Source health
  useEffect(() => {
    rendererRef.current?.setSourceOk(state.connected && (state.status?.ok ?? true));
  }, [state.connected, state.status]);

  // Mouse events — attach to both canvases; only the visible one fires
  useEffect(() => {
    const attach = (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return () => {};
      const onMove = (e: MouseEvent) => {
        const r = canvas.getBoundingClientRect();
        rendererRef.current?.setHover(e.clientX - r.left, e.clientY - r.top);
      };
      const onLeave = () => rendererRef.current?.setHover(-999, -999);
      const onClick = (e: MouseEvent) => {
        const r = canvas.getBoundingClientRect();
        rendererRef.current?.togglePin(e.clientX - r.left, e.clientY - r.top);
      };
      const onDbl = () => {
        if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
        else document.exitFullscreen?.();
      };
      canvas.addEventListener("mousemove", onMove);
      canvas.addEventListener("mouseleave", onLeave);
      canvas.addEventListener("click", onClick);
      canvas.addEventListener("dblclick", onDbl);
      return () => {
        canvas.removeEventListener("mousemove", onMove);
        canvas.removeEventListener("mouseleave", onLeave);
        canvas.removeEventListener("click", onClick);
        canvas.removeEventListener("dblclick", onDbl);
      };
    };
    const c1 = attach(canvasRef.current);
    const c2 = attach(canvas3dRef.current);
    return () => { c1(); c2(); };
  }, []);

  // Sound alert on new arrivals
  const alertedRef = useRef(new Set<string>());
  useEffect(() => {
    const cfg = configRef.current;
    const alerted = alertedRef.current;
    const nowHexes = new Set(state.aircraft.map((a) => a.hex));
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

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = configRef.current;
      switch (e.key) {
        case "r": conn.patchConfig({ rotationDeg: (c.rotationDeg + 5) % 360 }); break;
        case "R": conn.patchConfig({ rotationDeg: (c.rotationDeg - 5 + 360) % 360 }); break;
        case "m": conn.patchConfig({ mirrorX: !c.mirrorX }); break;
        case "M": conn.patchConfig({ mirrorY: !c.mirrorY }); break;
        case "t": {
          const next = THEMES[(THEMES.indexOf(c.theme) + 1) % THEMES.length];
          conn.patchConfig({ theme: next });
          break;
        }
        case "[": conn.patchConfig({ radiusMiles: Math.max(0.5, c.radiusMiles - 0.5) }); break;
        case "]": conn.patchConfig({ radiusMiles: c.radiusMiles + 0.5 }); break;
        case "h": conn.patchConfig({ showHud: !c.showHud }); break;
        case "3": conn.patchConfig({ view3d: !c.view3d }); break;
        case "f":
        case "F":
          if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
          else document.exitFullscreen?.();
          break;
        case "s":
        case "S":
          setShowStats((v) => !v);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conn]);

  const cfg = state.config;

  const stats = useMemo(() => {
    if (!cfg) return null;
    const cos = Math.cos(cfg.centerLat * Math.PI / 180);
    const positioned = state.aircraft.filter((a) => a.lat != null && a.lon != null);
    if (!positioned.length) return null;
    const withDist = positioned.map((a) => {
      const dLat = a.lat! - cfg.centerLat;
      const dLon = (a.lon! - cfg.centerLon) * cos;
      return { a, mi: Math.sqrt(dLat * dLat + dLon * dLon) * 69 };
    });
    const nearest = withDist.reduce((x, y) => (x.mi < y.mi ? x : y));
    const fastest = positioned.reduce((x, y) => ((y.gs ?? 0) > (x.gs ?? 0) ? y : x));
    const highest = positioned.reduce((x, y) =>
      ((y.altBaro ?? y.altGeom ?? 0) > (x.altBaro ?? x.altGeom ?? 0) ? y : x),
    );
    return { count: positioned.length, nearest, fastest, highest };
  }, [state.aircraft, cfg]);

  return (
    <div className="display-root">
      {/* 2D canvas */}
      <canvas
        ref={canvasRef}
        className="display-canvas"
        style={{ display: view3d ? "none" : "block" }}
      />

      {/* 3D container — Three.js injects its CSS2D label overlay here */}
      <div
        ref={container3dRef}
        style={{
          display: view3d ? "block" : "none",
          position: "absolute",
          inset: 0,
        }}
      >
        <canvas ref={canvas3dRef} className="display-canvas" />
      </div>

      {cfg?.showHud && (
        <div className="hud">
          <div className={`hud-dot ${state.connected ? "ok" : "bad"}`} />
          <span>
            {state.status?.source ?? "—"} · {state.aircraft.length} ac ·{" "}
            rot {cfg.rotationDeg}° · {view3d ? "3D" : cfg.projectionMode} · {cfg.theme}
          </span>
        </div>
      )}

      {showStats && stats && (
        <div className="stats-strip" onClick={() => setShowStats(false)}>
          <span className="stats-count">{stats.count} visible</span>
          <span className="stats-sep">·</span>
          <span>
            nearest&nbsp;
            <strong>{stats.nearest.a.flight ?? stats.nearest.a.hex.toUpperCase()}</strong>
            &nbsp;{stats.nearest.mi.toFixed(1)} mi
          </span>
          <span className="stats-sep">·</span>
          <span>
            fastest&nbsp;
            <strong>{stats.fastest.flight ?? stats.fastest.hex.toUpperCase()}</strong>
            &nbsp;{Math.round(stats.fastest.gs ?? 0)} kt
          </span>
          <span className="stats-sep">·</span>
          <span>
            highest&nbsp;
            <strong>{stats.highest.flight ?? stats.highest.hex.toUpperCase()}</strong>
            &nbsp;{((stats.highest.altBaro ?? stats.highest.altGeom ?? 0) / 1000).toFixed(0)}k ft
          </span>
        </div>
      )}

      {showFsHint && !document.fullscreenElement && (
        <div className="fs-hint">press F or double-click for fullscreen · 3 for 3D mode</div>
      )}
      {!state.connected && <div className="reconnect">connecting…</div>}
    </div>
  );
}
