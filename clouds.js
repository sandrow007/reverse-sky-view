/* Manolit∞ Nubes — visor estático de nubes reales a nivel de calle.
 * 100% navegador, sin backend: descarga teselas NASA GIBS, calcula la
 * homografía cámara-plano de nubes, recorta con una malla afín por
 * triángulos, enmascara la nube por blancura y la proyecta en Cesium
 * sobre el cuadrilátero georreferenciado exacto.
 *
 * Sandro. Licencia AGPL-3.0. Sin tokens, sin dependencias de pago.
 */
(function () {
  'use strict';

  // =========================================================================
  // Configuración
  // =========================================================================
  var HOME = { lat: 37.39651, lon: -5.99347 }; // Alameda de Hércules, Sevilla
  var EYE = 1.7;                 // altura del ojo en metros
  var FOVH = 60.0;               // campo horizontal en grados
  var PITCH_MIN = 6.0;           // permite mirar casi al nivel del suelo
  var PITCH_MAX = 85.0;
  var ALTA_ALT = 6000;           // altitud de la vista aérea (mapa + nubes visibles)
  var ALT_GLOBAL = 2400000;      // altitud del arranque: el globo entero con la nube
  // Transición automática aérea/calle según la altura de la cámara:
  // por debajo de ENTRADA se activa la calle, por encima de SALIDA vuelve
  // el mapa. La histéresis evita parpadeos al acercar o alejar la rueda.
  var UMBRAL_ENTRADA_CALLE = 150;
  var UMBRAL_SALIDA_CALLE = 260;
  var PITCH_ENTRADA = 20;        // inclinación al entrar en la calle
  var RADIO_EDIFICIOS = 280;
  var MAX_EDIFICIOS = 600;
  var AREA_MINIMA_M2 = 30;

  var GIBS_BASE = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best';
  // Capa fija de la sesión: con Time=default GIBS sirve siempre la imagen
  // más reciente publicada (HTTP 200 garantizado, sin sondas de fechas).
  // Calle y mapa usan la misma URL, así la foto es idéntica en ambos.
  var CAPA_SATELITE = 'MODIS_Terra_CorrectedReflectance_TrueColor';
  var MATRIX_SET = '250m';
  var TILE_PX = 512;
  var MAX_ZOOM = 8;
  var MIN_ZOOM = 3;

  // Esri primero: CDN fiable y con CORS abierto. OSM como redundancia.
  var OSM_ESPEJOS = [
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    'https://tile.openstreetmap.de/{z}/{x}/{y}.png',
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
  ];

  // Overpass: intento directo al espejo suizo (el más estable) y relé
  // allorigins como reserva, porque añade CORS incluso a sus errores.
  var OVERPASS_DIRECTO = 'https://overpass.osm.ch/api/interpreter';
  var OVERPASS_RESERVA = [
    'https://overpass.openstreetmap.fr/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

  var OUT_W = 1024;              // resolución de la textura de cielo
  var OUT_H = 640;
  var MALLA_X = 32;              // celdas de la malla de deformación
  var MALLA_Y = 20;

  var RADIO_TIERRA = 6378137.0;

  // =========================================================================
  // Estado
  // =========================================================================
  var viewer = null;
  var groundH = 0;
  var centro = { lat: HOME.lat, lon: HOME.lon };
  var modoCalle = false;
  var altitudNube = 2000;
  var nubePrimitive = null;
  var edificiosPrimitive = null;
  var capaAereaInst = null;
  var capaBaseActual = null;
  var espejoActual = 0;
  var ultimoCentroEdificios = null;
  var volando = false;           // true mientras un flyTo está en movimiento
  var ultimoPeticion = null;     // últimos parámetros con los que se calculó
  var pidiendo = false;
  var esperaTimer = null;
  var recalcs = 0;               // contador de recálculos realizados
  var cacheEdificios = {};       // 'lat,lon' -> lista de anillos filtrados
  var ordenCacheEdificios = [];
  var cacheElevacion = {};       // 'lat,lon' -> altura del terreno en metros

  var elEstado = document.getElementById('estado');
  var elCargando = document.getElementById('cargando');
  var elAltValor = document.getElementById('alt-valor');
  var elFecha = document.getElementById('leyenda-fecha');
  var elLectura = document.getElementById('lectura');

  // Superficie de errores: nada puede fallar en silencio. Cualquier error de
  // la pagina, promesa rechazada sin capturar o fallo del bucle de render
  // se escribe aqui con palabras, para que se vea sin abrir la consola.
  var errorVisiblePuesto = false;
  function errorVisible(txt) {
    if (errorVisiblePuesto) return;
    errorVisiblePuesto = true;
    fijarEstado(txt);
  }
  window.addEventListener('error', function (ev) {
    var m = ev && ev.message ? ev.message : 'error desconocido';
    errorVisible('Error en la pagina, avisa a Sandro con esto: ' + m);
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    var m = r && r.message ? r.message : String(r || 'fallo desconocido');
    if (m === 'sin-imagen') return; // ya lo gestiona recalcularNube
    errorVisible('Fallo sin capturar, avisa a Sandro con esto: ' + m);
  });

  function actualizarLectura() {
    if (!elLectura || !viewer) return;
    var pos = viewer.camera.positionCartographic;
    if (!pos) return;
    var lat = deg(pos.latitude), lon = deg(pos.longitude);
    var pitchV = modoCalle
      ? Math.round(clamp(deg(viewer.camera.pitch), PITCH_MIN, PITCH_MAX))
      : Math.round(deg(viewer.camera.pitch));
    elLectura.textContent = Math.abs(lat).toFixed(4) + ' ' + (lat >= 0 ? 'N' : 'S') +
      ' · ' + Math.abs(lon).toFixed(4) + ' ' + (lon >= 0 ? 'E' : 'O') +
      ' · giro ' + Math.round(normaliza(deg(viewer.camera.heading))) +
      '° · inclinación ' + pitchV + '°';
  }

  function fijarEstado(txt) { elEstado.textContent = txt; }
  function fijarCargando(on) { elCargando.classList.toggle('visible', !!on); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function rad(g) { return g * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }
  function normaliza(g) { g %= 360; return g < 0 ? g + 360 : g; }

  // =========================================================================
  // Matemáticas: rayos, intersección con el plano, homografía
  // =========================================================================
  function rayoEnu(heading, pitch, a, b, fovh, fovv) {
    var h = rad(heading), p = rad(pitch);
    var fx = Math.sin(h) * Math.cos(p);
    var fy = Math.cos(h) * Math.cos(p);
    var fz = Math.sin(p);
    var rx = Math.cos(h), ry = -Math.sin(h), rz = 0;
    var sx = ry * fz - rz * fy;
    var sy = rz * fx - rx * fz;
    var sz = rx * fy - ry * fx;
    var tx = Math.tan(rad(fovh) / 2), ty = Math.tan(rad(fovv) / 2);
    var dx = fx + a * tx * rx + b * ty * sx;
    var dy = fy + a * tx * ry + b * ty * sy;
    var dz = fz + b * ty * sz;
    var n = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return [dx / n, dy / n, dz / n];
  }

  function rayoALonLat(d, lat0, altura) {
    if (d[2] <= 1e-6) return null;
    var t = altura / d[2];
    var este = d[0] * t, norte = d[1] * t;
    var dlon = este / (RADIO_TIERRA * Math.cos(rad(lat0))) * 180 / Math.PI;
    var dlat = norte / RADIO_TIERRA * 180 / Math.PI;
    return [dlon, dlat];
  }

  // Rayo que siempre corta el plano de nubes: si apunta por debajo del
  // horizonte se le sube la elevación al mínimo. Así la textura cubre
  // también la franja baja de la pantalla cuando se mira hacia el suelo.
  function rayoAPlano(heading, pitch, a, b, fovh, fovv, altura, lat0) {
    var d = rayoEnu(heading, pitch, a, b, fovh, fovv);
    if (d[2] < 0.021) {
      var dz = 0.021; // unos 1.2 grados
      var nh = Math.sqrt(d[0] * d[0] + d[1] * d[1] + dz * dz);
      d = [d[0] / nh, d[1] / nh, dz / nh];
    }
    return rayoALonLat(d, lat0, altura);
  }

  // Resuelve un sistema lineal 8x8 por eliminación gaussiana con pivoteo
  function resuelve8(A, B) {
    var n = 8, M = [], i, j, k, row;
    for (i = 0; i < n; i++) {
      row = A[i].slice();
      row.push(B[i]);
      M.push(row);
    }
    for (k = 0; k < n; k++) {
      var piv = k, mx = Math.abs(M[k][k]);
      for (i = k + 1; i < n; i++) {
        if (Math.abs(M[i][k]) > mx) { mx = Math.abs(M[i][k]); piv = i; }
      }
      if (piv !== k) { var tmp = M[k]; M[k] = M[piv]; M[piv] = tmp; }
      var d = M[k][k];
      for (j = k; j <= n; j++) M[k][j] /= d;
      for (i = 0; i < n; i++) {
        if (i === k) continue;
        var f = M[i][k];
        if (f === 0) continue;
        for (j = k; j <= n; j++) M[i][j] -= f * M[k][j];
      }
    }
    var x = [];
    for (i = 0; i < n; i++) x.push(M[i][n]);
    return x;
  }

  // Homografía destino (x,y) -> fuente (u,v), 4 pares de puntos
  function homografia(dst, src) {
    var A = [], B = [];
    for (var i = 0; i < 4; i++) {
      var x = dst[i][0], y = dst[i][1], u = src[i][0], v = src[i][1];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    var c = resuelve8(A, B);
    return c; // a,b,c,d,e,f,g,h con u=(ax+by+c)/(gx+hy+1)
  }

  function aplicaH(H, x, y) {
    var den = H[6] * x + H[7] * y + 1;
    return [(H[0] * x + H[1] * y + H[2]) / den,
            (H[3] * x + H[4] * y + H[5]) / den];
  }

  // =========================================================================
  // GIBS: mosaico y máscara de nubes
  // =========================================================================
  function cargaImagen(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('no carga')); };
      img.src = url;
    });
  }

  // Time=default: GIBS resuelve a la fecha más reciente publicada.
  function urlTesela(z, y, x) {
    return GIBS_BASE + '/' + CAPA_SATELITE + '/default/default/' +
      MATRIX_SET + '/' + z + '/' + y + '/' + x + '.jpeg';
  }

  function zoomParaBBox(anchoDeg, altoDeg) {
    var necesario = Math.log(180.0 /
      (TILE_PX * Math.max(anchoDeg / OUT_W, altoDeg / OUT_H, 1e-9))) / Math.log(2);
    return clamp(Math.ceil(necesario), MIN_ZOOM, MAX_ZOOM);
  }

  function lonlatATesela(lon, lat, z) {
    var ancho = 180.0 / Math.pow(2, z);
    return [Math.floor((lon + 180) / ancho), Math.floor((90 - lat) / ancho)];
  }

  function cargaMosaico(lonMin, lonMax, latMin, latMax, z) {
    var ancho = 180.0 / Math.pow(2, z);
    var t0 = lonlatATesela(lonMin, latMax, z);
    var t1 = lonlatATesela(lonMax, latMin, z);
    var nx = t1[0] - t0[0] + 1, ny = t1[1] - t0[1] + 1;
    if (nx * ny > 64) return Promise.reject(new Error('region-grande'));
    var canvas = document.createElement('canvas');
    canvas.width = nx * TILE_PX; canvas.height = ny * TILE_PX;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var trabajos = [];
    var fallos = 0;
    for (var dy = 0; dy < ny; dy++) {
      for (var dx = 0; dx < nx; dx++) {
        trabajos.push((function (x, y, px, py) {
          return cargaImagen(urlTesela(z, y, x)).then(function (img) {
            ctx.drawImage(img, px, py);
          }, function () {
            fallos++;
            ctx.fillStyle = 'rgb(32,32,48)';
            ctx.fillRect(px, py, TILE_PX, TILE_PX);
          });
        })(t0[0] + dx, t0[1] + dy, dx * TILE_PX, dy * TILE_PX));
      }
    }
    return Promise.all(trabajos).then(function () {
      // si ninguna tesela llego, la red esta bloqueando GIBS: mejor avisar
      // que pintar un cielo falso
      if (fallos === trabajos.length && trabajos.length > 0) {
        throw new Error('sin-imagen');
      }
      return {
        canvas: canvas,
        lonMin: -180 + t0[0] * ancho,
        latMax: 90 - t0[1] * ancho,
        degPx: ancho / TILE_PX
      };
    });
  }

  function smoothstep(t) {
    t = clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  }

  // Máscara de nube por blancura sobre el mosaico (afecta solo al alfa)
  function aplicaMascara(mosaico) {
    var canvas = mosaico.canvas;
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var alfa = new Float32Array(w * h);
    var i, r, g, b, mn, mx;
    for (i = 0; i < w * h; i++) {
      r = d[i * 4]; g = d[i * 4 + 1]; b = d[i * 4 + 2];
      mn = Math.min(r, g, b); mx = Math.max(r, g, b);
      var a = smoothstep((mn - 135) / 90) *
              (1 - smoothstep((mx - mn - 28) / 47));
      alfa[i] = Math.pow(a, 0.75);
    }
    // difuminado separable 9-tap sobre el alfa
    var tmp = new Float32Array(w * h);
    var x, y, k, suma, peso;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        suma = 0;
        for (k = -4; k <= 4; k++) {
          suma += alfa[y * w + clamp(x + k, 0, w - 1)];
        }
        tmp[y * w + x] = suma / 9;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        suma = 0;
        for (k = -4; k <= 4; k++) {
          suma += tmp[clamp(y + k, 0, h - 1) * w + x];
        }
        alfa[y * w + x] = suma / 9;
      }
    }
    for (i = 0; i < w * h; i++) {
      // 0.8 deja respirar el cielo y los edificios bajo la nube
      d[i * 4 + 3] = Math.round(alfa[i] * 0.8 * 255);
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---------------------------------------------------------------------------
  // Implementación de referencia del mismo mapeo proyectivo por deformación
  // afín sobre canvas 2D. El visor usa en su lugar la rejilla de vértices de
  // calcularTextura (mapeo exacto en hardware, sin costuras); se conserva esta
  // versión como comprobación matemática independiente del cálculo de st.
  // ---------------------------------------------------------------------------
  function deformaMalla(src, H) {
    var dest = document.createElement('canvas');
    dest.width = OUT_W; dest.height = OUT_H;
    var ctx = dest.getContext('2d');
    var cw = OUT_W / MALLA_X, ch = OUT_H / MALLA_Y;
    for (var cy = 0; cy < MALLA_Y; cy++) {
      for (var cx = 0; cx < MALLA_X; cx++) {
        var x0 = cx * cw, y0 = cy * ch;
        var x1 = x0 + cw, y1 = y0 + ch;
        triangulo(ctx, src, H, x0, y0, x1, y0, x1, y1);
        triangulo(ctx, src, H, x0, y0, x1, y1, x0, y1);
      }
    }
    return dest;
  }

  function triangulo(ctx, src, H, xa, ya, xb, yb, xc, yc) {
    var qa = aplicaH(H, xa, ya), qb = aplicaH(H, xb, yb), qc = aplicaH(H, xc, yc);
    // afín fuente->destino con 3 pares de puntos
    var den = qa[0] * (qb[1] - qc[1]) + qb[0] * (qc[1] - qa[1]) +
              qc[0] * (qa[1] - qb[1]);
    if (Math.abs(den) < 1e-9) return;
    var a = (xa * (qb[1] - qc[1]) + xb * (qc[1] - qa[1]) +
             xc * (qa[1] - qb[1])) / den;
    var c = (xa * (qc[0] - qb[0]) + xb * (qa[0] - qc[0]) +
             xc * (qb[0] - qa[0])) / den;
    var e = (xa * (qb[0] * qc[1] - qc[0] * qb[1]) +
             xb * (qc[0] * qa[1] - qa[0] * qc[1]) +
             xc * (qa[0] * qb[1] - qb[0] * qa[1])) / den;
    var b = (ya * (qb[1] - qc[1]) + yb * (qc[1] - qa[1]) +
             yc * (qa[1] - qb[1])) / den;
    var d = (ya * (qc[0] - qb[0]) + yb * (qa[0] - qc[0]) +
             yc * (qb[0] - qa[0])) / den;
    var f = (ya * (qb[0] * qc[1] - qc[0] * qb[1]) +
             yb * (qc[0] * qa[1] - qa[0] * qc[1]) +
             yc * (qa[0] * qb[1] - qb[0] * qa[1])) / den;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.lineTo(xc, yc);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(a, b, c, d, e, f);
    ctx.drawImage(src, 0, 0);
    ctx.restore();
  }

  // =========================================================================
  // Núcleo: textura de cielo exacta para la cámara actual
  // =========================================================================
  function calcularTextura(lat, lon, heading, pitch) {
    var fovv = 2 * deg(Math.atan(Math.tan(rad(FOVH) / 2) / aspecto()));
    var esquinasSalida = [[0, 0], [OUT_W, 0], [OUT_W, OUT_H], [0, OUT_H]];
    var quad = [], i;
    for (i = 0; i < 4; i++) {
      var a = (esquinasSalida[i][0] / OUT_W) * 2 - 1;
      var b = 1 - (esquinasSalida[i][1] / OUT_H) * 2;
      var hit = rayoAPlano(heading, pitch, a, b, FOVH, fovv, altitudNube, lat);
      if (!hit) return Promise.reject(new Error('mira-arriba'));
      quad.push([lon + hit[0], lat + hit[1]]);
    }
    var lons = quad.map(function (q) { return q[0]; });
    var lats = quad.map(function (q) { return q[1]; });
    var lonMin = Math.min.apply(null, lons), lonMax = Math.max.apply(null, lons);
    var latMin = Math.min.apply(null, lats), latMax = Math.max.apply(null, lats);
    if (lonMax - lonMin > 20 || latMax - latMin > 20) {
      return Promise.reject(new Error('region-grande'));
    }
    var padX = (lonMax - lonMin) * 0.04, padY = (latMax - latMin) * 0.04;
    lonMin -= padX; lonMax += padX; latMin -= padY; latMax += padY;
    var z = zoomParaBBox(lonMax - lonMin, latMax - latMin);

    return cargaMosaico(lonMin, lonMax, latMin, latMax, z)
      .then(function (mosaico) {
        aplicaMascara(mosaico);
        realzaContraste(mosaico.canvas);
        // Rejilla de vértices 3D: cada nodo es un rayo de cámara que corta
        // el plano de nubes; su st apunta al píxel exacto del mosaico. El
        // mapeo proyectivo queda exacto en hardware, sin costuras de malla.
        var fovv2 = 2 * deg(Math.atan(Math.tan(rad(FOVH) / 2) / aspecto()));
        var GX = 47, GY = 29;              // celdas
        var absH = groundH + EYE + altitudNube;
        var wPx = mosaico.canvas.width, hPx = mosaico.canvas.height;
        var pos = [], st = [], indices = [];
        var jj, ii, a, b, d, hit, glon, glat;
        for (jj = 0; jj <= GY; jj++) {
          for (ii = 0; ii <= GX; ii++) {
            a = (ii / GX) * 2 - 1;
            b = 1 - (jj / GY) * 2;
            hit = rayoAPlano(heading, pitch, a, b, FOVH, fovv2, altitudNube, lat);
            glon = lon + hit[0];
            glat = lat + hit[1];
            pos.push(Cesium.Cartesian3.fromDegrees(glon, glat, absH));
            st.push((glon - mosaico.lonMin) / (mosaico.degPx * wPx),
                    1 - (mosaico.latMax - glat) / (mosaico.degPx * hPx));
          }
        }
        for (jj = 0; jj < GY; jj++) {
          for (ii = 0; ii < GX; ii++) {
            var v0 = jj * (GX + 1) + ii;   // arriba-izquierda
            var v1 = v0 + 1;               // arriba-derecha
            var v2 = v0 + GX + 1;          // abajo-izquierda
            var v3 = v2 + 1;               // abajo-derecha
            indices.push(v0, v3, v1, v0, v2, v3);
          }
        }
        return { canvas: mosaico.canvas, alt: altitudNube,
                 pos: pos, st: st, indices: indices };
      });
  }

  // Contraste suave para que la nube se lea sobre el cielo
  function realzaContraste(canvas) {
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    var img = ctx.getImageData(0, 0, w, h);
    var dd = img.data;
    for (var p = 0; p < w * h; p++) {
      for (var cch = 0; cch < 3; cch++) {
        var v = dd[p * 4 + cch];
        dd[p * 4 + cch] = clamp(Math.round((v - 40) / 215 * 255), 0, 255);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function aspecto() {
    var c = viewer ? viewer.canvas : document.getElementById('cesiumContainer');
    var a = c.clientWidth / Math.max(1, c.clientHeight);
    return clamp(a, 0.2, 6);
  }

  // =========================================================================
  // Escena Cesium
  // =========================================================================
  function creaProveedorBase() {
    var prov = new Cesium.UrlTemplateImageryProvider({
      url: OSM_ESPEJOS[espejoActual],
      credit: 'Esri, Maxar, Earthstar Geographics y colaboradores de OSM',
      maximumLevel: 19
    });
    prov.errorEvent.addEventListener(function () {
      cambiaEspejo();
      return true;
    });
    return prov;
  }

  function cambiaEspejo() {
    if (espejoActual + 1 >= OSM_ESPEJOS.length) return;
    if (cambioEspejoEnCurso) return;
    cambioEspejoEnCurso = true;
    espejoActual++;
    setTimeout(function () {
      if (capaBaseActual) viewer.imageryLayers.remove(capaBaseActual, true);
      capaBaseActual = viewer.imageryLayers.addImageryProvider(creaProveedorBase(), 0);
      cambioEspejoEnCurso = false;
    }, 300);
  }
  var cambioEspejoEnCurso = false;

  function initViewer() {
    capaBaseActual = null;
    viewer = new Cesium.Viewer('cesiumContainer', {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider()
    });
    capaBaseActual = viewer.imageryLayers.addImageryProvider(creaProveedorBase(), 0);
    viewer.camera.frustum.fov = rad(FOVH);
    viewer.camera.percentageChanged = 0.15;
    viewer.camera.moveEnd.addEventListener(alSoltarCamara);
    // si el bucle de render tropieza (por ejemplo con un driver concreto),
    // lo mostramos en pantalla y lo rearrancamos en vez de dejar la escena
    // congelada sin explicacion
    viewer.scene.renderError.addEventListener(function () {
      errorVisiblePuesto = false;
      errorVisible('El renderizado se detuvo, rearrancandolo');
      setTimeout(function () {
        try { viewer.useDefaultRenderLoop = true; } catch (e0) {}
      }, 500);
    });
    // progreso real de la descarga del mapa, para que el arranque no parezca
    // una pantalla muerta mientras suben las teselas
    viewer.scene.globe.tileLoadProgressEvent.addEventListener(function (encola) {
      if (encola > 0 && !pidiendo && elEstado) {
        fijarEstado('Descargando el mapa, quedan ' + encola + ' teselas');
      }
    });
    // manija mínima de depuración, útil para verificar la coherencia en consola
    window.__mnViewer = viewer;
    window.__mnStats = function () {
      return { recalcs: recalcs, groundH: groundH, modoCalle: modoCalle };
    };
  }

  function vistaAerea(altura) {
    modoCalle = false;
    if (nubePrimitive) nubePrimitive.show = false;
    if (capaAereaInst) capaAereaInst.show = true;
    var bm = document.getElementById('btn-modo');
    if (bm) bm.textContent = 'Bajar a la calle';
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(centro.lon, centro.lat,
        groundH + (altura || ALTA_ALT)),
      orientation: { heading: 0, pitch: rad(-90), roll: 0 }
    });
    actualizarLectura();
  }

  // Vuelo suave a un punto y altura dados. Al terminar, moveEnd llama a
  // alSoltarCamara, que decide solo si toca modo calle o modo aéreo.
  function volarA(lat, lon, altura) {
    volando = true; // hasta que moveEnd confirme el final del vuelo
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, groundH + altura),
      orientation: { heading: 0, pitch: rad(-90), roll: 0 },
      duration: 2.5
    });
  }

  function mirarCalle(lat, lon, heading, pitch) {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, groundH + EYE),
      orientation: { heading: rad(heading), pitch: rad(pitch), roll: 0 }
    });
  }

  function vistaCalle() {
    modoCalle = true;
    if (capaAereaInst) capaAereaInst.show = false;
    var bm = document.getElementById('btn-modo');
    if (bm) bm.textContent = 'Subir al mapa';
    volando = true; // hasta que moveEnd confirme el aterrizaje del flyTo
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(centro.lon, centro.lat, groundH + EYE),
      orientation: { heading: 0, pitch: rad(18), roll: 0 },
      duration: 2.0
    });
    actualizarLectura();
  }

  // =========================================================================
  // Terreno y edificios
  // =========================================================================
  function claveLugar(lat, lon) { return lat.toFixed(3) + ',' + lon.toFixed(3); }

  function cargarElevacion(lat, lon) {
    var clave = claveLugar(lat, lon);
    if (cacheElevacion[clave] !== undefined) {
      groundH = cacheElevacion[clave];
      return Promise.resolve();
    }
    try {
      var crudo = localStorage.getItem('mn-elev-v1-' + clave);
      if (crudo !== null && isFinite(Number(crudo))) {
        groundH = Number(crudo);
        cacheElevacion[clave] = groundH;
        return Promise.resolve();
      }
    } catch (e0) {}
    return fetch('https://api.open-meteo.com/v1/elevation?latitude=' +
      lat.toFixed(5) + '&longitude=' + lon.toFixed(5))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        // la API puede devolver el valor como texto, forzamos número
        var e = j ? Number(j.elevation) : NaN;
        groundH = isFinite(e) ? e : 0;
        cacheElevacion[clave] = groundH;
        try { localStorage.setItem('mn-elev-v1-' + clave, String(groundH)); } catch (e1) {}
      })
      .catch(function () { groundH = 0; cacheElevacion[clave] = 0; });
  }

  function alturaDeEdificio(tags) {
    var h = NaN;
    if (tags.height) h = parseFloat(String(tags.height).replace(',', '.'));
    if (!isFinite(h) && tags['building:levels']) {
      var n = parseFloat(tags['building:levels']);
      if (isFinite(n)) h = n * 3.0;
    }
    if (!isFinite(h)) h = 10.0;
    return clamp(h, 4, 120);
  }

  // Indice 0 = intento directo al espejo suizo. Indices 1..n = relé
  // allorigins sobre la lista de reserva (su CORS cubre también errores,
  // así un espejo saturado no deja bloqueos CORS en consola). Los fallos
  // de datos se detectan por parseo del JSON.
  function consultarOverpass(query, indice) {
    var url;
    if (indice === 0) {
      url = OVERPASS_DIRECTO + '?data=' + encodeURIComponent(query);
    } else {
      var k = indice - 1;
      if (k >= OVERPASS_RESERVA.length) return Promise.resolve(null);
      url = 'https://api.allorigins.win/raw?url=' +
        encodeURIComponent(OVERPASS_RESERVA[k] + '?data=' + encodeURIComponent(query));
    }
    return fetch(url)
      .then(function (r) {
        if (!r.ok) return consultarOverpass(query, indice + 1);
        return r.json().then(function (j) {
          if (j && j.elements) return j;
          return consultarOverpass(query, indice + 1);
        }, function () { return consultarOverpass(query, indice + 1); });
      }, function () { return consultarOverpass(query, indice + 1); });
  }

  // Filtrado puro de la respuesta Overpass: devuelve [{coords, altura}]
  function filtraEdificios(j) {
    var lista = [];
    if (!j || !j.elements) return lista;
    for (var i = 0; i < j.elements.length; i++) {
      var w = j.elements[i];
      if (w.type !== 'way' || !w.geometry || w.geometry.length < 4) continue;
      var coords = [];
      for (var k = 0; k < w.geometry.length; k++) {
        var gk = w.geometry[k];
        var ult = coords.length - 1;
        if (ult >= 0 && coords[ult][0] === gk.lon && coords[ult][1] === gk.lat) continue;
        coords.push([gk.lon, gk.lat]);
      }
      if (coords.length >= 2 &&
          coords[0][0] === coords[coords.length - 1][0] &&
          coords[0][1] === coords[coords.length - 1][1]) coords.pop();
      if (coords.length < 3) continue;
      var area2 = 0, mx = 0, my = 0, m;
      for (m = 0; m < coords.length; m++) {
        var p1 = coords[m], p2 = coords[(m + 1) % coords.length];
        area2 += (p1[0] * p2[1] - p2[0] * p1[1]);
        mx += coords[m][0]; my += coords[m][1];
      }
      mx /= coords.length; my /= coords.length;
      var mLon = 111320 * Math.cos(rad(my));
      var area = Math.abs(area2) * 0.5 * mLon * 110540;
      if (!isFinite(area) || area < AREA_MINIMA_M2) continue;
      var perimetro = 0;
      for (m = 0; m < coords.length; m++) {
        var q1 = coords[m], q2 = coords[(m + 1) % coords.length];
        var dl = (q2[0] - q1[0]) * mLon, db = (q2[1] - q1[1]) * 110540;
        perimetro += Math.sqrt(dl * dl + db * db);
      }
      if (area / (perimetro * perimetro + 1e-9) < 0.02) continue;
      lista.push({ coords: coords, altura: alturaDeEdificio(w.tags || {}) });
    }
    return lista;
  }

  function construirEdificios(lat, lon, lista) {
    if (edificiosPrimitive) {
      viewer.scene.primitives.remove(edificiosPrimitive);
      edificiosPrimitive = null;
    }
    ultimoCentroEdificios = { lat: lat, lon: lon };
    if (!lista.length) return;
    var base = groundH + 0.3;
    var instancias = [];
    for (var i = 0; i < lista.length; i++) {
      var anillo = lista[i].coords;
      var pos = [];
      for (var k = 0; k < anillo.length; k++) {
        pos.push(Cesium.Cartesian3.fromDegrees(anillo[k][0], anillo[k][1], base));
      }
      instancias.push(new Cesium.GeometryInstance({
        geometry: new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(pos),
          height: base,
          extrudedHeight: base + lista[i].altura,
          vertexFormat:
            Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat
        })
      }));
    }
    edificiosPrimitive = viewer.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: instancias,
      appearance: new Cesium.MaterialAppearance({
        material: Cesium.Material.fromType('Color', {
          color: Cesium.Color.fromCssColorString('#8f8a83')
        }),
        flat: false,
        translucent: false,
        face: Cesium.MaterialAppearance.MaterialSupport.BASIC.face
      }),
      asynchronous: false
    }));
  }

  function guardaCacheEdificios(clave, lista) {
    if (cacheEdificios[clave] !== undefined) return;
    ordenCacheEdificios.push(clave);
    if (ordenCacheEdificios.length > 6) {
      delete cacheEdificios[ordenCacheEdificios.shift()];
    }
    cacheEdificios[clave] = lista;
    // persistencia para recargas y uso repetido de la misma ciudad
    try { localStorage.setItem('mn-edif-v1-' + clave, JSON.stringify(lista)); } catch (e0) {}
  }

  function leeCacheEdificios(clave) {
    if (cacheEdificios[clave] !== undefined) return cacheEdificios[clave];
    try {
      var crudo = localStorage.getItem('mn-edif-v1-' + clave);
      if (crudo === null) return undefined;
      var lista = JSON.parse(crudo);
      if (!Array.isArray(lista)) return undefined;
      cacheEdificios[clave] = lista;
      return lista;
    } catch (e1) { return undefined; }
  }

  function cargarEdificios(lat, lon) {
    var clave = claveLugar(lat, lon);
    var cacheada = leeCacheEdificios(clave);
    if (cacheada !== undefined) {
      construirEdificios(lat, lon, cacheada);
      return Promise.resolve();
    }
    fijarEstado('Cargando edificios cercanos');
    var query = '[out:json];way["building"](around:' + RADIO_EDIFICIOS + ',' +
      lat.toFixed(6) + ',' + lon.toFixed(6) + ');out geom ' + MAX_EDIFICIOS + ';';
    return consultarOverpass(query, 0).then(function (j) {
      var lista = filtraEdificios(j);
      guardaCacheEdificios(clave, lista);
      construirEdificios(lat, lon, lista);
    });
  }

  // =========================================================================
  // Primitiva de la nube
  // =========================================================================
  function crearNube(res) {
    if (nubePrimitive) {
      viewer.scene.primitives.remove(nubePrimitive);
      nubePrimitive = null;
    }
    var pos = res.pos;
    var normales = [];
    var plano = [];
    for (var ni = 0; ni < pos.length; ni++) {
      var n = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(pos[ni]);
      normales.push(n.x, n.y, n.z);
      plano.push(pos[ni].x, pos[ni].y, pos[ni].z);
    }
    var geometria = new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3,
          values: new Float64Array(plano)
        }),
        st: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 2,
          values: new Float32Array(res.st)
        }),
        normal: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          values: new Float32Array(normales)
        })
      },
      indices: new Uint16Array(res.indices),
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: Cesium.BoundingSphere.fromPoints(pos)
    });
    var apariencia = new Cesium.MaterialAppearance({
      material: Cesium.Material.fromType('Image', {
        image: res.canvas.toDataURL('image/png')
      }),
      flat: true,
      translucent: true,
      face: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.face,
      vertexFormat:
        Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      renderState: {
        depthTest: { enabled: true },
        depthMask: false,
        blending: Cesium.BlendingState.ALPHA_BLEND,
        cull: { enabled: false }
      }
    });
    nubePrimitive = viewer.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry: geometria }),
      appearance: apariencia,
      asynchronous: false,
      releaseGeometryInstances: false
    }));
    nubePrimitive.show = modoCalle;
  }

  // =========================================================================
  // Capa aérea GIBS (misma capa que la textura de calle, misma foto)
  // =========================================================================
  function aseguraCapaAerea() {
    if (!capaAereaInst) {
      var plantilla = GIBS_BASE + '/' + CAPA_SATELITE +
        '/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpeg';
      var proveedor = new Cesium.WebMapTileServiceImageryProvider({
        url: plantilla,
        layer: CAPA_SATELITE,
        style: 'default',
        format: 'image/jpeg',
        tileMatrixSetID: MATRIX_SET,
        tileMatrixLabels: ['0', '1', '2', '3', '4', '5', '6', '7', '8'],
        dimensions: { Time: 'default', TileMatrixSet: MATRIX_SET },
        tilingScheme: new Cesium.GeographicTilingScheme(),
        maximumLevel: 8
      });
      proveedor.errorEvent.addEventListener(function () { return true; });
      capaAereaInst = new Cesium.ImageryLayer(proveedor, { alpha: 0.65 });
      viewer.imageryLayers.add(capaAereaInst, 1);
    }
    elFecha.textContent =
      'Satélite MODIS Terra · imagen más reciente de GIBS · la misma foto en calle y en mapa';
  }

  // =========================================================================
  // Recálculo de la nube con política antirruido
  // =========================================================================
  function recalcularNube(forzar) {
    if (!modoCalle || pidiendo) return;
    var cam = viewer.camera;
    var heading = normaliza(deg(cam.heading));
    var pitch = clamp(deg(cam.pitch), PITCH_MIN, PITCH_MAX);
    var pos = cam.positionCartographic;
    if (pos && !volando) {
      // solo se adopta la posicion de la camara cuando no hay vuelo en curso,
      // si no el recalculo se haria sobre un punto intermedio del trayecto
      centro.lat = deg(pos.latitude);
      centro.lon = deg(pos.longitude);
    }
    var clave = [centro.lat.toFixed(4), centro.lon.toFixed(4),
                 heading.toFixed(1), pitch.toFixed(1), altitudNube].join('|');
    if (!forzar && ultimoPeticion === clave) return;
    ultimoPeticion = clave;
    pidiendo = true;
    recalcs++;
    fijarCargando(true);
    calcularTextura(centro.lat, centro.lon, heading, pitch)
      .then(function (res) {
        crearNube(res);
        actualizarLectura();
        fijarEstado('Nube real a ' + Math.round(res.alt).toLocaleString('es-ES') +
          ' m · imagen más reciente del satélite');
      })
      .catch(function (err) {
        if (err && err.message === 'mira-arriba') {
          fijarEstado('Inclina la vista hacia el cielo para ver la nube');
        } else if (err && err.message === 'sin-imagen') {
          // GIBS no responde desde esta red: se dice claro y se ofrece el mapa
          fijarEstado('No llegan las imagenes del satelite desde tu red, muestro el mapa');
          vistaAerea();
        } else {
          fijarEstado('No pude generar la textura de nube ahora mismo');
        }
        ultimoPeticion = null;
      })
      .then(function () {
        pidiendo = false;
        fijarCargando(false);
      });
  }

  function alSoltarCamara() {
    volando = false; // la cámara se detuvo: fin de flyTo o de arrastre
    var pos = viewer.camera.positionCartographic;
    if (!pos) return;
    var hSobreSuelo = pos.height - groundH;
    if (!modoCalle && hSobreSuelo < UMBRAL_ENTRADA_CALLE) {
      // El usuario bajó con la rueda hasta el suelo: la calle se activa
      // donde está, sin botones. Se adopta la posición de la cámara como
      // centro y se pone la vista a altura de ojo mirando hacia arriba.
      // La elevación se recarga antes de fijar la cámara, por si llegó
      // arrastrando el mapa desde un lugar con otra altura del terreno.
      centro.lat = deg(pos.latitude);
      centro.lon = deg(pos.longitude);
      modoCalle = true;
      if (capaAereaInst) capaAereaInst.show = false;
      if (nubePrimitive) nubePrimitive.show = true;
      var hEntrada = normaliza(deg(viewer.camera.heading));
      mirarCalle(centro.lat, centro.lon, hEntrada, PITCH_ENTRADA);
      ultimoPeticion = null;
      fijarEstado('A pie de calle · calculando la nube de este punto');
      cargarElevacion(centro.lat, centro.lon)
        .catch(function () {})
        .then(function () {
          if (!modoCalle) return; // ya volvió a subir con la rueda
          mirarCalle(centro.lat, centro.lon, hEntrada, PITCH_ENTRADA);
          cargarEdificios(centro.lat, centro.lon);
          ultimoPeticion = null;
          recalcularNube(true);
          actualizarLectura();
        });
      actualizarLectura();
      return;
    }
    if (modoCalle && hSobreSuelo > UMBRAL_SALIDA_CALLE) {
      // El usuario subió con la rueda: vuelve el mapa con la capa de
      // nubes del satélite, la escena continúa sin cortes.
      modoCalle = false;
      if (nubePrimitive) nubePrimitive.show = false;
      if (capaAereaInst) capaAereaInst.show = true;
      fijarEstado('Vista aérea con las mismas nubes · baja con la rueda hasta la calle');
      actualizarLectura();
      return;
    }
    if (!modoCalle) return;
    if (pos.height < groundH + 1.2 || deg(viewer.camera.pitch) < PITCH_MIN) {
      // Si la cámara quedó bajo el suelo o mirando hacia abajo (tras un
      // vuelo o un zoom fuerte), se recoloca a altura de ojo mirando arriba.
      mirarCalle(centro.lat, centro.lon,
        normaliza(deg(viewer.camera.heading)), PITCH_ENTRADA);
    }
    if (ultimoCentroEdificios) {
      var dLat = centro.lat - ultimoCentroEdificios.lat;
      var dLon = centro.lon - ultimoCentroEdificios.lon;
      if (Math.sqrt(dLat * dLat + dLon * dLon) * 111320 > 150) {
        cargarEdificios(centro.lat, centro.lon);
      }
    }
    actualizarLectura();
    if (esperaTimer) clearTimeout(esperaTimer);
    esperaTimer = setTimeout(function () { recalcularNube(false); }, 900);
  }

  // =========================================================================
  // Controles
  // =========================================================================
  function girar(dh, dp) {
    var cam = viewer.camera;
    var h = normaliza(deg(cam.heading) + dh);
    if (modoCalle) {
      var p = clamp(deg(cam.pitch) + dp, PITCH_MIN, PITCH_MAX);
      mirarCalle(centro.lat, centro.lon, h, p);
      if (esperaTimer) clearTimeout(esperaTimer);
      esperaTimer = setTimeout(function () { recalcularNube(false); }, 450);
    } else {
      // en el aire las flechas tambien responden: giran la brujula e inclinan
      // la camara hacia el horizonte para ver el relieve en 3D
      var pa = clamp(deg(cam.pitch) + dp, -90, -15);
      viewer.camera.setView({
        destination: cam.position,
        orientation: { heading: rad(h), pitch: rad(pa), roll: 0 }
      });
    }
    actualizarLectura();
  }

  function initControles() {
    // El panel se puede cerrar con la × y reabrir con el botón flotante.
    var elPanel = document.getElementById('panel');
    var elBtnAbrir = document.getElementById('btn-abrir');
    document.getElementById('btn-cerrar').addEventListener('click', function () {
      elPanel.classList.add('oculto');
      elBtnAbrir.classList.add('visible');
    });
    elBtnAbrir.addEventListener('click', function () {
      elPanel.classList.remove('oculto');
      elBtnAbrir.classList.remove('visible');
    });
    // El botón de modo ya no se muestra: la transición aérea/calle es
    // automática por altura. Se conserva el manejador por si el elemento
    // vuelve algún día al HTML.
    var btnModo = document.getElementById('btn-modo');
    if (btnModo) btnModo.addEventListener('click', function () {
      if (modoCalle) {
        vistaAerea();
        fijarEstado('Mapa con las mismas nubes · pulsa Bajar a la calle');
      } else {
        vistaCalle();
      }
    });
    document.getElementById('btn-recalcular').addEventListener('click', function () {
      ultimoPeticion = null;
      recalcularNube(true);
    });
    document.getElementById('btn-posicion').addEventListener('click', function () {
      if (!navigator.geolocation) {
        fijarEstado('Tu navegador no da geolocalización');
        return;
      }
      fijarEstado('Buscando tu posición');
      navigator.geolocation.getCurrentPosition(function (pos) {
        centro.lat = pos.coords.latitude;
        centro.lon = pos.coords.longitude;
        ultimoCentroEdificios = null;
        cargarElevacion(centro.lat, centro.lon).then(function () {
          return cargarEdificios(centro.lat, centro.lon);
        }).then(function () {
          // Vuelo directo a pie de calle: al aterrizar, alSoltarCamara
          // activa el modo calle y calcula la nube de ese punto.
          volarA(centro.lat, centro.lon, 120);
        });
      }, function () {
        fijarEstado('No pude obtener tu posición');
      }, { timeout: 10000 });
    });
    document.getElementById('sel-ciudad').addEventListener('change', function () {
      var partes = this.value.split(',');
      var nuevaLat = parseFloat(partes[0]);
      var nuevaLon = parseFloat(partes[1]);
      if (!isFinite(nuevaLat) || !isFinite(nuevaLon)) return;
      centro.lat = nuevaLat;
      centro.lon = nuevaLon;
      ultimoCentroEdificios = null;
      ultimoPeticion = null;
      fijarEstado('Cargando ' + this.options[this.selectedIndex].text);
      cargarElevacion(centro.lat, centro.lon)
        .then(function () { return cargarEdificios(centro.lat, centro.lon); })
        .catch(function () {})
        .then(function () {
          // Vuelo a vista de barrio: con un giro de rueda más se entra
          // en la calle y la transición automática hace el resto.
          volarA(centro.lat, centro.lon, 600);
          fijarEstado('Nubes reales del satélite sobre ' +
            document.getElementById('sel-ciudad').options[
              document.getElementById('sel-ciudad').selectedIndex].text +
            ' · baja con la rueda hasta la calle');
        });
    });
    var slider = document.getElementById('slider-alt');
    slider.addEventListener('input', function () {
      altitudNube = parseInt(slider.value, 10);
      elAltValor.textContent = altitudNube.toLocaleString('es-ES');
    });
    slider.addEventListener('change', function () {
      if (!modoCalle) {
        fijarEstado('Altitud guardada, se aplica al bajar a la calle');
      }
      ultimoPeticion = null;
      recalcularNube(true);
    });
    document.addEventListener('keydown', function (ev) {
      var usada = true;
      switch (ev.key) {
        case 'ArrowLeft': girar(-5, 0); break;
        case 'ArrowRight': girar(5, 0); break;
        case 'ArrowUp': girar(0, 4); break;
        case 'ArrowDown': girar(0, -4); break;
        case 'PageUp':
          altitudNube = clamp(altitudNube + 100, 1200, 3000);
          slider.value = altitudNube;
          elAltValor.textContent = altitudNube.toLocaleString('es-ES');
          if (!modoCalle) {
            fijarEstado('Altitud guardada, se aplica al bajar a la calle');
          }
          ultimoPeticion = null; recalcularNube(true);
          break;
        case 'PageDown':
          altitudNube = clamp(altitudNube - 100, 1200, 3000);
          slider.value = altitudNube;
          elAltValor.textContent = altitudNube.toLocaleString('es-ES');
          if (!modoCalle) {
            fijarEstado('Altitud guardada, se aplica al bajar a la calle');
          }
          ultimoPeticion = null; recalcularNube(true);
          break;
        default: usada = false;
      }
      if (usada) ev.preventDefault();
    });
  }

  // =========================================================================
  // Arranque: el globo entero con la capa de nubes del satélite ya puesta.
  // La navegación es libre (arrastrar, rueda, inclinar) y al bajar hasta
  // el suelo la calle se activa sola, con edificios 3D y la nube arriba.
  // =========================================================================
  function arrancar() {
    initViewer();
    initControles();
    aseguraCapaAerea();
    vistaAerea(ALT_GLOBAL);
    fijarEstado('Cargando la elevacion del terreno');
    cargarElevacion(centro.lat, centro.lon)
      .catch(function () {})
      .then(function () {
        fijarEstado('Cargando edificios cercanos');
        return cargarEdificios(centro.lat, centro.lon);
      })
      .catch(function () {})
      .then(function () {
        fijarEstado('Mapa global con las nubes del satélite · baja con la rueda hasta la calle y mira arriba');
      });
  }

  if (typeof Cesium === 'undefined') {
    fijarEstado('No cargó Cesium desde su CDN. Revisa la conexión.');
    return;
  }
  try {
    arrancar();
  } catch (e) {
    elEstado.dataset.error = String(e && e.message ? e.message : e);
    fijarEstado('No se pudo iniciar el visor 3D');
  }
})();
