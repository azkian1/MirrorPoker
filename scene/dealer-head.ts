/**
 * Runtime UV projection of the 1536×1024 dealer reference.
 * The active v14 image edit removes facial makeup; the original v10 reference
 * remains archived. This shader preserves the edited face colours as sampled.
 *
 * Both boxes below use top-left image coordinates:
 * reference: x .335–.590, y .000–.430; RGBA body: x .28063846–.66936154, y .005–.415.
 * Pixel-space X/Y scale is uniform (~1.20582758); mouth/chin height is unchanged.
 * Three TextureLoader's default flipY means shader UV has its top at v=1.
 * Texture must use SRGBColorSpace.
 *
 * The original body alpha remains the final silhouette. A conservative profile
 * rejects the reference's room pixels; only its narrow outer hair/jaw boundary
 * and the final neck seam retain/blend the old cutout. Core face is 100% reference.
 * The source hair is cropped by the user's frame, so no missing crown is invented.
 * Actual alignment/edge acceptance belongs to the combined WebGL camera review.
 */
export const HEAD_MAPPING = {
  source: { pixels: [1536, 1024], min: [0.335, 0.000], extent: [0.255, 0.430] },
  target: { pixels: [1215, 1295], min: [0.28063846, 0.005], extent: [0.38872308, 0.410] },
  neckFade: [0.975, 1.000],
} as const

const glslVec2 = (values: readonly number[]) => `vec2(${values.map(value => value.toFixed(8)).join(', ')})`

export const DEALER_HEAD_GLSL = /* glsl */ `
uniform sampler2D dealerHeadMap;

// Conservative source-head silhouette, expressed inside the reference head box.
// Left/right limits follow hair, ear, cheek and chin; feather stays at the rim.
vec2 dealerHeadSpan(float y) {
  if (y < 0.10) return mix(vec2(0.24, 0.76), vec2(0.15, 0.86), y / 0.10);
  if (y < 0.20) return mix(vec2(0.15, 0.86), vec2(0.08, 0.90), (y - 0.10) / 0.10);
  if (y < 0.35) return mix(vec2(0.08, 0.90), vec2(0.03, 0.89), (y - 0.20) / 0.15);
  if (y < 0.50) return mix(vec2(0.03, 0.89), vec2(0.16, 0.87), (y - 0.35) / 0.15);
  if (y < 0.65) return mix(vec2(0.16, 0.87), vec2(0.26, 0.79), (y - 0.50) / 0.15);
  if (y < 0.80) return mix(vec2(0.26, 0.79), vec2(0.34, 0.73), (y - 0.65) / 0.15);
  if (y < 0.94) return mix(vec2(0.34, 0.73), vec2(0.44, 0.63), (y - 0.80) / 0.14);
  return mix(vec2(0.44, 0.63), vec2(0.47, 0.62), (y - 0.94) / 0.06);
}

vec4 dealerHead(vec4 body, vec2 uv) {
  vec2 topLeft = vec2(uv.x, 1.0 - uv.y);
  vec2 head = (topLeft - ${glslVec2(HEAD_MAPPING.target.min)}) / ${glslVec2(HEAD_MAPPING.target.extent)};
  if (body.a <= 0.0 || head.x < 0.0 || head.x > 1.0 || head.y < 0.0 || head.y > 1.0) return body;

  vec2 span = dealerHeadSpan(head.y);
  float rim = smoothstep(span.x, span.x + 0.018, head.x)
    * (1.0 - smoothstep(span.y - 0.018, span.y, head.x));
  float neck = 1.0 - smoothstep(${HEAD_MAPPING.neckFade.map(value => value.toFixed(8)).join(', ')}, head.y);
  float coverage = rim * neck;
  if (coverage <= 0.0) return body;

  vec2 sourceTopLeft = ${glslVec2(HEAD_MAPPING.source.min)} + head * ${glslVec2(HEAD_MAPPING.source.extent)};
  vec3 reference = texture2D(dealerHeadMap, vec2(sourceTopLeft.x, 1.0 - sourceTopLeft.y)).rgb;
  return vec4(mix(body.rgb, reference, coverage), body.a);
}
`
