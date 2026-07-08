const SPRING_STIFFNESS_PER_MS = 0.00055;
const SPRING_DAMPING_PER_MS = 0.0302;
const SPRING_MAX_FRAME_MS = 32;
const SPRING_SETTLED_DISTANCE_PX = 0.75;
const SPRING_SETTLED_VELOCITY_PX_PER_MS = 0.03;

interface SpringState {
  value: number;
  velocity: number;
}

export interface SpringOptions {
  value: number;
  target: number;
  velocity: number;
  onUpdate: (value: number) => void;
  onSettle: () => void;
}

/** Animates a single numeric value to a target with spring physics. */
export class Spring {
  private animationFrame: number | null = null;
  private state: SpringState | null = null;
  private target = 0;
  private lastTime: number | null = null;

  constructor(private readonly options: SpringOptions) {
    this.start();
  }

  private start() {
    this.target = this.options.target;
    this.state = { value: this.options.value, velocity: this.options.velocity };
    this.lastTime = null;
    this.options.onUpdate(this.options.value);

    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      this.options.onUpdate(this.target);
      this.finish();
      return;
    }

    this.animationFrame = window.requestAnimationFrame((time) => this.tick(time));
  }

  cancel() {
    if (this.animationFrame !== null) {
      const cancel = typeof window !== "undefined" ? window.cancelAnimationFrame : undefined;
      if (typeof cancel === "function") cancel.call(window, this.animationFrame);
    }

    this.animationFrame = null;
    this.state = null;
    this.lastTime = null;
    this.target = 0;
  }

  private tick(time: number) {
    if (!this.state) return;

    const deltaMs = this.lastTime === null ? 16 : time - this.lastTime;
    this.lastTime = time;

    this.state = springStep(this.state, this.target, deltaMs);
    this.options.onUpdate(this.state.value);

    if (springSettled(this.state, this.target)) {
      this.options.onUpdate(this.target);
      this.finish();
      return;
    }

    this.animationFrame = window.requestAnimationFrame((nextTime) => this.tick(nextTime));
  }

  private finish() {
    this.animationFrame = null;
    this.state = null;
    this.lastTime = null;
    this.target = 0;
    this.options.onSettle();
  }
}

function springStep(
  state: SpringState,
  targetValue: number,
  deltaMs: number,
): SpringState {
  const dt = Math.max(0, Math.min(deltaMs, SPRING_MAX_FRAME_MS));
  const displacement = state.value - targetValue;
  const acceleration = -SPRING_STIFFNESS_PER_MS * displacement - SPRING_DAMPING_PER_MS * state.velocity;
  const velocity = state.velocity + acceleration * dt;
  const value = state.value + velocity * dt;

  return { value, velocity };
}

function springSettled(
  state: SpringState,
  targetValue: number,
): boolean {
  return Math.abs(state.value - targetValue) <= SPRING_SETTLED_DISTANCE_PX
    && Math.abs(state.velocity) <= SPRING_SETTLED_VELOCITY_PX_PER_MS;
}
