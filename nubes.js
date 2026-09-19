/* Manolit∞ Nubes — visor de nubes reales a nivel de calle.
 * CesiumJS + textura recortada del backend (NASA GIBS) proyectada sobre un
 * plano georreferenciado a ~2.000 m. La oclusión la hace el depth-buffer
 * nativo contra edificios OSM 3D (Overpass) extruidos.
 *
 * Sandro. Licencia AGPL-3.0. Sin dependencias de pago y sin tokens.
 */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Configuración
  // -------------------------------------------------------------------------
  var HOME = { lat: 37.39651, lon: -5.99347 }; // Alameda de Hércules, Sevilla
  var EYE = 1.7;                              // altura del ojo, en metros
  var FOVH = 60.0;                            // campo horizontal, grados
  var PITCH_MIN = 25.0;                       // mínimo sobre el horizonte
  var ALTA_ALT = 14000;                       // altitud de la vista aérea
  var AREA_MINIMA_M2 = 30;                    // filtra polígonos degenerados

  var viewer = null;
  var groundH = 0;
  var centro = { lat: HOME.lat, lon: HOME.lon };
  var ultimoCentroEdificios = null;
  var sessionTime = null;   // fecha GIBS usada, para no mezclar timestamps
  var sessionLayer = null;  // capa GIBS usada
  var capaAereaInst = null;
  var nubePrimitive = null;
  var edificiosPrimitive = null;
  var esperaNubes = null;
  var pidiendoNubes = false;
  var listo = false;
  var modoCalle = true;

  var elEstado = document.getElementById('estado');
  var elCargando = document.getElementById('cargando');

  function fijarEstado(txt) {
    elEstado.textContent = txt;
  }

  function fijarCargando(on) {
    elCargando.classList.toggle('visible', !!on);
  }

  function grados(rad) {
    return Cesium.Math.toDegrees(rad);
  }

  function normalizarGrados(g) {
    g = g % 360;
    return g < 0 ? g + 360 : g;
  }

  function fechaBonita(iso) {
    try {
      var d = new Date(iso + 'T00:00:00Z');
      return d.toLocaleDateString('es-ES', {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
      });
    } catch (e) {
      return iso;
    }
  }

  // -------------------------------------------------------------------------
  // Visor
  // -------------------------------------------------------------------------
  function init() {
    var provBase = new Cesium.WebMapTileServiceImageryProvider({
      url: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/' +
        'BlueMarble_NextGeneration/default/500m/{TileMatrix}/' +
        '{TileRow}/{TileCol}.jpeg',
      layer: 'BlueMarble_NextGeneration',
      style: 'default',
      format: 'image/jpeg',
      tileMatrixSetID: '500m',
      tileMatrixLabels: ['0', '1', '2', '3', '4', '5', '6', '7'],
      tilingScheme: new Cesium.GeographicTilingScheme(),
      maximumLevel: 7,
      credit: 'NASA GIBS Blue Marble'
    });
    provBase.errorEvent.addEventListener(function () {
      return true; // sin ruido en consola si una tesela falla
    });
    var capaBase = new Cesium.ImageryLayer(provBase);

    viewer = new Cesium.Viewer('cesiumContainer', {
      baseLayer: capaBase,
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
    viewer.camera.percentageChanged = 0.03;
    viewer.camera.frustum.fov = Cesium.Math.toRadians(FOVH);
    viewer.camera.moveEnd.addEventListener(alMoverCamara);

    document.getElementById('btn-posicion')
      .addEventListener('click', irAMiPosicion);
    document.getElementById('btn-aerea')
      .addEventListener('click', vistaAerea);
    document.getElementById('btn-calle')
      .addEventListener('click', vistaCalle);

    mirarCalle(centro.lat, centro.lon, 0, 55);
    arrancarEn(centro.lat, centro.lon);
  }

  function mirarCalle(lat, lon, heading, pitch) {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        lon, lat, groundH + EYE),
      orientation: {
        heading: Cesium.Math.toRadians(heading),
        pitch: Cesium.Math.toRadians(pitch),
        roll: 0
      }
    });
  }

  function arrancarEn(lat, lon) {
    listo = false;
    fijarEstado('Cargando terreno y edificios');
    cargarElevacion(lat, lon)
      .then(function () { return cargarEdificios(lat, lon); })
      .then(function () {
        mirarCalle(lat, lon, 0, 45);
        listo = true;
        pedirNubes();
      })
      .catch(function () {
        // Los fallos parciales ya dejan su mensaje en pantalla
        listo = true;
        pedirNubes();
      });
  }

  // -------------------------------------------------------------------------
  // Terreno real (elevación del suelo, servicio gratuito sin clave)
  // -------------------------------------------------------------------------
  function cargarElevacion(lat, lon) {
    return fetch('/elevation?lat=' + lat.toFixed(5) +
      '&lon=' + lon.toFixed(5))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        groundH = (j && isFinite(j.elevation)) ? j.elevation : 0;
      })
      .catch(function () { groundH = 0; });
  }

  // -------------------------------------------------------------------------
  // Edificios OSM 3D reales (Overpass, extruidos con su altura)
  // -------------------------------------------------------------------------
  function alturaDeEdificio(tags) {
    var h = NaN;
    if (tags.height) {
      h = parseFloat(String(tags.height).replace(',', '.'));
    }
    if (!isFinite(h) && tags['building:levels']) {
      var n = parseFloat(tags['building:levels']);
      if (isFinite(n)) h = n * 3.0;
    }
    if (!isFinite(h)) h = 10.0;
    return Math.min(120, Math.max(4, h));
  }

  function cargarEdificios(lat, lon) {
    return fetch('/overpass?lat=' + lat.toFixed(6) +
      '&lon=' + lon.toFixed(6))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.ok === false) j = null;
        if (!viewer) return;
        if (edificiosPrimitive) {
          viewer.scene.primitives.remove(edificiosPrimitive);
          edificiosPrimitive = null;
        }
        if (!j || !j.elements) {
          fijarEstado('Sin edificios OSM en esta zona');
          return;
        }
        var base = groundH + 0.3;
        var instancias = [];
        for (var i = 0; i < j.elements.length; i++) {
          var w = j.elements[i];
          if (w.type !== 'way' || !w.geometry || w.geometry.length < 4) {
            continue;
          }
          var coords = [];
          for (var k = 0; k < w.geometry.length; k++) {
            var gk = w.geometry[k];
            var ult = coords.length - 1;
            if (ult >= 0 && coords[ult][0] === gk.lon &&
                coords[ult][1] === gk.lat) {
              continue; // puntos repetidos consecutivos
            }
            coords.push([gk.lon, gk.lat]);
          }
          if (coords.length >= 2 &&
              coords[0][0] === coords[coords.length - 1][0] &&
              coords[0][1] === coords[coords.length - 1][1]) {
            coords.pop(); // cierra el anillo, PolygonGeometry lo cierra solo
          }
          if (coords.length < 3) continue;
          // área con fórmula del shoelace (aprox. plana local)
          var area2 = 0;
          for (var m = 0; m < coords.length; m++) {
            var p1 = coords[m];
            var p2 = coords[(m + 1) % coords.length];
            area2 += (p1[0] * p2[1] - p2[0] * p1[1]);
          }
          var mx = 0, my = 0;
          for (var m2 = 0; m2 < coords.length; m2++) {
            mx += coords[m2][0]; my += coords[m2][1];
          }
          mx /= coords.length; my /= coords.length;
          var metrosPorGradoLon = 111320 * Math.cos(my * Math.PI / 180);
          var metrosPorGradoLat = 110540;
          var area = Math.abs(area2) * 0.5 * metrosPorGradoLon * metrosPorGradoLat;
          if (!isFinite(area) || area < AREA_MINIMA_M2) continue;
          // rechaza flecos alargados (muros, restos de polígonos)
          var perimetro = 0;
          for (var m3 = 0; m3 < coords.length; m3++) {
            var q1 = coords[m3];
            var q2 = coords[(m3 + 1) % coords.length];
            var dl = (q2[0] - q1[0]) * metrosPorGradoLon;
            var db = (q2[1] - q1[1]) * metrosPorGradoLat;
            perimetro += Math.sqrt(dl * dl + db * db);
          }
          var compacidad = area / (perimetro * perimetro + 1e-9);
          if (compacidad < 0.02) continue;
          var pos = [];
          for (var k3 = 0; k3 < coords.length; k3++) {
            pos.push(Cesium.Cartesian3.fromDegrees(
              coords[k3][0], coords[k3][1], base));
          }
          var altura = alturaDeEdificio(w.tags || {});
          instancias.push(new Cesium.GeometryInstance({
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: new Cesium.PolygonHierarchy(pos),
              height: base,
              extrudedHeight: base + altura,
              vertexFormat:
                Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat
            })
          }));
        }
        if (!instancias.length) return;
        edificiosPrimitive = viewer.scene.primitives.add(
          new Cesium.Primitive({
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
          })
        );
        ultimoCentroEdificios = { lat: lat, lon: lon };
      })
      .catch(function () {
        // Overpass puede saturarse; se reintenta al mover la cámara
        ultimoCentroEdificios = null;
      });
  }

  // -------------------------------------------------------------------------
  // Nube: textura exacta del backend sobre el cuadrilátero georreferenciado
  // -------------------------------------------------------------------------
  function aspectoCanvas() {
    var c = viewer.canvas;
    var a = c.clientWidth / Math.max(1, c.clientHeight);
    return Math.min(6, Math.max(0.2, a));
  }

  function pedirNubes() {
    if (!listo || pidiendoNubes) return;
    pidiendoNubes = true;
    fijarCargando(true);

    var cam = viewer.camera;
    var heading = normalizarGrados(grados(cam.heading));
    var pitch = Math.min(89, Math.max(PITCH_MIN, grados(cam.pitch)));

    var params = 'lat=' + centro.lat.toFixed(6) +
      '&lon=' + centro.lon.toFixed(6) +
      '&heading=' + heading.toFixed(2) +
      '&pitch=' + pitch.toFixed(2) +
      '&fovH=' + FOVH +
      '&aspect=' + aspectoCanvas().toFixed(3);
    if (sessionTime) params += '&time=' + encodeURIComponent(sessionTime);

    fetch('/clouds?' + params)
      .then(function (r) { return r.json(); })
      .then(function (resp) {
        if (!resp || resp.ok !== true) {
          fijarEstado(resp && resp.message
            ? resp.message
            : 'No se pudo generar la textura de nubes');
          return;
        }
        sessionTime = resp.time;
        sessionLayer = resp.layer;
        crearNube(resp);
        actualizarCapaAerea();
        var nombre = sessionLayer.indexOf('Aqua') !== -1
          ? 'MODIS Aqua' : 'MODIS Terra';
        fijarEstado(
          'Nubes reales del ' + fechaBonita(sessionTime) +
          ' · ' + nombre + ' · banda a ' +
          Math.round(resp.cloudAlt).toLocaleString('es-ES') + ' m'
        );
      })
      .catch(function () {
        fijarEstado('El backend no responde. ¿Arrancaste python app.py?');
      })
      .then(function () {
        pidiendoNubes = false;
        fijarCargando(false);
      });
  }

  function crearNube(resp) {
    var img = new Image();
    img.onload = function () {
      if (!viewer) return;
      if (nubePrimitive) {
        viewer.scene.primitives.remove(nubePrimitive);
        nubePrimitive = null;
      }
      var absH = groundH + EYE + resp.cloudAlt;
      var c = resp.corners;
      // Orden TL, TR, BR, BL tal como viene de la homografía del backend
      var pos = [
        Cesium.Cartesian3.fromDegrees(c.tl[0], c.tl[1], absH),
        Cesium.Cartesian3.fromDegrees(c.tr[0], c.tr[1], absH),
        Cesium.Cartesian3.fromDegrees(c.br[0], c.br[1], absH),
        Cesium.Cartesian3.fromDegrees(c.bl[0], c.bl[1], absH)
      ];
      // La textura se sube con v=0 en la fila inferior de la imagen
      var st = new Float32Array([
        0, 1,
        1, 1,
        1, 0,
        0, 0
      ]);
      var normales = [];
      for (var ni = 0; ni < 4; ni++) {
        var nrm = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(pos[ni]);
        normales.push(nrm.x, nrm.y, nrm.z);
      }
      var geometria = new Cesium.Geometry({
        attributes: {
          position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: new Float64Array([
              pos[0].x, pos[0].y, pos[0].z,
              pos[1].x, pos[1].y, pos[1].z,
              pos[2].x, pos[2].y, pos[2].z,
              pos[3].x, pos[3].y, pos[3].z
            ])
          }),
          st: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 2,
            values: st
          }),
          normal: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 3,
            values: new Float32Array(normales)
          })
        },
        // Sentido invertido: la cara visible mira hacia el suelo
        indices: new Uint16Array([0, 2, 1, 0, 3, 2]),
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: Cesium.BoundingSphere.fromPoints(pos)
      });

      var apariencia = new Cesium.MaterialAppearance({
        material: Cesium.Material.fromType('Image', { image: img }),
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
        geometryInstances: new Cesium.GeometryInstance({
          geometry: geometria
        }),
        appearance: apariencia,
        asynchronous: false,
        releaseGeometryInstances: false
      }));
    };
    img.onerror = function () {
      fijarEstado('No se pudo cargar la textura de nubes');
    };
    img.src = resp.texture;
  }

  // -------------------------------------------------------------------------
  // Vista aérea con la MISMA capa y fecha (coherencia verificable)
  // -------------------------------------------------------------------------
  function actualizarCapaAerea() {
    if (!sessionLayer || !sessionTime) return;
    if (!capaAereaInst) {
      var plantilla = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/' +
        sessionLayer +
        '/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpeg';
      var proveedor = new Cesium.WebMapTileServiceImageryProvider({
        url: plantilla,
        layer: sessionLayer,
        style: 'default',
        format: 'image/jpeg',
        tileMatrixSetID: '250m',
        tileMatrixLabels: ['0', '1', '2', '3', '4', '5', '6', '7', '8'],
        dimensions: { Time: sessionTime, TileMatrixSet: '250m' },
        tilingScheme: new Cesium.GeographicTilingScheme(),
        maximumLevel: 8
      });
      proveedor.errorEvent.addEventListener(function () { return true; });
      capaAereaInst = viewer.imageryLayers.add(
        new Cesium.ImageryLayer(proveedor, { alpha: 0.9 }));
    }
  }

  function vistaAerea() {
    if (!viewer) return;
    modoCalle = false;
    if (nubePrimitive) nubePrimitive.show = false;
    actualizarCapaAerea();
    if (capaAereaInst) capaAereaInst.show = true;
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        centro.lon, centro.lat, groundH + ALTA_ALT),
      orientation: {
        heading: 0,
        pitch: Cesium.Math.toRadians(-90),
        roll: 0
      }
    });
  }

  function vistaCalle() {
    if (!viewer) return;
    modoCalle = true;
    if (capaAereaInst) capaAereaInst.show = false;
    if (nubePrimitive) nubePrimitive.show = true;
    mirarCalle(centro.lat, centro.lon, 0, 55);
    pedirNubes();
  }

  // -------------------------------------------------------------------------
  // Interacción
  // -------------------------------------------------------------------------
  function alMoverCamara() {
    if (!listo) return;
    var cam = viewer.camera;
    var pos = cam.positionCartographic;
    if (!pos) return;
    centro.lat = Cesium.Math.toDegrees(pos.latitude);
    centro.lon = Cesium.Math.toDegrees(pos.longitude);

    if (ultimoCentroEdificios) {
      var dLat = centro.lat - ultimoCentroEdificios.lat;
      var dLon = centro.lon - ultimoCentroEdificios.lon;
      var distancia = Math.sqrt(dLat * dLat + dLon * dLon) * 111320;
      if (distancia > 150) cargarEdificios(centro.lat, centro.lon);
    }

    if (!modoCalle) return;
    if (esperaNubes) clearTimeout(esperaNubes);
    esperaNubes = setTimeout(pedirNubes, 700);
  }

  function irAMiPosicion() {
    if (!navigator.geolocation) {
      fijarEstado('Tu navegador no da geolocalización');
      return;
    }
    fijarEstado('Buscando tu posición');
    navigator.geolocation.getCurrentPosition(function (pos) {
      centro.lat = pos.coords.latitude;
      centro.lon = pos.coords.longitude;
      ultimoCentroEdificios = null;
      sessionTime = null;
      sessionLayer = null;
      arrancarEn(centro.lat, centro.lon);
    }, function () {
      fijarEstado('No pude obtener tu posición');
    }, { timeout: 10000 });
  }

  // -------------------------------------------------------------------------
  // Arranque
  // -------------------------------------------------------------------------
  try {
    init();
  } catch (e) {
    elEstado.dataset.error = String(e && e.message ? e.message : e);
    fijarEstado('No se pudo iniciar el visor 3D');
  }
})();