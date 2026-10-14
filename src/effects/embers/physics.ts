// The numbers behind the embers, as pure functions so tests can check them without a GPU.

/** Embers die at this temperature (kelvin): by then they give off well under 1% of their first light. */
export const DEATH_TEMPERATURE = 650;
/** The air (kelvin): what embers cool towards and buoyancy is measured from. */
export const AMBIENT = 300;
/** Linear drag towards the wind, 1/s. */
export const DRAG = 1.2;
/** How much a full drive level adds, as a share of the calm emission. */
export const DRIVE_SHARE = 0.6;

export interface EmberInputs {
  /** Average embers alive at the calm rate. */
  count: number;
  /** Seconds the mean ember takes to cool from `temperature` to DEATH_TEMPERATURE. */
  lifetime: number;
  /** Terminal rise speed of a fresh ember, canvas heights per second. */
  rise: number;
  /** Mean starting temperature, kelvin. */
  temperature: number;
}

export interface EmberPhysics {
  /** Newtonian cooling rate, 1/s. */
  cooling: number;
  /** Acceleration per 1000 K above ambient (the framework's `forces.buoyancy`). */
  buoyancy: number;
  /** Fire-line emission, embers per second, at drive `level`. */
  rate: number;
}

/**
 * Cooling that takes the mean ember from `temperature` to DEATH_TEMPERATURE in `lifetime`
 * (T(t) = ambient + (T0 - ambient) e^(-k t)); buoyancy whose terminal speed against DRAG is `rise`
 * for a fresh ember; and the rate that keeps `count` alive on average (Little's law: rate = count /
 * lifetime), raised by at most DRIVE_SHARE of itself by the drive `level` (0..1).
 */
export function emberPhysics(inputs: EmberInputs, level: number): EmberPhysics {
  const excess = Math.max(1, inputs.temperature - AMBIENT);
  const lifetime = Math.max(0.1, inputs.lifetime);
  const drive = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
  return {
    cooling: Math.log(excess / (DEATH_TEMPERATURE - AMBIENT)) / lifetime,
    buoyancy: (inputs.rise * DRAG * 1000) / excess,
    rate: (inputs.count / lifetime) * (1 + DRIVE_SHARE * drive),
  };
}

/** The pool for `count` embers: room for the drive, the torch and the pops, a power of two. */
export function emberCapacity(count: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1024, count * 2.5)));
}
