/**
 * Laura-style core: cyberpunk red orb in dark space. Motion and glow per state.
 * window.scene3d = { init, update, resize, setMode, cleanup }.
 */
(function() {
  let scene, camera, renderer, orb, orbGlow, ring, gridHelper, neuralGroup, clock;
  let mode = 'idle';
  let modeUntil = 0;
  let animId = null;
  let resizeHandler = null;

  // 3D neural nodes: positions around the orb (x,y,z) * radius, so they hover in 4D with the ball
  const NEURAL_RADIUS = 1.08;
  const NEURAL_POSITIONS = [
    { id: 'D',   pos: [1, 0, 0], phase: 0 },
    { id: 'C',   pos: [0.65, 0.65, 0.4], phase: 0.4 },
    { id: 'S',   pos: [0.65, -0.65, 0.4], phase: 0.8 },
    { id: 'N',   pos: [-0.65, 0.65, 0.4], phase: 1.2 },
    { id: 'Syn', pos: [-1, 0, 0], phase: 1.6 },
  ].map(o => ({
    id: o.id,
    pos: [o.pos[0] * NEURAL_RADIUS, o.pos[1] * NEURAL_RADIUS, o.pos[2] * NEURAL_RADIUS],
    phase: o.phase,
  }));

  const RED = [1, 0, 0.25];        // #ff0040 neon red
  const RED_DIM = [0.85, 0, 0.2]; // rest / calmer
  const MODES = {
    idle:      { rotSpeed: 0.2, floatAmp: 0.06, floatFreq: 0.6, pulse: 0, scale: 1, emissive: 0.2, glow: 0.1, ringScale: 0, color: RED },
    think:     { rotSpeed: 0.8, floatAmp: 0.04, floatFreq: 1.5, pulse: 0.08, scale: 1.05, emissive: 0.45, glow: 0.25, ringScale: 1.1, color: RED },
    read_file: { rotSpeed: 0.5, floatAmp: 0.02, floatFreq: 2, pulse: 0.06, scale: 1.02, emissive: 0.5, glow: 0.28, ringScale: 1.15, color: RED },
    list_dir:  { rotSpeed: 0.6, floatAmp: 0.05, floatFreq: 1.2, pulse: 0.05, scale: 1.03, emissive: 0.4, glow: 0.2, ringScale: 1.08, color: RED },
    fetch_url: { rotSpeed: 1, floatAmp: 0.08, floatFreq: 1.8, pulse: 0.1, scale: 1.06, emissive: 0.55, glow: 0.3, ringScale: 1.2, color: RED },
    browse:    { rotSpeed: 0.9, floatAmp: 0.07, floatFreq: 1.6, pulse: 0.09, scale: 1.05, emissive: 0.5, glow: 0.25, ringScale: 1.18, color: RED },
    write_journal: { rotSpeed: 0.4, floatAmp: 0.03, floatFreq: 0.9, pulse: 0.04, scale: 1.02, emissive: 0.45, glow: 0.22, ringScale: 1.12, color: RED_DIM },
    rest:      { rotSpeed: 0.08, floatAmp: 0.03, floatFreq: 0.4, pulse: 0.02, scale: 0.92, emissive: 0.15, glow: 0.06, ringScale: 0, color: RED_DIM },
    read_self: { rotSpeed: 0.6, floatAmp: 0.04, floatFreq: 1.2, pulse: 0.07, scale: 1.04, emissive: 0.5, glow: 0.26, ringScale: 1.15, color: RED },
  };

  function getMode() {
    if (Date.now() > modeUntil) return 'idle';
    return MODES[mode] ? mode : 'idle';
  }

  function init(container) {
    if (!window.THREE) return;
    const THREE = window.THREE;
    clock = new THREE.Clock();
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0608);
    scene.fog = new THREE.FogExp2(0x0a0608, 0.016);

    camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);

    const ambient = new THREE.AmbientLight(0x1a0808, 0.4);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xff0040, 0.7);
    key.position.set(5, 5, 5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xff2060, 0.2);
    fill.position.set(-4, 2, 3);
    scene.add(fill);

    const orbGeo = new THREE.SphereGeometry(0.55, 48, 48);
    const orbMat = new THREE.MeshStandardMaterial({
      color: 0xff0040,
      emissive: 0x400010,
      metalness: 0.75,
      roughness: 0.2,
    });
    orb = new THREE.Mesh(orbGeo, orbMat);
    orb.castShadow = true;
    scene.add(orb);

    const glowGeo = new THREE.SphereGeometry(0.62, 32, 32);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff2060,
      transparent: true,
      opacity: 0.16,
      wireframe: true,
    });
    orbGlow = new THREE.Mesh(glowGeo, glowMat);
    orb.add(orbGlow);

    const ringGeo = new THREE.RingGeometry(0.7, 0.85, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff2060,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    });
    ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = -0.1;
    ring.scale.setScalar(0);
    orb.add(ring);

    // 3D neural graph: nodes and lines connected to the orb, hovering with it
    neuralGroup = new THREE.Group();
    const nodeGeo = new THREE.SphereGeometry(0.08, 16, 16);
    const nodeMat = new THREE.MeshBasicMaterial({
      color: 0xff2060,
      transparent: true,
      opacity: 0.85,
    });
    const lineMat = new THREE.LineBasicMaterial({
      color: 0xff0040,
      transparent: true,
      opacity: 0.5,
    });
    const origin = new THREE.Vector3(0, 0, 0);
    NEURAL_POSITIONS.forEach((n, i) => {
      const pos = new THREE.Vector3(n.pos[0], n.pos[1], n.pos[2]);
      const node = new THREE.Mesh(nodeGeo, nodeMat.clone());
      node.position.copy(pos);
      neuralGroup.add(node);
      const lineGeo = new THREE.BufferGeometry().setFromPoints([origin, pos]);
      const line = new THREE.Line(lineGeo, lineMat);
      neuralGroup.add(line);
    });
    orb.add(neuralGroup);

    const gridGeo = new THREE.PlaneGeometry(35, 35, 35, 35);
    const gridMat = new THREE.MeshBasicMaterial({
      color: 0xff0040,
      wireframe: true,
      transparent: true,
      opacity: 0.07,
    });
    gridHelper = new THREE.Mesh(gridGeo, gridMat);
    gridHelper.rotation.x = -Math.PI / 2;
    gridHelper.position.y = -1;
    scene.add(gridHelper);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    resizeHandler = () => resize();
    window.addEventListener('resize', resizeHandler);
    animate();
  }

  function resize() {
    const container = document.getElementById('scene-container');
    if (!container || !camera || !renderer) return;
    const w = container.clientWidth;
    const h = container.clientHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function setMode(action) {
    if (action && MODES[action]) {
      mode = action;
      modeUntil = Date.now() + 4200;
    }
  }

  function animate() {
    if (!renderer || !scene || !camera) return;
    const t = clock.getElapsedTime();
    const m = MODES[getMode()] || MODES.idle;

    if (orb) {
      orb.rotation.y += m.rotSpeed * 0.016;
      orb.rotation.x = Math.sin(t * 0.5) * 0.06;
      const float = Math.sin(t * m.floatFreq) * m.floatAmp;
      orb.position.y = float;
      orb.position.x = Math.sin(t * 0.4) * 0.03;
      const pulseScale = 1 + Math.sin(t * 4) * m.pulse;
      orb.scale.setScalar(m.scale * pulseScale);
      if (orb.material) {
        const [r, g, b] = m.color;
        orb.material.emissive.setRGB(r * m.emissive, g * m.emissive, b * m.emissive);
        orb.material.color.setRGB(r, g, b);
      }
      if (orbGlow && orbGlow.material) {
        orbGlow.material.opacity = m.glow + Math.sin(t * 3) * 0.03;
        orbGlow.material.color.setRGB(m.color[0], m.color[1], m.color[2]);
      }
      if (ring && ring.material) {
        if (m.ringScale > 0) {
          ring.scale.setScalar(m.ringScale * (0.92 + Math.sin(t * 2) * 0.08));
          ring.rotation.z += 0.018;
          ring.material.opacity = 0.2 + Math.sin(t * 2) * 0.1;
        } else {
          ring.scale.setScalar(0);
        }
      }
      // 4D hover: neural nodes and lines move with the orb, subtle drift
      if (neuralGroup && neuralGroup.children.length) {
        neuralGroup.rotation.y = t * 0.12;
        neuralGroup.rotation.x = Math.sin(t * 0.3) * 0.08;
        const count = NEURAL_POSITIONS.length;
        for (let i = 0; i < count; i++) {
          const phase = NEURAL_POSITIONS[i].phase;
          const drift = 0.03 * Math.sin(t * 0.7 + phase);
          const bx = NEURAL_POSITIONS[i].pos[0], by = NEURAL_POSITIONS[i].pos[1], bz = NEURAL_POSITIONS[i].pos[2];
          const dx = bx * drift, dy = by * drift, dz = bz * drift;
          const node = neuralGroup.children[i * 2];
          const line = neuralGroup.children[i * 2 + 1];
          if (node && node.position) {
            node.position.set(bx + dx, by + dy, bz + dz);
          }
          if (line && line.geometry && line.geometry.attributes.position) {
            const posAttr = line.geometry.attributes.position;
            if (posAttr.count >= 2) {
              posAttr.setXYZ(1, bx + dx, by + dy, bz + dz);
              posAttr.needsUpdate = true;
            }
          }
        }
      }
    }
    if (gridHelper) gridHelper.position.z = (t * 1.2) % 2.5 - 1.25;
    renderer.render(scene, camera);
    animId = requestAnimationFrame(animate);
  }

  function update() {
    /* no-op: hormones removed for max speed; orb uses mode color only */
  }

  function cleanup() {
    if (animId != null) {
      cancelAnimationFrame(animId);
      animId = null;
    }
    if (resizeHandler) {
      window.removeEventListener('resize', resizeHandler);
      resizeHandler = null;
    }
    scene = null;
    camera = null;
    renderer = null;
    orb = null;
    orbGlow = null;
    ring = null;
    gridHelper = null;
    neuralGroup = null;
  }

  function setNeuralStats(stats) {
    if (!stats || !neuralGroup) return;
    // Optional: scale node glow/size by neurons/synapses; for now nodes stay fixed
  }

  window.scene3d = { init, update, resize, setMode, setNeuralStats, cleanup };
})();
