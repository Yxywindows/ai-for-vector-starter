import * as THREE from "three";

const clamp = (n, limit = 1) => Math.max(-limit, Math.min(limit, n));
const smooth = (n) => {
  n = Math.max(0, Math.min(1, n));
  return n * n * (3 - 2 * n);
};

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
    if (!this.head || bones.length !== 2)
      throw Error("Head and Neck bones required");
    const isHeadTrack = (track) =>
      bones.some(
        (bone) =>
          THREE.PropertyBinding.parseTrackName(track.name).nodeName ===
          bone.name,
      );
    const armBones = [];
    robot.traverse((node) => {
      if (node.isBone && /^Shoulder[._]?R$/.test(node.name))
        node.traverse((child) => {
          if (child.isBone) armBones.push(child);
        });
    });
    if (!armBones.length) throw Error("Right arm bones required");
    const isArmTrack = (track) =>
      armBones.some(
        (bone) =>
          THREE.PropertyBinding.parseTrackName(track.name).nodeName ===
          bone.name,
      );
    const idle = clips.find((clip) => clip.name === "Idle");
    if (!idle) throw Error("Idle clip required");
    this.bodyIdle = this.mixer
      .clipAction(
        new THREE.AnimationClip(
          "BodyIdle",
          idle.duration,
          idle.tracks.filter((t) => !isHeadTrack(t) && !isArmTrack(t)),
        ),
      )
      .play();
    this.headIdle = this.mixer
      .clipAction(
        new THREE.AnimationClip(
          "HeadIdle",
          idle.duration,
          idle.tracks.filter(isHeadTrack),
        ),
      )
      .play();
    this.armIdle = this.mixer
      .clipAction(
        new THREE.AnimationClip(
          "ArmIdle",
          idle.duration,
          idle.tracks.filter(isArmTrack),
        ),
      )
      .play();
    this.actions = {};
    for (const name of ["Yes", "No"]) {
      const source = clips.find(
        (clip) => clip.name === (name === "No" ? "Wave" : "Yes"),
      );
      const tracks = source?.tracks.filter(
        name === "No" ? isArmTrack : isHeadTrack,
      );
      if (!tracks?.length) throw Error(`${name} gesture tracks required`);
      const action = this.mixer.clipAction(
        new THREE.AnimationClip(`${name}Gesture`, source.duration, tracks),
      );
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this.actions[name] = action;
    }
    this.eyes = [];
    for (const side of ["L", "R"])
      for (const part of ["Iris", "Pupil", "Catchlight"]) {
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
  center() {
    this.target.set(0, 0);
  }
  cancel() {
    this.restoreGaze();
    for (const action of Object.values(this.actions)) action.stop();
    this.headIdle.setEffectiveWeight(1);
    this.headIdle.paused = false;
    this.armIdle.setEffectiveWeight(1);
    this.reaction = this.pending = null;
    this.center();
    this.gaze.set(0, 0);
    this.mixer.update(0);
  }
  setReduced(value) {
    this.reduced = value;
    if (value) {
      const showPendingResult = this.pending?.onStart;
      this.cancel();
      showPendingResult?.();
    }
  }
  react(state, onStart = () => {}) {
    const name =
      state === "succeeded" ? "Yes" : state === "failed" ? "No" : null;
    if (!name || this.reduced) return false;
    if (this.reaction) {
      this.pending = { name, onStart };
      return true;
    }
    this.start(name, onStart);
    return true;
  }
  start(name, onStart) {
    const action = this.actions[name];
    this.headIdle.paused = name === "No";
    action.reset().setEffectiveWeight(0).play();
    this.reaction = {
      name,
      sourceClip: name === "No" ? "Wave" : "Yes",
      elapsed: 0,
      duration: action.getClip().duration,
      weight: 0,
    };
    this.played[name]++;
    onStart();
  }
  get active() {
    return (
      !!this.reaction || this.gaze.distanceToSquared(this.target) > 0.000001
    );
  }
  update(dt, camera, animateIdle = true) {
    this.restoreGaze();
    if (this.reduced) return;
    dt = Math.max(0, Math.min(dt, 0.05));
    const reaction = this.reaction;
    let weight = 0;
    if (reaction) {
      reaction.elapsed += dt;
      weight =
        smooth(reaction.elapsed / 0.18) *
        smooth((reaction.duration - reaction.elapsed) / 0.28);
      reaction.weight = weight;
      this.actions[reaction.name].setEffectiveWeight(weight);
      this.headIdle.setEffectiveWeight(
        reaction.name === "Yes" ? 1 - weight : 1,
      );
      this.armIdle.setEffectiveWeight(reaction.name === "No" ? 1 - weight : 1);
    }
    this.mixer.update(animateIdle || reaction ? dt : 0);
    if (reaction && reaction.elapsed >= reaction.duration) {
      this.actions[reaction.name].stop();
      this.headIdle.setEffectiveWeight(1);
      this.headIdle.paused = false;
      this.armIdle.setEffectiveWeight(1);
      this.reaction = null;
      this.mixer.update(0);
      if (this.pending) {
        const next = this.pending;
        this.pending = null;
        this.start(next.name, next.onStart);
      }
    }
    // Gestures take priority over gaze. No keeps the head still and waves the right arm.
    const target = reaction ? new THREE.Vector2() : this.target;
    this.gaze.lerp(target, 1 - Math.exp(-dt / 0.16));
    if (this.gaze.distanceToSquared(target) < 0.000001) this.gaze.copy(target);
    this.baseHead.copy(this.head.quaternion);
    this.robot.updateMatrixWorld(true);
    const parentWorld = this.head.parent.getWorldQuaternion(
      new THREE.Quaternion(),
    );
    const cameraWorld = camera.getWorldQuaternion(new THREE.Quaternion());
    const yawAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(cameraWorld);
    const pitchAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(cameraWorld);
    const gazeGain = 1 - weight;
    const offset = new THREE.Quaternion()
      .setFromAxisAngle(
        yawAxis,
        this.gaze.x * THREE.MathUtils.degToRad(8) * gazeGain,
      )
      .multiply(
        new THREE.Quaternion().setFromAxisAngle(
          pitchAxis,
          -this.gaze.y * THREE.MathUtils.degToRad(5) * gazeGain,
        ),
      );
    const localOffset = parentWorld
      .clone()
      .invert()
      .multiply(offset)
      .multiply(parentWorld);
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
      pending: this.pending?.name ?? null,
      played: { ...this.played },
      gaze: this.gaze.toArray(),
      target: this.target.toArray(),
      headBone: this.head.name,
      headQuaternion: this.head.quaternion.toArray(),
      eyeOffsets: this.eyes.map(({ node, rest }) => ({
        name: node.name,
        offset: node.position.clone().sub(rest).toArray(),
      })),
      reduced: this.reduced,
    };
  }
}
