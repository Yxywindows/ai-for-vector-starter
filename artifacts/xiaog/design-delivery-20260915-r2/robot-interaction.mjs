import * as THREE from "three";

const clamp = (n, limit = 1) => Math.max(-limit, Math.min(limit, n));
const smooth = (n) => { n = Math.max(0, Math.min(1, n)); return n * n * (3 - 2 * n); };

export class RobotInteraction {
  constructor(robot, clips) {
    this.robot = robot;
    this.mixer = new THREE.AnimationMixer(robot);
    this.head = null;
    const bones = [];
    robot.traverse((node) => {
      if (node.isBone && /^(Head|Neck)(_|$)/.test(node.name)) bones.push(node);
      if (node.isBone && /^Head(_|$)/.test(node.name)) this.head = node;
    });
    if (!this.head || bones.length !== 2) throw Error("Head and Neck bones required");
    const isHeadTrack = (track) => bones.some((bone) =>
      THREE.PropertyBinding.parseTrackName(track.name).nodeName === bone.name);
    const idle = clips.find((clip) => clip.name === "Idle");
    if (!idle) throw Error("Idle clip required");
    this.bodyIdle = this.mixer.clipAction(new THREE.AnimationClip("BodyIdle", idle.duration, idle.tracks.filter((t) => !isHeadTrack(t)))).play();
    this.headIdle = this.mixer.clipAction(new THREE.AnimationClip("HeadIdle", idle.duration, idle.tracks.filter(isHeadTrack))).play();
    this.actions = {};
    for (const name of ["Yes", "No"]) {
      const source = clips.find((clip) => clip.name === name);
      const tracks = source?.tracks.filter(isHeadTrack);
      if (!tracks?.length) throw Error(`${name} head tracks required`);
      const action = this.mixer.clipAction(new THREE.AnimationClip(`${name}Head`, source.duration, tracks));
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this.actions[name] = action;
    }
    this.eyes = [];
    for (const side of ["L", "R"]) for (const part of ["Iris", "Pupil", "Catchlight"]) {
      const node = robot.getObjectByName(`Eye_${side}_${part}`);
      if (!node) throw Error(`Eye_${side}_${part} required`);
      this.eyes.push({ node, rest: node.position.clone() });
    }
    this.target = new THREE.Vector2();
    this.gaze = new THREE.Vector2();
    this.baseHead = this.head.quaternion.clone();
    this.applied = false;
    this.reduced = false;
    this.reaction = null;
    this.pending = null;
    this.played = { Yes: 0, No: 0 };
    this.mixer.setTime(0.8);
  }
  restoreGaze() {
    if (this.applied) this.head.quaternion.copy(this.baseHead);
    this.applied = false;
    for (const { node, rest } of this.eyes) node.position.copy(rest);
  }
  look(x, y) {
    if (!this.reduced) this.target.set(clamp(x), clamp(y));
  }
  center() { this.target.set(0, 0); }
  cancel() {
    this.restoreGaze();
    for (const action of Object.values(this.actions)) action.stop();
    this.headIdle.setEffectiveWeight(1);
    this.reaction = this.pending = null;
    this.center();
    this.gaze.set(0, 0);
    this.mixer.update(0);
  }
  setReduced(value) {
    this.reduced = value;
    if (value) this.cancel();
  }
  react(state) {
    const name = state === "succeeded" ? "Yes" : state === "failed" ? "No" : null;
    if (!name || this.reduced) return false;
    if (this.reaction) { this.pending = name; return true; }
    this.start(name);
    return true;
  }
  start(name) {
    const action = this.actions[name];
    action.reset().setEffectiveWeight(0).play();
    this.reaction = { name, elapsed: 0, duration: action.getClip().duration, weight: 0 };
    this.played[name]++;
  }
  get active() {
    return !!this.reaction || this.gaze.distanceToSquared(this.target) > 0.000001;
  }
  update(dt, camera, animateIdle = true) {
    this.restoreGaze();
    if (this.reduced) return;
    dt = Math.max(0, Math.min(dt, 0.05));
    const reaction = this.reaction;
    let weight = 0;
    if (reaction) {
      reaction.elapsed += dt;
      weight = smooth(reaction.elapsed / 0.18) * smooth((reaction.duration - reaction.elapsed) / 0.28);
      reaction.weight = weight;
      this.actions[reaction.name].setEffectiveWeight(weight);
      this.headIdle.setEffectiveWeight(1 - weight);
    }
    this.mixer.update(animateIdle || reaction ? dt : 0);
    if (reaction && reaction.elapsed >= reaction.duration) {
      this.actions[reaction.name].stop();
      this.headIdle.setEffectiveWeight(1);
      this.reaction = null;
      this.mixer.update(0);
      if (this.pending) { const next = this.pending; this.pending = null; this.start(next); }
    }
    // The source gesture owns the head. Eyes return to centre during the gesture.
    const target = reaction ? new THREE.Vector2() : this.target;
    this.gaze.lerp(target, 1 - Math.exp(-dt / 0.16));
    if (this.gaze.distanceToSquared(target) < 0.000001) this.gaze.copy(target);
    this.baseHead.copy(this.head.quaternion);
    this.robot.updateMatrixWorld(true);
    const parentWorld = this.head.parent.getWorldQuaternion(new THREE.Quaternion());
    const cameraWorld = camera.getWorldQuaternion(new THREE.Quaternion());
    const yawAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(cameraWorld);
    const pitchAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(cameraWorld);
    const gazeGain = 1 - weight;
    const offset = new THREE.Quaternion().setFromAxisAngle(yawAxis, this.gaze.x * THREE.MathUtils.degToRad(8) * gazeGain)
      .multiply(new THREE.Quaternion().setFromAxisAngle(pitchAxis, -this.gaze.y * THREE.MathUtils.degToRad(5) * gazeGain));
    const localOffset = parentWorld.clone().invert().multiply(offset).multiply(parentWorld);
    this.head.quaternion.premultiply(localOffset);
    this.applied = true;
    // These six meshes share Head_DetailMount: local X/Y is the lens plane, +Z is outward.
    for (const { node } of this.eyes) {
      node.position.x += this.gaze.x * 0.07;
      node.position.y += this.gaze.y * 0.045;
    }
  }
  metrics() {
    return {
      reaction: this.reaction ? { ...this.reaction } : null,
      pending: this.pending,
      played: { ...this.played },
      gaze: this.gaze.toArray(),
      target: this.target.toArray(),
      headBone: this.head.name,
      headQuaternion: this.head.quaternion.toArray(),
      eyeOffsets: this.eyes.map(({ node, rest }) => ({ name: node.name, offset: node.position.clone().sub(rest).toArray() })),
      reduced: this.reduced,
    };
  }
}
