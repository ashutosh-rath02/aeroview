import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { llToMeters, type Aircraft, type Config } from '@shared/index.js'
import { drawAircraftGlyph, classifyGlyph, GLYPH_SCALE, type GlyphKind } from './aircraftGlyph.js'
import tzLookup from 'tz-lookup'

// ─── constants ────────────────────────────────────────────────────────────────

const MI = 1609.34
const ALT_EX = 4 / 5280    // ft → miles, 4× vertical exaggeration
const MAX_HIST = 48
const TUBE_R = 0.06
const TUBE_RAD_SEG = 5
const DEG = Math.PI / 180
const PLANE_SIZE = 1.8

// ─── detail panel helpers ─────────────────────────────────────────────────────

function gcMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const d2r = Math.PI / 180
  const φ1 = lat1 * d2r, φ2 = lat2 * d2r
  const dφ = (lat2 - lat1) * d2r, dλ = (lon2 - lon1) * d2r
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function localTimeAt(lat: number, lon: number): string {
  try {
    const tz = tzLookup(lat, lon)
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz })
  } catch {
    const now = new Date()
    let m = (now.getUTCHours() * 60 + now.getUTCMinutes() + (lon / 15) * 60) % 1440
    if (m < 0) m += 1440
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`
  }
}

// ─── altitude colour ramp ─────────────────────────────────────────────────────

const ALT_STOPS: [number, [number, number, number]][] = [
  [0,     [255, 138,  61]],
  [4000,  [255, 198,  92]],
  [10000, [120, 224, 196]],
  [20000, [110, 178, 255]],
  [30000, [150, 150, 255]],
  [40000, [232, 236, 255]],
]

function altColor(ft: number): THREE.Color {
  if (ft <= ALT_STOPS[0][0]) return rgb3(ALT_STOPS[0][1])
  for (let i = 1; i < ALT_STOPS.length; i++) {
    if (ft <= ALT_STOPS[i][0]) {
      const [a0, c0] = ALT_STOPS[i - 1]
      const [a1, c1] = ALT_STOPS[i]
      const f = (ft - a0) / (a1 - a0)
      return new THREE.Color(
        (c0[0] + (c1[0] - c0[0]) * f) / 255,
        (c0[1] + (c1[1] - c0[1]) * f) / 255,
        (c0[2] + (c1[2] - c0[2]) * f) / 255,
      )
    }
  }
  return rgb3(ALT_STOPS[ALT_STOPS.length - 1][1])
}

function rgb3([r, g, b]: [number, number, number]): THREE.Color {
  return new THREE.Color(r / 255, g / 255, b / 255)
}

// ─── coordinate conversion ────────────────────────────────────────────────────

function toScene(
  m: { east: number; north: number },
  altFt: number,
  cfg: Config,
): THREE.Vector3 {
  const cos = Math.cos(cfg.rotationDeg * DEG)
  const sin = Math.sin(cfg.rotationDeg * DEG)
  const ex = (m.east  / MI) * (cfg.mirrorX ? -1 : 1)
  const nz = -(m.north / MI)
  return new THREE.Vector3(
    ex * cos + nz * sin,
    altFt * ALT_EX,
    -ex * sin + nz * cos,
  )
}

// ─── neon trail colour palette ────────────────────────────────────────────────
// Each aircraft gets a stable colour from its ICAO hex. Colours are pre-brightened
// (values > 0.5) so additive blending produces a visible glow even at low opacity.

const NEON_PALETTE = [
  new THREE.Color(0.0,  1.0,  1.0),   // cyan
  new THREE.Color(1.0,  0.08, 0.58),  // hot-pink
  new THREE.Color(0.18, 1.0,  0.22),  // lime
  new THREE.Color(1.0,  0.56, 0.0),   // amber
  new THREE.Color(0.28, 0.5,  1.0),   // electric blue
  new THREE.Color(0.78, 0.0,  1.0),   // violet
  new THREE.Color(0.0,  1.0,  0.5),   // mint
  new THREE.Color(1.0,  0.85, 0.0),   // gold
  new THREE.Color(1.0,  0.25, 0.0),   // red-orange
  new THREE.Color(0.4,  0.88, 1.0),   // sky-blue
]

// ─── tube trail helper ────────────────────────────────────────────────────────
// Returns a Group with two passes: a tight bright core + a wide soft bloom.
// colorIdx is a per-aircraft constant derived from its ICAO hex address.

function buildTube(pts: THREE.Vector3[], colorIdx: number, w = 1): THREE.Group {
  const col     = NEON_PALETTE[colorIdx % NEON_PALETTE.length]
  const group   = new THREE.Group()
  const curve   = new THREE.CatmullRomCurve3(pts)
  const tubeSeg = Math.max(pts.length * 3, 12)
  const ring    = TUBE_RAD_SEG + 1

  const makeMesh = (radius: number, opacity: number) => {
    const geo    = new THREE.TubeGeometry(curve, tubeSeg, radius, TUBE_RAD_SEG, false)
    const vcount = geo.attributes.position.count
    const colBuf = new Float32Array(vcount * 3)
    for (let i = 0; i < vcount; i++) {
      const t = Math.floor(i / ring) / tubeSeg
      const s = t * t * t   // cubic: invisible at tail, full brightness at head
      colBuf[i * 3]     = col.r * s
      colBuf[i * 3 + 1] = col.g * s
      colBuf[i * 3 + 2] = col.b * s
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colBuf, 3))
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }))
  }

  group.add(makeMesh(TUBE_R * w,       0.95))   // core  – bright, tight line
  group.add(makeMesh(TUBE_R * w * 3.5, 0.22))   // bloom – wide, soft halo
  return group
}

// ─── aircraft glyph texture (one per GlyphKind, reused across aircraft) ───────

function makeGlyphTex(kind: GlyphKind): THREE.Texture {
  const sz  = 512
  const c   = document.createElement('canvas')
  c.width   = c.height = sz
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, sz, sz)
  ctx.save()
  ctx.translate(sz / 2, sz / 2)
  // Fill ~80% of canvas so silhouette is sharp at sprite scale.
  // White so SpriteMaterial.color can tint per-aircraft altitude.
  drawAircraftGlyph(ctx, kind, sz * 0.40, [255, 255, 255], 1.0, 0, 0)
  ctx.restore()
  return new THREE.CanvasTexture(c)
}

// ─── procedural 3D aircraft model ────────────────────────────────────────────

function buildAircraftMesh(kind: GlyphKind): { group: THREE.Group; mat: THREE.MeshPhongMaterial } {
  const mat = new THREE.MeshPhongMaterial({
    color: 0xffffff, emissive: 0x1a2a3a, shininess: 90, flatShading: false,
  })
  const s = GLYPH_SCALE[kind]
  const g = new THREE.Group()

  const add = (geo: THREE.BufferGeometry) => {
    const mesh = new THREE.Mesh(geo, mat)
    g.add(mesh)
    return mesh
  }

  // Flat swept wing panel: root edge (x0, z0a→z0b) → tip edge (x1, z1a→z1b).
  // Aircraft nose points toward -Z. x0 < x1 for right wing, x0 > x1 for left wing.
  const wingPanel = (
    x0: number, z0a: number, z0b: number,
    x1: number, z1a: number, z1b: number,
    th = 0.013 * s,
  ) => {
    const h = th / 2
    const v = new Float32Array([
      x0, h, z0a,  x0, h, z0b,  x1, h, z1a,  x1, h, z1b,  // top  0–3
      x0,-h, z0a,  x0,-h, z0b,  x1,-h, z1a,  x1,-h, z1b,  // bot  4–7
    ])
    const i = new Uint16Array([
      0,2,1, 1,2,3,  4,5,6, 5,7,6,   // top / bottom
      0,4,2, 2,4,6,  1,3,5, 3,7,5,   // leading / trailing edge
      0,1,4, 1,5,4,  2,3,6, 3,7,6,   // root / tip
    ])
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(v, 3))
    geo.setIndex(new THREE.BufferAttribute(i, 1))
    geo.computeVertexNormals()
    add(geo)
  }

  // ── helicopter ──────────────────────────────────────────────────────────────
  if (kind === 'helicopter') {
    add(new THREE.SphereGeometry(0.22 * s, 8, 6))                  // cabin
    const boom = add(new THREE.CylinderGeometry(0.03*s, 0.015*s, 0.85*s, 6))
    boom.rotation.x = Math.PI / 2; boom.position.z = 0.52 * s
    const rotor = add(new THREE.CylinderGeometry(1.05*s, 1.05*s, 0.012*s, 14))
    rotor.position.y = 0.26 * s
    const tRotor = add(new THREE.CylinderGeometry(0.2*s, 0.2*s, 0.01*s, 8))
    tRotor.rotation.z = Math.PI / 2; tRotor.position.set(0.01*s, 0, 0.88*s)
    return { group: g, mat }
  }

  // ── fuselage + nose ─────────────────────────────────────────────────────────
  const FL  = (kind === 'glider' ? 1.28 : 1.08) * s   // fuselage length
  const FR  = (kind === 'glider' ? 0.028 : 0.056) * s // fuselage radius
  const NL  = 0.26 * s                                  // nose length
  const fuse = add(new THREE.CylinderGeometry(FR, FR * 1.12, FL, 8))
  fuse.rotation.x = Math.PI / 2
  const noseMesh = add(new THREE.ConeGeometry(FR, NL, 8))
  noseMesh.rotation.x = -Math.PI / 2
  noseMesh.position.z = -(FL / 2 + NL / 2)

  // ── glider ──────────────────────────────────────────────────────────────────
  if (kind === 'glider') {
    const sp = 1.8 * s
    // Near-straight high-aspect wings, very slight sweep
    wingPanel(-0.03*s, -0.09*s, 0.10*s,  -sp, -0.07*s, 0.08*s,  0.009*s)
    wingPanel( 0.03*s, -0.09*s, 0.10*s,   sp, -0.07*s, 0.08*s,  0.009*s)
    // T-tail horizontal stab
    wingPanel(-0.22*s, 0.52*s, 0.61*s,  -0.03*s, 0.51*s, 0.59*s,  0.008*s)
    wingPanel( 0.03*s, 0.51*s, 0.59*s,   0.22*s, 0.52*s, 0.61*s,  0.008*s)
    // Vertical fin (thin box)
    const vf = add(new THREE.BoxGeometry(0.01*s, 0.15*s, 0.11*s))
    vf.position.set(0, 0.075*s, 0.54*s)
    return { group: g, mat }
  }

  // ── jet airliners (airliner / widebody / quadjet / turboprop / light) ───────
  const halfSpan = (kind === 'widebody' ? 1.05 : kind === 'quadjet' ? 1.18 : 0.88) * s
  // Wing root: LE at z=-0.14, TE at z=+0.24 → chord 0.38
  // Wing tip: LE at z=+0.13 (swept 0.27 behind root LE), TE at z=+0.32 → tip chord 0.19
  const rLE = -0.14 * s, rTE = 0.24 * s   // root leading / trailing edge
  const tLE =  0.13 * s, tTE = 0.32 * s   // tip  leading / trailing edge
  wingPanel(-0.08*s, rLE, rTE,  -halfSpan, tLE, tTE)   // left wing
  wingPanel( 0.08*s, rLE, rTE,   halfSpan, tLE, tTE)   // right wing

  // Horizontal stabiliser (smaller, also swept)
  const hs = (kind === 'widebody' ? 0.40 : 0.31) * s
  wingPanel(-0.04*s, 0.50*s, 0.60*s,  -hs, 0.55*s, 0.63*s,  0.010*s)
  wingPanel( 0.04*s, 0.50*s, 0.60*s,   hs, 0.55*s, 0.63*s,  0.010*s)

  // Vertical tail fin
  const vfin = add(new THREE.BoxGeometry(0.011*s, 0.21*s, 0.13*s))
  vfin.position.set(0, 0.105*s, 0.52*s)

  // Engine nacelles under wings, positioned along the wing at correct sweep angle
  const engFrac = kind === 'quadjet'
    ? [0.40, 0.64, -0.40, -0.64]
    : [0.52, -0.52]                  // fraction of half-span
  for (const frac of engFrac) {
    const ex   = frac * halfSpan
    const absF = Math.abs(frac)
    // Z position follows the wing leading edge sweep: rLE + (tLE - rLE) * absF
    const ez   = rLE + (tLE - rLE) * absF + 0.10 * s
    const eng  = add(new THREE.CylinderGeometry(0.04*s, 0.046*s, 0.28*s, 6))
    eng.rotation.x = Math.PI / 2
    eng.position.set(ex, -0.07*s, ez)
  }

  return { group: g, mat }
}

// ─── GLTF model source ────────────────────────────────────────────────────────

const MODEL_BASE = 'https://yellow-digital.github.io/airplanes/models/'
const KIND_MODEL: Record<GlyphKind, string> = {
  airliner:   'A320.glb',
  widebody:   'A333.glb',
  quadjet:    'A380.glb',
  turboprop:  'AT75.glb',
  light:      'C182.glb',
  glider:     'paraglider.glb',
  helicopter: 'B407.glb',
}

// ─── per-aircraft scene objects ───────────────────────────────────────────────

interface AcObj {
  plane:    THREE.Group
  planeMat: THREE.MeshPhongMaterial
  kind:     GlyphKind
  glow:     THREE.Sprite
  label:    CSS2DObject
  tube:     THREE.Object3D | null   // THREE.Group with core + bloom meshes
  hist:     THREE.Vector3[]
  trackDeg: number
  colorIdx: number   // stable neon palette index derived from ICAO hex
}

// ─── renderer ─────────────────────────────────────────────────────────────────

export class Renderer3D {
  private scene   = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private webgl:  THREE.WebGLRenderer
  private css2d:  CSS2DRenderer
  private ctrl:   OrbitControls
  private glowTex:       THREE.Texture
  private planeTexByKind = new Map<GlyphKind, THREE.Texture>()
  private acObjs      = new Map<string, AcObj>()
  private acData      = new Map<string, Aircraft>()
  private detailEl:   HTMLDivElement
  private earthGeo!:  THREE.BufferGeometry
  private earthMat!:  THREE.MeshBasicMaterial
  private modelTemplates = new Map<GlyphKind, THREE.Group>()
  private runwayObjs: THREE.Object3D[] = []
  private altRingObjs: THREE.Object3D[] = []
  private lastRwyKey  = ''
  private raf         = 0
  private nextFrameDue = 0
  private lastInteractionTime = 0
  private w = 0
  private h = 0
  private pinnedHex: string | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    private container: HTMLElement,
    private getConfig: () => Config,
  ) {
    this.webgl = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.webgl.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.webgl.setClearColor(0x010308)  // deep-space navy — sky base colour

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 500)
    this.camera.position.set(0, 30, 20)
    this.camera.lookAt(0, 5, 0)

    this.ctrl = new OrbitControls(this.camera, canvas)
    this.ctrl.target.set(0, 5, 0)
    this.ctrl.enableDamping  = true
    this.ctrl.dampingFactor  = 0.07
    this.ctrl.minDistance    = 3
    this.ctrl.maxDistance    = 150
    this.ctrl.maxPolarAngle  = Math.PI / 2.04
    this.ctrl.update()
    this.lastInteractionTime = Date.now()
    this.ctrl.addEventListener('start', () => {
      this.ctrl.autoRotate     = false
      this.lastInteractionTime = Date.now()
    })
    this.ctrl.addEventListener('end', () => {
      this.lastInteractionTime = Date.now()
    })

    this.css2d = new CSS2DRenderer()
    this.css2d.domElement.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden'
    this.container.appendChild(this.css2d.domElement)

    this.glowTex = this.makeGlowTex()
    for (const k of ['light','glider','turboprop','airliner','widebody','quadjet','helicopter'] as GlyphKind[]) {
      this.planeTexByKind.set(k, makeGlyphTex(k))
    }

    // Detail panel — bottom-left overlay, shown when an aircraft is pinned
    this.detailEl = document.createElement('div')
    this.detailEl.style.cssText = [
      'position:absolute', 'bottom:36px', 'left:44px',
      'pointer-events:none',
      'color:rgba(245,247,255,0.95)',
      'text-shadow:0 0 18px rgba(0,0,0,1),0 0 6px rgba(0,0,0,1)',
      'display:none',
    ].join(';')
    this.container.appendChild(this.detailEl)

    this.buildScene()
    this.resize()
  }

  // ── glow sprite texture ──────────────────────────────────────────────────────

  private makeGlowTex(): THREE.Texture {
    const sz = 128
    const c   = document.createElement('canvas')
    c.width   = c.height = sz
    const ctx = c.getContext('2d')!
    const g = ctx.createRadialGradient(sz/2, sz/2, 0, sz/2, sz/2, sz/2)
    g.addColorStop(0,    'rgba(255,255,255,1)')
    g.addColorStop(0.15, 'rgba(255,255,255,0.95)')
    g.addColorStop(0.45, 'rgba(255,255,255,0.35)')
    g.addColorStop(0.8,  'rgba(255,255,255,0.06)')
    g.addColorStop(1,    'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, sz, sz)
    return new THREE.CanvasTexture(c)
  }

  // ── static scene geometry ────────────────────────────────────────────────────

  private buildScene(): void {
    const R       = 50
    const R_EARTH = 3958.8  // miles (same unit as scene)

    // ── Starfield (full sphere) ────────────────────────────────────────────────
    this.buildStarfield()

    // ── Lighting for 3-D aircraft models ──────────────────────────────────────
    this.scene.add(new THREE.AmbientLight(0x445566, 0.7))
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.1)
    sun.position.set(10, 40, -15)   // sun slightly ahead and above
    this.scene.add(sun)

    // ── Curved Earth surface ──────────────────────────────────────────────────
    // Each ring vertex is lowered by the spherical-Earth curvature drop.
    // At 50 mi edge the drop ≈ 0.316 mi → 1.26 scene units (4× exaggeration).
    this.earthGeo = this.buildEarthGeo(R, R_EARTH)
    this.earthMat = new THREE.MeshBasicMaterial({ color: 0x020810, side: THREE.DoubleSide })
    this.scene.add(new THREE.Mesh(this.earthGeo, this.earthMat))

    // Outer edge ring — follows curvature
    const edgePts: THREE.Vector3[] = []
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2
      const y = this.curveY(R, R_EARTH) + 0.02
      edgePts.push(new THREE.Vector3(Math.sin(a) * R, y, Math.cos(a) * R))
    }
    this.scene.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(edgePts),
      new THREE.LineBasicMaterial({ color: 0x1a3a58, transparent: true, opacity: 0.5 }),
    ))

    // Range rings — each hugs the curved surface
    for (const [mi, op] of [[10, 0.4], [25, 0.22], [45, 0.12]] as const) {
      const y = this.curveY(mi, R_EARTH) + 0.02
      const pts: THREE.Vector3[] = []
      for (let i = 0; i <= 120; i++) {
        const a = (i / 120) * Math.PI * 2
        pts.push(new THREE.Vector3(Math.sin(a) * mi, y, Math.cos(a) * mi))
      }
      this.scene.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x1a3a58, transparent: true, opacity: op }),
      ))
    }

    // Cardinal direction labels — follow curvature
    const D = Math.PI / 180
    for (const [az, dir] of [[0,'N'],[90,'E'],[180,'S'],[270,'W']] as const) {
      const r   = R * 0.91
      const ax  = Math.sin(az * D), az2 = Math.cos(az * D)
      const y   = this.curveY(r, R_EARTH) + 0.1
      const div = document.createElement('div')
      div.textContent = dir
      div.style.cssText = 'font:400 11px "JetBrains Mono",monospace;color:rgba(40,70,110,0.65);letter-spacing:3px;pointer-events:none;user-select:none'
      const lbl = new CSS2DObject(div)
      lbl.position.set(ax * r, y, az2 * r)
      this.scene.add(lbl)
    }

    // Altitude rings at 10/20/30/40k ft — stored so visibility can be toggled from config
    for (const ft of [10000, 20000, 30000, 40000]) {
      const y   = ft * ALT_EX
      const pts: THREE.Vector3[] = []
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2
        pts.push(new THREE.Vector3(Math.sin(a) * R * 0.93, y, Math.cos(a) * R * 0.93))
      }
      const ring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x0d1e30, transparent: true, opacity: 0.15 }),
      )
      ring.visible = false   // hidden by default; toggled live from config
      this.altRingObjs.push(ring)
      this.scene.add(ring)
    }

    // You-are-here glow
    const you = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: new THREE.Color(1, 0.2, 0.1),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }))
    you.position.set(0, 0.15, 0)
    you.scale.setScalar(1.4)
    this.scene.add(you)

    // Map tile ground texture (ESRI satellite, 3×3 tiles at zoom 9)
    this.loadMapTiles(this.getConfig())

    // GLTF aircraft models — load async; procedural mesh shows until each arrives
    this.loadModels()
  }

  // Load GLTF aircraft models from yellow-digital/airplanes CDN.
  // Each model is normalized to unit size and cached as a template.
  // When a model arrives it also upgrades any already-visible aircraft of that kind.
  private loadModels(): void {
    const loader = new GLTFLoader()
    for (const [kind, file] of Object.entries(KIND_MODEL) as [GlyphKind, string][]) {
      loader.load(
        MODEL_BASE + file,
        (gltf) => {
          const scene = gltf.scene
          // Centre and scale to unit size (longest horizontal dimension = 1)
          const box    = new THREE.Box3().setFromObject(scene)
          const size   = box.getSize(new THREE.Vector3())
          const center = box.getCenter(new THREE.Vector3())
          const maxDim = Math.max(size.x, size.z) || 1
          scene.scale.setScalar(1 / maxDim)
          scene.position.sub(center.multiplyScalar(1 / maxDim))

          const template = new THREE.Group()
          template.add(scene)
          this.modelTemplates.set(kind, template)

          // Upgrade any existing aircraft of this kind that were using the procedural fallback
          for (const obj of this.acObjs.values()) {
            if (obj.kind === kind) this.applyModel(obj.plane, template, obj.planeMat)
          }
        },
        undefined,
        () => { /* network/CORS error — procedural mesh stays */ },
      )
    }
  }

  // Replace contents of an aircraft group with a clone of the GLTF template,
  // applying the per-aircraft material so altitude colour still works.
  private applyModel(group: THREE.Group, template: THREE.Group, mat: THREE.MeshPhongMaterial): void {
    // Dispose existing procedural geometry
    group.traverse(child => {
      if (child instanceof THREE.Mesh) child.geometry.dispose()
    })
    group.clear()
    // Deep-clone so each aircraft has independent geometry
    const clone = template.clone(true)
    clone.traverse(child => {
      if (child instanceof THREE.Mesh) child.material = mat
    })
    group.add(clone)
  }

  // Bake a 3×3 ESRI satellite tile mosaic as a UV-mapped texture on the Earth disc.
  private loadMapTiles(cfg: Config): void {
    const Z = 9, P = Math.pow(2, Z)
    const tX     = (lon: number) => Math.floor((lon + 180) / 360 * P)
    const tY     = (lat: number) => {
      const r = lat * Math.PI / 180
      return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * P)
    }
    const tileLon = (tx: number) => tx / P * 360 - 180
    const tileLat = (ty: number) => {
      const n = Math.PI - 2 * Math.PI * ty / P
      return Math.atan(Math.sinh(n)) * 180 / Math.PI
    }

    const cx = tX(cfg.centerLon), cy = tY(cfg.centerLat)
    const N = 3, H = 1

    // Canvas texture shared by all 9 tiles
    const cvs   = document.createElement('canvas')
    cvs.width   = cvs.height = N * 256
    const ctx2d = cvs.getContext('2d')!
    const tex   = new THREE.CanvasTexture(cvs)

    // Geographic bounds of the N×N grid
    const lonTL = tileLon(cx - H), lonBR = tileLon(cx - H + N)
    const latTL = tileLat(cy - H), latBR = tileLat(cy - H + N)  // latTL > latBR (north > south)
    const dLon  = lonBR - lonTL, dLat = latTL - latBR

    // UV for every disc vertex: un-rotate scene xz → geographic east/north → tile UV.
    // v=1 at north (top of canvas), v=0 at south.  u=0 at west, u=1 at east.
    const DEG  = Math.PI / 180
    const cosr = Math.cos(cfg.rotationDeg * DEG)
    const sinr = Math.sin(cfg.rotationDeg * DEG)
    const mx   = cfg.mirrorX ? -1 : 1
    const cosLat = Math.cos(cfg.centerLat * DEG)

    const rings = 64, segs = 128, R = 50
    const uvArr: number[] = []
    for (let ring = 0; ring <= rings; ring++) {
      const dist = (ring / rings) * R
      for (let seg = 0; seg <= segs; seg++) {
        const a   = (seg / segs) * Math.PI * 2
        const vx  = Math.sin(a) * dist
        const vz  = Math.cos(a) * dist
        // Inverse of toScene rotation → geographic east/north in miles
        const east_mi  = (vx * cosr - vz * sinr) * mx
        const north_mi = -(vx * sinr + vz * cosr)
        // Miles → approximate degrees
        const lat = cfg.centerLat + north_mi * MI / 111320
        const lon = cfg.centerLon + east_mi  * MI / (111320 * cosLat)
        uvArr.push(
          (lon - lonTL) / dLon,           // u: 0=west, 1=east
          (lat - latBR) / dLat,           // v: 0=south(canvas bottom), 1=north(canvas top)
        )
      }
    }
    this.earthGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvArr), 2))

    // Switch the disc material to use the tile texture
    this.earthMat.map         = tex
    this.earthMat.color.set(0xffffff)
    this.earthMat.transparent = true
    this.earthMat.opacity     = 0.92
    this.earthMat.needsUpdate = true

    // ESRI World Imagery satellite tiles — note {z}/{y}/{x} ordering (not x/y)
    for (let dy = -H; dy <= H; dy++) {
      for (let dx = -H; dx <= H; dx++) {
        const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${Z}/${cy+dy}/${cx+dx}`
        const img = new Image()
        img.crossOrigin = 'anonymous'
        img.onload  = () => { ctx2d.drawImage(img, (dx+H)*256, (dy+H)*256, 256, 256); tex.needsUpdate = true }
        img.onerror = () => {}
        img.src = url
      }
    }
  }

  // Distribute 2 400 stars uniformly across the full sphere.
  private buildStarfield(): void {
    const positions: number[] = []
    const colors:    number[] = []
    for (let i = 0; i < 2400; i++) {
      // Uniform distribution on full sphere (Marsaglia / inverse-CDF method)
      const phi   = Math.acos(2 * Math.random() - 1)  // 0=north pole … PI=south pole
      const theta = Math.random() * Math.PI * 2
      const r     = 230 + Math.random() * 40
      positions.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      )
      // Mostly blue-white; occasional warm or cool accent
      const b  = 0.35 + Math.random() * 0.65
      const rn = Math.random()
      if      (rn < 0.12) colors.push(b, b * 0.82, b * 0.55)  // warm/orange
      else if (rn < 0.22) colors.push(b * 0.75, b * 0.82, b)  // cool blue
      else                 colors.push(b, b, b)                 // white
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    geo.setAttribute('color',    new THREE.BufferAttribute(new Float32Array(colors),    3))
    this.scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
      size: 1.5, sizeAttenuation: false,
      vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false,
    })))
  }

  // Vertical drop below observer for a point `dist` miles away on a sphere of radius R_e.
  // Returns the scene-space Y offset (negative = below observer plane).
  private curveY(dist: number, R_e: number): number {
    const drop = R_e - Math.sqrt(Math.max(0, R_e * R_e - dist * dist))
    return -drop * 4  // ALT_EX scale: drop(miles)*5280*ALT_EX = drop*4
  }

  // Curved Earth surface as a parametric disc — each ring's vertices are
  // lowered by the spherical-Earth curvature drop at that radial distance.
  private buildEarthGeo(R: number, R_e: number): THREE.BufferGeometry {
    const rings = 64, segs = 128
    const verts: number[] = []
    const inds:  number[] = []
    for (let ring = 0; ring <= rings; ring++) {
      const dist = (ring / rings) * R
      const y    = this.curveY(dist, R_e)
      for (let seg = 0; seg <= segs; seg++) {
        const a = (seg / segs) * Math.PI * 2
        verts.push(Math.sin(a) * dist, y, Math.cos(a) * dist)
      }
    }
    for (let ring = 0; ring < rings; ring++) {
      for (let seg = 0; seg < segs; seg++) {
        const a = ring * (segs + 1) + seg
        const b = a + segs + 1
        inds.push(a, b, a + 1, b, b + 1, a + 1)
      }
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
    geo.setIndex(inds)
    return geo
  }

  // ── resize ───────────────────────────────────────────────────────────────────

  resize(): void {
    this.w = this.canvas.clientWidth
    this.h = this.canvas.clientHeight
    this.webgl.setSize(this.w, this.h, false)
    this.css2d.setSize(this.w, this.h)
    this.camera.aspect = this.w / this.h
    this.camera.updateProjectionMatrix()
  }

  // ── data update ──────────────────────────────────────────────────────────────

  update(aircraft: Aircraft[]): void {
    const cfg  = this.getConfig()
    this.earthMat.opacity = cfg.discOpacity ?? 0.72
    for (const r of this.altRingObjs) r.visible = cfg.showAltRings3d ?? false
    this.updateRunways(cfg)
    const seen = new Set<string>()

    for (const ac of aircraft) {
      if (ac.lat == null || ac.lon == null) continue
      if (cfg.hideOnGround && ac.onGround) continue
      const alt = ac.altBaro ?? ac.altGeom ?? 0
      if (alt < cfg.minAltitudeFt || alt > cfg.maxAltitudeFt) continue

      const m = llToMeters(ac.lat, ac.lon, cfg.centerLat, cfg.centerLon)
      const rangeMi = Math.hypot(m.east, m.north) / MI
      if (rangeMi > cfg.radiusMiles * 1.08) continue

      const pos = toScene(m, alt, cfg)
      const col = cfg.altitudeColor ? altColor(alt) : new THREE.Color(0xe8ecff)
      seen.add(ac.hex)
      this.acData.set(ac.hex, ac)

      // ── create or reuse per-aircraft objects ────────────────────────────────
      let obj = this.acObjs.get(ac.hex)
      if (!obj) {
        const kind = classifyGlyph(ac)
        const { group: plane, mat: planeMat } = buildAircraftMesh(kind)

        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: this.glowTex, transparent: true, depthWrite: false,
          blending: THREE.AdditiveBlending,
        }))

        const div = document.createElement('div')
        div.style.cssText = [
          'font:300 9px "JetBrains Mono",monospace',
          'color:rgba(174,182,198,0.35)',
          'letter-spacing:0.5px',
          'pointer-events:none',
          'text-shadow:0 0 8px rgba(0,0,0,1)',
          'white-space:nowrap',
        ].join(';')
        const label = new CSS2DObject(div)

        // If the GLTF model has already loaded, swap in the real mesh immediately
        const template = this.modelTemplates.get(kind)
        if (template) this.applyModel(plane, template, planeMat)

        // Stable neon palette index — last 3 hex digits give 0-4095, mod palette length
        const colorIdx = parseInt(ac.hex.slice(-3), 16) % NEON_PALETTE.length

        this.scene.add(plane, glow, label)
        obj = { plane, planeMat, kind, glow, label, tube: null, hist: [], trackDeg: 0, colorIdx }
        this.acObjs.set(ac.hex, obj)
      }

      // ── update history ──────────────────────────────────────────────────────
      const last = obj.hist[obj.hist.length - 1]
      if (!last || last.distanceTo(pos) > 0.05) {
        obj.hist.push(pos.clone())
        if (obj.hist.length > MAX_HIST) obj.hist.shift()
      }

      // ── 3-D aircraft model ──────────────────────────────────────────────────
      const isPinned = ac.hex === this.pinnedHex
      const sz = (isPinned ? PLANE_SIZE * 1.5 : PLANE_SIZE) * (cfg.planeSize3d ?? 1)
      obj.plane.position.copy(pos)
      obj.plane.scale.setScalar(sz)
      obj.trackDeg = ac.track ?? 0
      obj.plane.rotation.y = -obj.trackDeg * DEG   // Y-rotate to face heading direction
      obj.planeMat.color.copy(col)
      obj.planeMat.emissive.copy(col).multiplyScalar(0.28)
      obj.planeMat.opacity = isPinned ? 1.0 : 0.92

      // Glow halo
      obj.glow.position.copy(pos)
      obj.glow.scale.setScalar(sz * 1.6)
      ;(obj.glow.material as THREE.SpriteMaterial).color.copy(col)
      ;(obj.glow.material as THREE.SpriteMaterial).opacity = isPinned ? 0.5 : 0.18

      // ── ribbon trail ────────────────────────────────────────────────────────
      if (obj.hist.length >= 2) {
        if (obj.tube) {
          this.scene.remove(obj.tube)
          obj.tube.traverse(child => {
            if (child instanceof THREE.Mesh) { child.geometry.dispose(); (child.material as THREE.Material).dispose() }
          })
        }
        obj.tube = buildTube(obj.hist, obj.colorIdx, cfg.trailWidth ?? 1)
        this.scene.add(obj.tube)
      }

      // ── label ───────────────────────────────────────────────────────────────
      const div = obj.label.element as HTMLDivElement
      const callsign = ac.flight?.trim() || ac.hex.toUpperCase()
      div.textContent  = isPinned ? `${callsign}  ${Math.round(alt / 1000)}k` : callsign
      div.style.color  = isPinned ? 'rgba(255,255,255,0.95)' : 'rgba(174,182,198,0.35)'
      div.style.fontSize = isPinned ? '12px' : '8px'
      obj.label.position.set(pos.x, pos.y + 0.55, pos.z)
    }

    // ── prune aircraft no longer in view ─────────────────────────────────────
    for (const [hex, obj] of this.acObjs) {
      if (seen.has(hex)) continue
      this.scene.remove(obj.plane, obj.glow, obj.label)
      obj.plane.traverse(child => {
        if (child instanceof THREE.Mesh) { child.geometry.dispose(); child.material.dispose() }
      })
      ;(obj.glow.material as THREE.SpriteMaterial).dispose()
      if (obj.tube) {
        this.scene.remove(obj.tube)
        obj.tube.traverse(child => {
          if (child instanceof THREE.Mesh) { child.geometry.dispose(); (child.material as THREE.Material).dispose() }
        })
      }
      this.acObjs.delete(hex)
      this.acData.delete(hex)
    }

    this.updateDetailEl()
  }

  // ── runways ───────────────────────────────────────────────────────────────────

  private updateRunways(cfg: Config): void {
    const key = [
      cfg.airport?.icao ?? '', cfg.showAirport ? '1' : '0',
      cfg.centerLat.toFixed(4), cfg.centerLon.toFixed(4),
      cfg.rotationDeg, cfg.mirrorX ? '1' : '0',
    ].join('|')
    if (key === this.lastRwyKey) return
    this.lastRwyKey = key

    for (const m of this.runwayObjs) this.scene.remove(m)
    this.runwayObjs = []

    if (!cfg.showAirport || !cfg.airport?.runways?.length) return

    // Airport name label at the centroid of all runways
    let sumX = 0, sumZ = 0, rwyCount = 0
    for (const r of cfg.airport.runways) {
      const leM = llToMeters(r.le[0], r.le[1], cfg.centerLat, cfg.centerLon)
      const heM = llToMeters(r.he[0], r.he[1], cfg.centerLat, cfg.centerLon)
      const leP = toScene(leM, 0, cfg)
      const heP = toScene(heM, 0, cfg)
      sumX += (leP.x + heP.x) / 2
      sumZ += (leP.z + heP.z) / 2
      rwyCount++
    }
    if (rwyCount) {
      const nameDiv = document.createElement('div')
      nameDiv.textContent = cfg.airport.name
      nameDiv.style.cssText = 'font:300 13px "JetBrains Mono",monospace;color:rgba(150,180,220,0.55);letter-spacing:4px;pointer-events:none;user-select:none'
      const nameLbl = new CSS2DObject(nameDiv)
      nameLbl.position.set(sumX / rwyCount, 0.1, sumZ / rwyCount)
      this.scene.add(nameLbl)
      this.runwayObjs.push(nameLbl)
    }

    for (const r of cfg.airport.runways) {
      const leM = llToMeters(r.le[0], r.le[1], cfg.centerLat, cfg.centerLon)
      const heM = llToMeters(r.he[0], r.he[1], cfg.centerLat, cfg.centerLon)
      const lePos = toScene(leM, 0, cfg); lePos.y = 0.004
      const hePos = toScene(heM, 0, cfg); hePos.y = 0.004

      const dir  = new THREE.Vector3().subVectors(hePos, lePos)
      const len  = dir.length()
      dir.normalize()
      const perp = new THREE.Vector3(-dir.z, 0, dir.x)  // horizontal perpendicular
      const up   = new THREE.Vector3(0, 1, 0)
      const mid  = lePos.clone().add(hePos).multiplyScalar(0.5)
      // Exaggerate width to at least 0.15 mi so the runway is visible at scene scale
      const wMi  = Math.max((r.widthFt ?? 150) * 0.3048 / MI, 0.15)

      // Runway fill — flat rectangle oriented along runway
      const geo  = new THREE.PlaneGeometry(wMi, len)
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: 0x3d7ab5, transparent: true, opacity: 0.45, side: THREE.DoubleSide,
        }),
      )
      mesh.position.copy(mid)
      // Orient: local X → perp, local Y → dir, local Z → up (face upward)
      mesh.quaternion.setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(perp, dir, up),
      )
      this.scene.add(mesh)
      this.runwayObjs.push(mesh)

      // Centreline glow
      const cl = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          lePos.clone().setY(0.008),
          hePos.clone().setY(0.008),
        ]),
        new THREE.LineBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.85 }),
      )
      this.scene.add(cl)
      this.runwayObjs.push(cl)

      // Edge lines
      for (const sign of [-1, 1] as const) {
        const edgeLE = lePos.clone().addScaledVector(perp, sign * wMi / 2).setY(0.007)
        const edgeHE = hePos.clone().addScaledVector(perp, sign * wMi / 2).setY(0.007)
        const edge = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([edgeLE, edgeHE]),
          new THREE.LineBasicMaterial({ color: 0x5599cc, transparent: true, opacity: 0.7 }),
        )
        this.scene.add(edge)
        this.runwayObjs.push(edge)
      }
    }
  }

  // ── detail panel ─────────────────────────────────────────────────────────────

  private updateDetailEl(): void {
    if (!this.pinnedHex) { this.detailEl.style.display = 'none'; return }
    const ac = this.acData.get(this.pinnedHex)
    if (!ac) { this.detailEl.style.display = 'none'; return }

    const alt   = ac.altBaro ?? ac.altGeom
    const trend = ac.baroRate != null
      ? ac.baroRate > 150 ? ' ↑' : ac.baroRate < -150 ? ' ↓' : ' →'
      : ''

    // Line 1: type  altitude  speed
    const type   = ac.typeName ?? ac.typeCode
    const altStr = ac.onGround ? 'on ground' : alt != null ? `${alt.toLocaleString('en-US')} ft` : null
    const spdStr = ac.gs != null ? `${Math.round(ac.gs)} kt` : null
    const line1  = [type, altStr, spdStr].filter(Boolean).join('  ')

    // Line 2 (optional): airline
    const airline = ac.airline ?? null

    // Line 3: BLR → HYD  Hyderabad  (short codes + dest city)
    let routeLine: string | null = null
    if (ac.origin && ac.destination) {
      const head = `${ac.origin} → ${ac.destination}`
      routeLine = ac.destName ? `${head}  ${ac.destName}` : head
    }

    // Line 4: 08:44 local · 265 mi to go
    let timeLine: string | null = null
    if (ac.destLat != null && ac.destLon != null) {
      const bits: string[] = [`${localTimeAt(ac.destLat, ac.destLon)} local`]
      if (ac.lat != null && ac.lon != null) {
        const mi = Math.round(gcMiles(ac.lat, ac.lon, ac.destLat, ac.destLon))
        if (mi > 1) bits.push(`${mi.toLocaleString('en-US')} mi to go`)
      }
      timeLine = bits.join('  ·  ')
    }

    const obj = this.acObjs.get(this.pinnedHex)
    const rangeMi = obj
      ? Math.sqrt(obj.plane.position.x ** 2 + obj.plane.position.z ** 2)
      : null

    const e = (s: string) =>
      s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    const row = (text: string, color: string, size = 14) =>
      `<div style="font:400 ${size}px 'JetBrains Mono',monospace;color:${color};margin-bottom:2px">${e(text)}</div>`

    this.detailEl.innerHTML = [
      `<div style="font:300 32px 'JetBrains Mono',monospace;letter-spacing:2px;margin-bottom:5px">${e(ac.flight?.trim() ?? ac.hex.toUpperCase())}${trend}</div>`,
      line1     ? row(line1,    'rgba(255,255,255,0.92)')         : '',
      airline   ? row(airline,  'rgba(255,255,255,0.7)')          : '',
      routeLine ? row(routeLine,'rgba(180,200,255,0.85)')         : '',
      timeLine  ? row(timeLine, 'rgba(174,182,198,0.8)')          : '',
      rangeMi != null
        ? row(`${rangeMi.toFixed(1)} mi from you`, 'rgba(120,220,160,0.85)', 13)
        : '',
      ac.registration
        ? row(ac.registration, 'rgba(120,160,220,0.65)', 13)
        : '',
    ].join('')
    this.detailEl.style.display = 'block'
  }

  // ── interaction ──────────────────────────────────────────────────────────────

  togglePin(x: number, y: number): void {
    const ndcX = (x / this.w) * 2 - 1
    const ndcY = -(y / this.h) * 2 + 1
    let best: string | null = null, bestD = 0.08
    for (const [hex, obj] of this.acObjs) {
      const p = obj.plane.position.clone().project(this.camera)
      const d = Math.hypot(p.x - ndcX, p.y - ndcY)
      if (d < bestD) { bestD = d; best = hex }
    }
    this.pinnedHex = best === this.pinnedHex ? null : best
    this.updateDetailEl()
  }

  setHover(_x: number, _y: number): void { /* OrbitControls handles mouse */ }
  setSourceOk(_ok: boolean): void { }

  // ── render loop ──────────────────────────────────────────────────────────────

  start(): void {
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop)

      // Honour maxFps cap (same logic as 2D renderer)
      const fps = this.getConfig().maxFps
      if (fps > 0) {
        const interval = 1000 / fps
        if (this.nextFrameDue === 0) this.nextFrameDue = now
        if (now < this.nextFrameDue) return
        this.nextFrameDue += interval
        if (now - this.nextFrameDue > interval) this.nextFrameDue = now + interval
      } else {
        this.nextFrameDue = 0
      }

      if (this.canvas.clientWidth !== this.w || this.canvas.clientHeight !== this.h) this.resize()

      // Auto-rotate after 10 s of no user interaction
      const cfg3d = this.getConfig()
      if (cfg3d.autoRotateIdle ?? true) {
        const idle = Date.now() - this.lastInteractionTime
        if (idle > 10000 && !this.ctrl.autoRotate) this.ctrl.autoRotate = true
        this.ctrl.autoRotateSpeed = cfg3d.autoRotateSpeed ?? 0.5
      } else {
        if (this.ctrl.autoRotate) this.ctrl.autoRotate = false
      }

      this.ctrl.update()

      this.webgl.render(this.scene, this.camera)
      this.css2d.render(this.scene, this.camera)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
    this.ctrl.dispose()
    this.css2d.domElement.remove()
    this.detailEl.remove()
    this.webgl.dispose()
    this.glowTex.dispose()
    for (const tex of this.planeTexByKind.values()) tex.dispose()
    for (const m of this.runwayObjs) this.scene.remove(m)
    this.runwayObjs = []
    for (const obj of this.acObjs.values()) {
      if (obj.tube) {
        obj.tube.traverse(child => {
          if (child instanceof THREE.Mesh) { child.geometry.dispose(); (child.material as THREE.Material).dispose() }
        })
      }
      obj.plane.traverse(child => {
        if (child instanceof THREE.Mesh) { child.geometry.dispose(); child.material.dispose() }
      })
      ;(obj.glow.material as THREE.SpriteMaterial).dispose()
    }
    this.acObjs.clear()
    this.acData.clear()
  }
}
