// The hash grid of the sparks effect, worked out on the CPU once per frame: how wide a lane is,
// how long a slot is and how many slots are filled, for a requested number of sparks per area.
// Pure arithmetic, so it can be tested without a GPU (tests/epic4-c.test.ts).

export interface SparkGridInput {
  /** The `density` parameter: 1 is the default amount. */
  density: number;
  /** The `size` parameter: 1 is the default radius. */
  size: number;
  /** Streak length in canvas heights. */
  streak: number;
  /** Width of the emitter as a fraction of the canvas width; 0 is a point. */
  source: number;
  /** Half-angle of the fan, in radians. */
  spread: number;
  /** Canvas width over height. */
  aspect: number;
  /** One pixel in canvas heights (1 / height). Omit to ignore the small-canvas floor. */
  pixel?: number;
}

export interface SparkGrid {
  /** Spark radius in canvas heights (in the layer whose scale is 1). */
  size: number;
  /** Width of a lane at the reference distance, in canvas heights. */
  laneWidth: number;
  /** Length of travel that holds one slot, in canvas heights. */
  slotLength: number;
  /** Fraction of slots that hold a spark, 0..1. */
  fill: number;
  /** Distance of the fan's virtual origin behind the emitter, in canvas heights. */
  focal: number;
  /** Half-angle of the fan, in radians, clamped to what the shader can address. */
  spread: number;
}

/** Radius of a spark at `size` 1, in canvas heights: 3.2 px at 1080p before the depth scale. */
export const SPARK_RADIUS = 0.003;
/** On a small canvas a spark at `size` 1 is at least this many pixels in radius, so a card still shows sparks. */
export const SPARK_MIN_PIXELS = 1.5;
/** Sparks per square canvas height, per layer, at `density` 1. */
export const SPARKS_PER_AREA = 70;
/** A slot is never shorter than this, so short sparks are not evenly spaced beads. */
const MIN_SLOT = 0.09;
/** The fastest lane runs at 1.4 times the average, and its streak is that much longer. */
const MAX_LANE_SPEED = 1.4;
/** A parallel fan is a point infinitely far away; this is far enough. */
const MAX_FOCAL = 40;

export function sparkGrid(input: SparkGridInput): SparkGrid {
  const size =
    Math.max(SPARK_RADIUS, SPARK_MIN_PIXELS * (input.pixel ?? 0)) * Math.max(input.size, 0.01);
  // The largest spark is 1.45 times the nominal radius (see the shader), and it must fit its slot
  // lengthways with room to be placed, and its lane sideways.
  const largest = size * 1.45;
  const longest = Math.max(input.streak, 0) * MAX_LANE_SPEED + 2 * largest;
  const slotLength = Math.max(MIN_SLOT, 1.6 * longest);
  const wanted = SPARKS_PER_AREA * Math.max(input.density, 0);
  // fill / (laneWidth * slotLength) sparks per area: aim for slots half full, then let the lane
  // width hit its limits and make up the difference with the fill.
  const laneWidth = Math.min(Math.max(0.5 / (wanted * slotLength), 4 * largest), 0.25);
  const fill = Math.min(wanted * laneWidth * slotLength, 0.92);

  const spread = Math.min(Math.max(input.spread, Math.PI / 180), Math.PI);
  const halfSource = 0.5 * Math.max(input.source, 0) * input.aspect;
  // Rays through the two ends of the emitter meet `focal` behind it. Past a right angle there is
  // no such point: the emitter is treated as a point.
  const focal = spread < Math.PI / 2 ? Math.min(halfSource / Math.tan(spread), MAX_FOCAL) : 0;
  return { size, laneWidth, slotLength, fill, focal, spread };
}
