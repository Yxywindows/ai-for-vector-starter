import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mapSVG } from "./map.mjs";
const normals = {
  projects: [0, 0, 1],
  data: [1, 0, 0],
  analysis: [0, 0, -1],
  tasks: [-1, 0, 0],
  exports: [0, 1, 0],
  overview: [0, -1, 0],
};
const clamp = (x) => Math.max(0, Math.min(1, x)),
  smooth = (x) => {
    x = clamp(x);
    return x * x * (3 - 2 * x);
  };
const mix = (a, b, t) => a + (b - a) * t;
function quadMatrix(points, w, h) {
  const src = [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ],
    a = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i],
      [u, v] = points[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let i = 0; i < 8; i++) {
    let pivot = i;
    for (let j = i + 1; j < 8; j++)
      if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    const divisor = a[i][i] || 1e-10;
    for (let k = i; k < 9; k++) a[i][k] /= divisor;
    for (let j = 0; j < 8; j++)
      if (j !== i) {
        const factor = a[j][i];
        for (let k = i; k < 9; k++) a[j][k] -= factor * a[i][k];
      }
  }
  const q = a.map((row) => row[8]);
  return `matrix3d(${[q[0], q[3], 0, q[6], q[1], q[4], 0, q[7], 0, 0, 1, 0, q[2], q[5], 0, 1].join(",")})`;
}
export class Observatory {
  constructor(container, projection, snapshot) {
    this.container = container;
    this.projection = projection;
    this.snapshot = snapshot;
    this.mode = "home";
    this.feature = null;
    this.started = performance.now();
    this.last = performance.now();
    this.elapsed = 0;
    this.reduced = false;
    this.frozen = false;
    this.frames = [];
    this.renderTimes = [];
    this.rendered = 0;
    this.quality = "standard";
    this.ratio = Math.min(
      devicePixelRatio,
      innerWidth <= 700 || innerWidth >= 1700 ? 1 : 1.5,
    );
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(this.ratio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.container.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color("#172127");
    this.scene.fog = new THREE.Fog("#172127", 8, 20);
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 35);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.03);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.45;
    this.scene.add(new THREE.HemisphereLight(0xe8eff2, 0x465057, 1.3));
    this.key = new THREE.DirectionalLight(0xfff0df, 3.2);
    this.key.position.set(-3, 5, 5);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    Object.assign(this.key.shadow.camera, {
      left: -4,
      right: 4,
      top: 5,
      bottom: -3,
      near: 0.1,
      far: 15,
    });
    this.key.shadow.bias = -0.00035;
    this.key.shadow.normalBias = 0.018;
    this.key.shadow.radius = 5;
    this.key.shadow.blurSamples = 8;
    this.scene.add(this.key);
    const fill = new THREE.DirectionalLight(0xcbdde4, 1.5);
    fill.position.set(4, 3, -3);
    this.scene.add(fill);
    this.floor = new THREE.Mesh(
      new THREE.PlaneGeometry(100, 100),
      new THREE.MeshStandardMaterial({
        color: "#172128",
        roughness: 0.94,
        metalness: 0.02,
      }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -0.018;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    // Broad contact patch supplements the cast shadow; no animated decorative geometry.
    const shadowData = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 4;
        shadowData[i + 3] = Math.round(
          90 * Math.exp(-((x - 32) ** 2 + (y - 32) ** 2) / 170),
        );
      }
    const tex = new THREE.DataTexture(shadowData, 64, 64);
    tex.needsUpdate = true;
    this.contact = new THREE.Mesh(
      new THREE.PlaneGeometry(1.85, 1),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.contact.rotation.x = -Math.PI / 2;
    this.contact.position.set(0, -0.005, 0);
    this.scene.add(this.contact);
    this.mapRoot = new THREE.Group();
    this.mapRoot.position.set(1.76, 0.025, 0.57);
    this.mapRoot.rotation.y = -0.22;
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 0.055, 1.76),
      new THREE.MeshStandardMaterial({ color: "#5a6c73", roughness: 0.8 }),
    );
    edge.receiveShadow = true;
    edge.castShadow = true;
    this.mapRoot.add(edge);
    this.mapFace = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 1.76),
      new THREE.MeshBasicMaterial({ color: "#dce1db" }),
    );
    this.mapFace.rotation.x = -Math.PI / 2;
    this.mapFace.position.y = 0.03;
    this.mapRoot.add(this.mapFace);
    this.scene.add(this.mapRoot);
    const planeGeometry = new THREE.BufferGeometry();
    planeGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(12), 3),
    );
    planeGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.projectionPlane = new THREE.Mesh(
      planeGeometry,
      new THREE.MeshBasicMaterial({
        color: "#74a4ae",
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.projectionPlane.frustumCulled = false;
    this.scene.add(this.projectionPlane);
    const ribbonGeometry = new THREE.BufferGeometry();
    ribbonGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(18), 3),
    );
    this.ribbon = new THREE.Mesh(
      ribbonGeometry,
      new THREE.MeshBasicMaterial({
        color: "#8bc4cd",
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.ribbon.frustumCulled = false;
    this.scene.add(this.ribbon);
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(12), 3),
    );
    this.leads = new THREE.LineSegments(
      lineGeo,
      new THREE.LineBasicMaterial({
        color: "#aacfd1",
        transparent: true,
        opacity: 0.65,
      }),
    );
    this.leads.frustumCulled = false;
    this.scene.add(this.leads);
    this.fromQ = new THREE.Quaternion();
    this.targetQ = new THREE.Quaternion();
    this.resize();
    this.titleGhost = document.createElement("div");
    this.titleGhost.className = "transition-title";
    this.titleGhost.setAttribute("aria-hidden", "true");
    document.body.append(this.titleGhost);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      document.body.classList.add("static-scene");
      document.querySelector("#model-state").textContent =
        "静态陪伴 · 导航与内容仍可使用";
      this.contextLost = true;
    });
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }
  async load() {
    const loader = new GLTFLoader();
    const [r, c] = await Promise.all([
      loader.loadAsync("./assets/OpenGMS_A.glb"),
      loader.loadAsync("./assets/cube.glb"),
    ]);
    this.robot = r.scene;
    this.cube = c.scene.getObjectByName("Cube_Root");
    this.scene.add(this.robot, this.cube);
    this.robot.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    this.cube.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    this.cube.position.set(1.12, 1.09, 0.22);
    this.cube.rotation.set(0.18, 0.34, 0.1);
    this.mixer = new THREE.AnimationMixer(this.robot);
    const idle = r.animations.find((a) => a.name === "Idle");
    if (!idle) throw Error("Idle not found");
    this.mixer.clipAction(idle).play();
    this.mixer.setTime(0.8);
    this.loaded = true;
    this.renderNow(0);
  }
  resize() {
    const box = this.container.getBoundingClientRect();
    this.width = Math.max(1, box.width);
    this.height = Math.max(1, box.height);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.forceRender = true;
  }
  setContext(snapshot, layer) {
    this.snapshot = snapshot;
    this.layer = layer;
    const version = ++this.textureVersion || 1;
    this.textureVersion = version;
    const svg = mapSVG(snapshot, layer, 1024, 700);
    const image = new Image();
    const objectURL = URL.createObjectURL(
      new Blob([svg], { type: "image/svg+xml" }),
    );
    image.onload = () => {
      URL.revokeObjectURL(objectURL);
      if (version !== this.textureVersion) return;
      const texture = new THREE.Texture(image);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      texture.anisotropy = Math.min(
        4,
        this.renderer.capabilities.getMaxAnisotropy(),
      );
      this.mapFace.material.map?.dispose();
      this.mapFace.material.map = texture;
      this.mapFace.material.needsUpdate = true;
      this.forceRender = true;
    };
    image.onerror = () => URL.revokeObjectURL(objectURL);
    image.src = objectURL;
    this.mapRoot.visible = !!layer?.extent;
  }
  setReduced(value) {
    this.reduced = value;
    this.forceRender = true;
    if (value && this.mode === "preview")
      this.started = performance.now() - 850;
  }
  setState(state, immediate = false) {
    const priorMode = this.mode;
    this.mode = state.mode;
    this.feature = state.feature;
    this.reduced = state.reduced;
    this.started =
      performance.now() -
      (immediate ? (state.mode === "expanding" ? 560 : 850) : 0);
    this.frozen = false;
    this.resize();
    if (this.cube) {
      this.fromQ.copy(this.cube.quaternion);
      this.placeCamera(0);
      if (this.feature) {
        const normal = new THREE.Vector3(...normals[this.feature]);
        const view = this.camera.position
          .clone()
          .sub(this.cube.position)
          .normalize();
        this.targetQ.setFromUnitVectors(normal, view);
      }
    }
    if (this.mode === "expanding") {
      this.expandFrom = this.previewQuad?.map((p) => [...p]);
      const heading = document.querySelector("#preview-title");
      const rect = heading.getBoundingClientRect();
      this.titleFrom = { x: rect.x, y: rect.y };
      this.titleGhost.textContent = heading.textContent;
    } else {
      this.titleGhost.style.display = "none";
      document.querySelector("#preview-title").style.visibility = "";
      this.projection.querySelector(".projection-inner").style.opacity = "";
    }
    this.projection.style.opacity = "1";
    this.forceRender = true;
    this.renderNow(immediate ? 850 : 0);
  }
  placeCamera(expanding) {
    const mobile = innerWidth <= 700,
      work = this.mode === "work";
    if (this.cube && !work)
      this.cube.position.set(mobile ? 0.94 : 1.12, mobile ? 1.12 : 1.09, 0.22);
    if (work) {
      this.camera.fov = 22;
      this.camera.position.set(0, 1.7, 3.2);
      this.camera.lookAt(0, 1.62, 0);
      this.scene.background = null;
      this.scene.fog = null;
    } else if (mobile) {
      this.camera.fov = 34;
      this.camera.position.set(0.26, 1.75, 3.65);
      this.camera.lookAt(0.26, 1.35, 0.05);
      this.scene.background = new THREE.Color("#172127");
      this.scene.fog = new THREE.Fog("#172127", 8, 20);
    } else {
      this.camera.fov = 32;
      this.camera.position.set(0.36, 2.05, 6.28);
      this.camera.lookAt(0.36, 1.02, 0);
      this.scene.background = new THREE.Color("#172127");
      this.scene.fog = new THREE.Fog("#172127", 8, 20);
    }
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }
  screen(v) {
    const p = v.clone().project(this.camera);
    return [(p.x * 0.5 + 0.5) * this.width, (0.5 - p.y * 0.5) * this.height];
  }
  onPlane(screen, plane) {
    const v = new THREE.Vector3(
      (screen[0] / this.width) * 2 - 1,
      1 - (screen[1] / this.height) * 2,
      0.5,
    ).unproject(this.camera);
    const ray = new THREE.Ray(
      this.camera.position.clone(),
      v.sub(this.camera.position).normalize(),
    );
    return (
      ray.intersectPlane(plane, new THREE.Vector3()) ?? new THREE.Vector3()
    );
  }
  drawProjection(ms, expandProgress) {
    const active =
      ["preview", "expanding"].includes(this.mode) && this.cube && this.feature;
    this.projectionPlane.visible =
      this.ribbon.visible =
      this.leads.visible =
        !!active;
    if (!active) return;
    const n = new THREE.Vector3(...normals[this.feature])
      .applyQuaternion(this.cube.quaternion)
      .normalize();
    const targetNormal = this.camera.position
      .clone()
      .sub(this.cube.position)
      .normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(
        this.camera.quaternion,
      ),
      up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const localNormal = new THREE.Vector3(...normals[this.feature]);
    const localU =
      Math.abs(localNormal.y) > 0.9
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0).cross(localNormal).normalize();
    const localV = localNormal.clone().cross(localU).normalize();
    const diagonal = right.clone().add(up);
    const signU =
        localU.clone().applyQuaternion(this.targetQ).dot(diagonal) >= 0
          ? 1
          : -1,
      signV =
        localV.clone().applyQuaternion(this.targetQ).dot(diagonal) >= 0
          ? 1
          : -1;
    const faceU = localU
        .applyQuaternion(this.cube.quaternion)
        .multiplyScalar(signU),
      faceV = localV
        .applyQuaternion(this.cube.quaternion)
        .multiplyScalar(signV);
    const cubeScale = this.cube.scale.x;
    const center = this.cube.position
      .clone()
      .addScaledVector(n, 0.216 * cubeScale);
    const corner = center
      .clone()
      .addScaledVector(faceU, 0.145 * cubeScale)
      .addScaledVector(faceV, 0.145 * cubeScale);
    this.faceOrigin = corner;
    this.normal = n;
    const a = this.screen(corner);
    this.sourceScreen = a;
    const mobile = innerWidth <= 700,
      short = innerHeight <= 550;
    let w = Math.min(380, innerWidth * 0.275),
      h = 510;
    if (short) {
      w = Math.min(260, innerWidth * 0.31);
      h = 296;
    }
    const left = Math.min(
      innerWidth - w - 35,
      Math.max(a[0] + 40, innerWidth * 0.69),
    );
    const top = Math.max(
      short ? 75 : 150,
      Math.min(a[1] - 160, innerHeight - h - 125),
    );
    let quad = [
      [left + 6, top],
      [left + w, top + 9],
      [left + w - 4, top + h],
      [left, top + h - 9],
    ];
    let reveal = this.reduced ? 1 : smooth((ms - 300) / 550);
    if (this.mode === "expanding") reveal = 1;
    if (mobile) {
      w = 350;
      h = 345;
      quad = [
        [Math.min(this.width - 100, a[0] + 7), a[1] - 10],
        [this.width - 8, a[1] + 10],
        [this.width - 20, this.height - 3],
        [Math.max(270, a[0] + 5), this.height - 3],
      ];
    }
    if (this.mode === "expanding" && !mobile) {
      const rect = [
        [262, 139],
        [innerWidth - 46, 139],
        [innerWidth - 46, innerHeight - 32],
        [262, innerHeight - 32],
      ];
      quad = quad.map((p, i) =>
        p.map((v, j) => mix(v, rect[i][j], expandProgress)),
      );
    }
    if (this.mode === "expanding" && !mobile) {
      const targetX = innerWidth >= 1700 ? 315 : innerWidth <= 1150 ? 218 : 262;
      const targetY =
        innerWidth >= 1700 ? 164.7 : innerWidth <= 1150 ? 142.7 : 153.7;
      this.titleGhost.style.cssText =
        "display:block;left:" +
        mix(this.titleFrom?.x ?? left + 25, targetX, expandProgress) +
        "px;top:" +
        mix(this.titleFrom?.y ?? top + 65, targetY, expandProgress) +
        "px;font-size:" +
        mix(29, 31, expandProgress) +
        "px";
      document.querySelector("#preview-title").style.visibility = "hidden";
      this.projection.querySelector(".projection-inner").style.opacity = String(
        1 - smooth(expandProgress / 0.65),
      );
    }
    this.previewQuad = quad.map((p) => [...p]);
    const grown = quad.map((p) => [
      mix(a[0], p[0], Math.max(0.002, reveal)),
      mix(a[1], p[1], Math.max(0.002, reveal)),
    ]);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
      targetNormal,
      center.clone().addScaledVector(targetNormal, 0.085),
    );
    const world = grown.map((p) => this.onPlane(p, plane));
    this.projectionPlane.geometry.attributes.position.array.set(
      world.flatMap((p) => p.toArray()),
    );
    this.projectionPlane.geometry.attributes.position.needsUpdate = true;
    const source2 = center
      .clone()
      .addScaledVector(faceU, 0.145 * cubeScale)
      .addScaledVector(faceV, -0.13 * cubeScale);
    const strip = [corner, source2, world[3], corner, world[3], world[0]];
    this.ribbon.geometry.attributes.position.array.set(
      strip.flatMap((p) => p.toArray()),
    );
    this.ribbon.geometry.attributes.position.needsUpdate = true;
    this.leads.geometry.attributes.position.array.set(
      [corner, world[0], source2, world[3]].flatMap((p) => p.toArray()),
    );
    this.leads.geometry.attributes.position.needsUpdate = true;
    this.ribbon.material.opacity = 0.16 * reveal * (1 - expandProgress);
    this.leads.material.opacity = 0.6 * reveal * (1 - expandProgress);
    this.projectionPlane.material.opacity = 0.16 * reveal;
    this.lastQuad = grown;
    this.projection.style.width = w + "px";
    this.projection.style.height = h + "px";
    this.projection.style.left = "0";
    this.projection.style.top = "0";
    this.projection.style.transform = quadMatrix(grown, w, h);
    this.projection.style.opacity = String(mobile ? 1 : clamp(reveal * 2));
    this.projection.style.pointerEvents =
      reveal > 0.1 || mobile ? "auto" : "none";
    if (mobile) {
      this.projectionPlane.material.opacity = 0.17 * reveal;
      this.projection.style.opacity = "1";
    }
  }
  renderNow(ms) {
    if (!this.loaded) return;
    const expanding =
      this.mode === "expanding" ? (this.reduced ? 1 : smooth(ms / 560)) : 0;
    this.placeCamera(expanding);
    const work = this.mode === "work";
    this.floor.visible = this.contact.visible = !work;
    this.mapRoot.visible = !work && !!this.layer?.extent;
    this.cube.visible = !work;
    this.robot.scale.setScalar(work ? 1 : mix(1, 0.2, expanding));
    this.robot.position.set(
      work ? 0 : mix(0, -1.5, expanding),
      work ? 0 : mix(0, 1.65, expanding),
      0,
    );
    if (this.mode === "preview") {
      this.cube.quaternion.slerpQuaternions(
        this.fromQ,
        this.targetQ,
        this.reduced ? 1 : smooth(ms / 510),
      );
    }
    if (this.mode === "expanding") {
      this.cube.quaternion.slerpQuaternions(
        this.fromQ,
        this.targetQ,
        this.reduced ? 1 : smooth(ms / 300),
      );
      this.cube.scale.setScalar(mix(1, 0.2, expanding));
    } else this.cube.scale.setScalar(1);
    this.scene.updateMatrixWorld(true);
    this.drawProjection(ms, expanding);
    this.renderer.render(this.scene, this.camera);
    this.rendered++;
  }
  frame(t) {
    const dt = t - this.last;
    this.last = t;
    if (
      !this.loaded ||
      this.contextLost ||
      this.staticQuality ||
      document.hidden ||
      this.frozen
    )
      return;
    this.elapsed += Math.min(dt, 100) / 1000;
    const ms = t - this.started;
    const animationActive =
      this.mode === "home" ||
      (this.mode === "preview" && ms < 870) ||
      this.mode === "expanding";
    if (!animationActive && !this.forceRender) return;
    if (!this.reduced && this.mode === "home") {
      this.cube.rotateOnWorldAxis(
        new THREE.Vector3(0, 1, 0),
        (Math.min(dt, 50) / 1000) *
          (0.45 + 0.2 * Math.sin((this.elapsed * Math.PI) / 4)),
      );
      this.mixer.update(Math.min(dt, 50) / 1000);
    }
    if (this.reduced && !this.forceRender) return;
    this.forceRender = false;
    const start = performance.now();
    this.renderNow(ms);
    this.renderTimes.push(performance.now() - start);
    if (dt > 0 && dt < 1000) this.frames.push(dt);
    if (this.frames.length > 360) this.frames.shift();
    if (this.renderTimes.length > 360) this.renderTimes.shift();
    if (this.quality === "low" && this.frames.length === 360) {
      const sorted = [...this.frames].sort((a, b) => a - b);
      if (sorted[180] > 50) {
        this.staticQuality = true;
        this.quality = "static";
        document.body.classList.add("static-scene");
        document.querySelector("#model-state").textContent =
          "静态陪伴 · 导航与内容仍可使用";
      }
    }
    if (this.quality === "standard" && this.frames.length === 180) {
      const avg = this.frames.reduce((a, b) => a + b, 0) / 180;
      if (avg > 38) {
        this.quality = "low";
        this.renderer.setPixelRatio(1);
        this.ratio = 1;
        this.renderer.shadowMap.enabled = false;
        document.querySelector("#model-state").textContent = "轻量画面";
        this.forceRender = true;
      }
    }
  }
  captureAt(state, ms) {
    this.setState(state, false);
    this.frozen = true;
    this.mixer?.setTime(0.8);
    this.cube.rotation.set(0.18, 0.34, 0.1);
    this.fromQ.copy(this.cube.quaternion);
    this.renderNow(ms);
  }
  resume() {
    this.frozen = false;
    this.last = performance.now();
    this.started = performance.now() - 850;
    this.forceRender = true;
  }
  metrics() {
    const ordered = [...this.frames].sort((a, b) => a - b);
    const normal = this.feature
      ? new THREE.Vector3(...normals[this.feature])
          .applyQuaternion(this.cube.quaternion)
          .normalize()
      : null;
    const view = this.cube
      ? this.camera.position.clone().sub(this.cube.position).normalize()
      : null;
    const meshBounds = this.robot
      ? new THREE.Box3().setFromObject(this.robot)
      : null;
    const gl = this.renderer.getContext(),
      ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      version: "D01-R1",
      mode: this.mode,
      feature: this.feature,
      ready: this.loaded,
      canvasCount: document.querySelectorAll("canvas").length,
      viewport: [innerWidth, innerHeight],
      canvasCSS: [this.width, this.height],
      drawingBuffer: [
        this.renderer.domElement.width,
        this.renderer.domElement.height,
      ],
      dpr: this.renderer.getPixelRatio(),
      quality: this.quality,
      reduced: this.reduced,
      renderer: ext
        ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER),
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      frameSamples: ordered.length,
      p50FrameMs: ordered[Math.floor(ordered.length * 0.5)] ?? null,
      p95FrameMs: ordered[Math.floor(ordered.length * 0.95)] ?? null,
      meanRenderCPUMs: this.renderTimes.length
        ? this.renderTimes.reduce((a, b) => a + b) / this.renderTimes.length
        : null,
      faceDotView: normal && view ? normal.dot(view) : null,
      worldNormal: normal?.toArray(),
      sourcePlaneOffset:
        normal && this.faceOrigin
          ? this.faceOrigin.clone().sub(this.cube.position).dot(normal)
          : null,
      faceSourceScreen: this.sourceScreen,
      projectionQuad: this.lastQuad,
      cubeQuaternion: this.cube?.quaternion.toArray(),
      cubeScreen: this.cube ? this.screen(this.cube.position) : null,
      robotBounds: meshBounds
        ? { min: meshBounds.min.toArray(), max: meshBounds.max.toArray() }
        : null,
      camera: {
        position: this.camera.position.toArray(),
        fov: this.camera.fov,
      },
      rendered: this.rendered,
    };
  }
}
