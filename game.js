(() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  const keys = new Set();
  const TRACK = 5793, LAPS = 3, SEG = 45, VIEW = 2700, GRID = 88, RACE_END = GRID + LAPS * TRACK;
  const RATIOS = [0, 3.42, 2.62, 2.08, 1.72, 1.46, 1.26, 1.11, 1.00];
  const RPM_K = 132, MASS = 798, REDLINE = 13400, IDLE = 4000;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const lerp = (a, b, t) => a + (b - a) * t;
  const modulo = (n, m) => ((n % m) + m) % m;
  const pad = (n) => String(n).padStart(2, '0');
  const sgn = (n) => (n < 0 ? -1 : 1);
  const fmtTime = (n) => {
    const m = Math.floor(n / 60), s = Math.floor(n % 60), ms = Math.floor((n % 1) * 1000);
    return `${pad(m)}:${pad(s)}.${String(ms).padStart(3, '0')}`;
  };

  let W = 0, H = 0, DPR = 1, last = 0;
  let phase = 'menu', paused = false, raceTime = 0;
  let lightStart = 0, lightsOutAt = 0;
  let car, opponents = [], audio = null, soundOn = false;
  let messageTimeout = 0, shake = 0;
  let trees = [], clouds = [], spectators = [], rpmBars = [];
  let CAR_SCALE = 1.5;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 1.7);
    W = window.innerWidth;
    H = window.innerHeight;
    CAR_SCALE = clamp(1.85 * Math.sqrt(W / 1280), .82, 1.85);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function setup() {
    car = {
      speed: 0, gear: 1, rpm: 4200, lateral: 0, latVel: 0, steer: 0,
      progress: modulo(-GRID, TRACK), distance: 0, lap: 1, grip: 1, wear: 0, tyreTemp: 86,
      ers: 1, shiftCut: 0, shiftFlash: 0, offTrack: false, throttle: 0,
      brake: 0, slip: 0, lapStart: 0, lapTimes: [], best: 0, topSpeed: 0,
      limiter: false, wallCool: 0, finalPlace: 8, nextLine: GRID, raceStarted: false
    };
    const pace = [76.8, 76.5, 76.2, 75.9, 75.6, 75.3, 75.0];
    const startGap = [80, 80, 60, 60, 40, 40, 20];
    const startLat = [.34, -.34, .34, -.34, .34, -.34, .34];
    const colors = ['#ff4d41', '#54c8ff', '#f4bd46', '#b25fff', '#45e1a3', '#ff7daa', '#e6e9ef'];
    const names = ['NOVA', 'KAI', 'MILO', 'LEO', 'AXEL', 'IVAN', 'THEO'];
    opponents = pace.map((base, i) => ({
      name: names[i], color: colors[i], progress: startGap[i], speed: base,
      base, lateral: startLat[i], phase: i * 1.7, finishTime: null
    }));
    trees = Array.from({ length: 132 }, (_, i) => ({
      d: i * 109 + 18, side: i % 2 ? 1 : -1, kind: i % 4,
      scale: .6 + ((i * 37) % 100) / 100 * .9
    }));
    clouds = Array.from({ length: 10 }, (_, i) => ({
      x: i / 10, y: .10 + ((i * 53) % 100) / 100 * .20, s: .45 + ((i * 29) % 100) / 100 * .85
    }));
    const crowd = ['#efe7d6', '#e0554b', '#f0c14b', '#5ac7dd', '#d8ff3e', '#ffffff', '#9a7bff'];
    spectators = Array.from({ length: 160 }, (_, i) => ({
      x: ((i * 53) % 100) / 100 * .30,
      row: i % 3,
      color: crowd[i % crowd.length]
    }));
    buildRPM();
  }

  function buildRPM() {
    $('rpmBars').innerHTML = Array.from({ length: 18 }, () => '<i></i>').join('');
    rpmBars = Array.from($('rpmBars').children);
  }

  /* ---------------------------------- track --------------------------------- */

  function bendAt(distance) {
    const p = modulo(distance, TRACK) / TRACK;
    const g = (c, w, a) => a * Math.exp(-Math.pow((p - c) / w, 2));
    return .00018 * Math.sin(p * Math.PI * 2 * 3.1 + .6)
      + .00014 * Math.sin(p * Math.PI * 2 * 7.3 - .4)
      + g(.10, .022, .00115)
      + g(.34, .016, -.00105)
      + g(.40, .016, -.00105)
      + g(.50, .018, .00095)
      + g(.545, .018, -.00105)
      + g(.69, .028, .00135)
      + g(.965, .020, -.00035);
  }

  function getCorner(p) {
    if (p < .012 || p > .975) return 'START / FINISH';
    const names = [
      [.025, 'CURVA GRANDE'], [.115, 'VARIANTE DEL RETTIFILO'], [.20, 'CURVA GRANDE'],
      [.34, 'LESMO 1'], [.40, 'LESMO 2'], [.52, 'ASCARI'], [.69, 'PARABOLICA'],
      [.87, 'START / FINISH']
    ];
    let best = names[0], diff = 1;
    for (const n of names) {
      const d = Math.abs(p - n[0]);
      if (d < diff) { diff = d; best = n; }
    }
    return diff < .045 ? best[1] : 'MONZA · CIRCUIT';
  }

  function projection(d) {
    const depth = 62 / (Math.max(0, d) + 62);
    return {
      y: H * .39 + (H * .94 - H * .39) * depth,
      t: depth,
      width: (W * .44) * depth
    };
  }

  function roadPoints() {
    const count = Math.ceil(VIEW / SEG);
    const points = [{ d: 0, dx: 0 }];
    let dx = 0;
    for (let i = 1; i <= count; i++) {
      const d = i * SEG;
      dx += bendAt(car.progress + d) * SEG * d * 6;
      points.push({ d, dx });
    }
    return points;
  }

  /* --------------------------------- render -------------------------------- */

  function drawGrandstand(x, y, w, h) {
    ctx.fillStyle = '#a8a79a';
    ctx.fillRect(x, y - h, w, h);
    ctx.fillStyle = '#898b80';
    ctx.fillRect(x, y - h, w, 4);
    ctx.fillStyle = '#7d2428';
    ctx.fillRect(x, y - h - 6, w, 7);
    ctx.fillStyle = 'rgba(255,255,255,.24)';
    ctx.fillRect(x, y - h + 4, w, 1.5);
    for (const s of spectators) {
      const px = x + 5 + (s.x / .30) * (w - 10);
      const py = y - h + 8 + s.row * 7;
      ctx.fillStyle = s.color;
      ctx.fillRect(px, py, 3, 3);
    }
  }

  function sky() {
    const hz = H * .39;
    const g = ctx.createLinearGradient(0, -20, 0, hz + 30);
    g.addColorStop(0, '#3f7b98');
    g.addColorStop(.5, '#96b9bd');
    g.addColorStop(.84, '#d7d0b6');
    g.addColorStop(1, '#e7d7b8');
    ctx.fillStyle = g;
    ctx.fillRect(-20, -20, W + 40, hz + 50);

    const sx = W * .79, sy = H * .16;
    const sun = ctx.createRadialGradient(sx, sy, 2, sx, sy, H * .32);
    sun.addColorStop(0, 'rgba(255,250,220,.95)');
    sun.addColorStop(.12, 'rgba(255,243,194,.6)');
    sun.addColorStop(.55, 'rgba(255,236,180,.12)');
    sun.addColorStop(1, 'rgba(255,236,180,0)');
    ctx.fillStyle = sun;
    ctx.fillRect(W * .42, -20, W * .58, H * .58);
    ctx.fillStyle = 'rgba(255,253,235,.82)';
    ctx.beginPath(); ctx.arc(sx, sy, H * .027, 0, Math.PI * 2); ctx.fill();

    for (const c of clouds) {
      const x = modulo(c.x * (W + 240) + raceTime * (1.6 + c.s), W + 240) - 120;
      const y = c.y * H;
      ctx.fillStyle = 'rgba(250,250,242,.16)';
      ctx.beginPath();
      ctx.ellipse(x, y, 68 * c.s, 12 * c.s, -.04, 0, Math.PI * 2);
      ctx.ellipse(x + 30 * c.s, y - 4 * c.s, 38 * c.s, 14 * c.s, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#8ba49b';
    ctx.beginPath();
    ctx.moveTo(-30, hz + 16);
    for (let x = -30; x <= W + 30; x += 26) {
      ctx.lineTo(x, hz - 4 - Math.sin(x * .004 + 12) * 14 - Math.sin(x * .011) * 7);
    }
    ctx.lineTo(W + 30, hz + 22);
    ctx.closePath(); ctx.fill();

    ctx.fillStyle = '#48664a';
    for (let x = -30; x < W + 30; x += 31) {
      const y = hz + 8 + Math.sin(x * .055) * 4;
      const h = 30 + Math.abs(Math.sin(x * .13)) * 34;
      ctx.beginPath();
      ctx.moveTo(x - 15, y + 20);
      ctx.lineTo(x, y - h);
      ctx.lineTo(x + 16, y + 20);
      ctx.fill();
    }

    ctx.fillStyle = '#2f4636';
    for (let x = -20; x < W + 20; x += 17) {
      const y = hz + 7 + Math.sin(x * .09) * 3;
      const h = 20 + Math.abs(Math.sin(x * .27)) * 30;
      ctx.beginPath();
      ctx.moveTo(x - 11, y + 20);
      ctx.lineTo(x, y - h);
      ctx.lineTo(x + 12, y + 20);
      ctx.fill();
      if (Math.abs(Math.sin(x * .043)) > .93) {
        ctx.fillRect(x - 2, y - h - 34, 4, 60);
      }
    }

    ctx.fillStyle = '#5f7d4b';
    ctx.fillRect(-20, hz + 18, W + 40, H - hz);

    drawGrandstand(W * .025, hz + 8, W * .215, 34);
  }

  function drawHaze() {
    const hz = H * .39;
    const g = ctx.createLinearGradient(0, hz - 4, 0, hz + H * .18);
    g.addColorStop(0, 'rgba(226,220,200,.42)');
    g.addColorStop(1, 'rgba(226,220,200,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, hz - 4, W, H * .18);
  }

  function drawRoad(points) {
    for (let i = points.length - 2; i >= 0; i--) {
      const a = points[i], b = points[i + 1];
      const pa = projection(a.d), pb = projection(b.d);
      const cxA = W / 2 + a.dx * pa.t, cxB = W / 2 + b.dx * pb.t;
      const wA = pa.width, wB = pb.width;
      const stripe = Math.floor((car.progress + a.d) / (SEG * 2)) % 2;
      const bend = bendAt(car.progress + a.d);
      const outer = bend > 0 ? -1 : 1;

      ctx.fillStyle = stripe ? '#6c8a53' : '#77955b';
      ctx.fillRect(-20, pb.y, W + 40, pa.y - pb.y + 1.2);

      if (Math.abs(bend) > .00042 && pa.t > .05) {
        ctx.fillStyle = stripe ? '#c7b184' : '#cfbb92';
        ctx.beginPath();
        ctx.moveTo(cxB + outer * wB * 1.045, pb.y);
        ctx.lineTo(cxB + outer * wB * 1.38, pb.y);
        ctx.lineTo(cxA + outer * wA * 1.38, pa.y);
        ctx.lineTo(cxA + outer * wA * 1.045, pa.y);
        ctx.closePath(); ctx.fill();
      }

      ctx.fillStyle = stripe ? '#e8e5d9' : '#d23c33';
      ctx.beginPath();
      ctx.moveTo(cxB - wB * 1.14, pb.y);
      ctx.lineTo(cxB - wB, pb.y);
      ctx.lineTo(cxA - wA, pa.y);
      ctx.lineTo(cxA - wA * 1.14, pa.y);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cxB + wB, pb.y);
      ctx.lineTo(cxB + wB * 1.14, pb.y);
      ctx.lineTo(cxA + wA * 1.14, pa.y);
      ctx.lineTo(cxA + wA, pa.y);
      ctx.closePath(); ctx.fill();

      ctx.fillStyle = stripe ? '#f3f0e4' : '#d42f2c';
      ctx.beginPath();
      ctx.moveTo(cxB - wB, pb.y);
      ctx.lineTo(cxB - wB * .955, pb.y);
      ctx.lineTo(cxA - wA * .955, pa.y);
      ctx.lineTo(cxA - wA, pa.y);
      ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cxB + wB * .955, pb.y);
      ctx.lineTo(cxB + wB, pb.y);
      ctx.lineTo(cxA + wA, pa.y);
      ctx.lineTo(cxA + wA * .955, pa.y);
      ctx.closePath(); ctx.fill();

      ctx.fillStyle = stripe ? '#3f4443' : '#424746';
      ctx.beginPath();
      ctx.moveTo(cxB - wB * .955, pb.y);
      ctx.lineTo(cxB + wB * .955, pb.y);
      ctx.lineTo(cxA + wA * .955, pa.y);
      ctx.lineTo(cxA - wA * .955, pa.y);
      ctx.closePath(); ctx.fill();

      if (i % 10 === 0) {
        ctx.fillStyle = 'rgba(16,20,20,.16)';
        ctx.fillRect(cxA - wA * .955, pa.y, wA * 1.91, Math.max(.7, pa.t * 1.3));
      }

      // tyre-polished racing line
      ctx.strokeStyle = 'rgba(20,24,24,.10)';
      ctx.lineWidth = Math.max(.7, pa.t * 8);
      for (const off of [-.22, .22]) {
        ctx.beginPath();
        ctx.moveTo(cxB + wB * off, pb.y);
        ctx.lineTo(cxA + wA * off, pa.y);
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(225,227,219,.06)';
      ctx.lineWidth = Math.max(.5, pa.t * 1.2);
      ctx.beginPath(); ctx.moveTo(cxB, pb.y); ctx.lineTo(cxA, pa.y); ctx.stroke();

      if (i % 4 === 0 && pa.t > .045) {
        const h = Math.max(2, 24 * pa.t), bw = Math.max(5, 58 * pa.t);
        for (const side of [-1, 1]) {
          const bx = cxA + side * wA * 1.41;
          ctx.fillStyle = '#d8d5c9';
          ctx.fillRect(bx - bw / 2, pa.y - h, bw, h);
          ctx.fillStyle = side < 0 ? '#bd1f2e' : '#1c2f46';
          ctx.fillRect(bx - bw / 2, pa.y - h, bw, h * .26);
          ctx.fillStyle = 'rgba(20,28,32,.82)';
          ctx.font = `bold ${Math.max(3, 7 * pa.t)}px "DM Mono", monospace`;
          ctx.textAlign = 'center';
          ctx.fillText(side < 0 ? 'APEX' : 'MONZA', bx, pa.y - h * .32);
        }
      }

      // continuous trackside barrier
      if (pa.t > .018) {
        ctx.strokeStyle = stripe ? 'rgba(235,233,224,.6)' : 'rgba(188,46,40,.7)';
        ctx.lineWidth = Math.max(.8, 4.5 * pa.t);
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(cxB + side * wB * 1.31, pb.y);
          ctx.lineTo(cxA + side * wA * 1.31, pa.y);
          ctx.stroke();
        }
      }

      // marshal post on the outside of corners
      if (i % 11 === 0 && Math.abs(bend) > .0005 && pa.t > .06) {
        const side = bend > 0 ? 1 : -1;
        const x = cxA + side * wA * 1.56;
        const mh = Math.max(3, 25 * pa.t), mw = Math.max(1.5, 7 * pa.t);
        ctx.fillStyle = '#e7e4d6';
        ctx.fillRect(x - mw / 2, pa.y - mh, mw, mh);
        ctx.fillStyle = '#ff7a1a';
        ctx.fillRect(x - mw / 2, pa.y - mh, mw, mh * .38);
        ctx.fillStyle = '#d8ff3e';
        ctx.fillRect(x + mw / 2, pa.y - mh, mw * .8, Math.max(1, mh * .2));
      }
    }
  }

  function drawTrees(points) {
    for (const tree of trees) {
      let d = modulo(tree.d - car.progress, TRACK);
      if (d > VIEW) continue;
      const p = projection(d);
      const idx = Math.min(points.length - 1, Math.floor(d / SEG));
      const center = W / 2 + points[idx].dx * p.t;
      const x = center + tree.side * (p.width * 1.86 + 40 * p.t);
      const size = Math.max(2, p.t * (66 * tree.scale));
      ctx.fillStyle = '#384133';
      ctx.fillRect(x - size * .09, p.y - size * .32, size * .18, size * .32);
      ctx.fillStyle = tree.kind === 0 ? '#244b36' : tree.kind === 1 ? '#365a3e' : tree.kind === 2 ? '#2c5036' : '#3d6440';
      ctx.beginPath();
      ctx.moveTo(x - size * .52, p.y - size * .23);
      ctx.lineTo(x, p.y - size * 1.4);
      ctx.lineTo(x + size * .52, p.y - size * .23);
      ctx.fill();
      ctx.fillStyle = 'rgba(171,195,121,.15)';
      ctx.beginPath();
      ctx.moveTo(x - size * .22, p.y - size * .46);
      ctx.lineTo(x, p.y - size * 1.32);
      ctx.lineTo(x + size * .06, p.y - size * .44);
      ctx.fill();
    }
  }

  function drawPits(points) {
    const base = GRID - car.distance;
    if (base < -620 || base > 1400) return;
    const step = 16;
    const teamColors = ['#e2333f', '#f0f0e8', '#2d9dd6', '#f4bd46', '#45b57b', '#e6e9ef'];
    for (let rel = 470; rel > -260; rel -= step) {
      const dF = base + rel;
      const dN = dF - step;
      if (dN < 8 || dF > VIEW) continue;
      const pF = projection(dF), pN = projection(dN);
      const iF = Math.min(points.length - 1, Math.floor(dF / SEG));
      const iN = Math.min(points.length - 1, Math.floor(dN / SEG));
      const cF = W / 2 + points[iF].dx * pF.t;
      const cN = W / 2 + points[iN].dx * pN.t;
      const wF = pF.width, wN = pN.width;
      const tF = pF.t, tN = pN.t;
      const bay = Math.floor((rel + 400) / step);

      // pit lane tarmac
      const aF = cF + wF * 1.32, bF = cF + wF * 1.82;
      const aN = cN + wN * 1.32, bN = cN + wN * 1.82;
      ctx.fillStyle = bay % 2 ? '#5a5f5e' : '#565b5a';
      ctx.beginPath();
      ctx.moveTo(aF, pF.y);
      ctx.lineTo(bF, pF.y);
      ctx.lineTo(bN, pN.y);
      ctx.lineTo(aN, pN.y);
      ctx.closePath(); ctx.fill();

      // pit lane markings
      ctx.strokeStyle = 'rgba(238,238,230,.5)';
      ctx.lineWidth = Math.max(.5, 1.6 * tF);
      ctx.beginPath();
      ctx.moveTo(cF + wF * 1.46, pF.y);
      ctx.lineTo(cN + wN * 1.46, pN.y);
      ctx.stroke();

      // pit wall
      const wallH = Math.max(1.5, 13 * tF);
      ctx.fillStyle = '#e8e5d9';
      ctx.beginPath();
      ctx.moveTo(cF + wF * 1.29, pF.y);
      ctx.lineTo(cF + wF * 1.33, pF.y);
      ctx.lineTo(cN + wN * 1.33, pN.y);
      ctx.lineTo(cN + wN * 1.29, pN.y);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#c02f2c';
      ctx.beginPath();
      ctx.moveTo(cF + wF * 1.29, pF.y - wallH);
      ctx.lineTo(cF + wF * 1.33, pF.y - wallH);
      ctx.lineTo(cN + wN * 1.33, pN.y - wallH);
      ctx.lineTo(cN + wN * 1.29, pN.y - wallH);
      ctx.closePath(); ctx.fill();

      // garage block facade
      const f1F = cF + wF * 1.84, f1N = cN + wN * 1.84;
      const f2F = cF + wF * 3.25, f2N = cN + wN * 3.25;
      const hF = 124 * tF, hN = 124 * tN;
      ctx.fillStyle = '#a5a296';
      ctx.beginPath();
      ctx.moveTo(f1F, pF.y - hF);
      ctx.lineTo(f2F, pF.y - hF);
      ctx.lineTo(f2N, pN.y - hN);
      ctx.lineTo(f1N, pN.y - hN);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(34,40,42,.4)';
      ctx.lineWidth = Math.max(.5, 1.4 * tF);
      ctx.beginPath();
      ctx.moveTo(f2F, pF.y - hF);
      ctx.lineTo(f2N, pN.y - hN);
      ctx.stroke();
      ctx.fillStyle = bay % 2 ? '#ccc9bb' : '#d6d3c6';
      ctx.beginPath();
      ctx.moveTo(f1F, pF.y);
      ctx.lineTo(f1N, pN.y);
      ctx.lineTo(f1N, pN.y - hN);
      ctx.lineTo(f1F, pF.y - hF);
      ctx.closePath(); ctx.fill();

      // garage doors
      ctx.fillStyle = bay % 3 === 0 ? '#2a3237' : '#333c42';
      ctx.beginPath();
      ctx.moveTo(f1F, pF.y);
      ctx.lineTo(f1N, pN.y);
      ctx.lineTo(f1N, pN.y - hN * .58);
      ctx.lineTo(f1F, pF.y - hF * .58);
      ctx.closePath(); ctx.fill();

      // glass band + roof lip + team stripe
      ctx.fillStyle = 'rgba(80,110,126,.8)';
      ctx.beginPath();
      ctx.moveTo(f1F, pF.y - hF * .58);
      ctx.lineTo(f1N, pN.y - hN * .58);
      ctx.lineTo(f1N, pN.y - hN * .76);
      ctx.lineTo(f1F, pF.y - hF * .76);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = teamColors[bay % teamColors.length];
      ctx.beginPath();
      ctx.moveTo(f1F, pF.y - hF * .76);
      ctx.lineTo(f1N, pN.y - hN * .76);
      ctx.lineTo(f1N, pN.y - hN * .82);
      ctx.lineTo(f1F, pF.y - hF * .82);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#8e2b2b';
      ctx.beginPath();
      ctx.moveTo(f1F, pF.y - hF * .94);
      ctx.lineTo(f1N, pN.y - hN * .94);
      ctx.lineTo(f1N, pN.y - hN);
      ctx.lineTo(f1F, pF.y - hF);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#e9e6da';
      ctx.beginPath();
      ctx.moveTo(f1F, pF.y - hF * .82);
      ctx.lineTo(f1N, pN.y - hN * .82);
      ctx.lineTo(f1N, pN.y - hN * .86);
      ctx.lineTo(f1F, pF.y - hF * .86);
      ctx.closePath(); ctx.fill();
    }
  }

  function drawStartArea(points) {
    const ahead = modulo(GRID - car.distance, TRACK);
    if (ahead > VIEW) return;
    const idx = Math.min(points.length - 1, Math.floor(ahead / SEG));
    const p = projection(ahead);
    const c = W / 2 + points[idx].dx * p.t;

    // painted starting-grid slots
    const slots = [[80, .34], [80, -.34], [60, .34], [60, -.34], [40, .34], [40, -.34], [20, .34], [4, 0]];
    for (const [g, lat] of slots) {
      const ad = modulo(g - car.distance, TRACK);
      if (ad > VIEW || ad < 10) continue;
      const pp = projection(ad);
      const ii = Math.min(points.length - 1, Math.floor(ad / SEG));
      const cc = W / 2 + points[ii].dx * pp.t + lat * pp.width;
      const bw = pp.width * .24, bh = Math.max(1.5, 26 * pp.t);
      ctx.strokeStyle = 'rgba(246,246,238,.6)';
      ctx.lineWidth = Math.max(.6, 2 * pp.t);
      ctx.beginPath();
      ctx.moveTo(cc - bw, pp.y); ctx.lineTo(cc - bw, pp.y - bh); ctx.lineTo(cc - bw * .55, pp.y - bh);
      ctx.moveTo(cc + bw, pp.y); ctx.lineTo(cc + bw, pp.y - bh); ctx.lineTo(cc + bw * .55, pp.y - bh);
      ctx.stroke();
    }

    if (ahead > 60 && ahead < 1500) {
      const t = p.t;
      const postW = Math.max(2, 9 * t);
      const h = 235 * t;
      const beamW = p.width * 2.6;
      const topY = p.y - h;
      if (topY > -40) {
        ctx.fillStyle = '#2a3034';
        ctx.fillRect(c - beamW / 2 - postW / 2, topY, postW, h);
        ctx.fillRect(c + beamW / 2 - postW / 2, topY, postW, h);
        ctx.fillStyle = '#1b2024';
        ctx.fillRect(c - beamW / 2 - postW, topY, beamW + postW * 2, Math.max(3, 27 * t));
        if (t > .14) {
          ctx.fillStyle = '#e9e6d8';
          ctx.font = `bold ${Math.max(4, 15 * t)}px "Barlow Condensed", sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText('MONZA', c, topY + Math.max(6, 19 * t));
        }
        for (let i = 0; i < 5; i++) {
          const lx = c + (i - 2) * Math.max(4, 12 * t);
          ctx.fillStyle = '#0d1113';
          ctx.beginPath();
          ctx.arc(lx, topY + Math.max(3, 23 * t), Math.max(1.2, 4 * t), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    const w = p.width * .94;
    const rows = 4, cols = 16, cell = (w * 2) / cols, rh = Math.max(2, 8 * p.t);
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        ctx.fillStyle = (r + col) % 2 ? '#f5f4ed' : '#17191b';
        ctx.fillRect(c - w + col * cell, p.y - r * rh, cell + .5, rh + .3);
      }
    }
  }

  function rounded(x, y, w, h, r, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  }

  function drawF1(x, y, s, color, player, braking) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);

    if (player) {
      const g = ctx.createRadialGradient(0, 36, 6, 0, 36, 92);
      g.addColorStop(0, 'rgba(0,0,0,.55)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-100, 20, 200, 86);
    } else {
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      ctx.beginPath(); ctx.ellipse(0, 34, 45, 13, 0, 0, Math.PI * 2); ctx.fill();
    }

    // slick tyres (front pair far, rear pair near)
    for (const [tx, ty, tw, th] of [[-40, -40, 16, 36], [24, -40, 16, 36], [-43, 8, 17, 38], [26, 8, 17, 38]]) {
      rounded(tx, ty, tw, th, 5, '#0e1113');
      ctx.fillStyle = 'rgba(255,255,255,.12)';
      ctx.fillRect(tx + 3, ty + 5, 2, th - 10);
      ctx.fillStyle = player ? '#e02337' : 'rgba(255,255,255,.18)';
      ctx.fillRect(tx, ty + th * .38, tw, 2);
      if (ty > 0) {
        ctx.fillStyle = 'rgba(255,255,255,.14)';
        ctx.fillRect(tx + 1, ty + th * .38 - 2, tw - 2, 1);
      }
    }

    // suspension arms
    ctx.strokeStyle = '#22282c';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-26, -24); ctx.lineTo(-38, -28);
    ctx.moveTo(26, -24); ctx.lineTo(38, -28);
    ctx.moveTo(-24, 14); ctx.lineTo(-35, 16);
    ctx.moveTo(24, 14); ctx.lineTo(35, 16);
    ctx.stroke();

    // floor
    ctx.fillStyle = '#14181b';
    ctx.beginPath();
    ctx.moveTo(-26, -30);
    ctx.lineTo(26, -30);
    ctx.lineTo(33, 12);
    ctx.lineTo(20, 24);
    ctx.lineTo(-20, 24);
    ctx.lineTo(-33, 12);
    ctx.closePath(); ctx.fill();

    // sidepods
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-16, -4); ctx.lineTo(-32, 1); ctx.lineTo(-28, 14); ctx.lineTo(-16, 17);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(16, -4); ctx.lineTo(32, 1); ctx.lineTo(28, 14); ctx.lineTo(16, 17);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(-31, 2, 4, 7);
    ctx.fillRect(27, 2, 4, 7);

    // main body / nose
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(-23, 27);
    ctx.lineTo(-19, 13);
    ctx.lineTo(-14, -16);
    ctx.lineTo(-8, -33);
    ctx.lineTo(0, -40);
    ctx.lineTo(8, -33);
    ctx.lineTo(14, -16);
    ctx.lineTo(19, 13);
    ctx.lineTo(23, 27);
    ctx.closePath(); ctx.fill();

    // body shading + engine cover fin
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.beginPath();
    ctx.moveTo(-5, -34); ctx.lineTo(0, -38); ctx.lineTo(4, -28); ctx.lineTo(0, 10); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.22)';
    ctx.beginPath();
    ctx.moveTo(5, -32); ctx.lineTo(10, -23); ctx.lineTo(8, 22); ctx.lineTo(2, 26); ctx.closePath(); ctx.fill();

    if (player) {
      ctx.fillStyle = '#e9ece4';
      ctx.fillRect(-2, -2, 4, 16);
      ctx.fillStyle = '#11171b';
      ctx.font = 'bold 9px "Barlow Condensed", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('16', 0, 8);
    }

    // cockpit, halo, helmet
    ctx.fillStyle = '#090d10';
    ctx.beginPath(); ctx.ellipse(0, -11, 8, 12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = player ? '#d8ff3e' : '#f3d16b';
    ctx.beginPath(); ctx.ellipse(0, -13, 5, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(15,22,28,.9)';
    ctx.fillRect(-4, -15, 8, 3);
    ctx.strokeStyle = '#c9d0ce';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-11, -18);
    ctx.quadraticCurveTo(-10, -26, 0, -25);
    ctx.quadraticCurveTo(10, -26, 11, -18);
    ctx.stroke();

    // mirrors
    ctx.fillStyle = '#0d1114';
    ctx.fillRect(-15, -20, 4, 3);
    ctx.fillRect(11, -20, 4, 3);

    // rear wing + DRS
    ctx.fillStyle = '#0d1114';
    ctx.fillRect(-37, 16, 5, 20);
    ctx.fillRect(32, 16, 5, 20);
    ctx.fillStyle = color;
    ctx.fillRect(-37, 16, 5, 3);
    ctx.fillRect(32, 16, 5, 3);
    ctx.fillStyle = '#15191d';
    ctx.beginPath();
    ctx.moveTo(-35, 33);
    ctx.lineTo(-31, 21);
    ctx.lineTo(31, 21);
    ctx.lineTo(35, 33);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(-32, 21, 64, 3.4);
    ctx.fillStyle = 'rgba(255,255,255,.12)';
    ctx.fillRect(-32, 23.2, 64, 1.1);
    ctx.fillStyle = player ? '#d8ff3e' : 'rgba(255,255,255,.5)';
    ctx.fillRect(-1.8, 26, 3.6, 6.5);

    // diffuser
    ctx.fillStyle = '#20262a';
    ctx.beginPath();
    ctx.moveTo(-23, 33);
    ctx.lineTo(23, 33);
    ctx.lineTo(18, 42);
    ctx.lineTo(-18, 42);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#0b0f12';
    for (let i = -2; i <= 2; i++) {
      ctx.fillRect(i * 7 - 1, 34, 2, 8);
    }

    // front wing
    ctx.fillStyle = '#14191d';
    ctx.beginPath();
    ctx.moveTo(-44, -32);
    ctx.lineTo(-40, -38);
    ctx.lineTo(-11, -36);
    ctx.lineTo(0, -33);
    ctx.lineTo(11, -36);
    ctx.lineTo(40, -38);
    ctx.lineTo(44, -32);
    ctx.lineTo(37, -28);
    ctx.lineTo(10, -29);
    ctx.lineTo(0, -27);
    ctx.lineTo(-10, -29);
    ctx.lineTo(-37, -28);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = color;
    ctx.fillRect(-40, -37, 10, 3);
    ctx.fillRect(30, -37, 10, 3);

    // brake light
    const lightOn = player ? braking : false;
    ctx.fillStyle = lightOn ? '#ff352c' : 'rgba(255,53,44,.42)';
    ctx.fillRect(-2.6, 36, 5.2, 3.4);
    if (lightOn) {
      ctx.shadowColor = '#ff2d22';
      ctx.shadowBlur = 14;
      ctx.fillRect(-2.6, 36, 5.2, 3.4);
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  function drawRivals(points) {
    for (const rival of opponents) {
      const d = modulo(rival.progress - car.distance, TRACK);
      if (d > VIEW || d < 14) continue;
      const p = projection(d);
      const idx = Math.min(points.length - 1, Math.floor(d / SEG));
      const center = W / 2 + points[idx].dx * p.t;
      const x = center + rival.lateral * p.width;
      const y = p.y - p.t * 7;
      const s = clamp(p.t * CAR_SCALE, .12, CAR_SCALE);
      drawF1(x, y, s, rival.color, false, false);
    }
  }

  function drawCar() {
    const bounce = Math.sin(raceTime * 27) * Math.min(1.6, car.speed * .018)
      + (car.offTrack ? Math.sin(raceTime * 63) * 2.1 : 0);
    const x = W * .5 + car.lateral * W * .37;
    const y = H * (W < 700 ? .80 : .855) + bounce;
    const boosting = phase === 'racing' && keys.has(' ') && car.ers > .005;
    if (boosting) {
      const glow = ctx.createRadialGradient(x, y + 26, 8, x, y + 26, 150 * (CAR_SCALE / 1.5));
      glow.addColorStop(0, 'rgba(96,220,255,.32)');
      glow.addColorStop(.5, 'rgba(96,220,255,.10)');
      glow.addColorStop(1, 'rgba(96,220,255,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - 190, y - 100, 380, 300);
    }
    ctx.save();
    if (Math.abs(car.steer) > .25) {
      ctx.translate(x, y);
      ctx.rotate(-car.steer * .038);
      ctx.translate(-x, -y);
    }
    drawF1(x, y, CAR_SCALE, '#e92032', true, car.brake > 0);
    ctx.restore();
  }

  function drawDust() {
    if (!car.offTrack || car.speed < 9) return;
    const x = W * .5 + car.lateral * W * .37;
    const side = car.lateral > 0 ? 1 : -1;
    for (let i = 0; i < 7; i++) {
      const k = (raceTime * 1.7 + i * .16) % 1;
      ctx.fillStyle = `rgba(196,172,126,${(1 - k) * .22})`;
      ctx.beginPath();
      ctx.arc(x - side * (16 + k * 86), H * .86 + 12 + k * 30, 5 + k * 19, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawSpeedLines() {
    if (car.speed < 52) return;
    const alpha = clamp((car.speed - 52) / 62, 0, .17);
    ctx.strokeStyle = `rgba(235,245,250,${alpha})`;
    ctx.lineWidth = 1;
    for (let i = 0; i < 9; i++) {
      const y = H * (.46 + ((i * 37) % 46) / 100);
      const side = i % 2 ? 1 : -1;
      const x = side < 0 ? W * .07 + i * 12 : W * .93 - i * 12;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + side * 13, y + 28);
      ctx.stroke();
    }
  }

  function drawStartLights() {
    if (phase !== 'lights') return;
    const elapsed = performance.now() - lightStart;
    const lit = Math.min(5, Math.floor(elapsed / 700));
    const cx = W / 2, cy = H * .42;
    const gap = clamp(W * .048, 36, 62);
    const r = clamp(W * .0095, 7, 12);

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.7)';
    ctx.shadowBlur = 34;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = 'rgba(6,10,15,.92)';
    ctx.beginPath();
    ctx.roundRect(cx - gap * 3.15, cy - r * 3.2, gap * 6.3, r * 6.4, 9);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgba(255,255,255,.17)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(216,255,62,.75)';
    ctx.fillRect(cx - gap * 3.15, cy - r * 3.2, gap * 6.3, 2);

    for (let i = 0; i < 5; i++) {
      const x = cx + (i - 2) * gap;
      for (let row = 0; row < 2; row++) {
        const y = cy + (row ? r * 1.55 : -r * 1.55);
        ctx.fillStyle = '#0c1013';
        ctx.strokeStyle = 'rgba(255,255,255,.13)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        if (i < lit) {
          const glow = ctx.createRadialGradient(x, y, 1, x, y, r * 2.6);
          glow.addColorStop(0, 'rgba(255,105,82,.9)');
          glow.addColorStop(.35, 'rgba(255,42,32,.55)');
          glow.addColorStop(1, 'rgba(255,40,30,0)');
          ctx.fillStyle = glow;
          ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#ff3b2e';
          ctx.beginPath(); ctx.arc(x, y, r * .8, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(255,226,214,.85)';
          ctx.beginPath(); ctx.arc(x - r * .2, y - r * .2, r * .3, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.font = `500 ${clamp(W * .007, 8, 11)}px "DM Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('START', cx, cy + r * 4.3);
    ctx.restore();
  }

  function drawTrack() {
    const sx = Math.sin(raceTime * 61) * shake * 3.4;
    const sy = Math.cos(raceTime * 47) * shake * 2.6;
    ctx.save();
    ctx.translate(sx, sy);
    sky();
    const points = roadPoints();
    drawRoad(points);
    drawTrees(points);
    drawPits(points);
    drawHaze();
    drawStartArea(points);
    drawRivals(points);
    drawDust();
    drawCar();
    drawSpeedLines();
    ctx.restore();
    drawStartLights();
  }

  /* --------------------------------- physics ------------------------------- */

  function currentGrip() {
    const tempPen = car.tyreTemp > 112 ? (car.tyreTemp - 112) * .004
      : car.tyreTemp < 72 ? (72 - car.tyreTemp) * .004 : 0;
    return clamp(1 - car.wear * .55 - tempPen - (car.offTrack ? .18 : 0), .34, 1);
  }

  function liveRank() {
    let rank = 1;
    for (const o of opponents) if (o.progress > car.distance) rank++;
    return clamp(rank, 1, 8);
  }

  function updateRev(dt, throttle) {
    const wheelRpm = car.speed * RATIOS[car.gear] * RPM_K;
    const clutchRpm = car.speed < 6 ? IDLE + throttle * 6800 : 0;
    const target = Math.max(IDLE, wheelRpm, clutchRpm);
    car.rpm = lerp(car.rpm, clamp(target, 0, REDLINE + 120), 1 - Math.exp(-dt * 11));
    if (car.rpm > REDLINE - 120) car.limiter = true;
    else if (car.rpm < REDLINE - 900) car.limiter = false;
  }

  function shift(dir) {
    if (phase !== 'racing' || paused) return;
    const next = clamp(car.gear + dir, 1, 8);
    if (next === car.gear) return;
    if (dir < 0) {
      const targetRpm = car.speed * RATIOS[next] * RPM_K;
      if (targetRpm > REDLINE - 300) {
        car.shiftFlash = .4;
        showMessage('DOWNSHIFT LOCKED', 700);
        if (soundOn) beep(170, .07, 'square', .02);
        return;
      }
    }
    car.gear = next;
    car.shiftCut = dir > 0 ? .12 : .08;
    car.shiftFlash = .4;
    if (soundOn) beep(dir > 0 ? 620 : 340, .04, 'square', .028);
  }

  function update(dt) {
    dt = Math.min(dt, .05);

    if (phase === 'lights') {
      const throttle = input('w') ? 1 : 0;
      car.throttle = throttle;
      car.brake = 0;
      car.steer = 0;
      updateRev(dt, throttle);
      car.tyreTemp = lerp(car.tyreTemp, 82, dt * .3);
      if (soundOn) updateEngineSound();
      return;
    }
    if (phase !== 'racing' || paused) return;

    raceTime += dt;
    const throttle = input('w') ? 1 : 0;
    const brake = input('s') ? 1 : 0;
    const steerIn = (input('d') ? 1 : 0) - (input('a') ? 1 : 0);
    const boost = keys.has(' ') && car.ers > .005 && !car.limiter;

    car.throttle = throttle;
    car.brake = brake;
    car.steer = lerp(car.steer, steerIn, 1 - Math.exp(-dt * 8));

    updateRev(dt, throttle);

    if (boost) car.ers = Math.max(0, car.ers - dt * .16);
    else car.ers = Math.min(1, car.ers + dt * .045);

    car.shiftCut = Math.max(0, car.shiftCut - dt);
    car.shiftFlash = Math.max(0, car.shiftFlash - dt);
    car.wallCool = Math.max(0, car.wallCool - dt);

    car.grip = currentGrip();

    const torque = clamp(1 - .32 * Math.pow((car.rpm - 10400) / 6400, 2), .26, 1);
    const launch = car.speed < 14 ? .60 + .40 * (car.speed / 14) : 1;
    let engine = throttle * 3800 * RATIOS[car.gear] * torque * launch * (boost ? 1.18 : 1);
    if (car.shiftCut > 0) engine *= .08;
    if (car.limiter) engine *= .05;
    engine *= 1 - car.wear * .06;

    const drag = .39 * car.speed * car.speed;
    const rolling = 95 + car.speed * 1.7;
    const brakeForce = brake * 29000;

    car.speed = Math.max(0, car.speed + (engine - drag - rolling - brakeForce) / MASS * dt);
    car.speed = Math.min(car.speed, 108);

    const speedK = clamp(car.speed / 55, 0, 1.7);
    const bend = clamp(bendAt(car.progress) * 1500, -1.8, 1.8);
    const cornerPush = -bend * 1.15 * Math.pow(speedK, 2);
    const authority = 3.35 * car.grip * (1 - clamp(car.slip * .38, 0, .5));
    car.latVel += (car.steer * authority - car.latVel * 2.05 + cornerPush) * dt;
    car.latVel = clamp(car.latVel, -1.55, 1.55);
    car.lateral += car.latVel * dt;

    car.offTrack = Math.abs(car.lateral) > .93;

    const demand = Math.abs(car.steer) * Math.pow(speedK, 1.7) * .9
      + Math.abs(car.latVel) * .5 + (car.offTrack ? .45 : 0);
    car.slip = clamp(demand - car.grip, 0, 1);

    if (car.slip > .25 && !car.offTrack) {
      car.speed = Math.max(0, car.speed - car.slip * car.speed * dt * .35);
    }

    if (car.offTrack) {
      car.speed = Math.max(0, car.speed - dt * (6 + car.speed * .16));
      shake = Math.max(shake, .35 + car.speed * .004);
    }

    if (Math.abs(car.lateral) > 1.2) {
      const side = sgn(car.lateral);
      car.lateral = side * 1.2;
      car.latVel = -side * Math.abs(car.latVel) * .25;
      car.speed *= .90;
      if (car.wallCool <= 0) {
        shake = 1.2;
        showMessage('WALL CONTACT', 850);
        car.wallCool = 1.1;
        if (soundOn) beep(70, .18, 'sawtooth', .06);
      }
    }

    car.wear = clamp(car.wear + dt * (.0005 + car.slip * .0016 + (car.offTrack ? .0028 : 0) + (brake && car.speed > 60 ? .00035 : 0)), 0, .6);
    const targetTemp = 86 + car.speed * .05 + Math.abs(car.steer) * car.speed * .40 + car.slip * 30;
    car.tyreTemp = lerp(car.tyreTemp, targetTemp, dt * .10);

    car.distance += car.speed * dt;
    car.progress = modulo(car.distance - GRID, TRACK);
    car.topSpeed = Math.max(car.topSpeed, car.speed);

    if (car.distance >= car.nextLine) {
      if (!car.raceStarted) {
        car.raceStarted = true;
        car.lapStart = raceTime;
        car.nextLine += TRACK;
        showMessage('LAP 01', 1200);
      } else {
        const lapTime = raceTime - car.lapStart;
        car.lapStart = raceTime;
        car.lapTimes.push(lapTime);
        if (!car.best || lapTime < car.best) car.best = lapTime;
        const completed = car.lap;
        car.nextLine += TRACK;
        car.lap = Math.min(LAPS, car.lap + 1);
        if (completed >= LAPS) {
          finishRace();
          return;
        }
        if (car.lap === LAPS) showMessage('FINAL LAP', 1700);
        else showMessage(`LAP ${pad(car.lap)}  ·  ${fmtTime(lapTime)}`, 2000);
        if (soundOn) beep(760, .08, 'sine', .03);
      }
    }

    for (const o of opponents) {
      if (o.finishTime !== null) continue;
      const gap = o.progress - car.distance;
      let pace = o.base + Math.sin(raceTime * .13 + o.phase) * .55 + Math.sin(raceTime * .033 + o.phase * 2) * .4;
      if (gap > 200) pace -= 1.1;
      else if (gap < -150) pace += 1.5;
      o.speed = lerp(o.speed, pace, dt * .45);
      o.progress += o.speed * dt;
      o.lateral = clamp(o.lateral + Math.sin(raceTime * .55 + o.phase) * dt * .07, -.62, .62);
      if (o.progress >= RACE_END) {
        o.progress = RACE_END;
        o.finishTime = raceTime;
      }
    }

    shake = Math.max(0, shake - dt * 2.2);
    if (soundOn) updateEngineSound();
  }

  /* ----------------------------------- HUD --------------------------------- */

  function updateHUD() {
    const kmh = Math.round(car.speed * 3.6);
    $('speed').textContent = String(kmh).padStart(3, '0');
    $('gear').textContent = phase === 'menu' ? 'N' : String(car.gear);
    $('rpmText').textContent = Math.round(car.rpm).toLocaleString('en-US');

    const rpmRatio = clamp((car.rpm - 4000) / 9400, 0, 1);
    rpmBars.forEach((el, i) => {
      el.className = i < rpmRatio * 18 ? (i > 14 ? 'hot' : 'on') : '';
    });

    $('throttleMeter').style.width = `${car.throttle * 100}%`;
    $('brakeMeter').style.width = `${car.brake * 100}%`;
    $('throttleText').textContent = `${Math.round(car.throttle * 100)}%`;
    $('brakeText').textContent = `${Math.round(car.brake * 100)}%`;

    $('gripText').textContent = `${Math.round(car.grip * 100)}%`;
    const tyreColor = car.grip < .68 ? '#ff6656' : car.grip < .86 ? '#ffd166' : '#aaff42';
    for (const id of ['tyreFL', 'tyreFR', 'tyreRL', 'tyreRR']) {
      const el = $(id);
      el.style.opacity = String(.4 + car.grip * .6);
      el.style.borderColor = tyreColor;
    }

    const boosting = phase === 'racing' && keys.has(' ') && car.ers > .005;
    $('ersMeter').style.width = `${car.ers * 100}%`;
    $('ersText').textContent = `${Math.round(car.ers * 100)}%`;
    $('drsState').innerHTML = `ERS <b>${car.ers <= .005 ? 'EMPTY' : boosting ? 'BOOST' : 'READY'}</b>`;

    $('lap').textContent = pad(Math.min(car.lap, LAPS));
    $('timer').textContent = fmtTime(raceTime);
    $('cornerName').textContent = getCorner(car.progress / TRACK);
    $('position').textContent = `P ${pad(phase === 'finished' ? (car.finalPlace || 8) : liveRank())}`;

    const lastLap = car.lapTimes[car.lapTimes.length - 1];
    const lapBox = $('lapTimes');
    const lastEl = lapBox.children[1];
    const bestEl = lapBox.children[3];
    lastEl.textContent = lastLap ? fmtTime(lastLap) : '--:--.---';
    bestEl.textContent = car.best ? fmtTime(car.best) : '--:--.---';

    let status = 'RACE IN PROGRESS';
    if (phase === 'menu') status = 'FORMATION LAP';
    else if (phase === 'lights') status = 'LIGHTS SEQUENCE · HOLD REVS';
    else if (phase === 'finished') status = 'RACE FINISHED';
    else if (car.offTrack) status = 'OFF TRACK · GRIP LIMITED';
    else if (car.limiter) status = 'REV LIMITER · UPSHIFT';
    else if (car.rpm > 12400) status = 'SHIFT UP';
    else if (car.slip > .55) status = 'TYRE SLIP · EASE OFF';
    $('statusText').textContent = status;
    $('statusText').style.color = car.offTrack && phase === 'racing' ? '#ff7868'
      : (car.limiter || car.rpm > 12400) && phase === 'racing' ? '#d8ff3e' : '';

    $('gearWrap').classList.toggle('shift', phase === 'racing' && car.rpm > 12400);
  }

  function showMessage(text, ms = 900) {
    $('messageText').textContent = text;
    $('raceMessage').classList.add('show');
    clearTimeout(messageTimeout);
    messageTimeout = setTimeout(() => $('raceMessage').classList.remove('show'), ms);
  }

  /* ---------------------------------- flow --------------------------------- */

  function resetRace() {
    setup();
    raceTime = 0;
    paused = false;
    shake = 0;
    clearTimeout(messageTimeout);
    $('raceMessage').classList.remove('show');
    $('pausePanel').style.display = 'none';
    if (audio && audio.engineGain) audio.engineGain.gain.setTargetAtTime(0, audio.currentTime, .05);
    updateHUD();
  }

  function begin() {
    if (phase === 'racing' || phase === 'lights') return;
    resetRace();
    phase = 'lights';
    lightStart = performance.now();
    lightsOutAt = lightStart + 3500 + 500 + Math.random() * 900;
    $('startCard').classList.add('hidden');
    $('resultCard').classList.add('hidden');
    $('pausePanel').style.display = 'none';
    $('mobileControls').style.display = '';
    if (soundOn) beep(440, .05, 'sine', .02);
  }

  function goRace() {
    if (phase !== 'lights') return;
    phase = 'racing';
    raceTime = 0;
    car.lapStart = 0;
    last = performance.now();
    showMessage('LIGHTS OUT', 1200);
    if (soundOn) beep(920, .2, 'square', .05);
  }

  function finishRace() {
    phase = 'finished';
    paused = false;
    keys.clear();
    car.finalPlace = 1 + opponents.filter((o) => o.finishTime !== null && o.finishTime <= raceTime).length;
    $('resultPos').textContent = `P ${pad(car.finalPlace)}`;
    $('resultTime').textContent = fmtTime(raceTime);
    $('resultBest').textContent = car.best ? fmtTime(car.best) : '--:--.---';
    $('resultWear').textContent = `${Math.round(car.wear * 100)}%`;
    $('resultSpeed').textContent = `${Math.round(car.topSpeed * 3.6)} KM/H`;
    const fastest = Math.min(...car.lapTimes);
    $('resultLaps').innerHTML = car.lapTimes.map((t, i) =>
      `<span class="${t === fastest ? 'fast' : ''}"><i>LAP ${i + 1}</i>${fmtTime(t)}</span>`
    ).join('');
    $('resultCard').classList.remove('hidden');
    $('gearWrap').classList.remove('shift');
    $('mobileControls').style.display = 'none';
    if (audio && audio.engineGain) audio.engineGain.gain.setTargetAtTime(0, audio.currentTime, .25);
    if (audio && audio.tyreGain) audio.tyreGain.gain.setTargetAtTime(0, audio.currentTime, .2);
    if (soundOn) beep(660, .12, 'sine', .04), setTimeout(() => soundOn && beep(880, .2, 'sine', .04), 150);
  }

  function togglePause() {
    if (phase !== 'racing') return;
    paused = !paused;
    $('pausePanel').style.display = paused ? 'block' : 'none';
    if (paused) {
      keys.clear();
      if (audio && audio.engineGain) audio.engineGain.gain.setTargetAtTime(0, audio.currentTime, .05);
      if (audio && audio.tyreGain) audio.tyreGain.gain.setTargetAtTime(0, audio.currentTime, .05);
    } else {
      last = performance.now();
    }
  }

  /* ---------------------------------- audio -------------------------------- */

  function ensureAudio() {
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      audio = new AC();
    }
    if (audio.state === 'suspended') audio.resume();
    return true;
  }

  function ensureEngineNodes() {
    if (!audio || audio.engine) return;
    audio.engine = audio.createOscillator();
    audio.engine.type = 'sawtooth';
    audio.engine2 = audio.createOscillator();
    audio.engine2.type = 'square';
    audio.engineFilter = audio.createBiquadFilter();
    audio.engineFilter.type = 'lowpass';
    audio.engineFilter.frequency.value = 900;
    audio.engineGain = audio.createGain();
    audio.engineGain.gain.value = 0;
    audio.engine.connect(audio.engineFilter);
    audio.engine2.connect(audio.engineFilter);
    audio.engineFilter.connect(audio.engineGain);
    audio.engineGain.connect(audio.destination);
    audio.engine.start();
    audio.engine2.start();

    const len = audio.sampleRate;
    const buf = audio.createBuffer(1, len, audio.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    audio.tyreSrc = audio.createBufferSource();
    audio.tyreSrc.buffer = buf;
    audio.tyreSrc.loop = true;
    audio.tyreFilter = audio.createBiquadFilter();
    audio.tyreFilter.type = 'bandpass';
    audio.tyreFilter.frequency.value = 2400;
    audio.tyreFilter.Q.value = 1.4;
    audio.tyreGain = audio.createGain();
    audio.tyreGain.gain.value = 0;
    audio.tyreSrc.connect(audio.tyreFilter);
    audio.tyreFilter.connect(audio.tyreGain);
    audio.tyreGain.connect(audio.destination);
    audio.tyreSrc.start();
  }

  function updateEngineSound() {
    if (!audio || !soundOn) return;
    ensureEngineNodes();
    const now = audio.currentTime;
    const f = 38 + car.rpm / 42;
    audio.engine.frequency.setTargetAtTime(f, now, .03);
    audio.engine2.frequency.setTargetAtTime(f * .5, now, .03);
    audio.engineFilter.frequency.setTargetAtTime(500 + car.throttle * 1600 + car.rpm * .06, now, .06);
    audio.engineGain.gain.setTargetAtTime(.007 + car.throttle * .022, now, .07);
    const squeal = clamp(car.slip * .9 + (car.offTrack ? .2 : 0), 0, 1);
    audio.tyreGain.gain.setTargetAtTime(squeal * .018 * clamp(car.speed / 20, 0, 1), now, .08);
    audio.tyreFilter.frequency.setTargetAtTime(car.offTrack ? 900 : 2400, now, .1);
  }

  function beep(freq, duration, type = 'sine', volume = .03) {
    if (!audio) return;
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.value = volume;
    o.connect(g);
    g.connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + duration);
  }

  function toggleSound() {
    soundOn = !soundOn;
    if (soundOn) {
      if (!ensureAudio()) { soundOn = false; return; }
      ensureEngineNodes();
      audio.engineGain.gain.setTargetAtTime(0, audio.currentTime, .06);
      $('soundBtn').style.color = '#d8ff3e';
      if (phase === 'racing' || phase === 'lights') updateEngineSound();
    } else {
      if (audio && audio.engineGain) audio.engineGain.gain.setTargetAtTime(0, audio.currentTime, .06);
      if (audio && audio.tyreGain) audio.tyreGain.gain.setTargetAtTime(0, audio.currentTime, .06);
      $('soundBtn').style.color = '';
    }
  }

  /* ---------------------------------- input -------------------------------- */

  function input(k) {
    return keys.has(k)
      || (k === 'w' && keys.has('arrowup'))
      || (k === 's' && keys.has('arrowdown'))
      || (k === 'a' && keys.has('arrowleft'))
      || (k === 'd' && keys.has('arrowright'));
  }

  function frame(now) {
    let dt = (now - last) / 1000;
    if (!isFinite(dt) || dt < 0) dt = 0;
    last = now;
    if (phase === 'lights' && now >= lightsOutAt) goRace();
    update(dt);
    drawTrack();
    updateHUD();
    requestAnimationFrame(frame);
  }

  $('startBtn').addEventListener('click', begin);
  $('restartBtn').addEventListener('click', begin);
  $('pauseBtn').addEventListener('click', togglePause);
  $('soundBtn').addEventListener('click', toggleSound);
  $('helpBtn').addEventListener('click', () => $('helpPop').classList.toggle('open'));

  document.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
    if (!keys.has(k)) {
      if (k === 'e' || k === 'shift') shift(1);
      if (k === 'q' || k === 'control') shift(-1);
      if (k === 'p') togglePause();
      if (k === 'enter' && phase === 'menu') begin();
      if (k === 'r' && phase === 'finished') begin();
    }
    keys.add(k);
  });
  document.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => {
    keys.clear();
    if (phase === 'racing' && !paused) togglePause();
  });

  document.querySelectorAll('.mobile-controls button[data-key]').forEach((b) => {
    const k = b.dataset.key;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      keys.add(k);
      b.setPointerCapture(e.pointerId);
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      b.addEventListener(ev, () => keys.delete(k));
    }
  });
  document.querySelectorAll('.mobile-controls button[data-shift]').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      shift(Number(b.dataset.shift));
    });
  });
  document.querySelectorAll('.mobile-controls button[data-boost]').forEach((b) => {
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      keys.add(' ');
      b.classList.add('on');
      b.setPointerCapture(e.pointerId);
    });
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      b.addEventListener(ev, () => {
        keys.delete(' ');
        b.classList.remove('on');
      });
    }
  });

  window.addEventListener('resize', resize);
  resize();
  setup();
  window.__APEX__ = {
    get car() { return car; },
    get opponents() { return opponents; },
    get phase() { return phase; },
    bend(d) { return bendAt(d); },
    skip(m) {
      car.distance = m;
      car.progress = modulo(m - GRID, TRACK);
      car.raceStarted = true;
      car.nextLine = GRID + Math.max(1, Math.ceil((m - GRID) / TRACK)) * TRACK;
    },
    finish() {
      car.lapTimes = [81.241, 80.517, 79.884];
      car.best = 79.884;
      car.wear = .19;
      car.topSpeed = 88.4;
      finishRace();
    }
  };
  requestAnimationFrame(frame);
})();
